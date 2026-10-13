package main

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeLostRunSessionStore holds session docs in memory and applies
// endSessionIf with the same re-read-then-decide semantics as the Firestore
// transaction.
type fakeLostRunSessionStore struct {
	mu      sync.Mutex
	docs    map[string]sessionDocState
	listErr error
	endErr  error
	// beforeEnd runs inside endSessionIf before the re-read, standing in for
	// a write that lands between the query and the transaction.
	beforeEnd func(id string, docs map[string]sessionDocState)
	ended     []string
}

func (s *fakeLostRunSessionStore) listRunSessions(_ context.Context, runID string) ([]sessionDocState, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.listErr != nil {
		return nil, s.listErr
	}
	var out []sessionDocState
	for _, doc := range s.docs {
		if doc.RunID == runID {
			out = append(out, doc)
		}
	}
	return out, nil
}

func (s *fakeLostRunSessionStore) endSessionIf(_ context.Context, id string, decide func(sessionDocState, bool) bool) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.endErr != nil {
		return false, s.endErr
	}
	if s.beforeEnd != nil {
		s.beforeEnd(id, s.docs)
	}
	current, exists := s.docs[id]
	if !decide(current, exists) {
		return false, nil
	}
	current.Liveness = "ended"
	current.UpdateTime = current.UpdateTime.Add(time.Second)
	s.docs[id] = current
	s.ended = append(s.ended, id)
	return true, nil
}

func (s *fakeLostRunSessionStore) liveness(id string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.docs[id].Liveness
}

const lostRunID = "jlapenna/homelab#2397/r1"

var lostRunWrittenAt = time.Date(2026, 10, 12, 23, 15, 0, 0, time.UTC)

func lostRunDoc(id, runID, liveness string) sessionDocState {
	return sessionDocState{ID: id, RunID: runID, Liveness: liveness, UpdateTime: lostRunWrittenAt}
}

func newTestLostRunSessionEnder(store lostRunSessionStore) (*lostRunSessionEnder, *bytes.Buffer) {
	var logs bytes.Buffer
	return &lostRunSessionEnder{store: store, logger: slog.New(slog.NewTextHandler(&logs, &slog.HandlerOptions{Level: slog.LevelDebug}))}, &logs
}

func TestLostRunSessionsEndsLiveAndIdleOnly(t *testing.T) {
	store := &fakeLostRunSessionStore{docs: map[string]sessionDocState{
		"ses_live":  lostRunDoc("ses_live", lostRunID, "live"),
		"ses_idle":  lostRunDoc("ses_idle", lostRunID, "idle"),
		"ses_ended": lostRunDoc("ses_ended", lostRunID, "ended"),
		"ses_stale": lostRunDoc("ses_stale", lostRunID, "stale"),
		"ses_other": lostRunDoc("ses_other", "jlapenna/homelab#2397/r2", "live"),
	}}
	ender, _ := newTestLostRunSessionEnder(store)

	ender.endRunSessions(context.Background(), lostRunID)

	for id, want := range map[string]string{
		"ses_live":  "ended",
		"ses_idle":  "ended",
		"ses_ended": "ended",
		"ses_stale": "stale",
		"ses_other": "live",
	} {
		if got := store.liveness(id); got != want {
			t.Errorf("%s liveness = %q, want %q", id, got, want)
		}
	}
	if len(store.ended) != 2 {
		t.Fatalf("ended %v, want only ses_live and ses_idle", store.ended)
	}
	// An already-terminal doc is never even re-read in a transaction.
	for _, id := range store.ended {
		if id == "ses_ended" || id == "ses_stale" {
			t.Fatalf("rewrote terminal doc %s", id)
		}
	}
}

func TestLostRunSessionsNoDocsIsANoOp(t *testing.T) {
	store := &fakeLostRunSessionStore{docs: map[string]sessionDocState{}}
	ender, _ := newTestLostRunSessionEnder(store)

	ender.endRunSessions(context.Background(), lostRunID)

	if len(store.ended) != 0 {
		t.Fatalf("ended %v with no docs", store.ended)
	}
}

func TestLostRunSessionsLeavesDocsChangedSinceTheQuery(t *testing.T) {
	cases := map[string]func(sessionDocState) sessionDocState{
		// finalize (or the dying worker's last flush) ended it first.
		"ended meanwhile": func(d sessionDocState) sessionDocState { d.Liveness = "ended"; return d },
		// A resumed retry took the session over under its own run.
		"claimed by retry": func(d sessionDocState) sessionDocState {
			d.RunID = "jlapenna/homelab#2397/r2"
			d.UpdateTime = d.UpdateTime.Add(time.Minute)
			return d
		},
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			store := &fakeLostRunSessionStore{docs: map[string]sessionDocState{
				"ses_live": lostRunDoc("ses_live", lostRunID, "live"),
			}}
			var want sessionDocState
			store.beforeEnd = func(id string, docs map[string]sessionDocState) {
				docs[id] = mutate(docs[id])
				want = docs[id]
			}
			ender, _ := newTestLostRunSessionEnder(store)

			ender.endRunSessions(context.Background(), lostRunID)

			if len(store.ended) != 0 {
				t.Fatalf("overwrote a doc changed since the query: %v", store.ended)
			}
			if got := store.docs["ses_live"]; got != want {
				t.Fatalf("doc = %+v, want untouched %+v", got, want)
			}
		})
	}
}

func TestLostRunSessionsDeletedDocIsLeftAlone(t *testing.T) {
	store := &fakeLostRunSessionStore{docs: map[string]sessionDocState{
		"ses_live": lostRunDoc("ses_live", lostRunID, "live"),
	}}
	store.beforeEnd = func(id string, docs map[string]sessionDocState) { delete(docs, id) }
	ender, _ := newTestLostRunSessionEnder(store)

	ender.endRunSessions(context.Background(), lostRunID)

	if _, ok := store.docs["ses_live"]; ok || len(store.ended) != 0 {
		t.Fatalf("recreated or ended a deleted doc: %+v %v", store.docs, store.ended)
	}
}

func TestLostRunSessionsFirestoreErrorsAreLoggedNotPropagated(t *testing.T) {
	t.Run("query", func(t *testing.T) {
		store := &fakeLostRunSessionStore{listErr: errors.New("permission denied")}
		ender, logs := newTestLostRunSessionEnder(store)

		ender.endRunSessions(context.Background(), lostRunID)

		if !strings.Contains(logs.String(), "permission denied") {
			t.Fatalf("query error not logged: %s", logs.String())
		}
	})
	t.Run("transaction", func(t *testing.T) {
		store := &fakeLostRunSessionStore{
			docs: map[string]sessionDocState{
				"ses_a": lostRunDoc("ses_a", lostRunID, "live"),
				"ses_b": lostRunDoc("ses_b", lostRunID, "idle"),
			},
			endErr: errors.New("deadline exceeded"),
		}
		ender, logs := newTestLostRunSessionEnder(store)

		ender.endRunSessions(context.Background(), lostRunID)

		// Each doc is attempted and logged; one failure does not stop the rest.
		if got := strings.Count(logs.String(), "deadline exceeded"); got != 2 {
			t.Fatalf("logged %d transaction errors, want 2: %s", got, logs.String())
		}
	})
}

func TestLostRunSessionEnderDisabledWithoutFirestore(t *testing.T) {
	if ender := newLostRunSessionEnder(noopConsoleStatusPublisher{}, discardLogger()); ender != nil {
		t.Fatalf("ender = %+v with status publication disabled, want nil", ender)
	}
	// A nil ender is a safe no-op, and so is a reporter without one.
	var ender *lostRunSessionEnder
	ender.endRunSessions(context.Background(), lostRunID)
	(&runExitReporter{}).endLostRunSessions(lostRunID)
}

func TestRunExitReporterEndsSessionsOnlyWhenSettledLost(t *testing.T) {
	cases := []struct {
		name     string
		status   int
		wantLive string
	}{
		{name: "lost", status: 200, wantLive: "ended"},
		{name: "unknown run", status: 404, wantLive: "live"},
		{name: "report failed", status: 500, wantLive: "live"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			recorder := &exitReportRecorder{statuses: []int{tc.status}}
			reporter := testExitReporter(recorder.server(t).URL)
			store := &fakeLostRunSessionStore{docs: map[string]sessionDocState{
				"ses_live": lostRunDoc("ses_live", lostRunID, "live"),
			}}
			reporter.sessions, _ = newTestLostRunSessionEnder(store)

			reporter.observeTerminated(lostRunID, "", "")
			reporter.wg.Wait()

			if got := store.liveness("ses_live"); got != tc.wantLive {
				t.Fatalf("liveness = %q, want %q", got, tc.wantLive)
			}
		})
	}
}

func TestRunExitReporterSessionFailureDoesNotFailTheReport(t *testing.T) {
	recorder := &exitReportRecorder{}
	reporter := testExitReporter(recorder.server(t).URL)
	reporter.sessions, _ = newTestLostRunSessionEnder(&fakeLostRunSessionStore{listErr: errors.New("unavailable")})

	reporter.observeTerminated(lostRunID, "", "")
	reporter.wg.Wait()
	// Recorded as delivered: a second observation does not re-report.
	reporter.observeTerminated(lostRunID, "", "")
	reporter.wg.Wait()

	if got := len(recorder.requests()); got != 1 {
		t.Fatalf("reports = %d, want 1", got)
	}
	if err := reporter.settleTerminated(context.Background(), lostRunID, "executor-1", "fingerprint"); err != nil {
		t.Fatalf("settleTerminated with a failing session store = %v, want nil", err)
	}
	reporter.wg.Wait()
}

// The dying worker's last flush can land between the query and the
// transaction. It keeps the lost run's runId, so the single pass still ends it
// rather than leaving a phantom live session behind.
func TestLostRunSessionsEndsDocsFlushedAfterTheQuery(t *testing.T) {
	store := &fakeLostRunSessionStore{docs: map[string]sessionDocState{
		"ses_live": lostRunDoc("ses_live", lostRunID, "live"),
	}}
	store.beforeEnd = func(id string, docs map[string]sessionDocState) {
		d := docs[id]
		d.Liveness = "idle"
		d.UpdateTime = d.UpdateTime.Add(time.Minute)
		docs[id] = d
	}
	ender, _ := newTestLostRunSessionEnder(store)

	ender.endRunSessions(context.Background(), lostRunID)

	if got := store.liveness("ses_live"); got != "ended" {
		t.Fatalf("liveness = %q, want ended after a late flush", got)
	}
}

package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"cloud.google.com/go/firestore"
	"google.golang.org/api/iterator"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// sessionsCollection is the telemetry session collection
// (libs/telemetry/src/server/store.ts SESSIONS_COLLECTION). The executor's
// telemetry-writer identity already writes it from every worker's hooks and
// `runner finalize`.
const sessionsCollection = "sessions"

const (
	// lostRunSessionsTimeout bounds one lost run's whole pass. It runs off the
	// exit reporter's path, so this only limits how long a stalled Firestore
	// keeps one goroutine alive.
	lostRunSessionsTimeout = 30 * time.Second
	// lostRunSessionsLimit bounds the query. A run has one provider session
	// per attempt, plus any subagents that report separately; far fewer than
	// this in practice.
	lostRunSessionsLimit = 50
)

// sessionDocState is the part of a `sessions/{id}` document this pass reads.
// UpdateTime is Firestore's own write time; the transaction re-reads the doc
// and decides on its current runId and liveness, not on this.
type sessionDocState struct {
	ID         string
	RunID      string
	Liveness   string
	UpdateTime time.Time
}

// lostRunSessionStore is the Firestore access this pass needs, so the logic
// can be tested without a server.
type lostRunSessionStore interface {
	// listRunSessions returns the docs whose runId is runID.
	listRunSessions(ctx context.Context, runID string) ([]sessionDocState, error)
	// endSessionIf re-reads id inside a transaction and sets its liveness to
	// `ended` only when decide approves the current state. It reports whether
	// it wrote.
	endSessionIf(ctx context.Context, id string, decide func(current sessionDocState, exists bool) bool) (bool, error)
}

// lostRunSessionEnder marks a lost run's non-terminal session docs ended.
type lostRunSessionEnder struct {
	store  lostRunSessionStore
	logger *slog.Logger
}

// newLostRunSessionEnder reuses the status publisher's Firestore client and
// telemetry-writer identity. It returns nil (a no-op) when publication is
// disabled, so it adds no credential or startup requirement of its own.
func newLostRunSessionEnder(publisher consoleStatusPublisher, logger *slog.Logger) *lostRunSessionEnder {
	firestorePublisher, ok := publisher.(*firestoreConsoleStatusPublisher)
	if !ok || firestorePublisher == nil || firestorePublisher.client == nil {
		return nil
	}
	return &lostRunSessionEnder{store: firestoreLostRunSessionStore{client: firestorePublisher.client}, logger: logger}
}

// shouldEndLostRunSession is the transaction's guard. A worker whose run was
// settled lost cannot write again, so its stored `live`/`idle` is a phantom.
// It still applies when the dying worker's last flush landed after the query:
// that write keeps the lost run's runId and a non-terminal liveness, and this
// single pass is the only chance to end it. Anything else is left alone: a
// doc that is already terminal (`ended` from finalize, or `stale`), and one
// that a resumed retry has since claimed under its own runId.
func shouldEndLostRunSession(runID string, current sessionDocState, exists bool) bool {
	if !exists || current.RunID != runID {
		return false
	}
	return current.Liveness == "live" || current.Liveness == "idle"
}

// endRunSessions marks each of runID's `live`/`idle` session docs ended. It
// is best effort: every failure is logged and the pass continues, and it
// returns nothing because its caller must never depend on it.
func (e *lostRunSessionEnder) endRunSessions(ctx context.Context, runID string) {
	if e == nil || e.store == nil || runID == "" {
		return
	}
	docs, err := e.store.listRunSessions(ctx, runID)
	if err != nil {
		e.logger.Warn("Listing a lost run's sessions failed; they stay as stored", slog.String("runId", runID), slog.String("error", err.Error()))
		return
	}
	for _, queried := range docs {
		if queried.Liveness != "live" && queried.Liveness != "idle" {
			continue
		}
		ended, err := e.store.endSessionIf(ctx, queried.ID, func(current sessionDocState, exists bool) bool {
			return shouldEndLostRunSession(runID, current, exists)
		})
		switch {
		case err != nil:
			e.logger.Warn("Ending a lost run's session failed; it stays as stored", slog.String("runId", runID), slog.String("sessionId", queried.ID), slog.String("error", err.Error()))
		case ended:
			e.logger.Info("Marked a lost run's session ended", slog.String("runId", runID), slog.String("sessionId", queried.ID), slog.String("was", queried.Liveness))
		default:
			e.logger.Debug("Lost run's session is terminal or claimed by another run; left as stored", slog.String("runId", runID), slog.String("sessionId", queried.ID))
		}
	}
}

type firestoreLostRunSessionStore struct {
	client *firestore.Client
}

func sessionDocStateFrom(snapshot *firestore.DocumentSnapshot) sessionDocState {
	state := sessionDocState{ID: snapshot.Ref.ID, UpdateTime: snapshot.UpdateTime}
	if runID, ok := snapshot.Data()["runId"].(string); ok {
		state.RunID = runID
	}
	if liveness, ok := snapshot.Data()["liveness"].(string); ok {
		state.Liveness = liveness
	}
	return state
}

func (s firestoreLostRunSessionStore) listRunSessions(ctx context.Context, runID string) ([]sessionDocState, error) {
	iter := s.client.Collection(sessionsCollection).Where("runId", "==", runID).Limit(lostRunSessionsLimit).Documents(ctx)
	defer iter.Stop()
	var docs []sessionDocState
	for {
		snapshot, err := iter.Next()
		if errors.Is(err, iterator.Done) {
			return docs, nil
		}
		if err != nil {
			return nil, err
		}
		docs = append(docs, sessionDocStateFrom(snapshot))
	}
}

func (s firestoreLostRunSessionStore) endSessionIf(ctx context.Context, id string, decide func(sessionDocState, bool) bool) (bool, error) {
	ref := s.client.Collection(sessionsCollection).Doc(id)
	var wrote bool
	err := s.client.RunTransaction(ctx, func(_ context.Context, tx *firestore.Transaction) error {
		wrote = false
		snapshot, err := tx.Get(ref)
		if status.Code(err) == codes.NotFound {
			return nil
		}
		if err != nil {
			return fmt.Errorf("re-reading session: %w", err)
		}
		if !decide(sessionDocStateFrom(snapshot), true) {
			return nil
		}
		wrote = true
		// Only liveness: `runner finalize` writes the same `ended` without
		// touching expireAt (a function of lastActivityAt) or the hook
		// observer, and there is no transcript here to refresh anything else.
		return tx.Update(ref, []firestore.Update{{Path: "liveness", Value: "ended"}})
	})
	if err != nil {
		return false, err
	}
	return wrote, nil
}

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// runExitReportedRetention bounds the reporter's memory of runs it already
// reported per claim generation. It only has to outlive the queue's own evidence retention: a
// terminal Job older than this has been deleted by the TTL controller at
// queueJobRetentionAge, so it can never be observed again.
const runExitReportedRetention = 2 * queueJobRetentionAge

// runExitReporter tells the Work API the moment a claimed run's worker
// terminates, so a worker that died without reporting its outcome (OOM,
// eviction, node loss, the Job deadline) is settled `lost` and retried now
// instead of when its two-hour run lease expires.
//
// It is fed by observations the executor already makes -- the Kubernetes
// queue's Job inventory read -- and adds no clock of its own. Every
// terminated claim is reported once per process, whatever its exit status: the
// server decides. A run that already reported its outcome (the normal case)
// has its claim retired once, so a restart re-reporting the retained Jobs is
// harmless. A failed report is retried on the next observation.
type runExitReporter struct {
	consoleURL   string
	runnerName   string
	httpClient   *http.Client
	acquireToken func(context.Context) (string, error)
	logger       *slog.Logger
	now          func() time.Time
	// sessions ends a lost run's phantom `live`/`idle` session docs. Nil
	// (status publication disabled) is a no-op.
	sessions *lostRunSessionEnder

	mu       sync.Mutex
	reported map[string]time.Time
	inflight map[string]struct{}
	// wg lets tests wait for the asynchronous reports to land.
	wg sync.WaitGroup
}

func newRunExitReporter(consoleURL, runnerName string, idToken func() (string, error), logger *slog.Logger) *runExitReporter {
	return &runExitReporter{
		consoleURL: consoleURL,
		runnerName: runnerName,
		// The route drains the outbox after settling a lost run; leave room
		// for that so a slow drain is not misread as a failed report.
		httpClient:   &http.Client{Timeout: 30 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }},
		acquireToken: queueClaimTokenAcquisition(idToken),
		logger:       logger,
		now:          time.Now,
		reported:     map[string]time.Time{},
		inflight:     map[string]struct{}{},
	}
}

// observeTerminated records that the worker for runID is no longer running
// and reports it asynchronously, unless it was already reported or a report
// for that exact claim is in flight. fingerprint is the immutable token hash
// recorded on the original Job at creation; the route identifies the claim by
// it, so an observation without one names no claim and is not reported.
// claimedBy is the runner name the run was claimed under (from its Job); the
// Work API accepts the report only from the claiming principal under that
// name. Empty falls back to this process's own runner name. It never blocks
// the caller (a claim admission or a status read) on the Work API.
func (r *runExitReporter) observeTerminated(runID, claimedBy, fingerprint string) {
	r.observeTerminatedWithDisruption(runID, claimedBy, fingerprint, nil)
}

// exitDisruption is the executor's exact attestation that this attempt's own
// worker Pod was removed by scheduler preemption before its container started,
// named by the Kubernetes UIDs of the Job and Pod it observed. It is untrusted
// by default: the Work API honors it only when the run's own recorded state
// agrees, and an absent or disagreeing attestation leaves the ordinary
// terminal loss. Only this exact kind exists -- eviction, node loss, an OOM, or
// a bare "the pod is gone" never produce one.
type exitDisruption struct {
	JobUID     string `json:"jobUid"`
	PodUID     string `json:"podUid"`
	ObservedAt string `json:"observedAt"`
	Kind       string `json:"kind"`
}

// schedulerPreemptionKind is the one disruption the Work API can recover from.
const schedulerPreemptionKind = "scheduler-preemption"

// observeTerminatedWithDisruption reports a terminated claim, optionally
// attesting that the scheduler preempted it before its worker container
// started. A nil attestation is the ordinary report.
func (r *runExitReporter) observeTerminatedWithDisruption(runID, claimedBy, fingerprint string, disruption *exitDisruption) {
	if r == nil || runID == "" || fingerprint == "" {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	now := r.now()
	for id, at := range r.reported {
		if now.Sub(at) > runExitReportedRetention {
			delete(r.reported, id)
		}
	}
	key := exitClaimKey(runID, fingerprint)
	if _, done := r.reported[key]; done {
		return
	}
	if _, busy := r.inflight[key]; busy {
		return
	}
	r.inflight[key] = struct{}{}
	r.wg.Add(1)
	go func() {
		defer r.wg.Done()
		runner := claimedBy
		if runner == "" {
			runner = r.runnerName
		}
		state, err := r.postContext(context.Background(), runID, runner, fingerprint, disruption)
		r.mu.Lock()
		delete(r.inflight, key)
		if err == nil {
			r.reported[key] = r.now()
		}
		r.mu.Unlock()
		switch {
		case err != nil:
			r.logger.Warn("Run exit report failed; retrying on the next observation", slog.String("runId", runID), slog.String("error", err.Error()))
		case state == "lost":
			r.logger.Warn("Run worker exited without reporting; the Work API settled it lost", slog.String("runId", runID))
			r.endLostRunSessions(runID)
		case state == stateNotClaimant:
			r.logger.Warn("Run exit report refused: this executor did not claim the run; not retried", slog.String("runId", runID), slog.String("runner", runner))
		default:
			r.logger.Debug("Run exit reported", slog.String("runId", runID), slog.String("state", state))
		}
	}()
}

// stateNotClaimant is post's answer for the route's 403: this principal and
// runner name and original fingerprint do not own the claim. This original
// claim cannot regain authority; its refusal is final and lease expiry remains
// the backstop. A replacement same-run claim has its own delivery key.
const stateNotClaimant = "not-claimant"

// postContext reports one exit as runner. The route's own 404 (the run no
// longer exists) and its claimant-mismatch 403 are final for this original
// claim, so both count as delivered; a pipeline-grant 403 is retried. A
// different same-run claim has a separate delivery key. A nil disruption is
// the ordinary report.
func (r *runExitReporter) postContext(ctx context.Context, runID, runner, fingerprint string, disruption *exitDisruption) (string, error) {
	token, err := r.acquireToken(ctx)
	if err != nil {
		return "", fmt.Errorf("minting exit report id token: %w", err)
	}
	payload := struct {
		Runner           string          `json:"runner"`
		ClaimFingerprint string          `json:"claimFingerprint"`
		Disruption       *exitDisruption `json:"disruption,omitempty"`
	}{Runner: runner, ClaimFingerprint: fingerprint, Disruption: disruption}
	body, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	req, err := http.NewRequestWithContext(
		ctx, http.MethodPost,
		strings.TrimRight(r.consoleURL, "/")+"/api/work/v1/runs/"+url.PathEscape(runID)+"/exit",
		bytes.NewReader(body),
	)
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := r.httpClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("exit report request: %w", err)
	}
	defer resp.Body.Close()
	respBody, err := io.ReadAll(io.LimitReader(resp.Body, claimResponseBodyLimit))
	if err != nil {
		return "", fmt.Errorf("reading exit report response: %w", err)
	}
	switch resp.StatusCode {
	case http.StatusOK:
		var result struct {
			State string `json:"state"`
		}
		if err := json.Unmarshal(respBody, &result); err != nil {
			return "", fmt.Errorf("decoding exit report response: %w", err)
		}
		return result.State, nil
	case http.StatusNotFound:
		// Only the route's own answer means the run is gone. A 404 from a
		// console that does not serve this route yet (or a wrong URL) must
		// stay retryable rather than silently fall back to lease expiry.
		if bytes.Contains(respBody, []byte("unknown run")) {
			return "unknown-run", nil
		}
		return "", fmt.Errorf("exit report returned 404 without the route's unknown-run answer")
	case http.StatusForbidden:
		// A missing pipeline grant is configuration that can be restored, so
		// it stays retryable: a restored grant then settles the run without
		// waiting for its lease. Any other 403 means another principal or
		// runner name claimed the run (or it was claimed before claims
		// recorded their principal); retrying cannot change that.
		if bytes.Contains(respBody, []byte("pipeline not granted")) {
			return "", fmt.Errorf("exit report refused: this executor is not granted the run's pipeline")
		}
		return stateNotClaimant, nil
	default:
		return "", fmt.Errorf("exit report returned %d", resp.StatusCode)
	}
}

// A refused old Job cannot suppress an exit from a later same-run claim.
func exitClaimKey(runID, fingerprint string) string { return runID + "\x00" + fingerprint }

// Retirement needs an actual logical settlement attempt inside its recovery
// deadline. It cannot use the asynchronous observation's delivery cache: an
// accepted terminal result may still have cleanup debt, and a claimant refusal
// is not evidence that this receipt may release.
func (r *runExitReporter) settleTerminated(ctx context.Context, runID, runner, fingerprint string) error {
	return r.settleTerminatedWithDisruption(ctx, runID, runner, fingerprint, nil)
}

func (r *runExitReporter) settleTerminatedWithDisruption(ctx context.Context, runID, runner, fingerprint string, disruption *exitDisruption) error {
	if r == nil || runID == "" || runner == "" || fingerprint == "" {
		return fmt.Errorf("receipt exit authority unavailable")
	}
	// Preserve the observed cause even when retirement wins the race with the
	// asynchronous inventory observer. The server still fences provider start,
	// original claim, Job UID, receipt time, and the separate recovery budget.
	state, err := r.postContext(ctx, runID, runner, fingerprint, disruption)
	if err != nil {
		return err
	}
	switch state {
	case "lost":
		r.endLostRunSessions(runID)
		return nil
	case "finished", "canceled":
		return nil
	default:
		return fmt.Errorf("receipt logical settlement unproven")
	}
}

// endLostRunSessions marks runID's session docs ended in the background. A
// worker that died without reporting never ran `runner finalize`, so its
// sessions would otherwise stay stored `live` forever. It never blocks or
// fails the exit report.
func (r *runExitReporter) endLostRunSessions(runID string) {
	if r.sessions == nil {
		return
	}
	r.wg.Add(1)
	go func() {
		defer r.wg.Done()
		ctx, cancel := context.WithTimeout(context.Background(), lostRunSessionsTimeout)
		defer cancel()
		r.sessions.endRunSessions(ctx, runID)
	}()
}

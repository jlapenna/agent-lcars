package main

import (
	"bytes"
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
// reported. It only has to outlive the queue's own evidence retention: a
// terminal Job older than this has been deleted (TTL and cleanup both stop
// at directRunnerExitedRetentionAge), so it can never be observed again.
const runExitReportedRetention = 2 * directRunnerExitedRetentionAge

// runExitReporter tells the Work API the moment a claimed run's worker
// terminates, so a worker that died without reporting its outcome (OOM,
// eviction, node loss, the Job deadline) is settled `lost` and retried now
// instead of when its two-hour run lease expires.
//
// It is fed by observations the executor already makes -- the Kubernetes
// queue's Job inventory read -- and adds no clock of its own. Every
// terminated Job is reported once per process, whatever its exit status: the
// server decides. A run that already reported its outcome (the normal case)
// is answered unchanged, so a restart re-reporting the retained Jobs is
// harmless. A failed report is retried on the next observation.
type runExitReporter struct {
	consoleURL string
	runnerName string
	httpClient *http.Client
	idToken    func() (string, error)
	logger     *slog.Logger
	now        func() time.Time

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
		httpClient: &http.Client{Timeout: 30 * time.Second},
		idToken:    idToken,
		logger:     logger,
		now:        time.Now,
		reported:   map[string]time.Time{},
		inflight:   map[string]struct{}{},
	}
}

// observeTerminated records that the worker for runID is no longer running
// and reports it asynchronously, unless it was already reported or a report
// is in flight. It never blocks the caller (a claim admission or a status
// read) on the Work API.
func (r *runExitReporter) observeTerminated(runID string) {
	if r == nil || runID == "" {
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
	if _, done := r.reported[runID]; done {
		return
	}
	if _, busy := r.inflight[runID]; busy {
		return
	}
	r.inflight[runID] = struct{}{}
	r.wg.Add(1)
	go func() {
		defer r.wg.Done()
		state, err := r.post(runID)
		r.mu.Lock()
		delete(r.inflight, runID)
		if err == nil {
			r.reported[runID] = r.now()
		}
		r.mu.Unlock()
		switch {
		case err != nil:
			r.logger.Warn("Run exit report failed; retrying on the next observation", slog.String("runId", runID), slog.String("error", err.Error()))
		case state == "lost":
			r.logger.Warn("Run worker exited without reporting; the Work API settled it lost", slog.String("runId", runID))
		case state == "pipeline-not-granted":
			r.logger.Warn("Run exit report refused: this executor is not granted the run's pipeline", slog.String("runId", runID))
		default:
			r.logger.Debug("Run exit reported", slog.String("runId", runID), slog.String("state", state))
		}
	}()
}

// post reports one exit. The route's 404 (the run no longer exists) and 403
// (this executor is not granted the run's pipeline) can never succeed on a
// later attempt, so they count as delivered.
func (r *runExitReporter) post(runID string) (string, error) {
	token, err := r.idToken()
	if err != nil {
		return "", fmt.Errorf("minting exit report id token: %w", err)
	}
	body, err := json.Marshal(map[string]string{"runner": r.runnerName})
	if err != nil {
		return "", err
	}
	req, err := http.NewRequest(
		http.MethodPost,
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
		return "pipeline-not-granted", nil
	default:
		return "", fmt.Errorf("exit report returned %d", resp.StatusCode)
	}
}

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"golang.org/x/oauth2"
	"google.golang.org/api/idtoken"
)

// directRunnerLaunch is what pollOnce hands to its reservation's launch
// callback once a claim succeeds -- what a direct-mode worker needs, nothing
// more. It is never logged whole (runToken is a live credential).
type directRunnerLaunch struct {
	runID      string
	runToken   string
	pipeline   string
	consoleURL string
	// runner is the name this executor claimed the run under. The Work API
	// accepts the run's exit report only under that same name, so the
	// Kubernetes queue records it on the Job: a restarted executor (whose
	// hostname-derived name changed) still reports as the claimant.
	runner string
}

// queueExecutorConfig is the poller's whole dependency surface, kept
// small and injectable so pollOnce is testable without a real GCP
// credential or Kubernetes API (see queue_executor_test.go).
type queueExecutorConfig struct {
	consoleURL string
	runnerName string
	httpClient *http.Client
	// recover maintains claimed workers: it retires settled claims, observes
	// placement and resumes eligible suspended originals. A bounded,
	// non-overlapping sweep never holds the claim path.
	recover func(context.Context) error
	// idToken mints a Google ID token for the console's work audience.
	// Production wires this to idTokenFromSource; tests inject a stub.
	idToken func() (string, error)
	// reserve acquires one process-local capacity slot before the durable
	// claim, and returns the launch for that slot. A nil reservation means
	// the backend is currently full, so the item remains queued without
	// minting a token.
	//
	// A launch failure leaves the run claimed on the control plane -- there
	// is no un-claim callback, by design. Safe startup handoffs are retried
	// under the original token; unrecoverable launches expire at the first-heartbeat deadline (15 minutes),
	// `expireLease` settles this exact run to `lost`, and the orchestrator's
	// own bounded auto-retry (`Orchestrator.sweepExpired`,
	// `MAX_AUTO_RETRIES`, then parked) mints a brand new run for the same
	// task, which a later poll claims instead.
	reserve func() (*directRunnerReservation, error)
}

// claimResponse is the Work API's claim. Every claim this executor makes is
// placement-aware (the server fences startup through placement observations
// instead of a claim-time deadline), and the server echoes placementAware
// only when the durable claim carries that state, so the echo is required.
type claimResponse struct {
	PlacementAware bool   `json:"placementAware"`
	RunID          string `json:"runId"`
	WorkID         string `json:"workId"`
	Pipeline       string `json:"pipeline"`
	Token          string `json:"token"`
	ExpiresAt      string `json:"expiresAt"`
}

type directRunnerReservation struct {
	launch  func(directRunnerLaunch) error
	release func()
}

// claimResponseBodyLimit bounds how much of a claim response pollOnce will
// ever read, mirroring github_http.go's readBoundedBody convention: an
// unbounded json.Decoder read against a misbehaving or compromised console
// (or a proxy sitting in front of it) could pin unbounded memory decoding a
// single claim response. 64 KiB is far larger than any real claim body
// (run id, work id, pipeline name, token, timestamp).
const claimResponseBodyLimit = 64 << 10

// queuePollOutcome is deliberately bounded because it becomes a Prometheus
// metric label. Keep operational causes here rather than using error strings
// as labels.
type queuePollOutcome string

const (
	queuePollOutcomeIdle204      queuePollOutcome = "idle_204"
	queuePollOutcomeIdleEmpty    queuePollOutcome = "idle_empty"
	queuePollOutcomePollError    queuePollOutcome = "poll_error"
	queuePollOutcomeClaimed      queuePollOutcome = "claimed"
	queuePollOutcomeLaunchErr    queuePollOutcome = "launch_error"
	queuePollOutcomeCapacityWait queuePollOutcome = "capacity_wait"
)

// pollOnce claims at most one run and, on success, launches it through the
// reserved slot. "Nothing
// queued for these pipelines" is not an error -- the caller's loop simply
// tries again on the next tick -- and the console answers it two ways this
// function must both tolerate: a bare 204, or (what it actually sends today)
// 200 with an empty body.
func pollOnce(cfg queueExecutorConfig) error {
	_, err := pollOnceWithOutcome(cfg)
	return err
}

// pollOnceWithOutcome preserves pollOnce's API/error behavior while exposing
// a bounded operational outcome to the durable poller metrics. A valid claim
// is counted before launch, so a launch failure is visible as both a claimed
// run and a failed launch rather than being mistaken for an empty queue.
func pollOnceWithOutcome(cfg queueExecutorConfig) (queuePollOutcome, error) {
	reservation, err := cfg.reserve()
	if err != nil {
		return queuePollOutcomePollError, fmt.Errorf("reserving direct-runner capacity: %w", err)
	}
	if reservation == nil {
		return queuePollOutcomeCapacityWait, nil
	}
	defer reservation.release()
	client := cfg.httpClient
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}
	token, err := cfg.idToken()
	if err != nil {
		return queuePollOutcomePollError, fmt.Errorf("minting claim id token: %w", err)
	}
	body, err := json.Marshal(map[string]any{"runner": cfg.runnerName, "placementAware": true})
	if err != nil {
		return queuePollOutcomePollError, err
	}
	req, err := http.NewRequest(http.MethodPost, cfg.consoleURL+"/api/work/v1/runs/claim", bytes.NewReader(body))
	if err != nil {
		return queuePollOutcomePollError, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		return queuePollOutcomePollError, fmt.Errorf("claim request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNoContent {
		return queuePollOutcomeIdle204, nil
	}
	if resp.StatusCode != http.StatusOK {
		return queuePollOutcomePollError, fmt.Errorf("claim returned %d", resp.StatusCode)
	}
	// Read the whole (bounded) body up front, rather than handing
	// resp.Body straight to json.NewDecoder: an empty or whitespace-only
	// 200 body is a valid "nothing queued" answer, not a decode error, and
	// json.Decoder has no clean way to distinguish "empty" from "the first
	// token was invalid" without this same read-first shape.
	respBody, err := io.ReadAll(io.LimitReader(resp.Body, claimResponseBodyLimit))
	if err != nil {
		return queuePollOutcomePollError, fmt.Errorf("reading claim response: %w", err)
	}
	if len(bytes.TrimSpace(respBody)) == 0 {
		return queuePollOutcomeIdleEmpty, nil
	}
	var claimed claimResponse
	if err := json.Unmarshal(respBody, &claimed); err != nil {
		return queuePollOutcomePollError, fmt.Errorf("decoding claim response: %w", err)
	}
	if claimed.RunID == "" || claimed.Token == "" {
		// A parseable-but-incomplete claim response (e.g. a stray `{}`) is
		// exactly as unlaunchable as no body at all -- never start a
		// container with a missing run id or token.
		return queuePollOutcomeIdleEmpty, nil
	}
	if !claimed.PlacementAware {
		return queuePollOutcomePollError, fmt.Errorf("placement-aware claim not acknowledged")
	}
	queueExecutorClaimsTotal.WithLabelValues(claimed.Pipeline).Inc()
	err = reservation.launch(directRunnerLaunch{
		runID:      claimed.RunID,
		runToken:   claimed.Token,
		pipeline:   claimed.Pipeline,
		consoleURL: cfg.consoleURL,
		runner:     cfg.runnerName,
	})
	if err != nil {
		return queuePollOutcomeLaunchErr, err
	}
	return queuePollOutcomeClaimed, nil
}

// newDirectRunnerIDTokenSource builds the Google ID token source used to
// authenticate every claim poll, directly from the same telemetry-writer
// service-account key console_status.go already reads via
// GOOGLE_APPLICATION_CREDENTIALS -- no metadata server (this fleet does not
// run on GCE/Cloud Run -- see the design spec), no new IAM grant: a
// service-account key can self-mint an ID token for any audience from its
// own private key alone.
//
// Built once, at orchestrator startup (see runOrchestrator's queue-executor
// block), not per poll: idtoken.NewTokenSource reads and
// validates the credentials file on construction, and that file never
// changes at runtime, so rebuilding it every 15s tick was repeated,
// unnecessary I/O. The returned source caches and refreshes the minted
// token itself (ordinary oauth2.TokenSource semantics) -- callers just call
// .Token() per poll, which is what queueExecutorConfig.idToken does.
func newDirectRunnerIDTokenSource(ctx context.Context, keyPath, audience string) (oauth2.TokenSource, error) {
	// The source caches tokens across claim, schedule, exit and retirement
	// callers. Its service-account refresh uses this context HTTP client;
	// the root lifecycle alone would allow a stalled refresh to pin all of
	// those callers indefinitely, including bounded recovery sweeps.
	client := &http.Client{Timeout: 10 * time.Second}
	if existing, ok := ctx.Value(oauth2.HTTPClient).(*http.Client); ok && existing != nil {
		copy := *existing
		client = &copy
		if client.Timeout <= 0 || client.Timeout > 10*time.Second {
			client.Timeout = 10 * time.Second
		}
	}
	ctx = context.WithValue(ctx, oauth2.HTTPClient, client)
	source, err := idtoken.NewTokenSource(ctx, audience, idtoken.WithCredentialsFile(keyPath))
	if err != nil {
		return nil, fmt.Errorf("building id token source: %w", err)
	}
	return source, nil
}

// idTokenFromSource adapts an oauth2.TokenSource's .Token() call to the
// queueExecutorConfig.idToken shape (func() (string, error)) pollOnce
// expects. A thin wrapper so runOrchestrator only builds the token source
// once (see newDirectRunnerIDTokenSource) and this is what actually runs on
// every poll tick.
func idTokenFromSource(source oauth2.TokenSource) (string, error) {
	tok, err := source.Token()
	if err != nil {
		return "", fmt.Errorf("minting id token: %w", err)
	}
	return tok.AccessToken, nil
}

// runQueueExecutorPoller ticks pollOnce on cfg's interval until ctx is
// done. A single failed claim is logged and never fatal: the next tick tries
// again. Startup recovery retries original eligible suspended Jobs without
// blocking claims; unrecoverable attempts retain bounded first-heartbeat deadline recovery.
func runQueueExecutorPoller(ctx context.Context, cfg queueExecutorConfig, interval time.Duration, logger *slog.Logger) {
	var background sync.WaitGroup
	defer background.Wait()
	recoveryRunning := make(chan struct{}, 1)
	recoverStartup := func() {
		if cfg.recover == nil {
			return
		}
		select {
		case recoveryRunning <- struct{}{}:
			background.Add(1)
			go func() {
				defer background.Done()
				defer func() { <-recoveryRunning }()
				recoveryCtx, cancel := context.WithTimeout(ctx, queueStartupRecoveryTimeout)
				defer cancel()
				if err := cfg.recover(recoveryCtx); err != nil {
					logger.Warn("Queue Job startup recovery incomplete", slog.Any("error", err))
				}
			}()
		default:
		}
	}
	recoverStartup()
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			recoverStartup()
			outcome, err := pollOnceWithOutcome(cfg)
			recordQueueExecutorPollOutcome(outcome)
			if err != nil {
				logger.Warn("queue executor poll failed", slog.String("error", err.Error()))
			}
		}
	}
}

// queueExecutorStartupState is the running executor's one-hot startup state
// (the queue_executor_state metric). An unconfigured executor never reaches
// runOrchestrator: validateQueueExecutorEnvironment refuses startup first, so
// the running process is either misconfigured (a credential, token source or
// Kubernetes preflight failed) or ready. Which pipelines it may claim is
// intentionally absent here: the authenticated work.executor grant is the
// single server-side capability source.
type queueExecutorStartupState string

const (
	queueExecutorStateMisconfigured queueExecutorStartupState = "misconfigured"
	queueExecutorStateReady         queueExecutorStartupState = "ready"
)

// queueExecutorAudience resolves the Google ID token audience the queue
// executor's claim calls are minted for: LCARS_WORK_AUDIENCE if set,
// else the "agent-lcars-work" audience configured by the console deployment.
// The console requires AGENT_LCARS_WORK_AUDIENCE at boot; deployments that
// customize it must set LCARS_WORK_AUDIENCE to the same value here.
func queueExecutorAudience(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "agent-lcars-work"
	}
	return trimmed
}

// queueExecutorRunnerName resolves the claim body's `runner` identity: the
// process's own hostname, or "autoscaler" if os.Hostname failed (e.g. a
// container without a resolvable hostname) or returned an empty string.
// runQueueExecutorPoller still needs SOME stable-ish runner name to claim
// with -- a hostname lookup failure at startup should not also take down
// the queue executor, the same "degrade, don't crash" posture
// runListenerSupervisor's own os.Hostname fallback (a random uuid) takes
// for its GitHub message-session owner.
func queueExecutorRunnerName(hostname string, err error) string {
	if err != nil || hostname == "" {
		return "autoscaler"
	}
	return hostname
}

// directRunnerCodexVolatileMountPath is where a Codex worker writes its
// rotating auth.json, transcript, and persistence payload: a memory-backed
// emptyDir (see kubernetesQueue.job), discarded when the Pod ends.
const directRunnerCodexVolatileMountPath = "/run/agent-lcars-codex"

const (
	// queueClaimPollInterval is how often the executor reserves local
	// capacity and asks the Work API for the next admitted run.
	// schedule-justification: the executor pulls admitted runs from POST /api/work/v1/runs/claim, so this bounds how long admitted work waits to start. No event channel reaches the executor without new IAM, and a held long-poll would keep the request-billed console instance billable 100% of the time (measured 7.4% today) against a $5/month budget.
	queueClaimPollInterval = 15 * time.Second

	// queueJobRetentionAge is the finished-Job TTL (TTLSecondsAfterFinished)
	// every queue Job carries: the Kubernetes TTL controller is the only
	// finished-Job retention, keeping terminated Pod logs for a day.
	queueJobRetentionAge = 24 * time.Hour

	queueStartupRecoveryTimeout = 20 * time.Second
)

// directRunnerImage is the one image contract for QueueExecutor Jobs: Claude,
// Codex, and OpenCode all execute through this same direct-runner image.
// LCARS_QUEUE_RUNNER_IMAGE is deployment knowledge (this fleet's own registry
// and image tag) this repo cannot infer, so it is required, explicit, and
// fails loudly rather than defaulting to any fleet's image.
func directRunnerImage() (string, error) {
	image := strings.TrimSpace(os.Getenv("LCARS_QUEUE_RUNNER_IMAGE"))
	if image == "" {
		return "", fmt.Errorf("LCARS_QUEUE_RUNNER_IMAGE is required to launch a direct-mode runner (the QueueExecutor container image reference, e.g. registry.example.com/homelab-runner:jit-node24)")
	}
	return image, nil
}

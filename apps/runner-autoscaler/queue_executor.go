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
	// recover resumes Jobs interrupted between create and start before new
	// claims.
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
	// is no un-claim callback, by design. Recovery is passive, and NOT a
	// return to `queued`: the claim's lease eventually expires (`LEASE_MS`),
	// `expireLease` settles this exact run to `lost`, and the orchestrator's
	// own bounded auto-retry (`Orchestrator.sweepExpired`,
	// `MAX_AUTO_RETRIES`, then parked) mints a brand new run for the same
	// task, which a later poll claims instead.
	reserve func() (*directRunnerReservation, error)
	// draining reports whether this instance is paused by SIGUSR1 (set in
	// runOrchestrator's own select loop, via an atomic.Bool the poller
	// goroutine reads). pollOnce short-circuits to a no-op while true: a
	// claim minted moments before this instance is replaced would just be
	// another launch failure to recover from. nil means "never draining".
	draining func() bool
	// cleanup garbage-collects backend state off the claim path (see
	// queueJobCleanupInterval). It must never participate in claiming or
	// affect a claim's recovery semantics.
	cleanup func(context.Context) error
}

type claimResponse struct {
	RunID     string `json:"runId"`
	WorkID    string `json:"workId"`
	Pipeline  string `json:"pipeline"`
	Token     string `json:"token"`
	ExpiresAt string `json:"expiresAt"`
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
	queuePollOutcomeDraining     queuePollOutcome = "draining"
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
	if cfg.draining != nil && cfg.draining() {
		return queuePollOutcomeDraining, nil
	}
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
	body, err := json.Marshal(map[string]string{"runner": cfg.runnerName})
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
// again. This is also the only handling a failed launch gets: see
// queueExecutorConfig.reserve's doc comment for how a claimed-but-never-
// launched run recovers (lease expiry -> lost -> a brand new run minted by
// auto-retry), since there is no un-claim callback to call here instead.
func runQueueExecutorPoller(ctx context.Context, cfg queueExecutorConfig, interval time.Duration, logger *slog.Logger) {
	if cfg.recover != nil {
		if err := cfg.recover(ctx); err != nil {
			logger.Warn("Queue Job startup recovery incomplete", slog.Any("error", err))
		}
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	cleanupTicker := time.NewTicker(queueJobCleanupInterval)
	defer cleanupTicker.Stop()
	cleanupRunning := make(chan struct{}, 1)
	cleanup := func() {
		if cfg.cleanup == nil {
			return
		}
		// Cleanup lists and may delete several Jobs. It must never hold up the
		// next work claim, and a slow API server must not accumulate
		// overlapping cleanup goroutines.
		select {
		case cleanupRunning <- struct{}{}:
			go func() {
				defer func() { <-cleanupRunning }()
				cleanupCtx, cancel := context.WithTimeout(ctx, queueJobCleanupSweepTimeout)
				defer cancel()
				if err := cfg.cleanup(cleanupCtx); err != nil {
					logger.Warn("queue Job cleanup failed", slog.String("error", err.Error()))
				}
			}()
		default:
			logger.Debug("queue Job cleanup still running; skipping overlapping sweep")
		}
	}
	// Sweep a finite pre-existing backlog immediately rather than waiting for
	// the first interval. This never touches an active Job and has no claim
	// side effect.
	cleanup()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			outcome, err := pollOnceWithOutcome(cfg)
			recordQueueExecutorPollOutcome(outcome)
			if err != nil {
				logger.Warn("queue executor poll failed", slog.String("error", err.Error()))
			}
		case <-cleanupTicker.C:
			cleanup()
		}
	}
}

// queueExecutorStartupState gates the durable poller on every
// deployment-owned connection and credential path it needs. Which pipelines
// it may claim is intentionally absent here: the authenticated work.executor
// grant is the single server-side capability source.
type queueExecutorStartupState string

const (
	queueExecutorStateDisabled      queueExecutorStartupState = "disabled"
	queueExecutorStateMisconfigured queueExecutorStartupState = "misconfigured"
	queueExecutorStateReady         queueExecutorStartupState = "ready"
)

// queueExecutorStartupStatus distinguishes an intentionally absent queue
// deployment (no console URL) from an incomplete deployment. Operators can
// alert on the latter without treating a host that has never been configured
// for queue work as a failed worker.
func queueExecutorStartupStatus(consoleURL, credentialsFile string) (start bool, state queueExecutorStartupState, reason string) {
	if strings.TrimSpace(consoleURL) == "" {
		return false, queueExecutorStateDisabled, "LCARS_CONSOLE_URL is required for the queue executor"
	}
	for _, required := range []struct {
		name  string
		value string
	}{
		{"LCARS_CONSOLE_URL", consoleURL},
		{"GOOGLE_APPLICATION_CREDENTIALS", credentialsFile},
	} {
		if strings.TrimSpace(required.value) == "" {
			return false, queueExecutorStateMisconfigured, required.name + " is required for the queue executor"
		}
	}
	return true, queueExecutorStateReady, ""
}

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

// Bounded post-exit evidence for terminated queue Jobs. The Job TTL controller
// removes every finished Job after queueJobRetentionAge; kubernetesQueue.cleanup
// additionally keeps at most queueJobRetentionPerSlot finished Jobs per
// max_concurrent slot, so a burst of failures cannot accumulate unbounded Jobs
// inside that window.
const (
	queueJobRetentionAge     = 24 * time.Hour
	queueJobRetentionPerSlot = 5
	// queueJobCleanupInterval is the garbage-collection backstop for the one
	// Kubernetes state nothing else reaps: a suspended, never-started Job shell
	// left behind when the executor died between creating the Job and its
	// run-token Secret. Such a shell counts against max_concurrent until removed.
	// This is a local Kubernetes API list, never a Work API call.
	queueJobCleanupInterval = 15 * time.Minute
	// queueJobCleanupSweepTimeout caps one cleanup sweep. It runs off the claim
	// loop, so a slow API server never delays a claim.
	queueJobCleanupSweepTimeout = 30 * time.Second
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

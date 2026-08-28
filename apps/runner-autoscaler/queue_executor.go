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
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/filters"
	dockerclient "github.com/docker/docker/client"
	"github.com/google/uuid"
	"golang.org/x/oauth2"
	"google.golang.org/api/idtoken"
)

// directRunnerLaunch is what pollOnce hands to its launch callback once a
// claim succeeds -- the env a direct-mode container needs, nothing more.
// It is never logged whole (runToken is a live credential); see pollOnce
// and launchDirectRunner.
type directRunnerLaunch struct {
	runID      string
	runToken   string
	pipeline   string
	consoleURL string
}

// queueExecutorConfig is the poller's whole dependency surface, kept
// small and injectable so pollOnce is testable without a real GCP
// credential or Docker host (see queue_executor_test.go).
type queueExecutorConfig struct {
	consoleURL string
	runnerName string
	httpClient *http.Client
	// idToken mints a Google ID token for the console's work audience.
	// Production wires this to idTokenFromTelemetryWriterKey below; tests
	// inject a stub.
	idToken func() (string, error)
	// launch starts one direct-mode container for a successful claim.
	// Production wires this to a Docker container-create call against a
	// host picked from the configured pool (round-robin -- see the design
	// spec's "Autoscaler change": deliberately not Scaler.pickHost's
	// load-aware logic, a stated simplification for this first cut).
	//
	// A launch failure here leaves the run claimed on the control plane --
	// there is no callback to un-claim it, by design (see the design spec's
	// "Autoscaler change"). Recovery is passive, and NOT a return to
	// `queued`: runQueueExecutorPoller logs the error and moves on, the
	// claim's lease eventually expires (`LEASE_MS`, 2h), `expireLease`
	// settles this exact run to `lost` -- its `queue.state` stays `claimed`
	// forever, nothing ever un-claims it or moves it back to `queued` -- and
	// the orchestrator's own bounded auto-retry (`Orchestrator.sweepExpired`,
	// `MAX_AUTO_RETRIES`, then parked) mints a BRAND NEW `queue`-executor run
	// for the same task, which a later poll (from this host or another)
	// claims instead. Nothing in this file attempts to un-claim or retry a
	// failed launch directly -- the retry is a different run entirely.
	launch func(directRunnerLaunch) error
	// draining reports whether this instance is mid-SIGUSR1 drain (set in
	// runOrchestrator's own select loop, via an atomic.Bool the poller
	// goroutine reads -- see runOrchestrator's "Native work items,
	// queue-executor sub-project" comment). pollOnce short-circuits to a
	// no-op while true: a drain already means "stop accepting new work" for
	// every GitHub-mode scale set (Scaler.BeginDrain), and a claim minted
	// moments before this instance is replaced would just be another
	// launch failure to recover from. nil (every existing test's zero
	// value) means "never draining" -- pollOnce treats a nil draining the
	// same as one that always returns false.
	draining func() bool
}

type claimResponse struct {
	RunID     string `json:"runId"`
	WorkID    string `json:"workId"`
	Pipeline  string `json:"pipeline"`
	Token     string `json:"token"`
	ExpiresAt string `json:"expiresAt"`
}

// claimResponseBodyLimit bounds how much of a claim response pollOnce will
// ever read, mirroring github_http.go's readBoundedBody convention: an
// unbounded json.Decoder read against a misbehaving or compromised console
// (or a proxy sitting in front of it) could pin unbounded memory decoding a
// single claim response. 64 KiB is far larger than any real claim body
// (run id, work id, pipeline name, token, timestamp).
const claimResponseBodyLimit = 64 << 10

// pollOnce claims at most one run and, on success, launches it. "Nothing
// queued for these pipelines" is not an error -- the caller's loop simply
// tries again on the next tick -- and the console answers it two ways this
// function must both tolerate: a bare 204, or (what it actually sends today)
// 200 with an empty body.
func pollOnce(cfg queueExecutorConfig) error {
	if cfg.draining != nil && cfg.draining() {
		return nil
	}
	client := cfg.httpClient
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}
	token, err := cfg.idToken()
	if err != nil {
		return fmt.Errorf("minting claim id token: %w", err)
	}
	body, err := json.Marshal(map[string]string{"runner": cfg.runnerName})
	if err != nil {
		return err
	}
	req, err := http.NewRequest(http.MethodPost, cfg.consoleURL+"/api/work/v1/runs/claim", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("claim request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNoContent {
		return nil
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("claim returned %d", resp.StatusCode)
	}
	// Read the whole (bounded) body up front, rather than handing
	// resp.Body straight to json.NewDecoder: an empty or whitespace-only
	// 200 body is a valid "nothing queued" answer, not a decode error, and
	// json.Decoder has no clean way to distinguish "empty" from "the first
	// token was invalid" without this same read-first shape.
	respBody, err := io.ReadAll(io.LimitReader(resp.Body, claimResponseBodyLimit))
	if err != nil {
		return fmt.Errorf("reading claim response: %w", err)
	}
	if len(bytes.TrimSpace(respBody)) == 0 {
		return nil
	}
	var claimed claimResponse
	if err := json.Unmarshal(respBody, &claimed); err != nil {
		return fmt.Errorf("decoding claim response: %w", err)
	}
	if claimed.RunID == "" || claimed.Token == "" {
		// A parseable-but-incomplete claim response (e.g. a stray `{}`) is
		// exactly as unlaunchable as no body at all -- never start a
		// container with a missing run id or token.
		return nil
	}
	return cfg.launch(directRunnerLaunch{
		runID:      claimed.RunID,
		runToken:   claimed.Token,
		pipeline:   claimed.Pipeline,
		consoleURL: cfg.consoleURL,
	})
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
// done. A single failed claim is logged and never fatal -- the same
// level-triggered, keep-trying-next-tick discipline HandleDesiredRunnerCount
// already uses for a failed scale-up. This is also the only handling a
// failed launch gets: see queueExecutorConfig.launch's doc comment for how
// a claimed-but-never-launched run recovers (lease expiry -> lost -> a
// brand new run minted by auto-retry), since there is no un-claim callback
// to call here instead.
func runQueueExecutorPoller(ctx context.Context, cfg queueExecutorConfig, interval time.Duration, logger *slog.Logger) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := pollOnce(cfg); err != nil {
				logger.Warn("queue executor poll failed", slog.String("error", err.Error()))
			}
		}
	}
}

// queueExecutorStartupDecision starts the durable poller only when every
// deployment-owned connection and credential path it needs is present. Which
// pipelines it may claim is intentionally absent here: the authenticated
// work.executor grant is the single server-side capability source.
func queueExecutorStartupDecision(consoleURL, credentialsFile, writerKeyPath, claudeTokenPath string) (start bool, reason string) {
	for _, required := range []struct {
		name  string
		value string
	}{
		{"LCARS_CONSOLE_URL", consoleURL},
		{"GOOGLE_APPLICATION_CREDENTIALS", credentialsFile},
		{"LCARS_QUEUE_TELEMETRY_WRITER_HOST_PATH", writerKeyPath},
		{"LCARS_QUEUE_CLAUDE_TOKEN_HOST_PATH", claudeTokenPath},
	} {
		if strings.TrimSpace(required.value) == "" {
			return false, required.name + " is required for the queue executor"
		}
	}
	return true, ""
}

// queueExecutorAudience resolves the Google ID token audience the queue
// executor's claim calls are minted for: LCARS_WORK_AUDIENCE if set,
// else the same "agent-lcars-work" default the console's own
// AGENT_LCARS_WORK_AUDIENCE (route.ts's googleIdTokenVerifier) falls back
// to, so an unconfigured deployment's autoscaler and console agree without
// either side setting anything.
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

// Direct-mode containers are launched outside any Scaler's runner-tracking
// state (they are one-shot, not GitHub-registered, and never adopted by
// HandleDesiredRunnerCount -- see the design spec's "Autoscaler change").
// These labels exist only so launchDirectRunner can count a host's current
// direct-mode containers for its own, independent concurrency cap.
const (
	directRunnerLabelKey      = "agent-lcars.direct-runner"
	directRunnerRunIDLabelKey = "agent-lcars.direct-runner.run-id"
	// directRunnerTelemetryWriterMountPath is the fixed in-container path
	// direct-runner.sh reads the telemetry-writer credential from
	// (WRITER_CREDENTIALS_FILE is hard-coded to this path in
	// runner-image/direct-runner.sh, not caller-configurable).
	directRunnerTelemetryWriterMountPath = "/run/secrets/telemetry-writer.json"
	// directRunnerClaudeTokenMountPath is the fixed in-container path
	// direct-runner.sh reads the claude CLI's long-lived OAuth token from
	// and exports as CLAUDE_CODE_OAUTH_TOKEN immediately before invoking
	// `claude` -- never placed in this container's Config.Env (see
	// launchDirectRunnerOnHost): a file mounted here is only visible to
	// something with exec/proc access to the running container, while an
	// env var set at ContainerCreate time is visible to anything that can
	// `docker inspect` the container on this host. Matches the
	// telemetry-writer.json pattern immediately above, not a new one.
	directRunnerClaudeTokenMountPath = "/run/secrets/claude-code-oauth-token"
)

// directRunnerHostCursor round-robins launchDirectRunner across the
// configured Docker hosts. Package-level and atomic rather than threaded
// through queueExecutorConfig: the design spec calls for simple round-robin
// placement here (explicitly not Scaler.pickHost's load-aware scoring), and
// a single poller goroutine is the only production caller.
var directRunnerHostCursor atomic.Uint64

// launchDirectRunner starts one direct-mode runner container for a
// successful claim, on a host picked round-robin from resolved's configured
// Docker hosts. It is the queueExecutorConfig.launch implementation wired
// in production (see runOrchestrator's queue-executor block); pollOnce's
// own tests inject a stub launch instead, so this function's coverage is the
// docker-facing tests in queue_executor_test.go that exercise
// launchDirectRunnerOnHost (and this function's round-robin) directly
// against fakeDockerServer, via an injected client factory the same way
// newDockerClient itself is the injected default here.
func launchDirectRunner(ctx context.Context, resolved resolvedOrchestratorConfig, l directRunnerLaunch, logger *slog.Logger) error {
	return launchDirectRunnerWithClient(ctx, resolved, l, newDockerClient, logger)
}

func launchDirectRunnerWithClient(ctx context.Context, resolved resolvedOrchestratorConfig, l directRunnerLaunch, newClient func(target string) (*dockerclient.Client, error), logger *slog.Logger) error {
	targets, order, err := ParseDockerHosts(resolved.DockerHosts)
	if err != nil {
		return fmt.Errorf("parsing fleet docker hosts: %w", err)
	}
	if len(order) == 0 {
		return fmt.Errorf("no docker hosts configured to launch a direct-mode runner")
	}
	runnerImage, err := directRunnerImageFor(resolved, l.pipeline)
	if err != nil {
		return err
	}
	writerKeyHostPath, err := directRunnerTelemetryWriterHostPath()
	if err != nil {
		return err
	}
	claudeTokenHostPath, err := directRunnerClaudeTokenHostPath()
	if err != nil {
		return err
	}
	maxConcurrent := directRunnerMaxConcurrent()

	start := directRunnerHostCursor.Add(1) - 1
	var lastErr error
	for i := range order {
		host := order[(start+uint64(i))%uint64(len(order))]
		if err := launchDirectRunnerOnHost(ctx, newClient, host, targets[host], runnerImage, writerKeyHostPath, claudeTokenHostPath, maxConcurrent, l, logger); err != nil {
			lastErr = err
			continue
		}
		return nil
	}
	if lastErr == nil {
		lastErr = fmt.Errorf("no configured docker host")
	}
	return fmt.Errorf("launching direct-mode runner for run %q: %w", l.runID, lastErr)
}

// directRunnerImageFor picks the runner image to launch: the runner-image
// Dockerfile bakes RUNNER_MODE=direct support into the SAME image every
// GitHub scale set already runs (entrypoint.sh branches on RUNNER_MODE
// before any GitHub-registration preflight), so any configured scale set's
// image is usable. Prefer a scale set whose labels name this pipeline (the
// same convention GitHub-mode dispatch already uses to route a job to a
// scale set); fall back to the first configured scale set otherwise.
func directRunnerImageFor(resolved resolvedOrchestratorConfig, pipeline string) (string, error) {
	pipeline = strings.ToLower(strings.TrimSpace(pipeline))
	for _, c := range resolved.ScaleSets {
		for _, label := range c.Labels {
			if strings.ToLower(label) == pipeline {
				return c.RunnerImage, nil
			}
		}
	}
	if len(resolved.ScaleSets) > 0 {
		return resolved.ScaleSets[0].RunnerImage, nil
	}
	return "", fmt.Errorf("no configured scale set to source a direct-runner image for pipeline %q", pipeline)
}

// directRunnerMaxConcurrent bounds how many direct-mode containers
// launchDirectRunner will let run concurrently on any one host.
// LCARS_QUEUE_MAX_CONCURRENT is not part of the design spec's own
// "Autoscaler change" section -- no existing capacity accounting in
// scaler.go covers direct-mode containers, since they are deliberately
// outside Scaler.HandleDesiredRunnerCount's state machine -- so a simple,
// independently-configured cap (default 1) stands in for it.
func directRunnerMaxConcurrent() int {
	raw := strings.TrimSpace(os.Getenv("LCARS_QUEUE_MAX_CONCURRENT"))
	if raw == "" {
		return 1
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < 1 {
		return 1
	}
	return n
}

// directRunnerTelemetryWriterHostPath returns the Docker-host-side path of
// the telemetry-writer key to bind-mount into a direct-mode container at
// directRunnerTelemetryWriterMountPath. This is deliberately NOT derived
// from GOOGLE_APPLICATION_CREDENTIALS (the autoscaler process's own,
// possibly-in-container credential path -- not necessarily a path that
// exists on the, possibly remote/SSH, Docker host whose daemon actually
// performs the bind mount): it is homelab deployment knowledge this repo
// cannot infer, so it is required, explicit, and fails loudly rather than
// guessing a path that could silently mount the wrong file or nothing.
func directRunnerTelemetryWriterHostPath() (string, error) {
	path := strings.TrimSpace(os.Getenv("LCARS_QUEUE_TELEMETRY_WRITER_HOST_PATH"))
	if path == "" {
		return "", fmt.Errorf("LCARS_QUEUE_TELEMETRY_WRITER_HOST_PATH is required to launch a direct-mode runner (Docker-host path of the telemetry-writer key, bind-mounted read-only to %s)", directRunnerTelemetryWriterMountPath)
	}
	return path, nil
}

// directRunnerClaudeTokenHostPath returns the Docker-host-side path of a
// plain-text file holding the current CLAUDE_CODE_OAUTH_TOKEN value, to
// bind-mount into a direct-mode container at directRunnerClaudeTokenMountPath
// (see that constant's comment for why this is a file mount and not a
// Config.Env entry). Same shape and same reasoning as
// directRunnerTelemetryWriterHostPath immediately above: this is homelab
// deployment knowledge -- where the operator staged the secret on the
// specific Docker host that will perform the bind mount -- this repo cannot
// infer, so it is required, explicit, and fails loudly rather than guessing
// a path that could silently mount the wrong file or nothing. Every
// pipeline the queue executor launches today is `claude` (README's own
// "codex/opencode are not covered" caveat), so this is unconditionally
// required whenever a direct-mode runner launches at all, exactly like the
// telemetry-writer path above.
func directRunnerClaudeTokenHostPath() (string, error) {
	path := strings.TrimSpace(os.Getenv("LCARS_QUEUE_CLAUDE_TOKEN_HOST_PATH"))
	if path == "" {
		return "", fmt.Errorf("LCARS_QUEUE_CLAUDE_TOKEN_HOST_PATH is required to launch a direct-mode runner (Docker-host path of a file holding the current CLAUDE_CODE_OAUTH_TOKEN value, bind-mounted read-only to %s)", directRunnerClaudeTokenMountPath)
	}
	return path, nil
}

// launchDirectRunnerOnHost attempts one host: connects, checks the
// concurrency cap via a label-filtered ContainerList (the same
// count-matching-labelled-containers pattern Scaler.checkHostRunnerLimit
// uses for GitHub-mode runners), and on capacity, creates and starts the
// container. Returns an error (never fatal to the caller's round-robin) if
// this host is unreachable, full, or the create/start call fails.
func launchDirectRunnerOnHost(ctx context.Context, newClient func(target string) (*dockerclient.Client, error), host, target, runnerImage, writerKeyHostPath, claudeTokenHostPath string, maxConcurrent int, l directRunnerLaunch, logger *slog.Logger) error {
	client, err := newClient(target)
	if err != nil {
		return fmt.Errorf("host %q: connecting: %w", host, err)
	}
	defer client.Close()

	listCtx, cancelList := context.WithTimeout(ctx, dockerInspectTimeout)
	running, err := client.ContainerList(listCtx, container.ListOptions{
		Filters: filters.NewArgs(filters.Arg("label", directRunnerLabelKey)),
	})
	cancelList()
	if err != nil {
		return fmt.Errorf("host %q: listing direct-runner containers: %w", host, err)
	}
	if len(running) >= maxConcurrent {
		return fmt.Errorf("host %q: at direct-runner capacity (%d/%d)", host, len(running), maxConcurrent)
	}

	name := fmt.Sprintf("direct-runner-%s-%s", dockerSafeNamePart(l.pipeline), uuid.NewString()[:8])
	env := []string{
		"RUNNER_MODE=direct",
		"LCARS_RUN_ID=" + l.runID,
		"LCARS_RUN_TOKEN=" + l.runToken,
	}
	if l.consoleURL != "" {
		env = append(env, "LCARS_CONSOLE_URL="+l.consoleURL)
	}
	hostConfig := &container.HostConfig{
		// The claude-token bind is deliberately the only path that puts
		// CLAUDE_CODE_OAUTH_TOKEN anywhere near this container: it never
		// appears in the env list below, only as a file direct-runner.sh
		// reads and exports into its own process just before invoking
		// `claude` (see directRunnerClaudeTokenMountPath's comment).
		Binds: []string{
			writerKeyHostPath + ":" + directRunnerTelemetryWriterMountPath + ":ro",
			claudeTokenHostPath + ":" + directRunnerClaudeTokenMountPath + ":ro",
		},
		// Deliberately NOT AutoRemove (final-review fix): AutoRemove reaps
		// the container -- logs included -- the instant it exits, which
		// would erase a non-zero-exit direct-runner's own stdout/stderr
		// before anything here ever reads it. Capturing that output
		// properly needs a live ContainerLogs follow stream started before
		// exit plus a ContainerWait/manual-remove goroutine, which is well
		// past a small change; see the README's "Queue executor" section
		// ("Exited direct-runner containers are not swept") for the
		// resulting gap this leaves -- exited containers now accumulate on
		// the host until something removes them, and nothing in this repo
		// does that yet.
		AutoRemove: false,
	}

	createCtx, cancelCreate := context.WithTimeout(ctx, dockerContainerOperationTimeout)
	created, err := client.ContainerCreate(createCtx, &container.Config{
		Image: runnerImage,
		User:  "runner",
		Env:   env,
		Labels: map[string]string{
			directRunnerLabelKey:      "1",
			directRunnerRunIDLabelKey: l.runID,
		},
	}, hostConfig, nil, nil, name)
	cancelCreate()
	if err != nil {
		return fmt.Errorf("host %q: creating direct-runner container: %w", host, err)
	}

	startCtx, cancelStart := context.WithTimeout(ctx, dockerContainerOperationTimeout)
	err = client.ContainerStart(startCtx, created.ID, container.StartOptions{})
	cancelStart()
	if err != nil {
		// Mirrors Scaler.startRunner's own cleanup-on-start-failure: the
		// container was created but never ran, so remove it with a detached
		// context rather than leaving a stopped ghost behind.
		removeCtx, cancelRemove := context.WithTimeout(context.WithoutCancel(ctx), dockerContainerOperationTimeout)
		_ = client.ContainerRemove(removeCtx, created.ID, container.RemoveOptions{Force: true})
		cancelRemove()
		return fmt.Errorf("host %q: starting direct-runner container: %w", host, err)
	}
	// Never logs l.runToken -- only the run id and the host it landed on,
	// mirroring Scaler.startRunner's own "Placed runner" log line.
	logger.Info("Placed direct runner", slog.String("runId", l.runID), slog.String("host", host))
	return nil
}

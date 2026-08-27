package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
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
	pipelines  []string
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
	launch func(directRunnerLaunch) error
}

type claimResponse struct {
	RunID     string `json:"runId"`
	WorkID    string `json:"workId"`
	Pipeline  string `json:"pipeline"`
	Token     string `json:"token"`
	ExpiresAt string `json:"expiresAt"`
}

// pollOnce claims at most one run and, on success, launches it. A 204 (no
// queued run for these pipelines) is not an error -- the caller's loop
// simply tries again on the next tick.
func pollOnce(cfg queueExecutorConfig) error {
	client := cfg.httpClient
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}
	token, err := cfg.idToken()
	if err != nil {
		return fmt.Errorf("minting claim id token: %w", err)
	}
	body, err := json.Marshal(map[string]any{
		"runner":    cfg.runnerName,
		"pipelines": cfg.pipelines,
	})
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
	var claimed claimResponse
	if err := json.NewDecoder(resp.Body).Decode(&claimed); err != nil {
		return fmt.Errorf("decoding claim response: %w", err)
	}
	return cfg.launch(directRunnerLaunch{
		runID:      claimed.RunID,
		runToken:   claimed.Token,
		pipeline:   claimed.Pipeline,
		consoleURL: cfg.consoleURL,
	})
}

// idTokenFromTelemetryWriterKey mints a Google ID token for `audience`
// directly from the same telemetry-writer service-account key
// console_status.go already reads via GOOGLE_APPLICATION_CREDENTIALS --
// no metadata server (this fleet does not run on GCE/Cloud Run -- see the
// design spec), no new IAM grant: a service-account key can self-mint an
// ID token for any audience from its own private key alone.
func idTokenFromTelemetryWriterKey(ctx context.Context, keyPath, audience string) (string, error) {
	source, err := idtoken.NewTokenSource(ctx, audience, idtoken.WithCredentialsFile(keyPath))
	if err != nil {
		return "", fmt.Errorf("building id token source: %w", err)
	}
	tok, err := source.Token()
	if err != nil {
		return "", fmt.Errorf("minting id token: %w", err)
	}
	return tok.AccessToken, nil
}

// runQueueExecutorPoller ticks pollOnce on cfg's interval until ctx is
// done. A single failed claim is logged and never fatal -- the same
// level-triggered, keep-trying-next-tick discipline HandleDesiredRunnerCount
// already uses for a failed scale-up.
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
// in production (see runOrchestrator's LCARS_QUEUE_POLL block); pollOnce's
// own tests inject a stub launch instead, so this function's coverage is the
// docker-facing tests in queue_executor_test.go that exercise
// launchDirectRunnerOnHost (and this function's round-robin) directly
// against fakeDockerServer, via an injected client factory the same way
// newDockerClient itself is the injected default here.
func launchDirectRunner(ctx context.Context, resolved resolvedOrchestratorConfig, l directRunnerLaunch) error {
	return launchDirectRunnerWithClient(ctx, resolved, l, newDockerClient)
}

func launchDirectRunnerWithClient(ctx context.Context, resolved resolvedOrchestratorConfig, l directRunnerLaunch, newClient func(target string) (*dockerclient.Client, error)) error {
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
	maxConcurrent := directRunnerMaxConcurrent()

	start := directRunnerHostCursor.Add(1) - 1
	var lastErr error
	for i := range order {
		host := order[(start+uint64(i))%uint64(len(order))]
		if err := launchDirectRunnerOnHost(ctx, newClient, host, targets[host], runnerImage, writerKeyHostPath, maxConcurrent, l); err != nil {
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

// launchDirectRunnerOnHost attempts one host: connects, checks the
// concurrency cap via a label-filtered ContainerList (the same
// count-matching-labelled-containers pattern Scaler.checkHostRunnerLimit
// uses for GitHub-mode runners), and on capacity, creates and starts the
// container. Returns an error (never fatal to the caller's round-robin) if
// this host is unreachable, full, or the create/start call fails.
func launchDirectRunnerOnHost(ctx context.Context, newClient func(target string) (*dockerclient.Client, error), host, target, runnerImage, writerKeyHostPath string, maxConcurrent int, l directRunnerLaunch) error {
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
		Binds: []string{writerKeyHostPath + ":" + directRunnerTelemetryWriterMountPath + ":ro"},
		// Direct-mode containers are one-shot and untracked by any Scaler --
		// there is no orphan sweeper for them the way cleanupOrphans covers
		// GitHub-mode runners. AutoRemove keeps a host from silently
		// accumulating exited containers between polls.
		AutoRemove: true,
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
	return nil
}

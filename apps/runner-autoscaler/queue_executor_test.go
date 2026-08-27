package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/docker/docker/api/types/container"
	dockerclient "github.com/docker/docker/client"
)

// discardLogger matches this package's own test convention
// (slog.New(slog.NewTextHandler(io.Discard, nil)), see checkpoint_test.go)
// for a logger tests don't care to inspect.
func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func TestPollOnceClaimsAndLaunches(t *testing.T) {
	var gotBody map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/work/v1/runs/claim" {
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"runId":     "work:01QUEUEEXECUTORTESTFIX01/r1",
			"workId":    "01QUEUEEXECUTORTESTFIX01",
			"pipeline":  "claude",
			"token":     "test-token",
			"expiresAt": "2026-08-27T01:00:00.000Z",
		})
	}))
	defer server.Close()

	var launched []directRunnerLaunch
	cfg := queueExecutorConfig{
		consoleURL: server.URL,
		pipelines:  []string{"claude"},
		runnerName: "test-runner",
		idToken:    func() (string, error) { return "fake-id-token", nil },
		launch: func(l directRunnerLaunch) error {
			launched = append(launched, l)
			return nil
		},
	}
	if err := pollOnce(cfg); err != nil {
		t.Fatalf("pollOnce: %v", err)
	}
	if len(launched) != 1 {
		t.Fatalf("expected one launch, got %d", len(launched))
	}
	if launched[0].runID != "work:01QUEUEEXECUTORTESTFIX01/r1" || launched[0].runToken != "test-token" {
		t.Fatalf("unexpected launch: %+v", launched[0])
	}
	if launched[0].pipeline != "claude" {
		t.Fatalf("expected pipeline %q, got %+v", "claude", launched[0])
	}
	if launched[0].consoleURL != server.URL {
		t.Fatalf("expected consoleURL %q to be threaded through to the launch, got %+v", server.URL, launched[0])
	}
	if gotBody["runner"] != "test-runner" {
		t.Fatalf("expected runner in claim body, got %v", gotBody)
	}
}

// TestPollOnceNoQueuedRunLaunchesNothing covers both shapes the console
// answers "nothing queued for these pipelines" with: a 200 with an empty
// body (what it actually sends today) and a bare 204 (still tolerated, in
// case that ever changes back).
func TestPollOnceNoQueuedRunLaunchesNothing(t *testing.T) {
	cases := []struct {
		name   string
		status int
	}{
		{"200 with an empty body", http.StatusOK},
		{"204", http.StatusNoContent},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(tc.status)
			}))
			defer server.Close()

			launchCount := 0
			cfg := queueExecutorConfig{
				consoleURL: server.URL,
				pipelines:  []string{"claude"},
				runnerName: "test-runner",
				idToken:    func() (string, error) { return "fake-id-token", nil },
				launch:     func(directRunnerLaunch) error { launchCount++; return nil },
			}
			if err := pollOnce(cfg); err != nil {
				t.Fatalf("pollOnce: %v", err)
			}
			if launchCount != 0 {
				t.Fatalf("expected no launch, got %d", launchCount)
			}
		})
	}
}

// TestPollOnceMissingRequiredFieldsLaunchesNothing proves a 200 that
// decodes fine but is missing runId/token (e.g. a stray `{}`, or a future
// console bug) is treated the same as "nothing queued" -- pollOnce must
// never hand launch() a directRunnerLaunch with an empty run id or token.
func TestPollOnceMissingRequiredFieldsLaunchesNothing(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{}`))
	}))
	defer server.Close()

	launchCount := 0
	cfg := queueExecutorConfig{
		consoleURL: server.URL,
		pipelines:  []string{"claude"},
		runnerName: "test-runner",
		idToken:    func() (string, error) { return "fake-id-token", nil },
		launch:     func(directRunnerLaunch) error { launchCount++; return nil },
	}
	if err := pollOnce(cfg); err != nil {
		t.Fatalf("pollOnce: %v", err)
	}
	if launchCount != 0 {
		t.Fatalf("expected no launch for a claim response missing runId/token, got %d", launchCount)
	}
}

// TestPollOnceDrainingSkipsClaim proves pollOnce short-circuits before ever
// making the claim HTTP call while cfg.draining reports true -- the
// SIGUSR1-drain gate (Task's final-review fix). A nil draining (every
// other test in this file) must keep behaving exactly as before; see those
// tests for that coverage.
func TestPollOnceDrainingSkipsClaim(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	launchCount := 0
	cfg := queueExecutorConfig{
		consoleURL: server.URL,
		pipelines:  []string{"claude"},
		runnerName: "test-runner",
		idToken:    func() (string, error) { return "fake-id-token", nil },
		launch:     func(directRunnerLaunch) error { launchCount++; return nil },
		draining:   func() bool { return true },
	}
	if err := pollOnce(cfg); err != nil {
		t.Fatalf("pollOnce: %v", err)
	}
	if calls != 0 {
		t.Fatalf("expected pollOnce to skip the claim request entirely while draining, got %d calls", calls)
	}
	if launchCount != 0 {
		t.Fatalf("expected no launch while draining, got %d", launchCount)
	}
}

// TestPollOnceUnauthorizedIsError covers a claim call the console rejects
// (e.g. an expired or malformed ID token): pollOnce must report the failure
// rather than silently treating it as "nothing queued", and must never
// launch anything on the strength of a rejected claim.
func TestPollOnceUnauthorizedIsError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer server.Close()

	launchCount := 0
	cfg := queueExecutorConfig{
		consoleURL: server.URL,
		pipelines:  []string{"claude"},
		runnerName: "test-runner",
		idToken:    func() (string, error) { return "fake-id-token", nil },
		launch:     func(directRunnerLaunch) error { launchCount++; return nil },
	}
	err := pollOnce(cfg)
	if err == nil {
		t.Fatalf("expected an error for a 401 claim response")
	}
	if !strings.Contains(err.Error(), "401") {
		t.Errorf("expected the error to mention the 401 status, got %q", err.Error())
	}
	if launchCount != 0 {
		t.Fatalf("expected no launch on 401, got %d", launchCount)
	}
}

// TestPollOnceClaimRequestBodyShape pins the claim request body's shape
// (runner + pipelines only) and guards against it ever accidentally
// growing a token field -- there is none to leak yet at claim time, but a
// careless future edit threading a stale token through would be exactly
// the kind of leak the "never log the run token" rule exists to prevent.
func TestPollOnceClaimRequestBodyShape(t *testing.T) {
	var gotBody map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	cfg := queueExecutorConfig{
		consoleURL: server.URL,
		pipelines:  []string{"claude", "codex"},
		runnerName: "runner-a",
		idToken:    func() (string, error) { return "fake-id-token", nil },
		launch:     func(directRunnerLaunch) error { return nil },
	}
	if err := pollOnce(cfg); err != nil {
		t.Fatalf("pollOnce: %v", err)
	}
	if gotBody["runner"] != "runner-a" {
		t.Fatalf("expected runner %q, got %v", "runner-a", gotBody)
	}
	pipelines, ok := gotBody["pipelines"].([]any)
	if !ok || len(pipelines) != 2 || pipelines[0] != "claude" || pipelines[1] != "codex" {
		t.Fatalf("expected pipelines [claude codex], got %v", gotBody["pipelines"])
	}
	if _, leaked := gotBody["token"]; leaked {
		t.Fatalf("claim request body must never carry a run token, got %v", gotBody)
	}
}

// TestPollOnceClaimResponseTooLargeIsError proves pollOnce bounds how much
// of a claim response it will decode (claimResponseBodyLimit): a response
// whose JSON object cannot close within that bound must error out rather
// than launch on a partially-decoded value. The oversized field lives
// INSIDE the JSON object (not as harmless trailing padding after a
// complete, valid object) so truncating at the limit actually breaks
// decoding -- json.Decoder.Decode stops after one complete value and
// ignores anything after it, so padding appended past a complete object
// would prove nothing here.
func TestPollOnceClaimResponseTooLargeIsError(t *testing.T) {
	hugeWorkID := strings.Repeat("x", claimResponseBodyLimit+1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"runId":     "work:01QUEUEEXECUTORTESTFIX05/r1",
			"workId":    hugeWorkID,
			"pipeline":  "claude",
			"token":     "test-token",
			"expiresAt": "2026-08-27T01:00:00.000Z",
		})
	}))
	defer server.Close()

	launchCount := 0
	cfg := queueExecutorConfig{
		consoleURL: server.URL,
		pipelines:  []string{"claude"},
		runnerName: "test-runner",
		idToken:    func() (string, error) { return "fake-id-token", nil },
		launch:     func(directRunnerLaunch) error { launchCount++; return nil },
	}
	err := pollOnce(cfg)
	if err == nil {
		t.Fatalf("expected an error for a claim response over claimResponseBodyLimit")
	}
	if launchCount != 0 {
		t.Fatalf("expected no launch for an oversized claim response, got %d", launchCount)
	}
}

func TestDirectRunnerImageFor(t *testing.T) {
	resolved := resolvedOrchestratorConfig{
		ScaleSets: []Config{
			{ScaleSetName: "claude-actions", Labels: []string{"claude"}, RunnerImage: "registry/claude-image:latest"},
			{ScaleSetName: "codex-actions", Labels: []string{"codex"}, RunnerImage: "registry/codex-image:latest"},
		},
	}

	t.Run("matches a scale set labelled for the pipeline", func(t *testing.T) {
		image, err := directRunnerImageFor(resolved, "claude")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if image != "registry/claude-image:latest" {
			t.Errorf("expected the claude-labelled scale set's image, got %q", image)
		}
	})

	t.Run("matches case-insensitively", func(t *testing.T) {
		image, err := directRunnerImageFor(resolved, "CODEX")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if image != "registry/codex-image:latest" {
			t.Errorf("expected the codex-labelled scale set's image, got %q", image)
		}
	})

	t.Run("falls back to the first scale set when no label matches", func(t *testing.T) {
		image, err := directRunnerImageFor(resolved, "opencode")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if image != "registry/claude-image:latest" {
			t.Errorf("expected the fallback (first) scale set's image, got %q", image)
		}
	})

	t.Run("errors when no scale set is configured at all", func(t *testing.T) {
		_, err := directRunnerImageFor(resolvedOrchestratorConfig{}, "claude")
		if err == nil {
			t.Fatalf("expected an error with no configured scale sets")
		}
	})
}

func TestDirectRunnerMaxConcurrent(t *testing.T) {
	cases := []struct {
		name string
		env  string
		want int
	}{
		{"unset defaults to 1", "", 1},
		{"valid override", "3", 3},
		{"zero falls back to 1", "0", 1},
		{"negative falls back to 1", "-1", 1},
		{"non-numeric falls back to 1", "many", 1},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("LCARS_QUEUE_MAX_CONCURRENT", tc.env)
			if got := directRunnerMaxConcurrent(); got != tc.want {
				t.Errorf("directRunnerMaxConcurrent() = %d, want %d", got, tc.want)
			}
		})
	}
}

// TestParseQueuePipelines pins LCARS_QUEUE_PIPELINES's parsing: trimmed,
// empties dropped, so an unset/blank value never becomes a literal ""
// pipeline name in the claim request body (see pollOnce's own body-shape
// test) and stray whitespace/a trailing comma never turns a real pipeline
// name into a different one.
func TestParseQueuePipelines(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want []string
	}{
		{"empty", "", nil},
		{"whitespace only", "   ", nil},
		{"single", "claude", []string{"claude"}},
		{"multiple", "claude,codex", []string{"claude", "codex"}},
		{"whitespace around entries", " claude , codex ", []string{"claude", "codex"}},
		{"trailing comma dropped", "claude,codex,", []string{"claude", "codex"}},
		{"blank entries between commas dropped", "claude,,codex", []string{"claude", "codex"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := parseQueuePipelines(tc.raw)
			if len(got) != len(tc.want) {
				t.Fatalf("parseQueuePipelines(%q) = %v, want %v", tc.raw, got, tc.want)
			}
			for i := range got {
				if got[i] != tc.want[i] {
					t.Fatalf("parseQueuePipelines(%q) = %v, want %v", tc.raw, got, tc.want)
				}
			}
		})
	}
}

// TestQueueExecutorStartupDecision pins the misconfiguration Task 5's own
// final-review fix guards against: LCARS_QUEUE_POLL=1 with nothing usable
// in LCARS_QUEUE_PIPELINES must refuse to start the poller and say why,
// rather than starting a poller that can never claim anything.
func TestQueueExecutorStartupDecision(t *testing.T) {
	cases := []struct {
		name          string
		pollRaw       string
		pipelinesRaw  string
		wantPipelines []string
		wantStart     bool
		wantReason    bool
	}{
		{"poll unset", "", "claude", nil, false, false},
		{"poll not 1", "0", "claude", nil, false, false},
		{"poll 1, no pipelines configured", "1", "", nil, false, true},
		{"poll 1, only blank pipeline entries", "1", " , ,", nil, false, true},
		{"poll 1, pipelines configured", "1", "claude,codex", []string{"claude", "codex"}, true, false},
		{"poll 1 case-insensitive/whitespace", " 1 ", "claude", []string{"claude"}, true, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			pipelines, start, reason := queueExecutorStartupDecision(tc.pollRaw, tc.pipelinesRaw)
			if start != tc.wantStart {
				t.Errorf("start = %v, want %v", start, tc.wantStart)
			}
			if (reason != "") != tc.wantReason {
				t.Errorf("reason = %q, want non-empty: %v", reason, tc.wantReason)
			}
			if len(pipelines) != len(tc.wantPipelines) {
				t.Fatalf("pipelines = %v, want %v", pipelines, tc.wantPipelines)
			}
			for i := range pipelines {
				if pipelines[i] != tc.wantPipelines[i] {
					t.Fatalf("pipelines = %v, want %v", pipelines, tc.wantPipelines)
				}
			}
		})
	}
}

// TestQueueExecutorAudience pins LCARS_WORK_AUDIENCE's default, matching
// the console's own AGENT_LCARS_WORK_AUDIENCE fallback (route.ts).
func TestQueueExecutorAudience(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want string
	}{
		{"unset defaults to agent-lcars-work", "", "agent-lcars-work"},
		{"whitespace only defaults to agent-lcars-work", "   ", "agent-lcars-work"},
		{"configured value passes through", "custom-audience", "custom-audience"},
		{"configured value is trimmed", "  custom-audience  ", "custom-audience"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := queueExecutorAudience(tc.raw); got != tc.want {
				t.Errorf("queueExecutorAudience(%q) = %q, want %q", tc.raw, got, tc.want)
			}
		})
	}
}

// TestQueueExecutorRunnerName pins the os.Hostname failure fallback: a
// hostname lookup that errors (or somehow returns "") must not crash or
// disable the queue executor, just fall back to a fixed name.
func TestQueueExecutorRunnerName(t *testing.T) {
	cases := []struct {
		name     string
		hostname string
		err      error
		want     string
	}{
		{"hostname resolved", "runner-1", nil, "runner-1"},
		{"hostname lookup errored", "", errors.New("boom"), "autoscaler"},
		{"empty hostname with no error", "", nil, "autoscaler"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := queueExecutorRunnerName(tc.hostname, tc.err); got != tc.want {
				t.Errorf("queueExecutorRunnerName(%q, %v) = %q, want %q", tc.hostname, tc.err, got, tc.want)
			}
		})
	}
}

func TestDirectRunnerTelemetryWriterHostPath(t *testing.T) {
	t.Run("required", func(t *testing.T) {
		t.Setenv("LCARS_QUEUE_TELEMETRY_WRITER_HOST_PATH", "")
		if _, err := directRunnerTelemetryWriterHostPath(); err == nil {
			t.Fatalf("expected an error when the host path env var is unset")
		}
	})
	t.Run("passes through a configured path", func(t *testing.T) {
		t.Setenv("LCARS_QUEUE_TELEMETRY_WRITER_HOST_PATH", "/secrets/telemetry-writer.json")
		got, err := directRunnerTelemetryWriterHostPath()
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got != "/secrets/telemetry-writer.json" {
			t.Errorf("got %q", got)
		}
	})
}

// TestNewDirectRunnerIDTokenSourceErrors pins the plumbing runOrchestrator
// relies on to disable the queue poller (rather than start it and fail
// every poll) when the credentials file is missing or unreadable: a bad
// keyPath must surface as an error from the builder itself, not lazily on
// first .Token() call.
func TestNewDirectRunnerIDTokenSourceErrors(t *testing.T) {
	_, err := newDirectRunnerIDTokenSource(context.Background(), "/nonexistent/telemetry-writer.json", "agent-lcars-work")
	if err == nil {
		t.Fatalf("expected an error building an id token source from a nonexistent key file")
	}
}

// TestLaunchDirectRunnerOnHostLogsPlacementWithoutToken proves a successful
// launch logs the run id and host (so an operator can find "which run
// landed where" without grepping Docker), and proves the run token -- a
// live credential -- never appears in that log line.
func TestLaunchDirectRunnerOnHostLogsPlacementWithoutToken(t *testing.T) {
	f := newFakeDockerServer(t)
	newClient := func(target string) (*dockerclient.Client, error) { return f.client(t), nil }

	var logBuf bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&logBuf, nil))

	l := directRunnerLaunch{
		runID:    "work:01QUEUEEXECUTORTESTFIX06/r1",
		runToken: "super-secret-run-token",
		pipeline: "claude",
	}
	err := launchDirectRunnerOnHost(context.Background(), newClient, "host-a", "unused-target", "registry/claude-image:latest", "/secrets/telemetry-writer.json", 1, l, logger)
	if err != nil {
		t.Fatalf("launchDirectRunnerOnHost: %v", err)
	}

	logged := logBuf.String()
	if !strings.Contains(logged, "Placed direct runner") {
		t.Errorf("expected a placement log line, got %q", logged)
	}
	if !strings.Contains(logged, l.runID) {
		t.Errorf("expected the log line to name the run id, got %q", logged)
	}
	if !strings.Contains(logged, "host-a") {
		t.Errorf("expected the log line to name the host, got %q", logged)
	}
	if strings.Contains(logged, l.runToken) {
		t.Fatalf("run token must never be logged, got %q", logged)
	}
}

// TestLaunchDirectRunnerOnHostCreatesAndStartsWithEnv is the "fake launcher
// interface asserting the docker-run env" case: it exercises
// launchDirectRunnerOnHost against fakeDockerServer end to end and checks
// exactly what a real docker daemon would have received -- image, the
// RUNNER_MODE=direct/LCARS_RUN_ID/LCARS_RUN_TOKEN/LCARS_CONSOLE_URL env,
// the telemetry-writer bind mount, and that ContainerStart was called.
func TestLaunchDirectRunnerOnHostCreatesAndStartsWithEnv(t *testing.T) {
	f := newFakeDockerServer(t)
	newClient := func(target string) (*dockerclient.Client, error) { return f.client(t), nil }

	l := directRunnerLaunch{
		runID:      "work:01QUEUEEXECUTORTESTFIX01/r1",
		runToken:   "super-secret-run-token",
		pipeline:   "claude",
		consoleURL: "https://lcars.test",
	}
	err := launchDirectRunnerOnHost(context.Background(), newClient, "host-a", "unused-target", "registry/claude-image:latest", "/secrets/telemetry-writer.json", 1, l, discardLogger())
	if err != nil {
		t.Fatalf("launchDirectRunnerOnHost: %v", err)
	}
	if f.createCount() != 1 {
		t.Fatalf("expected exactly one ContainerCreate, got %d", f.createCount())
	}
	if f.startCount() != 1 {
		t.Fatalf("expected exactly one ContainerStart, got %d", f.startCount())
	}

	created := f.getLastCreate()
	if created.Image != "registry/claude-image:latest" {
		t.Errorf("expected image %q, got %q", "registry/claude-image:latest", created.Image)
	}
	if created.User != "runner" {
		t.Errorf("expected user %q, got %q", "runner", created.User)
	}
	wantEnv := map[string]bool{
		"RUNNER_MODE=direct":                            true,
		"LCARS_RUN_ID=work:01QUEUEEXECUTORTESTFIX01/r1": true,
		"LCARS_RUN_TOKEN=super-secret-run-token":        true,
		"LCARS_CONSOLE_URL=https://lcars.test":          true,
	}
	if len(created.Env) != len(wantEnv) {
		t.Fatalf("expected %d env entries, got %v", len(wantEnv), created.Env)
	}
	for _, e := range created.Env {
		if !wantEnv[e] {
			t.Errorf("unexpected env entry %q", e)
		}
	}
	if created.Labels[directRunnerRunIDLabelKey] != l.runID {
		t.Errorf("expected run-id label %q, got %q", l.runID, created.Labels[directRunnerRunIDLabelKey])
	}
	wantBind := "/secrets/telemetry-writer.json:" + directRunnerTelemetryWriterMountPath + ":ro"
	if len(created.HostConfig.Binds) != 1 || created.HostConfig.Binds[0] != wantBind {
		t.Errorf("expected bind %q, got %v", wantBind, created.HostConfig.Binds)
	}
}

// TestLaunchDirectRunnerOnHostAtCapacity proves the concurrency cap refuses
// to create a container at all once a host already has maxConcurrent
// direct-runner containers running -- the queue-executor equivalent of
// Scaler.checkHostRunnerLimit.
func TestLaunchDirectRunnerOnHostAtCapacity(t *testing.T) {
	f := newFakeDockerServer(t)
	newClient := func(target string) (*dockerclient.Client, error) { return f.client(t), nil }

	// Simulate one already-running direct-runner container by making
	// ContainerList report one match for the label filter.
	f.mu.Lock()
	f.containers = append(f.containers, container.Summary{ID: "existing", Labels: map[string]string{directRunnerLabelKey: "1"}})
	f.mu.Unlock()

	l := directRunnerLaunch{runID: "work:01QUEUEEXECUTORTESTFIX02/r1", runToken: "t", pipeline: "claude"}
	err := launchDirectRunnerOnHost(context.Background(), newClient, "host-a", "unused-target", "registry/claude-image:latest", "/secrets/telemetry-writer.json", 1, l, discardLogger())
	if err == nil {
		t.Fatalf("expected an error when the host is already at its direct-runner cap")
	}
	if f.createCount() != 0 {
		t.Fatalf("expected no ContainerCreate when at capacity, got %d", f.createCount())
	}
}

// TestLaunchDirectRunnerRoundRobinsPastAFullHost exercises the whole
// launchDirectRunner round-robin: the first configured host is at capacity,
// so the container must land on the second.
func TestLaunchDirectRunnerRoundRobinsPastAFullHost(t *testing.T) {
	t.Setenv("LCARS_QUEUE_TELEMETRY_WRITER_HOST_PATH", "/secrets/telemetry-writer.json")

	full := newFakeDockerServer(t)
	full.mu.Lock()
	full.containers = append(full.containers, container.Summary{ID: "existing", Labels: map[string]string{directRunnerLabelKey: "1"}})
	full.mu.Unlock()

	spare := newFakeDockerServer(t)

	resolved := resolvedOrchestratorConfig{
		DockerHosts: []string{"full=fake-target-full", "spare=fake-target-spare"},
		ScaleSets:   []Config{{ScaleSetName: "claude-actions", Labels: []string{"claude"}, RunnerImage: "registry/claude-image:latest"}},
	}
	newClient := func(target string) (*dockerclient.Client, error) {
		switch target {
		case "fake-target-full":
			return full.client(t), nil
		case "fake-target-spare":
			return spare.client(t), nil
		default:
			t.Fatalf("unexpected docker target %q", target)
			return nil, nil
		}
	}
	l := directRunnerLaunch{runID: "work:01QUEUEEXECUTORTESTFIX03/r1", runToken: "t", pipeline: "claude"}

	if err := launchDirectRunnerWithClient(context.Background(), resolved, l, newClient, discardLogger()); err != nil {
		t.Fatalf("launchDirectRunnerWithClient: %v", err)
	}
	if full.createCount() != 0 {
		t.Errorf("expected the full host to receive no create, got %d", full.createCount())
	}
	if spare.createCount() != 1 {
		t.Errorf("expected the spare host to receive exactly one create, got %d", spare.createCount())
	}
}

// TestLaunchDirectRunnerOnHostRemovesContainerOnStartFailure mirrors
// Scaler.startRunner's own cleanup-on-start-failure: a container that was
// created but never started must not be left behind as a stopped ghost.
func TestLaunchDirectRunnerOnHostRemovesContainerOnStartFailure(t *testing.T) {
	f := newFakeDockerServer(t)
	f.setStartFailures(http.StatusInternalServerError)
	newClient := func(target string) (*dockerclient.Client, error) { return f.client(t), nil }

	l := directRunnerLaunch{runID: "work:01QUEUEEXECUTORTESTFIX04/r1", runToken: "t", pipeline: "claude"}
	err := launchDirectRunnerOnHost(context.Background(), newClient, "host-a", "unused-target", "registry/claude-image:latest", "/secrets/telemetry-writer.json", 1, l, discardLogger())
	if err == nil {
		t.Fatalf("expected an error when ContainerStart fails")
	}
	if f.createCount() != 1 {
		t.Fatalf("expected exactly one ContainerCreate, got %d", f.createCount())
	}
	removed := f.removedIDs()
	if len(removed) != 1 || removed[0] != "created-container" {
		t.Fatalf("expected the failed-to-start container to be removed, got %v", removed)
	}
}

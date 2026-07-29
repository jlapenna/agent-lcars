package main

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/actions/scaleset"
	"github.com/docker/docker/api/types/container"
	dockerclient "github.com/docker/docker/client"
)

// newStubScalesetClient builds a real *scaleset.Client wired against a local
// httptest server that 404s everything. The scaleset library derives its API
// base from GitHubConfigURL when that host isn't github.com (GHES-style
// config), so this never touches the network -- GetRunnerByName (called by
// deregisterRunner) fails cleanly against the stub with a wrapped error;
// there is no panic and nothing dials out.
func newStubScalesetClient(t *testing.T) *scaleset.Client {
	t.Helper()
	ghSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	t.Cleanup(ghSrv.Close)

	client, err := scaleset.NewClientWithPersonalAccessToken(scaleset.NewClientWithPersonalAccessTokenConfig{
		GitHubConfigURL:     ghSrv.URL + "/org/repo",
		PersonalAccessToken: "x",
		SystemInfo:          systemInfo(0),
	})
	if err != nil {
		t.Fatalf("failed to create stub scaleset client: %v", err)
	}
	return client
}

// TestDockerSafeNamePart covers the homelab#97 container-naming sanitizer:
// startRunner now embeds the (config-supplied) scale set name in the
// container --name, so it must never be able to produce a character Docker
// rejects there even though the same string is already validated as an
// arbitrary label-safe string elsewhere.
func TestDockerSafeNamePart(t *testing.T) {
	cases := map[string]string{
		"homelab-autoscale-claude-agent-lcars": "homelab-autoscale-claude-agent-lcars",
		"already.safe_name-123":                "already.safe_name-123",
		"has spaces":                           "has-spaces",
		"slash/and:colon":                      "slash-and-colon",
	}
	for in, want := range cases {
		if got := dockerSafeNamePart(in); got != want {
			t.Errorf("dockerSafeNamePart(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestPickHostReachability(t *testing.T) {
	// A fake daemon, NOT dockerclient.FromEnv. FromEnv defaults to
	// /var/run/docker.sock, and these tests then assert the client is
	// REACHABLE -- so they silently depended on the machine running them
	// having a live Docker daemon. That held while CI published from a
	// socket-mounted runner and broke the moment publishing moved to a
	// socketless lane (#101). The fake answers /_ping, which is all the
	// reachability probe needs.
	localClient := newFakeDockerServer(t).client(t)

	// Create a client that will fail to ping (unreachable TCP port)
	failingClient, err := dockerclient.NewClientWithOpts(
		dockerclient.WithHost("tcp://127.0.0.1:54321"),
		dockerclient.WithAPIVersionNegotiation(),
	)
	if err != nil {
		t.Fatalf("failed to create failing client: %v", err)
	}

	scaler := &Scaler{
		dockerHosts: []DockerHost{
			{Name: "failing-host", Client: failingClient},
			{Name: "local-host", Client: localClient},
		},
		logger: slog.New(slog.NewTextHandler(os.Stdout, nil)),
	}

	ctx := context.Background()
	picked, err := scaler.pickHost(ctx)
	if err != nil {
		t.Fatalf("pickHost returned error: %v", err)
	}

	// Since failing-host is unreachable, it should pick local-host
	if picked != "local-host" {
		t.Errorf("expected to pick local-host, got %s", picked)
	}
}

func TestRunnerStateUntracked(t *testing.T) {
	rs := runnerState{
		idle: make(map[string]runnerRef),
		busy: make(map[string]runnerRef),
	}

	// Verify marking untracked runner busy does not panic and returns false
	if rs.markBusy("non-existent-runner") {
		t.Errorf("expected markBusy for untracked runner to return false")
	}

	// Verify marking untracked runner done does not panic and returns false
	if _, ok := rs.markDone("non-existent-runner"); ok {
		t.Errorf("expected markDone for untracked runner to return false")
	}

	// Add a runner and test standard workflow
	rs.addIdle("runner-1", "host-a", "cid-1")
	if !rs.markBusy("runner-1") {
		t.Errorf("expected markBusy for idle runner-1 to return true")
	}
	ref, ok := rs.markDone("runner-1")
	if !ok || ref.host != "host-a" || ref.containerID != "cid-1" {
		t.Errorf("expected markDone for runner-1 to return ref host-a/cid-1, got %v, %v", ref, ok)
	}
}

func TestParseSweepOutput(t *testing.T) {
	cases := []struct {
		name       string
		out        string
		wantBefore int64
		wantAfter  int64
		wantOK     bool
	}{
		{"well formed", "SWEEP before=123 after=45\n", 123, 45, true},
		{"embedded in noise", "some du warning\nSWEEP before=10737418240 after=1073741824\n", 10737418240, 1073741824, true},
		{"zeroes", "SWEEP before=0 after=0\n", 0, 0, true},
		{"malformed", "no sweep line here\n", 0, 0, false},
		{"empty", "", 0, 0, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			before, after, ok := parseSweepOutput(c.out)
			if ok != c.wantOK || before != c.wantBefore || after != c.wantAfter {
				t.Errorf("parseSweepOutput(%q) = (%d, %d, %v), want (%d, %d, %v)", c.out, before, after, ok, c.wantBefore, c.wantAfter, c.wantOK)
			}
		})
	}
}

func TestSweepWorkDirsSkipsHostWithRunner(t *testing.T) {
	scaler := &Scaler{
		dockerHosts: []DockerHost{{Name: "janeway"}}, // nil client proves no helper is created
		runners: runnerState{
			idle: map[string]runnerRef{"runner-1": {host: "janeway", containerID: "cid-1"}},
			busy: make(map[string]runnerRef),
		},
		logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	scaler.SweepWorkDirs(context.Background())
}

func TestRunnerStateHasHostIncludesIdleAndBusy(t *testing.T) {
	runners := runnerState{
		idle: map[string]runnerRef{"idle": {host: "janeway"}},
		busy: map[string]runnerRef{"busy": {host: "spark"}},
	}
	if !runners.hasHost("janeway") || !runners.hasHost("spark") || runners.hasHost("laforge") {
		t.Fatal("hasHost did not account for idle and busy runners")
	}
}

func TestIsSparkLoaded(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("busy") == "true" {
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte("vllm:num_requests_running{model=\"default\"} 1.0\n"))
		} else {
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte("vllm:num_requests_running{model=\"default\"} 0.0\n"))
		}
	}))
	defer server.Close()

	scaler := &Scaler{
		sparkMetricsURL: server.URL + "?busy=true",
		logger:          slog.New(slog.NewTextHandler(os.Stdout, nil)),
	}

	if !scaler.isSparkLoaded(context.Background()) {
		t.Errorf("expected isSparkLoaded to return true when vllm:num_requests_running > 0")
	}

	scaler.sparkMetricsURL = server.URL + "?busy=false"
	if scaler.isSparkLoaded(context.Background()) {
		t.Errorf("expected isSparkLoaded to return false when vllm:num_requests_running == 0")
	}
}

// TestIsSparkLoadedLlamaSwapPowerDraw pins the llama-swap arm of the probe
// against a payload shaped like the real spark:8000 response, including the
// GB10 readings that are structurally zero on this hardware
// (gpu_util_percent / gpu_memory_*). A vLLM-only isSparkLoaded returns false
// for both cases below, which is exactly the regression this covers: the
// probe was inert in production while TestIsSparkLoaded stayed green against
// synthetic `vllm:` lines.
func TestIsSparkLoadedLlamaSwapPowerDraw(t *testing.T) {
	const idleWatts = "9.94"
	const busyWatts = "87.5"

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		watts := idleWatts
		if r.URL.Query().Get("busy") == "true" {
			watts = busyWatts
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(
			"llamaswap_gpu_util_percent{id=\"0\",name=\"NVIDIA GB10\"} 0\n" +
				"llamaswap_gpu_memory_used_bytes{id=\"0\",name=\"NVIDIA GB10\"} 0\n" +
				"llamaswap_gpu_memory_total_bytes{id=\"0\",name=\"NVIDIA GB10\"} 0\n" +
				"llamaswap_gpu_power_draw_watts{id=\"0\",name=\"NVIDIA GB10\"} " + watts + "\n",
		))
	}))
	defer server.Close()

	scaler := &Scaler{
		sparkMetricsURL: server.URL + "?busy=true",
		logger:          slog.New(slog.NewTextHandler(os.Stdout, nil)),
	}
	if !scaler.isSparkLoaded(context.Background()) {
		t.Errorf("expected isSparkLoaded to return true when GPU power draw (%sW) exceeds the %.0fW idle ceiling", busyWatts, sparkIdleGPUWatts)
	}

	scaler.sparkMetricsURL = server.URL + "?busy=false"
	if scaler.isSparkLoaded(context.Background()) {
		t.Errorf("expected isSparkLoaded to return false at the measured %sW idle floor", idleWatts)
	}
}

func TestIsSparkLoadedIgnoresResidentModelMemory(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("llamaswap_memory_free_bytes 1073741824\nllamaswap_swap_used_bytes 3221225472\n"))
	}))
	defer server.Close()

	scaler := &Scaler{sparkMetricsURL: server.URL, logger: slog.New(slog.NewTextHandler(os.Stdout, nil))}
	if scaler.isSparkLoaded(context.Background()) {
		t.Error("resident model memory and allocated swap must not penalize Spark without active pressure")
	}
}

func TestPickHostSparkLoadPenalty(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("vllm:num_requests_running{model=\"default\"} 2.0\n"))
	}))
	defer server.Close()

	// Fake daemon rather than dockerclient.FromEnv -- see
	// TestPickHostReachability for why FromEnv made these tests depend on
	// the host having a live Docker socket.
	localClient := newFakeDockerServer(t).client(t)

	scaler := &Scaler{
		sparkMetricsURL: server.URL,
		dockerHosts: []DockerHost{
			{Name: "spark", Client: localClient},
			{Name: "pike", Client: localClient},
		},
		runners: runnerState{
			idle: make(map[string]runnerRef),
			busy: make(map[string]runnerRef),
		},
		logger: slog.New(slog.NewTextHandler(os.Stdout, nil)),
	}

	// Even though spark has 0 runners and pike has 0 runners, spark is loaded so pike should be picked
	picked, err := scaler.pickHost(context.Background())
	if err != nil {
		t.Fatalf("pickHost returned error: %v", err)
	}
	if picked != "pike" {
		t.Errorf("expected pickHost to choose pike when spark has active inference load, got %s", picked)
	}
}

func TestScoreHostLoadPressureSignals(t *testing.T) {
	scaler := &Scaler{hostMemoryExempt: map[string]bool{"spark": true}}
	cases := []struct {
		name           string
		host           string
		load           hostLoad
		wantPenalty    int
		wantOverloaded bool
	}{
		{"cpu hard", "pike", hostLoad{memoryAvailable: 1, cpuUtilization: .97}, 100, true},
		{"cpu psi soft", "pike", hostLoad{memoryAvailable: 1, cpuPressure: .12}, 10, false},
		{"memory hard", "pike", hostLoad{memoryAvailable: .05}, 100, true},
		{"spark memory exempt", "spark", hostLoad{memoryAvailable: .01}, 0, false},
		{"active swap", "pike", hostLoad{memoryAvailable: 1, swapPagesPerSec: 20}, 10, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := scaler.scoreHostLoad(tc.host, tc.load)
			if got.penalty != tc.wantPenalty || got.overloaded != tc.wantOverloaded {
				t.Fatalf("score = (%d,%v), want (%d,%v)", got.penalty, got.overloaded, tc.wantPenalty, tc.wantOverloaded)
			}
		})
	}
}

func TestOverloadCooldown(t *testing.T) {
	now := time.Now()
	scaler := &Scaler{}
	loaded := scaler.applyOverloadCooldown("pike", hostLoad{normalizedLoad: 2, penalty: 100, overloaded: true}, now)
	if !loaded.overloaded || loaded.penalty != 100 {
		t.Fatalf("initial overloaded sample = %#v", loaded)
	}
	recoveredTooSoon := scaler.applyOverloadCooldown("pike", hostLoad{normalizedLoad: 0.1}, now.Add(time.Minute))
	if !recoveredTooSoon.overloaded || recoveredTooSoon.penalty != 100 {
		t.Fatalf("cooldown sample = %#v, want overload penalty retained", recoveredTooSoon)
	}
	recovered := scaler.applyOverloadCooldown("pike", hostLoad{normalizedLoad: 0.1}, now.Add(3*time.Minute))
	if recovered.overloaded || recovered.penalty != 0 {
		t.Fatalf("recovered sample = %#v, want no penalty", recovered)
	}
}

func TestPickHostAvoidsOverloadedHost(t *testing.T) {
	metrics := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		load := "2"
		if strings.Contains(r.URL.Path, "pike") {
			load = "32"
		}
		if _, err := fmt.Fprintf(w, "node_load1 %s\n", load); err != nil {
			t.Errorf("write load metric: %v", err)
		}
		for cpu := range 16 {
			if _, err := fmt.Fprintf(w, "node_cpu_seconds_total{cpu=\"%d\",mode=\"idle\"} 1\n", cpu); err != nil {
				t.Errorf("write CPU metric: %v", err)
			}
		}
	}))
	defer metrics.Close()

	// Fake daemon rather than dockerclient.FromEnv -- see
	// TestPickHostReachability for why FromEnv made these tests depend on
	// the host having a live Docker socket.
	localClient := newFakeDockerServer(t).client(t)
	scaler := &Scaler{
		hostMetricsURLTemplate: metrics.URL + "/%s/metrics",
		dockerHosts:            []DockerHost{{Name: "pike", Client: localClient}, {Name: "laforge", Client: localClient}},
		runners:                runnerState{idle: make(map[string]runnerRef), busy: make(map[string]runnerRef)},
		logger:                 slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	picked, err := scaler.pickHost(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if picked != "laforge" {
		t.Fatalf("picked %q, want laforge", picked)
	}
}

func TestHostLoadMetricsFailureFailsOpen(t *testing.T) {
	// Fake daemon rather than dockerclient.FromEnv -- see
	// TestPickHostReachability for why FromEnv made these tests depend on
	// the host having a live Docker socket.
	localClient := newFakeDockerServer(t).client(t)
	scaler := &Scaler{
		hostMetricsURLTemplate: "http://127.0.0.1:1/%s",
		dockerHosts:            []DockerHost{{Name: "pike", Client: localClient}},
		runners:                runnerState{idle: make(map[string]runnerRef), busy: make(map[string]runnerRef)},
		logger:                 slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	picked, err := scaler.pickHost(context.Background())
	if err != nil || picked != "pike" {
		t.Fatalf("pickHost() = (%q, %v), want (pike, nil)", picked, err)
	}
}

// TestPruneDeadIdleRunners exercises pruneDeadIdleRunners' ContainerInspect
// outcomes: only a successful inspect showing a non-running state, or a
// definitive not-found, counts as death. A transport-ish failure (a generic
// 500, or the host being unreachable altogether) must leave the entry
// tracked.
func TestPruneDeadIdleRunners(t *testing.T) {
	running := &container.State{Status: container.StateRunning, Running: true}
	exited := &container.State{Status: container.StateExited, Running: false}

	cases := []struct {
		name        string
		unreachable bool
		setup       func(f *fakeDockerServer)
		wantPruned  bool
	}{
		{
			name:       "running container is kept",
			setup:      func(f *fakeDockerServer) { f.setInspect("c1", http.StatusOK, running) },
			wantPruned: false,
		},
		{
			name:       "exited container is pruned",
			setup:      func(f *fakeDockerServer) { f.setInspect("c1", http.StatusOK, exited) },
			wantPruned: true,
		},
		{
			name:       "not found (404) is pruned",
			setup:      func(f *fakeDockerServer) { f.setInspect("c1", http.StatusNotFound, nil) },
			wantPruned: true,
		},
		{
			name:       "server error (500) is kept, not treated as not-found",
			setup:      func(f *fakeDockerServer) { f.setInspect("c1", http.StatusInternalServerError, nil) },
			wantPruned: false,
		},
		{
			name:        "transport error (connection refused) is kept",
			unreachable: true,
			wantPruned:  false,
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			var client *dockerclient.Client
			if c.unreachable {
				var err error
				client, err = dockerclient.NewClientWithOpts(
					dockerclient.WithHost("tcp://127.0.0.1:1"),
					dockerclient.WithAPIVersionNegotiation(),
				)
				if err != nil {
					t.Fatalf("failed to create unreachable client: %v", err)
				}
			} else {
				f := newFakeDockerServer(t)
				c.setup(f)
				client = f.client(t)
			}

			scaler := &Scaler{
				dockerHosts: []DockerHost{{Name: "host-a", Client: client}},
				runners: runnerState{
					idle: map[string]runnerRef{"runner-1": {host: "host-a", containerID: "c1"}},
					busy: make(map[string]runnerRef),
				},
				scalesetClient: newStubScalesetClient(t),
				logger:         slog.New(slog.NewTextHandler(os.Stdout, nil)),
			}

			scaler.pruneDeadIdleRunners(context.Background())

			_, stillIdle := scaler.runners.idle["runner-1"]
			switch {
			case c.wantPruned && stillIdle:
				t.Errorf("expected runner-1 to be pruned, but it is still tracked idle")
			case !c.wantPruned && !stillIdle:
				t.Errorf("expected runner-1 to remain tracked idle, but it was pruned")
			}
		})
	}
}

// TestCleanupOrphansScopedToScaleSet exercises the boot=true pass: stopped
// owned containers are removed, running owned containers are adopted, and
// other scale sets/unlabeled containers are untouched.
func TestCleanupOrphansScopedToScaleSet(t *testing.T) {
	old := time.Now().Add(-time.Hour).Unix()
	ours := map[string]string{runnerScaleSetLabelKey: "myset"}
	other := map[string]string{runnerScaleSetLabelKey: "otherset"}

	f := newFakeDockerServer(t)
	f.setContainers([]container.Summary{
		{ID: "a", Names: []string{"/runner-aaaaaaaa"}, Labels: ours, State: container.StateExited, Created: old},
		{ID: "e", Names: []string{"/runner-eeeeeeee"}, Labels: ours, State: container.StateRunning, Created: old},
		{ID: "b", Names: []string{"/runner-bbbbbbbb"}, Labels: other, State: container.StateExited, Created: old},
		{ID: "c", Names: []string{"/runner-cccccccc"}, State: container.StateExited, Created: old},
		{ID: "d", Names: []string{"/some-other-service"}, State: container.StateRunning, Created: old},
	})

	scaler := &Scaler{
		scaleSetName: "myset",
		dockerHosts:  []DockerHost{{Name: "host-a", Client: f.client(t)}},
		runners: runnerState{
			idle: make(map[string]runnerRef),
			busy: make(map[string]runnerRef),
		},
		scalesetClient: newStubScalesetClient(t),
		logger:         slog.New(slog.NewTextHandler(os.Stdout, nil)),
	}

	scaler.cleanupOrphans(context.Background(), true)

	removed := map[string]bool{}
	for _, id := range f.removedIDs() {
		removed[id] = true
	}
	if !removed["a"] {
		t.Errorf("expected labeled-ours container %q to be removed at boot", "a")
	}
	if removed["e"] {
		t.Errorf("running owned container %q must be adopted, not removed", "e")
	}
	if ref, ok := scaler.runners.busy["runner-eeeeeeee"]; !ok || ref.containerID != "e" {
		t.Errorf("running owned container was not adopted as busy: %#v", scaler.runners.busy)
	}
	if removed["c"] {
		t.Errorf("unlabeled container %q must never be removed, even with a runner-like name", "c")
	}
	if removed["b"] {
		t.Errorf("container %q labeled for a different scale set must never be removed", "b")
	}
	if removed["d"] {
		t.Errorf("unlabeled non-matching-name container %q must never be removed", "d")
	}
}

func TestTopHasRunnerWorker(t *testing.T) {
	if topHasRunnerWorker(container.TopResponse{Processes: [][]string{{"Runner.Listener run"}}}) {
		t.Error("idle listener must not be classified as busy")
	}
	if !topHasRunnerWorker(container.TopResponse{Processes: [][]string{{"/home/runner/bin/Runner.Worker spawnclient 123"}}}) {
		t.Error("Runner.Worker process must be classified as busy")
	}
}

func TestBeginDrainRemovesIdleAndPreservesBusy(t *testing.T) {
	f := newFakeDockerServer(t)
	scaler := &Scaler{
		scaleSetName: "myset",
		dockerHosts:  []DockerHost{{Name: "host-a", Client: f.client(t)}},
		runners: runnerState{
			idle: map[string]runnerRef{"idle": {host: "host-a", containerID: "i"}},
			busy: map[string]runnerRef{"busy": {host: "host-a", containerID: "b"}},
		},
		scalesetClient: newStubScalesetClient(t),
		logger:         slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	scaler.BeginDrain(context.Background())
	if !scaler.draining.Load() {
		t.Fatal("draining flag was not set")
	}
	if len(scaler.runners.idle) != 0 {
		t.Fatalf("idle runners remain: %#v", scaler.runners.idle)
	}
	if _, ok := scaler.runners.busy["busy"]; !ok {
		t.Fatal("busy runner was not preserved")
	}
	removed := f.removedIDs()
	if len(removed) != 1 || removed[0] != "i" {
		t.Fatalf("removed IDs = %v, want [i]", removed)
	}
}

func TestPickHostCountsRunnersAcrossScaleSets(t *testing.T) {
	loaded := newFakeDockerServer(t)
	loaded.setContainers([]container.Summary{
		{ID: "1", Labels: map[string]string{runnerScaleSetLabelKey: "other"}, State: container.StateRunning},
		{ID: "2", Labels: map[string]string{runnerScaleSetLabelKey: "third"}, State: container.StateRunning},
	})
	empty := newFakeDockerServer(t)
	metrics := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, err := fmt.Fprintln(w, "node_load1 0"); err != nil {
			t.Errorf("write load metric: %v", err)
		}
		if _, err := fmt.Fprintln(w, `node_cpu_seconds_total{cpu="0",mode="idle"} 1`); err != nil {
			t.Errorf("write CPU metric: %v", err)
		}
	}))
	defer metrics.Close()
	scaler := &Scaler{
		hostMetricsURLTemplate: metrics.URL + "/%s",
		dockerHosts:            []DockerHost{{Name: "loaded", Client: loaded.client(t)}, {Name: "empty", Client: empty.client(t)}},
		runners:                runnerState{idle: make(map[string]runnerRef), busy: make(map[string]runnerRef)},
		logger:                 slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	picked, err := scaler.pickHost(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if picked != "empty" {
		t.Fatalf("picked %q, want empty", picked)
	}
}

func TestPickHostHonorsFleetWideHostRunnerLimit(t *testing.T) {
	limited := newFakeDockerServer(t)
	limited.setContainers([]container.Summary{{
		ID: "1", Labels: map[string]string{runnerScaleSetLabelKey: "other"}, State: container.StateRunning,
	}})
	empty := newFakeDockerServer(t)
	metrics := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, err := fmt.Fprintln(w, "node_load1 0"); err != nil {
			t.Errorf("write load metric: %v", err)
		}
		if _, err := fmt.Fprintln(w, `node_cpu_seconds_total{cpu="0",mode="idle"} 1`); err != nil {
			t.Errorf("write CPU metric: %v", err)
		}
	}))
	defer metrics.Close()
	scaler := &Scaler{
		hostMetricsURLTemplate: metrics.URL + "/%s",
		dockerHosts:            []DockerHost{{Name: "janeway", Client: limited.client(t)}, {Name: "laforge", Client: empty.client(t)}},
		hostRunnerLimits:       map[string]int{"janeway": 1},
		runners:                runnerState{idle: make(map[string]runnerRef), busy: make(map[string]runnerRef)},
		logger:                 slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	picked, err := scaler.pickHost(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if picked != "laforge" {
		t.Fatalf("picked %q, want laforge", picked)
	}
}

func TestPickHostE2EPreservesFleetWideHostRunnerLimit(t *testing.T) {
	limited := newFakeDockerServer(t)
	limited.setContainers([]container.Summary{{
		ID: "1", Labels: map[string]string{runnerScaleSetLabelKey: "default"}, State: container.StateRunning,
	}})
	empty := newFakeDockerServer(t)
	metrics := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		load := "0"
		if strings.Contains(r.URL.Path, "laforge") {
			load = "32"
		}
		if _, err := fmt.Fprintf(w, "node_load1 %s\n", load); err != nil {
			t.Errorf("write load metric: %v", err)
		}
		for cpu := range 16 {
			if _, err := fmt.Fprintf(w, "node_cpu_seconds_total{cpu=\"%d\",mode=\"idle\"} 1\n", cpu); err != nil {
				t.Errorf("write CPU metric: %v", err)
			}
		}
	}))
	defer metrics.Close()
	scaler := &Scaler{
		hostMetricsURLTemplate: metrics.URL + "/%s",
		dockerHosts:            []DockerHost{{Name: "janeway", Client: limited.client(t)}, {Name: "laforge", Client: empty.client(t)}},
		hostRunnerLimits:       map[string]int{"janeway": 1},
		shareWorkDir:           true,
		runners:                runnerState{idle: make(map[string]runnerRef), busy: make(map[string]runnerRef)},
		logger:                 slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	picked, err := scaler.pickHost(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if picked != "laforge" {
		t.Fatalf("picked %q, want laforge; E2E candidate filtering reintroduced limited Janeway", picked)
	}
}

// TestCleanupOrphansPeriodicGuards exercises the boot=false pass: on top of
// the ownership check, a container must additionally be untracked, not
// running, and older than orphanMinAge to be removed.
func TestCleanupOrphansPeriodicGuards(t *testing.T) {
	old := time.Now().Add(-time.Hour).Unix()
	recent := time.Now().Unix()
	ours := map[string]string{runnerScaleSetLabelKey: "myset"}

	f := newFakeDockerServer(t)
	f.setContainers([]container.Summary{
		{ID: "t1", Names: []string{"/runner-11111111"}, Labels: ours, State: container.StateExited, Created: old},    // tracked -> kept
		{ID: "t2", Names: []string{"/runner-22222222"}, Labels: ours, State: container.StateRunning, Created: old},   // running -> kept
		{ID: "t3", Names: []string{"/runner-33333333"}, Labels: ours, State: container.StateExited, Created: recent}, // too young -> kept
		{ID: "t4", Names: []string{"/runner-44444444"}, Labels: ours, State: container.StateExited, Created: old},    // untracked+exited+old -> removed
	})

	scaler := &Scaler{
		scaleSetName: "myset",
		dockerHosts:  []DockerHost{{Name: "host-a", Client: f.client(t)}},
		runners: runnerState{
			idle: map[string]runnerRef{"runner-11111111": {host: "host-a", containerID: "t1"}},
			busy: make(map[string]runnerRef),
		},
		scalesetClient: newStubScalesetClient(t),
		logger:         slog.New(slog.NewTextHandler(os.Stdout, nil)),
	}

	scaler.cleanupOrphans(context.Background(), false)

	removed := f.removedIDs()
	if len(removed) != 1 || removed[0] != "t4" {
		t.Errorf("expected only t4 to be removed by the periodic pass, got %v", removed)
	}
}

// TestPickHostAllUnreachable verifies pickHost errors (rather than falling
// back to some default) when every configured docker host is unreachable.
func TestPickHostAllUnreachable(t *testing.T) {
	client, err := dockerclient.NewClientWithOpts(
		dockerclient.WithHost("tcp://127.0.0.1:1"),
		dockerclient.WithAPIVersionNegotiation(),
	)
	if err != nil {
		t.Fatalf("failed to create unreachable client: %v", err)
	}

	scaler := &Scaler{
		dockerHosts: []DockerHost{{Name: "only-host", Client: client}},
		runners: runnerState{
			idle: make(map[string]runnerRef),
			busy: make(map[string]runnerRef),
		},
		logger: slog.New(slog.NewTextHandler(os.Stdout, nil)),
	}

	host, err := scaler.pickHost(context.Background())
	if err == nil {
		t.Fatalf("expected pickHost to return an error when every host is unreachable")
	}
	if host != "" {
		t.Errorf("expected empty host on error, got %q", host)
	}
}

// TestPickHostSocketMountedNoColocation verifies that when mountDockerSocket
// is set, pickHost refuses to place a second same-scale-set runner on a host
// that already has one, and errors once every reachable host is occupied.
//
// Keys off shareWorkDir, not the socket: the exclusion exists because two
// runners of one scale set on a host resolve the same repo to the same
// checkout directory and corrupt each other, which is a property of the
// SHARED WORKDIR, not of holding docker.sock (agent-lcars#101).
func TestPickHostSharedWorkDirNoColocation(t *testing.T) {
	fa := newFakeDockerServer(t)
	fb := newFakeDockerServer(t)

	scaler := &Scaler{
		shareWorkDir: true,
		dockerHosts: []DockerHost{
			{Name: "a", Client: fa.client(t)},
			{Name: "b", Client: fb.client(t)},
		},
		runners: runnerState{
			idle: map[string]runnerRef{"runner-1": {host: "a", containerID: "c1"}},
			busy: make(map[string]runnerRef),
		},
		logger: slog.New(slog.NewTextHandler(os.Stdout, nil)),
	}

	picked, err := scaler.pickHost(context.Background())
	if err != nil {
		t.Fatalf("pickHost returned error: %v", err)
	}
	if picked != "b" {
		t.Errorf("expected pickHost to avoid co-locating on host a, got %s", picked)
	}

	scaler.runners.idle["runner-2"] = runnerRef{host: "b", containerID: "c2"}

	if _, err := scaler.pickHost(context.Background()); err == nil {
		t.Errorf("expected pickHost to error once every reachable host already has a runner placed")
	}
}

// TestEnsureRunnerImageRefreshesMutableTags pins agent-lcars#139: a TAG can
// move in the registry, so a local hit must never be treated as
// authoritative. The previous behaviour pulled only when the image was
// absent, which meant hosts served whatever they pulled first until an
// unrelated prune deleted it -- including for images rebuilt specifically to
// REMOVE something.
func TestEnsureRunnerImageRefreshesMutableTags(t *testing.T) {
	fake := newFakeDockerServer(t)
	scaler := &Scaler{
		runnerImage: "registry.example/runner:test",
		logger:      slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	client := fake.client(t)

	// Absent (e.g. just pruned) -- must pull.
	if err := scaler.ensureRunnerImage(context.Background(), client, "spark"); err != nil {
		t.Fatalf("ensureRunnerImage after prune: %v", err)
	}
	// Present but MUTABLE -- must pull again, because the tag may have moved.
	if err := scaler.ensureRunnerImage(context.Background(), client, "spark"); err != nil {
		t.Fatalf("ensureRunnerImage with cached tag: %v", err)
	}
	if got := fake.pullCount(); got != 2 {
		t.Fatalf("tag pulls = %d, want 2 (a cached tag must still be refreshed)", got)
	}
}

// TestEnsureRunnerImageTrustsDigestCache is the other half: a digest
// reference is immutable, so a local hit IS authoritative and re-pulling
// could not change the bytes. Skipping it keeps the refresh above from
// costing a registry round-trip on every placement for pinned images.
func TestEnsureRunnerImageTrustsDigestCache(t *testing.T) {
	fake := newFakeDockerServer(t)
	scaler := &Scaler{
		runnerImage: "registry.example/runner@sha256:" + strings.Repeat("a", 64),
		logger:      slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	client := fake.client(t)

	if err := scaler.ensureRunnerImage(context.Background(), client, "spark"); err != nil {
		t.Fatalf("ensureRunnerImage after prune: %v", err)
	}
	if err := scaler.ensureRunnerImage(context.Background(), client, "spark"); err != nil {
		t.Fatalf("ensureRunnerImage with cached digest: %v", err)
	}
	if got := fake.pullCount(); got != 1 {
		t.Fatalf("digest pulls = %d, want exactly 1 (immutable ref may be cached)", got)
	}
}

func TestIsDigestRef(t *testing.T) {
	for ref, want := range map[string]bool{
		"registry.example/runner:test":                              false,
		"registry.example:5000/ns/runner:test":                      false,
		"registry.example/runner@sha256:" + strings.Repeat("a", 64): true,
		"runner@sha256:" + strings.Repeat("b", 64):                  true,
	} {
		if got := isDigestRef(ref); got != want {
			t.Errorf("isDigestRef(%q) = %v, want %v", ref, got, want)
		}
	}
}

// TestRunnerBinds pins the privilege boundary the socketless build-client
// lane depends on, and that persistence is now independent of privilege:
// a pool can share the host workdir WITHOUT being handed the docker
// socket, which is the whole point of splitting the two flags
// (agent-lcars#101). File mounts stay read-only and never drag either
// along with them.
func TestRunnerBinds(t *testing.T) {
	mounts := []FileMount{{HostPath: "/etc/buildkit/client.pem", ContainerPath: "/secrets/client.pem"}}

	socketless := runnerBinds(false, false, mounts)
	if len(socketless) != 1 || socketless[0] != "/etc/buildkit/client.pem:/secrets/client.pem:ro" {
		t.Fatalf("socketless binds = %#v", socketless)
	}
	for _, b := range socketless {
		if strings.Contains(b, "docker.sock") || strings.Contains(b, "/home/runner/_work") {
			t.Fatalf("socketless lane leaked a privileged bind: %q", b)
		}
	}

	if got := runnerBinds(false, false, nil); got != nil {
		t.Fatalf("no socket, no workdir and no mounts should yield no binds, got %#v", got)
	}

	// The case the split exists for: a warm workdir with NO socket.
	warm := runnerBinds(false, true, nil)
	if len(warm) != 2 {
		t.Fatalf("shared-workdir binds = %#v", warm)
	}
	for _, b := range warm {
		if strings.Contains(b, "docker.sock") {
			t.Fatalf("sharing the workdir must not imply the socket: %q", b)
		}
	}

	// And the inverse: a socket with no shared workdir.
	sockOnly := runnerBinds(true, false, nil)
	if len(sockOnly) != 1 || !strings.Contains(sockOnly[0], "docker.sock") {
		t.Fatalf("socket-only binds = %#v", sockOnly)
	}

	// Both, plus mounts appended read-only last.
	both := runnerBinds(true, true, mounts)
	if len(both) != 4 {
		t.Fatalf("socket+workdir binds = %#v", both)
	}
	if both[3] != "/etc/buildkit/client.pem:/secrets/client.pem:ro" {
		t.Fatalf("file mount not appended read-only: %q", both[3])
	}
}

func TestRunnerHostConfig(t *testing.T) {
	t.Run("zero pids limit means unlimited, not zero", func(t *testing.T) {
		hc := runnerHostConfig(nil, nil, 0, 0, 0)
		if hc.Resources.PidsLimit != nil {
			t.Fatalf("PidsLimit = %v, want nil (unlimited)", *hc.Resources.PidsLimit)
		}
	})

	t.Run("memory, pids limit and shm size are all set", func(t *testing.T) {
		hc := runnerHostConfig([]string{"/a:/b"}, []string{"999"}, 12<<30, 8192, 1<<30)
		if hc.Resources.Memory != 12<<30 {
			t.Fatalf("Memory = %d, want %d", hc.Resources.Memory, int64(12<<30))
		}
		if hc.Resources.PidsLimit == nil || *hc.Resources.PidsLimit != 8192 {
			t.Fatalf("PidsLimit = %v, want 8192", hc.Resources.PidsLimit)
		}
		if hc.ShmSize != 1<<30 {
			t.Fatalf("ShmSize = %d, want %d", hc.ShmSize, int64(1<<30))
		}
		if len(hc.Binds) != 1 || hc.Binds[0] != "/a:/b" {
			t.Fatalf("Binds = %#v", hc.Binds)
		}
		if len(hc.GroupAdd) != 1 || hc.GroupAdd[0] != "999" {
			t.Fatalf("GroupAdd = %#v", hc.GroupAdd)
		}
	})
}

// TestEnsureRunnerImageRejectsStreamedPullError is the other half of #139's
// fix. Docker reports registry/auth/manifest failures INSIDE the pull
// progress stream, with ImagePull itself returning nil. Since a refreshed
// TAG is normally already present locally, simply discarding that body lets
// the following ImageInspect succeed against the STALE image -- so the
// function would return nil and launch exactly what the refresh exists to
// replace, including for a security-removal rebuild.
func TestEnsureRunnerImageRejectsStreamedPullError(t *testing.T) {
	fake := newFakeDockerServer(t)
	scaler := &Scaler{
		runnerImage: "registry.example/runner:test",
		logger:      slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	client := fake.client(t)

	// First pull succeeds, so the tag is present locally from here on --
	// which is what makes the post-pull inspect an unreliable check.
	if err := scaler.ensureRunnerImage(context.Background(), client, "spark"); err != nil {
		t.Fatalf("initial pull: %v", err)
	}

	fake.mu.Lock()
	fake.pullStreamError = true
	fake.mu.Unlock()

	err := scaler.ensureRunnerImage(context.Background(), client, "spark")
	if err == nil {
		t.Fatal("a streamed pull error must fail the refresh, not fall through to the cached image")
	}
	if !strings.Contains(err.Error(), "manifest unknown") {
		t.Errorf("error should surface the daemon's message, got: %v", err)
	}
}

package main

import (
	"context"
	"errors"
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
	"github.com/prometheus/client_golang/prometheus/testutil"
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
	rs.addIdle("runner-1", "host-a", "cid-1", time.Now())
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

func TestParseExternalsHealthOutput(t *testing.T) {
	cases := []struct {
		name        string
		out         string
		wantHealthy bool
		wantOK      bool
	}{
		{"healthy", "SWEEP before=1 after=1 cap=2\nEXTERNALS_HEALTHY=1\n", true, true},
		{"unhealthy", "SWEEP before=1 after=1 cap=2\nEXTERNALS_HEALTHY=0\n", false, true},
		{"missing line", "SWEEP before=1 after=1 cap=2\n", false, false},
		{"empty", "", false, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			healthy, ok := parseExternalsHealthOutput(c.out)
			if ok != c.wantOK || healthy != c.wantHealthy {
				t.Errorf("parseExternalsHealthOutput(%q) = (%v, %v), want (%v, %v)", c.out, healthy, ok, c.wantHealthy, c.wantOK)
			}
		})
	}
}

// TestExternalsHealthSkipped covers agent-lcars#464: a share_workdir pool
// (e.g. homelab-autoscale-e2e) can be configured with a runner_image that
// never had agent-lcars' externals-health.sh baked in, so the sweep script
// prints EXTERNALS_HEALTHY_SKIPPED instead of attempting the check. That
// must be recognized as "not applicable", not "malformed output" (which
// would log a WARN every single sweep, on every host, forever).
func TestExternalsHealthSkipped(t *testing.T) {
	cases := []struct {
		name string
		out  string
		want bool
	}{
		{"skipped", "SWEEP before=1 after=1 cap=2\nEXTERNALS_HEALTHY_SKIPPED\n", true},
		{"healthy", "SWEEP before=1 after=1 cap=2\nEXTERNALS_HEALTHY=1\n", false},
		{"unhealthy", "SWEEP before=1 after=1 cap=2\nEXTERNALS_HEALTHY=0\n", false},
		{"empty", "", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := externalsHealthSkipped(c.out); got != c.want {
				t.Errorf("externalsHealthSkipped(%q) = %v, want %v", c.out, got, c.want)
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

func TestSweepHostPreparesImageOutsideWorkDirLock(t *testing.T) {
	fake := newFakeDockerServer(t)
	client := fake.client(t)
	scaler := &Scaler{
		runnerImage: "registry.example/runner:test",
		logger:      slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	lock := scaler.hostWorkDirLock("pike")
	lock.Lock()

	done := make(chan struct{})
	go func() {
		defer close(done)
		scaler.sweepHostIfIdle(context.Background(), client, "pike")
	}()

	deadline := time.Now().Add(time.Second)
	for fake.pullCount() == 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if fake.pullCount() == 0 {
		lock.Unlock()
		<-done
		t.Fatal("runner image preparation waited for the workdir lock")
	}

	lock.Unlock()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("workdir sweep did not finish after releasing the lock")
	}
}

func TestSweepWorkDirsWithTimeoutBoundsSlowHost(t *testing.T) {
	fake := newFakeDockerServer(t)
	fake.setListDelay(time.Second)
	scaler := &Scaler{
		dockerHosts: []DockerHost{{Name: "pike", Client: fake.client(t)}},
		runnerImage: "registry.example/runner:test",
		logger:      slog.New(slog.NewTextHandler(io.Discard, nil)),
	}

	start := time.Now()
	scaler.sweepWorkDirsWithTimeout(context.Background(), 25*time.Millisecond)
	if elapsed := time.Since(start); elapsed > 500*time.Millisecond {
		t.Fatalf("timed sweep took %s, want context deadline to bound the slow host", elapsed)
	}
}

func TestSweepWorkDirsWithTimeoutBoundsContendedLock(t *testing.T) {
	fake := newFakeDockerServer(t)
	scaler := &Scaler{
		dockerHosts: []DockerHost{{Name: "pike", Client: fake.client(t)}},
		runnerImage: "registry.example/runner:test",
		logger:      slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	lock := scaler.hostWorkDirLock("pike")
	lock.Lock()
	defer lock.Unlock()

	start := time.Now()
	scaler.sweepWorkDirsWithTimeout(context.Background(), 25*time.Millisecond)
	if elapsed := time.Since(start); elapsed > 500*time.Millisecond {
		t.Fatalf("timed sweep took %s, want context deadline to bound lock acquisition", elapsed)
	}
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
	// the host having a live Docker socket. Each host gets its own
	// *dockerclient.Client (both pointed at the same fake daemon): pickHost
	// probes every host concurrently, and two hosts sharing a single
	// *dockerclient.Client race on the docker SDK's lazy, unsynchronized
	// API-version-negotiation state (github.com/jlapenna/agent-lcars#329).
	fakeDaemon := newFakeDockerServer(t)

	scaler := &Scaler{
		sparkMetricsURL: server.URL,
		dockerHosts: []DockerHost{
			{Name: "spark", Client: fakeDaemon.client(t)},
			{Name: "pike", Client: fakeDaemon.client(t)},
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
		{"load hard", "pike", hostLoad{memoryAvailable: 1, normalizedLoad: 2}, 100, true},
		{"cpu hard", "pike", hostLoad{memoryAvailable: 1, cpuUtilization: .97}, 100, true},
		{"cpu psi soft", "pike", hostLoad{memoryAvailable: 1, cpuPressure: .12}, 10, false},
		{"cpu psi hard", "pike", hostLoad{memoryAvailable: 1, cpuPressure: .30}, 100, true},
		{"memory psi hard", "pike", hostLoad{memoryAvailable: 1, memoryPressure: .30}, 100, true},
		{"memory hard", "pike", hostLoad{memoryAvailable: .05}, 100, true},
		{"spark memory exempt", "spark", hostLoad{memoryAvailable: .01}, 0, false},
		{"active swap", "pike", hostLoad{memoryAvailable: 1, swapPagesPerSec: 20}, 10, false},
		// Swap past swapHard penalizes heavily but must NOT set overloaded:
		// pswpin/pswpout cannot tell zram from disk, so it deprioritizes
		// rather than excludes. See scoreHostLoad and
		// TestScoreHostLoadSwapNeverHardOverloads.
		{"swap hard", "pike", hostLoad{memoryAvailable: 1, swapPagesPerSec: 150}, 100, false},
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
	// the host having a live Docker socket. Each host gets its own
	// *dockerclient.Client (both pointed at the same fake daemon): pickHost
	// probes every host concurrently, and two hosts sharing a single
	// *dockerclient.Client race on the docker SDK's lazy, unsynchronized
	// API-version-negotiation state (github.com/jlapenna/agent-lcars#329).
	fakeDaemon := newFakeDockerServer(t)
	scaler := &Scaler{
		hostMetricsURLTemplate: metrics.URL + "/%s/metrics",
		dockerHosts:            []DockerHost{{Name: "pike", Client: fakeDaemon.client(t)}, {Name: "laforge", Client: fakeDaemon.client(t)}},
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

// seedHostLoad injects an exact hostLoad straight into the fleet's placement
// cache so a test can drive pickHost's overload-exclusion logic
// deterministically -- without a real metrics endpoint or the multi-sample,
// multi-second real-time deltas probeHostLoad needs to derive CPU/PSI/swap
// rates. currentHostLoad treats any cache entry younger than
// 2*hostSampleInterval as authoritative, so this value flows straight
// through to pickHostLocked exactly as a real probe's result would.
//
// This caches load AS GIVEN, with no cooldown processing -- a test that
// wants a hard-overloaded reading must produce one the same way a real probe
// would (see hardOverloadedLoad), which also arms fleet.overloadedUntil as a
// side effect. Skipping that and caching a raw scoreHostLoad result directly
// produces a cache state no real probe could ever leave behind
// (overloaded=true with no armed cooldown), which would silently mask
// refreshOverloadCooldown misbehaving -- exactly the gap that let
// agent-lcars#259's cooldown-rearming bug through review the first time.
func seedHostLoad(fleet *FleetCoordinator, host string, load hostLoad) {
	load.observedAt = time.Now()
	fleet.hostLoadCache[host] = load
}

// hardOverloadedLoad scores a raw reading and runs it through
// applyOverloadCooldown exactly as probeHostLoad does before caching --
// arming fleet.overloadedUntil as a side effect for a genuine hard-overload
// reading -- so seedHostLoad callers below produce a cache state a real
// probe could actually leave behind.
func hardOverloadedLoad(scaler *Scaler, host string, raw hostLoad) hostLoad {
	scored := scaler.scoreHostLoad(host, raw)
	return scaler.applyOverloadCooldown(host, scored, time.Now())
}

// TestPickHostMixedFleetPrefersHealthyHost pins agent-lcars#259's first
// acceptance criterion: a fleet with both a healthy and a hard-overloaded
// host must always place on the healthy one, and must not count that as a
// placement_blocked_total -- the fleet had capacity, it just wasn't on the
// bad host.
func TestPickHostMixedFleetPrefersHealthyHost(t *testing.T) {
	overloadedDocker := newFakeDockerServer(t)
	healthyDocker := newFakeDockerServer(t)
	scaler := &Scaler{
		scaleSetName: "set",
		dockerHosts: []DockerHost{
			{Name: "pike", Client: overloadedDocker.client(t)},
			{Name: "laforge", Client: healthyDocker.client(t)},
		},
		runners: runnerState{idle: make(map[string]runnerRef), busy: make(map[string]runnerRef)},
		logger:  slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	fleet := scaler.coordinator()
	seedHostLoad(fleet, "pike", hardOverloadedLoad(scaler, "pike", hostLoad{memoryAvailable: 1, normalizedLoad: 2}))

	blocked := placementBlocked.WithLabelValues("set", placementReasonOverload)
	before := testutil.ToFloat64(blocked)

	picked, err := scaler.pickHost(context.Background())
	if err != nil {
		t.Fatalf("pickHost returned error: %v", err)
	}
	if picked != "laforge" {
		t.Fatalf("picked %q, want laforge (pike is hard-overloaded)", picked)
	}
	if got := testutil.ToFloat64(blocked) - before; got != 0 {
		t.Errorf("placement_blocked_total{reason=%q} rose by %v, want 0: the fleet had a healthy candidate", placementReasonOverload, got)
	}
}

// TestPickHostAllOverloadedFleetReportsCapacityBlocked pins agent-lcars#259's
// second acceptance criterion: when every reachable, within-limit host is
// hard-overloaded, pickHost must fail closed to fleet-at-capacity -- not
// place on the least-bad overloaded host -- and the cause must be visible in
// Prometheus under its own reason, distinct from host_limits.
func TestPickHostAllOverloadedFleetReportsCapacityBlocked(t *testing.T) {
	dockerA := newFakeDockerServer(t)
	dockerB := newFakeDockerServer(t)
	scaler := &Scaler{
		scaleSetName: "set",
		dockerHosts: []DockerHost{
			{Name: "pike", Client: dockerA.client(t)},
			{Name: "laforge", Client: dockerB.client(t)},
		},
		runners: runnerState{idle: make(map[string]runnerRef), busy: make(map[string]runnerRef)},
		logger:  slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	fleet := scaler.coordinator()
	for _, host := range []string{"pike", "laforge"} {
		seedHostLoad(fleet, host, hardOverloadedLoad(scaler, host, hostLoad{memoryAvailable: 1, normalizedLoad: 2}))
	}

	blocked := placementBlocked.WithLabelValues("set", placementReasonOverload)
	hostLimits := placementBlocked.WithLabelValues("set", placementReasonHostLimits)
	beforeBlocked := testutil.ToFloat64(blocked)
	beforeHostLimits := testutil.ToFloat64(hostLimits)

	host, err := scaler.pickHost(context.Background())
	if host != "" || !errors.Is(err, errFleetAtCapacity) {
		t.Fatalf("pickHost() = (%q, %v), want (\"\", errFleetAtCapacity)", host, err)
	}
	if got := testutil.ToFloat64(blocked) - beforeBlocked; got != 1 {
		t.Errorf("placement_blocked_total{reason=%q} rose by %v, want 1", placementReasonOverload, got)
	}
	// A saturation cause distinct from host_limits: without its own reason,
	// this looks identical in Prometheus to hosts merely being busy with
	// other work, not pressured.
	if got := testutil.ToFloat64(hostLimits) - beforeHostLimits; got != 0 {
		t.Errorf("placement_blocked_total{reason=%q} rose by %v, want 0", placementReasonHostLimits, got)
	}
}

// TestPickHostOverloadCooldownGatesUntilExpiry pins agent-lcars#259's third
// acceptance criterion: a host stays ineligible for the whole configured
// cooldown window even after its raw signal recovers, then becomes eligible
// again once the window elapses. It drives applyOverloadCooldown through the
// real pickHost path by manipulating the fleet's cooldown/cache state
// directly (the same state probeHostLoad would have produced), which avoids
// a real-time sleep spanning the (2-minute default) cooldown window.
func TestPickHostOverloadCooldownGatesUntilExpiry(t *testing.T) {
	fake := newFakeDockerServer(t)
	scaler := &Scaler{
		scaleSetName: "set",
		dockerHosts:  []DockerHost{{Name: "pike", Client: fake.client(t)}},
		runners:      runnerState{idle: make(map[string]runnerRef), busy: make(map[string]runnerRef)},
		logger:       slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	fleet := scaler.coordinator()
	now := time.Now()

	// A prior probe measured hard overload: seed the cache and the cooldown
	// expiry exactly as probeHostLoad -> applyOverloadCooldown would have.
	seedHostLoad(fleet, "pike", hostLoad{overloaded: true, penalty: 100})
	fleet.overloadedUntil["pike"] = now.Add(time.Minute)

	if host, err := scaler.pickHost(context.Background()); host != "" || !errors.Is(err, errFleetAtCapacity) {
		t.Fatalf("during hard overload: pickHost() = (%q, %v), want (\"\", errFleetAtCapacity)", host, err)
	}

	// The underlying signal recovers, but the cooldown window has not
	// elapsed -- the host must remain excluded. This is the point of
	// cooldown: a flapping or just-recovered host does not immediately
	// re-enter rotation. Run the recovered raw reading through
	// applyOverloadCooldown, exactly as probeHostLoad would, rather than
	// caching overloaded=false directly: a real probe can never leave that
	// cached while a cooldown window is still active (its own check-only
	// branch forces true first), so caching it raw here would test a state
	// that cannot actually occur.
	seedHostLoad(fleet, "pike", scaler.applyOverloadCooldown("pike", hostLoad{overloaded: false}, time.Now()))
	if host, err := scaler.pickHost(context.Background()); host != "" || !errors.Is(err, errFleetAtCapacity) {
		t.Fatalf("mid-cooldown recovery: pickHost() = (%q, %v), want (\"\", errFleetAtCapacity)", host, err)
	}

	// The cooldown window has elapsed: the host becomes eligible again.
	fleet.overloadedUntil["pike"] = now.Add(-time.Minute)
	seedHostLoad(fleet, "pike", hostLoad{overloaded: false})
	picked, err := scaler.pickHost(context.Background())
	if err != nil {
		t.Fatalf("after cooldown expiry: pickHost returned error: %v", err)
	}
	if picked != "pike" {
		t.Fatalf("picked %q, want pike", picked)
	}
}

// TestPickHostOverloadCooldownCachedRereadDoesNotExtendWindow pins the
// interaction flagged in PR #390 review (agent-lcars#259 follow-up):
// pickHostLocked used to feed a CACHED, already-cooldown-derived
// hostLoad.overloaded=true value straight back into applyOverloadCooldown.
// That function cannot tell "a fresh raw breach" apart from "an echo of my
// own prior cooldown-forcing" -- any overloaded=true input re-arms
// overloadedUntil to now+cooldown. Since currentHostLoad's cache stays
// authoritative for up to 2*hostSampleInterval (30s), and a retried scale-up
// loop calls pickHost far more often than that, a host whose RAW signal had
// already recovered but was still cooling down got its cooldown re-armed by
// every placement attempt within the cache window and could never actually
// exit cooldown.
//
// Unlike TestPickHostOverloadCooldownGatesUntilExpiry (which seeds the
// "recovered" phase with a raw overloaded=false value and so never exercises
// this path), this test seeds the cache with exactly what probeHostLoad
// produces for a recovered-but-cooling-down host: scoreHostLoad's healthy
// raw reading run through applyOverloadCooldown's check-only branch, which
// forces .overloaded=true from the still-active window without touching
// overloadedUntil. It then proves the fix two ways: repeated placement
// attempts against that cached reading leave the recorded cooldown expiry
// byte-for-byte unchanged (no re-arming), and the host becomes eligible
// again exactly once that untouched expiry passes -- not later.
func TestPickHostOverloadCooldownCachedRereadDoesNotExtendWindow(t *testing.T) {
	fake := newFakeDockerServer(t)
	scaler := &Scaler{
		scaleSetName: "set",
		dockerHosts:  []DockerHost{{Name: "pike", Client: fake.client(t)}},
		runners:      runnerState{idle: make(map[string]runnerRef), busy: make(map[string]runnerRef)},
		logger:       slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	fleet := scaler.coordinator()

	healthyRaw := scaler.scoreHostLoad("pike", hostLoad{memoryAvailable: 1})
	if healthyRaw.overloaded {
		t.Fatalf("fixture bug: healthyRaw must not be raw-overloaded")
	}
	originalUntil := time.Now().Add(40 * time.Millisecond)
	fleet.overloadedUntil["pike"] = originalUntil
	// Exactly what probeHostLoad does: run the healthy raw reading through
	// applyOverloadCooldown while a cooldown window is still active.
	cooldownForced := scaler.applyOverloadCooldown("pike", healthyRaw, time.Now())
	if !cooldownForced.overloaded {
		t.Fatalf("fixture bug: expected the still-active cooldown to force overloaded=true")
	}
	if got := fleet.overloadedUntil["pike"]; !got.Equal(originalUntil) {
		t.Fatalf("fixture bug: applyOverloadCooldown's own check-only branch must not rearm the window, got %v want %v", got, originalUntil)
	}
	seedHostLoad(fleet, "pike", cooldownForced)

	// Repeated placement attempts against that cached, cooldown-derived
	// reading -- exactly what a retried scale-up loop produces -- must never
	// push the recorded expiry out.
	for i := 0; i < 3; i++ {
		if host, err := scaler.pickHost(context.Background()); host != "" || !errors.Is(err, errFleetAtCapacity) {
			t.Fatalf("attempt %d: pickHost() = (%q, %v), want (\"\", errFleetAtCapacity)", i, host, err)
		}
		if got := fleet.overloadedUntil["pike"]; !got.Equal(originalUntil) {
			t.Fatalf("attempt %d: overloadedUntil moved from %v to %v -- a cached re-read must not rearm the cooldown", i, originalUntil, got)
		}
	}

	// The untouched window elapses on schedule: the host becomes eligible
	// again, without ever having been re-armed.
	time.Sleep(60 * time.Millisecond)
	picked, err := scaler.pickHost(context.Background())
	if err != nil {
		t.Fatalf("after the original cooldown window elapsed: pickHost returned error: %v", err)
	}
	if picked != "pike" {
		t.Fatalf("picked %q, want pike", picked)
	}
}

// TestPickHostExcludesEachHardOverloadSignal pins agent-lcars#259's
// requirement that load, CPU/PSI, and memory hard thresholds each
// independently exclude a host from placement, by feeding scoreHostLoad's
// real output for each signal through the real pickHost path (see
// seedHostLoad). TestScoreHostLoadPressureSignals already covers scoring in
// isolation; this covers that a hard-overloaded reading, from whichever
// signal produced it, actually removes the host from candidates and reports
// fleet-at-capacity instead of placing on it.
//
// Swap rate is deliberately NOT in this list -- it deprioritizes without
// excluding, because pswpin/pswpout cannot distinguish zram from disk. Its
// inverse is pinned by TestScoreHostLoadSwapNeverHardOverloads.
func TestPickHostExcludesEachHardOverloadSignal(t *testing.T) {
	cases := []struct {
		name string
		load hostLoad
	}{
		{"load hard", hostLoad{memoryAvailable: 1, normalizedLoad: 2}},
		{"cpu utilization hard", hostLoad{memoryAvailable: 1, cpuUtilization: .97}},
		{"cpu psi hard", hostLoad{memoryAvailable: 1, cpuPressure: .30}},
		{"memory psi hard", hostLoad{memoryAvailable: 1, memoryPressure: .30}},
		{"memory available hard", hostLoad{memoryAvailable: .05}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			fake := newFakeDockerServer(t)
			scaler := &Scaler{
				scaleSetName: "set",
				dockerHosts:  []DockerHost{{Name: "pike", Client: fake.client(t)}},
				runners:      runnerState{idle: make(map[string]runnerRef), busy: make(map[string]runnerRef)},
				logger:       slog.New(slog.NewTextHandler(io.Discard, nil)),
			}
			scored := scaler.scoreHostLoad("pike", tc.load)
			if !scored.overloaded {
				t.Fatalf("fixture %q must itself score hard-overloaded (penalty=%d)", tc.name, scored.penalty)
			}
			fleet := scaler.coordinator()
			seedHostLoad(fleet, "pike", scaler.applyOverloadCooldown("pike", scored, time.Now()))

			blocked := placementBlocked.WithLabelValues("set", placementReasonOverload)
			before := testutil.ToFloat64(blocked)

			host, err := scaler.pickHost(context.Background())
			if host != "" || !errors.Is(err, errFleetAtCapacity) {
				t.Fatalf("pickHost() = (%q, %v), want (\"\", errFleetAtCapacity)", host, err)
			}
			if got := testutil.ToFloat64(blocked) - before; got != 1 {
				t.Errorf("placement_blocked_total{reason=%q} rose by %v, want 1", placementReasonOverload, got)
			}
		})
	}
}

// TestScoreHostLoadSwapNeverHardOverloads is the inverse of
// TestPickHostExcludesEachHardOverloadSignal, for the one pressure signal
// that must NOT exclude. node_vmstat_pswpin/pswpout sum every swap device,
// so a host paging hard into zram (compressed RAM, microsecond latency) is
// indistinguishable from one thrashing to disk. pike does exactly that --
// /dev/zram0 at priority 5 under Ubuntu's zram-config, vm.swappiness=180 --
// and the old hard gate removed it from placement 25.1% of a measured week
// while memory PSI, which sees the actual stall, tripped on only 1.7% of it.
//
// So a swap rate far past swapHard must still score a heavy penalty (it
// loses ties) while remaining a placement candidate.
func TestScoreHostLoadSwapNeverHardOverloads(t *testing.T) {
	fake := newFakeDockerServer(t)
	scaler := &Scaler{
		scaleSetName: "set",
		dockerHosts:  []DockerHost{{Name: "pike", Client: fake.client(t)}},
		runners:      runnerState{idle: make(map[string]runnerRef), busy: make(map[string]runnerRef)},
		logger:       slog.New(slog.NewTextHandler(io.Discard, nil)),
	}

	scored := scaler.scoreHostLoad("pike", hostLoad{memoryAvailable: 1, swapPagesPerSec: 10000})
	if scored.overloaded {
		t.Fatal("swap rate must never hard-overload: zram traffic is indistinguishable from disk thrash")
	}
	if scored.penalty != 100 {
		t.Fatalf("penalty = %d, want 100 (deprioritized but still placeable)", scored.penalty)
	}

	fleet := scaler.coordinator()
	seedHostLoad(fleet, "pike", scaler.applyOverloadCooldown("pike", scored, time.Now()))

	host, err := scaler.pickHost(context.Background())
	if err != nil || host != "pike" {
		t.Fatalf("pickHost() = (%q, %v), want (\"pike\", nil)", host, err)
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
		// wantReason is the runnerDiedIdleTotal reason label expected to
		// increment by exactly 1, or "" if pruning must not touch the
		// counter at all (agent-lcars#393).
		wantReason string
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
			wantReason: runnerDeadReasonNotRunning,
		},
		{
			name:       "not found (404) is pruned",
			setup:      func(f *fakeDockerServer) { f.setInspect("c1", http.StatusNotFound, nil) },
			wantPruned: true,
			wantReason: runnerDeadReasonNotFound,
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

			// Counters are process-global and other subtests/tests share
			// them, so measure the delta this call produces rather than an
			// absolute value (same reasoning as
			// TestPickHostSharedWorkDirExhaustionCountsPlacementBlocked).
			notRunningCounter := runnerDiedIdleTotal.WithLabelValues("default", "host-a", runnerDeadReasonNotRunning)
			notFoundCounter := runnerDiedIdleTotal.WithLabelValues("default", "host-a", runnerDeadReasonNotFound)
			beforeNotRunning := testutil.ToFloat64(notRunningCounter)
			beforeNotFound := testutil.ToFloat64(notFoundCounter)

			scaler.pruneDeadIdleRunners(context.Background())

			_, stillIdle := scaler.runners.idle["runner-1"]
			switch {
			case c.wantPruned && stillIdle:
				t.Errorf("expected runner-1 to be pruned, but it is still tracked idle")
			case !c.wantPruned && !stillIdle:
				t.Errorf("expected runner-1 to remain tracked idle, but it was pruned")
			}

			gotNotRunning := testutil.ToFloat64(notRunningCounter) - beforeNotRunning
			gotNotFound := testutil.ToFloat64(notFoundCounter) - beforeNotFound
			wantNotRunning, wantNotFound := 0.0, 0.0
			switch c.wantReason {
			case runnerDeadReasonNotRunning:
				wantNotRunning = 1
			case runnerDeadReasonNotFound:
				wantNotFound = 1
			}
			if gotNotRunning != wantNotRunning {
				t.Errorf("runner_died_idle_total{reason=%q} rose by %v, want %v", runnerDeadReasonNotRunning, gotNotRunning, wantNotRunning)
			}
			if gotNotFound != wantNotFound {
				t.Errorf("runner_died_idle_total{reason=%q} rose by %v, want %v", runnerDeadReasonNotFound, gotNotFound, wantNotFound)
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

func TestEndDrainClearsMetricsAndIsIdempotent(t *testing.T) {
	scaler := &Scaler{
		scaleSetName: "watchdog-stuck",
		runners:      runnerState{idle: map[string]runnerRef{}, busy: map[string]runnerRef{}},
		logger:       slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	scaler.draining.Store(true)
	drainingGauge.WithLabelValues("watchdog-stuck").Set(1)
	cleared := testutil.ToFloat64(drainAutoClearedTotal.WithLabelValues("watchdog-stuck"))

	scaler.EndDrain()
	if scaler.draining.Load() {
		t.Fatal("EndDrain did not clear the draining flag")
	}
	if got := testutil.ToFloat64(drainingGauge.WithLabelValues("watchdog-stuck")); got != 0 {
		t.Errorf("drainingGauge = %v, want 0 after EndDrain", got)
	}
	if got := testutil.ToFloat64(drainAutoClearedTotal.WithLabelValues("watchdog-stuck")) - cleared; got != 1 {
		t.Errorf("drainAutoClearedTotal delta = %v, want 1", got)
	}

	// Calling again while already clear must not double-count the metric.
	scaler.EndDrain()
	if got := testutil.ToFloat64(drainAutoClearedTotal.WithLabelValues("watchdog-stuck")) - cleared; got != 1 {
		t.Errorf("drainAutoClearedTotal delta after a second EndDrain = %v, want still 1 (idempotent)", got)
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
		// laforge gets a nonzero-but-healthy load, just to differentiate it
		// from janeway's "0" -- this test is about host-limit filtering, not
		// load-based tie-breaking, so the value only needs to stay well
		// under loadHard (agent-lcars#259 made a hard-overloaded host
		// ineligible outright, and 32/16=2.0 used to cross that threshold
		// here incidentally).
		load := "0"
		if strings.Contains(r.URL.Path, "laforge") {
			load = "4"
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

// TestPickHostSharedWorkDirExhaustionCountsPlacementBlocked pins
// agent-lcars#210: the shared-workdir exclusivity branch used to return
// errFleetAtCapacity without touching placement_blocked_total, so a real
// placement-capacity cause was invisible to Prometheus. The homelab
// controller saw 25 such blocks in 24h for homelab-autoscale-e2e -- with
// every host reachable and under its runner limit -- and the only signal
// was an error log line.
func TestPickHostSharedWorkDirExhaustionCountsPlacementBlocked(t *testing.T) {
	fake := newFakeDockerServer(t)

	scaler := &Scaler{
		scaleSetName: "e2e",
		shareWorkDir: true,
		dockerHosts:  []DockerHost{{Name: "a", Client: fake.client(t)}},
		runners: runnerState{
			idle: map[string]runnerRef{"runner-1": {host: "a", containerID: "c1"}},
			busy: make(map[string]runnerRef),
		},
		logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	}

	// Counters are process-global and other tests share them, so measure the
	// delta this call produces rather than an absolute value.
	blocked := placementBlocked.WithLabelValues("e2e", placementReasonSharedWorkDirExclusive)
	hostLimits := placementBlocked.WithLabelValues("e2e", placementReasonHostLimits)
	beforeBlocked := testutil.ToFloat64(blocked)
	beforeHostLimits := testutil.ToFloat64(hostLimits)

	if _, err := scaler.pickHost(context.Background()); !errors.Is(err, errFleetAtCapacity) {
		t.Fatalf("pickHost error = %v, want one wrapping errFleetAtCapacity", err)
	}

	if got := testutil.ToFloat64(blocked) - beforeBlocked; got != 1 {
		t.Errorf("placement_blocked_total{reason=%q} rose by %v, want 1", placementReasonSharedWorkDirExclusive, got)
	}
	// The whole point of a dedicated reason is that this cause is
	// distinguishable, so it must not also land on a coarser one.
	if got := testutil.ToFloat64(hostLimits) - beforeHostLimits; got != 0 {
		t.Errorf("placement_blocked_total{reason=%q} rose by %v, want 0", placementReasonHostLimits, got)
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

// TestCreateContainerRecoversImageEvictedAfterInspect reproduces #478 at the
// Docker API boundary: image preparation/inspection succeeded, an external
// prune removed the image before ContainerCreate, and the daemon returned
// 404. The create boundary must re-prepare once and retry instead of leaving
// every periodic sweep to rediscover the same race.
func TestCreateContainerRecoversImageEvictedAfterInspect(t *testing.T) {
	fake := newFakeDockerServer(t)
	fake.mu.Lock()
	fake.imagePresent = true
	fake.mu.Unlock()
	fake.setCreateFailures(http.StatusNotFound)
	scaler := &Scaler{
		runnerImage: "registry.example/runner@sha256:" + strings.Repeat("a", 64),
		logger:      slog.New(slog.NewTextHandler(io.Discard, nil)),
	}

	created, err := scaler.createContainerWithImageRecovery(
		context.Background(),
		fake.client(t),
		"spark",
		&container.Config{Image: scaler.runnerImage},
		&container.HostConfig{},
		"",
	)
	if err != nil {
		t.Fatalf("createContainerWithImageRecovery: %v", err)
	}
	if created.ID != "created-container" {
		t.Fatalf("created container ID = %q, want created-container", created.ID)
	}
	if got := fake.createCount(); got != 2 {
		t.Fatalf("container creates = %d, want initial miss plus one retry", got)
	}
	if got := fake.pullCount(); got != 1 {
		t.Fatalf("image pulls = %d, want one recovery pull", got)
	}
}

func TestCreateContainerDoesNotRetryUnrelatedFailure(t *testing.T) {
	fake := newFakeDockerServer(t)
	fake.setCreateFailures(http.StatusInternalServerError)
	scaler := &Scaler{
		runnerImage: "registry.example/runner:test",
		logger:      slog.New(slog.NewTextHandler(io.Discard, nil)),
	}

	_, err := scaler.createContainerWithImageRecovery(
		context.Background(),
		fake.client(t),
		"spark",
		&container.Config{Image: scaler.runnerImage},
		&container.HostConfig{},
		"",
	)
	if err == nil {
		t.Fatal("an unrelated daemon failure must stay visible")
	}
	if got := fake.createCount(); got != 1 {
		t.Fatalf("container creates = %d, want no retry for non-not-found", got)
	}
	if got := fake.pullCount(); got != 0 {
		t.Fatalf("image pulls = %d, want no image recovery for unrelated failure", got)
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

// readinessScaler builds a two-host scaler where only "roamer" is gated on
// the readiness signal served by the given handler. "anchor" is always
// eligible, so a test can tell "the gate withheld roamer" apart from "nothing
// was placeable at all".
func readinessScaler(t *testing.T, metricName string, maxAge time.Duration, handler http.HandlerFunc) *Scaler {
	t.Helper()
	anchorDocker := newFakeDockerServer(t)
	roamerDocker := newFakeDockerServer(t)
	anchorDocker.setContainers([]container.Summary{})
	roamerDocker.setContainers([]container.Summary{})

	metrics := httptest.NewServer(handler)
	t.Cleanup(metrics.Close)

	fleet := newFleetCoordinator(4, nil, nil, nil, map[string]int{"set": 1}, []string{"set"})
	fleet.readinessRequired = map[string]bool{"roamer": true}

	return &Scaler{
		scaleSetName: "set", maxRunners: 4,
		dockerHosts: []DockerHost{
			{Name: "roamer", Client: roamerDocker.client(t)},
			{Name: "anchor", Client: anchorDocker.client(t)},
		},
		readinessMetricsURL: metrics.URL,
		readinessMetric:     metricName,
		readinessMaxAge:     maxAge,
		logger:              slog.New(slog.NewTextHandler(io.Discard, nil)),
		runners:             runnerState{idle: map[string]runnerRef{}, busy: map[string]runnerRef{}},
		fleet:               fleet,
	}
}

func servePlain(body string) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, body)
	}
}

// A gated host is only placeable while the operator's signal says so. The
// ungated peer stays placeable throughout, which is what proves the gate --
// not some unrelated failure -- is what moved the verdict.
func TestPickHostReadinessGateHonorsSignal(t *testing.T) {
	fresh := fmt.Sprintf("host_ci_ready_timestamp_seconds %d\n", time.Now().Unix())

	tests := []struct {
		name string
		body string
		want string
	}{
		{
			name: "ready",
			body: "# HELP host_ci_ready doc\nhost_ci_ready{host=\"roamer\"} 1\n" + fresh,
			want: "roamer",
		},
		{
			name: "not ready",
			body: "host_ci_ready{host=\"roamer\"} 0\n" + fresh,
			want: "anchor",
		},
		{
			// Absent is not "ready by default" -- the gate is fail-closed.
			name: "metric absent",
			body: "some_other_metric 1\n" + fresh,
			want: "anchor",
		},
		{
			// Another host's reading must not answer for this one.
			name: "only a different host is ready",
			body: "host_ci_ready{host=\"somebody_else\"} 1\n" + fresh,
			want: "anchor",
		},
		{
			// A publisher that stopped updating leaves its last reading
			// served forever; honoring it would fail the gate open.
			name: "stale timestamp",
			body: fmt.Sprintf("host_ci_ready{host=\"roamer\"} 1\nhost_ci_ready_timestamp_seconds %d\n", time.Now().Add(-time.Hour).Unix()),
			want: "anchor",
		},
		{
			name: "freshness metric missing entirely",
			body: "host_ci_ready{host=\"roamer\"} 1\n",
			want: "anchor",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			scaler := readinessScaler(t, "host_ci_ready", 5*time.Minute, servePlain(tt.body))
			host, err := scaler.pickHost(context.Background())
			if err != nil {
				t.Fatalf("pickHost() error = %v", err)
			}
			if host != tt.want {
				t.Fatalf("placement host = %q, want %q", host, tt.want)
			}
		})
	}
}

// Without a configured max age the freshness companion is not required, so
// operators who publish through something with its own staleness handling are
// not forced to invent one.
func TestPickHostReadinessGateSkipsFreshnessWhenUnset(t *testing.T) {
	scaler := readinessScaler(t, "host_ci_ready", 0, servePlain("host_ci_ready{host=\"roamer\"} 1\n"))
	host, err := scaler.pickHost(context.Background())
	if err != nil {
		t.Fatalf("pickHost() error = %v", err)
	}
	if host != "roamer" {
		t.Fatalf("placement host = %q, want roamer", host)
	}
}

// A broken publisher must not read as "ready". This is the failure mode the
// gate exists for, so it gets its own coverage rather than riding on the
// absent-metric case.
func TestPickHostReadinessGateFailsClosedOnPublisherErrors(t *testing.T) {
	tests := []struct {
		name  string
		build func(t *testing.T) *Scaler
	}{
		{
			name: "http error status",
			build: func(t *testing.T) *Scaler {
				return readinessScaler(t, "host_ci_ready", 0, func(w http.ResponseWriter, _ *http.Request) {
					w.WriteHeader(http.StatusInternalServerError)
				})
			},
		},
		{
			name: "endpoint unreachable",
			build: func(t *testing.T) *Scaler {
				s := readinessScaler(t, "host_ci_ready", 0, servePlain(""))
				s.readinessMetricsURL = "http://127.0.0.1:1/metrics"
				return s
			},
		},
		{
			// Gate requested but never configured: refuse rather than
			// quietly placing as though it had been satisfied.
			name: "gate unconfigured",
			build: func(t *testing.T) *Scaler {
				s := readinessScaler(t, "host_ci_ready", 0, servePlain(""))
				s.readinessMetricsURL, s.readinessMetric = "", ""
				return s
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			scaler := tt.build(t)
			host, err := scaler.pickHost(context.Background())
			if err != nil {
				t.Fatalf("pickHost() error = %v", err)
			}
			if host != "anchor" {
				t.Fatalf("placement host = %q, want anchor; a broken readiness publisher must not read as ready", host)
			}
		})
	}
}

// Exhausting the fleet through the gate must not be reported as a network
// problem: these hosts answered fine, the operator's signal withheld them.
func TestPickHostReadinessExhaustionReportsItsOwnReason(t *testing.T) {
	scaler := readinessScaler(t, "host_ci_ready", 0, servePlain("host_ci_ready{host=\"roamer\"} 0\n"))
	// Drop the ungated peer so the gate is the only thing left deciding.
	scaler.dockerHosts = scaler.dockerHosts[:1]

	blocked := placementBlocked.WithLabelValues("set", placementReasonReadiness)
	before := testutil.ToFloat64(blocked)

	_, err := scaler.pickHost(context.Background())
	if !errors.Is(err, errFleetAtCapacity) {
		t.Fatalf("pickHost() error = %v, want one wrapping errFleetAtCapacity", err)
	}
	if strings.Contains(err.Error(), "unreachable") {
		t.Errorf("a host withheld by its readiness gate must not be reported as unreachable, got: %v", err)
	}
	if !strings.Contains(err.Error(), "readiness") {
		t.Errorf("error should name the readiness gate, got: %v", err)
	}
	if got := testutil.ToFloat64(blocked) - before; got != 1 {
		t.Errorf("placement_blocked_total{reason=%q} rose by %v, want 1", placementReasonReadiness, got)
	}
}

// Hosts that never opted in must be unaffected, including by a totally broken
// readiness publisher.
func TestPickHostReadinessGateIgnoresUngatedHosts(t *testing.T) {
	scaler := readinessScaler(t, "host_ci_ready", 5*time.Minute, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	})
	scaler.fleet.readinessRequired = map[string]bool{}

	host, err := scaler.pickHost(context.Background())
	if err != nil {
		t.Fatalf("pickHost() error = %v", err)
	}
	if host != "roamer" && host != "anchor" {
		t.Fatalf("placement host = %q, want either host", host)
	}
}

// A label key that merely ends in "host" must not answer for "host". The
// substring form of this check (`host="roamer"` is contained in
// `target_host="roamer"`) let a mislabelled signal make a gated host
// placeable -- the fail-OPEN direction, which is the one that matters.
func TestPickHostReadinessGateRequiresExactHostLabel(t *testing.T) {
	tests := []struct {
		name string
		body string
		want string
	}{
		{
			name: "label key merely ends in host",
			body: "host_ci_ready{target_host=\"roamer\"} 1\n",
			want: "anchor",
		},
		{
			name: "no labels at all",
			body: "host_ci_ready 1\n",
			want: "anchor",
		},
		{
			name: "exact host label among several",
			body: "host_ci_ready{target_host=\"elsewhere\",host=\"roamer\",region=\"a\"} 1\n",
			want: "roamer",
		},
		{
			// A label value may legitimately contain a comma, so pair
			// splitting has to respect quoting.
			name: "comma inside a quoted label value",
			body: "host_ci_ready{note=\"a,b\",host=\"roamer\"} 1\n",
			want: "roamer",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			scaler := readinessScaler(t, "host_ci_ready", 0, servePlain(tt.body))
			host, err := scaler.pickHost(context.Background())
			if err != nil {
				t.Fatalf("pickHost() error = %v", err)
			}
			if host != tt.want {
				t.Fatalf("placement host = %q, want %q", host, tt.want)
			}
		})
	}
}

// time.Since goes negative for a future timestamp, so the staleness test can
// never fire and a publisher that later dies stays "fresh" until the local
// clock catches up. Emitting milliseconds where seconds are expected lands
// ~55000 years ahead and would disable the gate outright.
func TestPickHostReadinessGateRejectsFutureTimestamps(t *testing.T) {
	tests := []struct {
		name  string
		stamp int64
		want  string
	}{
		{
			name:  "milliseconds mistaken for seconds",
			stamp: time.Now().UnixMilli(),
			want:  "anchor",
		},
		{
			name:  "far future",
			stamp: time.Now().Add(24 * time.Hour).Unix(),
			want:  "anchor",
		},
		{
			// Ordinary NTP drift between publisher and reader must not
			// start withholding hosts.
			name:  "benign clock skew is tolerated",
			stamp: time.Now().Add(30 * time.Second).Unix(),
			want:  "roamer",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			body := fmt.Sprintf("host_ci_ready{host=\"roamer\"} 1\nhost_ci_ready_timestamp_seconds %d\n", tt.stamp)
			scaler := readinessScaler(t, "host_ci_ready", 5*time.Minute, servePlain(body))
			host, err := scaler.pickHost(context.Background())
			if err != nil {
				t.Fatalf("pickHost() error = %v", err)
			}
			if host != tt.want {
				t.Fatalf("placement host = %q, want %q", host, tt.want)
			}
		})
	}
}

func TestMetricLabelValue(t *testing.T) {
	tests := []struct {
		name      string
		line      string
		label     string
		want      string
		wantFound bool
	}{
		{name: "simple", line: `m{host="a"} 1`, label: "host", want: "a", wantFound: true},
		{name: "suffix key is not a match", line: `m{target_host="a"} 1`, label: "host", wantFound: false},
		{name: "prefix key is not a match", line: `m{host_extra="a"} 1`, label: "host", wantFound: false},
		{name: "second of several", line: `m{a="1",host="b"} 1`, label: "host", want: "b", wantFound: true},
		{name: "comma in value", line: `m{a="x,y",host="b"} 1`, label: "host", want: "b", wantFound: true},
		{name: "escaped quote in value", line: `m{a="x\"y",host="b"} 1`, label: "host", want: "b", wantFound: true},
		{name: "no labels", line: `m 1`, label: "host", wantFound: false},
		{name: "empty label set", line: `m{} 1`, label: "host", wantFound: false},
		{name: "spaces around key", line: `m{ host = "a" } 1`, label: "host", want: "a", wantFound: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, found := metricLabelValue(tt.line, tt.label)
			if found != tt.wantFound {
				t.Fatalf("metricLabelValue(%q) found = %v, want %v", tt.line, found, tt.wantFound)
			}
			if found && got != tt.want {
				t.Fatalf("metricLabelValue(%q) = %q, want %q", tt.line, got, tt.want)
			}
		})
	}
}

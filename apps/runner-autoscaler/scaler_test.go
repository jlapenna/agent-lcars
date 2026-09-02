package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"github.com/prometheus/client_golang/prometheus"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"runtime"
	"slices"
	"strconv"
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
		"homelab-autoscale-agent-runner": "homelab-autoscale-agent-runner",
		"already.safe_name-123":          "already.safe_name-123",
		"has spaces":                     "has-spaces",
		"slash/and:colon":                "slash-and-colon",
	}
	for in, want := range cases {
		if got := dockerSafeNamePart(in); got != want {
			t.Errorf("dockerSafeNamePart(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestRunnerEnvironmentIncludesPhysicalHost(t *testing.T) {
	want := []string{
		"ACTIONS_RUNNER_INPUT_JITCONFIG=opaque-jit-config",
		"AGENT_LCARS_RUNNER_HOST=laforge",
	}
	if got := runnerEnvironment("opaque-jit-config", "laforge"); !slices.Equal(got, want) {
		t.Fatalf("runnerEnvironment() = %q, want %q", got, want)
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

func TestHostMetricsUsesPerHostTimeout(t *testing.T) {
	metrics := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-r.Context().Done()
	}))
	defer metrics.Close()

	scaler := &Scaler{
		hostMetricsURLTemplate: metrics.URL + "/%s/metrics",
		hostMetricsTimeouts:    map[string]time.Duration{"pike": 50 * time.Millisecond},
	}
	started := time.Now()
	_, err := scaler.hostMetrics(context.Background(), "pike")
	if err == nil {
		t.Fatal("hostMetrics() unexpectedly succeeded")
	}
	if elapsed := time.Since(started); elapsed > 500*time.Millisecond {
		t.Fatalf("hostMetrics() took %v, want configured timeout to stop it promptly", elapsed)
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

	blocked := placementBlocked.WithLabelValues("set", "pike", placementReasonOverload)
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

	pikeBlocked := placementBlocked.WithLabelValues("set", "pike", placementReasonOverload)
	laforgeBlocked := placementBlocked.WithLabelValues("set", "laforge", placementReasonOverload)
	hostLimits := placementBlocked.WithLabelValues("set", "", placementReasonHostLimits)
	beforePike := testutil.ToFloat64(pikeBlocked)
	beforeLaforge := testutil.ToFloat64(laforgeBlocked)
	beforeHostLimits := testutil.ToFloat64(hostLimits)

	host, err := scaler.pickHost(context.Background())
	if host != "" || !errors.Is(err, errFleetAtCapacity) {
		t.Fatalf("pickHost() = (%q, %v), want (\"\", errFleetAtCapacity)", host, err)
	}
	// Each overloaded host records its own refusal by name -- this is a
	// per-host reason, not a fleet-wide one.
	if got := testutil.ToFloat64(pikeBlocked) - beforePike; got != 1 {
		t.Errorf("placement_blocked_total{host=%q,reason=%q} rose by %v, want 1", "pike", placementReasonOverload, got)
	}
	if got := testutil.ToFloat64(laforgeBlocked) - beforeLaforge; got != 1 {
		t.Errorf("placement_blocked_total{host=%q,reason=%q} rose by %v, want 1", "laforge", placementReasonOverload, got)
	}
	// A saturation cause distinct from host_limits: without its own reason,
	// this looks identical in Prometheus to hosts merely being busy with
	// other work, not pressured.
	if got := testutil.ToFloat64(hostLimits) - beforeHostLimits; got != 0 {
		t.Errorf("placement_blocked_total{reason=%q} rose by %v, want 0", placementReasonHostLimits, got)
	}
}

const gibibyte = int64(1024 * 1024 * 1024)

func memoryBoundScaler(t *testing.T, name string, memoryTotal, candidateMemory int64, containers []container.Summary) *Scaler {
	t.Helper()
	fake := newFakeDockerServer(t)
	fake.setMemoryTotal(memoryTotal)
	fake.setContainers(containers)
	return &Scaler{
		scaleSetName: name,
		runnerMemory: candidateMemory,
		dockerHosts:  []DockerHost{{Name: "janeway", Client: fake.client(t)}},
		runners:      runnerState{idle: map[string]runnerRef{}, busy: map[string]runnerRef{}},
		logger:       slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
}

func reservedRunner(id string, memory int64) container.Summary {
	return container.Summary{
		ID: id,
		Labels: map[string]string{
			runnerScaleSetLabelKey: "e2e",
			runnerMemoryLabelKey:   strconv.FormatInt(memory, 10),
		},
	}
}

// Janeway's 16 GiB physical-memory case is the regression that exposed this
// missing admission dimension: runner_limit=2 alone must not admit two 12 GiB
// E2E reservations while also preserving a host safety margin.
func TestPickHostRejectsSecondTwelveGiBReservationOnSixteenGiBHost(t *testing.T) {
	scaler := memoryBoundScaler(t, "e2e", 16*gibibyte, 12*gibibyte, []container.Summary{reservedRunner("first", 12*gibibyte)})
	blocked := placementBlocked.WithLabelValues("e2e", "janeway", placementReasonMemoryReservation)
	before := testutil.ToFloat64(blocked)

	host, err := scaler.pickHost(context.Background())
	if host != "" || !errors.Is(err, errFleetAtCapacity) {
		t.Fatalf("pickHost() = (%q, %v), want memory-capacity failure", host, err)
	}
	for _, detail := range []string{"reserved=12884901888", "candidate=12884901888", "physical=17179869184"} {
		if !strings.Contains(err.Error(), detail) {
			t.Errorf("error %q missing useful detail %q", err, detail)
		}
	}
	if got := testutil.ToFloat64(blocked) - before; got != 1 {
		t.Fatalf("placement_blocked_total{reason=%q} rose by %v, want 1", placementReasonMemoryReservation, got)
	}
}

func TestPickHostMixedSizeRunnerUsesSafeRemainingCapacity(t *testing.T) {
	scaler := memoryBoundScaler(t, "small", 16*gibibyte, 2*gibibyte, []container.Summary{reservedRunner("e2e", 12*gibibyte)})

	host, err := scaler.pickHost(context.Background())
	if err != nil {
		t.Fatalf("pickHost() error = %v", err)
	}
	if host != "janeway" {
		t.Fatalf("pickHost() = %q, want janeway: 12 GiB + 2 GiB fits its 90%% reservation budget", host)
	}
}

func TestPickHostIncludesInFlightMemoryReservations(t *testing.T) {
	scaler := memoryBoundScaler(t, "candidate", 16*gibibyte, 4*gibibyte, nil)
	fleet := scaler.coordinator()
	fleet.reservedMemory["janeway"] = 12 * gibibyte

	host, err := scaler.pickHost(context.Background())
	if host != "" || !errors.Is(err, errFleetAtCapacity) {
		t.Fatalf("pickHost() = (%q, %v), want in-flight memory reservation to block placement", host, err)
	}
	if !strings.Contains(err.Error(), "reserved=12884901888") {
		t.Fatalf("error %q does not report in-flight reservation", err)
	}
}

func TestPickHostHonorsConfiguredMemorySafetyMargin(t *testing.T) {
	scaler := memoryBoundScaler(t, "small", 16*gibibyte, 2*gibibyte, []container.Summary{reservedRunner("e2e", 12*gibibyte)})
	scaler.memorySafetyMargin = 0.25

	if host, err := scaler.pickHost(context.Background()); host != "" || !errors.Is(err, errFleetAtCapacity) {
		t.Fatalf("pickHost() with 25%% margin = (%q, %v), want capacity failure", host, err)
	}
}

// usageSampler builds a memoryUsageSampler that returns a canned usage value
// per container ID, without touching Docker at all -- the injection point
// agent-lcars#1694 added specifically so these tests never need a fake
// /stats endpoint.
func usageSampler(usage map[string]int64) func(context.Context, *dockerclient.Client, string) (int64, error) {
	return func(_ context.Context, _ *dockerclient.Client, containerID string) (int64, error) {
		bytes, ok := usage[containerID]
		if !ok {
			return 0, fmt.Errorf("no canned usage for container %q", containerID)
		}
		return bytes, nil
	}
}

// TestPickHostChargesObservedUsageOverReservation pins agent-lcars#1694's
// first admission rule: a runner sampled OVER its declared reservation is
// charged for what it is actually using, not the smaller declared figure.
// 16 GiB * 0.9 default margin = 14.4 GiB budget. The running runner declared
// only 4 GiB but is observed using 10 GiB; a 5 GiB candidate fits the
// declared-only arithmetic (4+5=9 <= 14.4) but must be refused once charged
// at its observed usage (10+5=15 > 14.4).
func TestPickHostChargesObservedUsageOverReservation(t *testing.T) {
	scaler := memoryBoundScaler(t, "e2e", 16*gibibyte, 5*gibibyte, []container.Summary{reservedRunner("over", 4*gibibyte)})
	scaler.memoryUsageSampler = usageSampler(map[string]int64{"over": 10 * gibibyte})

	host, err := scaler.pickHost(context.Background())
	if host != "" || !errors.Is(err, errFleetAtCapacity) {
		t.Fatalf("pickHost() = (%q, %v), want capacity failure: observed usage (10 GiB) must be charged over the 4 GiB declared reservation", host, err)
	}
	if !strings.Contains(err.Error(), "reserved=10737418240") {
		t.Fatalf("error %q does not charge the observed 10 GiB usage", err)
	}
	if got := testutil.ToFloat64(hostMemoryObservedGauge.WithLabelValues("janeway")); got != float64(10*gibibyte) {
		t.Errorf("host_memory_observed_bytes = %v, want 10 GiB", got)
	}
}

// TestPickHostChargesReservationWhenUnderObservedUsage pins agent-lcars#1694's
// second admission rule: a runner sampled UNDER its declared reservation is
// still charged at the (larger) declared reservation, not its smaller
// observed usage -- otherwise a low sample would let placement erode the
// exact safety margin runner_memory_reservation exists to hold. The running
// runner declared 12 GiB but is observed using only 1 GiB; a 3 GiB candidate
// would fit if charged at observed usage (1+3=4 <= 14.4 GiB budget) but must
// still be refused when charged at the 12 GiB reservation (12+3=15 > 14.4).
func TestPickHostChargesReservationWhenUnderObservedUsage(t *testing.T) {
	scaler := memoryBoundScaler(t, "e2e", 16*gibibyte, 3*gibibyte, []container.Summary{reservedRunner("under", 12*gibibyte)})
	scaler.memoryUsageSampler = usageSampler(map[string]int64{"under": 1 * gibibyte})

	host, err := scaler.pickHost(context.Background())
	if host != "" || !errors.Is(err, errFleetAtCapacity) {
		t.Fatalf("pickHost() = (%q, %v), want capacity failure: under-reservation usage must still charge the declared 12 GiB", host, err)
	}
	if !strings.Contains(err.Error(), "reserved=12884901888") {
		t.Fatalf("error %q does not charge the declared 12 GiB reservation", err)
	}
	if got := testutil.ToFloat64(hostMemoryObservedGauge.WithLabelValues("janeway")); got != float64(1*gibibyte) {
		t.Errorf("host_memory_observed_bytes = %v, want the observed 1 GiB (purely observational, unlike the charged reservation)", got)
	}
}

// TestPickHostFallsBackToReservationOnStatsFailure pins agent-lcars#1694's
// fallback rule: when the usage sample errors (short timeout, transient
// daemon error), admission charges the declared reservation exactly as it
// did before usage-aware charging existed, instead of charging zero or
// refusing outright.
func TestPickHostFallsBackToReservationOnStatsFailure(t *testing.T) {
	scaler := memoryBoundScaler(t, "e2e", 16*gibibyte, 2*gibibyte, []container.Summary{reservedRunner("first", 12*gibibyte)})
	scaler.memoryUsageSampler = func(context.Context, *dockerclient.Client, string) (int64, error) {
		return 0, fmt.Errorf("stats request timed out")
	}

	// 12 GiB declared + 2 GiB candidate = 14 GiB <= 14.4 GiB budget: fits at
	// the declared reservation.
	host, err := scaler.pickHost(context.Background())
	if err != nil {
		t.Fatalf("pickHost() error = %v, want the declared reservation to admit the candidate", err)
	}
	if host != "janeway" {
		t.Fatalf("pickHost() = %q, want janeway", host)
	}
	if got := testutil.ToFloat64(hostMemoryReservedGauge.WithLabelValues("janeway")); got != float64(12*gibibyte) {
		t.Errorf("host_memory_reserved_bytes = %v, want the declared 12 GiB (usage sample failed)", got)
	}
	if got := testutil.ToFloat64(hostMemoryObservedGauge.WithLabelValues("janeway")); got != float64(12*gibibyte) {
		t.Errorf("host_memory_observed_bytes = %v, want the declared 12 GiB fallback (usage sample failed)", got)
	}
}

// TestPickHostOvercommitAdmitsWhenHostUnpressured pins agent-lcars#1694's
// bounded-overcommit rule: 16 GiB * 0.9 margin = 14.4 GiB budget. A running
// 12 GiB reservation plus a 4 GiB candidate (16 GiB) exceeds that budget at
// the default 1.0 factor, but fits comfortably under a configured 1.25
// factor (18 GiB) once the host's latest load sample shows it unpressured.
func TestPickHostOvercommitAdmitsWhenHostUnpressured(t *testing.T) {
	scaler := memoryBoundScaler(t, "e2e", 16*gibibyte, 4*gibibyte, []container.Summary{reservedRunner("first", 12*gibibyte)})

	if host, err := scaler.pickHost(context.Background()); host != "" || !errors.Is(err, errFleetAtCapacity) {
		t.Fatalf("pickHost() without overcommit = (%q, %v), want capacity failure", host, err)
	}

	scaler.hostMemoryOvercommit = map[string]float64{"janeway": 1.25}
	fleet := scaler.coordinator()
	seedHostLoad(fleet, "janeway", hostLoad{memoryAvailable: 0.5, memoryPressure: 0.01})

	host, err := scaler.pickHost(context.Background())
	if err != nil {
		t.Fatalf("pickHost() with 1.25 overcommit on an unpressured host, error = %v", err)
	}
	if host != "janeway" {
		t.Fatalf("pickHost() = %q, want janeway", host)
	}
	if got := testutil.ToFloat64(hostMemoryOvercommitEffectiveGauge.WithLabelValues("janeway")); got != 1.25 {
		t.Errorf("host_memory_overcommit_effective = %v, want 1.25", got)
	}
	wantBudget := float64(int64(float64(16*gibibyte) * 0.9 * 1.25))
	if got := testutil.ToFloat64(hostMemoryBudgetGauge.WithLabelValues("janeway")); got != wantBudget {
		t.Errorf("host_memory_budget_bytes = %v, want %v (16 GiB * 0.9 margin * 1.25 overcommit)", got, wantBudget)
	}
}

// TestPickHostOvercommitWithdrawnUnderSoftPressure pins agent-lcars#1694's
// pressure gate: the same configured 1.25 factor that admits a candidate on
// an unpressured host (TestPickHostOvercommitAdmitsWhenHostUnpressured) must
// be withdrawn (falling back to 1.0) once the host's latest sample crosses
// EITHER soft threshold -- available memory at or below memory_soft, or
// memory PSI at or above psi_soft -- even though neither alone crosses the
// HARD threshold that would exclude the host outright.
func TestPickHostOvercommitWithdrawnUnderSoftPressure(t *testing.T) {
	tests := map[string]hostLoad{
		"low available memory": {memoryAvailable: 0.10, memoryPressure: 0.01}, // <= memory_soft (0.15), > memory_hard (0.08)
		"high memory PSI":      {memoryAvailable: 0.5, memoryPressure: 0.10},  // >= psi_soft (0.10), < psi_hard (0.25)
	}
	for name, load := range tests {
		t.Run(name, func(t *testing.T) {
			scaler := memoryBoundScaler(t, "e2e", 16*gibibyte, 4*gibibyte, []container.Summary{reservedRunner("first", 12*gibibyte)})
			scaler.hostMemoryOvercommit = map[string]float64{"janeway": 1.25}
			seedHostLoad(scaler.coordinator(), "janeway", load)

			host, err := scaler.pickHost(context.Background())
			if host != "" || !errors.Is(err, errFleetAtCapacity) {
				t.Fatalf("pickHost() on a soft-pressured host = (%q, %v), want capacity failure: overcommit must be withdrawn", host, err)
			}
			if got := testutil.ToFloat64(hostMemoryOvercommitEffectiveGauge.WithLabelValues("janeway")); got != 1.0 {
				t.Errorf("host_memory_overcommit_effective = %v, want 1.0 (withdrawn under soft pressure)", got)
			}
		})
	}
}

// TestLaneAdmissibleSlotsMatchesHandComputation pins agent-lcars#1695's
// acceptance criterion: the gauge must match a hand computation on the test
// fleet fixture. 32 GiB * 0.9 default safety margin = 28.8 GiB budget, minus
// the 8 GiB already reserved by the running container = 20.8 GiB, divided by
// the 8 GiB lane reservation = 2.6, floored to 2.
func TestLaneAdmissibleSlotsMatchesHandComputation(t *testing.T) {
	scaler := memoryBoundScaler(t, "e2e", 32*gibibyte, 8*gibibyte, []container.Summary{reservedRunner("first", 8*gibibyte)})
	if _, err := scaler.pickHost(context.Background()); err != nil {
		t.Fatalf("pickHost() error = %v", err)
	}
	if got := testutil.ToFloat64(laneAdmissibleSlotsGauge.WithLabelValues("e2e")); got != 2 {
		t.Fatalf("lane_admissible_slots = %v, want 2", got)
	}
}

// A runner_limit of 2 with one already running leaves only 1 slot of
// runner_limit headroom, which must cap the 2 memory-derived slots down to 1
// -- the gauge is a floor over both dimensions, not memory alone.
func TestLaneAdmissibleSlotsCapsAtRunnerLimitHeadroom(t *testing.T) {
	scaler := memoryBoundScaler(t, "e2e", 32*gibibyte, 8*gibibyte, []container.Summary{reservedRunner("first", 8*gibibyte)})
	scaler.hostRunnerLimits = map[string]int{"janeway": 2}
	if _, err := scaler.pickHost(context.Background()); err != nil {
		t.Fatalf("pickHost() error = %v", err)
	}
	if got := testutil.ToFloat64(laneAdmissibleSlotsGauge.WithLabelValues("e2e")); got != 1 {
		t.Fatalf("lane_admissible_slots = %v, want 1 (2 memory-derived slots capped by 1 remaining runner_limit headroom)", got)
	}
}

// A hard-overloaded host contributes zero regardless of how much memory or
// runner_limit headroom it would otherwise have -- reusing the fixture that
// produced 2 in TestLaneAdmissibleSlotsMatchesHandComputation isolates
// overload as the only thing that changed.
func TestLaneAdmissibleSlotsZeroWhenHardOverloaded(t *testing.T) {
	scaler := memoryBoundScaler(t, "e2e", 32*gibibyte, 8*gibibyte, []container.Summary{reservedRunner("first", 8*gibibyte)})
	fleet := scaler.coordinator()
	seedHostLoad(fleet, "janeway", hardOverloadedLoad(scaler, "janeway", hostLoad{memoryAvailable: 1, normalizedLoad: 2}))

	if _, err := scaler.pickHost(context.Background()); !errors.Is(err, errFleetAtCapacity) {
		t.Fatalf("pickHost() error = %v, want errFleetAtCapacity", err)
	}
	if got := testutil.ToFloat64(laneAdmissibleSlotsGauge.WithLabelValues("e2e")); got != 0 {
		t.Fatalf("lane_admissible_slots = %v, want 0 when the only host is hard-overloaded", got)
	}
}

// TestLaneAdmissibleSlotsUsesObservedChargingAndOvercommit pins agent-lcars#1694's
// requirement that lane_admissible_slots and pickHostLocked's own admission
// decision can never disagree: both must derive from the same effective
// budget (safety margin times the effective overcommit factor) and the same
// usage-aware charge (max(declared, observed) per running runner).
//
// 32 GiB * 0.9 default margin * 1.25 overcommit (host unpressured) = 36 GiB
// budget. The one running runner declared only 8 GiB but is observed using
// 16 GiB, so admission charges 16 GiB, not 8. (36 - 16) / 8 GiB lane
// reservation = 2.5, floored to 2.
func TestLaneAdmissibleSlotsUsesObservedChargingAndOvercommit(t *testing.T) {
	scaler := memoryBoundScaler(t, "e2e", 32*gibibyte, 8*gibibyte, []container.Summary{reservedRunner("first", 8*gibibyte)})
	scaler.memoryUsageSampler = usageSampler(map[string]int64{"first": 16 * gibibyte})
	scaler.hostMemoryOvercommit = map[string]float64{"janeway": 1.25}
	seedHostLoad(scaler.coordinator(), "janeway", hostLoad{memoryAvailable: 0.5, memoryPressure: 0.01})

	if _, err := scaler.pickHost(context.Background()); err != nil {
		t.Fatalf("pickHost() error = %v", err)
	}
	if got := testutil.ToFloat64(laneAdmissibleSlotsGauge.WithLabelValues("e2e")); got != 2 {
		t.Fatalf("lane_admissible_slots = %v, want 2 (the same effective budget and observed charging pickHostLocked's own admission used)", got)
	}
}

// refreshAdmissibleSlots is the "nothing is pending" path: it must publish a
// correct, fresh value on its own, without pickHost ever being called.
func TestRefreshAdmissibleSlotsWithoutPlacementAttempt(t *testing.T) {
	scaler := memoryBoundScaler(t, "solo", 32*gibibyte, 8*gibibyte, nil)
	scaler.refreshAdmissibleSlots(context.Background())
	// 32 GiB * 0.9 = 28.8 GiB budget, nothing reserved, divided by 8 GiB = 3.6,
	// floored to 3.
	if got := testutil.ToFloat64(laneAdmissibleSlotsGauge.WithLabelValues("solo")); got != 3 {
		t.Fatalf("lane_admissible_slots after refreshAdmissibleSlots() = %v, want 3", got)
	}
}

// twoHostUnboundedScaler builds a Scaler with one docker host per limits
// entry and no runner_memory ceiling, so laneAdmissibleSlotsOverHosts' headroom-only
// path (a.runnerMemory <= 0) is exercised: each host's contribution is
// exactly its configured runner_limit headroom, with no memory arithmetic to
// entangle a multi-role fixture in.
func twoHostUnboundedScaler(t *testing.T, name string, limits map[string]int) *Scaler {
	t.Helper()
	var hosts []DockerHost
	for hostName := range limits {
		fake := newFakeDockerServer(t)
		hosts = append(hosts, DockerHost{Name: hostName, Client: fake.client(t)})
	}
	return &Scaler{
		scaleSetName:     name,
		dockerHosts:      hosts,
		hostRunnerLimits: limits,
		runners:          runnerState{idle: map[string]runnerRef{}, busy: map[string]runnerRef{}},
		logger:           slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
}

// TestLanePermanentAdmissibleSlotsCountsOnlyPermanentHosts pins
// agent-lcars#1696's acceptance criterion: a lane with 2 slots of headroom
// on a permanent host and 3 on an opportunistic host must report 5 on the
// fleet-wide gauge (both roles place runners) but only 2 on the
// permanent-only gauge -- the fleet invariant an alert reads, which must stay
// truthful when the opportunistic host disappears.
func TestLanePermanentAdmissibleSlotsCountsOnlyPermanentHosts(t *testing.T) {
	scaler := twoHostUnboundedScaler(t, "e2e", map[string]int{"perm1": 2, "opp1": 3})
	fleet := scaler.coordinator()
	fleet.hostRoles = map[string]string{"perm1": hostRolePermanent, "opp1": hostRoleOpportunistic}

	scaler.refreshAdmissibleSlots(context.Background())

	if got := testutil.ToFloat64(laneAdmissibleSlotsGauge.WithLabelValues("e2e")); got != 5 {
		t.Fatalf("lane_admissible_slots = %v, want 5 (2 permanent + 3 opportunistic)", got)
	}
	if got := testutil.ToFloat64(lanePermanentAdmissibleSlotsGauge.WithLabelValues("e2e")); got != 2 {
		t.Fatalf("lane_permanent_admissible_slots = %v, want 2 (opportunistic host excluded)", got)
	}
}

// TestLanePermanentAdmissibleSlotsDefaultsUnsetRoleToPermanent pins backward
// compatibility for a Scaler built without ever populating fleet.hostRoles
// (every pre-#1696 unit test, and the single-scaler/local-fleet path): a host
// absent from hostRoles must still count as permanent, not be silently
// dropped from the invariant gauge.
func TestLanePermanentAdmissibleSlotsDefaultsUnsetRoleToPermanent(t *testing.T) {
	scaler := memoryBoundScaler(t, "solo", 32*gibibyte, 8*gibibyte, nil)
	scaler.refreshAdmissibleSlots(context.Background())
	if got := testutil.ToFloat64(lanePermanentAdmissibleSlotsGauge.WithLabelValues("solo")); got != 3 {
		t.Fatalf("lane_permanent_admissible_slots = %v, want 3 (unset role reads as permanent, matching lane_admissible_slots)", got)
	}
}

// TestPickHostSkipsMaintenanceHost pins agent-lcars#1696's placement
// exclusion: a role: maintenance host must never receive a placement, must
// be excluded from both admissible-slots gauges even though it has far more
// runner_limit headroom than the healthy host, and every probe must count it
// under placement_blocked_total{reason="maintenance"} while still reporting
// host_reachable exactly as an ordinary managed host would.
func TestPickHostSkipsMaintenanceHost(t *testing.T) {
	scaler := twoHostUnboundedScaler(t, "e2e", map[string]int{"perm1": 1, "maint1": 5})
	fleet := scaler.coordinator()
	fleet.hostRoles = map[string]string{"perm1": hostRolePermanent, "maint1": hostRoleMaintenance}

	blocked := placementBlocked.WithLabelValues("e2e", "maint1", placementReasonMaintenance)
	before := testutil.ToFloat64(blocked)

	host, err := scaler.pickHost(context.Background())
	if err != nil {
		t.Fatalf("pickHost() error = %v", err)
	}
	if host != "perm1" {
		t.Fatalf("pickHost() = %q, want perm1 (maint1 is under maintenance despite 5x the headroom)", host)
	}
	if got := testutil.ToFloat64(blocked) - before; got != 1 {
		t.Fatalf("placement_blocked_total{host=%q,reason=%q} rose by %v, want 1", "maint1", placementReasonMaintenance, got)
	}
	if got := testutil.ToFloat64(laneAdmissibleSlotsGauge.WithLabelValues("e2e")); got != 1 {
		t.Fatalf("lane_admissible_slots = %v, want 1 (only perm1's headroom; maint1 excluded)", got)
	}
	if got := testutil.ToFloat64(lanePermanentAdmissibleSlotsGauge.WithLabelValues("e2e")); got != 1 {
		t.Fatalf("lane_permanent_admissible_slots = %v, want 1", got)
	}
	if got := testutil.ToFloat64(hostReachableGauge.WithLabelValues("maint1")); got != 1 {
		t.Fatalf("host_reachable{host=%q} = %v, want 1: a maintenance host stays declared and probed", "maint1", got)
	}
}

// placement_blocked_total's host label distinguishes a per-host refusal
// (memory_reservation, readiness, overload -- pinned by the readiness,
// overload, and memory-reservation tests above/below) from a fleet-level one
// like host_limits, where every host individually refused on its own limit
// and no single host is more at fault than another.
func TestPlacementBlockedHostLimitsUsesEmptyHostLabel(t *testing.T) {
	limited := newFakeDockerServer(t)
	limited.setContainers([]container.Summary{{
		ID: "1", Labels: map[string]string{runnerScaleSetLabelKey: "set"}, State: container.StateRunning,
	}})
	scaler := &Scaler{
		scaleSetName:     "set",
		dockerHosts:      []DockerHost{{Name: "janeway", Client: limited.client(t)}},
		hostRunnerLimits: map[string]int{"janeway": 1},
		runners:          runnerState{idle: make(map[string]runnerRef), busy: make(map[string]runnerRef)},
		logger:           slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	blocked := placementBlocked.WithLabelValues("set", "", placementReasonHostLimits)
	before := testutil.ToFloat64(blocked)

	host, err := scaler.pickHost(context.Background())
	if host != "" || !errors.Is(err, errFleetAtCapacity) {
		t.Fatalf("pickHost() = (%q, %v), want host-limit capacity failure", host, err)
	}
	if got := testutil.ToFloat64(blocked) - before; got != 1 {
		t.Errorf("placement_blocked_total{host=\"\",reason=%q} rose by %v, want 1: host_limits is fleet-level, not attributed to janeway", placementReasonHostLimits, got)
	}
}

func TestDeclaredRunnerMemoryRequiresReservationLabel(t *testing.T) {
	_, err := declaredRunnerMemory(container.Summary{ID: "missing-label"})
	if err == nil || !strings.Contains(err.Error(), runnerMemoryLabelKey) {
		t.Fatalf("declaredRunnerMemory() error = %v, want missing reservation label", err)
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

			blocked := placementBlocked.WithLabelValues("set", "pike", placementReasonOverload)
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

// TestReconcileTrackedRunners exercises the runtime Docker reconciliation for
// both idle and busy entries. Only a successful inspect showing a non-running
// state, or a definitive not-found, counts as death. A transport-ish failure
// (a generic 500, or the host being unreachable altogether) must leave the
// entry tracked.
func TestReconcileTrackedRunners(t *testing.T) {
	running := &container.State{Status: container.StateRunning, Running: true}
	exited := &container.State{Status: container.StateExited, Running: false}
	recentCleanExit := &container.State{
		Status:     container.StateExited,
		Running:    false,
		ExitCode:   0,
		FinishedAt: time.Now().Add(-5 * time.Second).Format(time.RFC3339Nano),
	}
	oldCleanExit := &container.State{
		Status:     container.StateExited,
		Running:    false,
		ExitCode:   0,
		FinishedAt: time.Now().Add(-runnerCompletionSettleGrace - time.Second).Format(time.RFC3339Nano),
	}
	recentFailedExit := &container.State{
		Status:     container.StateExited,
		Running:    false,
		ExitCode:   1,
		FinishedAt: time.Now().Add(-5 * time.Second).Format(time.RFC3339Nano),
	}

	cases := []struct {
		name        string
		unreachable bool
		state       string
		setup       func(f *fakeDockerServer)
		wantPruned  bool
		// wantReason is the bounded mismatch reason expected for a pruned
		// entry. runnerDiedIdleTotal remains intentionally idle-only.
		wantReason string
	}{
		{
			name:       "running container is kept",
			state:      runnerTrackedStateIdle,
			setup:      func(f *fakeDockerServer) { f.setInspect("c1", http.StatusOK, running) },
			wantPruned: false,
		},
		{
			name:       "exited idle container is pruned",
			state:      runnerTrackedStateIdle,
			setup:      func(f *fakeDockerServer) { f.setInspect("c1", http.StatusOK, exited) },
			wantPruned: true,
			wantReason: runnerDeadReasonNotRunning,
		},
		{
			name:       "recent successful JIT exit waits for listener completion",
			state:      runnerTrackedStateIdle,
			setup:      func(f *fakeDockerServer) { f.setInspect("c1", http.StatusOK, recentCleanExit) },
			wantPruned: false,
		},
		{
			name:       "successful idle exit is pruned after listener settlement window",
			state:      runnerTrackedStateIdle,
			setup:      func(f *fakeDockerServer) { f.setInspect("c1", http.StatusOK, oldCleanExit) },
			wantPruned: true,
			wantReason: runnerDeadReasonNotRunning,
		},
		{
			name:       "recent failed idle exit is pruned immediately",
			state:      runnerTrackedStateIdle,
			setup:      func(f *fakeDockerServer) { f.setInspect("c1", http.StatusOK, recentFailedExit) },
			wantPruned: true,
			wantReason: runnerDeadReasonNotRunning,
		},
		{
			name:       "missing busy container is pruned",
			state:      runnerTrackedStateBusy,
			setup:      func(f *fakeDockerServer) { f.setInspect("c1", http.StatusNotFound, nil) },
			wantPruned: true,
			wantReason: runnerDeadReasonNotFound,
		},
		{
			name:       "server error (500) is kept, not treated as not-found",
			state:      runnerTrackedStateBusy,
			setup:      func(f *fakeDockerServer) { f.setInspect("c1", http.StatusInternalServerError, nil) },
			wantPruned: false,
		},
		{
			name:        "transport error (connection refused) is kept",
			unreachable: true,
			state:       runnerTrackedStateBusy,
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

			idle := map[string]runnerRef{}
			busy := map[string]runnerRef{}
			if c.state == runnerTrackedStateBusy {
				busy["runner-1"] = runnerRef{host: "host-a", containerID: "c1"}
			} else {
				idle["runner-1"] = runnerRef{host: "host-a", containerID: "c1"}
			}
			scaler := &Scaler{
				dockerHosts: []DockerHost{{Name: "host-a", Client: client}},
				runners: runnerState{
					idle: idle,
					busy: busy,
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
			mismatchCounter := trackedRunnerMismatchTotal.WithLabelValues("default", "host-a", c.state, c.wantReason)
			beforeNotRunning := testutil.ToFloat64(notRunningCounter)
			beforeNotFound := testutil.ToFloat64(notFoundCounter)
			beforeMismatch := testutil.ToFloat64(mismatchCounter)

			scaler.reconcileTrackedRunners(context.Background())

			_, stillIdle := scaler.runners.idle["runner-1"]
			_, stillBusy := scaler.runners.busy["runner-1"]
			switch {
			case c.wantPruned && (stillIdle || stillBusy):
				t.Errorf("expected runner-1 to be pruned, but it remains tracked (idle=%v busy=%v)", stillIdle, stillBusy)
			case !c.wantPruned && !(stillIdle || stillBusy):
				t.Errorf("expected runner-1 to remain tracked, but it was pruned")
			}

			gotNotRunning := testutil.ToFloat64(notRunningCounter) - beforeNotRunning
			gotNotFound := testutil.ToFloat64(notFoundCounter) - beforeNotFound
			wantNotRunning, wantNotFound := 0.0, 0.0
			if c.state == runnerTrackedStateIdle {
				switch c.wantReason {
				case runnerDeadReasonNotRunning:
					wantNotRunning = 1
				case runnerDeadReasonNotFound:
					wantNotFound = 1
				}
			}
			if gotNotRunning != wantNotRunning {
				t.Errorf("runner_died_idle_total{reason=%q} rose by %v, want %v", runnerDeadReasonNotRunning, gotNotRunning, wantNotRunning)
			}
			if gotNotFound != wantNotFound {
				t.Errorf("runner_died_idle_total{reason=%q} rose by %v, want %v", runnerDeadReasonNotFound, gotNotFound, wantNotFound)
			}
			gotMismatch := testutil.ToFloat64(mismatchCounter) - beforeMismatch
			wantMismatch := 0.0
			if c.wantPruned {
				wantMismatch = 1
			}
			if gotMismatch != wantMismatch {
				t.Errorf("tracked_runner_mismatch_total{state=%q,reason=%q} rose by %v, want %v", c.state, c.wantReason, gotMismatch, wantMismatch)
			}
		})
	}
}

// TestHandleDesiredRunnerCountDefersBusyRunnerReconciliation keeps the
// listener callback bounded even when a fleet has many busy entries. The
// periodic reconciler still owns busy-container cleanup (covered above).
func TestHandleDesiredRunnerCountDefersBusyRunnerReconciliation(t *testing.T) {
	fakeDocker := newFakeDockerServer(t)
	fakeDocker.setInspect("busy-container", http.StatusOK, &container.State{Status: container.StateExited, Running: false})

	scaler := &Scaler{
		dockerHosts: []DockerHost{{Name: "host-a", Client: fakeDocker.client(t)}},
		maxRunners:  1,
		runners: runnerState{
			idle: map[string]runnerRef{},
			busy: map[string]runnerRef{
				"runner-1": {host: "host-a", containerID: "busy-container"},
			},
		},
		scalesetClient: newStubScalesetClient(t),
		logger:         slog.New(slog.NewTextHandler(os.Stdout, nil)),
	}

	if _, err := scaler.HandleDesiredRunnerCount(context.Background(), 1); err != nil {
		t.Fatalf("HandleDesiredRunnerCount() error = %v", err)
	}
	if got := fakeDocker.inspectCallCount("busy-container"); got != 0 {
		t.Fatalf("listener callback inspected busy runner %d times, want 0", got)
	}
	if _, ok := scaler.runners.busy["runner-1"]; !ok {
		t.Fatal("listener callback removed busy runner; periodic reconciliation owns that cleanup")
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
	fleet := newFleetCoordinator(1, nil, map[string]int{"watchdog-stuck": 1}, nil, []string{"watchdog-stuck"})
	scaler := &Scaler{
		scaleSetName: "watchdog-stuck",
		maxRunners:   1,
		runners:      runnerState{idle: map[string]runnerRef{}, busy: map[string]runnerRef{}},
		fleet:        fleet,
		logger:       slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	scaler.queuedJobs.Store(1)
	scaler.draining.Store(true)
	drainingGauge.WithLabelValues("watchdog-stuck").Set(1)
	cleared := testutil.ToFloat64(drainAutoClearedTotal.WithLabelValues("watchdog-stuck"))
	scaler.updateSchedulerDemand(time.Unix(1234, 0))
	if got := testutil.ToFloat64(pendingRunnersGauge.WithLabelValues("watchdog-stuck")); got != 0 {
		t.Fatalf("pendingRunnersGauge while draining = %v, want 0", got)
	}

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
	if got := testutil.ToFloat64(pendingRunnersGauge.WithLabelValues("watchdog-stuck")); got != 1 {
		t.Errorf("pendingRunnersGauge after EndDrain = %v, want 1", got)
	}

	// Calling again while already clear must not double-count the metric.
	scaler.EndDrain()
	if got := testutil.ToFloat64(drainAutoClearedTotal.WithLabelValues("watchdog-stuck")) - cleared; got != 1 {
		t.Errorf("drainAutoClearedTotal delta after a second EndDrain = %v, want still 1 (idempotent)", got)
	}
}

func TestSchedulerDemandPublicationSerializesWithRunnerTransitions(t *testing.T) {
	fleet := newFleetCoordinator(1, nil, map[string]int{"protected": 1}, map[string]int{"protected": 10}, []string{"protected"})
	scaler := &Scaler{
		scaleSetName: "protected",
		maxRunners:   1,
		runners:      runnerState{idle: map[string]runnerRef{}, busy: map[string]runnerRef{}},
		fleet:        fleet,
	}
	scaler.queuedJobs.Store(1)

	// Stop the first publication after it has taken the runner snapshot. A
	// concurrent replacement transition must not pass that snapshot and
	// publish newer demand first; otherwise the delayed zero-runner snapshot
	// can overwrite it when the coordinator becomes available again.
	fleet.mu.Lock()
	publicationDone := make(chan struct{})
	go func() {
		scaler.updateSchedulerDemand(time.Unix(1234, 0))
		close(publicationDone)
	}()

	deadline := time.Now().Add(time.Second)
	for scaler.runners.mu.TryLock() {
		scaler.runners.mu.Unlock()
		if time.Now().After(deadline) {
			fleet.mu.Unlock()
			t.Fatal("demand publication never entered the runner-state critical section")
		}
		runtime.Gosched()
	}

	transitionDone := make(chan struct{})
	go func() {
		scaler.runners.addIdle("replacement", "host-a", "container-a", time.Now())
		scaler.updateSchedulerDemand(time.Unix(1235, 0))
		close(transitionDone)
	}()
	select {
	case <-transitionDone:
		fleet.mu.Unlock()
		t.Fatal("runner transition passed an older in-flight demand publication")
	case <-time.After(25 * time.Millisecond):
	}

	fleet.mu.Unlock()
	<-publicationDone
	<-transitionDone

	fleet.mu.Lock()
	demand := fleet.scaleSetDemand["protected"]
	fleet.mu.Unlock()
	if demand.active != 1 || demand.pending != 0 {
		t.Fatalf("final scheduler demand = active %d, pending %d; want active 1, pending 0", demand.active, demand.pending)
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
		runnerImage: "registry.example/runner:test",
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

// TestRunnerBinds pins that only explicitly allowlisted file mounts reach a
// runner and that every one remains read-only.
func TestRunnerBinds(t *testing.T) {
	mounts := []FileMount{{HostPath: "/etc/buildkit/client.pem", ContainerPath: "/secrets/client.pem"}}

	onlyMounts := runnerBinds(mounts)
	if len(onlyMounts) != 1 || onlyMounts[0] != "/etc/buildkit/client.pem:/secrets/client.pem:ro" {
		t.Fatalf("mounts-only binds = %#v", onlyMounts)
	}
	if got := runnerBinds(nil); got != nil {
		t.Fatalf("no mounts should yield no binds, got %#v", got)
	}
}

func TestRunnerHostConfig(t *testing.T) {
	t.Run("zero pids limit means unlimited, not zero", func(t *testing.T) {
		hc := runnerHostConfig(nil, 0, 0, 0, "")
		if hc.Resources.PidsLimit != nil {
			t.Fatalf("PidsLimit = %v, want nil (unlimited)", *hc.Resources.PidsLimit)
		}
	})

	t.Run("memory, pids limit and shm size are all set", func(t *testing.T) {
		hc := runnerHostConfig([]string{"/a:/b"}, 12<<30, 8192, 1<<30, "")
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
	})

	// agent-lcars#1700: every runner container joins the host-level runner
	// slice when one is configured, and is left with Docker's own default
	// (no CgroupParent at all) when the fleet disables it.
	t.Run("cgroup parent carried when configured", func(t *testing.T) {
		hc := runnerHostConfig(nil, 0, 0, 0, "homelab-runners.slice")
		if hc.Resources.CgroupParent != "homelab-runners.slice" {
			t.Fatalf("CgroupParent = %q, want %q", hc.Resources.CgroupParent, "homelab-runners.slice")
		}
	})

	t.Run("cgroup parent omitted when disabled", func(t *testing.T) {
		hc := runnerHostConfig(nil, 0, 0, 0, "")
		if hc.Resources.CgroupParent != "" {
			t.Fatalf("CgroupParent = %q, want empty (disabled)", hc.Resources.CgroupParent)
		}
	})
}

func TestRunnerLabelsIncludeExactMemoryReservation(t *testing.T) {
	labels := runnerLabels("e2e", "sprinkles", 12*gibibyte)
	if labels[runnerScaleSetLabelKey] != "e2e" || labels[runnerRegistrationLabelKey] != "sprinkles" {
		t.Fatalf("runner ownership labels = %#v", labels)
	}
	if got := labels[runnerMemoryLabelKey]; got != "12884901888" {
		t.Fatalf("memory reservation label = %q, want exact byte value", got)
	}
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

	fleet := newFleetCoordinator(4, nil, map[string]int{"set": 1}, nil, []string{"set"})
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

	blocked := placementBlocked.WithLabelValues("set", "roamer", placementReasonReadiness)
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

// agent-lcars#1683: the scheduler charges runner_memory_reservation, not the
// runner_memory ceiling, against a host's aggregate budget. A 14 GiB-capped
// candidate reserving 4 GiB fits beside an 8 GiB runner on a 16 GiB host
// (8 + 4 = 12 GiB under the 14.4 GiB budget) where the ceiling would not.
func TestPickHostChargesReservationNotCeiling(t *testing.T) {
	scaler := memoryBoundScaler(t, "default", 16*gibibyte, 14*gibibyte, []container.Summary{reservedRunner("first", 8*gibibyte)})
	if host, err := scaler.pickHost(context.Background()); host != "" || !errors.Is(err, errFleetAtCapacity) {
		t.Fatalf("pickHost() with reservation == ceiling = (%q, %v), want capacity failure", host, err)
	}
	scaler.runnerMemoryReservation = 4 * gibibyte
	host, err := scaler.pickHost(context.Background())
	if err != nil {
		t.Fatalf("pickHost() with 4 GiB reservation error = %v", err)
	}
	if host != "janeway" {
		t.Fatalf("pickHost() = %q, want janeway", host)
	}
}

func TestMemoryReservationDefaultsToCeiling(t *testing.T) {
	scaler := &Scaler{runnerMemory: 14 * gibibyte}
	if got := scaler.memoryReservation(); got != 14*gibibyte {
		t.Fatalf("memoryReservation() = %d, want the 14 GiB ceiling when no reservation is declared", got)
	}
	scaler.runnerMemoryReservation = 8 * gibibyte
	if got := scaler.memoryReservation(); got != 8*gibibyte {
		t.Fatalf("memoryReservation() = %d, want the declared 8 GiB reservation", got)
	}
	if labels := runnerLabels("default", "primary", scaler.memoryReservation()); labels[runnerMemoryLabelKey] != "8589934592" {
		t.Fatalf("container label = %q, want the reservation the scheduler will recount, not the ceiling", labels[runnerMemoryLabelKey])
	}
}

func TestFleetReservationChargesDeclaredReservation(t *testing.T) {
	scaler := memoryBoundScaler(t, "default", 32*gibibyte, 14*gibibyte, nil)
	scaler.runnerMemoryReservation = 8 * gibibyte
	fleet := scaler.coordinator()
	reservation, err := fleet.reserve(context.Background(), scaler)
	if err != nil {
		t.Fatalf("reserve() error = %v", err)
	}
	if got := fleet.reservedMemory["janeway"]; got != 8*gibibyte {
		t.Fatalf("in-flight reservedMemory = %d, want 8 GiB (the reservation), not the 14 GiB ceiling", got)
	}
	reservation.release("default")
	if got := fleet.reservedMemory["janeway"]; got != 0 {
		t.Fatalf("reservedMemory after release = %d, want 0", got)
	}
}

func TestRegistrationTarget(t *testing.T) {
	for in, want := range map[string][2]string{
		"https://github.com/supersprinklesracing/sprinkles": {"supersprinklesracing", "supersprinklesracing/sprinkles"},
		"https://github.com/jlapenna/agent-lcars/":          {"jlapenna", "jlapenna/agent-lcars"},
		"https://github.com/jlapenna/nx-cache-server.git":   {"jlapenna", "jlapenna/nx-cache-server"},
		"https://github.com/acme":                           {"acme", ""},
		"https://github.com/":                               {"", ""},
		"":                                                  {"", ""},
	} {
		owner, repository := registrationTarget(in)
		if owner != want[0] || repository != want[1] {
			t.Errorf("registrationTarget(%q) = (%q, %q), want (%q, %q)", in, owner, repository, want[0], want[1])
		}
	}
}

// agent-lcars#1693: the runner->job association is a metric keyed by the
// container name, published at JobStarted and removed when the job completes
// or the runner is deregistered, so cAdvisor memory can be joined to job names.
func TestRunnerJobInfoFollowsTheJobLifecycle(t *testing.T) {
	scaler := &Scaler{
		scaleSetName: "default",
		runners:      runnerState{idle: map[string]runnerRef{"runner-default-abc": {}}, busy: map[string]runnerRef{}},
		logger:       slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	job := &scaleset.JobStarted{RunnerName: "runner-default-abc", JobMessageBase: scaleset.JobMessageBase{
		JobID: "job-1", JobDisplayName: "Full verification", OwnerName: "supersprinklesracing", RepositoryName: "sprinkles",
		JobWorkflowRef: "supersprinklesracing/sprinkles/.github/workflows/ci.yml@refs/heads/main",
	}}
	if err := scaler.HandleJobStarted(context.Background(), job); err != nil {
		t.Fatalf("HandleJobStarted() error = %v", err)
	}
	labels := prometheus.Labels{"scale_set": "default", "runner": "runner-default-abc", "job_id": "job-1",
		"job_name": "Full verification", "workflow": "ci", "repository": "supersprinklesracing/sprinkles"}
	if got := testutil.ToFloat64(runnerJobInfoGauge.With(labels)); got != 1 {
		t.Fatalf("runner_job_info = %v, want 1 while the job runs", got)
	}
	scaler.forgetRunnerJob("runner-default-abc")
	if _, ok := scaler.runnerJobs.Load("runner-default-abc"); ok {
		t.Fatal("job-info labels retained after forgetRunnerJob")
	}
	if n := testutil.CollectAndCount(runnerJobInfoGauge); n != 0 {
		t.Fatalf("runner_job_info series after completion = %d, want 0", n)
	}
	// A job completed without ever being assigned a runner carries no name
	// and must not publish an empty-runner series.
	scaler.recordRunnerJob(&scaleset.JobStarted{JobMessageBase: scaleset.JobMessageBase{JobID: "job-2"}})
	if n := testutil.CollectAndCount(runnerJobInfoGauge); n != 0 {
		t.Fatalf("runner_job_info series for a runner-less job = %d, want 0", n)
	}
}

// agent-lcars#1687: a job cancelled or superseded while still queued
// completes without ever being assigned a runner -- GitHub sends an empty
// RunnerName. That is routine (cancel/re-dispatch loops fired it 57 times in
// 4h on 2026-09-01) and must log at INFO with its own counter, not the WARN
// meant for a runner GitHub knows about that this control plane has no
// record of at all.
func TestHandleJobCompletedUnassignedRunner(t *testing.T) {
	var logBuf bytes.Buffer
	scaler := &Scaler{
		scaleSetName: "e2e",
		runners:      runnerState{idle: map[string]runnerRef{}, busy: map[string]runnerRef{}},
		logger:       slog.New(slog.NewTextHandler(&logBuf, nil)),
	}
	before := testutil.ToFloat64(jobsCompletedUnassignedTotal.WithLabelValues("e2e"))

	job := &scaleset.JobCompleted{JobMessageBase: scaleset.JobMessageBase{JobID: "job-1", RunnerRequestID: 42}}
	if err := scaler.HandleJobCompleted(context.Background(), job); err != nil {
		t.Fatalf("HandleJobCompleted() error = %v", err)
	}

	if got := testutil.ToFloat64(jobsCompletedUnassignedTotal.WithLabelValues("e2e")) - before; got != 1 {
		t.Fatalf("jobs_completed_unassigned_total{e2e} increment = %v, want 1", got)
	}
	logged := logBuf.String()
	if !strings.Contains(logged, "level=INFO") || !strings.Contains(logged, "Job completed without an assigned runner") {
		t.Fatalf("expected an INFO \"Job completed without an assigned runner\" log, got: %s", logged)
	}
	if strings.Contains(logged, "level=WARN") {
		t.Fatalf("expected no WARN log for a job completed without an assigned runner, got: %s", logged)
	}
}

// The non-empty case -- a runner name GitHub reports that this tracker has
// never heard of -- keeps its existing WARN behaviour untouched by the new
// empty-name branch, and must not increment the new unassigned counter.
func TestHandleJobCompletedUntrackedRunnerStillWarns(t *testing.T) {
	var logBuf bytes.Buffer
	scaler := &Scaler{
		scaleSetName: "e2e",
		runners:      runnerState{idle: map[string]runnerRef{}, busy: map[string]runnerRef{}},
		logger:       slog.New(slog.NewTextHandler(&logBuf, nil)),
	}
	before := testutil.ToFloat64(jobsCompletedUnassignedTotal.WithLabelValues("e2e"))

	job := &scaleset.JobCompleted{RunnerName: "runner-ghost", JobMessageBase: scaleset.JobMessageBase{JobID: "job-2"}}
	if err := scaler.HandleJobCompleted(context.Background(), job); err != nil {
		t.Fatalf("HandleJobCompleted() error = %v", err)
	}

	if got := testutil.ToFloat64(jobsCompletedUnassignedTotal.WithLabelValues("e2e")) - before; got != 0 {
		t.Fatalf("jobs_completed_unassigned_total{e2e} increment = %v, want 0 for a non-empty untracked name", got)
	}
	logged := logBuf.String()
	if !strings.Contains(logged, "level=WARN") || !strings.Contains(logged, "Job completed for untracked runner") {
		t.Fatalf("expected the existing WARN \"Job completed for untracked runner\" log, got: %s", logged)
	}
}

// Mirrors TestHandleJobCompletedUnassignedRunner for HandleJobStarted, which
// treats an empty RunnerName the same way as an "untracked runner" today.
func TestHandleJobStartedUnassignedRunner(t *testing.T) {
	var logBuf bytes.Buffer
	scaler := &Scaler{
		scaleSetName: "e2e",
		runners:      runnerState{idle: map[string]runnerRef{}, busy: map[string]runnerRef{}},
		logger:       slog.New(slog.NewTextHandler(&logBuf, nil)),
	}
	before := testutil.ToFloat64(jobsCompletedUnassignedTotal.WithLabelValues("e2e"))

	job := &scaleset.JobStarted{JobMessageBase: scaleset.JobMessageBase{JobID: "job-3", RunnerRequestID: 7}}
	if err := scaler.HandleJobStarted(context.Background(), job); err != nil {
		t.Fatalf("HandleJobStarted() error = %v", err)
	}

	if got := testutil.ToFloat64(jobsCompletedUnassignedTotal.WithLabelValues("e2e")) - before; got != 1 {
		t.Fatalf("jobs_completed_unassigned_total{e2e} increment = %v, want 1", got)
	}
	logged := logBuf.String()
	if !strings.Contains(logged, "level=INFO") || !strings.Contains(logged, "Job started without an assigned runner") {
		t.Fatalf("expected an INFO \"Job started without an assigned runner\" log, got: %s", logged)
	}
	if strings.Contains(logged, "level=WARN") {
		t.Fatalf("expected no WARN log for a job started without an assigned runner, got: %s", logged)
	}
}

// The non-empty case for HandleJobStarted keeps its existing WARN behaviour.
func TestHandleJobStartedUntrackedRunnerStillWarns(t *testing.T) {
	var logBuf bytes.Buffer
	scaler := &Scaler{
		scaleSetName: "e2e",
		runners:      runnerState{idle: map[string]runnerRef{}, busy: map[string]runnerRef{}},
		logger:       slog.New(slog.NewTextHandler(&logBuf, nil)),
	}
	before := testutil.ToFloat64(jobsCompletedUnassignedTotal.WithLabelValues("e2e"))

	job := &scaleset.JobStarted{RunnerName: "runner-ghost", JobMessageBase: scaleset.JobMessageBase{JobID: "job-4"}}
	if err := scaler.HandleJobStarted(context.Background(), job); err != nil {
		t.Fatalf("HandleJobStarted() error = %v", err)
	}

	if got := testutil.ToFloat64(jobsCompletedUnassignedTotal.WithLabelValues("e2e")) - before; got != 0 {
		t.Fatalf("jobs_completed_unassigned_total{e2e} increment = %v, want 0 for a non-empty untracked name", got)
	}
	logged := logBuf.String()
	if !strings.Contains(logged, "level=WARN") || !strings.Contains(logged, "Received job started for untracked runner") {
		t.Fatalf("expected the existing WARN \"Received job started for untracked runner\" log, got: %s", logged)
	}
}

func TestWorkflowFromRef(t *testing.T) {
	for in, want := range map[string]string{
		"supersprinklesracing/sprinkles/.github/workflows/ci.yml@refs/heads/main":  "ci",
		"jlapenna/homelab/.github/workflows/reconcile-main.yaml@refs/pull/1/merge": "reconcile-main",
		"deploy.yml": "deploy",
		"":           "",
	} {
		if got := workflowFromRef(in); got != want {
			t.Errorf("workflowFromRef(%q) = %q, want %q", in, got, want)
		}
	}
}

// agent-lcars#1699: every runs-on label a scale set declares is published so
// queue depth carrying a runs_on label can be attributed to the lane.
func TestPublishScaleSetInfoExportsEveryDeclaredLabel(t *testing.T) {
	scaleSetLabelInfoGauge.Reset()
	cfg := Config{
		ScaleSetName: "ci-heavy", RegistrationName: "primary", RegistrationURL: "https://github.com/acme/widgets",
		Labels: []string{"ci-heavy", "homelab-autoscale-ci-heavy"},
	}
	publishScaleSetInfo(cfg, 8*gibibyte, 14*gibibyte)
	for _, label := range cfg.Labels {
		if got := testutil.ToFloat64(scaleSetLabelInfoGauge.WithLabelValues("ci-heavy", label)); got != 1 {
			t.Fatalf("scale_set_label_info{scale_set=ci-heavy,label=%s} = %v, want 1", label, got)
		}
	}
	if n := testutil.CollectAndCount(scaleSetLabelInfoGauge); n != 2 {
		t.Fatalf("label info series = %d, want exactly the two declared labels", n)
	}
	if got := testutil.ToFloat64(scaleSetInfoGauge.WithLabelValues("ci-heavy", "primary", "acme", "acme/widgets")); got != 1 {
		t.Fatalf("scale_set_info for ci-heavy = %v, want 1", got)
	}
	if got := testutil.ToFloat64(scaleSetMemoryReservationGauge.WithLabelValues("ci-heavy")); got != float64(8*gibibyte) {
		t.Fatalf("reservation gauge = %v, want 8 GiB", got)
	}
}

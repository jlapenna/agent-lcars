package main

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"text/template"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/prometheus/client_golang/prometheus/testutil"
)

// TestDegradationLadderDisabledPreservesOldRefusal pins the default-off
// guarantee (agent-lcars#1697): even when rung 2/3 data is available and
// WOULD admit, a lane with the ladder disabled sees the exact pre-ladder
// refusal, and never touches placement_degraded_total.
func TestDegradationLadderDisabledPreservesOldRefusal(t *testing.T) {
	scaler := memoryBoundScaler(t, "heavy", 16*gibibyte, 8*gibibyte, []container.Summary{reservedRunner("first", 10*gibibyte)})
	// degradationLadderEnabled left at its zero value (false).
	fleet := scaler.coordinator()
	fleet.observedMemoryMaxAge = time.Hour
	fleet.setObservedMemory("heavy", 2*float64(gibibyte), time.Now())
	seedHostLoad(fleet, "janeway", hostLoad{memoryAvailable: 1, memoryAvailableBytes: float64(20 * gibibyte)})

	degradedBefore := testutil.ToFloat64(placementDegradedTotal.WithLabelValues("heavy", degradationRungObservedP95))

	host, err := scaler.pickHost(context.Background())
	if host != "" || !errors.Is(err, errFleetAtCapacity) {
		t.Fatalf("pickHost() = (%q, %v), want the pre-ladder capacity failure even though rung 2/3 data is available", host, err)
	}
	if got := testutil.ToFloat64(placementDegradedTotal.WithLabelValues("heavy", degradationRungObservedP95)) - degradedBefore; got != 0 {
		t.Errorf("placement_degraded_total{rung=observed_p95} rose by %v with the ladder disabled, want 0", got)
	}
}

// TestDegradationLadderRung1AdmitsWithoutDegrading confirms a ladder-enabled
// lane that admits at its declared reservation never touches
// placement_degraded_total: rung 1 is the normal path, not a rung.
func TestDegradationLadderRung1AdmitsWithoutDegrading(t *testing.T) {
	scaler := memoryBoundScaler(t, "heavy", 16*gibibyte, 2*gibibyte, []container.Summary{reservedRunner("first", 10*gibibyte)})
	scaler.degradationLadderEnabled = true

	before := testutil.ToFloat64(placementDegradedTotal.WithLabelValues("heavy", degradationRungObservedP95))

	host, err := scaler.pickHost(context.Background())
	if err != nil {
		t.Fatalf("pickHost() error = %v, want the declared reservation to admit", err)
	}
	if host != "janeway" {
		t.Fatalf("pickHost() = %q, want janeway", host)
	}
	if got := testutil.ToFloat64(placementDegradedTotal.WithLabelValues("heavy", degradationRungObservedP95)) - before; got != 0 {
		t.Errorf("placement_degraded_total rose by %v, want 0: rung 1 admitted", got)
	}
}

// TestDegradationLadderAdmitsAtObservedP95WhenDeclaredFails pins rung 2
// (docs/fleet-scheduler-redesign.md#D): 16 GiB * 0.9 margin = 14.4 GiB
// budget. A running 10 GiB reservation plus the 8 GiB declared candidate
// (18 GiB) exceeds it, but the lane's observed p95 (2 GiB) fits (12 GiB).
func TestDegradationLadderAdmitsAtObservedP95WhenDeclaredFails(t *testing.T) {
	scaler := memoryBoundScaler(t, "heavy", 16*gibibyte, 8*gibibyte, []container.Summary{reservedRunner("first", 10*gibibyte)})
	scaler.degradationLadderEnabled = true
	fleet := scaler.coordinator()
	fleet.observedMemoryMaxAge = time.Hour
	fleet.setObservedMemory("heavy", 2*float64(gibibyte), time.Now())
	seedHostLoad(fleet, "janeway", hostLoad{memoryAvailable: 1, memoryPressure: 0})

	before := testutil.ToFloat64(placementDegradedTotal.WithLabelValues("heavy", degradationRungObservedP95))

	host, err := scaler.pickHost(context.Background())
	if err != nil {
		t.Fatalf("pickHost() error = %v, want rung 2 to admit at the observed p95", err)
	}
	if host != "janeway" {
		t.Fatalf("pickHost() = %q, want janeway", host)
	}
	if got := testutil.ToFloat64(placementDegradedTotal.WithLabelValues("heavy", degradationRungObservedP95)) - before; got != 1 {
		t.Errorf("placement_degraded_total{rung=observed_p95} rose by %v, want 1", got)
	}
}

// TestDegradationLadderRung2RespectsSoftPressure pins rung 2's "not
// soft-pressured" gate: an observed p95 that would otherwise fit the free
// budget must still be refused (falling through to rung 3, or refusal) on a
// host below memory_soft, even though it is not hard-overloaded.
func TestDegradationLadderRung2RespectsSoftPressure(t *testing.T) {
	scaler := memoryBoundScaler(t, "heavy", 16*gibibyte, 8*gibibyte, []container.Summary{reservedRunner("first", 10*gibibyte)})
	scaler.degradationLadderEnabled = true
	fleet := scaler.coordinator()
	fleet.observedMemoryMaxAge = time.Hour
	fleet.setObservedMemory("heavy", 2*float64(gibibyte), time.Now())
	// Below the default memory_soft (0.15) but not hard-overloaded: rung 1's
	// own overload gate would not exclude this host, but rung 2 must.
	seedHostLoad(fleet, "janeway", hostLoad{memoryAvailable: 0.10, memoryPressure: 0})

	host, err := scaler.pickHost(context.Background())
	if host != "" || !errors.Is(err, errFleetAtCapacity) {
		t.Fatalf("pickHost() = (%q, %v), want rung 2 to refuse a soft-pressured host despite fitting the observed p95", host, err)
	}
}

// TestDegradationLadderFallsBackToFloorWhenObservedP95Absent pins rung 3's
// activation when rung 2 has no data at all: no observed sample has ever
// been recorded for this lane.
func TestDegradationLadderFallsBackToFloorWhenObservedP95Absent(t *testing.T) {
	scaler := memoryBoundScaler(t, "heavy", 16*gibibyte, 8*gibibyte, []container.Summary{reservedRunner("first", 10*gibibyte)})
	scaler.degradationLadderEnabled = true
	fleet := scaler.coordinator()
	fleet.observedMemoryMaxAge = time.Hour
	seedHostLoad(fleet, "janeway", hostLoad{memoryAvailable: 1, memoryAvailableBytes: float64(20 * gibibyte)})

	before := testutil.ToFloat64(placementDegradedTotal.WithLabelValues("heavy", degradationRungFreeMemoryFloor))

	host, err := scaler.pickHost(context.Background())
	if err != nil {
		t.Fatalf("pickHost() error = %v, want rung 3 to admit with no observed sample at all", err)
	}
	if host != "janeway" {
		t.Fatalf("pickHost() = %q, want janeway", host)
	}
	if got := testutil.ToFloat64(placementDegradedTotal.WithLabelValues("heavy", degradationRungFreeMemoryFloor)) - before; got != 1 {
		t.Errorf("placement_degraded_total{rung=free_memory_floor} rose by %v, want 1", got)
	}
}

// TestDegradationLadderFallsBackToFloorWhenObservedP95Stale pins rung 3's
// activation when rung 2's cached sample has aged past
// fleet.observedMemoryMaxAge (3x refresh_interval).
func TestDegradationLadderFallsBackToFloorWhenObservedP95Stale(t *testing.T) {
	scaler := memoryBoundScaler(t, "heavy", 16*gibibyte, 8*gibibyte, []container.Summary{reservedRunner("first", 10*gibibyte)})
	scaler.degradationLadderEnabled = true
	fleet := scaler.coordinator()
	fleet.observedMemoryMaxAge = 10 * time.Minute
	fleet.setObservedMemory("heavy", 2*float64(gibibyte), time.Now().Add(-time.Hour))
	seedHostLoad(fleet, "janeway", hostLoad{memoryAvailable: 1, memoryAvailableBytes: float64(20 * gibibyte)})

	host, err := scaler.pickHost(context.Background())
	if err != nil {
		t.Fatalf("pickHost() error = %v, want rung 3 to admit once the p95 sample is stale", err)
	}
	if host != "janeway" {
		t.Fatalf("pickHost() = %q, want janeway", host)
	}
}

// TestDegradationLadderFloorExcludesHardPressuredHost pins rung 3's "reachable,
// non-hard-pressured" gate: ample free memory does not override a genuine
// hard-overload reading.
func TestDegradationLadderFloorExcludesHardPressuredHost(t *testing.T) {
	scaler := memoryBoundScaler(t, "heavy", 16*gibibyte, 8*gibibyte, []container.Summary{reservedRunner("first", 10*gibibyte)})
	scaler.degradationLadderEnabled = true
	fleet := scaler.coordinator()
	seedHostLoad(fleet, "janeway", hardOverloadedLoad(scaler, "janeway", hostLoad{memoryAvailable: 1, normalizedLoad: 2, memoryAvailableBytes: float64(20 * gibibyte)}))

	before := testutil.ToFloat64(placementDegradedTotal.WithLabelValues("heavy", degradationRungRefused))

	host, err := scaler.pickHost(context.Background())
	if host != "" || !errors.Is(err, errFleetAtCapacity) {
		t.Fatalf("pickHost() = (%q, %v), want capacity failure: janeway is hard-overloaded despite ample free memory", host, err)
	}
	if got := testutil.ToFloat64(placementDegradedTotal.WithLabelValues("heavy", degradationRungRefused)) - before; got != 1 {
		t.Errorf("placement_degraded_total{rung=refused} rose by %v, want 1", got)
	}
}

// TestDegradationLadderRefusesWhenEveryRungFails pins rung 4: nothing
// admits, the refused rung is counted, and lane_admissible_slots already
// reads 0 from the same (unmodified) admission arithmetic.
func TestDegradationLadderRefusesWhenEveryRungFails(t *testing.T) {
	scaler := memoryBoundScaler(t, "heavy", 16*gibibyte, 8*gibibyte, []container.Summary{reservedRunner("first", 12*gibibyte)})
	scaler.degradationLadderEnabled = true
	fleet := scaler.coordinator()
	seedHostLoad(fleet, "janeway", hostLoad{memoryAvailable: 1, memoryPressure: 0})

	before := testutil.ToFloat64(placementDegradedTotal.WithLabelValues("heavy", degradationRungRefused))

	host, err := scaler.pickHost(context.Background())
	if host != "" || !errors.Is(err, errFleetAtCapacity) {
		t.Fatalf("pickHost() = (%q, %v), want capacity failure", host, err)
	}
	if got := testutil.ToFloat64(placementDegradedTotal.WithLabelValues("heavy", degradationRungRefused)) - before; got != 1 {
		t.Errorf("placement_degraded_total{rung=refused} rose by %v, want 1", got)
	}
	if got := testutil.ToFloat64(laneAdmissibleSlotsGauge.WithLabelValues("heavy")); got != 0 {
		t.Errorf("lane_admissible_slots = %v, want 0", got)
	}
}

// ladderFleetScaler builds two independent *Scaler values (distinct lanes'
// worth of local state) that share ONE FleetCoordinator and ONE Docker host,
// the shape reserve()'s rung-3 floor cordon needs to be exercised across
// separate placement attempts the way two different callers of startRunner
// would.
func ladderFleetScaler(t *testing.T, scaleSetName string, ceiling int64, fleet *FleetCoordinator, host DockerHost) *Scaler {
	t.Helper()
	return &Scaler{
		scaleSetName: scaleSetName, runnerMemory: ceiling, degradationLadderEnabled: true,
		dockerHosts: []DockerHost{host}, fleet: fleet,
		runners: runnerState{idle: map[string]runnerRef{}, busy: map[string]runnerRef{}},
		logger:  slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
}

// TestDegradationLadderFloorAdmitsAtMostOnePerHost pins rung 3's floor
// invariant end to end through FleetCoordinator.reserve: a second rung-3
// candidate is refused while the first is still in flight, and releasing
// the first's claim (as HandleJobCompleted/reconcileTrackedRunners would)
// frees the host for a subsequent rung-3 placement.
func TestDegradationLadderFloorAdmitsAtMostOnePerHost(t *testing.T) {
	fake := newFakeDockerServer(t)
	fake.setMemoryTotal(16 * gibibyte)
	fake.setContainers(nil)
	host := DockerHost{Name: "laforge", Client: fake.client(t)}
	fleet := newFleetCoordinator(0, nil, map[string]int{"heavy": 1}, nil, []string{"heavy"})
	seedHostLoad(fleet, "laforge", hostLoad{memoryAvailable: 1, memoryAvailableBytes: float64(20 * gibibyte)})
	// A large phantom in-flight reservation makes both the declared
	// reservation and any observed p95 impossible on this lone host,
	// forcing every attempt below to rung 3.
	fleet.reservedMemory["laforge"] = 16 * gibibyte

	scalerA := ladderFleetScaler(t, "heavy", 8*gibibyte, fleet, host)
	first, err := fleet.reserve(context.Background(), scalerA, "runner-a")
	if err != nil {
		t.Fatalf("first reserve() error = %v, want rung-3 admission", err)
	}
	if first.rung != degradationRungFreeMemoryFloor {
		t.Fatalf("first reservation rung = %q, want %q", first.rung, degradationRungFreeMemoryFloor)
	}
	if got := testutil.ToFloat64(placementDegradedActiveGauge.WithLabelValues("heavy", "laforge")); got != 1 {
		t.Fatalf("placement_degraded_active = %v, want 1 while the rung-3 runner is in flight", got)
	}
	// Releases only the short-term admission bookkeeping (as startRunner's
	// defer does on every path) -- the floor claim itself outlives this.
	first.release("heavy")

	scalerB := ladderFleetScaler(t, "heavy", 8*gibibyte, fleet, host)
	if _, err := fleet.reserve(context.Background(), scalerB, "runner-b"); err == nil {
		t.Fatal("second reserve() on the same lone host succeeded, want the floor cordon to refuse it")
	} else if !errors.Is(err, errFleetAtCapacity) {
		t.Fatalf("second reserve() error = %v, want errFleetAtCapacity", err)
	}

	// Releasing the first runner's floor claim (as HandleJobCompleted or
	// reconcileTrackedRunners' markDoneWithState path would, via the
	// Scaler-level wrapper that also decrements placement_degraded_active)
	// frees the host.
	scalerA.releaseFloorClaim("runner-a")
	if got := testutil.ToFloat64(placementDegradedActiveGauge.WithLabelValues("heavy", "laforge")); got != 0 {
		t.Fatalf("placement_degraded_active = %v, want 0 after the floor claim was released", got)
	}
	third, err := fleet.reserve(context.Background(), scalerB, "runner-c")
	if err != nil {
		t.Fatalf("reserve() after releasing the floor claim, error = %v", err)
	}
	if third.rung != degradationRungFreeMemoryFloor {
		t.Fatalf("post-release rung = %q, want %q", third.rung, degradationRungFreeMemoryFloor)
	}
}

// TestDegradationLadderRefresherSkipsWithoutPrometheusURL pins
// runDegradationLadderRefresher's no-op behavior when
// fleet.placement.degradation_ladder.prometheus_url is unset: it must
// return immediately rather than looping forever, and must never touch the
// fleet's observed-memory cache.
func TestDegradationLadderRefresherSkipsWithoutPrometheusURL(t *testing.T) {
	fleet := newFleetCoordinator(0, nil, nil, nil, nil)
	rt := &scaleSetRuntime{scaler: &Scaler{scaleSetName: "heavy", degradationLadderEnabled: true, logger: slog.New(slog.NewTextHandler(io.Discard, nil))}}

	done := make(chan struct{})
	go func() {
		runDegradationLadderRefresher(context.Background(), []*scaleSetRuntime{rt}, fleet, resolvedDegradationLadder{})
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("runDegradationLadderRefresher did not return immediately with no prometheus_url configured")
	}
	if _, ok := fleet.getObservedMemory("heavy"); ok {
		t.Error("observed memory was recorded despite no prometheus_url")
	}
}

// TestDegradationLadderRefresherPopulatesFleetCache is an end-to-end check
// that the refresher goroutine queries Prometheus, stores the result on the
// shared FleetCoordinator, and publishes the observed-p95 gauge -- the glue
// between the httptest-covered prometheusClient and the fleet-state-covered
// placement rungs, tested separately above.
func TestDegradationLadderRefresherPopulatesFleetCache(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"success","data":{"resultType":"vector","result":[{"metric":{},"value":[1735689600,"3221225472"]}]}}`))
	}))
	defer srv.Close()

	tmpl, err := template.New("q").Parse(defaultDegradationLadderQuery)
	if err != nil {
		t.Fatal(err)
	}
	ladder := resolvedDegradationLadder{
		PrometheusURL: srv.URL, Window: "168h", Quantile: 0.95,
		QueryTemplate: tmpl, RefreshInterval: 10 * time.Millisecond, MaxSampleAge: time.Hour,
	}
	fleet := newFleetCoordinator(0, nil, nil, nil, nil)
	fleet.observedMemoryMaxAge = ladder.MaxSampleAge
	rt := &scaleSetRuntime{scaler: &Scaler{scaleSetName: "heavy", degradationLadderEnabled: true, logger: slog.New(slog.NewTextHandler(io.Discard, nil))}}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		runDegradationLadderRefresher(ctx, []*scaleSetRuntime{rt}, fleet, ladder)
		close(done)
	}()
	t.Cleanup(func() {
		cancel()
		<-done
	})

	deadline := time.Now().Add(2 * time.Second)
	for {
		if sample, ok := fleet.getObservedMemory("heavy"); ok {
			if sample.bytes != 3221225472 {
				t.Fatalf("observed sample = %v, want 3221225472", sample.bytes)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("degradation ladder refresher never populated the fleet's observed-memory cache")
		}
		time.Sleep(5 * time.Millisecond)
	}
	if got := testutil.ToFloat64(laneObservedMemoryP95Gauge.WithLabelValues("heavy")); got != 3221225472 {
		t.Errorf("lane_observed_memory_p95_bytes = %v, want 3221225472", got)
	}
}

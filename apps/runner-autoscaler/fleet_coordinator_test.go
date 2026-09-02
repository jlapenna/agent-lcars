package main

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/prometheus/client_golang/prometheus/testutil"
)

func TestFleetReservationMakesHostLimitAtomicAcrossScalers(t *testing.T) {
	fake := newFakeDockerServer(t)
	fake.setContainers([]container.Summary{})
	host := DockerHost{Name: "janeway", Client: fake.client(t)}
	fleet := newFleetCoordinator(24, map[string]int{"janeway": 1},
		map[string]int{"default": 1, "e2e": 1}, nil, []string{"default", "e2e"})
	newScaler := func(name string) *Scaler {
		return &Scaler{
			scaleSetName: name, maxRunners: 8, dockerHosts: []DockerHost{host},
			logger:           slog.Default(),
			hostRunnerLimits: fleet.hostRunnerLimits,
			runners:          runnerState{idle: map[string]runnerRef{}, busy: map[string]runnerRef{}},
			fleet:            fleet,
		}
	}
	first, err := fleet.reserve(context.Background(), newScaler("default"), "test-runner-1")
	if err != nil {
		t.Fatal(err)
	}
	defer first.release("default")
	if _, err := fleet.reserve(context.Background(), newScaler("e2e"), "test-runner-2"); err == nil {
		t.Fatal("second scaler reserved janeway despite runner_limit=1")
	}
}

func TestFleetReservationEnforcesGlobalLimit(t *testing.T) {
	fake := newFakeDockerServer(t)
	fake.setContainers([]container.Summary{})
	host := DockerHost{Name: "host", Client: fake.client(t)}
	fleet := newFleetCoordinator(1, nil,
		map[string]int{"a": 1, "b": 1}, nil, []string{"a", "b"})
	newScaler := func(name string) *Scaler {
		return &Scaler{
			scaleSetName: name, maxRunners: 1, dockerHosts: []DockerHost{host}, logger: slog.Default(),
			runners: runnerState{idle: map[string]runnerRef{}, busy: map[string]runnerRef{}}, fleet: fleet,
		}
	}
	reservation, err := fleet.reserve(context.Background(), newScaler("a"), "test-runner-3")
	if err != nil {
		t.Fatal(err)
	}
	defer reservation.release("a")
	if _, err := fleet.reserve(context.Background(), newScaler("b"), "test-runner-4"); err == nil {
		t.Fatal("second reservation exceeded fleet max_runners=1")
	}
}

func TestFleetReservationProtectsOneRunnerForHigherPriorityDemand(t *testing.T) {
	fake := newFakeDockerServer(t)
	fake.setContainers([]container.Summary{})
	host := DockerHost{Name: "host", Client: fake.client(t)}
	fleet := newFleetCoordinator(2, map[string]int{"host": 2},
		map[string]int{"default": 1, "protected": 1},
		map[string]int{"default": 0, "protected": 10},
		[]string{"default", "protected"})
	newScaler := func(name string) *Scaler {
		return &Scaler{
			scaleSetName: name, maxRunners: 2, dockerHosts: []DockerHost{host}, logger: slog.Default(),
			runners: runnerState{idle: map[string]runnerRef{}, busy: map[string]runnerRef{}}, fleet: fleet,
		}
	}

	fleet.updateDemand("protected", 2, 0, time.Unix(100, 0))
	if _, err := fleet.reserve(context.Background(), newScaler("default"), "test-runner-5"); !errors.Is(err, errFleetAtCapacity) {
		t.Fatalf("ordinary reservation error = %v, want capacity deferral", err)
	}

	protected, err := fleet.reserve(context.Background(), newScaler("protected"), "test-runner-6")
	if err != nil {
		t.Fatal(err)
	}
	// One active protected runner satisfies the minimum-service reservation;
	// its second pending job must not monopolize the other fleet slot.
	fleet.updateDemand("protected", 1, 1, time.Unix(101, 0))
	protected.release("protected")
	ordinary, err := fleet.reserve(context.Background(), newScaler("default"), "test-runner-7")
	if err != nil {
		t.Fatalf("ordinary reservation after protected service = %v", err)
	}
	ordinary.release("default")
}

// TestFleetReservationProceedsWhenProtectedLaneHasSpareCapacity is
// agent-lcars#1718's headline fix: a higher-priority lane merely having
// pending demand and no runner of its own must not, by itself, refuse a
// lower-priority placement -- only actually running out of admissible slots
// for the protected lane may. Registering "protected"'s own Scaler with the
// fleet (registerScaler) is what lets reserve evaluate its real capacity
// instead of failing closed on an unknown lane.
func TestFleetReservationProceedsWhenProtectedLaneHasSpareCapacity(t *testing.T) {
	fake := newFakeDockerServer(t)
	fake.setContainers([]container.Summary{})
	host := DockerHost{Name: "host", Client: fake.client(t)}
	fleet := newFleetCoordinator(10, map[string]int{"host": 5},
		map[string]int{"default": 1, "protected": 1},
		map[string]int{"default": 0, "protected": 10},
		[]string{"default", "protected"})
	newScaler := func(name string) *Scaler {
		return &Scaler{
			scaleSetName: name, maxRunners: 10, dockerHosts: []DockerHost{host}, logger: slog.Default(),
			runners: runnerState{idle: map[string]runnerRef{}, busy: map[string]runnerRef{}}, fleet: fleet,
		}
	}
	fleet.registerScaler(newScaler("protected"))
	fleet.updateDemand("protected", 1, 0, time.Unix(200, 0))

	refusals := priorityReservationRefusalsTotal.WithLabelValues("default", "protected")
	before := testutil.ToFloat64(refusals)

	reservation, err := fleet.reserve(context.Background(), newScaler("default"), "test-runner-plenty")
	if err != nil {
		t.Fatalf("reserve() = %v, want the lower-priority placement to proceed: host_limit=5 leaves 4 admissible slots for protected even after this placement", err)
	}
	reservation.release("default")

	if got := testutil.ToFloat64(refusals) - before; got != 0 {
		t.Fatalf("priority_reservation_refusals_total rose by %v, want 0 (plenty of admissible slots remained for protected)", got)
	}
}

// TestFleetReservationRefusedWhenItWouldTakeProtectedLanesLastSlot is the gate's
// other edge, symmetric with the spare-capacity case above: when the
// protected lane has exactly one admissible slot fleet-wide, this placement
// taking it really would leave the protected lane with none, so the refusal
// (and its dedicated counter, agent-lcars#1718) is warranted.
func TestFleetReservationRefusedWhenItWouldTakeProtectedLanesLastSlot(t *testing.T) {
	fake := newFakeDockerServer(t)
	fake.setContainers([]container.Summary{})
	host := DockerHost{Name: "host", Client: fake.client(t)}
	fleet := newFleetCoordinator(10, map[string]int{"host": 1},
		map[string]int{"default": 1, "protected": 1},
		map[string]int{"default": 0, "protected": 10},
		[]string{"default", "protected"})
	newScaler := func(name string) *Scaler {
		return &Scaler{
			scaleSetName: name, maxRunners: 10, dockerHosts: []DockerHost{host}, logger: slog.Default(),
			runners: runnerState{idle: map[string]runnerRef{}, busy: map[string]runnerRef{}}, fleet: fleet,
		}
	}
	fleet.registerScaler(newScaler("protected"))
	fleet.updateDemand("protected", 1, 0, time.Unix(200, 0))

	refusals := priorityReservationRefusalsTotal.WithLabelValues("default", "protected")
	before := testutil.ToFloat64(refusals)

	if _, err := fleet.reserve(context.Background(), newScaler("default"), "test-runner-last-slot"); !errors.Is(err, errFleetAtCapacity) {
		t.Fatalf("reserve() error = %v, want capacity deferral: host_limit=1 means this placement takes protected's only admissible slot", err)
	}

	if got := testutil.ToFloat64(refusals) - before; got != 1 {
		t.Fatalf("priority_reservation_refusals_total{scale_set=\"default\",protected=\"protected\"} rose by %v, want 1", got)
	}
}

// TestFleetReservationAllowsLowerPriorityPlacementWithFleetWideCapacity is
// the regression test for the 2026-09-02 15:51:51 UTC incident
// (agent-lcars#1718): homelab-autoscale-control's 2 GiB runner request was
// refused for 90 s while 15 admissible slots sat free fleet-wide, because
// reserve's priority-reservation gate refused ANY lower-priority placement
// whenever a higher-priority lane had pending demand and no runner of its
// own -- never checking whether the fleet could actually serve both. Four
// hosts each carry about 20 GiB of free budget and the protected lane only
// reserves 6 GiB per runner, so taking one 2 GiB slot for the lower-priority
// lane cannot come close to exhausting the protected lane's admissible
// slots. This fails against the pre-fix gate (which refuses unconditionally
// the moment a higher-priority lane is short a runner) and passes once the
// gate consults laneAdmissibleSlotsOverHosts before refusing.
func TestFleetReservationAllowsLowerPriorityPlacementWithFleetWideCapacity(t *testing.T) {
	var hosts []DockerHost
	for _, name := range []string{"host-a", "host-b", "host-c", "host-d"} {
		fake := newFakeDockerServer(t)
		fake.setMemoryTotal(20 * gibibyte)
		fake.setContainers([]container.Summary{})
		hosts = append(hosts, DockerHost{Name: name, Client: fake.client(t)})
	}
	fleet := newFleetCoordinator(50, nil,
		map[string]int{"control": 1, "ci": 1},
		map[string]int{"control": 0, "ci": 10},
		[]string{"control", "ci"})
	newScaler := func(name string, runnerMemory int64) *Scaler {
		return &Scaler{
			scaleSetName: name, maxRunners: 50, runnerMemory: runnerMemory,
			dockerHosts: hosts, logger: slog.Default(),
			runners: runnerState{idle: map[string]runnerRef{}, busy: map[string]runnerRef{}}, fleet: fleet,
		}
	}
	fleet.registerScaler(newScaler("ci", 6*gibibyte))
	fleet.updateDemand("ci", 1, 0, time.Unix(1788364311, 0)) // 2026-09-02T15:51:51Z

	reservation, err := fleet.reserve(context.Background(), newScaler("control", 2*gibibyte), "control-runner")
	if err != nil {
		t.Fatalf("reserve() = %v, want the 2 GiB control-lane placement to proceed: four hosts with ~20 GiB free budget each is nowhere near exhausted by a 6 GiB protected reservation", err)
	}
	reservation.release("control")
}

func TestFleetDemandPublishesUninterruptedPendingTimestamp(t *testing.T) {
	fleet := newFleetCoordinator(1, nil, nil, nil, nil)
	label := "pending-timestamp-test"
	first := time.Unix(1234, 0)
	fleet.updateDemand(label, 2, 0, first)
	if got := testutil.ToFloat64(pendingSinceTimestampGauge.WithLabelValues(label)); got != 1234 {
		t.Fatalf("pending timestamp = %v, want 1234", got)
	}
	fleet.updateDemand(label, 1, 0, time.Unix(9999, 0))
	if got := testutil.ToFloat64(pendingSinceTimestampGauge.WithLabelValues(label)); got != 1234 {
		t.Fatalf("uninterrupted pending timestamp = %v, want original 1234", got)
	}
	fleet.updateDemand(label, 0, 0, time.Unix(10000, 0))
	if got := testutil.ToFloat64(pendingSinceTimestampGauge.WithLabelValues(label)); got != 0 {
		t.Fatalf("cleared pending timestamp = %v, want 0", got)
	}
}

func TestRetiredHostIsCordonedFromNewPlacements(t *testing.T) {
	retired := newFakeDockerServer(t)
	active := newFakeDockerServer(t)
	retired.setContainers([]container.Summary{})
	active.setContainers([]container.Summary{})
	retiredHost := DockerHost{Name: "retired", Client: retired.client(t)}
	activeHost := DockerHost{Name: "active", Client: active.client(t)}
	fleet := newFleetCoordinator(2, nil, map[string]int{"set": 1}, nil, []string{"set"})
	scaler := &Scaler{
		scaleSetName: "set", maxRunners: 2,
		dockerHosts: []DockerHost{activeHost, retiredHost}, placementHosts: []DockerHost{activeHost},
		logger: slog.Default(), runners: runnerState{idle: map[string]runnerRef{}, busy: map[string]runnerRef{}}, fleet: fleet,
	}
	host, err := scaler.pickHost(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if host != "active" {
		t.Fatalf("placement host = %q, want active; retired hosts must be cordoned", host)
	}
}

// TestFleetReservationsAreAtomicUnderConcurrentGoroutines is the homelab#97
// regression test for the race the multi-registration design introduces:
// with N registrations' listeners now calling fleet.reserve concurrently
// (previously each registration's scale-up was strictly serial), two
// concurrent callers reading the same "host X has fewest" snapshot before
// either commits its pick could both place there and oversubscribe it.
// Every worker holds its reservation open for a moment after reserve()
// returns -- standing in for the slow JIT/container-create work a real
// startRunner does before releasing -- so overlapping holds across
// goroutines are actually exercised, not just serial calls like the tests
// above. Run with `go test -race` to also catch any unsynchronized access to
// the coordinator's shared maps.
func TestFleetReservationsAreAtomicUnderConcurrentGoroutines(t *testing.T) {
	fake := newFakeDockerServer(t)
	fake.setContainers([]container.Summary{})
	hostA := DockerHost{Name: "host-a", Client: fake.client(t)}
	hostB := DockerHost{Name: "host-b", Client: fake.client(t)}
	const fleetMax = 50 // effectively unbounded; the invariant under test is per-host exclusivity, not this cap.
	fleet := newFleetCoordinator(fleetMax, nil,
		map[string]int{"set-a": 1, "set-b": 1}, nil, []string{"set-a", "set-b"})
	newScaler := func(name string) *Scaler {
		return &Scaler{
			scaleSetName: name, maxRunners: fleetMax,
			dockerHosts: []DockerHost{hostA, hostB}, logger: slog.Default(),
			runners: runnerState{idle: map[string]runnerRef{}, busy: map[string]runnerRef{}},
			fleet:   fleet,
		}
	}

	var mu sync.Mutex
	live, peak := map[string]int{}, map[string]int{}
	record := func(host string, delta int) {
		mu.Lock()
		defer mu.Unlock()
		live[host] += delta
		if live[host] > peak[host] {
			peak[host] = live[host]
		}
	}

	const workers, itersPerWorker = 8, 5
	var wg sync.WaitGroup
	var successes int64
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			name := "set-a"
			if w%2 == 1 {
				name = "set-b"
			}
			for i := 0; i < itersPerWorker; i++ {
				r, err := fleet.reserve(context.Background(), newScaler(name), "test-runner-8")
				if err != nil {
					continue // every host momentarily in-flight elsewhere; not an error under test.
				}
				atomic.AddInt64(&successes, 1)
				record(r.host, 1)
				// Stand-in for the slow JIT-generate/ContainerCreate/Start
				// work a real startRunner does before releasing -- gives
				// concurrent holds on DIFFERENT hosts a real chance to
				// overlap in wall-clock time.
				time.Sleep(2 * time.Millisecond)
				record(r.host, -1)
				r.release(name)
			}
		}(w)
	}
	wg.Wait()

	if successes == 0 {
		t.Fatal("no reservation ever succeeded; test is not exercising anything")
	}
	// The exact invariant this closes (homelab#97): a host can never have
	// more than one reservation concurrently held, because pick-then-reserve
	// is atomic under the shared coordinator's lock/gate -- two overlapping
	// callers can never both observe "host X has fewest" and both commit to
	// it before the other's reservation is recorded.
	for host, p := range peak {
		if p > 1 {
			t.Fatalf("host %q had %d reservations concurrently held at once, want <= 1 (the exact double-placement race homelab#97 closes)", host, p)
		}
	}
	if got := fleet.reservations["host-a"] + fleet.reservations["host-b"]; got != 0 {
		t.Fatalf("reservations not fully released after test: %#v", fleet.reservations)
	}
}

func TestWeightedPlacementGateAlternatesWaitingScaleSets(t *testing.T) {
	gate := newWeightedPlacementGate(map[string]int{"a": 1, "b": 1}, []string{"a", "b"})
	releaseA, err := gate.acquire(context.Background(), "a")
	if err != nil {
		t.Fatal(err)
	}
	got := make(chan string, 2)
	go func() {
		release, acquireErr := gate.acquire(context.Background(), "a")
		if acquireErr == nil {
			got <- "a"
			release()
		}
	}()
	go func() {
		release, acquireErr := gate.acquire(context.Background(), "b")
		if acquireErr == nil {
			got <- "b"
			release()
		}
	}()
	waitForGateWaiters(t, gate, "a", "b")
	releaseA()
	// Both were pending when the active turn ended, so the cursor must hand
	// the next turn to b before returning to a.
	if first := <-got; first != "b" {
		t.Fatalf("first waiter = %q, want b", first)
	}
	if second := <-got; second != "a" {
		t.Fatalf("second waiter = %q, want a", second)
	}
}

func waitForGateWaiters(t *testing.T, gate *weightedPlacementGate, names ...string) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		gate.mu.Lock()
		ready := true
		for _, name := range names {
			ready = ready && len(gate.waiters[name]) > 0
		}
		gate.mu.Unlock()
		if ready {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("timed out waiting for gate waiters")
}

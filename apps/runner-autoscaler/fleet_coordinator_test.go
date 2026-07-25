package main

import (
	"context"
	"log/slog"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/docker/docker/api/types/container"
)

func TestFleetReservationMakesHostLimitAtomicAcrossScalers(t *testing.T) {
	fake := newFakeDockerServer(t)
	fake.setContainers([]container.Summary{})
	host := DockerHost{Name: "janeway", Client: fake.client(t)}
	fleet := newFleetCoordinator(24, map[string]int{"janeway": 1}, nil, nil,
		map[string]int{"default": 1, "e2e": 1}, []string{"default", "e2e"})
	newScaler := func(name string) *Scaler {
		return &Scaler{
			scaleSetName: name, maxRunners: 8, dockerHosts: []DockerHost{host},
			logger:           slog.Default(),
			hostRunnerLimits: fleet.hostRunnerLimits,
			runners:          runnerState{idle: map[string]runnerRef{}, busy: map[string]runnerRef{}},
			fleet:            fleet,
		}
	}
	first, err := fleet.reserve(context.Background(), newScaler("default"))
	if err != nil {
		t.Fatal(err)
	}
	defer first.release("default")
	if _, err := fleet.reserve(context.Background(), newScaler("e2e")); err == nil {
		t.Fatal("second scaler reserved janeway despite runner_limit=1")
	}
}

func TestFleetReservationEnforcesGlobalLimit(t *testing.T) {
	fake := newFakeDockerServer(t)
	fake.setContainers([]container.Summary{})
	host := DockerHost{Name: "host", Client: fake.client(t)}
	fleet := newFleetCoordinator(1, nil, nil, nil,
		map[string]int{"a": 1, "b": 1}, []string{"a", "b"})
	newScaler := func(name string) *Scaler {
		return &Scaler{
			scaleSetName: name, maxRunners: 1, dockerHosts: []DockerHost{host}, logger: slog.Default(),
			runners: runnerState{idle: map[string]runnerRef{}, busy: map[string]runnerRef{}}, fleet: fleet,
		}
	}
	reservation, err := fleet.reserve(context.Background(), newScaler("a"))
	if err != nil {
		t.Fatal(err)
	}
	defer reservation.release("a")
	if _, err := fleet.reserve(context.Background(), newScaler("b")); err == nil {
		t.Fatal("second reservation exceeded fleet max_runners=1")
	}
}

func TestSocketPlacementRejectsOtherSetsSharedWorkdirRunner(t *testing.T) {
	fake := newFakeDockerServer(t)
	fake.setContainers([]container.Summary{{
		ID: "existing", State: container.StateRunning,
		Labels: map[string]string{runnerScaleSetLabelKey: "other", runnerSharedWorkDirLabelKey: "true"},
	}})
	host := DockerHost{Name: "host", Client: fake.client(t)}
	fleet := newFleetCoordinator(4, nil, nil, map[string]string{"host": "1"},
		map[string]int{"e2e": 1}, []string{"e2e"})
	scaler := &Scaler{
		scaleSetName: "e2e", maxRunners: 1, mountDockerSocket: true,
		dockerHosts: []DockerHost{host}, logger: slog.Default(),
		runners: runnerState{idle: map[string]runnerRef{}, busy: map[string]runnerRef{}}, fleet: fleet,
	}
	if _, err := fleet.reserve(context.Background(), scaler); err == nil {
		t.Fatal("socket placement overlapped another set's shared-workdir runner")
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
	fleet := newFleetCoordinator(fleetMax, nil, nil, nil,
		map[string]int{"set-a": 1, "set-b": 1}, []string{"set-a", "set-b"})
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
				r, err := fleet.reserve(context.Background(), newScaler(name))
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

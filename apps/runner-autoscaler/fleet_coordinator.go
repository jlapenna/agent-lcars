package main

import (
	"context"
	"fmt"
	"sync"
	"time"
)

// FleetCoordinator is the single authority for capacity shared by every
// scale-set listener in this process. Reservations close the count/create
// race without serializing slow image/JIT/container work across hosts.
type FleetCoordinator struct {
	mu           sync.Mutex
	maxRunners   int
	reservations map[string]int
	// sharedWorkDirReservations: hosts with an in-flight placement from a
	// scale set that shares the host workdir. Tracks occupancy of the
	// CHECKOUT, not possession of docker.sock -- see Config.ShareWorkDir.
	sharedWorkDirReservations map[string]int
	startInFlight             map[string]bool
	lastFleetCounts           map[string]int
	dockerSocketGIDs          map[string]string
	workDirSizeCaps           map[string]int64
	hostRunnerLimits          map[string]int
	mainsRequired             map[string]bool
	metricsViaSSH             map[string]bool
	gate                      *weightedPlacementGate

	hostSampleMu     sync.Mutex
	hostSamples      map[string]hostSample
	hostLoadCache    map[string]hostLoad
	overloadMu       sync.Mutex
	overloadedUntil  map[string]time.Time
	placementMu      sync.Mutex
	placementCursor  int
	hostWorkDirLocks sync.Map
}

// hostReservation tracks one in-flight placement decision so its release
// (on success or failure) always decrements the matching reservation/socket
// counters exactly once, even if release is called from multiple defers.
type hostReservation struct {
	fleet         *FleetCoordinator
	host          string
	sharedWorkDir bool
	once          sync.Once
}

func newFleetCoordinator(maxRunners int, limits map[string]int, workCaps map[string]int64, socketGIDs map[string]string, weights map[string]int, order []string) *FleetCoordinator {
	return &FleetCoordinator{
		maxRunners:   maxRunners,
		reservations: map[string]int{}, sharedWorkDirReservations: map[string]int{}, startInFlight: map[string]bool{}, lastFleetCounts: map[string]int{},
		hostRunnerLimits: limits, workDirSizeCaps: workCaps, dockerSocketGIDs: socketGIDs, mainsRequired: map[string]bool{}, metricsViaSSH: map[string]bool{},
		hostSamples: map[string]hostSample{}, hostLoadCache: map[string]hostLoad{}, overloadedUntil: map[string]time.Time{},
		gate: newWeightedPlacementGate(weights, order),
	}
}

func (f *FleetCoordinator) reserve(ctx context.Context, scaler *Scaler) (*hostReservation, error) {
	releaseTurn, err := f.gate.acquire(ctx, scaler.scaleSetName)
	if err != nil {
		return nil, err
	}
	defer releaseTurn()

	// The lock covers the authoritative Docker recount and reservation update.
	// It is released before JIT generation/container creation so starts on
	// different hosts remain concurrent.
	f.mu.Lock()
	defer f.mu.Unlock()
	host, err := scaler.pickHostLocked(ctx, f)
	if err != nil {
		return nil, err
	}
	f.reservations[host]++
	f.startInFlight[host] = true
	if scaler.shareWorkDir {
		f.sharedWorkDirReservations[host]++
	}
	reservationGauge.WithLabelValues(scaler.scaleSetName, host).Inc()
	return &hostReservation{fleet: f, host: host, sharedWorkDir: scaler.shareWorkDir}, nil
}

func (r *hostReservation) release(scaleSet string) {
	if r == nil || r.fleet == nil {
		return
	}
	r.once.Do(func() {
		r.fleet.mu.Lock()
		if r.fleet.reservations[r.host] > 0 {
			r.fleet.reservations[r.host]--
		}
		if r.sharedWorkDir && r.fleet.sharedWorkDirReservations[r.host] > 0 {
			r.fleet.sharedWorkDirReservations[r.host]--
		}
		r.fleet.startInFlight[r.host] = false
		r.fleet.mu.Unlock()
		reservationGauge.WithLabelValues(scaleSet, r.host).Dec()
	})
}

func (f *FleetCoordinator) socketGID(host string) (string, error) {
	gid := f.dockerSocketGIDs[host]
	if gid == "" {
		return "", fmt.Errorf("host %q has no configured docker socket GID", host)
	}
	return gid, nil
}

// weightedPlacementGate serializes only host selection/reservation and picks
// waiting scale sets in deterministic weighted round-robin order.
type weightedPlacementGate struct {
	mu      sync.Mutex
	active  bool
	order   []string
	cursor  int
	waiters map[string][]chan struct{}
}

func newWeightedPlacementGate(weights map[string]int, scaleSetOrder []string) *weightedPlacementGate {
	g := &weightedPlacementGate{waiters: map[string][]chan struct{}{}}
	for _, name := range scaleSetOrder {
		weight := weights[name]
		if weight < 1 {
			weight = 1
		}
		for range weight {
			g.order = append(g.order, name)
		}
	}
	return g
}

func (g *weightedPlacementGate) acquire(ctx context.Context, scaleSet string) (func(), error) {
	if g == nil || len(g.order) == 0 {
		return func() {}, nil
	}
	ready := make(chan struct{})
	g.mu.Lock()
	g.waiters[scaleSet] = append(g.waiters[scaleSet], ready)
	g.dispatchLocked()
	g.mu.Unlock()

	select {
	case <-ready:
		return func() {
			g.mu.Lock()
			g.active = false
			g.dispatchLocked()
			g.mu.Unlock()
		}, nil
	case <-ctx.Done():
		g.mu.Lock()
		queue := g.waiters[scaleSet]
		removed := false
		for i, ch := range queue {
			if ch == ready {
				g.waiters[scaleSet] = append(queue[:i], queue[i+1:]...)
				removed = true
				break
			}
		}
		// If it was no longer queued, dispatch had granted the turn at the
		// same instant cancellation won the select. Release that active turn
		// here so the gate cannot remain wedged forever.
		if !removed {
			g.active = false
			g.dispatchLocked()
		}
		g.mu.Unlock()
		return nil, ctx.Err()
	}
}

func (g *weightedPlacementGate) dispatchLocked() {
	if g.active || len(g.order) == 0 {
		return
	}
	for range len(g.order) {
		name := g.order[g.cursor%len(g.order)]
		g.cursor = (g.cursor + 1) % len(g.order)
		queue := g.waiters[name]
		if len(queue) == 0 {
			continue
		}
		g.waiters[name] = queue[1:]
		g.active = true
		close(queue[0])
		return
	}
}

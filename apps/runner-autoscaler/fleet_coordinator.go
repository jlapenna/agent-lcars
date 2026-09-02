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
	mu                sync.Mutex
	maxRunners        int
	reservations      map[string]int
	reservedMemory    map[string]int64
	startInFlight     map[string]bool
	scaleSetDemand    map[string]schedulerDemand
	priorities        map[string]int
	lastFleetCounts   map[string]int
	hostRunnerLimits  map[string]int
	mainsRequired     map[string]bool
	metricsViaSSH     map[string]bool
	readinessRequired map[string]bool
	// hostRoles is every configured fleet host's resolved role (permanent,
	// opportunistic, or maintenance; empty reads as permanent for the
	// zero-value/single-scaler test path) -- see hostRolePermanent and
	// probeFleetHosts' maintenance exclusion (agent-lcars#1696).
	hostRoles map[string]string
	gate      *weightedPlacementGate

	hostSampleMu    sync.Mutex
	hostSamples     map[string]hostSample
	hostLoadCache   map[string]hostLoad
	overloadMu      sync.Mutex
	overloadedUntil map[string]time.Time
	placementMu     sync.Mutex
	placementCursor int
}

type schedulerDemand struct {
	pending      int
	active       int
	reservations int
	pendingSince time.Time
}

// hostReservation tracks one in-flight placement decision so its release
// (on success or failure) always decrements the matching reservation counter
// exactly once, even if release is called from multiple defers.
type hostReservation struct {
	fleet  *FleetCoordinator
	host   string
	memory int64
	once   sync.Once
}

func newFleetCoordinator(maxRunners int, limits map[string]int, weights, priorities map[string]int, order []string) *FleetCoordinator {
	return &FleetCoordinator{
		maxRunners:   maxRunners,
		reservations: map[string]int{}, reservedMemory: map[string]int64{}, startInFlight: map[string]bool{},
		scaleSetDemand: map[string]schedulerDemand{}, priorities: priorities, lastFleetCounts: map[string]int{},
		hostRunnerLimits: limits, mainsRequired: map[string]bool{}, metricsViaSSH: map[string]bool{}, readinessRequired: map[string]bool{},
		hostRoles:   map[string]string{},
		hostSamples: map[string]hostSample{}, hostLoadCache: map[string]hostLoad{}, overloadedUntil: map[string]time.Time{},
		gate: newWeightedPlacementGate(weights, order),
	}
}

// updateDemand persists the listener's latest runner deficit between GitHub
// callbacks. The weighted gate can only order callers that happen to wait at
// the same instant; this state lets reserve protect one service slot for a
// higher-priority lane even while that lane is between retry callbacks.
func (f *FleetCoordinator) updateDemand(scaleSet string, pending, active int, now time.Time) {
	if f == nil {
		return
	}
	f.mu.Lock()
	demand := f.scaleSetDemand[scaleSet]
	if pending > 0 && demand.pending == 0 {
		demand.pendingSince = now
	}
	if pending == 0 {
		demand.pendingSince = time.Time{}
	}
	demand.pending = max(0, pending)
	demand.active = max(0, active)
	f.scaleSetDemand[scaleSet] = demand
	f.mu.Unlock()

	pendingRunnersGauge.WithLabelValues(scaleSet).Set(float64(demand.pending))
	if demand.pendingSince.IsZero() {
		pendingSinceTimestampGauge.WithLabelValues(scaleSet).Set(0)
	} else {
		pendingSinceTimestampGauge.WithLabelValues(scaleSet).Set(float64(demand.pendingSince.Unix()))
	}
}

// higherPriorityDemandLocked returns a higher-priority scale set that still
// needs its minimum service share. One active or in-flight runner satisfies
// that share, so ordinary/default work can keep using every remaining slot;
// this is not strict priority and cannot monopolize the fleet.
func (f *FleetCoordinator) higherPriorityDemandLocked(scaleSet string) string {
	priority := f.priorities[scaleSet]
	winner := ""
	winnerPriority := priority
	for name, demand := range f.scaleSetDemand {
		candidatePriority := f.priorities[name]
		if candidatePriority <= priority || demand.pending == 0 || demand.active+demand.reservations > 0 {
			continue
		}
		if candidatePriority > winnerPriority || (candidatePriority == winnerPriority && (winner == "" || name < winner)) {
			winner = name
			winnerPriority = candidatePriority
		}
	}
	return winner
}

// snapshot records the fleet telemetry a restart cannot re-derive instantly.
// Both halves are rate/deadline state, not inventory: overload cooldowns
// otherwise reset to zero and make a host that was hard-overloaded seconds
// ago immediately placeable again, and host samples otherwise leave the first
// probe after boot with no previous counter reading, so CPU-utilization, PSI
// and swap RATES all compute as zero and pressure-based admission is
// effectively disabled until a second sample lands.
func (f *FleetCoordinator) snapshot() checkpointFleet {
	out := checkpointFleet{
		OverloadedUntil: map[string]time.Time{},
		HostSamples:     map[string]checkpointHostSample{},
	}
	f.overloadMu.Lock()
	for host, until := range f.overloadedUntil {
		out.OverloadedUntil[host] = until
	}
	f.overloadMu.Unlock()

	f.hostSampleMu.Lock()
	for host, s := range f.hostSamples {
		out.HostSamples[host] = checkpointHostSample{
			At: s.at, IdleSeconds: s.idleSeconds, CPUPressure: s.cpuPressure,
			MemoryPressure: s.memoryPressure, SwapPages: s.swapPages,
		}
	}
	f.hostSampleMu.Unlock()
	return out
}

// restore reapplies a checkpointed fleet snapshot. Expired cooldowns are
// dropped rather than restored -- a deadline already in the past would only
// add work for the next placement to discard -- and samples are restored
// verbatim so the first post-boot probe computes a real rate against them.
func (f *FleetCoordinator) restore(cp checkpointFleet, now time.Time) {
	f.overloadMu.Lock()
	for host, until := range cp.OverloadedUntil {
		if until.After(now) {
			f.overloadedUntil[host] = until
		}
	}
	f.overloadMu.Unlock()

	f.hostSampleMu.Lock()
	for host, s := range cp.HostSamples {
		f.hostSamples[host] = hostSample{
			at: s.At, idleSeconds: s.IdleSeconds, cpuPressure: s.CPUPressure,
			memoryPressure: s.MemoryPressure, swapPages: s.SwapPages,
		}
	}
	f.hostSampleMu.Unlock()
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
	scaleSet := scaler.scaleSetLabel()
	if protected := f.higherPriorityDemandLocked(scaleSet); protected != "" {
		// Fleet-level: a scheduler decision to protect another scale set's
		// share, not any host refusing this one.
		placementBlocked.WithLabelValues(scaleSet, "", placementReasonPriorityReservation).Inc()
		return nil, fmt.Errorf("%w: reserving the next safe slot for higher-priority scale set %q", errFleetAtCapacity, protected)
	}
	host, err := scaler.pickHostLocked(ctx, f)
	if err != nil {
		return nil, err
	}
	f.reservations[host]++
	f.reservedMemory[host] += scaler.memoryReservation()
	f.startInFlight[host] = true
	demand := f.scaleSetDemand[scaleSet]
	demand.reservations++
	f.scaleSetDemand[scaleSet] = demand
	reservationGauge.WithLabelValues(scaleSet, host).Inc()
	return &hostReservation{fleet: f, host: host, memory: scaler.memoryReservation()}, nil
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
		if r.memory > 0 {
			r.fleet.reservedMemory[r.host] -= r.memory
			if r.fleet.reservedMemory[r.host] < 0 {
				r.fleet.reservedMemory[r.host] = 0
			}
		}
		r.fleet.startInFlight[r.host] = false
		demand := r.fleet.scaleSetDemand[scaleSet]
		if demand.reservations > 0 {
			demand.reservations--
		}
		r.fleet.scaleSetDemand[scaleSet] = demand
		r.fleet.mu.Unlock()
		reservationGauge.WithLabelValues(scaleSet, r.host).Dec()
	})
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

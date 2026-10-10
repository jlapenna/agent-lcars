package main

import (
	"context"
	"fmt"
	"log/slog"
	"math"
	"sync"
	"sync/atomic"
	"time"

	dto "github.com/prometheus/client_model/go"
)

// queueExecutorStatusSource reports operational health for the one direct
// queue executor. It is intentionally separate from Run lifecycle state:
// queued/claimed/running counts are server-authoritative orchestrator data,
// while this source can truthfully report only whether this host-side worker
// is ready, draining, and how many unfinished queue Jobs the Kubernetes inventory currently shows.
type queueExecutorStatusSource struct {
	ready         atomic.Bool
	draining      func() bool
	mu            sync.RWMutex
	maxConcurrent int
	activeRuns    func(context.Context) (int, error)
	logger        *slog.Logger
	claimCounters func() ([3]uint64, error)
	claimSamples  []queueClaimSample
}

type queueClaimSample struct {
	at     time.Time
	counts [3]uint64
}

// Both Prometheus's float64 counters and the Console's JavaScript reader
// must retain exact integer values across the signed Firestore boundary.
const maxQueueClaimCounter = uint64(1<<53 - 1)

func newConsoleClaimWindow(counts [3]uint64, start, end time.Time) *consoleClaimWindow {
	for _, count := range counts {
		if count > maxQueueClaimCounter {
			return nil
		}
	}
	return &consoleClaimWindow{
		Claude: int64(counts[0]), Codex: int64(counts[1]), OpenCode: int64(counts[2]),
		WindowStart: start.UTC().Format(time.RFC3339Nano), WindowEnd: end.UTC().Format(time.RFC3339Nano),
	}
}

func newQueueExecutorStatusSource(
	draining func() bool,
	logger *slog.Logger,
) *queueExecutorStatusSource {
	return &queueExecutorStatusSource{
		draining:      draining,
		logger:        logger,
		claimCounters: currentQueueClaimCounters,
	}
}

// configureCapacity is called exactly once, before ready becomes true, with
// the backend's own capacity and active-attempt count.
func (s *queueExecutorStatusSource) configureCapacity(capacity int, count func(context.Context) (int, error)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.maxConcurrent = capacity
	s.activeRuns = count
}

func (s *queueExecutorStatusSource) snapshot(ctx context.Context, now time.Time) consoleQueueExecutorStatus {
	ready := s.ready.Load()
	status := consoleQueueExecutorStatus{
		SchemaVersion: 2,
		Kind:          "queue-executor",
		Executor:      "queue",
		Ready:         ready,
		Draining:      s.draining != nil && s.draining(),
		UpdatedAt:     now.UTC().Format(time.RFC3339Nano),
		ExpireAt:      now.Add(consoleStatusTTL),
	}
	if !ready {
		return status
	}
	s.mu.RLock()
	maxConcurrent := s.maxConcurrent
	activeRuns := s.activeRuns
	s.mu.RUnlock()
	status.MaxConcurrent = maxConcurrent
	status.Claims = s.claimWindow(now)
	if activeRuns == nil {
		return status
	}
	countCtx, cancel := context.WithTimeout(ctx, consoleStatusTimeout)
	active, err := activeRuns(countCtx)
	cancel()
	if err != nil {
		// Omitting activeRuns is intentional: a partial backend inventory read must
		// never be rendered as a plausible zero. The timestamp still proves
		// the queue process itself remains alive and publishing.
		s.logger.Warn("Failed to count active queue attempts for console status", slog.Any("error", err))
		return status
	}
	status.ActiveRuns = &active
	return status
}

// Reading these three existing metric series does not touch the claim path,
// Firestore, or the network. A read/reset/gap is explicitly unavailable.
func currentQueueClaimCounters() ([3]uint64, error) {
	var counts [3]uint64
	for i, pipeline := range [3]string{"claude", "codex", "opencode"} {
		var metric dto.Metric
		if err := queueExecutorClaimsTotal.WithLabelValues(pipeline).Write(&metric); err != nil {
			return counts, err
		}
		value := metric.GetCounter().GetValue()
		if value < 0 || value > float64(maxQueueClaimCounter) || math.IsNaN(value) || math.IsInf(value, 0) || value != math.Trunc(value) {
			return counts, fmt.Errorf("invalid claim counter")
		}
		counts[i] = uint64(value)
	}
	return counts, nil
}

func (s *queueExecutorStatusSource) claimWindow(now time.Time) *consoleClaimWindow {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.claimCounters == nil {
		return nil
	}
	counts, err := s.claimCounters()
	if err != nil {
		s.claimSamples = nil
		return nil
	}
	if len(s.claimSamples) > 0 {
		previous := s.claimSamples[len(s.claimSamples)-1]
		if !now.After(previous.at) || now.Sub(previous.at) > consoleStatusTTL || counts[0] < previous.counts[0] || counts[1] < previous.counts[1] || counts[2] < previous.counts[2] {
			s.claimSamples = nil
		}
	}
	cutoff := now.Add(-15 * time.Minute)
	retained := s.claimSamples[:0]
	for _, sample := range s.claimSamples {
		if !sample.at.Before(cutoff) {
			retained = append(retained, sample)
		}
	}
	s.claimSamples = append(retained, queueClaimSample{at: now, counts: counts})
	// Production samples every ten seconds. Also bound memory for a caller
	// sampling faster than that contract.
	if len(s.claimSamples) > 92 {
		s.claimSamples = s.claimSamples[len(s.claimSamples)-92:]
	}
	first := s.claimSamples[0]
	if !now.After(first.at) {
		return nil
	}
	return newConsoleClaimWindow([3]uint64{counts[0] - first.counts[0], counts[1] - first.counts[1], counts[2] - first.counts[2]}, first.at, now)
}

// runQueueExecutorStatusPublisher shares the scale-set publisher's bounded
// collection and staleness contract, without participating in queue claims or
// backend launch decisions. A slow status read therefore cannot delay work.
func runQueueExecutorStatusPublisher(ctx context.Context, publisher consoleStatusPublisher, source *queueExecutorStatusSource) {
	if !publisher.Enabled() {
		return
	}
	publish := func() {
		publisher.PublishQueueExecutor(ctx, source.snapshot(ctx, time.Now()))
	}
	publish()
	ticker := time.NewTicker(consoleStatusInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			publish()
		}
	}
}

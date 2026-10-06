package main

import (
	"context"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"
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
}

func newQueueExecutorStatusSource(
	draining func() bool,
	logger *slog.Logger,
) *queueExecutorStatusSource {
	return &queueExecutorStatusSource{
		draining: draining,
		logger:   logger,
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

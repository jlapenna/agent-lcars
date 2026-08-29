package main

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/filters"
	dockerclient "github.com/docker/docker/client"
)

// queueExecutorStatusSource reports operational health for the one direct
// queue executor. It is intentionally separate from Run lifecycle state:
// queued/claimed/running counts are server-authoritative orchestrator data,
// while this source can truthfully report only whether this host-side worker
// is ready, draining, and how many direct containers Docker currently sees.
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

// configureEligibleHosts is called exactly once, before ready becomes true.
// Keeping the selected set here makes status capacity and active-run counts
// use the exact same host pool as the poller's launch callback.
func (s *queueExecutorStatusSource) configureEligibleHosts(resolved resolvedOrchestratorConfig, newClient func(string) (*dockerclient.Client, error)) {
	capacity := 0
	if _, hosts, err := ParseDockerHosts(resolved.DockerHosts); err == nil {
		capacity = len(hosts) * directRunnerMaxConcurrent()
	}
	s.mu.Lock()
	s.maxConcurrent = capacity
	s.activeRuns = func(ctx context.Context) (int, error) {
		return activeDirectRunnerCount(ctx, resolved, newClient)
	}
	s.mu.Unlock()
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
		ExpireAt:      now.Add(3 * consoleStatusInterval),
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
		// Omitting activeRuns is intentional: a partial Docker-host read must
		// never be rendered as a plausible zero. The timestamp still proves
		// the queue process itself remains alive and publishing.
		s.logger.Warn("Failed to count active direct runners for console status", slog.Any("error", err))
		return status
	}
	status.ActiveRuns = &active
	return status
}

// runQueueExecutorStatusPublisher shares the scale-set publisher's bounded
// collection and staleness contract, without participating in queue claims or
// Docker launch decisions. A slow status read therefore cannot delay work.
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

// activeDirectRunnerCount asks each configured Docker host for currently
// running containers owned by the generic direct-runner queue adapter. A
// failure on any host makes the aggregate unavailable rather than partial.
func activeDirectRunnerCount(ctx context.Context, resolved resolvedOrchestratorConfig, newClient func(string) (*dockerclient.Client, error)) (int, error) {
	targets, order, err := ParseDockerHosts(resolved.DockerHosts)
	if err != nil {
		return 0, fmt.Errorf("parsing fleet docker hosts for direct-runner status: %w", err)
	}
	active := 0
	for _, host := range order {
		client, err := newClient(targets[host])
		if err != nil {
			return 0, fmt.Errorf("host %q: connecting for direct-runner status: %w", host, err)
		}
		listCtx, cancel := context.WithTimeout(ctx, dockerInspectTimeout)
		containers, listErr := client.ContainerList(listCtx, container.ListOptions{
			Filters: filters.NewArgs(filters.Arg("label", directRunnerLabelKey+"=1")),
		})
		cancel()
		closeErr := client.Close()
		if listErr != nil {
			return 0, fmt.Errorf("host %q: listing active direct runners: %w", host, listErr)
		}
		if closeErr != nil {
			return 0, fmt.Errorf("host %q: closing direct-runner status client: %w", host, closeErr)
		}
		for _, direct := range containers {
			if direct.Labels[directRunnerLabelKey] == "1" && direct.Labels[directRunnerRunIDLabelKey] != "" {
				active++
			}
		}
	}
	return active, nil
}

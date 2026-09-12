package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/filters"
	dockerclient "github.com/docker/docker/client"
)

// A controller restart can interrupt Docker create/start. Resume that same
// container, never create a replacement or restart an exited attempt. Its first
// request is the authenticated Work brief: expired, canceled, or superseded
// attempts fail there before checkout, credentials, or provider execution.
// Run before this controller starts claiming new work. Docker start is itself
// idempotent if a previous controller's start request completes concurrently.
func recoverCreatedDirectRunners(ctx context.Context, resolved resolvedOrchestratorConfig, newClient func(string) (*dockerclient.Client, error), logger *slog.Logger) error {
	targets, order, err := ParseDockerHosts(resolved.DockerHosts)
	if err != nil {
		return err
	}
	var errs []error
	for _, host := range order {
		if ctx.Err() != nil {
			return errors.Join(append(errs, ctx.Err())...)
		}
		hostCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
		err := recoverCreatedDirectRunnersOnHost(hostCtx, targets[host], newClient, directRunnerMaxConcurrent(), logger)
		cancel()
		if err != nil {
			errs = append(errs, fmt.Errorf("host %q: %w", host, err))
		}
	}
	return errors.Join(errs...)
}

func recoverCreatedDirectRunnersOnHost(ctx context.Context, target string, newClient func(string) (*dockerclient.Client, error), limit int, logger *slog.Logger) error {
	client, err := newClient(target)
	if err != nil {
		return err
	}
	defer client.Close()
	listed, err := client.ContainerList(ctx, container.ListOptions{All: true, Filters: filters.NewArgs(filters.Arg("label", directRunnerLabelKey+"=1"))})
	if err != nil {
		return err
	}
	active := 0
	for _, c := range listed {
		if c.Labels[directRunnerLabelKey] == "1" && (c.State == container.StateRunning || c.State == container.StateRestarting || c.State == container.StatePaused) {
			active++
		}
	}
	var errs []error
	for _, c := range listed {
		if active >= limit {
			break
		}
		if c.State != container.StateCreated || c.Labels[directRunnerLabelKey] != "1" || c.Labels[directRunnerRunIDLabelKey] == "" {
			continue
		}
		inspected, err := client.ContainerInspect(ctx, c.ID)
		if err != nil {
			errs = append(errs, err)
			active++ // unknown state may already occupy capacity
			continue
		}
		if inspected.State == nil || inspected.State.Status != container.StateCreated || inspected.State.Running {
			active++ // conservatively reserve capacity after a state race
			continue
		}
		// A never-started container has Docker's zero timestamp. Refuse malformed
		// timestamps and any evidence of a previous execution, even if state drifted.
		started, err := time.Parse(time.RFC3339Nano, inspected.State.StartedAt)
		if err != nil || !started.IsZero() {
			continue
		}
		if err := client.ContainerStart(ctx, c.ID, container.StartOptions{}); err != nil {
			// Keep it for diagnosis/recovery; never force-remove on an ambiguous start.
			errs = append(errs, err)
			active++ // a timed-out start may have succeeded at the daemon
			continue
		}
		active++
		logger.Info("Recovered never-started direct runner", slog.String("runId", c.Labels[directRunnerRunIDLabelKey]), slog.String("container", c.ID))
	}
	return errors.Join(errs...)
}

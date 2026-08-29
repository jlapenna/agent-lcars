package main

import (
	"context"
	"errors"
	"log/slog"
	"testing"
	"time"

	"github.com/docker/docker/api/types/container"
	dockerclient "github.com/docker/docker/client"
)

func TestConsoleStatusSnapshotIncludesQueueAndActiveJob(t *testing.T) {
	scaler := &Scaler{
		scaleSetName:     "lcars-ci",
		registrationName: "primary",
		registrationURL:  "https://github.com/jlapenna/agent-lcars",
		minRunners:       1,
		maxRunners:       4,
		runners: runnerState{idle: map[string]runnerRef{
			"idle-runner": {host: "janeway"},
		}, busy: map[string]runnerRef{
			"busy-runner": {host: "spark", jobID: "job-42"},
		}},
	}
	scaler.queuedJobs.Store(2)
	now := time.Date(2026, 8, 9, 4, 0, 0, 0, time.UTC)

	got := scaler.consoleStatusSnapshot(now)

	if got.ScaleSet != "lcars-ci" || got.Registration != "primary" || got.RegistrationURL != "https://github.com/jlapenna/agent-lcars" || got.QueuedJobs != 2 {
		t.Fatalf("unexpected status identity/queue: %#v", got)
	}
	if got.UpdatedAt != now.Format(time.RFC3339Nano) || !got.ExpireAt.Equal(now.Add(3*consoleStatusInterval)) {
		t.Fatalf("unexpected status timestamps: %#v", got)
	}
	if len(got.Runners) != 2 || got.Runners[0].Name != "busy-runner" || got.Runners[0].JobID != "job-42" || got.Runners[1].State != "idle" {
		t.Fatalf("unexpected runner projection: %#v", got.Runners)
	}
}

func TestQueueExecutorStatusSnapshotReportsOnlyTruthfulWorkerHealth(t *testing.T) {
	draining := false
	source := &queueExecutorStatusSource{
		draining:      func() bool { return draining },
		maxConcurrent: 3,
		activeRuns:    func(context.Context) (int, error) { return 2, nil },
		logger:        discardLogger(),
	}
	now := time.Date(2026, 8, 28, 18, 0, 0, 0, time.UTC)

	notReady := source.snapshot(context.Background(), now)
	if notReady.SchemaVersion != 2 || notReady.Kind != "queue-executor" || notReady.Executor != "queue" || notReady.Ready || notReady.Draining || notReady.ActiveRuns != nil || notReady.MaxConcurrent != 0 {
		t.Fatalf("unexpected unavailable queue status: %#v", notReady)
	}
	if !notReady.ExpireAt.Equal(now.Add(3 * consoleStatusInterval)) {
		t.Fatalf("unexpected queue status expiry: %#v", notReady)
	}

	source.ready.Store(true)
	draining = true
	ready := source.snapshot(context.Background(), now)
	if !ready.Ready || !ready.Draining || ready.MaxConcurrent != 3 || ready.ActiveRuns == nil || *ready.ActiveRuns != 2 {
		t.Fatalf("unexpected ready queue status: %#v", ready)
	}

	source.activeRuns = func(context.Context) (int, error) { return 0, errors.New("docker unavailable") }
	unknownActive := source.snapshot(context.Background(), now)
	if unknownActive.ActiveRuns != nil {
		t.Fatalf("active runs = %v, want omitted when host read fails", *unknownActive.ActiveRuns)
	}
}

func TestActiveDirectRunnerCountCountsOnlyOwnedRunningContainers(t *testing.T) {
	f := newFakeDockerServer(t)
	f.setContainers([]container.Summary{
		{ID: "owned-running", Labels: map[string]string{directRunnerLabelKey: "1", directRunnerRunIDLabelKey: "work:abc/r1"}},
		{ID: "missing-run-id", Labels: map[string]string{directRunnerLabelKey: "1"}},
		{ID: "unrelated", Labels: map[string]string{"other": "1"}},
	})
	newClient := func(string) (*dockerclient.Client, error) { return f.client(t), nil }
	resolved := resolvedOrchestratorConfig{DockerHosts: []string{"host-a=local"}}

	active, err := activeDirectRunnerCount(context.Background(), resolved, newClient)
	if err != nil {
		t.Fatalf("activeDirectRunnerCount: %v", err)
	}
	if active != 1 {
		t.Fatalf("active direct runners = %d, want 1", active)
	}
}

func TestConsoleStatusPublisherIsDisabledWithoutExplicitOptIn(t *testing.T) {
	t.Setenv("AGENT_LCARS_AUTOSCALER_STATUS_ENABLED", "")
	publisher, err := newConsoleStatusPublisher(context.Background(), slog.Default())
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := publisher.(noopConsoleStatusPublisher); !ok {
		t.Fatalf("publisher = %T, want noop when opt-in is absent", publisher)
	}
}

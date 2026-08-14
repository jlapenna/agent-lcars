package main

import (
	"context"
	"log/slog"
	"testing"
	"time"
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

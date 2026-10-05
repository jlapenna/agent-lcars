package main

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/docker/docker/api/types/container"
	dockerclient "github.com/docker/docker/client"
)

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
	if !notReady.ExpireAt.Equal(now.Add(consoleStatusTTL)) {
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

func TestStatusWriteGateWritesOnChangeOrHeartbeatOnly(t *testing.T) {
	gate := newStatusWriteGate(consoleStatusHeartbeat)
	start := time.Date(2026, 10, 5, 12, 0, 0, 0, time.UTC)
	active := 1
	sample := func(at time.Time, runs int) consoleQueueExecutorStatus {
		value := runs
		return consoleQueueExecutorStatus{
			SchemaVersion: 2, Kind: "queue-executor", Executor: "queue", Ready: true,
			ActiveRuns: &value, MaxConcurrent: 3,
			UpdatedAt: at.Format(time.RFC3339Nano), ExpireAt: at.Add(consoleStatusTTL),
		}
	}

	first := sample(start, active)
	if !gate.shouldWrite(queueExecutorStatusDocument, first, start) {
		t.Fatal("first sample of a document must be written")
	}
	gate.recordWritten(queueExecutorStatusDocument, first, start)

	// Same content, new timestamps, new pointer: a duplicate until the heartbeat.
	for _, offset := range []time.Duration{consoleStatusInterval, consoleStatusHeartbeat - time.Second} {
		at := start.Add(offset)
		if gate.shouldWrite(queueExecutorStatusDocument, sample(at, active), at) {
			t.Fatalf("unchanged sample at +%s must not be written before the heartbeat", offset)
		}
	}

	heartbeat := start.Add(consoleStatusHeartbeat)
	if !gate.shouldWrite(queueExecutorStatusDocument, sample(heartbeat, active), heartbeat) {
		t.Fatal("unchanged sample must be written once the heartbeat is due")
	}

	changed := start.Add(consoleStatusInterval)
	if !gate.shouldWrite(queueExecutorStatusDocument, sample(changed, active+1), changed) {
		t.Fatal("a changed active-run count must be written immediately")
	}
	unknown := sample(changed, active)
	unknown.ActiveRuns = nil
	if !gate.shouldWrite(queueExecutorStatusDocument, unknown, changed) {
		t.Fatal("an active-run count becoming unknown must be written immediately")
	}
}

func TestStatusWriteGateTracksDocumentsIndependently(t *testing.T) {
	gate := newStatusWriteGate(consoleStatusHeartbeat)
	now := time.Date(2026, 10, 5, 12, 0, 0, 0, time.UTC)
	lane := consoleARCLaneStatus{SchemaVersion: 3, Kind: "arc-lane", Lane: "lcars-ci", PendingJobs: 1}
	gate.recordWritten("arc-lcars-ci", lane, now)

	other := lane
	other.Lane = "lcars-arm64"
	if !gate.shouldWrite("arc-lcars-arm64", other, now) {
		t.Fatal("a lane never written must be written")
	}
	lane.UpdatedAt = now.Add(consoleStatusInterval).Format(time.RFC3339Nano)
	if gate.shouldWrite("arc-lcars-ci", lane, now.Add(consoleStatusInterval)) {
		t.Fatal("an unchanged lane must wait for its own heartbeat")
	}
}

func TestConsoleStatusTTLOutlivesTheHeartbeat(t *testing.T) {
	// A healthy producer rewrites an unchanged document every heartbeat plus
	// at most one sample interval. The TTL (and the console's matching
	// staleness threshold) must leave room for a missed heartbeat.
	if consoleStatusTTL < 2*(consoleStatusHeartbeat+consoleStatusInterval) {
		t.Fatalf("TTL %s leaves no room for one missed heartbeat of %s", consoleStatusTTL, consoleStatusHeartbeat)
	}
}

func TestConsoleStalenessMatchesStatusTTL(t *testing.T) {
	// The console hides a snapshot older than RUNNER_STATUS_STALENESS_MS; it
	// must be the TTL this producer writes, or healthy-but-unchanged
	// documents would flap stale between heartbeats.
	source, err := os.ReadFile("../console/src/lib/runner-status-contract.ts")
	if err != nil {
		t.Fatal(err)
	}
	match := regexp.MustCompile(`RUNNER_STATUS_STALENESS_MS = ([0-9_]+);`).FindSubmatch(source)
	if match == nil {
		t.Fatal("RUNNER_STATUS_STALENESS_MS not found in the console contract")
	}
	staleness, err := strconv.Atoi(strings.ReplaceAll(string(match[1]), "_", ""))
	if err != nil {
		t.Fatal(err)
	}
	if time.Duration(staleness)*time.Millisecond != consoleStatusTTL {
		t.Fatalf("console staleness %dms != producer TTL %s", staleness, consoleStatusTTL)
	}
}

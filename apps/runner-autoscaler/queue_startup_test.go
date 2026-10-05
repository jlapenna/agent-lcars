package main

import (
	"context"
	"strings"
	"testing"

	dockerclient "github.com/docker/docker/client"
)

func TestQueueLaunchUsesStartupSnapshotAfterEnvironmentChanges(t *testing.T) {
	configureDirectRunnerPreflightMounts(t)
	t.Setenv("LCARS_QUEUE_MAX_CONCURRENT", "2")
	raw := resolvedOrchestratorConfig{DockerHosts: []string{"host=target"}}
	q, err := resolveQueueExecutor(raw)
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"LCARS_QUEUE_RUNNER_IMAGE", "LCARS_QUEUE_TELEMETRY_WRITER_HOST_PATH", "LCARS_QUEUE_CLAUDE_TOKEN_HOST_PATH", "LCARS_QUEUE_OPENCODE_KEY_HOST_PATH", "LCARS_QUEUE_MAX_CONCURRENT"} {
		t.Setenv(key, "")
	}
	raw.DockerHosts[0] = "corrupted-after-startup"
	fake := newFakeDockerServer(t)
	fake.imagePresent = true
	fake.pullStreamError = true
	reservation, err := newDirectRunnerCapacityReservations(q, func(target string) (*dockerclient.Client, error) {
		if target != "target" {
			t.Fatalf("changed target %s", target)
		}
		return fake.client(t), nil
	}, discardLogger()).reserve(context.Background())
	if err != nil || reservation == nil {
		t.Fatalf("reservation: %v", err)
	}
	defer reservation.release()
	if err := reservation.launch(directRunnerLaunch{runID: "work:01STARTUPSNAPSHOT/r1", pipeline: "claude"}); err != nil {
		t.Fatal(err)
	}
	if fake.pullCount() != 0 || fake.createCount() != 1 {
		t.Fatal("cached launch must not pull when the registry cannot be resolved")
	}
	if fake.lastCreate.Image != "registry/direct-runner:test" {
		t.Fatalf("image changed: %s", fake.lastCreate.Image)
	}
	if !strings.Contains(strings.Join(fake.lastCreate.HostConfig.Binds, ","), "/secrets/claude-code-oauth-token:") {
		t.Fatal("lost startup credential bind")
	}
}

func TestQueueEnvironmentRejectsStaticDefects(t *testing.T) {
	for _, key := range []string{"LCARS_QUEUE_RUNNER_IMAGE", "LCARS_QUEUE_TELEMETRY_WRITER_HOST_PATH", "LCARS_QUEUE_CLAUDE_TOKEN_HOST_PATH", "LCARS_QUEUE_OPENCODE_KEY_HOST_PATH", "GOOGLE_APPLICATION_CREDENTIALS", "LCARS_QUEUE_MAX_CONCURRENT", "LCARS_CONSOLE_URL"} {
		t.Run(key, func(t *testing.T) {
			configureDirectRunnerPreflightMounts(t)
			t.Setenv("LCARS_CONSOLE_URL", "https://console.example")
			t.Setenv("GOOGLE_APPLICATION_CREDENTIALS", "/secrets/google.json")
			t.Setenv("LCARS_QUEUE_MAX_CONCURRENT", "1")
			bad := ""
			if key == "LCARS_QUEUE_MAX_CONCURRENT" {
				bad = "zero"
			}
			if key == "LCARS_CONSOLE_URL" {
				bad = "relative"
			}
			t.Setenv(key, bad)
			if err := validateQueueExecutorEnvironment(resolvedOrchestratorConfig{DockerHosts: []string{"host=target"}}); err == nil {
				t.Fatal("invalid configuration accepted")
			}
		})
	}
}

// TestQueueExecutorEnvironmentRejectsDisabledQueueExecutor covers startup
// after homelab#1623 Phase 3 retired the scale-set runtime: the queue
// executor is this process's only possible job, so an unconfigured queue
// executor must always refuse to start rather than run forever as a silent
// no-op.
func TestQueueExecutorEnvironmentRejectsDisabledQueueExecutor(t *testing.T) {
	for _, key := range []string{"LCARS_CONSOLE_URL", "GOOGLE_APPLICATION_CREDENTIALS", "LCARS_QUEUE_TELEMETRY_WRITER_HOST_PATH"} {
		t.Setenv(key, "")
	}
	err := validateQueueExecutorEnvironment(resolvedOrchestratorConfig{})
	if err == nil {
		t.Fatal("expected an error: the queue executor is this process's only job and it is unconfigured")
	}
	if !strings.Contains(err.Error(), "nothing else to run") {
		t.Fatalf("unexpected error: %v", err)
	}
}

// A launch follows the mutable tag the way a Kubernetes PullAlways Job does:
// one registry digest lookup, and a pull only when the tag has moved. This
// replaced a five-minute background refresh that pulled on every host.
func TestQueueLaunchFollowsTagOnlyWhenDigestMoved(t *testing.T) {
	const current = "sha256:1111111111111111111111111111111111111111111111111111111111111111"
	const promoted = "sha256:2222222222222222222222222222222222222222222222222222222222222222"
	for _, tc := range []struct {
		name            string
		registryDigest  string
		pullStreamError bool
		wantPulls       int
	}{
		{name: "unchanged tag launches cached image", registryDigest: current, wantPulls: 0},
		{name: "moved tag pulls before launch", registryDigest: promoted, wantPulls: 1},
		{name: "failed pull launches cached image", registryDigest: promoted, pullStreamError: true, wantPulls: 1},
		{name: "unreachable registry launches cached image", registryDigest: "", wantPulls: 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			q := testQueueResolved(t, resolvedOrchestratorConfig{DockerHosts: []string{"host=target"}})
			fake := newFakeDockerServer(t)
			fake.imagePresent = true
			fake.localDigest = current
			fake.registryDigest = tc.registryDigest
			fake.pullStreamError = tc.pullStreamError
			clients := func(string) (*dockerclient.Client, error) { return fake.client(t), nil }
			if err := launchDirectRunnerWithClient(context.Background(), q, directRunnerLaunch{runID: "work:01FOLLOWTAG/r1", pipeline: "codex"}, clients, discardLogger()); err != nil {
				t.Fatal(err)
			}
			if fake.lookupCount() != 1 {
				t.Fatalf("digest lookups = %d, want 1", fake.lookupCount())
			}
			if fake.pullCount() != tc.wantPulls || fake.createCount() != 1 {
				t.Fatalf("pulls = %d (want %d), creates = %d (want 1)", fake.pullCount(), tc.wantPulls, fake.createCount())
			}
		})
	}
}

func TestQueueLaunchPullsMissingImageWithoutDigestLookup(t *testing.T) {
	q := testQueueResolved(t, resolvedOrchestratorConfig{DockerHosts: []string{"host=target"}})
	fake := newFakeDockerServer(t)
	clients := func(string) (*dockerclient.Client, error) { return fake.client(t), nil }
	if err := launchDirectRunnerWithClient(context.Background(), q, directRunnerLaunch{runID: "work:01MISSINGIMAGE/r1", pipeline: "codex"}, clients, discardLogger()); err != nil {
		t.Fatal(err)
	}
	if fake.pullCount() != 1 || fake.lookupCount() != 0 || fake.createCount() != 1 {
		t.Fatalf("pulls = %d, lookups = %d, creates = %d", fake.pullCount(), fake.lookupCount(), fake.createCount())
	}
}

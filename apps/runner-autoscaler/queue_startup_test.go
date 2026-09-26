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
		t.Fatal("cached launch should not touch registry")
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

func TestQueueImageRefreshFailurePreservesCachedLaunch(t *testing.T) {
	q := testQueueResolved(t, resolvedOrchestratorConfig{DockerHosts: []string{"host=target"}})
	fake := newFakeDockerServer(t)
	fake.imagePresent = true
	fake.pullStreamError = true
	clients := func(string) (*dockerclient.Client, error) { return fake.client(t), nil }
	refreshQueueRunnerImagesOnce(context.Background(), q, clients, discardLogger())
	if fake.pullCount() != 1 {
		t.Fatal("background refresh did not follow tag")
	}
	if err := launchDirectRunnerWithClient(context.Background(), q, directRunnerLaunch{runID: "work:01CACHEDLAUNCH/r1", pipeline: "codex"}, clients, discardLogger()); err != nil {
		t.Fatal(err)
	}
	if fake.pullCount() != 1 || fake.createCount() != 1 {
		t.Fatal("launch retried failed registry refresh")
	}
}

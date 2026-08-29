package main

import (
	"context"
	"strings"
	"testing"
	"time"

	dockerclient "github.com/docker/docker/client"
)

func directRunnerPreflightResolved() resolvedOrchestratorConfig {
	return resolvedOrchestratorConfig{
		DockerHosts: []string{"eligible=eligible-target", "ineligible=ineligible-target"},
		ScaleSets:   []Config{{RunnerImage: "registry/direct-runner:test"}},
	}
}

func configureDirectRunnerPreflightMounts(t *testing.T) {
	t.Helper()
	t.Setenv("LCARS_QUEUE_TELEMETRY_WRITER_HOST_PATH", "/secrets/telemetry-writer.json")
	t.Setenv("LCARS_QUEUE_CLAUDE_TOKEN_HOST_PATH", "/secrets/claude-code-oauth-token")
	t.Setenv("LCARS_QUEUE_OPENCODE_KEY_HOST_PATH", "/secrets/opencode-llm-api-key")
}

func TestDirectRunnerPreflightExcludesUnreadableHostsFromLaunchPool(t *testing.T) {
	configureDirectRunnerPreflightMounts(t)
	healthy := newFakeDockerServer(t)
	unreadable := newFakeDockerServer(t)
	unreadable.setWaitStatuses(1)
	clients := func(target string) (*dockerclient.Client, error) {
		switch target {
		case "eligible-target":
			return healthy.client(t), nil
		case "ineligible-target":
			return unreadable.client(t), nil
		default:
			t.Fatalf("unexpected Docker target %q", target)
			return nil, nil
		}
	}

	selected, err := directRunnerPreflightHosts(context.Background(), directRunnerPreflightResolved(), clients, discardLogger())
	if err != nil {
		t.Fatalf("directRunnerPreflightHosts: %v", err)
	}
	if got := strings.Join(selected.DockerHosts, ","); got != "eligible=eligible-target" {
		t.Fatalf("eligible launch hosts = %q, want only eligible host", got)
	}
	status := newQueueExecutorStatusSource(func() bool { return false }, discardLogger())
	status.configureEligibleHosts(selected, clients)
	status.ready.Store(true)
	snapshot := status.snapshot(context.Background(), nowForTest())
	if snapshot.MaxConcurrent != directRunnerMaxConcurrent() || snapshot.ActiveRuns == nil || *snapshot.ActiveRuns != 0 {
		t.Fatalf("queue status must use only eligible launch hosts: %#v", snapshot)
	}
	for name, fake := range map[string]*fakeDockerServer{"healthy": healthy, "unreadable": unreadable} {
		if fake.createCount() != 1 || fake.startCount() != 1 || fake.waitCount() != 1 {
			t.Fatalf("%s preflight calls create/start/wait = %d/%d/%d, want 1/1/1", name, fake.createCount(), fake.startCount(), fake.waitCount())
		}
		removed := fake.removedIDs()
		if len(removed) != 1 || removed[0] != "created-container" {
			t.Fatalf("%s preflight cleanup = %v, want created container removed", name, removed)
		}
		if forced := fake.removalsForced(); len(forced) != 1 || !forced[0] {
			t.Fatalf("%s preflight cleanup force = %v, want [true]", name, forced)
		}
	}

	created := healthy.getLastCreate()
	wantBinds := map[string]bool{
		"/secrets/telemetry-writer.json:" + directRunnerTelemetryWriterMountPath + ":ro": true,
		"/secrets/claude-code-oauth-token:" + directRunnerClaudeTokenMountPath + ":ro":   true,
		"/secrets/opencode-llm-api-key:" + directRunnerOpenCodeTokenMountPath + ":ro":    true,
	}
	if len(created.HostConfig.Binds) != len(wantBinds) {
		t.Fatalf("preflight binds = %v, want %v", created.HostConfig.Binds, wantBinds)
	}
	for _, bind := range created.HostConfig.Binds {
		if !wantBinds[bind] {
			t.Fatalf("unexpected preflight bind %q", bind)
		}
	}
	if created.Labels[directRunnerPreflightLabelKey] != "1" {
		t.Fatalf("preflight label = %v", created.Labels)
	}
	if created.HostConfig.NetworkMode != "none" || !created.HostConfig.ReadonlyRootfs {
		t.Fatalf("preflight host isolation = %#v, want no network and read-only root", created.HostConfig)
	}
	if len(created.Entrypoint) != 1 || created.Entrypoint[0] != "/bin/sh" || len(created.Cmd) < 6 {
		t.Fatalf("unexpected preflight command: entrypoint=%v cmd=%v", created.Entrypoint, created.Cmd)
	}
}

func nowForTest() time.Time { return time.Date(2026, 8, 28, 20, 0, 0, 0, time.UTC) }

func TestDirectRunnerPreflightRefusesClaimsWhenNoHostCanReadAllBinds(t *testing.T) {
	configureDirectRunnerPreflightMounts(t)
	first := newFakeDockerServer(t)
	second := newFakeDockerServer(t)
	first.setWaitStatuses(1)
	second.setWaitStatuses(1)
	clients := func(target string) (*dockerclient.Client, error) {
		if target == "eligible-target" {
			return first.client(t), nil
		}
		return second.client(t), nil
	}

	_, err := directRunnerPreflightHosts(context.Background(), directRunnerPreflightResolved(), clients, discardLogger())
	if err == nil || !strings.Contains(err.Error(), "no configured Docker host passed") {
		t.Fatalf("preflight error = %v, want no eligible host", err)
	}
	if first.waitCount() != 1 || second.waitCount() != 1 {
		t.Fatalf("every configured host must be probed before refusing claims: waits=%d/%d", first.waitCount(), second.waitCount())
	}
	if len(first.removedIDs()) != 1 || len(second.removedIDs()) != 1 {
		t.Fatalf("failed probes must clean up their disposable containers: removals=%v/%v", first.removedIDs(), second.removedIDs())
	}
}

func TestDirectRunnerPreflightRequiresEveryPermanentAdapterContract(t *testing.T) {
	configureDirectRunnerPreflightMounts(t)
	t.Setenv("LCARS_QUEUE_OPENCODE_KEY_HOST_PATH", "")
	fake := newFakeDockerServer(t)
	_, err := directRunnerPreflightHosts(context.Background(), directRunnerPreflightResolved(), func(string) (*dockerclient.Client, error) {
		return fake.client(t), nil
	}, discardLogger())
	if err == nil || !strings.Contains(err.Error(), "opencode adapter") {
		t.Fatalf("preflight error = %v, want missing OpenCode adapter credential", err)
	}
	if fake.createCount() != 0 {
		t.Fatalf("preflight must fail before probing or claiming when a permanent adapter contract is absent")
	}
}

func TestDirectRunnerPreflightRequiresEveryConfiguredDirectRunnerImage(t *testing.T) {
	configureDirectRunnerPreflightMounts(t)
	fake := newFakeDockerServer(t)
	// The first configured image starts, while a pipeline-specific second
	// image cannot. A host must be excluded before it can claim work for that
	// second pipeline, rather than being marked ready from the first image.
	fake.setStartFailures(0, 500)
	resolved := resolvedOrchestratorConfig{
		DockerHosts: []string{"host=host-target"},
		ScaleSets: []Config{
			{ScaleSetName: "claude", Labels: []string{"claude"}, RunnerImage: "registry/claude:test"},
			{ScaleSetName: "codex", Labels: []string{"codex"}, RunnerImage: "registry/codex:test"},
		},
	}

	_, err := directRunnerPreflightHosts(context.Background(), resolved, func(string) (*dockerclient.Client, error) {
		return fake.client(t), nil
	}, discardLogger())
	if err == nil || !strings.Contains(err.Error(), "no configured Docker host passed") {
		t.Fatalf("preflight error = %v, want no eligible host", err)
	}
	if fake.createCount() != 2 || fake.startCount() != 2 || fake.waitCount() != 1 {
		t.Fatalf("every configured image must be probed: creates/starts/waits = %d/%d/%d, want 2/2/1", fake.createCount(), fake.startCount(), fake.waitCount())
	}
	if len(fake.removedIDs()) != 2 {
		t.Fatalf("every image probe must clean up: removals=%v", fake.removedIDs())
	}
}

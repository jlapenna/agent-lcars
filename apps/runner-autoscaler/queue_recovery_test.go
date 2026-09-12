package main

import (
	"context"
	"github.com/docker/docker/api/types/container"
	dockerclient "github.com/docker/docker/client"
	"net/http"
	"testing"
)

func TestRecoverCreatedDirectRunners(t *testing.T) {
	for _, tc := range []struct {
		name, listed, inspected, started string
		owned                            bool
		want                             int
	}{
		{"interrupted launch", container.StateCreated, container.StateCreated, "0001-01-01T00:00:00Z", true, 1},
		{"already running", container.StateRunning, container.StateRunning, "2026-09-12T00:00:00Z", true, 0},
		{"exited attempt", container.StateExited, container.StateExited, "2026-09-12T00:00:00Z", true, 0},
		{"state race", container.StateCreated, container.StateRunning, "2026-09-12T00:00:00Z", true, 0},
		{"previous execution", container.StateCreated, container.StateCreated, "2026-09-12T00:00:00Z", true, 0},
		{"unknown execution", container.StateCreated, container.StateCreated, "", true, 0},
		{"foreign container", container.StateCreated, container.StateCreated, "0001-01-01T00:00:00Z", false, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newFakeDockerServer(t)
			labels := map[string]string{}
			if tc.owned {
				labels[directRunnerLabelKey] = "1"
				labels[directRunnerRunIDLabelKey] = "work:recovery/r4"
			}
			f.setContainers([]container.Summary{{ID: "interrupted", State: tc.listed, Labels: labels}})
			f.setInspect("interrupted", http.StatusOK, &container.State{Status: tc.inspected, StartedAt: tc.started})
			err := recoverCreatedDirectRunnersOnHost(context.Background(), "test", func(string) (*dockerclient.Client, error) { return f.client(t), nil }, 1, discardLogger())
			if err != nil {
				t.Fatal(err)
			}
			if f.starts != tc.want {
				t.Fatalf("starts=%d want %d", f.starts, tc.want)
			}
			if f.createCount() != 0 || len(f.removed) != 0 {
				t.Fatal("recovery must neither recreate nor delete attempts")
			}
		})
	}
}

func TestRecoveryRespectsExistingCapacity(t *testing.T) {
	f := newFakeDockerServer(t)
	labels := map[string]string{directRunnerLabelKey: "1", directRunnerRunIDLabelKey: "work:recovery/r4"}
	f.setContainers([]container.Summary{{ID: "active", State: container.StateRunning, Labels: labels}, {ID: "waiting", State: container.StateCreated, Labels: labels}})
	err := recoverCreatedDirectRunnersOnHost(context.Background(), "test", func(string) (*dockerclient.Client, error) { return f.client(t), nil }, 1, discardLogger())
	if err != nil {
		t.Fatal(err)
	}
	if f.starts != 0 {
		t.Fatal("recovery exceeded host capacity")
	}
}

func TestRecoveryAmbiguousStartDoesNotLaunchAnotherAttempt(t *testing.T) {
	f := newFakeDockerServer(t)
	labels := map[string]string{directRunnerLabelKey: "1", directRunnerRunIDLabelKey: "work:recovery/r4"}
	f.setContainers([]container.Summary{{ID: "first", State: container.StateCreated, Labels: labels}, {ID: "second", State: container.StateCreated, Labels: labels}})
	for _, id := range []string{"first", "second"} {
		f.setInspect(id, http.StatusOK, &container.State{Status: container.StateCreated, StartedAt: "0001-01-01T00:00:00Z"})
	}
	f.startFailures = []int{http.StatusInternalServerError}
	err := recoverCreatedDirectRunnersOnHost(context.Background(), "test", func(string) (*dockerclient.Client, error) { return f.client(t), nil }, 1, discardLogger())
	if err == nil {
		t.Fatal("ambiguous start must surface an error")
	}
	if f.starts != 1 || len(f.removed) != 0 {
		t.Fatal("must preserve the ambiguous attempt and its capacity")
	}
}

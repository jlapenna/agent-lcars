package main

import (
	"context"
	"fmt"
	"reflect"
	"testing"
	"time"

	core "k8s.io/api/core/v1"
	meta "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/kubernetes/fake"
)

var runnerStart = time.Date(2026, 10, 14, 7, 0, 0, 0, time.UTC)

// runnerPod is a hostPod that has started, with its readiness set.
func runnerPod(name, node string, phase core.PodPhase, ready bool, labels map[string]string) *core.Pod {
	pod := hostPod(name, node, phase, labels, "4", "12Gi")
	status := core.ConditionFalse
	if ready {
		status = core.ConditionTrue
	}
	pod.Status.StartTime = &meta.Time{Time: runnerStart}
	pod.Status.Conditions = []core.PodCondition{{Type: core.PodReady, Status: status}}
	return pod
}

func TestHostInventoryListsEveryRunnerPodWithItsState(t *testing.T) {
	arc := map[string]string{arcScaleSetLabel: "lcars-ci", arcComponentKey: arcRunnerValue}
	listener := map[string]string{arcScaleSetLabel: "lcars-ci", arcComponentKey: "runner-scale-set-listener"}
	direct := runnerPod("lcars-run-1", "spark", core.PodRunning, true, map[string]string{queueJobLabel: "true"})
	direct.Annotations = map[string]string{queueRunAnnotation: "run-1"}
	terminating := runnerPod("arc-stopping", "spark", core.PodRunning, true, arc)
	terminating.DeletionTimestamp = &meta.Time{Time: runnerStart}
	client := fake.NewClientset(
		hostNode("spark", true, false, "20", "128Gi"),
		hostNode("picard", true, true, "16", "64Gi"),
		hostNode("worf", false, false, "8", "16Gi"),
		runnerPod("arc-up", "spark", core.PodRunning, true, arc),
		runnerPod("arc-booting", "spark", core.PodRunning, false, arc),
		runnerPod("arc-cordoned", "picard", core.PodRunning, true, arc),
		runnerPod("arc-lost", "worf", core.PodRunning, true, arc),
		runnerPod("arc-unscheduled", "", core.PodPending, false, arc),
		runnerPod("arc-done", "spark", core.PodSucceeded, false, arc),
		runnerPod("listener", "spark", core.PodRunning, true, listener),
		terminating,
		direct,
	)
	inventory, err := hostInventory(context.Background(), client)
	if err != nil {
		t.Fatal(err)
	}
	since := runnerStart.Format(time.RFC3339)
	row := func(name, kind, lane, host, state string) consoleRunner {
		return consoleRunner{Name: name, namespace: "arc-runners", Kind: kind, Lane: lane, Host: host, State: state,
			Since: since, RequestedCPUMillis: 4000, RequestedMemoryBytes: 12 << 30}
	}
	directRow := row("lcars-run-1", runnerKindDirect, runnerKindDirect, "spark", runnerBusy)
	directRow.RunID = "run-1"
	want := []consoleRunner{
		row("arc-unscheduled", runnerKindARC, "lcars-ci", "", runnerStarting),
		row("arc-cordoned", runnerKindARC, "lcars-ci", "picard", runnerDraining),
		row("arc-booting", runnerKindARC, "lcars-ci", "spark", runnerStarting),
		row("arc-stopping", runnerKindARC, "lcars-ci", "spark", runnerDraining),
		row("arc-up", runnerKindARC, "lcars-ci", "spark", runnerOnline),
		directRow,
		row("arc-lost", runnerKindARC, "lcars-ci", "worf", runnerOffline),
	}
	if !reflect.DeepEqual(inventory.Runners, want) {
		t.Fatalf("runners = %#v\nwant %#v", inventory.Runners, want)
	}
	if inventory.RunnerJobsKnown {
		t.Fatal("jobs are known before EphemeralRunners were read")
	}
}

func TestHostInventoryPublishesNoRunnersPastTheLimit(t *testing.T) {
	objects := []runtime.Object{hostNode("spark", true, false, "2000", "4000Gi")}
	for i := 0; i <= maxConsoleRunners; i++ {
		objects = append(objects, runnerPod(fmt.Sprintf("r%03d", i), "spark", core.PodRunning, true,
			map[string]string{arcScaleSetLabel: "lcars-ci", arcComponentKey: arcRunnerValue}))
	}
	inventory, err := hostInventory(context.Background(), fake.NewClientset(objects...))
	if err != nil {
		t.Fatal(err)
	}
	if inventory.Runners != nil {
		t.Fatalf("published %d runners past the limit", len(inventory.Runners))
	}
}

func TestParseEphemeralRunnersKeepsOnlyAssignedJobs(t *testing.T) {
	jobs, err := parseEphemeralRunners([]byte(`{"items":[
		{"metadata":{"name":"arc-busy","namespace":"arc-runners"},"status":{"jobRequestId":42,"jobRepositoryName":"jlapenna/agent-lcars","jobDisplayName":"Verify","workflowRunId":9001}},
		{"metadata":{"name":"arc-idle","namespace":"arc-runners"},"status":{"phase":"Running"}}
	]}`))
	if err != nil {
		t.Fatal(err)
	}
	want := arcRunnerJobs{"arc-runners/arc-busy": {repository: "jlapenna/agent-lcars", name: "Verify", workflowRunID: 9001}}
	if !reflect.DeepEqual(jobs, want) {
		t.Fatalf("jobs = %#v", jobs)
	}
	if _, err := parseEphemeralRunners([]byte(`{"items":`)); err == nil {
		t.Fatal("a truncated list parsed")
	}
}

func TestApplyRunnerJobsSettlesUpARCRunners(t *testing.T) {
	inventory := &consoleHostInventory{Runners: []consoleRunner{
		{Name: "arc-busy", namespace: "arc", Kind: runnerKindARC, State: runnerOnline},
		{Name: "arc-idle", namespace: "arc", Kind: runnerKindARC, State: runnerOnline},
		{Name: "arc-draining", namespace: "arc", Kind: runnerKindARC, State: runnerDraining},
		{Name: "arc-busy", namespace: "other", Kind: runnerKindARC, State: runnerOnline},
		{Name: "lcars-run-1", Kind: runnerKindDirect, State: runnerBusy, RunID: "run-1"},
	}}
	job := arcRunnerJob{repository: "jlapenna/homelab", name: "lint", workflowRunID: 7}
	applyRunnerJobs(inventory, arcRunnerJobs{"arc/arc-busy": job, "arc/arc-draining": job})
	got := []string{}
	for _, r := range inventory.Runners {
		got = append(got, r.Name+":"+r.State+":"+r.JobRepository)
	}
	want := []string{
		"arc-busy:busy:jlapenna/homelab", "arc-idle:idle:", "arc-draining:draining:jlapenna/homelab",
		"arc-busy:idle:", "lcars-run-1:busy:",
	}
	if !reflect.DeepEqual(got, want) || !inventory.RunnerJobsKnown {
		t.Fatalf("runners = %v, jobs known %v", got, inventory.RunnerJobsKnown)
	}
}

func TestHostStatusWritesRunnerChangesAtOnce(t *testing.T) {
	now := time.Now()
	status := func(state string) consoleHostStatus {
		return consoleHostStatus{SchemaVersion: 1, Kind: "hosts", Inventory: &consoleHostInventory{
			Hosts:   []consoleHost{{Name: "spark", Ready: true}},
			Runners: []consoleRunner{{Name: "arc-1", Kind: runnerKindARC, State: state}},
		}}
	}
	gate := newStatusWriteGate(consoleStatusHeartbeat)
	gate.recordWritten("hosts", status(runnerIdle), now)
	if gate.shouldWrite("hosts", status(runnerIdle), now.Add(consoleStatusInterval)) {
		t.Fatal("an unchanged runner wrote before the heartbeat")
	}
	if !gate.shouldWrite("hosts", status(runnerBusy), now.Add(consoleStatusInterval)) {
		t.Fatal("a runner taking a job waited for the heartbeat")
	}
}

package main

import (
	"context"
	"reflect"
	"testing"
	"time"

	core "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	meta "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes/fake"
)

func hostNode(name string, ready, unschedulable bool, cpu, memory string) *core.Node {
	status := core.ConditionFalse
	if ready {
		status = core.ConditionTrue
	}
	return &core.Node{
		ObjectMeta: meta.ObjectMeta{Name: name},
		Spec:       core.NodeSpec{Unschedulable: unschedulable},
		Status: core.NodeStatus{
			Allocatable: core.ResourceList{core.ResourceCPU: resource.MustParse(cpu), core.ResourceMemory: resource.MustParse(memory)},
			Conditions:  []core.NodeCondition{{Type: core.NodeReady, Status: status}},
		},
	}
}

func hostPod(name, node string, phase core.PodPhase, labels map[string]string, cpu, memory string) *core.Pod {
	return &core.Pod{
		ObjectMeta: meta.ObjectMeta{Name: name, Namespace: "arc-runners", Labels: labels},
		Spec: core.PodSpec{NodeName: node, Containers: []core.Container{{Name: "main", Resources: core.ResourceRequirements{
			Requests: core.ResourceList{core.ResourceCPU: resource.MustParse(cpu), core.ResourceMemory: resource.MustParse(memory)},
		}}}},
		Status: core.PodStatus{Phase: phase},
	}
}

func TestHostInventorySumsRequestsAndCountsRunnerPods(t *testing.T) {
	runner := map[string]string{arcScaleSetLabel: "lcars-ci", arcComponentKey: arcRunnerValue}
	listener := map[string]string{arcScaleSetLabel: "lcars-ci", arcComponentKey: "runner-scale-set-listener"}
	client := fake.NewClientset(
		hostNode("spark", true, false, "20", "128Gi"),
		hostNode("picard", true, true, "16", "64Gi"),
		hostNode("worf", false, false, "8", "16Gi"),
		hostPod("r1", "spark", core.PodRunning, runner, "4", "8Gi"),
		hostPod("listener", "spark", core.PodRunning, listener, "100m", "128Mi"),
		hostPod("job", "spark", core.PodPending, map[string]string{queueJobLabel: "true"}, "2", "4Gi"),
		hostPod("done", "spark", core.PodSucceeded, runner, "8", "16Gi"),
		hostPod("elsewhere", "", core.PodPending, runner, "1", "1Gi"),
	)
	inventory, err := hostInventory(context.Background(), client)
	if err != nil {
		t.Fatal(err)
	}
	want := []consoleHost{
		{Name: "picard", Ready: true, Unschedulable: true, CPUMillis: 16000, MemoryBytes: 64 << 30},
		{Name: "spark", Ready: true, CPUMillis: 20000, MemoryBytes: 128 << 30,
			RequestedCPUMillis: 6100, RequestedMemoryBytes: 12<<30 + 128<<20, RunnerPods: 1, QueueJobPods: 1},
		{Name: "worf", CPUMillis: 8000, MemoryBytes: 16 << 30},
	}
	if !reflect.DeepEqual(inventory.Hosts, want) {
		t.Fatalf("hosts = %#v\nwant %#v", inventory.Hosts, want)
	}
}

func TestHostStatusWritesStructuralChangesAtOnceAndLoadOnTheHeartbeat(t *testing.T) {
	now := time.Now()
	status := func(requested int64, ready bool) consoleHostStatus {
		return consoleHostStatus{SchemaVersion: 1, Kind: "hosts", Inventory: &consoleHostInventory{Hosts: []consoleHost{
			{Name: "spark", Ready: ready, CPUMillis: 20000, MemoryBytes: 1, RequestedCPUMillis: requested},
		}}}
	}
	gate := newStatusWriteGate(consoleStatusHeartbeat)
	gate.recordWritten("hosts", status(1000, true), now)
	if gate.shouldWrite("hosts", status(5000, true), now.Add(consoleStatusInterval)) {
		t.Fatal("a load change wrote before the heartbeat")
	}
	if !gate.shouldWrite("hosts", status(1000, false), now.Add(consoleStatusInterval)) {
		t.Fatal("a host going NotReady waited for the heartbeat")
	}
	if !gate.shouldWrite("hosts", status(5000, true), now.Add(consoleStatusHeartbeat)) {
		t.Fatal("load missed the heartbeat")
	}
}

type captureHostPublisher struct{ statuses chan consoleHostStatus }

func (p captureHostPublisher) PublishHosts(_ context.Context, status consoleHostStatus) {
	p.statuses <- status
}

func TestHostStatusPublisherPublishesTheInventory(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	publisher := captureHostPublisher{statuses: make(chan consoleHostStatus, 1)}
	go runHostStatusPublisher(ctx, publisher, fake.NewClientset(hostNode("spark", true, false, "20", "128Gi")), nil)
	select {
	case status := <-publisher.statuses:
		if status.Kind != "hosts" || status.SchemaVersion != 1 || len(status.Inventory.Hosts) != 1 || status.ExpireAt.IsZero() {
			t.Fatalf("published %#v", status)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("publisher did not publish")
	}
}

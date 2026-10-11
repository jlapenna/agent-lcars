package main

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"testing"
	"time"

	batch "k8s.io/api/batch/v1"
	core "k8s.io/api/core/v1"
	meta "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/kubernetes/fake"
	ktesting "k8s.io/client-go/testing"
)

func TestPlacementTransitionsRequireExactPodOwnership(t *testing.T) {
	now := time.Now().UTC()
	job := batch.Job{ObjectMeta: meta.ObjectMeta{UID: "original", CreationTimestamp: meta.NewTime(now.Add(-5 * time.Minute))}}
	job.Spec.Suspend = ptr(true)
	if p := placementForJob(job, nil, nil, now); p.Phase != "bootstrapping" || p.Reason != "launch-pending" {
		t.Fatalf("suspended Job must not imply scheduler placement: %+v", p)
	}
	job.Spec.Suspend = ptr(false)
	pod := core.Pod{ObjectMeta: meta.ObjectMeta{OwnerReferences: []meta.OwnerReference{{Kind: "Job", UID: "original", Controller: ptr(true)}}}, Status: core.PodStatus{Phase: core.PodPending, Conditions: []core.PodCondition{{Type: core.PodScheduled, Status: core.ConditionFalse, Reason: "Unschedulable", Message: "private node names and raw events"}}}}
	p := placementForJob(job, []core.Pod{pod}, nil, now)
	if p.Phase != "waiting-for-placement" || p.Reason != "unschedulable" || p.JobCreatedAt != job.CreationTimestamp.UTC().Format(time.RFC3339Nano) {
		t.Fatalf("Pending observation=%+v", p)
	}
	pod.Spec.NodeName = "private-node"
	p = placementForJob(job, []core.Pod{pod}, nil, now)
	if p.Phase != "bootstrapping" {
		t.Fatalf("scheduled observation=%+v", p)
	}
	pod.Status.Phase = core.PodRunning
	if p = placementForJob(job, []core.Pod{pod}, nil, now); p.Phase != "bootstrapping" {
		t.Fatal("Pod Running must not imply provider start")
	}
	pod.OwnerReferences[0].UID = "replacement"
	if p = placementForJob(job, []core.Pod{pod}, nil, now); p.Phase != "waiting-for-placement" {
		t.Fatal("adopted replacement Pod")
	}
	if p = placementForJob(job, nil, errors.New("private API response"), now); p.Phase != "unavailable" || p.Reason != "inventory-unavailable" {
		t.Fatalf("API failure=%+v", p)
	}
}

func TestPlacementObserverDoesNotPublishMalformedOrTerminalClaims(t *testing.T) {
	runID := "work:01J5Z3K9QX8F0N2B4V6C8D1E3G/r1"
	job := batch.Job{ObjectMeta: meta.ObjectMeta{Name: queueJobName(runID), Namespace: "queue", UID: "original", Labels: map[string]string{queueJobLabel: "true"}, Annotations: map[string]string{queueRunAnnotation: runID, queueRunnerAnnotation: "runner", queueClaimAnnotation: "fingerprint"}}}
	q := &kubernetesQueue{config: queueKubernetesConfig{Namespace: "queue"}, client: fake.NewClientset(&job), logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	calls := 0
	report := func(_ context.Context, j batch.Job, p queuePlacement) error {
		calls++
		if j.UID != "original" || p.Phase != "waiting-for-placement" {
			t.Fatal("wrong identity/phase")
		}
		return nil
	}
	if err := q.observePlacements(context.Background(), report); err != nil || calls != 1 {
		t.Fatalf("calls=%d err=%v", calls, err)
	}
	job.Annotations[queueClaimAnnotation] = ""
	q.client = fake.NewClientset(&job)
	if err := q.observePlacements(context.Background(), report); err != nil || calls != 1 {
		t.Fatal("published claim without fencing authority")
	}
	job.Annotations[queueClaimAnnotation] = "fingerprint"
	job.Status.Conditions = []batch.JobCondition{{Type: batch.JobFailed, Status: core.ConditionTrue}}
	q.client = fake.NewClientset(&job)
	if err := q.observePlacements(context.Background(), report); err != nil || calls != 1 {
		t.Fatal("published settled Job")
	}
}

func TestPlacementInventoryUnavailableIsNeverAPlacementSuccess(t *testing.T) {
	runID := "work:01J5Z3K9QX8F0N2B4V6C8D1E3G/r1"
	job := batch.Job{ObjectMeta: meta.ObjectMeta{Name: queueJobName(runID), Namespace: "queue", UID: "original", Labels: map[string]string{queueJobLabel: "true"}, Annotations: map[string]string{queueRunAnnotation: runID, queueRunnerAnnotation: "runner", queueClaimAnnotation: "fingerprint"}}}
	client := fake.NewClientset(&job)
	q := &kubernetesQueue{config: queueKubernetesConfig{Namespace: "queue"}, client: client, logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	calls := 0
	report := func(_ context.Context, _ batch.Job, p queuePlacement) error {
		calls++
		if p.Phase != "unavailable" || p.Reason != "inventory-unavailable" {
			t.Fatal("API loss fabricated placement")
		}
		return nil
	}
	client.PrependReactor("list", "pods", func(ktesting.Action) (bool, runtime.Object, error) {
		return true, nil, errors.New("private API response")
	})
	// No Node read is needed to observe this Job's placement. Even unavailable
	// node inventory must never turn a Pod/Job into evidence of provider work.
	client.PrependReactor("list", "nodes", func(ktesting.Action) (bool, runtime.Object, error) {
		t.Fatal("placement must not require or infer node capacity")
		return true, nil, errors.New("node API unavailable")
	})
	if err := q.observePlacements(context.Background(), report); err != nil || calls != 1 {
		t.Fatalf("Pod API loss: calls=%d err=%v", calls, err)
	}
	client.PrependReactor("list", "jobs", func(ktesting.Action) (bool, runtime.Object, error) {
		return true, nil, errors.New("private API response")
	})
	if err := q.observePlacements(context.Background(), report); err == nil || calls != 1 {
		t.Fatal("Job API loss must leave observations to age out")
	}
}

package main

import (
	"context"
	"fmt"
	"testing"

	batch "k8s.io/api/batch/v1"
	core "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	meta "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/kubernetes/fake"
	clienttesting "k8s.io/client-go/testing"
	"k8s.io/client-go/util/retry"
)

func suspendedStartupFixture(t *testing.T) (*kubernetesQueue, *fake.Clientset, *batch.Job, *core.Secret) {
	t.Helper()
	q, c := kubeQueueFixture()
	j, err := q.job(directRunnerLaunch{runID: "work:startup/r1", runner: "executor", pipeline: "codex"})
	if err != nil {
		t.Fatal(err)
	}
	j.ResourceVersion = "1"
	j, err = c.BatchV1().Jobs(q.config.Namespace).Create(context.Background(), j, meta.CreateOptions{})
	if err != nil {
		t.Fatal(err)
	}
	s := &core.Secret{ObjectMeta: meta.ObjectMeta{Name: j.Name, Namespace: q.config.Namespace, OwnerReferences: []meta.OwnerReference{{APIVersion: "batch/v1", Kind: "Job", Name: j.Name, UID: j.UID, Controller: ptr(true)}}}, Immutable: ptr(true), Data: map[string][]byte{"run-token": []byte("private-token")}}
	s, err = c.CoreV1().Secrets(q.config.Namespace).Create(context.Background(), s, meta.CreateOptions{})
	if err != nil {
		t.Fatal(err)
	}
	return q, c, j, s
}

func startupConflict(name string) error {
	return apierrors.NewConflict(schema.GroupResource{Group: "batch", Resource: "jobs"}, name, fmt.Errorf("controller advanced resourceVersion"))
}

// Exercise the actual Create/credential/unsuspend path. The Job controller's
// status write races the first update; retry must preserve that status and
// revalidate the credential and durable run before using the fresh version.
func TestKubernetesLaunchRetriesFreshVersionAfterControllerConflict(t *testing.T) {
	q, c := kubeQueueFixture()
	c.PrependReactor("create", "jobs", func(a clienttesting.Action) (bool, runtime.Object, error) {
		a.(clienttesting.CreateAction).GetObject().(*batch.Job).ResourceVersion = "1"
		return false, nil, nil
	})
	updates, fences := 0, 0
	q.verifyRun = func(_ context.Context, runID, token string) error {
		fences++
		if runID != "work:startup/r1" || token != "private-token" {
			t.Fatal("fence did not receive original run credential")
		}
		return nil
	}
	c.PrependReactor("update", "jobs", func(a clienttesting.Action) (bool, runtime.Object, error) {
		updates++
		incoming := a.(clienttesting.UpdateAction).GetObject().(*batch.Job)
		if updates == 1 {
			stored, err := c.Tracker().Get(batch.SchemeGroupVersion.WithResource("jobs"), q.config.Namespace, incoming.Name)
			if err != nil {
				t.Fatal(err)
			}
			current := stored.(*batch.Job).DeepCopy()
			current.ResourceVersion = "2"
			current.Status.Conditions = []batch.JobCondition{{Type: batch.JobSuspended, Status: core.ConditionTrue}}
			if err := c.Tracker().Update(batch.SchemeGroupVersion.WithResource("jobs"), current, q.config.Namespace); err != nil {
				t.Fatal(err)
			}
			return true, nil, startupConflict(incoming.Name)
		}
		if incoming.ResourceVersion != "2" || len(incoming.Status.Conditions) != 1 {
			t.Fatal("retry overwrote controller status using stale version")
		}
		return false, nil, nil
	})
	l := directRunnerLaunch{runID: "work:startup/r1", runner: "executor", runToken: "private-token", pipeline: "codex"}
	if err := q.launch(context.Background(), l); err != nil {
		t.Fatal(err)
	}
	if err := q.launch(context.Background(), l); err != nil {
		t.Fatal(err)
	}
	jobs, _ := c.BatchV1().Jobs(q.config.Namespace).List(context.Background(), meta.ListOptions{})
	secrets, _ := c.CoreV1().Secrets(q.config.Namespace).List(context.Background(), meta.ListOptions{})
	if updates != 2 || fences != 2 || len(jobs.Items) != 1 || len(secrets.Items) != 1 || *jobs.Items[0].Spec.Suspend {
		t.Fatalf("updates=%d fences=%d jobs=%d secrets=%d", updates, fences, len(jobs.Items), len(secrets.Items))
	}
}

func TestKubernetesStartupFailureRetriesOriginalDuringRecovery(t *testing.T) {
	for _, failure := range []string{"persistent conflict", "transient read", "transient update"} {
		t.Run(failure, func(t *testing.T) {
			q, c, j, _ := suspendedStartupFixture(t)
			failing, updates := true, 0
			c.PrependReactor("get", "jobs", func(clienttesting.Action) (bool, runtime.Object, error) {
				if failing && failure == "transient read" {
					return true, nil, fmt.Errorf("API unavailable")
				}
				return false, nil, nil
			})
			c.PrependReactor("update", "jobs", func(clienttesting.Action) (bool, runtime.Object, error) {
				updates++
				if failing {
					if failure == "persistent conflict" {
						return true, nil, startupConflict(j.Name)
					}
					return true, nil, fmt.Errorf("API unavailable")
				}
				return false, nil, nil
			})
			if err := q.resume(context.Background(), j); err == nil {
				t.Fatal("startup failure ignored")
			}
			if failure == "persistent conflict" && updates != retry.DefaultBackoff.Steps {
				t.Fatalf("unbounded conflict retries: %d", updates)
			}
			failing = false
			before, _ := c.BatchV1().Jobs(q.config.Namespace).Get(context.Background(), j.Name, meta.GetOptions{})
			if !*before.Spec.Suspend {
				t.Fatal("failed handoff started attempt")
			}
			if err := q.recover(context.Background()); err != nil {
				t.Fatal(err)
			}
			jobs, _ := c.BatchV1().Jobs(q.config.Namespace).List(context.Background(), meta.ListOptions{})
			secrets, _ := c.CoreV1().Secrets(q.config.Namespace).List(context.Background(), meta.ListOptions{})
			if len(jobs.Items) != 1 || len(secrets.Items) != 1 || jobs.Items[0].UID != j.UID || *jobs.Items[0].Spec.Suspend {
				t.Fatal("recovery replaced or failed to resume original")
			}
		})
	}
}

func TestKubernetesStartupNeverAdoptsOrRestartsAttempt(t *testing.T) {
	for _, state := range []string{"UID replaced", "run changed", "runner changed", "label changed", "re-suspended", "deleting", "unsuspended", "started", "active", "succeeded", "failed", "complete", "failure target", "success criteria", "owned pod", "mutable secret", "wrong owner", "empty token", "expired lease", "settled run", "missing fence"} {
		t.Run(state, func(t *testing.T) {
			q, c, original, s := suspendedStartupFixture(t)
			j := original.DeepCopy()
			switch state {
			case "UID replaced":
				j.UID = "replacement"
			case "run changed":
				j.Annotations[queueRunAnnotation] = "work:other/r1"
			case "runner changed":
				j.Annotations[queueRunnerAnnotation] = "other"
			case "label changed":
				j.Labels[queueJobLabel] = "false"
			case "re-suspended":
				// Kubernetes clears StartTime and removes Pods on suspension;
				// zero counters and no Pods cannot prove it never executed.
				j.Generation = 3
			case "deleting":
				j.DeletionTimestamp = ptr(meta.Now())
			case "unsuspended":
				j.Spec.Suspend = ptr(false)
				j.Generation = 2
			case "started":
				j.Status.StartTime = ptr(meta.Now())
			case "active":
				j.Status.Active = 1
			case "succeeded":
				j.Status.Succeeded = 1
			case "failed":
				j.Status.Failed = 1
			case "complete":
				j.Status.Conditions = []batch.JobCondition{{Type: batch.JobComplete, Status: core.ConditionTrue}}
			case "failure target":
				j.Status.Conditions = []batch.JobCondition{{Type: batch.JobFailureTarget, Status: core.ConditionTrue}}
			case "success criteria":
				j.Status.Conditions = []batch.JobCondition{{Type: batch.JobSuccessCriteriaMet, Status: core.ConditionTrue}}
			case "owned pod":
				// No queue label: ownership, not a convenient selector, fences it.
				_, err := c.CoreV1().Pods(q.config.Namespace).Create(context.Background(), &core.Pod{ObjectMeta: meta.ObjectMeta{Name: "original-pod", OwnerReferences: []meta.OwnerReference{{Kind: "Job", UID: j.UID}}}}, meta.CreateOptions{})
				if err != nil {
					t.Fatal(err)
				}
			case "mutable secret":
				s.Immutable = ptr(false)
			case "wrong owner":
				s.OwnerReferences[0].UID = "other"
			case "empty token":
				s.Data["run-token"] = nil
			case "expired lease", "settled run":
				q.verifyRun = func(context.Context, string, string) error { return fmt.Errorf("run no longer live") }
			case "missing fence":
				q.verifyRun = nil
			}
			if _, err := c.BatchV1().Jobs(q.config.Namespace).Update(context.Background(), j, meta.UpdateOptions{}); err != nil {
				t.Fatal(err)
			}
			if _, err := c.CoreV1().Secrets(q.config.Namespace).Update(context.Background(), s, meta.UpdateOptions{}); err != nil {
				t.Fatal(err)
			}
			c.ClearActions()
			err := q.resume(context.Background(), original)
			mustReject := state == "UID replaced" || state == "run changed" || state == "runner changed" || state == "label changed" || state == "re-suspended" || state == "mutable secret" || state == "wrong owner" || state == "empty token" || state == "expired lease" || state == "settled run" || state == "missing fence"
			if (err != nil) != mustReject {
				t.Fatalf("unexpected refusal: %v", err)
			}
			for _, a := range c.Actions() {
				if a.GetVerb() == "update" || a.GetVerb() == "create" || a.GetVerb() == "delete" {
					t.Fatal("unsafe attempt mutated")
				}
			}
		})
	}
}

func TestKubernetesConflictRechecksAuthority(t *testing.T) {
	for _, changed := range []string{"run settled", "credential replaced", "Job replaced", "Job re-suspended"} {
		t.Run(changed, func(t *testing.T) {
			q, c, j, s := suspendedStartupFixture(t)
			updates, fences := 0, 0
			q.verifyRun = func(context.Context, string, string) error {
				fences++
				if updates > 0 && changed == "run settled" {
					return fmt.Errorf("run settled")
				}
				return nil
			}
			c.PrependReactor("update", "jobs", func(clienttesting.Action) (bool, runtime.Object, error) {
				updates++
				if changed == "credential replaced" {
					s.OwnerReferences[0].UID = "other"
					if err := c.Tracker().Update(core.SchemeGroupVersion.WithResource("secrets"), s, q.config.Namespace); err != nil {
						t.Fatal(err)
					}
				}
				if changed == "Job replaced" {
					replacement := j.DeepCopy()
					replacement.UID = "other"
					if err := c.Tracker().Update(batch.SchemeGroupVersion.WithResource("jobs"), replacement, q.config.Namespace); err != nil {
						t.Fatal(err)
					}
				}
				if changed == "Job re-suspended" {
					resuspended := j.DeepCopy()
					resuspended.Generation = 3
					if err := c.Tracker().Update(batch.SchemeGroupVersion.WithResource("jobs"), resuspended, q.config.Namespace); err != nil {
						t.Fatal(err)
					}
				}
				return true, nil, startupConflict(j.Name)
			})
			if err := q.resume(context.Background(), j); err == nil {
				t.Fatal("retried with stale authority")
			}
			if updates != 1 {
				t.Fatal("updated after authority changed")
			}
			wantFences := 1
			if changed == "run settled" {
				wantFences = 2
			}
			if fences != wantFences {
				t.Fatalf("fences=%d, want %d", fences, wantFences)
			}
		})
	}
}

func TestKubernetesConflictWithConcurrentResumeIsIdempotent(t *testing.T) {
	q, c, j, _ := suspendedStartupFixture(t)
	updates := 0
	c.PrependReactor("update", "jobs", func(clienttesting.Action) (bool, runtime.Object, error) {
		updates++
		winner := j.DeepCopy()
		winner.ResourceVersion = "2"
		winner.Generation = 2
		winner.Spec.Suspend = ptr(false)
		if err := c.Tracker().Update(batch.SchemeGroupVersion.WithResource("jobs"), winner, q.config.Namespace); err != nil {
			t.Fatal(err)
		}
		return true, nil, startupConflict(j.Name)
	})
	if err := q.resume(context.Background(), j); err != nil {
		t.Fatal("concurrent successful resume was not idempotent:", err)
	}
	if err := q.recover(context.Background()); err != nil {
		t.Fatal(err)
	}
	if updates != 1 {
		t.Fatalf("duplicate start after concurrent resume: %d", updates)
	}
}

func TestKubernetesStartupCancellationDoesNotUpdate(t *testing.T) {
	q, c, j, _ := suspendedStartupFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	q.verifyRun = func(context.Context, string, string) error { cancel(); return nil }
	c.ClearActions()
	if err := q.resume(ctx, j); err != context.Canceled {
		t.Fatalf("cancellation ignored: %v", err)
	}
	for _, a := range c.Actions() {
		if a.GetVerb() == "update" {
			t.Fatal("updated after cancellation")
		}
	}
}

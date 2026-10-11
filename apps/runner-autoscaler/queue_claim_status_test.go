package main

import (
	"context"
	"encoding/json"
	"fmt"
	"k8s.io/apimachinery/pkg/types"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	batch "k8s.io/api/batch/v1"
	core "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	meta "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	clienttesting "k8s.io/client-go/testing"
)

func TestQueueClaimStatusRequiresExactTypedAuthority(t *testing.T) {
	for _, kind := range []string{"settled", "live", "401", "404", "redirect", "malformed", "oversized", "wrong run", "wrong runner", "wrong fingerprint", "unknown status", "identity error", "cancelled"} {
		t.Run(kind, func(t *testing.T) {
			fingerprint := queueClaimFingerprint("private-run-token")
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Authorization") != "Bearer private-executor-token" || r.URL.Query().Get("runner") != "runner" || r.URL.Query().Get("claimFingerprint") != fingerprint || r.URL.Path != "/api/work/v1/runs/work:status/r1/claim-status" {
					t.Error("incorrect authenticated claim query")
				}
				if kind == "401" {
					w.WriteHeader(401)
					return
				}
				if kind == "404" {
					w.WriteHeader(404)
					return
				}
				if kind == "redirect" {
					w.Header().Set("Location", "/elsewhere")
					w.WriteHeader(302)
					return
				}
				if kind == "malformed" {
					fmt.Fprint(w, "private-run-token")
					return
				}
				if kind == "oversized" {
					fmt.Fprint(w, strings.Repeat("a", (64<<10)+1))
					return
				}
				body := map[string]string{"runId": "work:status/r1", "runner": "runner", "claimFingerprint": fingerprint, "status": "settled"}
				if kind == "live" {
					body["status"] = "live"
				}
				if kind == "wrong run" {
					body["runId"] = "other"
				}
				if kind == "wrong runner" {
					body["runner"] = "other"
				}
				if kind == "wrong fingerprint" {
					body["claimFingerprint"] = strings.Repeat("b", 64)
				}
				if kind == "unknown status" {
					body["status"] = "expired"
				}
				json.NewEncoder(w).Encode(body)
			}))
			defer server.Close()
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if kind == "cancelled" {
				cancel()
			}
			fence := queueClaimStatus(server.URL, func() (string, error) {
				if kind == "identity error" {
					return "", fmt.Errorf("private-executor-token")
				}
				return "private-executor-token", nil
			})
			settled, err := fence(ctx, "work:status/r1", "runner", fingerprint)
			if settled != (kind == "settled") || (err != nil) != (kind != "settled" && kind != "live") {
				t.Fatalf("settled=%v err=%v", settled, err)
			}
			if err != nil && (strings.Contains(err.Error(), "private-") || strings.Contains(err.Error(), server.URL)) {
				t.Fatal("credential/request details leaked")
			}
		})
	}
}

func TestKubernetesRetiresSettledOriginalAndDrainsPendingPods(t *testing.T) {
	for _, kind := range []string{"secret-less shell", "owned-secret legacy", "Pending", "Running"} {
		t.Run(kind, func(t *testing.T) {
			q, c, job, _ := suspendedStartupFixture(t)
			ctx := context.Background()
			c.CoreV1().Nodes().Create(ctx, queueReadyNode(), meta.CreateOptions{})
			fingerprint := queueClaimFingerprint("private-token")
			if kind != "owned-secret legacy" {
				job.Annotations[queueClaimAnnotation] = fingerprint
			}
			if kind == "secret-less shell" {
				c.CoreV1().Secrets(q.config.Namespace).Delete(ctx, job.Name, meta.DeleteOptions{})
			}
			if kind == "Pending" || kind == "Running" {
				job.Spec.Suspend = ptr(false)
				job.Generation = 2
				job.Status.StartTime = ptr(meta.Now())
				job.Status.Active = 1
				pod := &core.Pod{ObjectMeta: *job.Spec.Template.ObjectMeta.DeepCopy(), Status: core.PodStatus{Phase: core.PodPending}}
				pod.Name, pod.Namespace = "owned", q.config.Namespace
				pod.OwnerReferences = []meta.OwnerReference{{Kind: "Job", Name: job.Name, UID: job.UID, Controller: ptr(true)}}
				if kind == "Running" {
					pod.Status.Phase = core.PodRunning
					pod.Spec.NodeName = "node"
				}
				c.CoreV1().Pods(q.config.Namespace).Create(ctx, pod, meta.CreateOptions{})
			}
			c.Tracker().Update(batch.SchemeGroupVersion.WithResource("jobs"), job, q.config.Namespace)
			calls := 0
			q.claimSettled = func(_ context.Context, runID, runner, hash string) (bool, error) {
				calls++
				if runID != job.Annotations[queueRunAnnotation] || runner != "executor" || hash != fingerprint {
					t.Fatal("retirement not bound to original claim")
				}
				return true, nil
			}
			c.PrependReactor("delete", "jobs", func(a clienttesting.Action) (bool, runtime.Object, error) {
				options := a.(clienttesting.DeleteAction).GetDeleteOptions()
				if options.Preconditions == nil || *options.Preconditions.UID != job.UID || *options.Preconditions.ResourceVersion != "1" || options.PropagationPolicy == nil || *options.PropagationPolicy != meta.DeletePropagationForeground {
					t.Fatal("unguarded/nonforeground cancellation")
				}
				return false, nil, nil
			})
			if err := q.recover(ctx); err != nil {
				t.Fatal(err)
			}
			if _, err := c.BatchV1().Jobs(q.config.Namespace).Get(ctx, job.Name, meta.GetOptions{}); !apierrors.IsNotFound(err) || calls != 1 {
				t.Fatal("settled original retained")
			}
			if kind == "Pending" || kind == "Running" {
				if r, err := q.reserve(ctx); err != nil || r != nil {
					t.Fatal("admission opened with owned Pod still present")
				}
				c.CoreV1().Pods(q.config.Namespace).Delete(ctx, "owned", meta.DeleteOptions{})
			}
			r, err := q.reserve(ctx)
			if err != nil || r == nil {
				t.Fatal("successor admission stayed blocked after drainage")
			}
			r.release()
		})
	}
}

func TestKubernetesRetirementFailsClosed(t *testing.T) {
	for _, kind := range []string{"live", "authority error", "missing authority", "re-suspended", "replaced UID", "updated version", "wrong run", "missing runner", "deleting", "Secret-less legacy", "wrong Secret owner", "mutable Secret", "empty Secret"} {
		t.Run(kind, func(t *testing.T) {
			q, c, job, secret := suspendedStartupFixture(t)
			ctx := context.Background()
			job.Annotations[queueClaimAnnotation] = queueClaimFingerprint("private-token")
			q.claimSettled = func(context.Context, string, string, string) (bool, error) {
				if kind == "authority error" {
					return false, fmt.Errorf("HTTP401")
				}
				if kind == "replaced UID" || kind == "updated version" {
					fresh := job.DeepCopy()
					if kind == "replaced UID" {
						fresh.UID = "new-job"
					} else {
						fresh.ResourceVersion = "2"
					}
					c.Tracker().Update(batch.SchemeGroupVersion.WithResource("jobs"), fresh, q.config.Namespace)
				}
				return kind != "live", nil
			}
			switch kind {
			case "missing authority":
				q.claimSettled = nil
			case "re-suspended":
				job.Generation = 3
			case "wrong run":
				job.Annotations[queueRunAnnotation] = "work:other/r1"
			case "missing runner":
				delete(job.Annotations, queueRunnerAnnotation)
			case "deleting":
				job.DeletionTimestamp = ptr(meta.Now())
			case "Secret-less legacy":
				delete(job.Annotations, queueClaimAnnotation)
				c.CoreV1().Secrets(q.config.Namespace).Delete(ctx, job.Name, meta.DeleteOptions{})
			case "wrong Secret owner", "mutable Secret", "empty Secret":
				delete(job.Annotations, queueClaimAnnotation)
				if kind == "wrong Secret owner" {
					secret.OwnerReferences[0].UID = "other"
				}
				if kind == "mutable Secret" {
					secret.Immutable = ptr(false)
				}
				if kind == "empty Secret" {
					secret.Data = nil
				}
				c.Tracker().Update(core.SchemeGroupVersion.WithResource("secrets"), secret, q.config.Namespace)
			}
			c.Tracker().Update(batch.SchemeGroupVersion.WithResource("jobs"), job, q.config.Namespace)
			c.PrependReactor("delete", "jobs", func(a clienttesting.Action) (bool, runtime.Object, error) {
				if kind != "replaced UID" && kind != "updated version" {
					t.Fatal("unsafe claim deletion")
				}
				options := a.(clienttesting.DeleteAction).GetDeleteOptions()
				stored, err := c.Tracker().Get(batch.SchemeGroupVersion.WithResource("jobs"), q.config.Namespace, job.Name)
				if err != nil {
					t.Fatal(err)
				}
				fresh := stored.(*batch.Job)
				if options.Preconditions == nil || (fresh.UID == *options.Preconditions.UID && fresh.ResourceVersion == *options.Preconditions.ResourceVersion) {
					t.Fatal("retirement did not retain original preconditions across concurrent replacement/update")
				}
				return true, nil, startupConflict(job.Name)
			})
			q.cleanup(ctx)
			if _, err := c.BatchV1().Jobs(q.config.Namespace).Get(ctx, job.Name, meta.GetOptions{}); err != nil {
				t.Fatal("original/replacement lost")
			}
		})
	}
}

func TestKubernetesLaunchRejectsAnotherClaimBeforeSecretAdoption(t *testing.T) {
	q, c, job, _ := suspendedStartupFixture(t)
	job.Annotations[queueClaimAnnotation] = queueClaimFingerprint("old-token")
	c.Tracker().Update(batch.SchemeGroupVersion.WithResource("jobs"), job, q.config.Namespace)
	c.PrependReactor("create", "secrets", func(clienttesting.Action) (bool, runtime.Object, error) {
		t.Fatal("adopted old claim credential")
		return true, nil, nil
	})
	if err := q.launch(context.Background(), directRunnerLaunch{runID: job.Annotations[queueRunAnnotation], runner: "executor", runToken: "fresh-token", pipeline: "codex"}); err == nil {
		t.Fatal("same-run different claim adopted")
	}
}

func TestKubernetesRetirementAdmissionWaitsForForegroundDeletion(t *testing.T) {
	q, c, job, _ := suspendedStartupFixture(t)
	ctx := context.Background()
	c.CoreV1().Nodes().Create(ctx, queueReadyNode(), meta.CreateOptions{})
	job.DeletionTimestamp = ptr(meta.Now())
	job.Status.Conditions = []batch.JobCondition{{Type: batch.JobFailed, Status: core.ConditionTrue}}
	c.Tracker().Update(batch.SchemeGroupVersion.WithResource("jobs"), job, q.config.Namespace)
	if r, err := q.reserve(ctx); err != nil || r != nil {
		t.Fatal("terminal foreground Job released admission before drainage")
	}
}

// Exercise retirement through authenticated status, foreground drainage,
// reservation, credential creation and unsuspend, rather than treating a free
// reservation as proof that the next attempt can actually launch.
func TestKubernetesRetirementAllowsSuccessorAndUnrelatedLaunch(t *testing.T) {
	for _, runID := range []string{"work:startup/r2", "work:unrelated/r1"} {
		t.Run(runID, func(t *testing.T) {
			q, c, original, _ := suspendedStartupFixture(t)
			ctx := context.Background()
			if _, err := c.CoreV1().Nodes().Create(ctx, queueReadyNode(), meta.CreateOptions{}); err != nil {
				t.Fatal(err)
			}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Authorization") != "Bearer executor-identity" || r.URL.Query().Get("runner") != "executor" || r.URL.Query().Get("claimFingerprint") != queueClaimFingerprint("private-token") || r.URL.Path != "/api/work/v1/runs/work:startup/r1/claim-status" {
					t.Error("status authority was not bound to the original claim")
					w.WriteHeader(http.StatusForbidden)
					return
				}
				json.NewEncoder(w).Encode(map[string]string{"runId": "work:startup/r1", "runner": "executor", "claimFingerprint": queueClaimFingerprint("private-token"), "status": "settled"})
			}))
			defer server.Close()
			q.claimSettled = queueClaimStatus(server.URL, func() (string, error) { return "executor-identity", nil })
			c.PrependReactor("delete", "jobs", func(a clienttesting.Action) (bool, runtime.Object, error) {
				options := a.(clienttesting.DeleteAction).GetDeleteOptions()
				if options.Preconditions == nil || *options.Preconditions.UID != original.UID || *options.Preconditions.ResourceVersion != original.ResourceVersion || options.PropagationPolicy == nil || *options.PropagationPolicy != meta.DeletePropagationForeground {
					t.Fatal("retirement lost its original identity or foreground fence")
				}
				deleting := original.DeepCopy()
				deleting.DeletionTimestamp = ptr(meta.Now())
				return true, nil, c.Tracker().Update(batch.SchemeGroupVersion.WithResource("jobs"), deleting, q.config.Namespace)
			})
			if reservation, err := q.reserve(ctx); err != nil || reservation != nil {
				t.Fatal("original never-started Job did not block admission")
			}
			if err := q.recover(ctx); err != nil {
				t.Fatal(err)
			}
			retiring, err := c.BatchV1().Jobs(q.config.Namespace).Get(ctx, original.Name, meta.GetOptions{})
			if err != nil || retiring.DeletionTimestamp == nil {
				t.Fatalf("settled original was not retired by recovery: %v", err)
			}
			if reservation, err := q.reserve(ctx); err != nil || reservation != nil {
				t.Fatal("admission opened before foreground Job drainage")
			}
			// The fake API has no garbage collector. Complete its foreground
			// deletion explicitly, without changing the executor's admission path.
			if err := c.Tracker().Delete(batch.SchemeGroupVersion.WithResource("jobs"), q.config.Namespace, original.Name); err != nil {
				t.Fatal(err)
			}
			reservation, err := q.reserve(ctx)
			if err != nil || reservation == nil {
				t.Fatalf("drained original still blocked admission: %v", err)
			}
			defer reservation.release()
			verified := false
			q.verifyRun = func(_ context.Context, admittedID, token string) error {
				if admittedID != runID || token != "fresh-token" {
					return fmt.Errorf("new launch reused original claim")
				}
				verified = true
				return nil
			}
			if err := reservation.launch(directRunnerLaunch{runID: runID, runner: "executor", pipeline: "codex", runToken: "fresh-token"}); err != nil {
				t.Fatal(err)
			}
			job, err := c.BatchV1().Jobs(q.config.Namespace).Get(ctx, queueJobName(runID), meta.GetOptions{})
			if err != nil || !verified || job.Spec.Suspend == nil || *job.Spec.Suspend {
				t.Fatalf("admitted attempt did not pass its own fence and launch: %v", err)
			}
			secret, err := c.CoreV1().Secrets(q.config.Namespace).Get(ctx, job.Name, meta.GetOptions{})
			if err != nil || string(secret.Data["run-token"]) != "fresh-token" || secret.OwnerReferences[0].Name != job.Name || secret.OwnerReferences[0].UID != job.UID {
				t.Fatalf("admitted attempt lacks its own owned credential: %v", err)
			}
		})
	}
}

func TestKubernetesStatusFailurePreservesTerminalRetention(t *testing.T) {
	q, c := kubeQueueFixture()
	q.config.MaxConcurrent = 1
	ctx := context.Background()
	live, err := q.job(directRunnerLaunch{runID: "work:badclaim/r1", runner: "executor", pipeline: "codex", runToken: "token"})
	if err != nil {
		t.Fatal(err)
	}
	live.UID = "live"
	live.ResourceVersion = "1"
	live.Generation = 2
	live.Spec.Suspend = ptr(false)
	live.Status.Active = 1
	if err := c.Tracker().Create(batch.SchemeGroupVersion.WithResource("jobs"), live, q.config.Namespace); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 6; i++ {
		job, err := q.job(directRunnerLaunch{runID: fmt.Sprintf("work:finished%d/r1", i), pipeline: "codex"})
		if err != nil {
			t.Fatal(err)
		}
		job.UID = types.UID(fmt.Sprintf("finished%d", i))
		job.ResourceVersion = "1"
		job.Status.Conditions = []batch.JobCondition{{Type: batch.JobComplete, Status: core.ConditionTrue, LastTransitionTime: meta.NewTime(time.Now().Add(-time.Hour + time.Duration(i)*time.Minute))}}
		if err := c.Tracker().Create(batch.SchemeGroupVersion.WithResource("jobs"), job, q.config.Namespace); err != nil {
			t.Fatal(err)
		}
	}
	q.claimSettled = func(context.Context, string, string, string) (bool, error) {
		return false, fmt.Errorf("status unavailable")
	}
	if err := q.cleanup(ctx); err == nil {
		t.Fatal("status authority error hidden")
	}
	jobs, err := c.BatchV1().Jobs(q.config.Namespace).List(ctx, meta.ListOptions{})
	if err != nil {
		t.Fatal(err)
	}
	finished := 0
	for _, job := range jobs.Items {
		if queueJobTerminal(job) {
			finished++
		}
	}
	if finished != q.config.MaxConcurrent*queueJobRetentionPerSlot {
		t.Fatalf("failed status prevented terminal retention: %d", finished)
	}
	if _, err := c.BatchV1().Jobs(q.config.Namespace).Get(ctx, live.Name, meta.GetOptions{}); err != nil {
		t.Fatal("failed status retired active claim")
	}
}

package main

import (
	"context"
	"fmt"
	"sort"
	"testing"

	batch "k8s.io/api/batch/v1"
	core "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	meta "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
)

func TestKubernetesBoundedSweepsEventuallyReachLaterSettledClaim(t *testing.T) {
	for _, cleanup := range []bool{false, true} {
		t.Run(fmt.Sprintf("cleanup=%v", cleanup), func(t *testing.T) {
			q, c := kubeQueueFixture(queueReadyNode())
			ctx := context.Background()
			var jobs []*batch.Job
			for i := 0; i < 5; i++ {
				job, err := q.job(directRunnerLaunch{runID: fmt.Sprintf("work:fairness%d/r1", i), runner: "executor", pipeline: "codex", runToken: "fixture"})
				if err != nil {
					t.Fatal(err)
				}
				job.UID = types.UID(fmt.Sprintf("job%d", i))
				job.ResourceVersion = "1"
				job.Generation = 2
				job.Spec.Suspend = ptr(false)
				job.Status.Active = 1
				job.Status.StartTime = ptr(meta.Now())
				jobs = append(jobs, job)
				if err := c.Tracker().Create(batch.SchemeGroupVersion.WithResource("jobs"), job, q.config.Namespace); err != nil {
					t.Fatal(err)
				}
			}
			sort.Slice(jobs, func(i, j int) bool { return jobs[i].Name < jobs[j].Name })
			target := jobs[len(jobs)-1]
			// Only this settled Job is unplaced and blocks useful admission.
			for _, job := range jobs[:len(jobs)-1] {
				pod := &core.Pod{ObjectMeta: meta.ObjectMeta{Name: job.Name, Namespace: q.config.Namespace, OwnerReferences: []meta.OwnerReference{{Kind: "Job", Name: job.Name, UID: job.UID, Controller: ptr(true)}}}, Spec: core.PodSpec{NodeName: "node"}, Status: core.PodStatus{Phase: core.PodRunning}}
				c.CoreV1().Pods(q.config.Namespace).Create(ctx, pod, meta.CreateOptions{})
			}
			q.config.MaxConcurrent = 8
			if r, err := q.reserve(ctx); err != nil || r != nil {
				t.Fatal("unplaced settled claim did not block admission")
			}
			attempts := map[string]int{}
			var exhaust context.CancelFunc
			q.claimSettled = func(ctx context.Context, runID, runner, fingerprint string) (bool, error) {
				if err := ctx.Err(); err != nil {
					return false, err
				}
				attempts[runID]++
				if runID == target.Annotations[queueRunAnnotation] {
					return true, nil
				}
				// An earlier successful live lookup consumes the whole sweep.
				// Cancellation pins this boundary without a flaky wall-clock race.
				exhaust()
				return false, nil
			}
			for range 5 {
				sweep, cancel := context.WithCancel(ctx)
				exhaust = cancel
				if cleanup {
					q.cleanup(sweep)
				} else {
					q.recover(sweep)
				}
				cancel()
			}
			if attempts[target.Annotations[queueRunAnnotation]] != 1 {
				t.Fatalf("later settled claim starved: %v", attempts)
			}
			if _, err := c.BatchV1().Jobs(q.config.Namespace).Get(ctx, target.Name, meta.GetOptions{}); !apierrors.IsNotFound(err) {
				t.Fatal("settled target retained")
			}
			r, err := q.reserve(ctx)
			if err != nil || r == nil {
				t.Fatal("unrelated/successor admission stayed blocked")
			}
			r.release()
		})
	}
}

func TestQueueSweepCursorSurvivesLastJobDeletion(t *testing.T) {
	c := queueSweepCursor{}
	c.visit("b")
	jobs := []batch.Job{{ObjectMeta: meta.ObjectMeta{Name: "a"}}, {ObjectMeta: meta.ObjectMeta{Name: "c"}}}
	ordered := c.ordered(jobs)
	if ordered[0].Name != "c" || ordered[1].Name != "a" {
		t.Fatal("deleted cursor restarted at first Job")
	}
	c.visit("z")
	if c.ordered(jobs)[0].Name != "a" {
		t.Fatal("cursor failed to wrap")
	}
}

package main

import (
	"context"
	"testing"

	meta "k8s.io/apimachinery/pkg/apis/meta/v1"
)

func TestGooseJobUsesSupportedRunnerAndCredentials(t *testing.T) {
	q, _ := kubeQueueFixture()
	launch := directRunnerLaunch{runID: "work:recipe/r1", pipeline: "goose"}
	q.config.Requests = map[string]string{"cpu": "2", "memory": "6Gi", "ephemeral-storage": "24Gi"}
	q.config.Limits = map[string]string{"cpu": "2", "memory": "6Gi", "ephemeral-storage": "24Gi"}
	// Recipes run on the ordinary executor path.
	job, err := q.job(launch)
	if err != nil {
		t.Fatal(err)
	}
	if len(job.Spec.Template.Spec.Containers) != 1 {
		t.Fatal("Goose must use the normal single runner")
	}
	c := job.Spec.Template.Spec.Containers[0]
	if c.Image != q.image || len(c.Command) != 0 {
		t.Fatal("Goose bypassed the supported runner entrypoint")
	}
	for name, expected := range queueResources(q.config.Requests) {
		request, limit := c.Resources.Requests[name], c.Resources.Limits[name]
		if request.Cmp(expected) != 0 || limit.Cmp(expected) != 0 {
			t.Fatal("allocation differs from normal lane")
		}
	}
	found := map[string]bool{}
	for _, v := range job.Spec.Template.Spec.Volumes {
		if v.Secret != nil {
			for _, item := range v.Secret.Items {
				found[item.Key] = true
			}
		}
	}
	if !found["goose-config.yaml"] || !found["goose-environment.json"] || found["claude-code-oauth-token"] || found["opencode-llm-api-key"] {
		t.Fatal("wrong provider credentials projected")
	}
	// The recipe deadline is on the Pod only: queue wait never consumes it.
	if job.Spec.ActiveDeadlineSeconds != nil || job.Spec.Template.Spec.ActiveDeadlineSeconds == nil || *job.Spec.Template.Spec.ActiveDeadlineSeconds != 1800 {
		t.Fatal("recipe deadline not bounded on the Pod alone")
	}
	q.config.Limits["cpu"] = "3"
	if _, err = q.job(launch); err == nil {
		t.Fatal("oversized recipe job accepted")
	}
}

// A claim whose Job cannot even be built has no worker: the executor reports
// the exit at once instead of holding the claim until its start deadline.
func TestUnbuildableJobReportsItsClaimExited(t *testing.T) {
	q, client := kubeQueueFixture()
	q.config.Requests = map[string]string{"cpu": "2", "memory": "6Gi", "ephemeral-storage": "24Gi"}
	q.config.Limits = map[string]string{"cpu": "3", "memory": "6Gi", "ephemeral-storage": "24Gi"}
	recorder := &exitReportRecorder{}
	q.exits = testExitReporter(recorder.server(t).URL)

	err := q.launch(context.Background(), directRunnerLaunch{runID: "work:recipe/r1", runToken: "fixture-run-token", pipeline: "goose", runner: "executor-0"})
	if err == nil {
		t.Fatal("oversized recipe job launched")
	}
	q.exits.wg.Wait()

	if jobs, _ := client.BatchV1().Jobs("lcars-work").List(context.Background(), meta.ListOptions{}); len(jobs.Items) != 0 {
		t.Fatal("a Job was created for an unbuildable launch")
	}
	paths := recorder.requests()
	if len(paths) != 1 || paths[0] != "/api/work/v1/runs/work:recipe%2Fr1/exit" || recorder.runners[0] != "executor-0" || recorder.fingerprints[0] != testClaimFingerprint {
		t.Fatalf("exit reports = %v runners = %v; want one for the claim", paths, recorder.runners)
	}
}

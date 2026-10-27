package main

import "testing"

func TestGooseJobUsesSupportedRunnerAndCredentials(t *testing.T) {
	q, _ := kubeQueueFixture()
	launch := directRunnerLaunch{runID: "work:recipe/r1", pipeline: "goose"}
	if _, err := q.job(launch); err == nil {
		t.Fatal("accepted recipe without capacity receipt")
	}
	q.config.Capacity = &queueCapacityConfig{WorkerAudience: "lcars-worker"}
	q.config.Requests = map[string]string{"cpu": "2", "memory": "6Gi", "ephemeral-storage": "24Gi"}
	q.config.Limits = map[string]string{"cpu": "2", "memory": "6Gi", "ephemeral-storage": "24Gi"}
	launch.receipt = &capacityFence{RunID: launch.runID}
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

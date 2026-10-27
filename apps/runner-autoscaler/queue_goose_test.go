package main

import (
	core "k8s.io/api/core/v1"
	"strings"
	"testing"
)

func TestGooseJobRequiresReceiptAndIsolatesCredentials(t *testing.T) {
	q, _ := kubeQueueFixture()
	t.Setenv("LCARS_GOOSE_IMAGE", "registry.example/goose@sha256:"+strings.Repeat("a", 64))
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
	container := job.Spec.Template.Spec.Containers[0]
	if len(job.Spec.Template.Spec.Containers) != 2 || job.Spec.Template.Spec.ShareProcessNamespace == nil || *job.Spec.Template.Spec.ShareProcessNamespace {
		t.Fatal("recipe must have a separate process namespace")
	}
	recipe := job.Spec.Template.Spec.Containers[1]
	if len(recipe.Env) != 1 || recipe.Env[0].Name != "LCARS_JOB_ROLE" {
		t.Fatal("recipe received control-plane environment")
	}
	for _, mount := range recipe.VolumeMounts {
		if mount.Name == "worker-identity" {
			t.Fatal("recipe received worker identity")
		}
	}
	for _, mount := range container.VolumeMounts {
		if mount.Name == "credentials" {
			t.Fatal("bootstrap received tool credentials")
		}
	}
	for name, expected := range queueResources(q.config.Requests) {
		sum := container.Resources.Requests[name]
		sum.Add(recipe.Resources.Requests[name])
		bootstrapLimit := container.Resources.Limits[name]
		recipeLimit := recipe.Resources.Limits[name]
		if sum.Cmp(expected) != 0 || bootstrapLimit.Cmp(container.Resources.Requests[name]) != 0 || recipeLimit.Cmp(recipe.Resources.Requests[name]) != 0 {
			t.Fatal("container resources do not equal the whole-job allocation")
		}
	}
	if container.SecurityContext.ReadOnlyRootFilesystem == nil || !*container.SecurityContext.ReadOnlyRootFilesystem {
		t.Fatal("writable root")
	}
	if len(container.Command) != 2 || !strings.HasSuffix(container.Command[1], "goose-worker.mjs") {
		t.Fatal("wrong worker")
	}
	for _, volume := range job.Spec.Template.Spec.Volumes {
		if volume.Name == "credentials" && volume.Secret.SecretName != "lcars-goose-profile" {
			t.Fatal("coding credentials exposed")
		}
		if volume.Name == "work" && volume.EmptyDir.Medium != core.StorageMediumMemory {
			t.Fatal("scratch has no hard boundary")
		}
	}
	q.config.Limits["cpu"] = "3"
	if _, err = q.job(launch); err == nil {
		t.Fatal("oversized recipe job accepted")
	}
}

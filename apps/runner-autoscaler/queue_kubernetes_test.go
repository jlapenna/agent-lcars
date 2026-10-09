package main

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"testing"
	"time"

	auth "k8s.io/api/authorization/v1"
	batch "k8s.io/api/batch/v1"
	core "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	meta "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/kubernetes/fake"
	clienttesting "k8s.io/client-go/testing"
)

func kubeQueueFixture(objects ...runtime.Object) (*kubernetesQueue, *fake.Clientset) {
	c := fake.NewClientset(objects...)
	q := &kubernetesQueue{client: c, image: "registry.example.com/runner:live", logger: slog.New(slog.NewTextHandler(io.Discard, nil)), config: queueKubernetesConfig{Namespace: "lcars-work", CredentialsSecret: "credentials", ServiceAccount: "worker", MaxConcurrent: 2, NodeSelector: map[string]string{"queue-runner": "true"}, Requests: map[string]string{"cpu": "500m", "memory": "1Gi", "ephemeral-storage": "4Gi"}, Limits: map[string]string{"cpu": "4", "memory": "8Gi", "ephemeral-storage": "24Gi"}}}
	c.PrependReactor("create", "jobs", func(a clienttesting.Action) (bool, runtime.Object, error) {
		j := a.(clienttesting.CreateAction).GetObject().(*batch.Job)
		j.UID = types.UID("job-uid")
		j.CreationTimestamp = meta.Now()
		return false, nil, nil
	})
	return q, c
}
func queueReadyNode() *core.Node {
	return &core.Node{ObjectMeta: meta.ObjectMeta{Name: "node", Labels: map[string]string{"queue-runner": "true"}}, Status: core.NodeStatus{Conditions: []core.NodeCondition{{Type: core.NodeReady, Status: core.ConditionTrue}}, Allocatable: core.ResourceList{core.ResourceCPU: resource.MustParse("4"), core.ResourceMemory: resource.MustParse("8Gi"), core.ResourceEphemeralStorage: resource.MustParse("30Gi"), core.ResourcePods: resource.MustParse("20")}}}
}

// Protect claim eligibility and secret isolation through the real API client.
func TestKubernetesReserveEligibilityAndPendingPlacement(t *testing.T) {
	for _, kind := range []string{"inference busy", "offline", "cordoned", "ARC cpu", "ARC init memory", "API unavailable"} {
		t.Run(kind, func(t *testing.T) {
			n := queueReadyNode()
			objects := []runtime.Object{n}
			switch kind {
			case "inference busy":
				n.Spec.Taints = []core.Taint{{Key: "inference-busy", Effect: core.TaintEffectNoSchedule}}
			case "offline":
				n.Status.Conditions[0].Status = core.ConditionFalse
			case "cordoned":
				n.Spec.Unschedulable = true
			case "ARC cpu", "ARC init memory":
				pod := &core.Pod{ObjectMeta: meta.ObjectMeta{Name: "arc", Namespace: "arc"}, Spec: core.PodSpec{NodeName: n.Name}}
				if kind == "ARC cpu" {
					pod.Spec.Containers = []core.Container{{Name: "runner", Resources: core.ResourceRequirements{Requests: core.ResourceList{core.ResourceCPU: resource.MustParse("4")}}}}
				} else {
					pod.Spec.InitContainers = []core.Container{{Name: "init", Resources: core.ResourceRequirements{Requests: core.ResourceList{core.ResourceMemory: resource.MustParse("8Gi")}}}}
				}
				objects = append(objects, pod)
			}
			q, c := kubeQueueFixture(objects...)
			if kind == "API unavailable" {
				c.PrependReactor("list", "pods", func(clienttesting.Action) (bool, runtime.Object, error) { return true, nil, fmt.Errorf("unavailable") })
			}
			r, err := q.reserve(context.Background())
			wantPending := kind == "ARC cpu" || kind == "ARC init memory"
			if (r != nil) != wantPending || (err != nil) != (kind == "API unavailable") {
				t.Fatalf("reservation=%v err=%v; pending placement allowed=%v", r, err, wantPending)
			}
			if r != nil {
				r.release()
			}
		})
	}
}
func TestKubernetesCapacityIncludesPendingAndHeldJobs(t *testing.T) {
	q, c := kubeQueueFixture(queueReadyNode())
	ctx := context.Background()
	r1, err := q.reserve(ctx)
	if err != nil || r1 == nil {
		t.Fatal(err)
	}
	defer r1.release()
	r2, err := q.reserve(ctx)
	if err != nil || r2 != nil {
		t.Fatal("a held reservation must prevent a second pending claim")
	}
	r1.release()
	r1.release()
	_, err = c.BatchV1().Jobs(q.config.Namespace).Create(ctx, &batch.Job{ObjectMeta: meta.ObjectMeta{Name: queueJobName("work:pending/r1"), Labels: map[string]string{queueJobLabel: "true"}, Annotations: map[string]string{queueRunAnnotation: "work:pending/r1"}}}, meta.CreateOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if r, err := q.reserve(ctx); err != nil || r != nil {
		t.Fatal("an existing pending Job must prevent a second pending claim")
	}
}
func TestKubernetesLaunchProviderIsolationAndSingleAttempt(t *testing.T) {
	for _, provider := range []string{"claude", "codex", "opencode"} {
		t.Run(provider, func(t *testing.T) {
			q, c := kubeQueueFixture()
			ctx := context.Background()
			l := directRunnerLaunch{runID: "work:example/r1", runToken: "secret-run-token", pipeline: provider, consoleURL: "https://console.example.com"}
			for range 2 {
				if err := q.launch(ctx, l); err != nil {
					t.Fatal(err)
				}
			}
			jobs, _ := c.BatchV1().Jobs(q.config.Namespace).List(ctx, meta.ListOptions{})
			if len(jobs.Items) != 1 {
				t.Fatal("duplicate attempt")
			}
			j := jobs.Items[0]
			p := j.Spec.Template.Spec
			if p.DNSPolicy != core.DNSClusterFirst || p.DNSConfig == nil || len(p.DNSConfig.Options) != 1 || p.DNSConfig.Options[0].Name != "ndots" || p.DNSConfig.Options[0].Value == nil || *p.DNSConfig.Options[0].Value != "1" {
				t.Fatal("external API names must resolve before search suffixes while retaining cluster DNS")
			}
			if *j.Spec.Suspend || *j.Spec.BackoffLimit != 0 || p.RestartPolicy != core.RestartPolicyNever || *p.AutomountServiceAccountToken || p.NodeName != "" {
				t.Fatal("single attempt/scheduling policy violated")
			}
			if *j.Spec.PodReplacementPolicy != batch.Failed {
				t.Fatal("replacement can overlap terminating pod")
			}
			for _, env := range p.Containers[0].Env {
				if env.Name == "LCARS_RUN_TOKEN" && (env.Value != "" || env.ValueFrom == nil || env.ValueFrom.SecretKeyRef.Name != j.Name) {
					t.Fatal("run token exposed in pod spec")
				}
			}
			keys := map[string]bool{}
			volatile := false
			for _, v := range p.Volumes {
				if v.HostPath != nil {
					t.Fatal("host file dependency")
				}
				if v.Secret != nil {
					for _, item := range v.Secret.Items {
						keys[item.Key] = true
					}
				}
				if v.Name == "codex-volatile" {
					volatile = v.EmptyDir != nil && v.EmptyDir.Medium == core.StorageMediumMemory
				}
			}
			if !keys["telemetry-writer.json"] || keys["claude-code-oauth-token"] != (provider == "claude") || keys["opencode-llm-api-key"] != (provider == "opencode") || volatile != (provider == "codex") {
				t.Fatal("provider isolation violated")
			}
			secret, _ := c.CoreV1().Secrets(q.config.Namespace).Get(ctx, j.Name, meta.GetOptions{})
			if string(secret.Data["run-token"]) != l.runToken || secret.OwnerReferences[0].UID != j.UID || !*secret.Immutable {
				t.Fatal("run Secret not owned by exact Job")
			}
		})
	}
}
func TestKubernetesRecoveryAndAmbiguousCreate(t *testing.T) {
	q, c := kubeQueueFixture()
	ctx := context.Background()
	l := directRunnerLaunch{runID: "work:recover/r1", runToken: "token", pipeline: "codex"}
	j, _ := q.job(l)
	j, _ = c.BatchV1().Jobs(q.config.Namespace).Create(ctx, j, meta.CreateOptions{})
	_, err := c.CoreV1().Secrets(q.config.Namespace).Create(ctx, &core.Secret{ObjectMeta: meta.ObjectMeta{Name: j.Name, OwnerReferences: []meta.OwnerReference{{UID: j.UID, Kind: "Job"}}}, Data: map[string][]byte{"run-token": []byte("token")}}, meta.CreateOptions{})
	if err != nil {
		t.Fatal(err)
	}
	c.PrependReactor("create", "jobs", func(clienttesting.Action) (bool, runtime.Object, error) {
		return true, nil, fmt.Errorf("timeout after persistence")
	})
	if err := q.launch(ctx, l); err != nil {
		t.Fatal(err)
	}
	j, _ = c.BatchV1().Jobs(q.config.Namespace).Get(ctx, j.Name, meta.GetOptions{})
	if *j.Spec.Suspend {
		t.Fatal("persisted attempt not recovered")
	}
	j.Spec.Suspend = ptr(true)
	j.Status.StartTime = ptr(meta.Now())
	_, _ = c.BatchV1().Jobs(q.config.Namespace).Update(ctx, j, meta.UpdateOptions{})
	if err := q.recover(ctx); err != nil {
		t.Fatal(err)
	}
	j, _ = c.BatchV1().Jobs(q.config.Namespace).Get(ctx, j.Name, meta.GetOptions{})
	if !*j.Spec.Suspend {
		t.Fatal("previously executed attempt restarted")
	}
}
func TestKubernetesCredentialFailureKeepsJobSuspended(t *testing.T) {
	q, c := kubeQueueFixture()
	ctx := context.Background()
	l := directRunnerLaunch{runID: "work:denied/r1", pipeline: "codex", runToken: "token"}
	c.PrependReactor("create", "secrets", func(clienttesting.Action) (bool, runtime.Object, error) { return true, nil, fmt.Errorf("denied") })
	if err := q.launch(ctx, l); err == nil {
		t.Fatal("credential failure ignored")
	}
	j, _ := c.BatchV1().Jobs(q.config.Namespace).Get(ctx, queueJobName(l.runID), meta.GetOptions{})
	if !*j.Spec.Suspend {
		t.Fatal("started without credential")
	}
}
func TestKubernetesRecoveryRejectsWrongSecretOwner(t *testing.T) {
	q, c := kubeQueueFixture()
	ctx := context.Background()
	l := directRunnerLaunch{runID: "work:identity/r1", runToken: "token", pipeline: "codex"}
	j, _ := q.job(l)
	j, _ = c.BatchV1().Jobs(q.config.Namespace).Create(ctx, j, meta.CreateOptions{})
	_, _ = c.CoreV1().Secrets(q.config.Namespace).Create(ctx, &core.Secret{ObjectMeta: meta.ObjectMeta{Name: j.Name, OwnerReferences: []meta.OwnerReference{{UID: "other", Kind: "Job"}}}, Data: map[string][]byte{"run-token": []byte("token")}}, meta.CreateOptions{})
	if err := q.launch(ctx, l); err == nil {
		t.Fatal("adopted unrelated credential")
	}
	j, _ = c.BatchV1().Jobs(q.config.Namespace).Get(ctx, j.Name, meta.GetOptions{})
	if !*j.Spec.Suspend {
		t.Fatal("identity conflict launched work")
	}
}
func TestKubernetesCleanupPreservesExecutingJob(t *testing.T) {
	q, c := kubeQueueFixture()
	ctx := context.Background()
	for _, active := range []bool{false, true} {
		j, _ := q.job(directRunnerLaunch{runID: fmt.Sprintf("work:%v/r1", active), pipeline: "codex"})
		j.CreationTimestamp = meta.NewTime(time.Now().Add(-3 * time.Hour))
		if active {
			j.Spec.Suspend = ptr(false)
			j.Status.StartTime = ptr(meta.Now())
		}
		if err := c.Tracker().Create(batch.SchemeGroupVersion.WithResource("jobs"), j, q.config.Namespace); err != nil {
			t.Fatal(err)
		}
	}
	if err := q.cleanup(ctx); err != nil {
		t.Fatal(err)
	}
	jobs, _ := c.BatchV1().Jobs(q.config.Namespace).List(ctx, meta.ListOptions{})
	if len(jobs.Items) != 1 || *jobs.Items[0].Spec.Suspend {
		t.Fatal("cleanup removed executing attempt")
	}
}
func TestKubernetesUnknownProviderHasNoSideEffects(t *testing.T) {
	q, c := kubeQueueFixture()
	err := q.launch(context.Background(), directRunnerLaunch{runID: "work:x/r1", pipeline: "unknown"})
	if err == nil || len(c.Actions()) != 0 {
		t.Fatal("unknown provider mutated cluster")
	}
}

func TestKubernetesPreflightRequiresWorkerAccountAndWriteGrants(t *testing.T) {
	for _, missing := range []string{"worker-account", "write-permission", "none"} {
		t.Run(missing, func(t *testing.T) {
			q, c := kubeQueueFixture(queueReadyNode(), &core.Secret{ObjectMeta: meta.ObjectMeta{Name: "credentials", Namespace: "lcars-work"}, Data: map[string][]byte{"telemetry-writer.json": []byte("writer"), "claude-code-oauth-token": []byte("claude"), "opencode-llm-api-key": []byte("opencode")}})
			if missing != "worker-account" {
				_, err := c.CoreV1().ServiceAccounts("lcars-work").Create(context.Background(), &core.ServiceAccount{ObjectMeta: meta.ObjectMeta{Name: "worker"}}, meta.CreateOptions{})
				if err != nil {
					t.Fatal(err)
				}
			}
			c.PrependReactor("create", "selfsubjectaccessreviews", func(clienttesting.Action) (bool, runtime.Object, error) {
				return true, &auth.SelfSubjectAccessReview{Status: auth.SubjectAccessReviewStatus{Allowed: missing != "write-permission"}}, nil
			})
			if err := q.preflight(context.Background()); (err != nil) != (missing != "none") {
				t.Fatalf("preflight=%v for %s", err, missing)
			}
		})
	}
}

func TestKubernetesRetentionBoundsExitedEvidenceWithoutTouchingActiveJob(t *testing.T) {
	q, c := kubeQueueFixture()
	ctx := context.Background()
	q.config.MaxConcurrent = 1
	for i := range queueJobRetentionPerSlot + 2 {
		j := &batch.Job{ObjectMeta: meta.ObjectMeta{Name: fmt.Sprintf("finished-%02d", i), Namespace: q.config.Namespace, Labels: map[string]string{queueJobLabel: "true"}}, Status: batch.JobStatus{Conditions: []batch.JobCondition{{Type: batch.JobFailed, Status: core.ConditionTrue, LastTransitionTime: meta.NewTime(time.Now().Add(-time.Duration(i) * time.Minute))}}}}
		if err := c.Tracker().Create(batch.SchemeGroupVersion.WithResource("jobs"), j, q.config.Namespace); err != nil {
			t.Fatal(err)
		}
	}
	j := &batch.Job{ObjectMeta: meta.ObjectMeta{Name: "running", Namespace: q.config.Namespace, Labels: map[string]string{queueJobLabel: "true"}}}
	if err := c.Tracker().Create(batch.SchemeGroupVersion.WithResource("jobs"), j, q.config.Namespace); err != nil {
		t.Fatal(err)
	}
	if err := q.cleanup(ctx); err != nil {
		t.Fatal(err)
	}
	jobs, _ := c.BatchV1().Jobs(q.config.Namespace).List(ctx, meta.ListOptions{})
	if len(jobs.Items) != queueJobRetentionPerSlot+1 {
		t.Fatal("exited retention did not enforce capacity bound")
	}
	if _, err := c.BatchV1().Jobs(q.config.Namespace).Get(ctx, "running", meta.GetOptions{}); err != nil {
		t.Fatal("retention removed running Job")
	}
}

func TestKubernetesConfigurationRejectsAPIIlegalTolerationsBeforeClaim(t *testing.T) {
	for _, tc := range []struct {
		name      string
		tolerance queueToleration
		valid     bool
	}{
		{"exists with value", queueToleration{Key: "inference", Operator: core.TolerationOpExists, Value: "busy", Effect: core.TaintEffectNoSchedule}, false},
		{"invalid key", queueToleration{Key: "invalid/key/again", Operator: core.TolerationOpExists, Effect: core.TaintEffectNoSchedule}, false},
		{"invalid equal value", queueToleration{Key: "inference", Operator: core.TolerationOpEqual, Value: "contains spaces", Effect: core.TaintEffectNoSchedule}, false},
		{"exists", queueToleration{Key: "inference", Operator: core.TolerationOpExists, Effect: core.TaintEffectNoSchedule}, true},
		{"equal", queueToleration{Key: "inference", Operator: core.TolerationOpEqual, Value: "idle", Effect: core.TaintEffectNoSchedule}, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			q, _ := kubeQueueFixture()
			q.config.Tolerations = []queueToleration{tc.tolerance}
			if err := q.config.validate(); (err == nil) != tc.valid {
				t.Fatalf("validation=%v valid=%v", err, tc.valid)
			}
		})
	}
}

// Observe the emitted worker Job, including the off value that overrides image
// defaults. A provider can be activated without activating the other two.
func TestKubernetesWorkerPolicySelection(t *testing.T) {
	for _, selection := range []struct {
		raw, want string
		invalid   bool
	}{
		{"", "", false}, {" ", "", false},
		{"claude", "claude", false}, {"codex", "codex", false}, {"opencode", "opencode", false},
		{" opencode,claude,claude ", "claude,opencode", false},
		{"all", "", true}, {"codex,", "", true}, {"codex,,claude", "", true},
	} {
		t.Run(selection.raw, func(t *testing.T) {
			t.Setenv("LCARS_WORKER_POLICY_PROVIDERS", selection.raw)
			selected, err := directRunnerWorkerPolicyProviders()
			if (err != nil) != selection.invalid || selected != selection.want {
				t.Fatalf("selected=%q err=%v", selected, err)
			}
			if selection.invalid {
				return
			}
			q, c := kubeQueueFixture()
			q.workerPolicyProviders = selected
			for _, provider := range []string{"claude", "codex", "opencode"} {
				launch := directRunnerLaunch{runID: "work:policy-" + provider + "/r1", pipeline: provider, runToken: "fixture-token"}
				if err := q.launch(context.Background(), launch); err != nil {
					t.Fatal(err)
				}
				job, err := c.BatchV1().Jobs(q.config.Namespace).Get(context.Background(), queueJobName(launch.runID), meta.GetOptions{})
				if err != nil {
					t.Fatal(err)
				}
				found := 0
				for _, env := range job.Spec.Template.Spec.Containers[0].Env {
					if env.Name == "LCARS_WORKER_POLICY_PROVIDERS" {
						found++
						if env.Value != selection.want || env.ValueFrom != nil {
							t.Fatal("worker policy selection changed at launch")
						}
					}
				}
				if found != 1 {
					t.Fatal("worker policy selector must explicitly override image defaults")
				}
			}
		})
	}
}

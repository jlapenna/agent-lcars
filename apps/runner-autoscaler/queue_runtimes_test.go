package main

import (
	"context"
	"reflect"
	"sort"
	"strings"
	"testing"

	"github.com/prometheus/client_golang/prometheus/testutil"
	auth "k8s.io/api/authorization/v1"
	core "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	meta "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/kubernetes/fake"
	clienttesting "k8s.io/client-go/testing"
)

const testClawImage = "registry.example.com/openclaw@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

func testClawRuntime() queueRuntimeConfig {
	shape := map[string]string{"cpu": "2", "memory": "3Gi", "ephemeral-storage": "8Gi"}
	return queueRuntimeConfig{
		Image: testClawImage, Requests: shape, Limits: map[string]string{"cpu": "2", "memory": "3Gi", "ephemeral-storage": "8Gi"},
		ActiveDeadlineSeconds: 3300,
		SecretName:            "claw-investigator",
		Items: []queueRuntimeSecretItem{
			{Key: "investigator-ssh-key", Path: "ssh/id_ed25519"},
			{Key: "known-hosts", Path: "ssh/known_hosts"},
			{Key: "litellm-api-key", Path: "env/LITELLM_API_KEY"},
		},
		Agent: &queueRuntimeAgentConfig{ConfigMap: "claw-investigator-agent", Items: []queueRuntimeSecretItem{
			{Key: "config.json", Path: "config.json"},
			{Key: "approvals.json", Path: "approvals.json"},
			{Key: "workspace-AGENTS.md", Path: "workspace/AGENTS.md"},
		}},
		Env: []queueRuntimeEnv{{Name: "CLAW_AGENT", Value: "investigator"}},
	}
}

// zoneQueueFixture is a runtimes-only zone executor: no legacy credential
// Secret, resources or runner image.
func zoneQueueFixture(objects ...runtime.Object) (*kubernetesQueue, *fake.Clientset) {
	q, c := kubeQueueFixture(objects...)
	q.image = ""
	q.config.CredentialsSecret = ""
	q.config.Requests, q.config.Limits = nil, nil
	q.config.RuntimesOnly = true
	q.config.Runtimes = map[string]queueRuntimeConfig{"claw-investigator": testClawRuntime()}
	return q, c
}

func TestQueueRuntimeValidation(t *testing.T) {
	for name, mutate := range map[string]func(*queueKubernetesConfig){
		"tag instead of digest": func(c *queueKubernetesConfig) {
			r := c.Runtimes["claw-investigator"]
			r.Image = "registry.example.com/openclaw:2026.11.3"
			c.Runtimes["claw-investigator"] = r
		},
		"requests below limits": func(c *queueKubernetesConfig) {
			r := c.Runtimes["claw-investigator"]
			r.Requests = map[string]string{"cpu": "1", "memory": "3Gi", "ephemeral-storage": "8Gi"}
			c.Runtimes["claw-investigator"] = r
		},
		"missing ephemeral-storage": func(c *queueKubernetesConfig) {
			r := c.Runtimes["claw-investigator"]
			r.Requests = map[string]string{"cpu": "2", "memory": "3Gi"}
			r.Limits = map[string]string{"cpu": "2", "memory": "3Gi"}
			c.Runtimes["claw-investigator"] = r
		},
		"cpu above ceiling": func(c *queueKubernetesConfig) {
			r := c.Runtimes["claw-investigator"]
			r.Requests = map[string]string{"cpu": "3", "memory": "3Gi", "ephemeral-storage": "8Gi"}
			r.Limits = r.Requests
			c.Runtimes["claw-investigator"] = r
		},
		"memory above ceiling": func(c *queueKubernetesConfig) {
			r := c.Runtimes["claw-investigator"]
			r.Requests = map[string]string{"cpu": "2", "memory": "7Gi", "ephemeral-storage": "8Gi"}
			r.Limits = r.Requests
			c.Runtimes["claw-investigator"] = r
		},
		"storage above ceiling": func(c *queueKubernetesConfig) {
			r := c.Runtimes["claw-investigator"]
			r.Requests = map[string]string{"cpu": "2", "memory": "3Gi", "ephemeral-storage": "41Gi"}
			r.Limits = r.Requests
			c.Runtimes["claw-investigator"] = r
		},
		"unsupported resource": func(c *queueKubernetesConfig) {
			r := c.Runtimes["claw-investigator"]
			r.Requests = map[string]string{"cpu": "2", "memory": "3Gi", "ephemeral-storage": "8Gi", "nvidia.com/gpu": "1"}
			c.Runtimes["claw-investigator"] = r
		},
		"deadline equals lease": func(c *queueKubernetesConfig) {
			r := c.Runtimes["claw-investigator"]
			r.ActiveDeadlineSeconds = queueRunLeaseSeconds
			c.Runtimes["claw-investigator"] = r
		},
		"deadline leaves no turn": func(c *queueKubernetesConfig) {
			r := c.Runtimes["claw-investigator"]
			r.ActiveDeadlineSeconds = 359
			c.Runtimes["claw-investigator"] = r
		},
		"name outside claw": func(c *queueKubernetesConfig) {
			c.Runtimes["claude"] = c.Runtimes["claw-investigator"]
		},
		"uppercase name": func(c *queueKubernetesConfig) {
			c.Runtimes["claw-Investigator"] = c.Runtimes["claw-investigator"]
		},
		"item path escapes": func(c *queueKubernetesConfig) {
			r := c.Runtimes["claw-investigator"]
			r.Items = []queueRuntimeSecretItem{{Key: "litellm-api-key", Path: "../litellm"}}
			c.Runtimes["claw-investigator"] = r
		},
		"absolute item path": func(c *queueKubernetesConfig) {
			r := c.Runtimes["claw-investigator"]
			r.Items = []queueRuntimeSecretItem{{Key: "litellm-api-key", Path: "/etc/litellm"}}
			c.Runtimes["claw-investigator"] = r
		},
		"invalid item key": func(c *queueKubernetesConfig) {
			r := c.Runtimes["claw-investigator"]
			r.Items = []queueRuntimeSecretItem{{Key: "a/b", Path: "litellm"}}
			c.Runtimes["claw-investigator"] = r
		},
		"repeated item path": func(c *queueKubernetesConfig) {
			r := c.Runtimes["claw-investigator"]
			r.Items = []queueRuntimeSecretItem{{Key: "a", Path: "x"}, {Key: "b", Path: "x"}}
			c.Runtimes["claw-investigator"] = r
		},
		"no items": func(c *queueKubernetesConfig) {
			r := c.Runtimes["claw-investigator"]
			r.Items = nil
			c.Runtimes["claw-investigator"] = r
		},
		"agent item escapes": func(c *queueKubernetesConfig) {
			r := c.Runtimes["claw-investigator"]
			r.Agent = &queueRuntimeAgentConfig{ConfigMap: "agent", Items: []queueRuntimeSecretItem{{Key: "config.json", Path: "../config.json"}}}
			c.Runtimes["claw-investigator"] = r
		},
		"agent without ConfigMap": func(c *queueKubernetesConfig) {
			r := c.Runtimes["claw-investigator"]
			r.Agent = &queueRuntimeAgentConfig{}
			c.Runtimes["claw-investigator"] = r
		},
		"legacy credential Secret": func(c *queueKubernetesConfig) {
			c.RuntimesOnly = false
			c.CredentialsSecret = "claw-investigator"
			c.Requests = map[string]string{"cpu": "1", "memory": "1Gi", "ephemeral-storage": "1Gi"}
			c.Limits = c.Requests
		},
		"env LCARS_ prefix": func(c *queueKubernetesConfig) {
			r := c.Runtimes["claw-investigator"]
			r.Env = []queueRuntimeEnv{{Name: "LCARS_RUN_TOKEN", Value: "x"}}
			c.Runtimes["claw-investigator"] = r
		},
		"env RUNNER_MODE": func(c *queueKubernetesConfig) {
			r := c.Runtimes["claw-investigator"]
			r.Env = []queueRuntimeEnv{{Name: "RUNNER_MODE", Value: "direct"}}
			c.Runtimes["claw-investigator"] = r
		},
		"env turn deadline": func(c *queueKubernetesConfig) {
			r := c.Runtimes["claw-investigator"]
			r.Env = []queueRuntimeEnv{{Name: "CLAW_TURN_DEADLINE_SECONDS", Value: "9999"}}
			c.Runtimes["claw-investigator"] = r
		},
		"runtimes_only with legacy credentials": func(c *queueKubernetesConfig) {
			c.CredentialsSecret = "credentials"
		},
		"runtimes_only with legacy shape": func(c *queueKubernetesConfig) {
			c.Requests = map[string]string{"cpu": "1"}
		},
		"runtimes_only without runtimes": func(c *queueKubernetesConfig) {
			c.Runtimes = nil
		},
	} {
		t.Run(name, func(t *testing.T) {
			q, _ := zoneQueueFixture()
			if err := q.config.validate(); err != nil {
				t.Fatalf("baseline zone config rejected: %v", err)
			}
			mutate(&q.config)
			if err := q.config.validate(); err == nil {
				t.Fatal("invalid runtime configuration accepted")
			}
		})
	}
}

func TestQueueRuntimeAcceptsExactCeiling(t *testing.T) {
	q, _ := zoneQueueFixture()
	r := q.config.Runtimes["claw-investigator"]
	r.Requests = map[string]string{"cpu": "2", "memory": "6Gi", "ephemeral-storage": "40Gi"}
	r.Limits = map[string]string{"cpu": "2000m", "memory": "6Gi", "ephemeral-storage": "40Gi"}
	r.ActiveDeadlineSeconds = queueRunLeaseSeconds - 1
	r.Agent = nil
	q.config.Runtimes["claw-investigator"] = r
	if err := q.config.validate(); err != nil {
		t.Fatalf("runtime at the ceiling rejected: %v", err)
	}
}

func clawLaunch() directRunnerLaunch {
	return directRunnerLaunch{runID: "work:claw/r1", runToken: "secret-run-token", pipeline: "claw-investigator", consoleURL: "https://console.example.com", runner: "zone-0"}
}

// A claw Job carries exactly its declared zone material: no telemetry
// writer, provider key, Hindsight token or Codex volume.
func TestClawJobMountsOnlyDeclaredZoneMaterial(t *testing.T) {
	q, _ := zoneQueueFixture()
	job, err := q.job(clawLaunch())
	if err != nil {
		t.Fatal(err)
	}
	pod := job.Spec.Template.Spec
	container := pod.Containers[0]
	if container.Image != testClawImage || container.ImagePullPolicy != core.PullIfNotPresent {
		t.Fatalf("image=%s pull=%s, want pinned digest with IfNotPresent", container.Image, container.ImagePullPolicy)
	}
	if len(container.Command) != 0 || len(container.Args) != 0 {
		t.Fatal("the image entrypoint must not be overridden")
	}
	if pod.ActiveDeadlineSeconds == nil || *pod.ActiveDeadlineSeconds != 3300 {
		t.Fatalf("pod deadline = %v, want 3300", pod.ActiveDeadlineSeconds)
	}
	for name, want := range map[core.ResourceName]string{core.ResourceCPU: "2", core.ResourceMemory: "3Gi", core.ResourceEphemeralStorage: "8Gi"} {
		request, limit := container.Resources.Requests[name], container.Resources.Limits[name]
		if request.Cmp(resource.MustParse(want)) != 0 || limit.Cmp(request) != 0 {
			t.Fatalf("%s request=%s limit=%s, want %s", name, request.String(), limit.String(), want)
		}
	}
	sc := container.SecurityContext
	if sc == nil || sc.ReadOnlyRootFilesystem == nil || !*sc.ReadOnlyRootFilesystem || sc.AllowPrivilegeEscalation == nil || *sc.AllowPrivilegeEscalation {
		t.Fatal("claw container must keep the hardened, read-only root security context")
	}
	if pod.SecurityContext == nil || pod.SecurityContext.RunAsNonRoot == nil || !*pod.SecurityContext.RunAsNonRoot || *pod.AutomountServiceAccountToken {
		t.Fatal("pod security context changed")
	}
	if !reflect.DeepEqual(pod.NodeSelector, q.config.NodeSelector) {
		t.Fatal("node placement must come from the executor configuration")
	}

	env := map[string]core.EnvVar{}
	var names []string
	for _, e := range container.Env {
		env[e.Name] = e
		names = append(names, e.Name)
	}
	sort.Strings(names)
	if want := []string{"CLAW_AGENT", "CLAW_TURN_DEADLINE_SECONDS", "LCARS_CONSOLE_URL", "LCARS_RUN_ID", "LCARS_RUN_TOKEN", "RUNNER_MODE"}; !reflect.DeepEqual(names, want) {
		t.Fatalf("env = %v, want exactly %v", names, want)
	}
	if env["RUNNER_MODE"].Value != "claw" || env["LCARS_RUN_ID"].Value != "work:claw/r1" || env["LCARS_CONSOLE_URL"].Value != "https://console.example.com" || env["CLAW_AGENT"].Value != "investigator" {
		t.Fatalf("env values wrong: %+v", env)
	}
	if got := env["CLAW_TURN_DEADLINE_SECONDS"].Value; got != "3000" {
		t.Fatalf("turn deadline = %s, want pod deadline minus 300", got)
	}
	token := env["LCARS_RUN_TOKEN"]
	if token.Value != "" || token.ValueFrom == nil || token.ValueFrom.SecretKeyRef == nil || token.ValueFrom.SecretKeyRef.Name != job.Name || token.ValueFrom.SecretKeyRef.Key != "run-token" {
		t.Fatal("run token must come from the per-Job run-token Secret")
	}

	volumes := map[string]core.Volume{}
	for _, v := range pod.Volumes {
		volumes[v.Name] = v
		if v.HostPath != nil {
			t.Fatal("host path volume")
		}
	}
	if len(volumes) != 4 {
		t.Fatalf("volumes = %v, want claw-secrets, claw-agent, work, tmp only", pod.Volumes)
	}
	secret := volumes["claw-secrets"].Secret
	if secret == nil || secret.SecretName != "claw-investigator" || (secret.Optional != nil && *secret.Optional) {
		t.Fatal("zone Secret volume missing or optional")
	}
	if want := []core.KeyToPath{{Key: "investigator-ssh-key", Path: "ssh/id_ed25519"}, {Key: "known-hosts", Path: "ssh/known_hosts"}, {Key: "litellm-api-key", Path: "env/LITELLM_API_KEY"}}; !reflect.DeepEqual(secret.Items, want) {
		t.Fatalf("secret items = %v, want exactly %v", secret.Items, want)
	}
	agent := volumes["claw-agent"].ConfigMap
	if agent == nil || agent.Name != "claw-investigator-agent" || len(agent.Items) != 3 || agent.Items[2].Path != "workspace/AGENTS.md" {
		t.Fatalf("agent ConfigMap volume = %+v", agent)
	}
	work := volumes["work"].EmptyDir
	if work == nil || work.SizeLimit == nil || work.SizeLimit.Cmp(resource.MustParse("8Gi")) != 0 {
		t.Fatal("work emptyDir must be bounded by the ephemeral-storage limit")
	}
	if volumes["tmp"].EmptyDir == nil {
		t.Fatal("/tmp must be a writable emptyDir")
	}
	mounts := map[string]core.VolumeMount{}
	for _, m := range container.VolumeMounts {
		mounts[m.MountPath] = m
	}
	if len(mounts) != 4 || !mounts["/run/claw-secrets"].ReadOnly || !mounts["/claw/agent"].ReadOnly || mounts["/work"].Name != "work" || mounts["/tmp"].Name != "tmp" {
		t.Fatalf("mounts = %v", container.VolumeMounts)
	}
	text := job.String()
	for _, forbidden := range []string{"telemetry-writer", "claude-code-oauth-token", "opencode-llm-api-key", "antigravity-oauth-token", "hindsight", "HINDSIGHT", "codex", "LCARS_WORKER_POLICY_PROVIDERS", "goose", "secret-run-token"} {
		if strings.Contains(text, forbidden) {
			t.Fatalf("claw Job carries forbidden material %q", forbidden)
		}
	}
}

func TestClawJobRejectsProviderAuthAndOmitsOptionalAgent(t *testing.T) {
	q, _ := zoneQueueFixture()
	l := clawLaunch()
	l.providerAuth = "claude"
	if _, err := q.job(l); err == nil {
		t.Fatal("a runtime must not accept provider auth")
	}
	r := q.config.Runtimes["claw-investigator"]
	r.Agent = nil
	q.config.Runtimes["claw-investigator"] = r
	job, err := q.job(clawLaunch())
	if err != nil {
		t.Fatal(err)
	}
	for _, v := range job.Spec.Template.Spec.Volumes {
		if v.ConfigMap != nil {
			t.Fatal("agent ConfigMap mounted without being declared")
		}
	}
}

// Declaring runtimes on the shared executor leaves every legacy pipeline's
// Job exactly as before.
func TestLegacyJobsUnchangedByDeclaredRuntimes(t *testing.T) {
	for _, pipeline := range []string{"claude", "codex", "opencode", "agy"} {
		t.Run(pipeline, func(t *testing.T) {
			plain, _ := kubeQueueFixture()
			declared, _ := kubeQueueFixture()
			declared.config.Runtimes = map[string]queueRuntimeConfig{"claw-investigator": testClawRuntime()}
			l := directRunnerLaunch{runID: "work:legacy/r1", runToken: "t", pipeline: pipeline, consoleURL: "https://console.example.com", runner: "r"}
			want, err := plain.job(l)
			if err != nil {
				t.Fatal(err)
			}
			got, err := declared.job(l)
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(want, got) {
				t.Fatal("declaring a runtime changed a legacy Job")
			}
			c := got.Spec.Template.Spec.Containers[0]
			if c.ImagePullPolicy != core.PullAlways || *got.Spec.Template.Spec.ActiveDeadlineSeconds != queueRunLeaseSeconds || c.SecurityContext.ReadOnlyRootFilesystem != nil {
				t.Fatal("legacy Job shape changed")
			}
		})
	}
}

func TestRuntimesOnlyExecutorRefusesLegacyPipelines(t *testing.T) {
	q, c := zoneQueueFixture()
	for _, pipeline := range []string{"claude", "codex", "goose", "claw-oncall"} {
		if err := q.launch(context.Background(), directRunnerLaunch{runID: "work:x/" + pipeline, pipeline: pipeline}); err == nil {
			t.Fatalf("runtimes-only executor launched %s", pipeline)
		}
	}
	if len(c.Actions()) != 0 {
		t.Fatal("refused launch mutated the cluster")
	}
}

func TestClawLaunchCountsPipelineAndIsolatedMemory(t *testing.T) {
	q, c := zoneQueueFixture()
	counter := queueExecutorMemoryLaunchesTotal.WithLabelValues("claw-investigator", "isolated")
	before := testutil.ToFloat64(counter)
	if err := q.launch(context.Background(), clawLaunch()); err != nil {
		t.Fatal(err)
	}
	if got := testutil.ToFloat64(counter) - before; got != 1 {
		t.Fatalf("claw memory launches = %v, want 1", got)
	}
	for _, action := range c.Actions() {
		if get, ok := action.(clienttesting.GetAction); ok && action.GetResource().Resource == "secrets" && get.GetName() != queueJobName("work:claw/r1") {
			t.Fatalf("claw launch read Secret %s", get.GetName())
		}
	}
	jobs, _ := c.BatchV1().Jobs(q.config.Namespace).List(context.Background(), meta.ListOptions{})
	if len(jobs.Items) != 1 || *jobs.Items[0].Spec.Suspend {
		t.Fatal("claw Job not launched and resumed")
	}
}

func zoneSecret(data map[string][]byte) *core.Secret {
	return &core.Secret{ObjectMeta: meta.ObjectMeta{Name: "claw-investigator", Namespace: "lcars-work"}, Data: data}
}

func zoneAgentConfigMap() *core.ConfigMap {
	return &core.ConfigMap{ObjectMeta: meta.ObjectMeta{Name: "claw-investigator-agent", Namespace: "lcars-work"}, Data: map[string]string{"config.json": "{}", "approvals.json": "{}", "workspace-AGENTS.md": "# agent"}}
}

// A zone executor starts without the legacy credential Secret or provider
// keys, but requires every declared zone item and agent key.
func TestZoneExecutorPreflight(t *testing.T) {
	complete := map[string][]byte{"investigator-ssh-key": []byte("k"), "known-hosts": []byte("h"), "litellm-api-key": []byte("l")}
	for name, tc := range map[string]struct {
		objects []runtime.Object
		ok      bool
	}{
		"complete":              {objects: []runtime.Object{zoneSecret(complete), zoneAgentConfigMap()}, ok: true},
		"missing zone Secret":   {objects: []runtime.Object{zoneAgentConfigMap()}},
		"empty item":            {objects: []runtime.Object{zoneSecret(map[string][]byte{"investigator-ssh-key": []byte("k"), "known-hosts": []byte("h"), "litellm-api-key": {}}), zoneAgentConfigMap()}},
		"missing agent map":     {objects: []runtime.Object{zoneSecret(complete)}},
		"agent map missing key": {objects: []runtime.Object{zoneSecret(complete), &core.ConfigMap{ObjectMeta: meta.ObjectMeta{Name: "claw-investigator-agent", Namespace: "lcars-work"}, Data: map[string]string{"config.json": "{}"}}}},
	} {
		t.Run(name, func(t *testing.T) {
			objects := append([]runtime.Object{queueReadyNode(), &core.ServiceAccount{ObjectMeta: meta.ObjectMeta{Name: "worker", Namespace: "lcars-work"}}}, tc.objects...)
			q, c := zoneQueueFixture(objects...)
			c.PrependReactor("create", "selfsubjectaccessreviews", func(clienttesting.Action) (bool, runtime.Object, error) {
				return true, &auth.SelfSubjectAccessReview{Status: auth.SubjectAccessReviewStatus{Allowed: true}}, nil
			})
			err := q.preflight(context.Background())
			if (err == nil) != tc.ok {
				t.Fatalf("preflight = %v, want ok=%v", err, tc.ok)
			}
			if err != nil && strings.Contains(err.Error(), "secret-value") {
				t.Fatal("preflight exposed a credential value")
			}
		})
	}
}

// The shared executor with a declared runtime still requires its legacy keys.
func TestSharedExecutorPreflightStillRequiresLegacyKeys(t *testing.T) {
	q, c := kubeQueueFixture(queueReadyNode(), &core.ServiceAccount{ObjectMeta: meta.ObjectMeta{Name: "worker", Namespace: "lcars-work"}}, zoneSecret(map[string][]byte{"investigator-ssh-key": []byte("k"), "known-hosts": []byte("h"), "litellm-api-key": []byte("l")}), zoneAgentConfigMap())
	q.config.Runtimes = map[string]queueRuntimeConfig{"claw-investigator": testClawRuntime()}
	c.PrependReactor("create", "selfsubjectaccessreviews", func(clienttesting.Action) (bool, runtime.Object, error) {
		return true, &auth.SelfSubjectAccessReview{Status: auth.SubjectAccessReviewStatus{Allowed: true}}, nil
	})
	if err := q.preflight(context.Background()); err == nil || !strings.Contains(err.Error(), "queue credential Secret") {
		t.Fatalf("preflight = %v, want the legacy credential Secret requirement", err)
	}
}

func TestAdmissionShapeIsLargestServedShape(t *testing.T) {
	q, _ := kubeQueueFixture()
	q.config.Requests = map[string]string{"cpu": "500m", "memory": "4Gi", "ephemeral-storage": "4Gi"}
	q.config.Runtimes = map[string]queueRuntimeConfig{"claw-investigator": testClawRuntime()}
	shape := q.config.admissionShape()
	for name, want := range map[core.ResourceName]string{core.ResourceCPU: "2", core.ResourceMemory: "4Gi", core.ResourceEphemeralStorage: "8Gi"} {
		got := shape[name]
		if got.Cmp(resource.MustParse(want)) != 0 {
			t.Fatalf("%s = %s, want %s", name, got.String(), want)
		}
	}
	zone, _ := zoneQueueFixture()
	zone.config.Requests = map[string]string{"cpu": "4"} // ignored when runtimes_only
	if got := zone.config.admissionShape()[core.ResourceCPU]; got.Cmp(resource.MustParse("2")) != 0 {
		t.Fatalf("runtimes-only shape cpu = %s, want the runtime's 2", got.String())
	}
}

func TestZoneReserveUsesRuntimeShape(t *testing.T) {
	small := queueReadyNode()
	small.Status.Allocatable[core.ResourceEphemeralStorage] = resource.MustParse("6Gi")
	q, _ := zoneQueueFixture(small)
	if r, err := q.reserve(context.Background()); err != nil || r != nil {
		t.Fatalf("reservation=%v err=%v; a node smaller than the runtime shape must not admit", r, err)
	}
	q, _ = zoneQueueFixture(queueReadyNode())
	r, err := q.reserve(context.Background())
	if err != nil || r == nil {
		t.Fatalf("reservation=%v err=%v; a fitting node must admit", r, err)
	}
	r.release()
}

func TestRuntimesOnlyEnvironmentNeedsNoRunnerImage(t *testing.T) {
	t.Setenv("LCARS_CONSOLE_URL", "https://console.example")
	t.Setenv("GOOGLE_APPLICATION_CREDENTIALS", "/secrets/google.json")
	t.Setenv("LCARS_SCHEDULER_CREDENTIALS", "/secrets/scheduler.json")
	t.Setenv("LCARS_QUEUE_RUNNER_IMAGE", "")
	t.Setenv("LCARS_WORKER_POLICY_PROVIDERS", "")
	q, _ := zoneQueueFixture()
	config := q.config
	config.Kubeconfig = writeTestKubeconfig(t)
	if err := validateQueueExecutorEnvironment(OrchestratorConfig{Version: 1, Kubernetes: &config}); err != nil {
		t.Fatalf("zone executor environment rejected: %v", err)
	}
	config.RuntimesOnly = false
	config.CredentialsSecret = "credentials"
	config.Requests = map[string]string{"cpu": "1", "memory": "1Gi", "ephemeral-storage": "1Gi"}
	config.Limits = config.Requests
	if err := validateQueueExecutorEnvironment(OrchestratorConfig{Version: 1, Kubernetes: &config}); err == nil {
		t.Fatal("a shared executor without LCARS_QUEUE_RUNNER_IMAGE must be rejected")
	}
}

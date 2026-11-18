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
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/resource"
	meta "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/util/validation/field"
	"k8s.io/apimachinery/pkg/version"
	fakediscovery "k8s.io/client-go/discovery/fake"
	"k8s.io/client-go/kubernetes/fake"
	clienttesting "k8s.io/client-go/testing"
	podresource "k8s.io/component-helpers/resource"
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
		"env item LCARS_RUN_TOKEN": func(c *queueKubernetesConfig) {
			r := c.Runtimes["claw-investigator"]
			r.Items = []queueRuntimeSecretItem{{Key: "litellm-api-key", Path: "env/LCARS_RUN_TOKEN"}}
			c.Runtimes["claw-investigator"] = r
		},
		"env item LCARS_CONSOLE_URL": func(c *queueKubernetesConfig) {
			r := c.Runtimes["claw-investigator"]
			r.Items = []queueRuntimeSecretItem{{Key: "litellm-api-key", Path: "env/LCARS_CONSOLE_URL"}}
			c.Runtimes["claw-investigator"] = r
		},
		"env item RUNNER_MODE": func(c *queueKubernetesConfig) {
			r := c.Runtimes["claw-investigator"]
			r.Items = []queueRuntimeSecretItem{{Key: "litellm-api-key", Path: "env/RUNNER_MODE"}}
			c.Runtimes["claw-investigator"] = r
		},
		"env item CLAW_TURN_DEADLINE_SECONDS": func(c *queueKubernetesConfig) {
			r := c.Runtimes["claw-investigator"]
			r.Items = []queueRuntimeSecretItem{{Key: "litellm-api-key", Path: "env/CLAW_TURN_DEADLINE_SECONDS"}}
			c.Runtimes["claw-investigator"] = r
		},
		"env item OPENCLAW_STATE_DIR": func(c *queueKubernetesConfig) {
			r := c.Runtimes["claw-investigator"]
			r.Items = []queueRuntimeSecretItem{{Key: "litellm-api-key", Path: "env/OPENCLAW_STATE_DIR"}}
			c.Runtimes["claw-investigator"] = r
		},
		"env item NODE_OPTIONS": func(c *queueKubernetesConfig) {
			r := c.Runtimes["claw-investigator"]
			r.Items = []queueRuntimeSecretItem{{Key: "litellm-api-key", Path: "env/NODE_OPTIONS"}}
			c.Runtimes["claw-investigator"] = r
		},
		"env item PATH": func(c *queueKubernetesConfig) {
			r := c.Runtimes["claw-investigator"]
			r.Items = []queueRuntimeSecretItem{{Key: "litellm-api-key", Path: "env/PATH"}}
			c.Runtimes["claw-investigator"] = r
		},
		"env item HOME": func(c *queueKubernetesConfig) {
			r := c.Runtimes["claw-investigator"]
			r.Items = []queueRuntimeSecretItem{{Key: "litellm-api-key", Path: "env/HOME"}}
			c.Runtimes["claw-investigator"] = r
		},
		"env item nested": func(c *queueKubernetesConfig) {
			r := c.Runtimes["claw-investigator"]
			r.Items = []queueRuntimeSecretItem{{Key: "litellm-api-key", Path: "env/LITELLM/API_KEY"}}
			c.Runtimes["claw-investigator"] = r
		},
		"env item invalid name": func(c *queueKubernetesConfig) {
			r := c.Runtimes["claw-investigator"]
			r.Items = []queueRuntimeSecretItem{{Key: "litellm-api-key", Path: "env/1-BAD"}}
			c.Runtimes["claw-investigator"] = r
		},
		"env item repeats declared env": func(c *queueKubernetesConfig) {
			r := c.Runtimes["claw-investigator"]
			r.Items = []queueRuntimeSecretItem{{Key: "litellm-api-key", Path: "env/CLAW_AGENT"}}
			c.Runtimes["claw-investigator"] = r
		},
		"item path ..data": func(c *queueKubernetesConfig) {
			r := c.Runtimes["claw-investigator"]
			r.Items = []queueRuntimeSecretItem{{Key: "litellm-api-key", Path: "..data"}}
			c.Runtimes["claw-investigator"] = r
		},
		"item path ..foo/bar": func(c *queueKubernetesConfig) {
			r := c.Runtimes["claw-investigator"]
			r.Items = []queueRuntimeSecretItem{{Key: "litellm-api-key", Path: "..foo/bar"}}
			c.Runtimes["claw-investigator"] = r
		},
		"item nested ..segment": func(c *queueKubernetesConfig) {
			r := c.Runtimes["claw-investigator"]
			r.Items = []queueRuntimeSecretItem{{Key: "litellm-api-key", Path: "ssh/..key"}}
			c.Runtimes["claw-investigator"] = r
		},
		"item path parent of another": func(c *queueKubernetesConfig) {
			r := c.Runtimes["claw-investigator"]
			r.Items = []queueRuntimeSecretItem{{Key: "a", Path: "ssh"}, {Key: "b", Path: "ssh/id_ed25519"}}
			c.Runtimes["claw-investigator"] = r
		},
		"declared env HOME": func(c *queueKubernetesConfig) {
			r := c.Runtimes["claw-investigator"]
			r.Env = []queueRuntimeEnv{{Name: "HOME", Value: "x"}}
			c.Runtimes["claw-investigator"] = r
		},
		"declared env PATH": func(c *queueKubernetesConfig) {
			r := c.Runtimes["claw-investigator"]
			r.Env = []queueRuntimeEnv{{Name: "PATH", Value: "x"}}
			c.Runtimes["claw-investigator"] = r
		},
		"declared env NODE_OPTIONS": func(c *queueKubernetesConfig) {
			r := c.Runtimes["claw-investigator"]
			r.Env = []queueRuntimeEnv{{Name: "NODE_OPTIONS", Value: "x"}}
			c.Runtimes["claw-investigator"] = r
		},
		"declared env OPENCLAW_CONFIG_PATH": func(c *queueKubernetesConfig) {
			r := c.Runtimes["claw-investigator"]
			r.Env = []queueRuntimeEnv{{Name: "OPENCLAW_CONFIG_PATH", Value: "x"}}
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
			err := q.config.validate()
			if err == nil {
				t.Fatal("invalid runtime configuration accepted")
			}
			t.Log(err)
		})
	}
}

func TestQueueRuntimeAcceptsExactCeiling(t *testing.T) {
	q, _ := zoneQueueFixture()
	r := q.config.Runtimes["claw-investigator"]
	r.Requests = map[string]string{"cpu": "2", "memory": "6Gi", "ephemeral-storage": "40Gi"}
	r.Limits = map[string]string{"cpu": "2000m", "memory": "6Gi", "ephemeral-storage": "40Gi"}
	r.ActiveDeadlineSeconds = queueRunLeaseSeconds - 1
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
	if len(volumes) != 3 {
		t.Fatalf("volumes = %v, want claw-secrets, work, tmp only", pod.Volumes)
	}
	secret := volumes["claw-secrets"].Secret
	if secret == nil || secret.SecretName != "claw-investigator" || (secret.Optional != nil && *secret.Optional) {
		t.Fatal("zone Secret volume missing or optional")
	}
	if want := []core.KeyToPath{{Key: "investigator-ssh-key", Path: "ssh/id_ed25519"}, {Key: "known-hosts", Path: "ssh/known_hosts"}, {Key: "litellm-api-key", Path: "env/LITELLM_API_KEY"}}; !reflect.DeepEqual(secret.Items, want) {
		t.Fatalf("secret items = %v, want exactly %v", secret.Items, want)
	}
	// Zone secrets stay 0440 and are never executable.
	if secret.DefaultMode == nil || *secret.DefaultMode != 0o440 {
		t.Fatalf("zone Secret mode = %v, want 0440", secret.DefaultMode)
	}
	for _, item := range secret.Items {
		if item.Mode != nil {
			t.Fatalf("item %s overrides the volume mode", item.Key)
		}
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
	if len(mounts) != 3 || !mounts["/run/claw-secrets"].ReadOnly || mounts["/work"].Name != "work" || mounts["/tmp"].Name != "tmp" {
		t.Fatalf("mounts = %v", container.VolumeMounts)
	}
	text := job.String()
	for _, forbidden := range []string{"telemetry-writer", "claude-code-oauth-token", "opencode-llm-api-key", "antigravity-oauth-token", "hindsight", "HINDSIGHT", "codex", "LCARS_WORKER_POLICY_PROVIDERS", "goose", "secret-run-token"} {
		if strings.Contains(text, forbidden) {
			t.Fatalf("claw Job carries forbidden material %q", forbidden)
		}
	}
}

func TestClawJobRejectsProviderAuthAndMountsNoConfigMap(t *testing.T) {
	q, _ := zoneQueueFixture()
	l := clawLaunch()
	l.providerAuth = "claude"
	if _, err := q.job(l); err == nil {
		t.Fatal("a runtime must not accept provider auth")
	}
	job, err := q.job(clawLaunch())
	if err != nil {
		t.Fatal(err)
	}
	// Agent definitions arrive in the run brief, never as a mount.
	for _, v := range job.Spec.Template.Spec.Volumes {
		if v.ConfigMap != nil {
			t.Fatal("claw Job mounts a ConfigMap")
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
	for _, pipeline := range []string{"claude", "codex", "goose", "claw-undeclared"} {
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

// A zone executor starts without the legacy credential Secret or provider
// keys, but requires every declared zone item.
func TestZoneExecutorPreflight(t *testing.T) {
	complete := map[string][]byte{"investigator-ssh-key": []byte("k"), "known-hosts": []byte("h"), "litellm-api-key": []byte("l")}
	for name, tc := range map[string]struct {
		objects []runtime.Object
		ok      bool
	}{
		"complete":            {objects: []runtime.Object{zoneSecret(complete)}, ok: true},
		"missing zone Secret": {objects: nil},
		"empty item":          {objects: []runtime.Object{zoneSecret(map[string][]byte{"investigator-ssh-key": []byte("k"), "known-hosts": []byte("h"), "litellm-api-key": {}})}},
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
	q, c := kubeQueueFixture(queueReadyNode(), &core.ServiceAccount{ObjectMeta: meta.ObjectMeta{Name: "worker", Namespace: "lcars-work"}}, zoneSecret(map[string][]byte{"investigator-ssh-key": []byte("k"), "known-hosts": []byte("h"), "litellm-api-key": []byte("l")}))
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

// A zone executor needs neither the runner image nor the scheduler key, and
// never owns the schedule ticker: that belongs to the shared executor.
func TestRuntimesOnlyEnvironmentNeedsNoRunnerImageOrScheduler(t *testing.T) {
	t.Setenv("LCARS_CONSOLE_URL", "https://console.example")
	t.Setenv("GOOGLE_APPLICATION_CREDENTIALS", "/secrets/google.json")
	t.Setenv("LCARS_SCHEDULER_CREDENTIALS", "")
	t.Setenv("LCARS_QUEUE_RUNNER_IMAGE", "")
	t.Setenv("LCARS_WORKER_POLICY_PROVIDERS", "")
	q, _ := zoneQueueFixture()
	config := q.config
	config.Kubeconfig = writeTestKubeconfig(t)
	zone := OrchestratorConfig{Version: 1, Kubernetes: &config}
	if err := validateQueueExecutorEnvironment(zone); err != nil {
		t.Fatalf("zone executor environment rejected: %v", err)
	}
	if runsScheduleTicker(zone) {
		t.Fatal("a runtimes_only zone executor must not run the schedule ticker")
	}
	t.Setenv("LCARS_SCHEDULER_CREDENTIALS", "/secrets/scheduler.json")
	if err := validateQueueExecutorEnvironment(zone); err == nil || !strings.Contains(err.Error(), "runs no schedule ticker") {
		t.Fatalf("zone executor holding the scheduler key: err=%v, want refusal", err)
	}
	config.RuntimesOnly = false
	config.CredentialsSecret = "credentials"
	config.Requests = map[string]string{"cpu": "1", "memory": "1Gi", "ephemeral-storage": "1Gi"}
	config.Limits = config.Requests
	shared := OrchestratorConfig{Version: 1, Kubernetes: &config}
	if !runsScheduleTicker(shared) {
		t.Fatal("the shared executor owns the schedule ticker")
	}
	if err := validateQueueExecutorEnvironment(shared); err == nil {
		t.Fatal("a shared executor without LCARS_QUEUE_RUNNER_IMAGE must be rejected")
	}
	t.Setenv("LCARS_QUEUE_RUNNER_IMAGE", "registry.example.com/runner:test")
	t.Setenv("LCARS_SCHEDULER_CREDENTIALS", "")
	if err := validateQueueExecutorEnvironment(shared); err == nil || !strings.Contains(err.Error(), "LCARS_SCHEDULER_CREDENTIALS is required") {
		t.Fatalf("a shared executor without the scheduler key: err=%v, want refusal", err)
	}
}

// Env items are a separate namespace from declared env only by name: a
// distinct, unreserved env/ item and declared env coexist.
func TestQueueRuntimeAcceptsDistinctEnvItems(t *testing.T) {
	q, _ := zoneQueueFixture()
	r := q.config.Runtimes["claw-investigator"]
	r.Items = append(r.Items, queueRuntimeSecretItem{Key: "github-token", Path: "env/GH_TOKEN"})
	q.config.Runtimes["claw-investigator"] = r
	if err := q.config.validate(); err != nil {
		t.Fatalf("distinct env items rejected: %v", err)
	}
}

// A Job spec the apiserver refuses as invalid settles its claim at once
// instead of holding it until the placement deadline; a transient create
// failure does not.
func TestLaunchSettlesClaimWhenJobCreateIsInvalid(t *testing.T) {
	for _, tc := range []struct {
		name    string
		err     error
		settles bool
	}{
		{"invalid", apierrors.NewInvalid(schema.GroupKind{Group: "batch", Kind: "Job"}, "lcars-work-x", field.ErrorList{field.Invalid(field.NewPath("spec"), "..data", "must not start with '..'")}), true},
		{"transient", apierrors.NewServiceUnavailable("apiserver unavailable"), false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			recorder := &exitReportRecorder{}
			q, c := zoneQueueFixture()
			q.exits = testExitReporter(recorder.server(t).URL)
			c.PrependReactor("create", "jobs", func(clienttesting.Action) (bool, runtime.Object, error) { return true, nil, tc.err })
			if err := q.launch(context.Background(), clawLaunch()); err == nil {
				t.Fatal("refused create reported success")
			}
			q.exits.wg.Wait()
			if got := len(recorder.requests()); (got == 1) != tc.settles {
				t.Fatalf("exit reports = %d, want settled=%v", got, tc.settles)
			}
			jobs, _ := c.BatchV1().Jobs(q.config.Namespace).List(context.Background(), meta.ListOptions{})
			if len(jobs.Items) != 0 {
				t.Fatal("refused create left a Job")
			}
		})
	}
}

// A runtime that sets harness_container runs the harness in a container of
// its own: the launcher keeps the run token, the harness holds the zone's
// Secret items under another UID, and the kubelet stops the harness when the
// launcher exits.
func TestQueueRuntimeHarnessContainerShape(t *testing.T) {
	q, _ := zoneQueueFixture()
	rt := testClawRuntime()
	rt.HarnessContainer = true
	q.config.Runtimes["claw-investigator"] = rt
	if err := q.config.validate(); err != nil {
		t.Fatal(err)
	}
	job, err := q.job(clawLaunch())
	if err != nil {
		t.Fatal(err)
	}
	pod := job.Spec.Template.Spec
	if len(pod.Containers) != 1 || pod.Containers[0].Name != "claw" {
		t.Fatalf("the launcher must be the Pod's only regular container: %#v", pod.Containers)
	}
	if len(pod.InitContainers) != 2 || pod.InitContainers[0].Name != "claw-home" || pod.InitContainers[1].Name != "harness" {
		t.Fatalf("init containers = %#v", pod.InitContainers)
	}
	launcher, prepare, harness := pod.Containers[0], pod.InitContainers[0], pod.InitContainers[1]

	envNames := func(c core.Container) []string {
		names := []string{}
		for _, env := range c.Env {
			names = append(names, env.Name)
		}
		sort.Strings(names)
		return names
	}
	mounts := func(c core.Container) map[string]core.VolumeMount {
		out := map[string]core.VolumeMount{}
		for _, mount := range c.VolumeMounts {
			out[mount.MountPath] = mount
		}
		return out
	}

	// The run token and the Console's address stay with the launcher.
	if got, want := envNames(launcher), []string{"CLAW_AGENT", "CLAW_HARNESS_SOCKET", "CLAW_TURN_DEADLINE_SECONDS", "LCARS_CONSOLE_URL", "LCARS_RUN_ID", "LCARS_RUN_TOKEN", "RUNNER_MODE"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("launcher env = %v", got)
	}
	if got, want := envNames(harness), []string{"CLAW_AGENT", "CLAW_HARNESS_SOCKET"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("harness env = %v", got)
	}
	// The zone's Secret items and the scratch are the harness's alone.
	if _, mounted := mounts(launcher)[queueRuntimeSecretMountPath]; mounted {
		t.Fatal("the launcher must not mount the zone Secret")
	}
	if _, mounted := mounts(launcher)[queueRuntimeWorkMountPath]; mounted {
		t.Fatal("the launcher must not mount the harness's scratch")
	}
	if mount := mounts(harness)[queueRuntimeSecretMountPath]; mount.Name != "claw-secrets" || !mount.ReadOnly {
		t.Fatalf("harness secret mount = %#v", mount)
	}
	// The launcher writes the definition; the harness only reads it.
	if mount := mounts(launcher)[queueRuntimeDefinitionMountPath]; mount.Name != "definition" || mount.SubPath != "definition" || mount.ReadOnly {
		t.Fatalf("launcher definition mount = %#v", mount)
	}
	if mount := mounts(harness)[queueRuntimeDefinitionMountPath]; mount.Name != "definition" || mount.SubPath != "definition" || !mount.ReadOnly {
		t.Fatalf("harness definition mount = %#v", mount)
	}
	// Both write HOME, through the directory the launcher's user created.
	for name, c := range map[string]core.Container{"launcher": launcher, "harness": harness} {
		if mount := mounts(c)[queueRuntimeHomeMountPath]; mount.Name != "home" || mount.SubPath != "home" || mount.ReadOnly {
			t.Fatalf("%s home mount = %#v", name, mount)
		}
		if mount := mounts(c)["/run/claw"]; mount.Name != "harness-socket" {
			t.Fatalf("%s socket mount = %#v", name, mount)
		}
	}
	if got, want := prepare.Command, []string{"mkdir", "-m", "1775", "/claw/definition/definition", "/claw/home/home"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("claw-home command = %v", got)
	}

	// The harness is another user; the others are the Pod's.
	if harness.SecurityContext.RunAsUser == nil || *harness.SecurityContext.RunAsUser != queueRuntimeHarnessUID || *pod.SecurityContext.RunAsUser == queueRuntimeHarnessUID {
		t.Fatalf("harness user = %#v, pod user = %v", harness.SecurityContext.RunAsUser, *pod.SecurityContext.RunAsUser)
	}
	if launcher.SecurityContext.RunAsUser != nil || prepare.SecurityContext.RunAsUser != nil {
		t.Fatal("the launcher and claw-home run as the Pod's user")
	}
	for _, c := range []core.Container{launcher, prepare, harness} {
		sc := c.SecurityContext
		if sc.AllowPrivilegeEscalation == nil || *sc.AllowPrivilegeEscalation || sc.ReadOnlyRootFilesystem == nil || !*sc.ReadOnlyRootFilesystem || len(sc.Capabilities.Drop) != 1 || sc.Capabilities.Drop[0] != "ALL" {
			t.Fatalf("%s security context = %#v", c.Name, sc)
		}
	}
	// A sidecar: the kubelet starts it before the launcher and stops it
	// when the launcher exits, so the launcher alone decides the Pod's phase.
	if harness.RestartPolicy == nil || *harness.RestartPolicy != core.ContainerRestartPolicyAlways || prepare.RestartPolicy != nil {
		t.Fatalf("restart policies = %v, %v", harness.RestartPolicy, prepare.RestartPolicy)
	}
	if got, want := harness.Command, []string{"node", "/opt/claw/claw-harness.mjs"}; !reflect.DeepEqual(got, want) || launcher.Command != nil {
		t.Fatalf("commands = %v, %v", got, launcher.Command)
	}
	if pod.ShareProcessNamespace != nil {
		t.Fatal("the containers must not share a PID namespace")
	}

	// Requests equal limits everywhere, and the launcher's share plus the
	// harness's remainder is exactly what the runtime declares.
	for _, name := range []core.ResourceName{core.ResourceCPU, core.ResourceMemory, core.ResourceEphemeralStorage} {
		total := launcher.Resources.Requests[name].DeepCopy()
		total.Add(harness.Resources.Requests[name])
		if declared := resource.MustParse(rt.Limits[string(name)]); total.Cmp(declared) != 0 {
			t.Fatalf("%s: launcher + harness = %s, declared %s", name, total.String(), declared.String())
		}
		for _, c := range []core.Container{launcher, prepare, harness} {
			request, limit := c.Resources.Requests[name], c.Resources.Limits[name]
			if request.Cmp(limit) != 0 || request.Sign() <= 0 {
				t.Fatalf("%s %s: request %s, limit %s", c.Name, name, request.String(), limit.String())
			}
		}
		share := resource.MustParse(queueRuntimeLauncherShare[string(name)])
		for _, c := range []core.Container{prepare, launcher} {
			if request := c.Resources.Requests[name]; request.Cmp(share) != 0 {
				t.Fatalf("%s %s = %s, the launcher's share is %s", c.Name, name, request.String(), share.String())
			}
		}
	}
	// What the scheduler and the executor's own node-fit check count for the
	// Pod is exactly what the runtime declares.
	for name, declared := range queueResources(rt.Requests) {
		if counted := podresource.PodRequests(&core.Pod{Spec: pod}, podresource.PodResourcesOptions{})[name]; counted.Cmp(declared) != 0 {
			t.Fatalf("pod %s request = %s, declared %s", name, counted.String(), declared.String())
		}
	}
	// Neither side mounts the root of the definition or HOME volume: a
	// volume's own root is writable by every user.
	for _, c := range []core.Container{launcher, harness} {
		for _, mount := range c.VolumeMounts {
			if (mount.Name == "definition" || mount.Name == "home") && mount.SubPath == "" {
				t.Fatalf("%s mounts the root of %s", c.Name, mount.Name)
			}
		}
	}
	// The harness's scratch is bounded by the harness's own storage limit.
	for _, volume := range pod.Volumes {
		if volume.Name == "work" {
			if limit := harness.Resources.Limits[core.ResourceEphemeralStorage]; volume.EmptyDir.SizeLimit.Cmp(limit) != 0 {
				t.Fatalf("scratch size limit = %s, harness limit %s", volume.EmptyDir.SizeLimit.String(), limit.String())
			}
		}
	}

	// A runtime that would leave the harness less than the launcher's own
	// share is refused at startup; twice the share is the least that fits.
	for name, sizes := range map[string][2]string{"cpu": {"150m", "200m"}, "memory": {"767Mi", "768Mi"}, "ephemeral-storage": {"1Gi", "2Gi"}} {
		small := testClawRuntime()
		small.HarnessContainer = true
		small.Requests = map[string]string{"cpu": "2", "memory": "3Gi", "ephemeral-storage": "8Gi"}
		small.Requests[name], small.Limits[name] = sizes[0], sizes[0]
		if err := small.validate("claw-investigator", "runner-credentials"); err == nil || !strings.Contains(err.Error(), "launcher's") {
			t.Fatalf("%s = %s: %v", name, sizes[0], err)
		}
		// Without a harness container the same size is fine.
		small.HarnessContainer = false
		if err := small.validate("claw-investigator", "runner-credentials"); err != nil {
			t.Fatal(err)
		}
		small.HarnessContainer = true
		small.Requests[name], small.Limits[name] = sizes[1], sizes[1]
		if err := small.validate("claw-investigator", "runner-credentials"); err != nil {
			t.Fatalf("%s = %s: %v", name, sizes[1], err)
		}
	}
	// The socket's variable is the executor's to set.
	reserved := testClawRuntime()
	reserved.Env = []queueRuntimeEnv{{Name: "CLAW_HARNESS_SOCKET", Value: "/tmp/x"}}
	if err := reserved.validate("claw-investigator", "runner-credentials"); err == nil {
		t.Fatal("CLAW_HARNESS_SOCKET must be reserved")
	}
}

// A runtime that does not set harness_container keeps its single-container
// Job exactly.
func TestQueueRuntimeWithoutHarnessContainerIsOneContainer(t *testing.T) {
	q, _ := zoneQueueFixture()
	job, err := q.job(clawLaunch())
	if err != nil {
		t.Fatal(err)
	}
	pod := job.Spec.Template.Spec
	if len(pod.InitContainers) != 0 || len(pod.Containers) != 1 {
		t.Fatalf("containers = %d init, %d regular", len(pod.InitContainers), len(pod.Containers))
	}
	for _, env := range pod.Containers[0].Env {
		if env.Name == "CLAW_HARNESS_SOCKET" {
			t.Fatal("no harness socket without a harness container")
		}
	}
}

// A harness container is a sidecar, which a cluster from before 1.29 runs as
// an init container that never exits. The executor refuses to start there.
func TestQueueRuntimeHarnessContainerNeedsSidecars(t *testing.T) {
	for version, runs := range map[string]bool{"1.28": false, "1.29": true, "1.29+": true, "1.36": true, "2.0": true, "1.": false, "": false, "1.x": false} {
		major, minor, _ := strings.Cut(version, ".")
		if got := queueClusterRunsSidecars(major, minor); got != runs {
			t.Fatalf("version %q: sidecars = %v, want %v", version, got, runs)
		}
	}
	secret := &core.Secret{ObjectMeta: meta.ObjectMeta{Name: "claw-investigator", Namespace: "lcars-work"}, Data: map[string][]byte{"investigator-ssh-key": []byte("k"), "known-hosts": []byte("h"), "litellm-api-key": []byte("m")}}
	for minor, wantErr := range map[string]string{"28": "needs Kubernetes 1.29", "36+": ""} {
		q, c := zoneQueueFixture(secret)
		rt := testClawRuntime()
		rt.HarnessContainer = true
		q.config.Runtimes["claw-investigator"] = rt
		c.Discovery().(*fakediscovery.FakeDiscovery).FakedServerVersion = &version.Info{Major: "1", Minor: minor}
		err := q.preflight(context.Background())
		if wantErr == "" {
			// Whatever else the fixture lacks, the version is not the complaint.
			if err != nil && strings.Contains(err.Error(), "harness_container") {
				t.Fatalf("1.%s: %v", minor, err)
			}
			continue
		}
		if err == nil || !strings.Contains(err.Error(), wantErr) {
			t.Fatalf("1.%s: %v", minor, err)
		}
	}
	// A runtime without a harness container never asks for the version.
	q, c := zoneQueueFixture(secret)
	c.Discovery().(*fakediscovery.FakeDiscovery).FakedServerVersion = &version.Info{Major: "1", Minor: "20"}
	if err := q.preflight(context.Background()); err != nil && strings.Contains(err.Error(), "harness_container") {
		t.Fatal(err)
	}
}

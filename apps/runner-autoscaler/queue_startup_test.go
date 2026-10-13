package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// writeTestKubeconfig writes a syntactically valid kubeconfig: environment
// validation loads the REST config but never contacts the API server.
func writeTestKubeconfig(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "kubeconfig")
	const body = `apiVersion: v1
kind: Config
clusters:
- name: test
  cluster:
    server: https://127.0.0.1:6443
users:
- name: test
  user:
    token: test-token
contexts:
- name: test
  context:
    cluster: test
    user: test
current-context: test
`
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func testKubernetesResolved(t *testing.T) resolvedOrchestratorConfig {
	t.Helper()
	q, _ := kubeQueueFixture()
	config := q.config
	config.Kubeconfig = writeTestKubeconfig(t)
	return resolvedOrchestratorConfig{Raw: OrchestratorConfig{Version: 1, Kubernetes: &config}}
}

func TestQueueEnvironmentAcceptsCompleteKubernetesDeployment(t *testing.T) {
	t.Setenv("LCARS_CONSOLE_URL", "https://console.example")
	t.Setenv("GOOGLE_APPLICATION_CREDENTIALS", "/secrets/google.json")
	t.Setenv("LCARS_QUEUE_RUNNER_IMAGE", "registry/direct-runner:test")
	if err := validateQueueExecutorEnvironment(testKubernetesResolved(t)); err != nil {
		t.Fatalf("complete deployment rejected: %v", err)
	}
}

func TestQueueEnvironmentRejectsStaticDefects(t *testing.T) {
	for _, key := range []string{"LCARS_QUEUE_RUNNER_IMAGE", "GOOGLE_APPLICATION_CREDENTIALS", "LCARS_CONSOLE_URL", "LCARS_WORKER_POLICY_PROVIDERS"} {
		t.Run(key, func(t *testing.T) {
			t.Setenv("LCARS_CONSOLE_URL", "https://console.example")
			t.Setenv("GOOGLE_APPLICATION_CREDENTIALS", "/secrets/google.json")
			t.Setenv("LCARS_QUEUE_RUNNER_IMAGE", "registry/direct-runner:test")
			bad := ""
			if key == "LCARS_CONSOLE_URL" {
				bad = "relative"
			}
			if key == "LCARS_WORKER_POLICY_PROVIDERS" {
				bad = "unqualified-provider"
			}
			t.Setenv(key, bad)
			if err := validateQueueExecutorEnvironment(testKubernetesResolved(t)); err == nil {
				t.Fatal("invalid configuration accepted")
			}
		})
	}
}

// The queue executor is this process's only job, so an unconfigured queue
// executor must always refuse to start rather than run forever as a silent
// no-op.
func TestQueueExecutorEnvironmentRejectsDisabledQueueExecutor(t *testing.T) {
	for _, key := range []string{"LCARS_CONSOLE_URL", "GOOGLE_APPLICATION_CREDENTIALS"} {
		t.Setenv(key, "")
	}
	err := validateQueueExecutorEnvironment(testKubernetesResolved(t))
	if err == nil {
		t.Fatal("expected an error: the queue executor is this process's only job and it is unconfigured")
	}
	if !strings.Contains(err.Error(), "nothing else to run") {
		t.Fatalf("unexpected error: %v", err)
	}
}

package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const validOrchestratorYAML = `
version: 1
kubernetes:
  namespace: lcars-work
  credentials_secret: lcars-runner-credentials
  service_account: lcars-direct-runner
  max_concurrent: 2
  node_selector:
    homelab.jlapenna.net/queue-runner: 'true'
  requests:
    cpu: '1'
    memory: 2Gi
    ephemeral-storage: 1Gi
  limits:
    cpu: '1'
    memory: 2Gi
    ephemeral-storage: 4Gi
`

func writeConfig(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "orchestrator.yml")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestOrchestratorConfigDefaultsServerFields(t *testing.T) {
	resolved, err := loadOrchestratorConfig(writeConfig(t, validOrchestratorYAML))
	if err != nil {
		t.Fatal(err)
	}
	if got, want := resolved.Raw.Server.MetricsAddr, "127.0.0.1:8080"; got != want {
		t.Fatalf("default metrics_addr = %q, want %q", got, want)
	}
	if got, want := resolved.Raw.Server.LogLevel, "info"; got != want {
		t.Fatalf("default log_level = %q, want %q", got, want)
	}
	if got, want := resolved.Raw.Server.LogFormat, "text"; got != want {
		t.Fatalf("default log_format = %q, want %q", got, want)
	}
}

func TestOrchestratorConfigHonorsExplicitMetricsAddr(t *testing.T) {
	body := strings.Replace(validOrchestratorYAML, "version: 1\n", "version: 1\nserver:\n  metrics_addr: 0.0.0.0:9999\n", 1)
	resolved, err := loadOrchestratorConfig(writeConfig(t, body))
	if err != nil {
		t.Fatal(err)
	}
	if got, want := resolved.Raw.Server.MetricsAddr, "0.0.0.0:9999"; got != want {
		t.Fatalf("metrics_addr = %q, want %q", got, want)
	}
}

func TestOrchestratorConfigRequiresVersion1(t *testing.T) {
	body := strings.Replace(validOrchestratorYAML, "version: 1", "version: 2", 1)
	if _, err := loadOrchestratorConfig(writeConfig(t, body)); err == nil || !strings.Contains(err.Error(), "version must be 1") {
		t.Fatalf("expected a version error, got %v", err)
	}
}

// Kubernetes Jobs are the queue executor's only backend: a config without the
// stanza has nothing to launch work with and must not start.
func TestOrchestratorConfigRequiresKubernetes(t *testing.T) {
	if _, err := loadOrchestratorConfig(writeConfig(t, "version: 1\n")); err == nil || !strings.Contains(err.Error(), "kubernetes is required") {
		t.Fatalf("expected a kubernetes-required error, got %v", err)
	}
}

func TestOrchestratorConfigValidatesKubernetes(t *testing.T) {
	body := strings.Replace(validOrchestratorYAML, "  max_concurrent: 2\n", "  max_concurrent: 0\n", 1)
	if _, err := loadOrchestratorConfig(writeConfig(t, body)); err == nil || !strings.Contains(err.Error(), "positive max_concurrent") {
		t.Fatalf("expected a kubernetes validation error, got %v", err)
	}
}

func TestOrchestratorConfigRejectsUnknownField(t *testing.T) {
	_, err := loadOrchestratorConfig(writeConfig(t, validOrchestratorYAML+"unknown: true\n"))
	if err == nil || !strings.Contains(err.Error(), "field unknown not found") {
		t.Fatalf("expected strict YAML error, got %v", err)
	}
}

// Every key the removed Docker backend and scale-set manager read is rejected
// by name, so a stale file fails with an instruction to delete the key rather
// than either silently configuring nothing or a bare decoder error.
func TestOrchestratorConfigRejectsRetiredKeysByName(t *testing.T) {
	for key, snippet := range map[string]string{
		"fleet":             "fleet:\n  hosts:\n    - name: janeway\n      docker: local\n",
		"github":            "github:\n  app_id: 1\n",
		"registrations":     "registrations:\n  - name: agent-lcars\n",
		"scale_sets":        "scale_sets:\n  - name: homelab-autoscale\n",
		"server.state_path": "server:\n  state_path: /state/checkpoint.json\n",
		"fleet (empty)":     "fleet:\n",
	} {
		t.Run(key, func(t *testing.T) {
			_, err := loadOrchestratorConfig(writeConfig(t, validOrchestratorYAML+snippet))
			if err == nil || !strings.Contains(err.Error(), "retired keys") || !strings.Contains(err.Error(), strings.TrimSuffix(key, " (empty)")) {
				t.Fatalf("expected a retired-key error naming %s, got %v", key, err)
			}
		})
	}
}

// TestLoadOrchestratorConfigAcceptsLiveHomelabOrchestratorYAMLShape pins the
// exact key set homelab's rendered .orchestrator.runtime.yml carries today
// (version, server, kubernetes, arc_lanes), so removing a backend can never
// make the live controller refuse to start.
func TestLoadOrchestratorConfigAcceptsLiveHomelabOrchestratorYAMLShape(t *testing.T) {
	const live = `version: 1

server:
  metrics_addr: :8080
  log_level: info
  log_format: text

kubernetes:
  namespace: lcars-work
  kubeconfig: /run/secrets/queue-kubeconfig
  credentials_secret: lcars-runner-credentials
  service_account: lcars-direct-runner
  max_concurrent: 5
  node_selector:
    homelab.jlapenna.net/queue-runner: 'true'
    homelab.jlapenna.net/shared-worker: 'true'
  tolerations:
    - key: homelab.jlapenna.net/ci-only
      operator: Equal
      value: 'true'
      effect: NoSchedule
  requests:
    cpu: '6'
    memory: 12Gi
    ephemeral-storage: 4Gi
  limits:
    cpu: '6'
    memory: 12Gi
    ephemeral-storage: 24Gi
arc_lanes:
- name: lcars-ci
  registration_url: https://github.com/jlapenna/agent-lcars
  metrics_url: http://laforge.lan.jlapenna.net:30086/metrics
`
	resolved, err := loadOrchestratorConfig(writeConfig(t, live))
	if err != nil {
		t.Fatalf("live homelab orchestrator.yml shape rejected: %v", err)
	}
	if resolved.Raw.Kubernetes == nil || resolved.Raw.Kubernetes.MaxConcurrent != 5 || len(resolved.Raw.ARCLanes) != 1 {
		t.Fatalf("live config resolved unexpectedly: %+v", resolved.Raw)
	}
}

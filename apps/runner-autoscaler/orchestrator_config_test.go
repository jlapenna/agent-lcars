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
	cfg, err := loadOrchestratorConfig(writeConfig(t, validOrchestratorYAML))
	if err != nil {
		t.Fatal(err)
	}
	if got, want := cfg.Server.MetricsAddr, "127.0.0.1:8080"; got != want {
		t.Fatalf("default metrics_addr = %q, want %q", got, want)
	}
	if got, want := cfg.Server.LogLevel, "info"; got != want {
		t.Fatalf("default log_level = %q, want %q", got, want)
	}
	if got, want := cfg.Server.LogFormat, "text"; got != want {
		t.Fatalf("default log_format = %q, want %q", got, want)
	}
}

func TestOrchestratorConfigHonorsExplicitMetricsAddr(t *testing.T) {
	body := strings.Replace(validOrchestratorYAML, "version: 1\n", "version: 1\nserver:\n  metrics_addr: 0.0.0.0:9999\n", 1)
	cfg, err := loadOrchestratorConfig(writeConfig(t, body))
	if err != nil {
		t.Fatal(err)
	}
	if got, want := cfg.Server.MetricsAddr, "0.0.0.0:9999"; got != want {
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

// Strict decoding rejects every unknown key, including the retired scale-set
// manager and Docker backend keys, so a stale file can never be mistaken for
// live configuration.
func TestOrchestratorConfigRejectsUnknownField(t *testing.T) {
	for key, snippet := range map[string]string{
		"unknown":    "unknown: true\n",
		"fleet":      "fleet:\n  hosts:\n    - name: janeway\n",
		"github":     "github:\n  app_id: 1\n",
		"scale_sets": "scale_sets:\n  - name: homelab-autoscale\n",
		"state_path": "server:\n  state_path: /state/checkpoint.json\n",
	} {
		t.Run(key, func(t *testing.T) {
			_, err := loadOrchestratorConfig(writeConfig(t, validOrchestratorYAML+snippet))
			if err == nil || !strings.Contains(err.Error(), "field "+key+" not found") {
				t.Fatalf("expected strict YAML error naming %s, got %v", key, err)
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
	cfg, err := loadOrchestratorConfig(writeConfig(t, live))
	if err != nil {
		t.Fatalf("live homelab orchestrator.yml shape rejected: %v", err)
	}
	if cfg.Kubernetes == nil || cfg.Kubernetes.MaxConcurrent != 5 || len(cfg.ARCLanes) != 1 {
		t.Fatalf("live config resolved unexpectedly: %+v", cfg)
	}
}

// zoneOrchestratorYAML is the documented homelab-ops zone executor shape: it
// serves only claw-investigator and declares no legacy credential Secret,
// resources or runner image.
const zoneOrchestratorYAML = `version: 1
kubernetes:
  namespace: homelab-ops-claw
  service_account: claw-runner
  max_concurrent: 1
  node_selector:
    homelab.jlapenna.net/queue-runner: 'true'
  runtimes_only: true
  runtimes:
    claw-investigator:
      image: registry.example.com/openclaw@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
      requests: { cpu: '2', memory: 3Gi, ephemeral-storage: 8Gi }
      limits: { cpu: '2', memory: 3Gi, ephemeral-storage: 8Gi }
      active_deadline_seconds: 3300
      secret_name: claw-investigator
      items:
        - { key: investigator-ssh-key, path: ssh/id_ed25519 }
        - { key: known-hosts, path: ssh/known_hosts }
        - { key: litellm-api-key, path: env/LITELLM_API_KEY }
      agent:
        config_map: claw-investigator-agent
        items:
          - { key: config.json, path: config.json }
          - { key: approvals.json, path: approvals.json }
          - { key: workspace-AGENTS.md, path: workspace/AGENTS.md }
      env:
        - { name: CLAW_AGENT, value: investigator }
`

func TestOrchestratorConfigAcceptsZoneExecutor(t *testing.T) {
	cfg, err := loadOrchestratorConfig(writeConfig(t, zoneOrchestratorYAML))
	if err != nil {
		t.Fatalf("zone executor config rejected: %v", err)
	}
	rt, ok := cfg.Kubernetes.Runtimes["claw-investigator"]
	if !cfg.Kubernetes.RuntimesOnly || !ok || rt.ActiveDeadlineSeconds != 3300 || len(rt.Items) != 3 || rt.Agent == nil || len(rt.Agent.Items) != 3 || rt.Env[0].Name != "CLAW_AGENT" {
		t.Fatalf("zone config resolved unexpectedly: %+v", cfg.Kubernetes)
	}
}

func TestOrchestratorConfigRejectsInvalidRuntime(t *testing.T) {
	for name, edit := range map[string][2]string{
		"unknown runtime key": {"      active_deadline_seconds: 3300\n", "      active_deadline_seconds: 3300\n      command: [sh]\n"},
		"tag image":           {"openclaw@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", "openclaw:latest"},
		"deadline at lease":   {"active_deadline_seconds: 3300", "active_deadline_seconds: 7200"},
		"unequal limits":      {"limits: { cpu: '2', memory: 3Gi", "limits: { cpu: '2', memory: 4Gi"},
		"legacy name":         {"    claw-investigator:\n", "    claude:\n"},
		"escaping item":       {"path: ssh/known_hosts", "path: ../known_hosts"},
		"reserved env":        {"name: CLAW_AGENT", "name: LCARS_RUN_ID"},
		"zone with legacy":    {"  runtimes_only: true\n", "  runtimes_only: true\n  credentials_secret: lcars-runner-credentials\n"},
		"shared without keys": {"  runtimes_only: true\n", ""},
	} {
		t.Run(name, func(t *testing.T) {
			body := strings.Replace(zoneOrchestratorYAML, edit[0], edit[1], 1)
			if body == zoneOrchestratorYAML {
				t.Fatal("test edit did not apply")
			}
			if _, err := loadOrchestratorConfig(writeConfig(t, body)); err == nil {
				t.Fatal("invalid runtime config accepted")
			}
		})
	}
}

// A shared executor may declare runtimes alongside its legacy pipelines.
func TestOrchestratorConfigAcceptsSharedExecutorRuntimes(t *testing.T) {
	runtimes := zoneOrchestratorYAML[strings.Index(zoneOrchestratorYAML, "  runtimes:\n"):]
	runtimes = strings.Replace(runtimes, "secret_name: claw-investigator", "secret_name: claw-investigator-zone", 1)
	cfg, err := loadOrchestratorConfig(writeConfig(t, validOrchestratorYAML+runtimes))
	if err != nil {
		t.Fatalf("shared executor with a runtime rejected: %v", err)
	}
	if cfg.Kubernetes.RuntimesOnly || len(cfg.Kubernetes.Runtimes) != 1 {
		t.Fatalf("unexpected shared config: %+v", cfg.Kubernetes)
	}
}

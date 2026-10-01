package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const validOrchestratorYAML = `
version: 1
fleet:
  hosts:
    - name: janeway
      docker: local
    - name: laforge
      docker: ssh://homelab@laforge.lan.jlapenna.net
`

func writeConfig(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "orchestrator.yml")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestLoadOrchestratorConfigResolvesDockerHosts(t *testing.T) {
	resolved, err := loadOrchestratorConfig(writeConfig(t, validOrchestratorYAML))
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"janeway=local", "laforge=ssh://homelab@laforge.lan.jlapenna.net"}
	if len(resolved.DockerHosts) != len(want) || resolved.DockerHosts[0] != want[0] || resolved.DockerHosts[1] != want[1] {
		t.Fatalf("DockerHosts = %v, want %v", resolved.DockerHosts, want)
	}
	if len(resolved.Warnings) != 0 {
		t.Fatalf("Warnings = %v, want none for a config with no legacy sections", resolved.Warnings)
	}
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

func TestOrchestratorConfigRequiresNonEmptyFleetHosts(t *testing.T) {
	body := "version: 1\nfleet:\n  hosts: []\n"
	if _, err := loadOrchestratorConfig(writeConfig(t, body)); err == nil || !strings.Contains(err.Error(), "fleet.hosts must not be empty") {
		t.Fatalf("expected a fleet.hosts error, got %v", err)
	}
}

func TestOrchestratorConfigRequiresHostNameAndDocker(t *testing.T) {
	tests := map[string]string{
		"missing name":   "version: 1\nfleet:\n  hosts:\n    - docker: local\n",
		"missing docker": "version: 1\nfleet:\n  hosts:\n    - name: janeway\n",
	}
	for name, body := range tests {
		t.Run(name, func(t *testing.T) {
			if _, err := loadOrchestratorConfig(writeConfig(t, body)); err == nil || !strings.Contains(err.Error(), "requires name and docker") {
				t.Fatalf("expected a name/docker error, got %v", err)
			}
		})
	}
}

func TestOrchestratorConfigRejectsDuplicateHostName(t *testing.T) {
	body := "version: 1\nfleet:\n  hosts:\n    - name: janeway\n      docker: local\n    - name: janeway\n      docker: ssh://homelab@janeway.lan.jlapenna.net\n"
	if _, err := loadOrchestratorConfig(writeConfig(t, body)); err == nil || !strings.Contains(err.Error(), `duplicate fleet host "janeway"`) {
		t.Fatalf("expected a duplicate-host error, got %v", err)
	}
}

// TestOrchestratorConfigParsesReadinessKeys proves the strict
// (KnownFields(true)) parser accepts the new per-host readiness_url and
// readiness_metric keys, resolves them into resolvedOrchestratorConfig.Readiness
// keyed by host name, and applies the defaultReadinessMetric default when
// readiness_metric is omitted.
func TestOrchestratorConfigParsesReadinessKeys(t *testing.T) {
	body := strings.Replace(validOrchestratorYAML,
		"      docker: local\n",
		"      docker: local\n      readiness_url: http://janeway.lan.jlapenna.net:9100/metrics\n",
		1)
	body = strings.Replace(body,
		"      docker: ssh://homelab@laforge.lan.jlapenna.net\n",
		"      docker: ssh://homelab@laforge.lan.jlapenna.net\n      readiness_url: http://laforge.lan.jlapenna.net:9100/metrics\n      readiness_metric: laforge_ready\n",
		1)
	resolved, err := loadOrchestratorConfig(writeConfig(t, body))
	if err != nil {
		t.Fatalf("readiness_url/readiness_metric must parse under the strict decoder: %v", err)
	}
	if len(resolved.Readiness) != 2 {
		t.Fatalf("Readiness = %v, want exactly 2 entries", resolved.Readiness)
	}
	janeway, ok := resolved.Readiness["janeway"]
	if !ok {
		t.Fatalf("Readiness[janeway] missing, got %v", resolved.Readiness)
	}
	if janeway.url != "http://janeway.lan.jlapenna.net:9100/metrics" || janeway.metric != defaultReadinessMetric {
		t.Fatalf("janeway readiness = %+v, want url set and metric defaulted to %q", janeway, defaultReadinessMetric)
	}
	laforge, ok := resolved.Readiness["laforge"]
	if !ok {
		t.Fatalf("Readiness[laforge] missing, got %v", resolved.Readiness)
	}
	if laforge.url != "http://laforge.lan.jlapenna.net:9100/metrics" || laforge.metric != "laforge_ready" {
		t.Fatalf("laforge readiness = %+v, want its explicit metric name preserved", laforge)
	}
}

// TestOrchestratorConfigHostWithoutReadinessURLHasNoReadinessEntry proves a
// host that never sets readiness_url gets no Readiness map entry at all --
// today's "always eligible" behavior is preserved by absence, not a
// zero-value struct.
func TestOrchestratorConfigHostWithoutReadinessURLHasNoReadinessEntry(t *testing.T) {
	resolved, err := loadOrchestratorConfig(writeConfig(t, validOrchestratorYAML))
	if err != nil {
		t.Fatal(err)
	}
	if len(resolved.Readiness) != 0 {
		t.Fatalf("Readiness = %v, want none when no host sets readiness_url", resolved.Readiness)
	}
}

// TestOrchestratorConfigRejectsInvalidReadinessURL proves a malformed
// readiness_url fails config loading loudly (fail-fast at startup), the same
// posture this file already takes for a malformed LCARS_CONSOLE_URL in
// validateQueueExecutorEnvironment.
func TestOrchestratorConfigRejectsInvalidReadinessURL(t *testing.T) {
	tests := map[string]string{
		"not a URL at all":   "not-a-url",
		"missing scheme":     "janeway.lan.jlapenna.net:9100/metrics",
		"non-http(s) scheme": "ftp://janeway.lan.jlapenna.net/metrics",
	}
	for name, readinessURL := range tests {
		t.Run(name, func(t *testing.T) {
			body := strings.Replace(validOrchestratorYAML, "      docker: local\n", "      docker: local\n      readiness_url: "+readinessURL+"\n", 1)
			if _, err := loadOrchestratorConfig(writeConfig(t, body)); err == nil || !strings.Contains(err.Error(), "readiness_url") {
				t.Fatalf("expected a readiness_url error, got %v", err)
			}
		})
	}
}

func TestOrchestratorConfigRejectsUnknownField(t *testing.T) {
	_, err := loadOrchestratorConfig(writeConfig(t, validOrchestratorYAML+"unknown: true\n"))
	if err == nil || !strings.Contains(err.Error(), "field unknown not found") {
		t.Fatalf("expected strict YAML error, got %v", err)
	}
}

// TestOrchestratorConfigRejectsUnknownHostField guards fleet.hosts[]: unlike
// the legacy top-level sections and legacy per-host keys this file's package
// doc enumerates, an actually-unrecognized host key (never valid at any
// point in this config's history) must still fail loudly rather than
// silently decode into nothing.
func TestOrchestratorConfigRejectsUnknownHostField(t *testing.T) {
	body := strings.Replace(validOrchestratorYAML, "      docker: local\n", "      docker: local\n      workdir_size_cap: 30g\n", 1)
	if _, err := loadOrchestratorConfig(writeConfig(t, body)); err == nil || !strings.Contains(err.Error(), "field workdir_size_cap not found") {
		t.Fatalf("expected strict YAML error for an unknown host field, got %v", err)
	}
}

// --- Legacy-section compatibility (homelab#1623 Phase 3) ---
//
// The live homelab orchestrator.yml (jlapenna/homelab's
// github-runner-autoscaler/orchestrator.yml) still carries every section
// below: it keeps one enabled registration (agent-lcars, scale set
// homelab-autoscale-lcars-e2e) specifically because this binary required at
// least one enabled scale set before this change -- see that file's own
// retirement commit (homelab#1657) and docs/k3s.md's Phase 2b batch 3
// "Cutover order" step 4. This decoder must not reject that file; it must
// decode-and-ignore every one of these sections and say so via Warnings, so
// an operator sees the dead weight instead of the process refusing to start.

func TestOrchestratorConfigWarnsOnLegacyGitHubAndRegistrationsAndScaleSets(t *testing.T) {
	body := validOrchestratorYAML + `github:
  url: https://github.com/supersprinklesracing/sprinkles
  runner_group: Default
scale_sets:
  - name: default
    labels: [default]
registrations:
  - name: agent-lcars
    disabled: false
    github:
      url: https://github.com/jlapenna/agent-lcars
    app:
      client_id: Iv23liexample
      installation_id: 123456
      private_key_file: /secrets/lcars-app-private-key.pem
    scale_sets:
      - name: homelab-autoscale-lcars-e2e
        labels: [lcars-e2e]
        runner_image: example/e2e-runner:latest
        min_runners: 0
        max_runners: 2
`
	resolved, err := loadOrchestratorConfig(writeConfig(t, body))
	if err != nil {
		t.Fatalf("a config with legacy github/scale_sets/registrations must still resolve: %v", err)
	}
	for _, want := range []string{"github", "scale_sets", "registrations"} {
		found := false
		for _, warning := range resolved.Warnings {
			if strings.Contains(warning, want) {
				found = true
			}
		}
		if !found {
			t.Fatalf("Warnings = %v, want a notice naming %q", resolved.Warnings, want)
		}
	}
}

func TestOrchestratorConfigWarnsOnLegacyFleetSections(t *testing.T) {
	body := strings.Replace(validOrchestratorYAML, "fleet:\n", "fleet:\n  max_runners: 2\n  file_mount_allowlist: [/etc/buildkit-client]\n  placement:\n    host_metrics_url_template: http://%s.lan.jlapenna.net:9100/metrics\n    load_soft: 0.75\n", 1)
	resolved, err := loadOrchestratorConfig(writeConfig(t, body))
	if err != nil {
		t.Fatalf("a config with legacy fleet sections must still resolve: %v", err)
	}
	for _, want := range []string{"fleet.max_runners", "fleet.placement", "fleet.file_mount_allowlist"} {
		found := false
		for _, warning := range resolved.Warnings {
			if strings.Contains(warning, want) {
				found = true
			}
		}
		if !found {
			t.Fatalf("Warnings = %v, want a notice naming %q", resolved.Warnings, want)
		}
	}
}

func TestOrchestratorConfigWarnsOnLegacyServerStatePath(t *testing.T) {
	body := strings.Replace(validOrchestratorYAML, "version: 1\n", "version: 1\nserver:\n  state_path: /var/lib/runner-autoscaler/state.json\n", 1)
	resolved, err := loadOrchestratorConfig(writeConfig(t, body))
	if err != nil {
		t.Fatalf("a config with legacy server.state_path must still resolve: %v", err)
	}
	if !containsSubstring(resolved.Warnings, "server.state_path") {
		t.Fatalf("Warnings = %v, want a notice naming server.state_path", resolved.Warnings)
	}
}

func TestOrchestratorConfigWarnsOnLegacyPerHostFields(t *testing.T) {
	body := strings.Replace(validOrchestratorYAML, "      docker: local\n", "      docker: local\n      runner_limit: 1\n      require_mains: true\n      require_readiness: true\n      metrics_via_ssh: true\n      role: opportunistic\n      inference_metrics_url: http://llama-swap.lan.jlapenna.net:8000/metrics\n", 1)
	resolved, err := loadOrchestratorConfig(writeConfig(t, body))
	if err != nil {
		t.Fatalf("a config with legacy per-host fields must still resolve: %v", err)
	}
	if !containsSubstring(resolved.Warnings, "fleet.hosts[]") {
		t.Fatalf("Warnings = %v, want a notice naming the legacy per-host keys", resolved.Warnings)
	}
}

func containsSubstring(haystack []string, needle string) bool {
	for _, s := range haystack {
		if strings.Contains(s, needle) {
			return true
		}
	}
	return false
}

// TestLoadOrchestratorConfigAcceptsLiveHomelabOrchestratorYAMLShape loads a
// fixture mirroring today's actual jlapenna/homelab
// github-runner-autoscaler/orchestrator.yml shape in full -- every legacy
// section at once, including a non-disabled registration with a real
// scale_sets entry (not merely "disabled: true" placeholders) -- and asserts
// it still resolves to queue-executor-only Docker hosts, with warnings
// naming every ignored section. This is a fixture written here, not a read
// of the homelab repository.
func TestLoadOrchestratorConfigAcceptsLiveHomelabOrchestratorYAMLShape(t *testing.T) {
	const fixture = `
version: 1

github:
  url: https://github.com/supersprinklesracing/sprinkles
  runner_group: Default

server:
  metrics_addr: :8080
  log_level: info
  log_format: text
  state_path: /var/lib/runner-autoscaler/state.json

fleet:
  max_runners: 2
  file_mount_allowlist:
    - /etc/buildkit-client
  hosts:
    - name: homelab
      docker: local
      runner_limit: 1
    - name: laforge
      docker: ssh://homelab@laforge.lan.jlapenna.net
      memory_safety_margin: 0.50
      runner_limit: 1
    - name: picard
      docker: ssh://homelab@picard.lan.jlapenna.net
      runner_limit: 1
      inference_metrics_url: http://llama-swap.lan.jlapenna.net:8000/metrics
    - name: laptop
      docker: ssh://homelab@laptop.ts.jlapenna.net
      require_mains: true
      require_readiness: true
      metrics_via_ssh: true
      runner_limit: 2
      role: opportunistic
  placement:
    host_metrics_url_template: http://%s.lan.jlapenna.net:9100/metrics
    readiness_metrics_url: http://homelab.lan.jlapenna.net:9100/metrics
    readiness_metric: tailscale_peer_lan_present
    readiness_max_age: 5m
    host_memory_exempt: [picard]
    runner_cgroup_parent: homelab-runners.slice
    memory_safety_margin: 0.10
    cpu_safety_margin: 0.10
    memory_safety_margin_max: 6g
    load_soft: 0.75
    load_busy: 1.0
    load_hard: 2.0
    cpu_soft: 0.85
    cpu_hard: 0.95
    psi_soft: 0.10
    psi_hard: 0.25
    memory_soft: 0.15
    memory_hard: 0.08
    swap_soft: 10
    swap_hard: 100
    overload_cooldown: 30s
    telemetry_penalty: 1
    degradation_ladder:
      enabled: true
      prometheus_url: http://prometheus:9090

registrations:
  - name: agent-lcars
    disabled: false
    github:
      url: https://github.com/jlapenna/agent-lcars
      runner_group: Default
    app:
      client_id: Iv23liexample
      installation_id: 154210710
      private_key_file: /secrets/lcars-app-private-key.pem
    scale_sets:
      - name: homelab-autoscale-lcars-e2e
        labels: [lcars-e2e, homelab-autoscale-lcars-e2e]
        runner_image: docker-registry.lan.jlapenna.net/agent-lcars/e2e-runner:latest
        min_runners: 0
        max_runners: 2
        weight: 1
        runner_memory: 12g
        runner_memory_reservation: 6g
        runner_cpus: 6
        runner_cpu_reservation: 2.5
        priority: 10
        pids_limit: 8192
        shm_size: 1g
  - name: homelab
    disabled: true
    github:
      url: https://github.com/jlapenna/homelab
      runner_group: Default
    app:
      client_id: Iv23liexample
      installation_id: 154210710
      private_key_file: /secrets/lcars-app-private-key.pem
`
	resolved, err := loadOrchestratorConfig(writeConfig(t, fixture))
	if err != nil {
		t.Fatalf("today's live homelab orchestrator.yml shape must still resolve: %v", err)
	}
	want := []string{"homelab=local", "laforge=ssh://homelab@laforge.lan.jlapenna.net", "picard=ssh://homelab@picard.lan.jlapenna.net", "laptop=ssh://homelab@laptop.ts.jlapenna.net"}
	if len(resolved.DockerHosts) != len(want) {
		t.Fatalf("DockerHosts = %v, want %v", resolved.DockerHosts, want)
	}
	for i, host := range want {
		if resolved.DockerHosts[i] != host {
			t.Fatalf("DockerHosts[%d] = %q, want %q", i, resolved.DockerHosts[i], host)
		}
	}
	// The live file has no top-level scale_sets: key any more (that was
	// retired from the primary registration already); its only surviving
	// scale set is nested under registrations[], covered by the
	// "registrations" warning below.
	for _, want := range []string{"github", "registrations", "fleet.max_runners", "fleet.placement", "fleet.file_mount_allowlist", "server.state_path", "fleet.hosts[]"} {
		if !containsSubstring(resolved.Warnings, want) {
			t.Fatalf("Warnings = %v, want a notice naming %q", resolved.Warnings, want)
		}
	}

	// The queue executor only ever reads DockerHosts; prove the preflight
	// path that actually launches direct runners accepts this resolved
	// config unchanged (it ignores every legacy section just as thoroughly).
	if _, _, err := ParseDockerHosts(resolved.DockerHosts); err != nil {
		t.Fatalf("ParseDockerHosts rejected the resolved legacy-shaped config: %v", err)
	}
}

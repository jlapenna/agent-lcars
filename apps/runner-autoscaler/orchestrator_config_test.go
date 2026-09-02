package main

import (
	"context"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus/testutil"
)

const validOrchestratorYAML = `
version: 1
github:
  url: https://github.com/example/repo
server:
  state_path: /var/lib/runner-autoscaler/state.json
fleet:
  max_runners: 2
  hosts:
    - name: janeway
      docker: local
      runner_limit: 1
  placement: {}
scale_sets:
  - name: default
    labels: [default]
    runner_image: example/default:latest
    min_runners: 0
    max_runners: 1
  - name: e2e
    labels: [e2e]
    runner_image: example/e2e:latest
    min_runners: 0
    max_runners: 1
`

func writeConfig(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "orchestrator.yml")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestLoadOrchestratorConfig(t *testing.T) {
	resolved, err := loadOrchestratorConfig(writeConfig(t, validOrchestratorYAML))
	if err != nil {
		t.Fatal(err)
	}
	if got := resolved.RunnerLimits["janeway"]; got != 1 {
		t.Fatalf("runner limit = %d, want 1", got)
	}
	if len(resolved.ScaleSets) != 2 || resolved.Weights["default"] != 1 {
		t.Fatalf("unexpected resolved scale sets: %#v", resolved.ScaleSets)
	}
	if got := resolved.Raw.Fleet.Placement.MemorySafetyMargin; got != defaultMemorySafetyMargin {
		t.Fatalf("memory safety margin = %v, want default %v", got, defaultMemorySafetyMargin)
	}
	// agent-lcars#1728: host_metrics_url_template has no fleet-named
	// default; unset resolves to a domain-free template.
	if got, want := resolved.Raw.Fleet.Placement.HostMetricsURLTemplate, "http://%s:9100/metrics"; got != want {
		t.Fatalf("host_metrics_url_template default = %q, want %q", got, want)
	}
	// agent-lcars#1726: no host is memory-exempt, and no host carries an
	// inference probe, by default.
	if len(resolved.Raw.Fleet.Placement.HostMemoryExempt) != 0 {
		t.Fatalf("host_memory_exempt default = %v, want empty", resolved.Raw.Fleet.Placement.HostMemoryExempt)
	}
	if len(resolved.InferenceMetricsURLs) != 0 {
		t.Fatalf("InferenceMetricsURLs default = %v, want empty", resolved.InferenceMetricsURLs)
	}
}

// TestOrchestratorConfigDeprecatedSparkMetricsURLAlias covers
// agent-lcars#1726's one-release backward-compatible alias:
// fleet.placement.spark_metrics_url still populates the inference probe for
// a host named "spark" and produces a deprecation warning.
func TestOrchestratorConfigDeprecatedSparkMetricsURLAlias(t *testing.T) {
	body := strings.Replace(validOrchestratorYAML, "    - name: janeway", "    - name: spark", 1)
	body = strings.Replace(body, "  placement: {}", "  placement:\n    spark_metrics_url: http://spark.example.invalid:8000/metrics", 1)

	resolved, err := loadOrchestratorConfig(writeConfig(t, body))
	if err != nil {
		t.Fatal(err)
	}
	if got := resolved.InferenceMetricsURLs["spark"]; got != "http://spark.example.invalid:8000/metrics" {
		t.Fatalf("InferenceMetricsURLs[spark] = %q, want the deprecated alias URL", got)
	}
	if len(resolved.Warnings) == 0 || !strings.Contains(resolved.Warnings[0], "spark_metrics_url is deprecated") {
		t.Fatalf("Warnings = %v, want a spark_metrics_url deprecation notice", resolved.Warnings)
	}
}

// TestOrchestratorConfigDeprecatedSparkMetricsURLAliasOnlyAppliesToSpark
// covers the alias's narrow scope: it does not retarget to a differently
// named host even when that's the only host configured (agent-lcars#1726 --
// the whole point of the issue is that a rename silently orphaned this
// alias, and the generalized per-host key is the fix, not a smarter alias).
func TestOrchestratorConfigDeprecatedSparkMetricsURLAliasOnlyAppliesToSpark(t *testing.T) {
	body := strings.Replace(validOrchestratorYAML, "  placement: {}", "  placement:\n    spark_metrics_url: http://spark.example.invalid:8000/metrics", 1)

	resolved, err := loadOrchestratorConfig(writeConfig(t, body))
	if err != nil {
		t.Fatal(err)
	}
	if got := resolved.InferenceMetricsURLs["janeway"]; got != "" {
		t.Fatalf("InferenceMetricsURLs[janeway] = %q, want empty: the alias must not apply to a non-spark host", got)
	}
	if got := resolved.InferenceMetricsURLs["spark"]; got != "http://spark.example.invalid:8000/metrics" {
		t.Fatalf("InferenceMetricsURLs[spark] = %q, want the deprecated alias URL even with no host literally named spark configured", got)
	}
}

// TestOrchestratorConfigHostInferenceMetricsURLPreferredOverAlias covers the
// new-style per-host key taking precedence when both it and the deprecated
// alias are set for the "spark" host.
func TestOrchestratorConfigHostInferenceMetricsURLPreferredOverAlias(t *testing.T) {
	body := strings.Replace(validOrchestratorYAML, "    - name: janeway\n      docker: local",
		"    - name: spark\n      docker: local\n      inference_metrics_url: http://explicit.example.invalid:8000/metrics", 1)
	body = strings.Replace(body, "  placement: {}", "  placement:\n    spark_metrics_url: http://deprecated.example.invalid:8000/metrics", 1)

	resolved, err := loadOrchestratorConfig(writeConfig(t, body))
	if err != nil {
		t.Fatal(err)
	}
	if got := resolved.InferenceMetricsURLs["spark"]; got != "http://explicit.example.invalid:8000/metrics" {
		t.Fatalf("InferenceMetricsURLs[spark] = %q, want the explicit per-host URL to win over the deprecated alias", got)
	}
}

func TestOrchestratorConfigResolvesSchedulingPriority(t *testing.T) {
	body := strings.Replace(validOrchestratorYAML,
		"    runner_image: example/default:latest",
		"    runner_image: example/default:latest\n    priority: 10", 1)
	resolved, err := loadOrchestratorConfig(writeConfig(t, body))
	if err != nil {
		t.Fatal(err)
	}
	if got := resolved.Priorities["default"]; got != 10 {
		t.Fatalf("default priority = %d, want 10", got)
	}
	if got := resolved.Priorities["e2e"]; got != 0 {
		t.Fatalf("e2e default priority = %d, want 0", got)
	}
}

func TestOrchestratorConfigRejectsNegativeSchedulingPriority(t *testing.T) {
	body := strings.Replace(validOrchestratorYAML,
		"    runner_image: example/default:latest",
		"    runner_image: example/default:latest\n    priority: -1", 1)
	_, err := loadOrchestratorConfig(writeConfig(t, body))
	if err == nil || !strings.Contains(err.Error(), "priority must be at least 0") {
		t.Fatalf("load error = %v, want priority validation error", err)
	}
}

func TestLoadOrchestratorConfigRejectsDigestRunnerImage(t *testing.T) {
	body := strings.Replace(
		validOrchestratorYAML,
		"runner_image: example/default:latest",
		"runner_image: example/default@sha256:0123456789abcdef",
		1,
	)
	_, err := loadOrchestratorConfig(writeConfig(t, body))
	if err == nil || !strings.Contains(err.Error(), "must be a mutable tag") {
		t.Fatalf("digest runner image error = %v, want mutable-tag validation", err)
	}
}

func TestOrchestratorConfigResolvesMemorySafetyMargin(t *testing.T) {
	body := strings.Replace(validOrchestratorYAML, "  placement: {}", "  placement:\n    memory_safety_margin: 0.25", 1)
	resolved, err := loadOrchestratorConfig(writeConfig(t, body))
	if err != nil {
		t.Fatal(err)
	}
	if got := resolved.Raw.Fleet.Placement.MemorySafetyMargin; got != 0.25 {
		t.Fatalf("memory safety margin = %v, want 0.25", got)
	}
}

func TestOrchestratorConfigRejectsInvalidMemorySafetyMargin(t *testing.T) {
	for _, margin := range []string{"-0.1", "1", "1.1", ".nan", ".inf"} {
		body := strings.Replace(validOrchestratorYAML, "  placement: {}", "  placement:\n    memory_safety_margin: "+margin, 1)
		_, err := loadOrchestratorConfig(writeConfig(t, body))
		if err == nil || !strings.Contains(err.Error(), "memory_safety_margin") {
			t.Fatalf("margin %s error = %v, want memory_safety_margin complaint", margin, err)
		}
	}
}

func TestOrchestratorConfigDefaultsMemoryOvercommitToOne(t *testing.T) {
	resolved, err := loadOrchestratorConfig(writeConfig(t, validOrchestratorYAML))
	if err != nil {
		t.Fatal(err)
	}
	if got := resolved.MemoryOvercommit["janeway"]; got != 1.0 {
		t.Fatalf("memory_overcommit default = %v, want 1.0", got)
	}
}

func TestOrchestratorConfigResolvesMemoryOvercommit(t *testing.T) {
	body := strings.Replace(validOrchestratorYAML, "      runner_limit: 1", "      runner_limit: 1\n      memory_overcommit: 1.25", 1)
	resolved, err := loadOrchestratorConfig(writeConfig(t, body))
	if err != nil {
		t.Fatal(err)
	}
	if got := resolved.MemoryOvercommit["janeway"]; got != 1.25 {
		t.Fatalf("memory_overcommit = %v, want 1.25", got)
	}
}

// TestOrchestratorConfigRejectsInvalidMemoryOvercommit pins agent-lcars#1694's
// bound: 0.5 is below 1.0 (an overcommit factor may never REDUCE the
// budget), and 3.0 exceeds the 2.0 ceiling the fleet scheduler redesign
// approved (docs/fleet-scheduler-redesign.md#C).
func TestOrchestratorConfigRejectsInvalidMemoryOvercommit(t *testing.T) {
	for _, factor := range []string{"0.5", "3.0", "-1", ".nan", ".inf"} {
		body := strings.Replace(validOrchestratorYAML, "      runner_limit: 1", "      runner_limit: 1\n      memory_overcommit: "+factor, 1)
		_, err := loadOrchestratorConfig(writeConfig(t, body))
		if err == nil || !strings.Contains(err.Error(), "memory_overcommit") {
			t.Fatalf("memory_overcommit %s error = %v, want memory_overcommit complaint", factor, err)
		}
	}
}

// TestOrchestratorConfigDefaultsRunnerCgroupParent covers agent-lcars#1728:
// there is no fleet-named default, so omitting
// fleet.placement.runner_cgroup_parent entirely (the fixture's bare
// "placement: {}") resolves to "" -- the host-level slice bound is off by
// default, same as an explicit empty string.
func TestOrchestratorConfigDefaultsRunnerCgroupParent(t *testing.T) {
	resolved, err := loadOrchestratorConfig(writeConfig(t, validOrchestratorYAML))
	if err != nil {
		t.Fatal(err)
	}
	if got := resolved.RunnerCgroupParent; got != "" {
		t.Fatalf("runner cgroup parent = %q, want empty (no fleet-named default)", got)
	}
}

// TestOrchestratorConfigRunnerCgroupParentExplicitEmptyDisables covers the
// other half of the tri-state: an explicit empty string (as opposed to
// omitting the key) disables the host-level slice bound entirely.
func TestOrchestratorConfigRunnerCgroupParentExplicitEmptyDisables(t *testing.T) {
	body := strings.Replace(validOrchestratorYAML, "  placement: {}", "  placement:\n    runner_cgroup_parent: \"\"", 1)
	resolved, err := loadOrchestratorConfig(writeConfig(t, body))
	if err != nil {
		t.Fatal(err)
	}
	if got := resolved.RunnerCgroupParent; got != "" {
		t.Fatalf("runner cgroup parent = %q, want empty (disabled)", got)
	}
}

// TestOrchestratorConfigRunnerCgroupParentConfigured covers an explicit
// non-default slice name propagating through to the resolved config.
func TestOrchestratorConfigRunnerCgroupParentConfigured(t *testing.T) {
	body := strings.Replace(validOrchestratorYAML, "  placement: {}", "  placement:\n    runner_cgroup_parent: custom-runners.slice", 1)
	resolved, err := loadOrchestratorConfig(writeConfig(t, body))
	if err != nil {
		t.Fatal(err)
	}
	if got := resolved.RunnerCgroupParent; got != "custom-runners.slice" {
		t.Fatalf("runner cgroup parent = %q, want %q", got, "custom-runners.slice")
	}
}

// TestOrchestratorConfigRejectsInvalidRunnerCgroupParent covers the bare
// systemd slice name requirement -- no slashes, and it must end in
// ".slice" -- which is what Docker's systemd cgroup driver itself requires.
func TestOrchestratorConfigRejectsInvalidRunnerCgroupParent(t *testing.T) {
	for _, bad := range []string{"homelab-runners", "path/to.slice", "has space.slice", "semi;colon.slice"} {
		body := strings.Replace(validOrchestratorYAML, "  placement: {}", "  placement:\n    runner_cgroup_parent: \""+bad+"\"", 1)
		_, err := loadOrchestratorConfig(writeConfig(t, body))
		if err == nil || !strings.Contains(err.Error(), "runner_cgroup_parent") {
			t.Fatalf("runner_cgroup_parent %q error = %v, want runner_cgroup_parent complaint", bad, err)
		}
	}
}

// TestOrchestratorConfigDefaultsRoleToPermanent pins agent-lcars#1696's
// default: a host that sets no role: at all must resolve as permanent, so
// existing fleet.yml files with no role: lines keep counting fully toward
// lane_permanent_admissible_slots after this upgrade.
func TestOrchestratorConfigDefaultsRoleToPermanent(t *testing.T) {
	resolved, err := loadOrchestratorConfig(writeConfig(t, validOrchestratorYAML))
	if err != nil {
		t.Fatal(err)
	}
	if got := resolved.HostRoles["janeway"]; got != hostRolePermanent {
		t.Fatalf("host role default = %q, want %q", got, hostRolePermanent)
	}
}

func TestOrchestratorConfigResolvesRole(t *testing.T) {
	for _, role := range []string{hostRolePermanent, hostRoleOpportunistic, hostRoleMaintenance} {
		t.Run(role, func(t *testing.T) {
			body := strings.Replace(validOrchestratorYAML, "      runner_limit: 1", "      runner_limit: 1\n      role: "+role, 1)
			resolved, err := loadOrchestratorConfig(writeConfig(t, body))
			if err != nil {
				t.Fatal(err)
			}
			if got := resolved.HostRoles["janeway"]; got != role {
				t.Fatalf("host role = %q, want %q", got, role)
			}
		})
	}
}

// TestOrchestratorConfigRejectsInvalidRole pins the closed set of role
// values: anything else (a typo, an old/renamed role) must fail config load
// rather than silently defaulting to permanent or being ignored.
func TestOrchestratorConfigRejectsInvalidRole(t *testing.T) {
	body := strings.Replace(validOrchestratorYAML, "      runner_limit: 1", "      runner_limit: 1\n      role: retired", 1)
	_, err := loadOrchestratorConfig(writeConfig(t, body))
	if err == nil || !strings.Contains(err.Error(), "invalid role") {
		t.Fatalf("invalid role error = %v, want role validation error", err)
	}
}

func TestLoadOrchestratorConfigResolvesSSHMetrics(t *testing.T) {
	body := strings.Replace(validOrchestratorYAML, "docker: local", "docker: ssh://runner@janeway\n      metrics_via_ssh: true", 1)
	resolved, err := loadOrchestratorConfig(writeConfig(t, body))
	if err != nil {
		t.Fatal(err)
	}
	if !resolved.MetricsViaSSH["janeway"] {
		t.Fatalf("metrics_via_ssh was not resolved for janeway: %#v", resolved.MetricsViaSSH)
	}
}

func TestLoadOrchestratorConfigResolvesPerHostMetricsTimeout(t *testing.T) {
	body := strings.Replace(validOrchestratorYAML, "docker: local", "docker: local\n      metrics_timeout: 5s", 1)
	resolved, err := loadOrchestratorConfig(writeConfig(t, body))
	if err != nil {
		t.Fatal(err)
	}
	if got := resolved.HostMetricsTimeouts["janeway"]; got != 5*time.Second {
		t.Fatalf("metrics timeout = %v, want 5s", got)
	}
}

func TestOrchestratorConfigRejectsInvalidPerHostMetricsTimeout(t *testing.T) {
	for _, raw := range []string{"soon", "0s"} {
		body := strings.Replace(validOrchestratorYAML, "docker: local", "docker: local\n      metrics_timeout: "+raw, 1)
		_, err := loadOrchestratorConfig(writeConfig(t, body))
		if err == nil || !strings.Contains(err.Error(), "metrics_timeout") {
			t.Fatalf("metrics_timeout %q error = %v, want metrics_timeout complaint", raw, err)
		}
	}
}

func TestLoadOrchestratorConfigResolvesRequireReadiness(t *testing.T) {
	body := strings.Replace(validOrchestratorYAML, "      docker: local", "      docker: local\n      require_readiness: true", 1)
	body = strings.Replace(body, "  placement: {}", "  placement:\n    readiness_metrics_url: http://example.invalid/metrics\n    readiness_metric: host_ci_ready\n    readiness_max_age: 5m", 1)
	resolved, err := loadOrchestratorConfig(writeConfig(t, body))
	if err != nil {
		t.Fatal(err)
	}
	if !resolved.ReadinessRequired["janeway"] {
		t.Fatalf("require_readiness was not resolved for janeway: %#v", resolved.ReadinessRequired)
	}
	if resolved.ReadinessMaxAge != 5*time.Minute {
		t.Fatalf("readiness_max_age = %v, want 5m", resolved.ReadinessMaxAge)
	}
}

// A host gated on a signal nobody publishes would pass config validation and
// then silently never receive runners, because the gate is fail-closed. Fail
// at load instead, where the operator can still see it.
func TestOrchestratorConfigRejectsReadinessWithoutPublisher(t *testing.T) {
	tests := []struct {
		name      string
		placement string
		want      string
	}{
		{
			name:      "no url or metric",
			placement: "  placement: {}",
			want:      "readiness_metrics_url is required",
		},
		{
			name:      "url without metric",
			placement: "  placement:\n    readiness_metrics_url: http://example.invalid/metrics",
			want:      "readiness_metric is required",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			body := strings.Replace(validOrchestratorYAML, "      docker: local", "      docker: local\n      require_readiness: true", 1)
			body = strings.Replace(body, "  placement: {}", tt.placement, 1)
			_, err := loadOrchestratorConfig(writeConfig(t, body))
			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("loadOrchestratorConfig() error = %v, want %q", err, tt.want)
			}
		})
	}
}

func TestOrchestratorConfigRejectsInvalidReadinessMaxAge(t *testing.T) {
	body := strings.Replace(validOrchestratorYAML, "  placement: {}", "  placement:\n    readiness_max_age: soon", 1)
	_, err := loadOrchestratorConfig(writeConfig(t, body))
	if err == nil || !strings.Contains(err.Error(), "readiness_max_age") {
		t.Fatalf("loadOrchestratorConfig() error = %v, want a readiness_max_age complaint", err)
	}
}

// The gate is opt-in: a fleet that never mentions readiness must not acquire
// a new required-config burden.
func TestOrchestratorConfigAllowsReadinessConfigWithoutOptIn(t *testing.T) {
	if _, err := loadOrchestratorConfig(writeConfig(t, validOrchestratorYAML)); err != nil {
		t.Fatalf("unmodified config should still load: %v", err)
	}
}

func TestValidateReloadCompatibilityAcceptsLiveSettings(t *testing.T) {
	current, err := loadOrchestratorConfig(writeConfig(t, validOrchestratorYAML))
	if err != nil {
		t.Fatal(err)
	}
	nextBody := strings.Replace(validOrchestratorYAML, "max_runners: 2", "max_runners: 1", 1)
	nextBody = strings.Replace(nextBody, "runner_image: example/default:latest", "runner_image: example/default:next", 1)
	next, err := loadOrchestratorConfig(writeConfig(t, nextBody))
	if err != nil {
		t.Fatal(err)
	}
	if err := validateReloadCompatibility(current, next); err != nil {
		t.Fatalf("expected live settings to be reloadable: %v", err)
	}
}

func TestValidateReloadCompatibilityRejectsProcessLifetimeChanges(t *testing.T) {
	current, err := loadOrchestratorConfig(writeConfig(t, validOrchestratorYAML))
	if err != nil {
		t.Fatal(err)
	}
	e2eScaleSet := "\n  - name: e2e\n    labels: [e2e]\n    runner_image: example/e2e:latest\n    min_runners: 0\n    max_runners: 1\n"
	tests := []struct {
		name string
		body string
		want string
	}{
		{
			name: "metrics bind",
			body: strings.Replace(validOrchestratorYAML, "server:\n", "server:\n  metrics_addr: 0.0.0.0:8080\n", 1),
			want: "server.metrics_addr",
		},
		{
			name: "removed scale set",
			body: strings.Replace(strings.Replace(validOrchestratorYAML, e2eScaleSet, "\n", 1), "max_runners: 2", "max_runners: 1", 1),
			want: "cannot be removed",
		},
		{
			name: "changed host transport",
			body: strings.Replace(validOrchestratorYAML, "docker: local", "docker: ssh://runner@janeway", 1),
			want: "cannot change Docker transport",
		},
		{
			// The checkpoint store binds its path at startup, so accepting
			// this would send every later checkpoint to the OLD file while
			// the config claimed otherwise -- and a restart would adopt from
			// a path nothing had written since the reload.
			name: "changed checkpoint state path",
			body: strings.Replace(validOrchestratorYAML, "state_path: /var/lib/runner-autoscaler/state.json", "state_path: /var/lib/runner-autoscaler/moved.json", 1),
			want: "server.state_path",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			next, err := loadOrchestratorConfig(writeConfig(t, tt.body))
			if err != nil {
				t.Fatal(err)
			}
			err = validateReloadCompatibility(current, next)
			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("validateReloadCompatibility() error = %v, want %q", err, tt.want)
			}
		})
	}
}

func TestValidateReloadCompatibilityAllowsFleetHostChanges(t *testing.T) {
	current, err := loadOrchestratorConfig(writeConfig(t, validOrchestratorYAML))
	if err != nil {
		t.Fatal(err)
	}
	addedHost := `    - name: laforge
      docker: ssh://runner@laforge
`
	next, err := loadOrchestratorConfig(writeConfig(t, strings.Replace(validOrchestratorYAML, "  placement: {}\n", addedHost+"  placement: {}\n", 1)))
	if err != nil {
		t.Fatal(err)
	}
	if err := validateReloadCompatibility(current, next); err != nil {
		t.Fatalf("expected fleet host change to be reloadable: %v", err)
	}
}

func TestMergeDockerHostsRetainsOnlyTrackedRemovedHosts(t *testing.T) {
	current := []DockerHost{{Name: "janeway"}, {Name: "spark"}}
	next := []DockerHost{{Name: "laforge"}}
	merged := mergeDockerHosts(next, current, map[string]bool{"spark": true})
	if len(merged) != 2 || merged[0].Name != "laforge" || merged[1].Name != "spark" {
		t.Fatalf("merged hosts = %#v, want laforge plus tracked retired spark", merged)
	}
}

func TestFleetRunnerCountSumsAcrossScaleSets(t *testing.T) {
	runtimes := []*scaleSetRuntime{
		{scaler: &Scaler{runners: runnerState{idle: map[string]runnerRef{"a": {}}, busy: map[string]runnerRef{"b": {}}}}},
		{scaler: &Scaler{runners: runnerState{idle: map[string]runnerRef{}, busy: map[string]runnerRef{"c": {}}}}},
	}
	if got := fleetRunnerCount(runtimes); got != 3 {
		t.Fatalf("fleetRunnerCount = %d, want 3", got)
	}
}

func TestFleetAssignedJobsSumsAcrossScaleSets(t *testing.T) {
	runtimes := []*scaleSetRuntime{
		{scaler: &Scaler{}},
		{scaler: &Scaler{}},
	}
	runtimes[0].scaler.queuedJobs.Store(2)
	runtimes[1].scaler.queuedJobs.Store(5)
	if got := fleetAssignedJobs(runtimes); got != 7 {
		t.Fatalf("fleetAssignedJobs = %d, want 7", got)
	}
}

// TestBeginDrainFleetAcknowledgesEveryLaneDespiteOneSlowHost is the
// agent-lcars#1722 regression test: a SIGUSR1 drain must publish
// drainingGauge=1 for every scale set within roughly the time it takes to
// loop over them, not gated behind any one lane's idle-runner teardown.
// Before this fix, the SIGUSR1 handler called the combined BeginDrain (mark
// + remove idle runners) once per runtime in a single sequential loop, so a
// scale set with an unreachable Docker host stalled every LATER scale set's
// acknowledgement behind removeIdleRunnerTimeout/deregisterRunnerTimeout
// (15s each). Here the first lane's host never answers ContainerRemove at
// all, and the test still requires every lane's gauge to read 1 within
// 100ms of calling beginDrainFleet.
func TestBeginDrainFleetAcknowledgesEveryLaneDespiteOneSlowHost(t *testing.T) {
	f := newFakeDockerServer(t)
	unblock := f.blockRemoves()
	t.Cleanup(unblock)

	blockedScaler := &Scaler{
		scaleSetName: "blocked-lane",
		dockerHosts:  []DockerHost{{Name: "host-a", Client: f.client(t)}},
		runners: runnerState{
			idle: map[string]runnerRef{"idle": {host: "host-a", containerID: "i"}},
			busy: map[string]runnerRef{},
		},
		scalesetClient: newStubScalesetClient(t),
		logger:         slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	healthyScaler := &Scaler{
		scaleSetName: "healthy-lane",
		runners:      runnerState{idle: map[string]runnerRef{}, busy: map[string]runnerRef{}},
		logger:       slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	runtimes := []*scaleSetRuntime{
		{scaler: blockedScaler}, // listed FIRST: the pre-fix sequential loop would stall here
		{scaler: healthyScaler},
	}

	start := time.Now()
	beginDrainFleet(context.Background(), runtimes)
	if elapsed := time.Since(start); elapsed > 100*time.Millisecond {
		t.Fatalf("beginDrainFleet itself took %v, want well under 100ms (teardown must not run inline)", elapsed)
	}

	deadline := time.Now().Add(100 * time.Millisecond)
	for _, name := range []string{"blocked-lane", "healthy-lane"} {
		for {
			if testutil.ToFloat64(drainingGauge.WithLabelValues(name)) == 1 {
				break
			}
			if time.Now().After(deadline) {
				t.Fatalf("drainingGauge for %q not 1 within 100ms of the drain signal", name)
			}
			time.Sleep(time.Millisecond)
		}
	}
	if !blockedScaler.draining.Load() || !healthyScaler.draining.Load() {
		t.Fatal("both scale sets should be marked draining")
	}
}

func TestDrainWatchdogTick(t *testing.T) {
	t0 := time.Now()
	cases := []struct {
		name             string
		draining         bool
		fleetRunnerCount int
		zeroSince        time.Time
		now              time.Time
		wantZeroSince    time.Time
		wantSelfHeal     bool
	}{
		{
			name:             "not draining is always left alone",
			draining:         false,
			fleetRunnerCount: 0,
			zeroSince:        t0,
			now:              t0.Add(2 * drainStuckTimeout),
			wantZeroSince:    time.Time{},
			wantSelfHeal:     false,
		},
		{
			name:             "draining with runners resets the clock",
			draining:         true,
			fleetRunnerCount: 1,
			zeroSince:        t0,
			now:              t0.Add(2 * drainStuckTimeout),
			wantZeroSince:    time.Time{},
			wantSelfHeal:     false,
		},
		{
			name:             "first zero observation starts the clock without healing",
			draining:         true,
			fleetRunnerCount: 0,
			zeroSince:        time.Time{},
			now:              t0,
			wantZeroSince:    t0,
			wantSelfHeal:     false,
		},
		{
			name:             "zero but under the stuck timeout keeps waiting",
			draining:         true,
			fleetRunnerCount: 0,
			zeroSince:        t0,
			now:              t0.Add(drainStuckTimeout - time.Second),
			wantZeroSince:    t0,
			wantSelfHeal:     false,
		},
		{
			name:             "zero past the stuck timeout self-heals and resets the clock",
			draining:         true,
			fleetRunnerCount: 0,
			zeroSince:        t0,
			now:              t0.Add(drainStuckTimeout),
			wantZeroSince:    time.Time{},
			wantSelfHeal:     true,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			gotZeroSince, gotSelfHeal := drainWatchdogTick(tc.draining, tc.fleetRunnerCount, tc.zeroSince, tc.now)
			if !gotZeroSince.Equal(tc.wantZeroSince) {
				t.Errorf("zeroSince = %v, want %v", gotZeroSince, tc.wantZeroSince)
			}
			if gotSelfHeal != tc.wantSelfHeal {
				t.Errorf("selfHeal = %v, want %v", gotSelfHeal, tc.wantSelfHeal)
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

func TestOrchestratorConfigRejectsRetiredSharedWorkDirFields(t *testing.T) {
	tests := map[string]string{
		"scale set share_workdir": strings.Replace(validOrchestratorYAML, "    max_runners: 1\n", "    max_runners: 1\n    share_workdir: true\n", 1),
		"host workdir_size_cap":   strings.Replace(validOrchestratorYAML, "      runner_limit: 1\n", "      runner_limit: 1\n      workdir_size_cap: 30g\n", 1),
		"host pnpm_store_budget":  strings.Replace(validOrchestratorYAML, "      runner_limit: 1\n", "      runner_limit: 1\n      pnpm_store_budget: 10g\n", 1),
	}
	for name, body := range tests {
		t.Run(name, func(t *testing.T) {
			if _, err := loadOrchestratorConfig(writeConfig(t, body)); err == nil {
				t.Fatal("retired shared-workdir field was accepted")
			}
		})
	}
}

func TestOrchestratorConfigRejectsDuplicateLabel(t *testing.T) {
	body := strings.Replace(validOrchestratorYAML, "labels: [e2e]", "labels: [default]", 1)
	_, err := loadOrchestratorConfig(writeConfig(t, body))
	if err == nil || !strings.Contains(err.Error(), "label \"default\" is shared") {
		t.Fatalf("expected duplicate-label error, got %v", err)
	}
}

func TestOrchestratorConfigDefaultsMetricsAddrToLocalhost(t *testing.T) {
	resolved, err := loadOrchestratorConfig(writeConfig(t, validOrchestratorYAML))
	if err != nil {
		t.Fatal(err)
	}
	if got := resolved.Raw.Server.MetricsAddr; got != "127.0.0.1:8080" {
		t.Fatalf("metrics addr = %q, want 127.0.0.1:8080 (localhost-only default)", got)
	}
}

func TestOrchestratorConfigParsesPidsLimitAndShmSize(t *testing.T) {
	body := strings.Replace(validOrchestratorYAML,
		"    labels: [e2e]\n",
		"    labels: [e2e]\n    pids_limit: 8192\n    shm_size: 1g\n", 1)
	resolved, err := loadOrchestratorConfig(writeConfig(t, body))
	if err != nil {
		t.Fatal(err)
	}
	var e2e *Config
	for i := range resolved.ScaleSets {
		if resolved.ScaleSets[i].ScaleSetName == "e2e" {
			e2e = &resolved.ScaleSets[i]
		}
	}
	if e2e == nil {
		t.Fatal("e2e scale set not found in resolved config")
	}
	if e2e.RunnerPidsLimit != 8192 {
		t.Fatalf("RunnerPidsLimit = %d, want 8192", e2e.RunnerPidsLimit)
	}
	if e2e.RunnerShmSize != "1g" {
		t.Fatalf("RunnerShmSize = %q, want 1g", e2e.RunnerShmSize)
	}
}

func TestOrchestratorConfigRejectsNegativePidsLimit(t *testing.T) {
	body := strings.Replace(validOrchestratorYAML,
		"    labels: [e2e]\n",
		"    labels: [e2e]\n    pids_limit: -1\n", 1)
	_, err := loadOrchestratorConfig(writeConfig(t, body))
	if err == nil || !strings.Contains(err.Error(), "invalid pids_limit") {
		t.Fatalf("expected invalid pids_limit error, got %v", err)
	}
}

func TestOrchestratorConfigRejectsInvalidShmSize(t *testing.T) {
	body := strings.Replace(validOrchestratorYAML,
		"    labels: [e2e]\n",
		"    labels: [e2e]\n    shm_size: not-a-size\n", 1)
	_, err := loadOrchestratorConfig(writeConfig(t, body))
	if err == nil || !strings.Contains(err.Error(), "invalid shm_size") {
		t.Fatalf("expected invalid shm_size error, got %v", err)
	}
}

func TestLoadCredentials(t *testing.T) {
	resolved, err := loadOrchestratorConfig(writeConfig(t, validOrchestratorYAML))
	if err != nil {
		t.Fatal(err)
	}
	keyPath := filepath.Join(t.TempDir(), "app.pem")
	if err := os.WriteFile(keyPath, []byte("key"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("APP_CLIENT_ID", "client")
	t.Setenv("APP_INSTALLATION_ID", "42")
	t.Setenv("APP_PRIVATE_KEY_FILE", keyPath)
	if err := resolved.loadCredentials(); err != nil {
		t.Fatal(err)
	}
	for _, c := range resolved.ScaleSets {
		if c.GitHubApp.ClientID != "client" || c.GitHubApp.InstallationID != 42 || c.GitHubApp.PrivateKey != "key" {
			t.Fatalf("credentials not propagated to %q", c.ScaleSetName)
		}
		if c.RegistrationName != primaryRegistrationName {
			t.Fatalf("scale set %q registration = %q, want %q", c.ScaleSetName, c.RegistrationName, primaryRegistrationName)
		}
	}
}

// registrationYAML appends an additional homelab#97 registration, reusing
// the label "default" (allowed: label uniqueness is scoped per registration,
// matching GitHub's own per-account constraint) but a distinct scale-set
// name (required: names stay process-wide unique across every registration).
func registrationYAML(extra string) string {
	return validOrchestratorYAML + `registrations:
  - name: second
    github:
      url: https://github.com/example/other-repo
    app:
      client_id: second-client
      installation_id: 99
      private_key_file: ` + extra + `
    scale_sets:
      - name: second-default
        labels: [default]
        runner_image: example/second:latest
        min_runners: 0
        max_runners: 1
`
}

func TestLoadOrchestratorConfigWithAdditionalRegistration(t *testing.T) {
	keyPath := filepath.Join(t.TempDir(), "second-app.pem")
	if err := os.WriteFile(keyPath, []byte("second-key"), 0o600); err != nil {
		t.Fatal(err)
	}
	// fleet.max_runners must not exceed the aggregate across BOTH the
	// primary scale sets (2) and the new registration's (1).
	body := strings.Replace(registrationYAML(keyPath), "max_runners: 2\n", "max_runners: 3\n", 1)
	resolved, err := loadOrchestratorConfig(writeConfig(t, body))
	if err != nil {
		t.Fatal(err)
	}
	if len(resolved.ScaleSets) != 3 {
		t.Fatalf("resolved scale sets = %d, want 3: %#v", len(resolved.ScaleSets), resolved.ScaleSets)
	}
	var second Config
	found := false
	for _, c := range resolved.ScaleSets {
		if c.ScaleSetName == "second-default" {
			second, found = c, true
		}
	}
	if !found {
		t.Fatalf("second registration's scale set not resolved: %#v", resolved.ScaleSets)
	}
	if second.RegistrationName != "second" || second.RegistrationURL != "https://github.com/example/other-repo" {
		t.Fatalf("second scale set registration wiring wrong: %#v", second)
	}

	// The primary registration's scale sets must NOT pick up "second"'s
	// credentials (or vice versa) -- each registration's App auth stays
	// scoped to its own scale sets despite sharing one []Config slice.
	t.Setenv("APP_CLIENT_ID", "primary-client")
	t.Setenv("APP_INSTALLATION_ID", "42")
	primaryKeyPath := filepath.Join(t.TempDir(), "primary-app.pem")
	if err := os.WriteFile(primaryKeyPath, []byte("primary-key"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("APP_PRIVATE_KEY_FILE", primaryKeyPath)
	resolved, err = loadOrchestratorConfig(writeConfig(t, body))
	if err != nil {
		t.Fatal(err)
	}
	if err := resolved.loadCredentials(); err != nil {
		t.Fatal(err)
	}
	for _, c := range resolved.ScaleSets {
		switch c.RegistrationName {
		case primaryRegistrationName:
			if c.GitHubApp.ClientID != "primary-client" || c.GitHubApp.PrivateKey != "primary-key" {
				t.Fatalf("primary scale set %q got wrong credentials: %#v", c.ScaleSetName, c.GitHubApp)
			}
		case "second":
			if c.GitHubApp.ClientID != "second-client" || c.GitHubApp.InstallationID != 99 || c.GitHubApp.PrivateKey != "second-key" {
				t.Fatalf("registration \"second\" scale set %q got wrong credentials: %#v", c.ScaleSetName, c.GitHubApp)
			}
		default:
			t.Fatalf("unexpected registration name %q", c.RegistrationName)
		}
	}
}

func TestOrchestratorConfigRejectsDuplicateRegistrationName(t *testing.T) {
	// Append a SECOND "registrations:" list entry also named "second" --
	// still valid YAML (two items in one list), but resolve() must reject
	// the name collision.
	body := registrationYAML("/secrets/second.pem") + `  - name: second
    github:
      url: https://github.com/example/third-repo
    app:
      client_id: third-client
      installation_id: 100
      private_key_file: /secrets/third.pem
    scale_sets:
      - name: third-default
        labels: [third]
        runner_image: example/third:latest
        min_runners: 0
        max_runners: 1
`
	_, err := loadOrchestratorConfig(writeConfig(t, body))
	if err == nil || !strings.Contains(err.Error(), `duplicate registration name "second"`) {
		t.Fatalf("expected duplicate registration name error, got %v", err)
	}
}

func TestOrchestratorConfigRejectsReservedRegistrationName(t *testing.T) {
	body := strings.Replace(registrationYAML("/secrets/second.pem"), "name: second\n", "name: primary\n", 1)
	_, err := loadOrchestratorConfig(writeConfig(t, body))
	if err == nil || !strings.Contains(err.Error(), "is reserved") {
		t.Fatalf("expected reserved-name error, got %v", err)
	}
}

func TestOrchestratorConfigRejectsScaleSetNameCollisionAcrossRegistrations(t *testing.T) {
	body := strings.Replace(registrationYAML("/secrets/second.pem"), "name: second-default\n", "name: default\n", 1)
	_, err := loadOrchestratorConfig(writeConfig(t, body))
	if err == nil || !strings.Contains(err.Error(), `duplicate scale set "default"`) {
		t.Fatalf("expected process-wide scale-set-name collision error, got %v", err)
	}
}

func TestOrchestratorConfigRejectsIncompleteRegistrationApp(t *testing.T) {
	body := strings.Replace(registrationYAML("/secrets/second.pem"), "      installation_id: 99\n", "", 1)
	_, err := loadOrchestratorConfig(writeConfig(t, body))
	if err == nil || !strings.Contains(err.Error(), "app.installation_id must be a positive integer") {
		t.Fatalf("expected missing installation_id error, got %v", err)
	}
}

// The real orchestrator.yml now lives in jlapenna/homelab (this repo only
// owns the Go source), so the schema-drift check that used to load it
// directly here (`../orchestrator.yml`) moved with it: homelab's own deploy
// pipeline runs `runner-autoscaler --check-config` against the real file
// before restarting the live service, using the image this repo publishes.

func TestOrchestratorConfigDisabledRegistrationSkipsValidationAndCredentials(t *testing.T) {
	// A disabled registration keeps its real (obviously placeholder) shape in
	// the committed file -- including an installation_id of 0 and a
	// private_key_file that doesn't exist on disk -- without blocking
	// --check-config for every other registration in the same process.
	body := strings.Replace(registrationYAML("/secrets/does-not-exist.pem"), "installation_id: 99\n", "installation_id: 0\n", 1)
	body = strings.Replace(body, "    github:\n", "    disabled: true\n    github:\n", 1)
	resolved, err := loadOrchestratorConfig(writeConfig(t, body))
	if err != nil {
		t.Fatalf("disabled registration should not fail validation: %v", err)
	}
	if len(resolved.ScaleSets) != 2 {
		t.Fatalf("disabled registration's scale sets should not be resolved: %#v", resolved.ScaleSets)
	}
	t.Setenv("APP_CLIENT_ID", "primary-client")
	t.Setenv("APP_INSTALLATION_ID", "42")
	keyPath := filepath.Join(t.TempDir(), "primary-app.pem")
	if err := os.WriteFile(keyPath, []byte("primary-key"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("APP_PRIVATE_KEY_FILE", keyPath)
	if err := resolved.loadCredentials(); err != nil {
		t.Fatalf("disabled registration's missing private key should not be read: %v", err)
	}
}

// TestOrchestratorConfigRejectsAllDisabledRegistrations guards against
// runOrchestrator's resolved.ScaleSets[0] panicking on startup: a config
// with no primary scale_sets and only disabled registrations passes the
// raw "at least one of scale_sets or registrations must be set" check
// (registrations IS set) but must still fail validation once resolved,
// since it resolves to zero actual scale sets.
func TestOrchestratorConfigRejectsAllDisabledRegistrations(t *testing.T) {
	body := `
version: 1
server:
  state_path: /var/lib/runner-autoscaler/state.json
fleet:
  max_runners: 1
  hosts:
    - name: janeway
      docker: local
  placement: {}
registrations:
  - name: second
    disabled: true
    github:
      url: https://github.com/example/other-repo
    app:
      client_id: second-client
      installation_id: 0
      private_key_file: /secrets/does-not-exist.pem
    scale_sets:
      - name: second-default
        labels: [default]
        runner_image: example/second:latest
        min_runners: 0
        max_runners: 1
`
	_, err := loadOrchestratorConfig(writeConfig(t, body))
	if err == nil || !strings.Contains(err.Error(), "at least one enabled scale set is required") {
		t.Fatalf("expected 'at least one enabled scale set' error, got %v", err)
	}
}

func TestParseFileMounts(t *testing.T) {
	allow := []string{"/etc/buildkit"}
	for _, tc := range []struct {
		name    string
		raw     []string
		allow   []string
		wantErr string
	}{
		{name: "valid", raw: []string{"/etc/buildkit/client.pem:/secrets/client.pem"}, allow: allow},
		{name: "no allowlist", raw: []string{"/etc/buildkit/client.pem:/secrets/client.pem"}, allow: nil,
			wantErr: "fleet.file_mount_allowlist is empty"},
		{name: "outside allowlist", raw: []string{"/etc/other/client.pem:/secrets/client.pem"}, allow: allow,
			wantErr: "not under any fleet.file_mount_allowlist prefix"},
		// The whole point of the allowlist: a sibling directory whose name
		// merely starts with an allowed prefix must not match.
		{name: "prefix is not a path boundary", raw: []string{"/etc/buildkit-evil/x.pem:/secrets/x.pem"}, allow: allow,
			wantErr: "not under any fleet.file_mount_allowlist prefix"},
		// Without this, file_mounts would be a way to smuggle in the Docker
		// socket -- see dockerSocketPaths.
		{name: "docker socket rejected", raw: []string{"/var/run/docker.sock:/var/run/docker.sock"},
			allow: []string{"/var/run"}, wantErr: "is or contains the Docker socket"},
		{name: "traversal in source", raw: []string{"/etc/buildkit/../../root/.ssh/id_rsa:/secrets/k"}, allow: allow,
			wantErr: "must be absolute and already clean"},
		{name: "relative container path", raw: []string{"/etc/buildkit/client.pem:secrets/client.pem"}, allow: allow,
			wantErr: "must be absolute and already clean"},
		{name: "missing separator", raw: []string{"/etc/buildkit/client.pem"}, allow: allow,
			wantErr: `must be "hostPath:containerPath"`},
		{name: "duplicate target", allow: allow,
			raw:     []string{"/etc/buildkit/a.pem:/secrets/c.pem", "/etc/buildkit/b.pem:/secrets/c.pem"},
			wantErr: "more than once"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := parseFileMounts("lane", tc.raw, tc.allow)
			if tc.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
					t.Fatalf("err = %v, want containing %q", err, tc.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if len(got) != len(tc.raw) {
				t.Fatalf("got %d mounts, want %d", len(got), len(tc.raw))
			}
		})
	}
}

func TestOrchestratorConfigResolvesFileMounts(t *testing.T) {
	body := strings.Replace(validOrchestratorYAML, "  placement: {}\n",
		"  placement: {}\n  file_mount_allowlist: [/etc/buildkit]\n", 1)
	body = strings.Replace(body, "    labels: [e2e]\n",
		"    labels: [e2e]\n    file_mounts: [\"/etc/buildkit/client.pem:/secrets/client.pem\"]\n", 1)
	resolved, err := loadOrchestratorConfig(writeConfig(t, body))
	if err != nil {
		t.Fatal(err)
	}
	for _, s := range resolved.ScaleSets {
		if s.ScaleSetName != "e2e" {
			continue
		}
		if len(s.FileMounts) != 1 || s.FileMounts[0].ContainerPath != "/secrets/client.pem" {
			t.Fatalf("unexpected file mounts: %#v", s.FileMounts)
		}
		return
	}
	t.Fatal("scale set e2e not found")
}

func TestOrchestratorConfigFileMountsFailClosedWithoutAllowlist(t *testing.T) {
	body := strings.Replace(validOrchestratorYAML, "    labels: [e2e]\n",
		"    labels: [e2e]\n    file_mounts: [\"/etc/buildkit/client.pem:/secrets/client.pem\"]\n", 1)
	_, err := loadOrchestratorConfig(writeConfig(t, body))
	if err == nil || !strings.Contains(err.Error(), "fleet.file_mount_allowlist is empty") {
		t.Fatalf("expected fail-closed rejection, got %v", err)
	}
}

// TestParseFileMountsRejectsIndirectDockerSocket covers the ways a literal
// equality check against /var/run/docker.sock can be walked around: the
// containing directory (read-only does not stop a connect(2) to a socket
// inside it) and the /run spelling, since /var/run is a symlink to /run on
// systemd hosts.
func TestParseFileMountsRejectsIndirectDockerSocket(t *testing.T) {
	for _, src := range []string{
		"/var/run/docker.sock",
		"/run/docker.sock",
		"/var/run",
		"/run",
		"/var",
		"/",
	} {
		t.Run(src, func(t *testing.T) {
			// Allowlist the source itself, so only the socket guard can reject it.
			_, err := parseFileMounts("lane", []string{src + ":/host-run"}, []string{src})
			if err == nil || !strings.Contains(err.Error(), "Docker socket") {
				t.Fatalf("source %q: err = %v, want Docker socket rejection", src, err)
			}
		})
	}
}

func TestValidateFileMountAllowlist(t *testing.T) {
	for _, tc := range []struct{ name, entry, wantErr string }{
		{name: "valid", entry: "/etc/buildkit-client"},
		// Cleaning this instead of rejecting it would silently widen the
		// privilege boundary from one directory to all of /etc.
		{name: "unclean widens scope", entry: "/etc/buildkit-client/..", wantErr: "absolute and already clean"},
		{name: "relative", entry: "etc/buildkit-client", wantErr: "absolute and already clean"},
		{name: "trailing slash", entry: "/etc/buildkit-client/", wantErr: "absolute and already clean"},
		{name: "socket dir", entry: "/var/run", wantErr: "contains the Docker socket"},
		{name: "run dir", entry: "/run", wantErr: "contains the Docker socket"},
		{name: "root", entry: "/", wantErr: "contains the Docker socket"},
		{name: "socket itself", entry: "/var/run/docker.sock", wantErr: "contains the Docker socket"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := validateFileMountAllowlist([]string{tc.entry})
			if tc.wantErr == "" {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("err = %v, want containing %q", err, tc.wantErr)
			}
		})
	}
}

// The allowlist is the privilege boundary, so a bad entry must fail the
// config even when nothing references it yet.
func TestOrchestratorConfigRejectsBadAllowlistWithoutAnyFileMounts(t *testing.T) {
	body := strings.Replace(validOrchestratorYAML, "  placement: {}\n",
		"  placement: {}\n  file_mount_allowlist: [/var/run]\n", 1)
	_, err := loadOrchestratorConfig(writeConfig(t, body))
	if err == nil || !strings.Contains(err.Error(), "contains the Docker socket") {
		t.Fatalf("expected allowlist rejection, got %v", err)
	}
}

// buildOrchestratorRuntimes -> buildScaleSetRuntime -> Scaler is the seam that
// carries fleet.placement settings into the object that actually reads them.
// It had no coverage, and a field that stopped at Config was silently dropped
// there: the readiness gate parsed, validated, passed --check-config, and then
// did nothing, because hostReady saw an empty URL and refused every host it
// was asked about. Assert the whole copied block, not just one field, so the
// next addition that forgets this line fails here instead of in production.
func TestBuildOrchestratorRuntimesCarriesPlacementConfigIntoScaler(t *testing.T) {
	body := strings.Replace(validOrchestratorYAML, "      docker: local",
		"      docker: local\n      metrics_timeout: 5s\n      require_readiness: true\n      inference_metrics_url: http://janeway.example.invalid:8000/metrics", 1)
	body = strings.Replace(body, "  placement: {}", `  placement:
    host_metrics_url_template: http://%s.example.invalid:9100/metrics
    readiness_metrics_url: http://readiness.example.invalid/metrics
    readiness_metric: host_ci_ready
    readiness_max_age: 5m`, 1)
	body = strings.Replace(body, "    readiness_max_age: 5m", "    readiness_max_age: 5m\n    memory_safety_margin: 0.25", 1)

	resolved, err := loadOrchestratorConfig(writeConfig(t, body))
	if err != nil {
		t.Fatal(err)
	}

	// buildScaleSetRuntime runs Config.Validate, which insists on credentials.
	// They are irrelevant to the wiring under test, so supply a placeholder
	// token rather than reaching for real ones.
	for i := range resolved.ScaleSets {
		resolved.ScaleSets[i].Token = "placeholder-not-a-real-token"
	}

	hosts := []DockerHost{{Name: "janeway"}}
	fleet := newFleetCoordinator(resolved.Raw.Fleet.MaxRunners, resolved.RunnerLimits, resolved.Weights, resolved.Priorities, nil)
	runtimes, err := buildOrchestratorRuntimes(resolved, hosts, hosts, fleet, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(runtimes) == 0 {
		t.Fatal("expected at least one scale-set runtime")
	}

	for _, rt := range runtimes {
		s := rt.scaler
		if s.readinessMetricsURL != "http://readiness.example.invalid/metrics" {
			t.Errorf("scale set %q: readinessMetricsURL = %q, want it carried through from fleet.placement", s.scaleSetName, s.readinessMetricsURL)
		}
		if s.readinessMetric != "host_ci_ready" {
			t.Errorf("scale set %q: readinessMetric = %q, want host_ci_ready", s.scaleSetName, s.readinessMetric)
		}
		if s.readinessMaxAge != 5*time.Minute {
			t.Errorf("scale set %q: readinessMaxAge = %v, want 5m", s.scaleSetName, s.readinessMaxAge)
		}
		// Neighbours in the same copied block, so this test guards the whole
		// hand-off rather than only the field that broke.
		if got := s.inferenceMetricsURLs["janeway"]; got != "http://janeway.example.invalid:8000/metrics" {
			t.Errorf("scale set %q: inferenceMetricsURLs[janeway] = %q", s.scaleSetName, got)
		}
		if s.hostMetricsURLTemplate != "http://%s.example.invalid:9100/metrics" {
			t.Errorf("scale set %q: hostMetricsURLTemplate = %q", s.scaleSetName, s.hostMetricsURLTemplate)
		}
		if got := s.hostMetricsTimeouts["janeway"]; got != 5*time.Second {
			t.Errorf("scale set %q: metrics timeout = %v, want 5s", s.scaleSetName, got)
		}
		if got := s.memorySafetyMargin; got != 0.25 {
			t.Errorf("scale set %q: memorySafetyMargin = %v, want 0.25", s.scaleSetName, got)
		}
	}

	// And the per-host opt-in must reach the coordinator the gate consults.
	configureFleet(fleet, resolved)
	if !fleet.readinessRequired["janeway"] {
		t.Errorf("readinessRequired not propagated to the coordinator: %#v", fleet.readinessRequired)
	}
}

func TestOrchestratorConfigResolvesRunnerMemoryReservation(t *testing.T) {
	body := strings.Replace(validOrchestratorYAML, "  - name: default\n    labels: [default]\n", "  - name: default\n    labels: [default]\n    runner_memory: 14g\n    runner_memory_reservation: 8g\n", 1)
	resolved, err := loadOrchestratorConfig(writeConfig(t, body))
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range resolved.ScaleSets {
		if c.ScaleSetName == "default" {
			if c.RunnerMemory != "14g" || c.RunnerMemoryReservation != "8g" {
				t.Fatalf("default scale set memory = (%q, %q), want (14g, 8g)", c.RunnerMemory, c.RunnerMemoryReservation)
			}
			return
		}
	}
	t.Fatal("default scale set not resolved")
}

func TestOrchestratorConfigRejectsBadRunnerMemoryReservation(t *testing.T) {
	cases := map[string]string{
		"exceeds ceiling": "    runner_memory: 14g\n    runner_memory_reservation: 16g\n",
		"without ceiling": "    runner_memory_reservation: 8g\n",
		"unparseable":     "    runner_memory: 14g\n    runner_memory_reservation: lots\n",
		"zero":            "    runner_memory: 14g\n    runner_memory_reservation: 0\n",
	}
	for name, extra := range cases {
		body := strings.Replace(validOrchestratorYAML, "  - name: default\n    labels: [default]\n", "  - name: default\n    labels: [default]\n"+extra, 1)
		_, err := loadOrchestratorConfig(writeConfig(t, body))
		if err == nil || !strings.Contains(err.Error(), "runner_memory_reservation") {
			t.Fatalf("%s: error = %v, want runner_memory_reservation complaint", name, err)
		}
	}
}

// TestDegradationLadderConfigDefaults pins agent-lcars#1697's documented
// defaults for an omitted fleet.placement.degradation_ladder block: off,
// with the window/quantile/query/refresh_interval defaults that make an
// operator's later opt-in ("enabled: true") behave sensibly with no other
// keys set.
func TestDegradationLadderConfigDefaults(t *testing.T) {
	resolved, err := loadOrchestratorConfig(writeConfig(t, validOrchestratorYAML))
	if err != nil {
		t.Fatal(err)
	}
	dl := resolved.DegradationLadder
	if dl.Enabled {
		t.Error("degradation_ladder.enabled defaulted to true, want false")
	}
	if dl.PrometheusURL != "" {
		t.Errorf("prometheus_url defaulted to %q, want empty", dl.PrometheusURL)
	}
	if dl.Window != "168h" {
		t.Errorf("observed_window default = %q, want 168h", dl.Window)
	}
	if dl.Quantile != 0.95 {
		t.Errorf("observed_quantile default = %v, want 0.95", dl.Quantile)
	}
	if dl.RefreshInterval != 10*time.Minute {
		t.Errorf("refresh_interval default = %v, want 10m", dl.RefreshInterval)
	}
	if dl.MaxSampleAge != 30*time.Minute {
		t.Errorf("MaxSampleAge = %v, want 3x the 10m default refresh_interval (30m)", dl.MaxSampleAge)
	}
	for _, c := range resolved.ScaleSets {
		if c.DegradationLadderEnabled {
			t.Errorf("scale set %q defaulted to ladder-enabled, want false", c.ScaleSetName)
		}
	}
	rendered, err := dl.render("default")
	if err != nil {
		t.Fatalf("render() error = %v", err)
	}
	want := `quantile(0.95, max_over_time(container_memory_rss{container_label_autoscaler_scale_set="default"}[168h]))`
	if rendered != want {
		t.Errorf("default observed_query rendered = %q, want %q", rendered, want)
	}
}

func degradationLadderYAML(placementBlock string) string {
	return strings.Replace(validOrchestratorYAML, "  placement: {}", "  placement:\n"+placementBlock, 1)
}

// TestDegradationLadderConfigGlobalEnableAppliesToAllLanes pins the "global
// enabled with no per-lane override" precedence rule.
func TestDegradationLadderConfigGlobalEnableAppliesToAllLanes(t *testing.T) {
	body := degradationLadderYAML("    degradation_ladder:\n      enabled: true\n      prometheus_url: http://prometheus:9090\n")
	resolved, err := loadOrchestratorConfig(writeConfig(t, body))
	if err != nil {
		t.Fatal(err)
	}
	if !resolved.DegradationLadder.Enabled {
		t.Error("resolved.DegradationLadder.Enabled = false, want true")
	}
	if resolved.DegradationLadder.PrometheusURL != "http://prometheus:9090" {
		t.Errorf("prometheus_url = %q, want http://prometheus:9090", resolved.DegradationLadder.PrometheusURL)
	}
	for _, c := range resolved.ScaleSets {
		if !c.DegradationLadderEnabled {
			t.Errorf("scale set %q DegradationLadderEnabled = false, want true (fleet-wide default)", c.ScaleSetName)
		}
	}
}

// TestDegradationLadderConfigPerLaneOverridePrecedence pins agent-lcars#1697's
// override rule both ways: an explicit false wins over a true fleet default,
// and an explicit true wins over a false (the default) fleet default. Also
// exercises registrations[].scale_sets[], not just the top-level list.
func TestDegradationLadderConfigPerLaneOverridePrecedence(t *testing.T) {
	// Global default on; "default" opts out, "e2e" inherits it.
	body := degradationLadderYAML("    degradation_ladder:\n      enabled: true\n")
	body = strings.Replace(body, "  - name: default\n    labels: [default]\n",
		"  - name: default\n    labels: [default]\n    degradation_ladder: false\n", 1)
	resolved, err := loadOrchestratorConfig(writeConfig(t, body))
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, c := range resolved.ScaleSets {
		got[c.ScaleSetName] = c.DegradationLadderEnabled
	}
	if got["default"] {
		t.Error(`scale set "default" DegradationLadderEnabled = true, want false (explicit override)`)
	}
	if !got["e2e"] {
		t.Error(`scale set "e2e" DegradationLadderEnabled = false, want true (inherits the fleet default)`)
	}

	// Global default off (the base config); an additional registration's
	// lane opts in explicitly while its sibling in the same registration
	// does not.
	keyPath := filepath.Join(t.TempDir(), "third-app.pem")
	if err := os.WriteFile(keyPath, []byte("key"), 0o600); err != nil {
		t.Fatal(err)
	}
	regBody := strings.Replace(validOrchestratorYAML, "max_runners: 2\n", "max_runners: 4\n", 1) + `registrations:
  - name: third
    github:
      url: https://github.com/example/third-repo
    app:
      client_id: third-client
      installation_id: 7
      private_key_file: ` + keyPath + `
    scale_sets:
      - name: third-ladder
        labels: [third-ladder]
        runner_image: example/third:latest
        min_runners: 0
        max_runners: 1
        degradation_ladder: true
      - name: third-plain
        labels: [third-plain]
        runner_image: example/third:latest
        min_runners: 0
        max_runners: 1
`
	resolved, err = loadOrchestratorConfig(writeConfig(t, regBody))
	if err != nil {
		t.Fatal(err)
	}
	got = map[string]bool{}
	for _, c := range resolved.ScaleSets {
		got[c.ScaleSetName] = c.DegradationLadderEnabled
	}
	if !got["third-ladder"] {
		t.Error(`registrations[].scale_sets[] "third-ladder" DegradationLadderEnabled = false, want true (explicit override)`)
	}
	if got["third-plain"] {
		t.Error(`registrations[].scale_sets[] "third-plain" DegradationLadderEnabled = true, want false (no override, fleet default off)`)
	}
}

func TestDegradationLadderConfigValidatesQuantile(t *testing.T) {
	cases := []string{"1.5", "-0.2"}
	for _, quantile := range cases {
		body := degradationLadderYAML("    degradation_ladder:\n      observed_quantile: " + quantile + "\n")
		_, err := loadOrchestratorConfig(writeConfig(t, body))
		if err == nil || !strings.Contains(err.Error(), "observed_quantile") {
			t.Fatalf("quantile %s: error = %v, want observed_quantile complaint", quantile, err)
		}
	}
}

func TestDegradationLadderConfigValidatesObservedWindow(t *testing.T) {
	cases := []string{"not-a-duration", "-1h", "0h"}
	for _, window := range cases {
		body := degradationLadderYAML("    degradation_ladder:\n      observed_window: \"" + window + "\"\n")
		_, err := loadOrchestratorConfig(writeConfig(t, body))
		if err == nil || !strings.Contains(err.Error(), "observed_window") {
			t.Fatalf("window %q: error = %v, want observed_window complaint", window, err)
		}
	}
}

func TestDegradationLadderConfigValidatesRefreshInterval(t *testing.T) {
	cases := []string{"not-a-duration", "-5m", "0m"}
	for _, interval := range cases {
		body := degradationLadderYAML("    degradation_ladder:\n      refresh_interval: \"" + interval + "\"\n")
		_, err := loadOrchestratorConfig(writeConfig(t, body))
		if err == nil || !strings.Contains(err.Error(), "refresh_interval") {
			t.Fatalf("interval %q: error = %v, want refresh_interval complaint", interval, err)
		}
	}
}

func TestDegradationLadderConfigValidatesPrometheusURL(t *testing.T) {
	body := degradationLadderYAML("    degradation_ladder:\n      prometheus_url: \"not-a-url\"\n")
	_, err := loadOrchestratorConfig(writeConfig(t, body))
	if err == nil || !strings.Contains(err.Error(), "prometheus_url") {
		t.Fatalf("error = %v, want prometheus_url complaint", err)
	}
}

func TestDegradationLadderConfigValidatesObservedQueryTemplate(t *testing.T) {
	body := degradationLadderYAML("    degradation_ladder:\n      observed_query: \"{{.Bogus\"\n")
	_, err := loadOrchestratorConfig(writeConfig(t, body))
	if err == nil || !strings.Contains(err.Error(), "observed_query") {
		t.Fatalf("error = %v, want observed_query complaint", err)
	}
}

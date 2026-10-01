package main

import (
	"bytes"
	"fmt"
	"os"
	"strings"

	yaml "go.yaml.in/yaml/v3"
)

// OrchestratorConfig is the configuration surface for the LCARS queue
// executor: which Docker hosts it may launch direct runners on, plus server
// basics (metrics bind, log level/format).
//
// GitHub, Registrations, and ScaleSets are retired scale-set runner
// management (homelab#1623 Phase 3 deleted that code; see
// apps/runner-autoscaler/README.md). They are decoded into `any` -- not
// removed from the struct -- purely so the still-live homelab
// orchestrator.yml (which has not yet had its own follow-up cleanup PR, see
// that file's own retirement notes) keeps parsing under this decoder's
// KnownFields(true) instead of refusing to start. resolve's legacyWarnings
// logs a warning naming every ignored section so the file's dead weight is
// visible rather than silent; nothing under them is read.
type OrchestratorConfig struct {
	Version int                `yaml:"version"`
	Server  OrchestratorServer `yaml:"server"`
	Fleet   OrchestratorFleet  `yaml:"fleet"`

	GitHubLegacy        any `yaml:"github,omitempty"`
	RegistrationsLegacy any `yaml:"registrations,omitempty"`
	ScaleSetsLegacy     any `yaml:"scale_sets,omitempty"`
}

type OrchestratorServer struct {
	MetricsAddr string `yaml:"metrics_addr,omitempty"`
	LogLevel    string `yaml:"log_level,omitempty"`
	LogFormat   string `yaml:"log_format,omitempty"`

	// StatePathLegacy was the scale-set control plane's checkpoint file
	// (homelab#487). The queue executor's own restart story is a Docker-label
	// scan (queue_recovery.go's recoverCreatedDirectRunners), which needs no
	// checkpoint, so this is retired along with the rest of the scale-set
	// runtime -- see this file's package doc.
	StatePathLegacy string `yaml:"state_path,omitempty"`
}

type OrchestratorFleet struct {
	// Hosts is the only part of fleet.* the queue executor actually reads
	// (via resolvedOrchestratorConfig.DockerHosts): the host name and Docker
	// transport (newDockerClient's "local" / "ssh://..." target), nothing
	// else. direct_runner_preflight.go's own preflight -- not any of the
	// legacy per-host keys below -- decides which configured hosts are
	// actually eligible to launch a direct runner.
	Hosts []FleetHostConfig `yaml:"hosts"`

	MaxRunnersLegacy         any `yaml:"max_runners,omitempty"`
	PlacementLegacy          any `yaml:"placement,omitempty"`
	FileMountAllowlistLegacy any `yaml:"file_mount_allowlist,omitempty"`
}

type FleetHostConfig struct {
	Name   string `yaml:"name"`
	Docker string `yaml:"docker"`

	// Legacy scale-set placement knobs (fleet-wide scheduling: runner limits,
	// readiness/role gating, memory/inference load awareness) -- retired by
	// homelab#1623 Phase 3 along with the Scaler that read them. See this
	// file's package doc for why they are decoded rather than removed.
	RequireMainsLegacy        bool    `yaml:"require_mains,omitempty"`
	MetricsViaSSHLegacy       bool    `yaml:"metrics_via_ssh,omitempty"`
	MetricsTimeoutLegacy      string  `yaml:"metrics_timeout,omitempty"`
	RequireReadinessLegacy    bool    `yaml:"require_readiness,omitempty"`
	RunnerLimitLegacy         *int    `yaml:"runner_limit,omitempty"`
	MemoryOvercommitLegacy    float64 `yaml:"memory_overcommit,omitempty"`
	MemorySafetyMarginLegacy  float64 `yaml:"memory_safety_margin,omitempty"`
	RoleLegacy                string  `yaml:"role,omitempty"`
	InferenceMetricsURLLegacy string  `yaml:"inference_metrics_url,omitempty"`
	InferenceIdleWattsLegacy  float64 `yaml:"inference_idle_watts,omitempty"`
}

// hasLegacyFields reports whether any retired per-host scale-set placement
// key is set on this host entry.
func (h FleetHostConfig) hasLegacyFields() bool {
	return h.RequireMainsLegacy || h.MetricsViaSSHLegacy || h.MetricsTimeoutLegacy != "" ||
		h.RequireReadinessLegacy || h.RunnerLimitLegacy != nil || h.MemoryOvercommitLegacy != 0 ||
		h.MemorySafetyMarginLegacy != 0 || h.RoleLegacy != "" || h.InferenceMetricsURLLegacy != "" ||
		h.InferenceIdleWattsLegacy != 0
}

type resolvedOrchestratorConfig struct {
	Raw OrchestratorConfig
	// DockerHosts is every configured fleet.hosts[] entry rendered as
	// "name=target", the shape ParseDockerHosts/newDockerClient consume. This
	// is the one piece of fleet config the queue executor actually uses.
	DockerHosts []string
	// Warnings collects non-fatal compatibility notices produced while
	// resolving the config (today: retired sections the file still carries),
	// surfaced by the caller (which holds the logger resolve itself does not)
	// once loadOrchestratorConfig returns successfully.
	Warnings []string
}

func loadOrchestratorConfig(path string) (resolvedOrchestratorConfig, error) {
	var out resolvedOrchestratorConfig
	b, err := os.ReadFile(path)
	if err != nil {
		return out, fmt.Errorf("reading orchestrator config %q: %w", path, err)
	}
	dec := yaml.NewDecoder(bytes.NewReader(b))
	dec.KnownFields(true)
	if err := dec.Decode(&out.Raw); err != nil {
		return out, fmt.Errorf("parsing orchestrator config %q: %w", path, err)
	}
	if err := out.resolve(); err != nil {
		return out, fmt.Errorf("invalid orchestrator config %q: %w", path, err)
	}
	return out, nil
}

func (r *resolvedOrchestratorConfig) resolve() error {
	c := &r.Raw
	if c.Version != 1 {
		return fmt.Errorf("version must be 1")
	}
	if c.Server.MetricsAddr == "" {
		// Localhost-only by default: /metrics, /healthz, /readyz carry no
		// secrets but do disclose fleet topology with no auth. A deployment
		// that wants external scraping must opt in explicitly via
		// server.metrics_addr (e.g. "0.0.0.0:8080").
		c.Server.MetricsAddr = "127.0.0.1:8080"
	}
	if c.Server.LogLevel == "" {
		c.Server.LogLevel = "info"
	}
	if c.Server.LogFormat == "" {
		c.Server.LogFormat = "text"
	}
	if len(c.Fleet.Hosts) == 0 {
		return fmt.Errorf("fleet.hosts must not be empty")
	}

	seenHosts := map[string]bool{}
	for i, h := range c.Fleet.Hosts {
		name, docker := strings.TrimSpace(h.Name), strings.TrimSpace(h.Docker)
		if name == "" || docker == "" {
			return fmt.Errorf("fleet.hosts[%d] requires name and docker", i)
		}
		if seenHosts[name] {
			return fmt.Errorf("duplicate fleet host %q", name)
		}
		seenHosts[name] = true
		r.DockerHosts = append(r.DockerHosts, name+"="+docker)
	}

	r.Warnings = append(r.Warnings, legacyConfigWarnings(c)...)
	return nil
}

// legacyConfigWarnings names every retired scale-set section this config
// still carries, so an operator sees the dead weight in the logs instead of
// it just silently decoding into nothing. It never fails resolve: a
// still-live orchestrator.yml predating its own cleanup PR must keep
// starting the queue executor.
func legacyConfigWarnings(c *OrchestratorConfig) []string {
	var ignored []string
	if c.GitHubLegacy != nil {
		ignored = append(ignored, "github")
	}
	if c.RegistrationsLegacy != nil {
		ignored = append(ignored, "registrations")
	}
	if c.ScaleSetsLegacy != nil {
		ignored = append(ignored, "scale_sets")
	}
	if c.Fleet.MaxRunnersLegacy != nil {
		ignored = append(ignored, "fleet.max_runners")
	}
	if c.Fleet.PlacementLegacy != nil {
		ignored = append(ignored, "fleet.placement")
	}
	if c.Fleet.FileMountAllowlistLegacy != nil {
		ignored = append(ignored, "fleet.file_mount_allowlist")
	}
	if c.Server.StatePathLegacy != "" {
		ignored = append(ignored, "server.state_path")
	}
	for _, h := range c.Fleet.Hosts {
		if h.hasLegacyFields() {
			ignored = append(ignored, "fleet.hosts[].{require_mains,require_readiness,metrics_via_ssh,metrics_timeout,runner_limit,memory_overcommit,memory_safety_margin,role,inference_metrics_url,inference_idle_watts}")
			break
		}
	}
	if len(ignored) == 0 {
		return nil
	}
	return []string{"orchestrator config contains retired scale-set runner management sections, accepted but ignored (homelab#1623 Phase 3 retired that code; a follow-up change should remove them from the file): " + strings.Join(ignored, ", ")}
}

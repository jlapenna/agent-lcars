package main

import (
	"bytes"
	"fmt"
	"os"
	"strings"

	yaml "go.yaml.in/yaml/v3"
)

// OrchestratorConfig is the configuration surface for the LCARS queue
// executor: the Kubernetes Job backend it launches direct runners through,
// the ARC lanes it reports status for, and server basics (metrics bind, log
// level/format).
//
// The retired fields below are decoded (as raw nodes, so even an empty
// `fleet:` counts as present) only so loadOrchestratorConfig can
// reject them with an error naming the key, instead of the YAML decoder's
// bare "field not found". Nothing reads them: the scale-set runner manager
// (github, registrations, scale_sets, server.state_path) was retired by
// homelab#1623 Phase 3, and the Docker execution backend (every fleet.* key:
// SSH/Docker host inventory, per-host readiness gates, and the scale-set
// placement knobs) was removed once Kubernetes Jobs became the only backend.
type OrchestratorConfig struct {
	Version    int                    `yaml:"version"`
	Server     OrchestratorServer     `yaml:"server"`
	ARCLanes   []arcLaneConfig        `yaml:"arc_lanes,omitempty"`
	Kubernetes *queueKubernetesConfig `yaml:"kubernetes,omitempty"`

	FleetRetired         yaml.Node `yaml:"fleet,omitempty"`
	GitHubRetired        yaml.Node `yaml:"github,omitempty"`
	RegistrationsRetired yaml.Node `yaml:"registrations,omitempty"`
	ScaleSetsRetired     yaml.Node `yaml:"scale_sets,omitempty"`
}

type OrchestratorServer struct {
	MetricsAddr string `yaml:"metrics_addr,omitempty"`
	LogLevel    string `yaml:"log_level,omitempty"`
	LogFormat   string `yaml:"log_format,omitempty"`

	// StatePathRetired was the scale-set control plane's checkpoint file
	// (homelab#487); see OrchestratorConfig's retired fields.
	StatePathRetired yaml.Node `yaml:"state_path,omitempty"`
}

type resolvedOrchestratorConfig struct {
	Raw OrchestratorConfig
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
	if retired := retiredConfigKeys(c); len(retired) > 0 {
		return fmt.Errorf("retired keys are no longer accepted; delete them: %s (the Docker execution backend and the scale-set runner manager were removed; kubernetes is the only queue backend)", strings.Join(retired, ", "))
	}
	if err := validateARCLanes(c.ARCLanes); err != nil {
		return err
	}
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
	if c.Kubernetes == nil {
		return fmt.Errorf("kubernetes is required: it is the queue executor's only backend")
	}
	return c.Kubernetes.validate()
}

// retiredConfigKeys names every removed top-level or server key the file
// still sets.
func retiredConfigKeys(c *OrchestratorConfig) []string {
	var retired []string
	for _, key := range []struct {
		name string
		set  bool
	}{
		{"fleet", c.FleetRetired.Kind != 0},
		{"github", c.GitHubRetired.Kind != 0},
		{"registrations", c.RegistrationsRetired.Kind != 0},
		{"scale_sets", c.ScaleSetsRetired.Kind != 0},
		{"server.state_path", c.Server.StatePathRetired.Kind != 0},
	} {
		if key.set {
			retired = append(retired, key.name)
		}
	}
	return retired
}

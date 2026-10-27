package main

import (
	"bytes"
	"fmt"
	"os"

	yaml "go.yaml.in/yaml/v3"
)

// OrchestratorConfig is the configuration surface for the LCARS queue
// executor: the Kubernetes Job backend it launches direct runners through,
// the ARC lanes it reports status for, and server basics (metrics bind, log
// level/format). The decoder's KnownFields(true) rejects every other key,
// including the retired scale-set manager and Docker backend keys.
type OrchestratorConfig struct {
	Version    int                    `yaml:"version"`
	Server     OrchestratorServer     `yaml:"server"`
	ARCLanes   []arcLaneConfig        `yaml:"arc_lanes,omitempty"`
	Kubernetes *queueKubernetesConfig `yaml:"kubernetes,omitempty"`
}

type OrchestratorServer struct {
	MetricsAddr string `yaml:"metrics_addr,omitempty"`
	LogLevel    string `yaml:"log_level,omitempty"`
	LogFormat   string `yaml:"log_format,omitempty"`
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

package main

import (
	"fmt"
	"log/slog"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/actions/scaleset"
)

// primaryRegistrationName identifies the scale sets declared in
// orchestrator.yml's top-level github/scale_sets blocks (homelab#97): the
// original, single-GitHub-account shape that predates the registrations:
// list below. It is reserved -- a named entry in registrations: may not
// reuse it -- so every scale set's RegistrationName is always unambiguous
// in logs, metrics, and container labels.
const primaryRegistrationName = "primary"

type Config struct {
	RegistrationURL string
	MaxRunners      int
	MinRunners      int
	ScaleSetName    string
	Labels          []string
	RunnerGroup     string
	GitHubApp       scaleset.GitHubAppAuth
	Token           string
	RunnerImage     string
	LogLevel        string
	LogFormat       string
	// RegistrationName is a homelab addition (homelab#97): which GitHub
	// registration (account/repo + App credentials) this scale set belongs
	// to -- primaryRegistrationName for the top-level github/scale_sets
	// blocks, or the matching registrations[].name entry otherwise. Multiple
	// registrations share one shared FleetCoordinator/DockerHost pool but
	// each gets its own *scaleset.Client and GitHub App auth. Used to keep
	// interleaved logs, Docker container names/labels, and credential
	// resolution attributable to the right registration.
	RegistrationName string
	// PrivateKeyFile is a homelab addition: path to the GitHub App private
	// key PEM, read into GitHubApp.PrivateKey so the key never appears in
	// argv or the environment. See loadPrivateKeyFile.
	PrivateKeyFile string
	// DockerHosts is a homelab addition: fleet-wide placement. Each entry is
	// "name=target" (target "local" or "ssh://user@host"). Empty means the
	// single local socket (original single-host behavior). See hosts.go.
	DockerHosts []string
	// HostPolicyFile contains per-host placement and storage policy in YAML.
	// CLI host overrides remain supported and take precedence.
	HostPolicyFile string
	// HostRunnerLimits caps total autoscaled runner containers across all
	// scale sets on named hosts (for example janeway=1).
	HostRunnerLimits []string
	// MountDockerSocket is a homelab addition: bind-mount the PLACEMENT
	// host's own docker.sock into every spawned runner (root-equivalent —
	// only for a scale set standing in for the e2e-docker label; default and
	// claude-agent must stay false, mirroring the static runners' privilege
	// boundary, members#1976).
	MountDockerSocket bool
	// DockerSocketGIDs is a homelab addition: supplementary GIDs added to
	// every spawned runner when MountDockerSocket is set. The official
	// actions/actions-runner image runs as non-root `runner` with no group
	// fixed up for the mounted socket (unlike the old myoung34-style images,
	// which ran a root entrypoint that did this) — a bind mount alone 404s
	// with "permission denied" without matching group membership. The
	// docker group's GID differs PER HOST (homelab 983, pike 979, laforge
	// 1002, spark 988 — confirmed via `id`), so all fleet GIDs are added to
	// every container; the ones that don't match the placement host are
	// simply inert.
	DockerSocketGIDs []string
	// RunnerMemory is a homelab addition: optional memory limit for spawned
	// runner containers (e.g. 16g, 4g, 512m). Empty means no limit.
	RunnerMemory string
	// WorkDirSizeCap is a homelab addition: size ceiling (e.g. 10g) for the
	// shared /home/runner/_work directory bind-mounted into every runner when
	// MountDockerSocket is set (see docs/incidents.md 2026-07-18 — that shared
	// dir has no per-container lifecycle to clean it up, unlike a normal
	// container's writable layer). Only enforced when MountDockerSocket is
	// true; ignored otherwise since nothing shared is mounted.
	WorkDirSizeCap string
	// WorkDirSizeCaps overrides WorkDirSizeCap for named fleet hosts, using
	// name=size entries (for example janeway=20g). Small runner nodes need a
	// lower ceiling than Spark's multi-terabyte cache tier.
	WorkDirSizeCaps []string
	// SparkMetricsURL is a homelab addition: URL to probe for Spark inference
	// metrics (vllm:num_requests_running / waiting). When active inference
	// requests are present, placement on spark is penalized to preserve GPU
	// throughput for interactive/batch AI workloads.
	SparkMetricsURL string
	// HostMetricsURLTemplate is a homelab addition: fmt.Sprintf-style URL
	// template used to fetch node-exporter metrics for every placement host.
	// The single %s is replaced with the Docker host name. Empty disables
	// load-aware placement.
	HostMetricsURLTemplate string
	HostLoadSoft           float64
	HostLoadBusy           float64
	HostLoadHard           float64
	HostCPUSoft            float64
	HostCPUHard            float64
	HostPSISoft            float64
	HostPSIHard            float64
	HostMemorySoft         float64
	HostMemoryHard         float64
	HostSwapSoft           float64
	HostSwapHard           float64
	HostOverloadCooldown   time.Duration
	HostTelemetryPenalty   int
	HostMemoryExempt       []string
	// MetricsAddr is a homelab addition: listen address for HTTP metrics/healthz server.
	MetricsAddr string
}

func stringSet(values []string) map[string]bool {
	out := make(map[string]bool, len(values))
	for _, value := range values {
		if value = strings.TrimSpace(value); value != "" {
			out[value] = true
		}
	}
	return out
}

func (c *Config) defaults() {
	if c.RunnerGroup == "" {
		c.RunnerGroup = scaleset.DefaultRunnerGroup
	}
	if c.RegistrationName == "" {
		c.RegistrationName = primaryRegistrationName
	}
	if c.RunnerImage == "" {
		c.RunnerImage = "ghcr.io/actions/actions-runner:latest"
	}
	// SparkMetricsURL and MetricsAddr are deliberately NOT defaulted here:
	// empty is a meaningful, documented value for both (disables spark-aware
	// placement / disables the metrics server respectively), and the cobra
	// flags in main.go already supply the non-empty default for the unset
	// case. Re-filling them here would make "pass an empty flag to disable"
	// impossible.
	if c.WorkDirSizeCap == "" {
		c.WorkDirSizeCap = "50g"
	}
	if c.HostLoadHard == 0 {
		p := defaultHostLoadPolicy()
		c.HostLoadSoft, c.HostLoadBusy, c.HostLoadHard = p.loadSoft, p.loadBusy, p.loadHard
		c.HostCPUSoft, c.HostCPUHard = p.cpuSoft, p.cpuHard
		c.HostPSISoft, c.HostPSIHard = p.psiSoft, p.psiHard
		c.HostMemorySoft, c.HostMemoryHard = p.memorySoft, p.memoryHard
		c.HostSwapSoft, c.HostSwapHard = p.swapSoft, p.swapHard
		c.HostOverloadCooldown, c.HostTelemetryPenalty = p.cooldown, p.telemetryPenalty
	}
}

// loadPrivateKeyFile reads the App private key from PrivateKeyFile into
// GitHubApp.PrivateKey when a path was given and no inline key was set.
// Homelab addition: keeps the PEM out of argv/env (the upstream example only
// accepts the key contents via the --app-private-key flag).
func (c *Config) loadPrivateKeyFile() error {
	if c.PrivateKeyFile == "" || c.GitHubApp.PrivateKey != "" {
		return nil
	}
	b, err := os.ReadFile(c.PrivateKeyFile)
	if err != nil {
		return fmt.Errorf("reading --app-private-key-file: %w", err)
	}
	c.GitHubApp.PrivateKey = string(b)
	return nil
}

func (c *Config) Validate() error {
	c.defaults()

	if _, err := url.ParseRequestURI(c.RegistrationURL); err != nil {
		return fmt.Errorf("invalid registration URL: %w, it should be the full URL of where you want to register your scale set, e.g. 'https://github.com/org/repo'", err)
	}

	appError := c.GitHubApp.Validate()
	if c.Token == "" && appError != nil {
		return fmt.Errorf("no credentials provided: either GitHub App (client id, installation id and private key) (recommended) or a Personal Access Token are required")
	}

	if c.ScaleSetName == "" {
		return fmt.Errorf("scale set name is required")
	}
	for i, label := range c.Labels {
		if strings.TrimSpace(label) == "" {
			return fmt.Errorf("label at index %d is empty", i)
		}
	}
	if c.MaxRunners < c.MinRunners {
		return fmt.Errorf("max runners cannot be less than min-runners")
	}
	if c.RunnerGroup == "" {
		return fmt.Errorf("runner group is required")
	}
	if c.RunnerImage == "" {
		return fmt.Errorf("runner image is required")
	}
	if _, _, err := ParseDockerHosts(c.DockerHosts); err != nil {
		return err
	}
	if c.HostMetricsURLTemplate != "" && strings.Count(c.HostMetricsURLTemplate, "%s") != 1 {
		return fmt.Errorf("--host-metrics-url-template must contain exactly one %%s placeholder")
	}
	if !(c.HostLoadSoft < c.HostLoadBusy && c.HostLoadBusy < c.HostLoadHard) {
		return fmt.Errorf("host load thresholds must satisfy soft < busy < hard")
	}
	if !(c.HostCPUSoft < c.HostCPUHard && c.HostPSISoft < c.HostPSIHard && c.HostMemoryHard < c.HostMemorySoft && c.HostSwapSoft < c.HostSwapHard) {
		return fmt.Errorf("host pressure thresholds are not ordered correctly")
	}
	return nil
}

// systemInfo serves as a base system info
func systemInfo(scaleSetID int) scaleset.SystemInfo {
	return scaleset.SystemInfo{
		System:     "dockerscaleset",
		Subsystem:  "dockerscaleset",
		CommitSHA:  "NA",    // You can leverage build flags to set commit SHA
		Version:    "0.1.0", // You can leverage build flags to set version
		ScaleSetID: scaleSetID,
	}
}

func (c *Config) ScalesetClient() (*scaleset.Client, error) {
	if err := c.GitHubApp.Validate(); err == nil {
		return scaleset.NewClientWithGitHubApp(
			scaleset.ClientWithGitHubAppConfig{
				GitHubConfigURL: c.RegistrationURL,
				GitHubAppAuth:   c.GitHubApp,
				SystemInfo:      systemInfo(0),
			},
		)
	}

	return scaleset.NewClientWithPersonalAccessToken(
		scaleset.NewClientWithPersonalAccessTokenConfig{
			GitHubConfigURL:     c.RegistrationURL,
			PersonalAccessToken: c.Token,
			SystemInfo:          systemInfo(0),
		},
	)
}

func (c *Config) Logger() *slog.Logger {
	var lvl slog.Level
	switch strings.ToLower(c.LogLevel) {
	case "debug":
		lvl = slog.LevelDebug
	case "info":
		lvl = slog.LevelInfo
	case "warn":
		lvl = slog.LevelWarn
	case "error":
		lvl = slog.LevelError
	default:
		lvl = slog.LevelInfo
	}

	switch c.LogFormat {
	case "json":
		return slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
			AddSource: true,
			Level:     lvl,
		}))
	case "text":
		return slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{
			AddSource: true,
			Level:     lvl,
		}))
	default:
		return slog.New(slog.DiscardHandler)
	}
}

// BuildLabels returns the labels to use for the runner scale set.
// If custom labels are provided, those are used; otherwise, the scale set name is used as the label.
func (c *Config) BuildLabels() []scaleset.Label {
	if len(c.Labels) > 0 {
		labels := make([]scaleset.Label, len(c.Labels))
		for i, name := range c.Labels {
			labels[i] = scaleset.Label{Name: strings.TrimSpace(name)}
		}
		return labels
	}
	return []scaleset.Label{{Name: c.ScaleSetName}}
}

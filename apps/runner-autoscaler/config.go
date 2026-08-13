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
	// DockerHosts is a homelab addition: fleet-wide placement. Each entry is
	// "name=target" (target "local" or "ssh://user@host"). Empty means the
	// single local socket (original single-host behavior). See hosts.go.
	DockerHosts []string
	// MountDockerSocket is a homelab addition: bind-mount the PLACEMENT
	// host's own docker.sock into every spawned runner (root-equivalent —
	// only for a scale set standing in for the e2e-docker label; default and
	// claude-agent must stay false, mirroring the static runners' privilege
	// boundary, members#1976).
	MountDockerSocket bool
	// ShareWorkDir is a homelab addition: bind-mount the PLACEMENT host's
	// /home/runner/{_work,externals} into every runner this scale set
	// spawns, so checkouts, node_modules and caches persist across jobs.
	//
	// Split out of MountDockerSocket (agent-lcars#101). Those were one flag
	// because the only pool that wanted a persistent workdir also happened
	// to want the socket, so removing the socket silently took the workdir
	// bind with it -- and with it every cross-job cache. They are unrelated
	// concerns: this one is about persistence, MountDockerSocket is about
	// privilege. A pool can now have a warm workdir without being handed
	// root on the placement host.
	//
	// Everything that exists BECAUSE the workdir is shared keys off this,
	// not the socket: the per-host placement exclusion (two runners of one
	// scale set on a host resolve the same repo to the same checkout
	// directory and corrupt each other), the workdir lock, the size-cap
	// sweeper, and the shared-workdir container label.
	ShareWorkDir bool
	// FileMounts is a homelab addition: specific host files exposed
	// read-only inside every runner this scale set spawns (agent-lcars#101).
	// It exists so the socketless BuildKit publish lane can receive its
	// client certificate from the encrypted homelab secret store instead of
	// GitHub Actions secrets.
	//
	// Deliberately far narrower than MountDockerSocket: every source must
	// sit under a fleet.file_mount_allowlist prefix, mounts are always
	// read-only, and the docker socket is rejected as a source outright --
	// otherwise this would be a trivial way around
	// fleet.docker_socket_allowlist, reintroducing the exact
	// root-equivalent access agent-lcars#101 removes.
	FileMounts []FileMount
	// RunnerMemory is a homelab addition: optional memory limit for spawned
	// runner containers (e.g. 16g, 4g, 512m). Empty means no limit.
	RunnerMemory string
	// RunnerPidsLimit is a homelab addition: optional PID-count ceiling for
	// spawned runner containers (orchestrator.yml's `pids_limit`). Zero means
	// no limit -- the same "unset means unlimited" convention as
	// RunnerMemory, just expressed with the type's own zero value instead of
	// an empty string, since a PID limit has no unit suffix to make an empty
	// string the natural sentinel.
	RunnerPidsLimit int64
	// RunnerShmSize is a homelab addition: optional /dev/shm size for spawned
	// runner containers (e.g. "1g"), same string-with-unit convention as
	// RunnerMemory. Restores what e2e.yml's dropped job-level `container:`
	// block covered with `--ipc=host` (homelab#148) -- implemented as an
	// explicit shm_size rather than the full host IPC namespace share that
	// flag implies: the documented need (Chromium/Playwright wanting more
	// /dev/shm than Docker's 64m default) is satisfied by sizing /dev/shm
	// directly, without also handing the container the host's IPC namespace.
	RunnerShmSize string
	// SparkMetricsURL is a homelab addition: URL to probe for Spark inference
	// metrics. Both exposition shapes are understood — vLLM
	// (vllm:num_requests_running / waiting) and llama-swap
	// (llamaswap_gpu_power_draw_watts, what spark serves today); see
	// isSparkLoaded. When active inference is detected, placement on spark is
	// penalized to preserve GPU throughput for interactive/batch AI workloads.
	SparkMetricsURL string
	// HostMetricsURLTemplate is a homelab addition: fmt.Sprintf-style URL
	// template used to fetch node-exporter metrics for every placement host.
	// The single %s is replaced with the Docker host name. Empty disables
	// load-aware placement.
	HostMetricsURLTemplate string
	// HostMetricsTimeouts optionally overrides the one-second telemetry probe
	// deadline for individual fleet hosts.
	HostMetricsTimeouts map[string]time.Duration
	// HostLoadPolicy holds the resolved fleet.placement thresholds (see
	// resolvedOrchestratorConfig.Placement, which this is copied from
	// verbatim in runOrchestrator).
	HostLoadPolicy   hostLoadPolicy
	HostMemoryExempt []string
	// ReadinessMetricsURL, ReadinessMetric and ReadinessMaxAge configure the
	// per-host readiness gate consulted for hosts that set
	// require_readiness. See FleetPlacementFile for the semantics and
	// hostReady for the check itself. Empty URL/metric disables the gate.
	ReadinessMetricsURL string
	ReadinessMetric     string
	ReadinessMaxAge     time.Duration
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
		// The fleet must never fall back to a public image registry. The
		// multi-architecture Actions runner base is mirrored into the
		// homelab registry before any runner image is published.
		c.RunnerImage = "docker-registry.lan.jlapenna.net/mirror/actions-runner:latest"
	}
	// SparkMetricsURL is deliberately NOT defaulted here: empty is a
	// meaningful, documented value (disables spark-aware placement), and the
	// cobra flags in main.go already supply the non-empty default for the
	// unset case. Re-filling it here would make "pass an empty flag to
	// disable" impossible.
	if c.HostLoadPolicy.loadHard == 0 {
		c.HostLoadPolicy = defaultHostLoadPolicy()
	}
}

// FileMount is a homelab addition: one host file exposed read-only inside
// spawned runners. See Config.FileMounts.
type FileMount struct {
	// HostPath is the absolute path on the PLACEMENT host. Like the docker
	// socket bind, it is resolved by whichever host's daemon actually
	// places the runner, so the file must exist on every fleet host that
	// can host this scale set.
	HostPath string
	// ContainerPath is the absolute path inside the runner container.
	ContainerPath string
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
	p := c.HostLoadPolicy
	if !(p.loadSoft < p.loadBusy && p.loadBusy < p.loadHard) {
		return fmt.Errorf("host load thresholds must satisfy soft < busy < hard")
	}
	if !(p.cpuSoft < p.cpuHard && p.psiSoft < p.psiHard && p.memoryHard < p.memorySoft && p.swapSoft < p.swapHard) {
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

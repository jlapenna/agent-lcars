package main

import (
	"bytes"
	"fmt"
	"math"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"text/template"
	"time"

	"github.com/actions/scaleset"
	"github.com/docker/go-units"
	yaml "go.yaml.in/yaml/v3"
)

// OrchestratorConfig is the single, versioned configuration surface for the
// multi-scale-set control plane. GitHub credentials deliberately remain in
// the environment/mounted key file and are never accepted in this YAML --
// with one deliberate exception: registrations[].app.client_id and
// .installation_id, which are not secret (see RegistrationAppConfig).
type OrchestratorConfig struct {
	Version int                `yaml:"version"`
	GitHub  OrchestratorGitHub `yaml:"github"`
	Server  OrchestratorServer `yaml:"server"`
	Fleet   OrchestratorFleet  `yaml:"fleet"`
	// ScaleSets are registered against the top-level GitHub account/repo
	// above, authenticated from the environment (APP_CLIENT_ID /
	// APP_INSTALLATION_ID / APP_PRIVATE_KEY_FILE) exactly as before
	// homelab#97 -- this is the "primary" registration, kept for back-compat
	// so today's Sprinkles deployment needs zero config-shape changes.
	ScaleSets []ScaleSetConfigFile `yaml:"scale_sets"`
	// Registrations are ADDITIONAL GitHub scale-set registrations beyond the
	// primary one above (homelab#97) -- each is a distinct GitHub
	// account/repo with its own App installation, sharing this process's
	// FleetCoordinator and DockerHost pool with every other registration.
	// The scaleset.Client library binds one Client to one registration's URL
	// + auth at construction, so each registration gets its own listener
	// goroutine(s) and Client; only placement/scheduling is shared.
	Registrations []RegistrationConfigFile `yaml:"registrations,omitempty"`
}

type OrchestratorGitHub struct {
	URL         string `yaml:"url"`
	RunnerGroup string `yaml:"runner_group,omitempty"`
}

// RegistrationConfigFile is one additional GitHub scale-set registration
// (homelab#97) -- a distinct account/repo from the primary github: block,
// with its own App credentials and scale sets, sharing the process-wide
// fleet placement. Client ID and installation ID are ordinary GitHub App
// identifiers, not secrets (see README "Secrets") and so are committed
// directly here; only the private key CONTENT is secret, and this file only
// ever holds a path to it (mounted separately, vault-templated by
// ansible/deploy_secrets.yml).
type RegistrationConfigFile struct {
	Name string `yaml:"name"`
	// Disabled skips this registration entirely -- no validation of its App
	// credentials/private key, no listener, no scale sets counted anywhere
	// -- so a not-yet-provisioned registration (no GitHub App created yet,
	// no vault secrets) can be committed in its real final shape, with
	// obvious placeholder values, without blocking --check-config or
	// deployment of every OTHER registration in this same process/file.
	// Flip to false (or delete the line) once the App is created, installed,
	// and the vault secrets below are real.
	Disabled  bool                  `yaml:"disabled,omitempty"`
	GitHub    OrchestratorGitHub    `yaml:"github"`
	App       RegistrationAppConfig `yaml:"app"`
	ScaleSets []ScaleSetConfigFile  `yaml:"scale_sets"`
}

// RegistrationAppConfig identifies the GitHub App used to authenticate this
// registration. ClientID and InstallationID are not secret -- they identify
// the App/installation, not authenticate as it (see README "GitHub App
// setup"). Only the PEM content behind PrivateKeyFile is secret, and it
// never appears in this YAML -- just the in-container mount path.
type RegistrationAppConfig struct {
	ClientID       string `yaml:"client_id"`
	InstallationID int64  `yaml:"installation_id"`
	PrivateKeyFile string `yaml:"private_key_file"`
}

type OrchestratorServer struct {
	MetricsAddr string `yaml:"metrics_addr,omitempty"`
	LogLevel    string `yaml:"log_level,omitempty"`
	LogFormat   string `yaml:"log_format,omitempty"`
	// StatePath is where the control plane checkpoints runner state so a
	// restart can adopt in-flight runners instead of waiting out a full
	// fleet drain. Required, and required to be writable: see
	// verifyCheckpointPath for why this fails loudly rather than degrading.
	// The deployment must back it with a volume that survives container
	// recreation -- a path inside the container's own filesystem is erased
	// by the very restart the checkpoint exists to make safe.
	StatePath string `yaml:"state_path"`
}

type OrchestratorFleet struct {
	MaxRunners int                `yaml:"max_runners"`
	Hosts      []FleetHostConfig  `yaml:"hosts"`
	Placement  FleetPlacementFile `yaml:"placement,omitempty"`
	// FileMountAllowlist bounds which host paths a scale set's file_mounts
	// may read from. Every source must sit at or beneath one of these
	// prefixes.
	//
	// Fail-CLOSED: an unset allowlist means no scale set may mount anything
	// at all.
	FileMountAllowlist []string `yaml:"file_mount_allowlist,omitempty"`
}

type FleetHostConfig struct {
	Name              string `yaml:"name"`
	Docker            string `yaml:"docker"`
	RequireMains      bool   `yaml:"require_mains,omitempty"`
	MetricsViaSSH     bool   `yaml:"metrics_via_ssh,omitempty"`
	MetricsTimeoutRaw string `yaml:"metrics_timeout,omitempty"`
	// RequireReadiness gates placement on an operator-supplied signal, read
	// from fleet.placement.readiness_metrics_url. Reachability alone is not
	// always sufficient to decide a host should take work: a machine can be
	// perfectly reachable while it is somewhere, or in some state, the
	// operator does not want CI running on. What "ready" means is entirely
	// the operator's to define -- this only consumes the verdict.
	RequireReadiness bool `yaml:"require_readiness,omitempty"`
	RunnerLimit      *int `yaml:"runner_limit,omitempty"`
	// MemoryOvercommit multiplies this host's reserved-memory admission
	// budget (physical memory minus fleet.placement.memory_safety_margin)
	// while its latest load sample shows it unpressured -- see
	// effectiveMemoryOvercommit and the fleet scheduler redesign's "bounded
	// overcommit" (agent-lcars#1694, docs/fleet-scheduler-redesign.md#C).
	// Must be at least 1.0 and at most 2.0; zero (the default) selects 1.0,
	// i.e. no overcommit.
	MemoryOvercommit float64 `yaml:"memory_overcommit,omitempty"`
	// Role declares this host's standing in the fleet invariant (the fleet
	// scheduler redesign's phase 2, agent-lcars#1696,
	// docs/fleet-scheduler-redesign.md#F): hostRolePermanent (the default,
	// when empty), hostRoleOpportunistic, or hostRoleMaintenance. See those
	// constants' doc comment for what each one means for placement and for
	// github_runner_autoscaler_lane_permanent_admissible_slots.
	Role string `yaml:"role,omitempty"`
}

// Fleet host roles (agent-lcars#1696, docs/fleet-scheduler-redesign.md#F).
// The scheduler computes admissible slots per lane over permanent hosts
// only (github_runner_autoscaler_lane_permanent_admissible_slots) so that
// losing a non-permanent host never trips the fleet invariant alert.
const (
	// hostRolePermanent is the default: an ordinary host that counts toward
	// both the fleet-wide lane_admissible_slots gauge and the
	// permanent-only lane_permanent_admissible_slots gauge the invariant
	// alert reads.
	hostRolePermanent = "permanent"
	// hostRoleOpportunistic hosts (laptop) are placed on exactly like a
	// permanent host when reachable and ready -- pickHostLocked and
	// lane_admissible_slots make no distinction -- but never count toward
	// lane_permanent_admissible_slots, so losing one never fires the
	// permanent-capacity invariant alert.
	hostRoleOpportunistic = "opportunistic"
	// hostRoleMaintenance hosts (pike) are never placement candidates --
	// probeFleetHosts forces them ineligible and counts every probe under
	// placementBlocked{reason=placementReasonMaintenance} -- but stay
	// declared in fleet.hosts so host_reachable, host_ready, and
	// host_role_info keep reporting on them. This is additive: removing a
	// host from fleet.hosts entirely (today's mechanism, and pike's
	// credentials-revoked/re-entry preflight) still works unchanged for a
	// host that should not even be connected to.
	hostRoleMaintenance = "maintenance"
)

type FleetPlacementFile struct {
	HostMetricsURLTemplate string `yaml:"host_metrics_url_template,omitempty"`
	SparkMetricsURL        string `yaml:"spark_metrics_url,omitempty"`
	// ReadinessMetricsURL is a Prometheus-format endpoint published by the
	// operator, serving ReadinessMetric for every host that sets
	// require_readiness. One endpoint for the whole fleet rather than one
	// per host: the answer is often about a host as seen from elsewhere, so
	// the host itself is not necessarily able to report it.
	ReadinessMetricsURL string `yaml:"readiness_metrics_url,omitempty"`
	// ReadinessMetric is the gauge name to look up, matched with a
	// host="<name>" label. A value greater than zero means ready.
	ReadinessMetric string `yaml:"readiness_metric,omitempty"`
	// ReadinessMaxAge, when set, additionally requires a companion
	// "<ReadinessMetric>_timestamp_seconds" gauge that is no older than
	// this. Strongly recommended: the gate is fail-closed, so a publisher
	// that dies leaves its last reading served forever and a stale "ready"
	// would fail the gate OPEN -- the one outcome it exists to prevent.
	ReadinessMaxAge  string   `yaml:"readiness_max_age,omitempty"`
	HostMemoryExempt []string `yaml:"host_memory_exempt,omitempty"`
	// MemorySafetyMargin is the fraction of Docker-reported physical host
	// memory that aggregate runner reservations may not consume.
	MemorySafetyMargin float64 `yaml:"memory_safety_margin,omitempty"`
	// RunnerCgroupParent is the systemd slice every runner container is
	// created under (Docker's --cgroup-parent), so co-tenant runners on one
	// host are bounded collectively by a slice memory.max / memory.high in
	// addition to their own per-container ceilings (agent-lcars#1700). The
	// autoscaler only declares that bound (runnerSliceBudget, published as
	// github_runner_autoscaler_runner_slice_expected_memory_max_bytes /
	// _high_bytes); Ansible enforces it (jlapenna/homelab#1102,
	// agent-lcars#1712). A pointer because the tri-state matters: an
	// omitted key defaults to defaultRunnerCgroupParent, while an explicit
	// empty string disables the slice bound entirely -- once YAML decoding
	// is done a plain string can no longer tell those two apart.
	RunnerCgroupParent *string `yaml:"runner_cgroup_parent,omitempty"`
	LoadSoft           float64 `yaml:"load_soft,omitempty"`
	LoadBusy           float64 `yaml:"load_busy,omitempty"`
	LoadHard           float64 `yaml:"load_hard,omitempty"`
	CPUSoft            float64 `yaml:"cpu_soft,omitempty"`
	CPUHard            float64 `yaml:"cpu_hard,omitempty"`
	PSISoft            float64 `yaml:"psi_soft,omitempty"`
	PSIHard            float64 `yaml:"psi_hard,omitempty"`
	MemorySoft         float64 `yaml:"memory_soft,omitempty"`
	MemoryHard         float64 `yaml:"memory_hard,omitempty"`
	SwapSoft           float64 `yaml:"swap_soft,omitempty"`
	SwapHard           float64 `yaml:"swap_hard,omitempty"`
	OverloadCooldown   string  `yaml:"overload_cooldown,omitempty"`
	TelemetryPenalty   int     `yaml:"telemetry_penalty,omitempty"`
	// DegradationLadder configures the placement degradation ladder
	// (agent-lcars#1697, docs/fleet-scheduler-redesign.md#D): when no host
	// admits a lane's declared reservation, an ordered ladder of
	// progressively looser admission rules runs instead of refusing
	// outright. Default off fleet-wide; see ScaleSetConfigFile.DegradationLadder
	// for the per-lane override.
	DegradationLadder DegradationLadderConfigFile `yaml:"degradation_ladder,omitempty"`
}

// DegradationLadderConfigFile is the raw fleet.placement.degradation_ladder
// block (agent-lcars#1697, docs/fleet-scheduler-redesign.md#D). See
// resolvedDegradationLadder for the validated/defaulted form placement
// actually consults.
type DegradationLadderConfigFile struct {
	// Enabled is the fleet-wide default: a lane's own degradation_ladder
	// override (ScaleSetConfigFile.DegradationLadder) always wins when set.
	Enabled bool `yaml:"enabled,omitempty"`
	// PrometheusURL is the base URL (e.g. "http://prometheus:9090") queried
	// for rung 2's observed-p95 figure. Empty disables rung 2 fleet-wide
	// (regardless of any lane's own enablement): the ladder then goes
	// straight from rung 1 to rung 3.
	PrometheusURL string `yaml:"prometheus_url,omitempty"`
	// ObservedWindow is the max_over_time window baked into ObservedQuery's
	// default template, e.g. "168h" for seven days. Defaults to "168h".
	ObservedWindow string `yaml:"observed_window,omitempty"`
	// ObservedQuantile is the quantile computed over that window. Must be in
	// (0, 1]. Defaults to 0.95.
	ObservedQuantile float64 `yaml:"observed_quantile,omitempty"`
	// ObservedQuery is a Go text/template string rendered with .ScaleSet,
	// .Window, and .Quantile to produce the PromQL instant query rung 2
	// evaluates per ladder-enabled lane. Defaults to
	// defaultDegradationLadderQuery.
	ObservedQuery string `yaml:"observed_query,omitempty"`
	// RefreshInterval is how often every ladder-enabled lane's observed
	// figure is re-queried. Defaults to "10m". A sample older than 3x this
	// interval is treated as stale and skips rung 2.
	RefreshInterval string `yaml:"refresh_interval,omitempty"`
}

// defaultDegradationLadderQuery is FleetPlacementFile.DegradationLadder's
// default ObservedQuery (agent-lcars#1697): cAdvisor's
// container_label_autoscaler_scale_set label already carries the scale-set
// name onto every runner container it exports, and this measures the
// max-per-run RSS (not the mean) over the window before taking the quantile
// across runs, matching "what the worst run in the window actually used".
const defaultDegradationLadderQuery = `quantile({{.Quantile}}, max_over_time(container_memory_rss{container_label_autoscaler_scale_set="{{.ScaleSet}}"}[{{.Window}}]))`

// resolvedDegradationLadder is FleetPlacementFile.DegradationLadder after
// defaulting and validation: the shared configuration every ladder-enabled
// lane's rung 2 evaluation consults (agent-lcars#1697).
type resolvedDegradationLadder struct {
	// Enabled is the fleet-wide default; see DegradationLadderConfigFile.Enabled
	// and Config.DegradationLadderEnabled for the fully-resolved per-lane
	// value.
	Enabled         bool
	PrometheusURL   string
	Window          string
	Quantile        float64
	QueryTemplate   *template.Template
	RefreshInterval time.Duration
	// MaxSampleAge is 3x RefreshInterval: a cached observed-p95 sample older
	// than this is treated as stale and skips rung 2, per design.
	MaxSampleAge time.Duration
}

// render produces the PromQL instant query for one ladder-enabled scale
// set's rung 2 evaluation.
func (d resolvedDegradationLadder) render(scaleSet string) (string, error) {
	var buf bytes.Buffer
	if err := d.QueryTemplate.Execute(&buf, struct {
		ScaleSet string
		Window   string
		Quantile float64
	}{ScaleSet: scaleSet, Window: d.Window, Quantile: d.Quantile}); err != nil {
		return "", fmt.Errorf("rendering degradation ladder observed_query for scale set %q: %w", scaleSet, err)
	}
	return buf.String(), nil
}

type ScaleSetConfigFile struct {
	Name         string   `yaml:"name"`
	Labels       []string `yaml:"labels"`
	RunnerImage  string   `yaml:"runner_image"`
	RunnerMemory string   `yaml:"runner_memory,omitempty"`
	// RunnerMemoryReservation is the scheduler's per-runner reservation for
	// aggregate host-memory admission, distinct from the RunnerMemory cgroup
	// ceiling (agent-lcars#1683). Omitted means "reserve the full ceiling".
	RunnerMemoryReservation string `yaml:"runner_memory_reservation,omitempty"`
	// PidsLimit and ShmSize are homelab additions restoring what e2e.yml's
	// dropped job-level `container:` block carried (homelab#148); see
	// Config.RunnerPidsLimit / Config.RunnerShmSize.
	PidsLimit  int64  `yaml:"pids_limit,omitempty"`
	ShmSize    string `yaml:"shm_size,omitempty"`
	MinRunners int    `yaml:"min_runners"`
	MaxRunners int    `yaml:"max_runners"`
	Weight     int    `yaml:"weight,omitempty"`
	// Priority protects one minimum-service runner for this scale set while
	// it has pending demand and no runner of its own -- but only when a
	// lower-priority placement would actually leave it with zero admissible
	// slots fleet-wide (agent-lcars#1718); a lower-priority lane is never
	// refused just because this one is pending, as long as the fleet has
	// room for both. Higher numbers take precedence; equal priorities retain
	// weighted round-robin ordering. Zero is the default ordinary tier.
	Priority int `yaml:"priority,omitempty"`
	// FileMounts are "hostPath:containerPath" pairs, mounted read-only.
	// See Config.FileMounts and fleet.file_mount_allowlist.
	FileMounts []string `yaml:"file_mounts,omitempty"`
	// DegradationLadder overrides fleet.placement.degradation_ladder.enabled
	// for this one lane (agent-lcars#1697, docs/fleet-scheduler-redesign.md#D):
	// a pointer so the tri-state matters -- unset defers to the fleet-wide
	// default, true always enables the ladder for this lane even when the
	// fleet default is off, and false always disables it even when the
	// fleet default is on. Valid on both top-level scale_sets[] entries and
	// registrations[].scale_sets[] entries.
	DegradationLadder *bool `yaml:"degradation_ladder,omitempty"`
}

// dockerSocketPaths are every spelling of the Docker socket that config
// validation must refuse to expose. Two are needed because /var/run is a
// symlink to /run on systemd hosts, so the same socket has two absolute
// paths and a literal comparison against one of them silently permits the
// other.
//
// Sources are rejected if they ARE one of these or CONTAIN one: mounting
// /var/run read-only still lets a process inside the container connect to
// the socket sitting in it -- read-only restricts writes to the directory,
// not connections to a socket within. Either form would hand back the
// root-equivalent host access agent-lcars#101 removed; file_mounts has no
// path back to it, full stop -- there is no flag anywhere in this config
// that can expose the socket.
var dockerSocketPaths = []string{"/var/run/docker.sock", "/run/docker.sock"}

// containsPath reports whether ancestor is, or is a parent directory of,
// target. Compares whole path segments, so /etc/buildkit does not contain
// /etc/buildkit-evil. Both arguments must already be absolute and clean.
func containsPath(ancestor, target string) bool {
	if ancestor == target {
		return true
	}
	if ancestor == "/" {
		return strings.HasPrefix(target, "/")
	}
	return strings.HasPrefix(target, ancestor+string(filepath.Separator))
}

// validateFileMountAllowlist checks the fleet allowlist itself. This list is
// the privilege boundary for host-file access, so it is validated even when
// no scale set currently uses it -- a latent over-broad entry should fail
// the config, not wait for someone to exploit it.
func validateFileMountAllowlist(allowlist []string) error {
	for _, entry := range allowlist {
		prefix := strings.TrimSpace(entry)
		// Do NOT clean-and-accept: cleaning "/etc/buildkit-client/.."
		// would silently widen the boundary to /etc, granting a far
		// broader subtree than the configured text suggests.
		if !filepath.IsAbs(prefix) || filepath.Clean(prefix) != prefix {
			return fmt.Errorf("fleet.file_mount_allowlist entry %q must be absolute and already clean", entry)
		}
		for _, sock := range dockerSocketPaths {
			if containsPath(prefix, sock) {
				return fmt.Errorf("fleet.file_mount_allowlist entry %q is or contains the Docker socket %s, which may never be exposed to a runner", entry, sock)
			}
		}
	}
	return nil
}

// parseFileMounts validates a scale set's file_mounts against the fleet
// allowlist and returns the resolved, read-only mounts.
func parseFileMounts(scaleSetName string, raw []string, allowlist []string) ([]FileMount, error) {
	if len(raw) == 0 {
		return nil, nil
	}
	if len(allowlist) == 0 {
		return nil, fmt.Errorf("scale set %q sets file_mounts but fleet.file_mount_allowlist is empty", scaleSetName)
	}
	out := make([]FileMount, 0, len(raw))
	seenTargets := map[string]bool{}
	for _, entry := range raw {
		hostPath, containerPath, ok := strings.Cut(strings.TrimSpace(entry), ":")
		hostPath, containerPath = strings.TrimSpace(hostPath), strings.TrimSpace(containerPath)
		if !ok || hostPath == "" || containerPath == "" {
			return nil, fmt.Errorf("scale set %q file_mounts entry %q must be \"hostPath:containerPath\"", scaleSetName, entry)
		}
		for label, p := range map[string]string{"host": hostPath, "container": containerPath} {
			if !filepath.IsAbs(p) || filepath.Clean(p) != p {
				return nil, fmt.Errorf("scale set %q file_mounts %s path %q must be absolute and already clean", scaleSetName, label, p)
			}
		}
		for _, sock := range dockerSocketPaths {
			if containsPath(hostPath, sock) {
				return nil, fmt.Errorf("scale set %q may not mount %q via file_mounts: it is or contains the Docker socket %s, which may never be exposed to a runner", scaleSetName, hostPath, sock)
			}
		}
		if !underAllowlist(hostPath, allowlist) {
			return nil, fmt.Errorf("scale set %q file_mounts source %q is not under any fleet.file_mount_allowlist prefix", scaleSetName, hostPath)
		}
		if seenTargets[containerPath] {
			return nil, fmt.Errorf("scale set %q mounts %q more than once", scaleSetName, containerPath)
		}
		seenTargets[containerPath] = true
		out = append(out, FileMount{HostPath: hostPath, ContainerPath: containerPath})
	}
	return out, nil
}

// underAllowlist reports whether path sits at or beneath an allowlist entry.
// Entries are NOT cleaned here -- validateFileMountAllowlist has already
// rejected unclean ones, so normalizing at comparison time could only
// broaden the boundary silently.
func underAllowlist(path string, allowlist []string) bool {
	for _, prefix := range allowlist {
		if containsPath(strings.TrimSpace(prefix), path) {
			return true
		}
	}
	return false
}

type resolvedOrchestratorConfig struct {
	Raw                 OrchestratorConfig
	DockerHosts         []string
	RunnerLimits        map[string]int
	MainsRequired       map[string]bool
	MetricsViaSSH       map[string]bool
	HostMetricsTimeouts map[string]time.Duration
	// ReadinessRequired names the hosts whose placement is gated on the
	// operator-supplied readiness signal. Nil when no host opts in.
	ReadinessRequired map[string]bool
	ReadinessMaxAge   time.Duration
	// MemoryOvercommit is every fleet host's resolved memory_overcommit
	// factor (default 1.0 for a host that does not set one).
	MemoryOvercommit map[string]float64
	// HostRoles is every configured fleet host's resolved role (defaulting
	// to hostRolePermanent), keyed by host name (agent-lcars#1696).
	HostRoles map[string]string
	Placement hostLoadPolicy
	Cooldown  time.Duration
	// RunnerCgroupParent is the resolved fleet.placement.runner_cgroup_parent:
	// defaultRunnerCgroupParent when the key is omitted, the configured value
	// when set, or "" when explicitly disabled. See FleetPlacementFile.
	RunnerCgroupParent string
	// DegradationLadder is the resolved fleet.placement.degradation_ladder
	// block (agent-lcars#1697). See Config.DegradationLadderEnabled for each
	// scale set's own resolved enablement.
	DegradationLadder resolvedDegradationLadder
	ScaleSets         []Config
	Weights           map[string]int
	Priorities        map[string]int
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
		// secrets but do disclose full fleet topology (host names,
		// per-scale-set runner counts, placement/drain state) with no
		// auth. A deployment that wants external scraping must opt in
		// explicitly via server.metrics_addr (e.g. "0.0.0.0:8080").
		c.Server.MetricsAddr = "127.0.0.1:8080"
	}
	if c.Server.LogLevel == "" {
		c.Server.LogLevel = "info"
	}
	if c.Server.LogFormat == "" {
		c.Server.LogFormat = "text"
	}
	if err := validateCheckpointPath(c.Server.StatePath); err != nil {
		return err
	}
	if c.Fleet.MaxRunners < 1 {
		return fmt.Errorf("fleet.max_runners must be at least 1")
	}
	if len(c.Fleet.Hosts) == 0 {
		return fmt.Errorf("fleet.hosts must not be empty")
	}

	r.RunnerLimits = map[string]int{}
	r.HostMetricsTimeouts = map[string]time.Duration{}
	r.MemoryOvercommit = map[string]float64{}
	r.HostRoles = map[string]string{}
	seenHosts := map[string]bool{}
	for i, h := range c.Fleet.Hosts {
		h.Name, h.Docker = strings.TrimSpace(h.Name), strings.TrimSpace(h.Docker)
		if h.Name == "" || h.Docker == "" {
			return fmt.Errorf("fleet.hosts[%d] requires name and docker", i)
		}
		if seenHosts[h.Name] {
			return fmt.Errorf("duplicate fleet host %q", h.Name)
		}
		seenHosts[h.Name] = true
		if h.RequireMains {
			if r.MainsRequired == nil {
				r.MainsRequired = map[string]bool{}
			}
			r.MainsRequired[h.Name] = true
		}
		if h.MetricsViaSSH {
			if r.MetricsViaSSH == nil {
				r.MetricsViaSSH = map[string]bool{}
			}
			r.MetricsViaSSH[h.Name] = true
		}
		if raw := strings.TrimSpace(h.MetricsTimeoutRaw); raw != "" {
			timeout, err := time.ParseDuration(raw)
			if err != nil || timeout <= 0 {
				return fmt.Errorf("host %q has invalid metrics_timeout %q", h.Name, h.MetricsTimeoutRaw)
			}
			r.HostMetricsTimeouts[h.Name] = timeout
		}
		if h.RequireReadiness {
			if r.ReadinessRequired == nil {
				r.ReadinessRequired = map[string]bool{}
			}
			r.ReadinessRequired[h.Name] = true
		}
		r.DockerHosts = append(r.DockerHosts, h.Name+"="+h.Docker)
		if h.RunnerLimit != nil {
			if *h.RunnerLimit < 1 {
				return fmt.Errorf("host %q runner_limit must be at least 1", h.Name)
			}
			r.RunnerLimits[h.Name] = *h.RunnerLimit
		}
		overcommit := h.MemoryOvercommit
		if overcommit == 0 {
			overcommit = 1.0
		}
		if math.IsNaN(overcommit) || math.IsInf(overcommit, 0) || overcommit < 1.0 || overcommit > 2.0 {
			return fmt.Errorf("host %q memory_overcommit must be at least 1.0 and at most 2.0", h.Name)
		}
		r.MemoryOvercommit[h.Name] = overcommit

		role := strings.TrimSpace(h.Role)
		if role == "" {
			role = hostRolePermanent
		}
		switch role {
		case hostRolePermanent, hostRoleOpportunistic, hostRoleMaintenance:
		default:
			return fmt.Errorf("host %q has invalid role %q (must be %s, %s, or %s)", h.Name, h.Role, hostRolePermanent, hostRoleOpportunistic, hostRoleMaintenance)
		}
		r.HostRoles[h.Name] = role
	}

	if err := validateFileMountAllowlist(c.Fleet.FileMountAllowlist); err != nil {
		return err
	}

	// Fail at load rather than at placement: a host asking to be gated on a
	// signal nobody publishes would otherwise pass --check-config and then
	// silently never receive runners, since the gate is fail-closed.
	if len(r.ReadinessRequired) > 0 {
		if strings.TrimSpace(c.Fleet.Placement.ReadinessMetricsURL) == "" {
			return fmt.Errorf("fleet.placement.readiness_metrics_url is required when any host sets require_readiness")
		}
		if strings.TrimSpace(c.Fleet.Placement.ReadinessMetric) == "" {
			return fmt.Errorf("fleet.placement.readiness_metric is required when any host sets require_readiness")
		}
	}
	if raw := strings.TrimSpace(c.Fleet.Placement.ReadinessMaxAge); raw != "" {
		age, err := time.ParseDuration(raw)
		if err != nil || age <= 0 {
			return fmt.Errorf("fleet.placement.readiness_max_age %q is not a positive duration", c.Fleet.Placement.ReadinessMaxAge)
		}
		r.ReadinessMaxAge = age
	}

	p := &c.Fleet.Placement
	defaults := defaultHostLoadPolicy()
	if p.HostMetricsURLTemplate == "" {
		p.HostMetricsURLTemplate = "http://%s.lan.jlapenna.net:9100/metrics"
	}
	if p.SparkMetricsURL == "" {
		p.SparkMetricsURL = "http://spark.lan.jlapenna.net:8000/metrics"
	}
	if len(p.HostMemoryExempt) == 0 {
		p.HostMemoryExempt = []string{"spark"}
	}
	if p.MemorySafetyMargin == 0 {
		p.MemorySafetyMargin = defaultMemorySafetyMargin
	}
	if math.IsNaN(p.MemorySafetyMargin) || math.IsInf(p.MemorySafetyMargin, 0) || p.MemorySafetyMargin < 0 || p.MemorySafetyMargin >= 1 {
		return fmt.Errorf("fleet.placement.memory_safety_margin must be greater than 0 and less than 1")
	}
	switch {
	case p.RunnerCgroupParent == nil:
		r.RunnerCgroupParent = defaultRunnerCgroupParent
	case strings.TrimSpace(*p.RunnerCgroupParent) == "":
		r.RunnerCgroupParent = ""
	default:
		r.RunnerCgroupParent = strings.TrimSpace(*p.RunnerCgroupParent)
	}
	if r.RunnerCgroupParent != "" && !runnerCgroupParentPattern.MatchString(r.RunnerCgroupParent) {
		return fmt.Errorf("fleet.placement.runner_cgroup_parent %q must be a bare systemd slice name ending in \".slice\", with no slashes", r.RunnerCgroupParent)
	}
	if strings.Count(p.HostMetricsURLTemplate, "%s") != 1 {
		return fmt.Errorf("fleet.placement.host_metrics_url_template must contain exactly one %%s")
	}
	setFloatDefault(&p.LoadSoft, defaults.loadSoft)
	setFloatDefault(&p.LoadBusy, defaults.loadBusy)
	setFloatDefault(&p.LoadHard, defaults.loadHard)
	setFloatDefault(&p.CPUSoft, defaults.cpuSoft)
	setFloatDefault(&p.CPUHard, defaults.cpuHard)
	setFloatDefault(&p.PSISoft, defaults.psiSoft)
	setFloatDefault(&p.PSIHard, defaults.psiHard)
	setFloatDefault(&p.MemorySoft, defaults.memorySoft)
	setFloatDefault(&p.MemoryHard, defaults.memoryHard)
	setFloatDefault(&p.SwapSoft, defaults.swapSoft)
	setFloatDefault(&p.SwapHard, defaults.swapHard)
	if p.TelemetryPenalty == 0 {
		p.TelemetryPenalty = defaults.telemetryPenalty
	}
	if p.OverloadCooldown == "" {
		p.OverloadCooldown = defaults.cooldown.String()
	}
	cooldown, err := time.ParseDuration(p.OverloadCooldown)
	if err != nil || cooldown <= 0 {
		return fmt.Errorf("invalid fleet.placement.overload_cooldown %q", p.OverloadCooldown)
	}
	r.Cooldown = cooldown
	r.Placement = hostLoadPolicy{
		loadSoft: p.LoadSoft, loadBusy: p.LoadBusy, loadHard: p.LoadHard,
		cpuSoft: p.CPUSoft, cpuHard: p.CPUHard,
		psiSoft: p.PSISoft, psiHard: p.PSIHard,
		memorySoft: p.MemorySoft, memoryHard: p.MemoryHard,
		swapSoft: p.SwapSoft, swapHard: p.SwapHard,
		cooldown: cooldown, telemetryPenalty: p.TelemetryPenalty,
	}
	if !(p.LoadSoft < p.LoadBusy && p.LoadBusy < p.LoadHard) ||
		!(p.CPUSoft < p.CPUHard && p.PSISoft < p.PSIHard && p.MemoryHard < p.MemorySoft && p.SwapSoft < p.SwapHard) {
		return fmt.Errorf("fleet placement thresholds are not ordered correctly")
	}

	dl := &p.DegradationLadder
	if dl.ObservedWindow == "" {
		dl.ObservedWindow = "168h"
	}
	if dl.ObservedQuantile == 0 {
		dl.ObservedQuantile = 0.95
	}
	if dl.ObservedQuery == "" {
		dl.ObservedQuery = defaultDegradationLadderQuery
	}
	if dl.RefreshInterval == "" {
		dl.RefreshInterval = "10m"
	}
	if math.IsNaN(dl.ObservedQuantile) || dl.ObservedQuantile <= 0 || dl.ObservedQuantile > 1 {
		return fmt.Errorf("fleet.placement.degradation_ladder.observed_quantile must be greater than 0 and at most 1")
	}
	ladderWindow, err := time.ParseDuration(dl.ObservedWindow)
	if err != nil || ladderWindow <= 0 {
		return fmt.Errorf("fleet.placement.degradation_ladder.observed_window %q must be a positive duration", dl.ObservedWindow)
	}
	ladderRefresh, err := time.ParseDuration(dl.RefreshInterval)
	if err != nil || ladderRefresh <= 0 {
		return fmt.Errorf("fleet.placement.degradation_ladder.refresh_interval %q must be a positive duration", dl.RefreshInterval)
	}
	if strings.TrimSpace(dl.PrometheusURL) != "" {
		if _, err := url.ParseRequestURI(dl.PrometheusURL); err != nil {
			return fmt.Errorf("fleet.placement.degradation_ladder.prometheus_url %q is invalid: %w", dl.PrometheusURL, err)
		}
	}
	ladderTemplate, err := template.New("degradation_ladder_observed_query").Parse(dl.ObservedQuery)
	if err != nil {
		return fmt.Errorf("fleet.placement.degradation_ladder.observed_query is not a valid template: %w", err)
	}
	r.DegradationLadder = resolvedDegradationLadder{
		Enabled: dl.Enabled, PrometheusURL: strings.TrimSpace(dl.PrometheusURL),
		Window: dl.ObservedWindow, Quantile: dl.ObservedQuantile, QueryTemplate: ladderTemplate,
		RefreshInterval: ladderRefresh, MaxSampleAge: 3 * ladderRefresh,
	}

	if len(c.ScaleSets) == 0 && len(c.Registrations) == 0 {
		return fmt.Errorf("at least one of scale_sets or registrations must be set")
	}
	r.Weights = map[string]int{}
	r.Priorities = map[string]int{}
	seenSets := map[string]bool{}
	maxSum := 0

	// The primary registration: today's shape, unchanged. github.url is only
	// required when it actually has scale sets to register -- a
	// registrations-only config (no homelab deployment does this today, but
	// nothing should require an unused top-level github.url) stays valid.
	if len(c.ScaleSets) > 0 {
		if strings.TrimSpace(c.GitHub.URL) == "" {
			return fmt.Errorf("github.url is required when scale_sets is set")
		}
		if c.GitHub.RunnerGroup == "" {
			c.GitHub.RunnerGroup = scaleset.DefaultRunnerGroup
		}
		built, sum, err := r.resolveScaleSets(primaryRegistrationName, c.GitHub.URL, c.GitHub.RunnerGroup, c.ScaleSets, seenSets)
		if err != nil {
			return err
		}
		r.ScaleSets = append(r.ScaleSets, built...)
		maxSum += sum
	}

	// Additional registrations (homelab#97): each is a distinct GitHub
	// account/repo + App, validated and resolved the same way, but with its
	// own label-uniqueness scope -- GitHub only forbids two scale sets
	// sharing a label WITHIN one registration/account, so two different
	// registrations may reuse a label string without conflict. Scale-set
	// NAMES, by contrast, must stay unique across the WHOLE process
	// (seenSets is not reset per registration): they key the shared
	// FleetCoordinator's weighted-fair gate, Prometheus label values, and
	// Docker container labels/names, none of which are registration-scoped.
	seenRegistrations := map[string]bool{}
	for i := range c.Registrations {
		reg := &c.Registrations[i]
		reg.Name = strings.TrimSpace(reg.Name)
		if reg.Name == "" {
			return fmt.Errorf("registrations[%d] requires a name", i)
		}
		if reg.Name == primaryRegistrationName {
			return fmt.Errorf("registrations[%d]: name %q is reserved for the top-level github/scale_sets block", i, reg.Name)
		}
		if seenRegistrations[reg.Name] {
			return fmt.Errorf("duplicate registration name %q", reg.Name)
		}
		seenRegistrations[reg.Name] = true
		if reg.Disabled {
			continue
		}
		reg.GitHub.URL = strings.TrimSpace(reg.GitHub.URL)
		if reg.GitHub.URL == "" {
			return fmt.Errorf("registration %q: github.url is required", reg.Name)
		}
		if reg.GitHub.RunnerGroup == "" {
			reg.GitHub.RunnerGroup = scaleset.DefaultRunnerGroup
		}
		reg.App.ClientID = strings.TrimSpace(reg.App.ClientID)
		if reg.App.ClientID == "" {
			return fmt.Errorf("registration %q: app.client_id is required", reg.Name)
		}
		if reg.App.InstallationID <= 0 {
			return fmt.Errorf("registration %q: app.installation_id must be a positive integer", reg.Name)
		}
		reg.App.PrivateKeyFile = strings.TrimSpace(reg.App.PrivateKeyFile)
		if reg.App.PrivateKeyFile == "" {
			return fmt.Errorf("registration %q: app.private_key_file is required", reg.Name)
		}
		if len(reg.ScaleSets) == 0 {
			return fmt.Errorf("registration %q: scale_sets must not be empty", reg.Name)
		}
		built, sum, err := r.resolveScaleSets(reg.Name, reg.GitHub.URL, reg.GitHub.RunnerGroup, reg.ScaleSets, seenSets)
		if err != nil {
			return err
		}
		r.ScaleSets = append(r.ScaleSets, built...)
		maxSum += sum
	}

	if len(r.ScaleSets) == 0 {
		return fmt.Errorf("at least one enabled scale set is required (every registration is disabled or empty)")
	}
	if c.Fleet.MaxRunners > maxSum {
		return fmt.Errorf("fleet.max_runners %d exceeds aggregate scale-set maximum %d", c.Fleet.MaxRunners, maxSum)
	}
	return nil
}

// resolveScaleSets validates and converts one registration's scale_sets:
// entries into runtime Config values. seenSets is shared across every
// registration (scale-set names are process-wide identifiers); label
// uniqueness is scoped to just this call's registrationName, matching
// GitHub's own per-account label constraint.
func (r *resolvedOrchestratorConfig) resolveScaleSets(registrationName, registrationURL, runnerGroup string, files []ScaleSetConfigFile, seenSets map[string]bool) ([]Config, int, error) {
	seenLabels := map[string]string{}
	maxSum := 0
	var out []Config
	for i := range files {
		s := files[i]
		s.Name, s.RunnerImage = strings.TrimSpace(s.Name), strings.TrimSpace(s.RunnerImage)
		if s.Name == "" || s.RunnerImage == "" {
			return nil, 0, fmt.Errorf("registration %q scale_sets[%d] requires name and runner_image", registrationName, i)
		}
		if isDigestImageReference(s.RunnerImage) {
			return nil, 0, fmt.Errorf("scale set %q runner_image must be a mutable tag, not a digest: %q", s.Name, s.RunnerImage)
		}
		if seenSets[s.Name] {
			return nil, 0, fmt.Errorf("duplicate scale set %q", s.Name)
		}
		seenSets[s.Name] = true
		if s.MaxRunners < 1 || s.MinRunners < 0 || s.MinRunners > s.MaxRunners {
			return nil, 0, fmt.Errorf("scale set %q has invalid min/max runners", s.Name)
		}
		if s.Weight == 0 {
			s.Weight = 1
		}
		if s.Weight < 1 {
			return nil, 0, fmt.Errorf("scale set %q weight must be at least 1", s.Name)
		}
		if s.Priority < 0 {
			return nil, 0, fmt.Errorf("scale set %q priority must be at least 0", s.Name)
		}
		if len(s.Labels) == 0 {
			return nil, 0, fmt.Errorf("scale set %q requires at least one label", s.Name)
		}
		for j, label := range s.Labels {
			label = strings.TrimSpace(label)
			if label == "" {
				return nil, 0, fmt.Errorf("scale set %q label %d is empty", s.Name, j)
			}
			key := strings.ToLower(label)
			if owner, ok := seenLabels[key]; ok {
				return nil, 0, fmt.Errorf("label %q is shared by scale sets %q and %q within registration %q", label, owner, s.Name, registrationName)
			}
			seenLabels[key] = s.Name
			s.Labels[j] = label
		}
		if s.RunnerMemory != "" {
			if n, err := units.RAMInBytes(s.RunnerMemory); err != nil || n <= 0 {
				return nil, 0, fmt.Errorf("scale set %q has invalid runner_memory %q", s.Name, s.RunnerMemory)
			}
		}
		if s.RunnerMemoryReservation != "" {
			if s.RunnerMemory == "" {
				return nil, 0, fmt.Errorf("scale set %q sets runner_memory_reservation %q without runner_memory", s.Name, s.RunnerMemoryReservation)
			}
			reservation, err := units.RAMInBytes(s.RunnerMemoryReservation)
			if err != nil || reservation <= 0 {
				return nil, 0, fmt.Errorf("scale set %q has invalid runner_memory_reservation %q", s.Name, s.RunnerMemoryReservation)
			}
			if limit, _ := units.RAMInBytes(s.RunnerMemory); reservation > limit {
				return nil, 0, fmt.Errorf("scale set %q runner_memory_reservation %q exceeds runner_memory %q", s.Name, s.RunnerMemoryReservation, s.RunnerMemory)
			}
		}
		if s.PidsLimit < 0 {
			return nil, 0, fmt.Errorf("scale set %q has invalid pids_limit %d", s.Name, s.PidsLimit)
		}
		if s.ShmSize != "" {
			if n, err := units.RAMInBytes(s.ShmSize); err != nil || n <= 0 {
				return nil, 0, fmt.Errorf("scale set %q has invalid shm_size %q", s.Name, s.ShmSize)
			}
		}
		fileMounts, err := parseFileMounts(s.Name, s.FileMounts, r.Raw.Fleet.FileMountAllowlist)
		if err != nil {
			return nil, 0, err
		}
		maxSum += s.MaxRunners
		r.Weights[s.Name] = s.Weight
		r.Priorities[s.Name] = s.Priority
		// A lane is ladder-enabled iff its own override is true, or the
		// override is unset and the fleet-wide default is true -- an
		// explicit false always wins over the fleet default
		// (agent-lcars#1697, docs/fleet-scheduler-redesign.md#D).
		ladderEnabled := r.DegradationLadder.Enabled
		if s.DegradationLadder != nil {
			ladderEnabled = *s.DegradationLadder
		}
		out = append(out, Config{
			RegistrationURL: registrationURL, RunnerGroup: runnerGroup, RegistrationName: registrationName,
			ScaleSetName: s.Name, Labels: s.Labels, RunnerImage: s.RunnerImage,
			RunnerMemory: s.RunnerMemory, RunnerMemoryReservation: s.RunnerMemoryReservation, RunnerPidsLimit: s.PidsLimit, RunnerShmSize: s.ShmSize,
			MinRunners: s.MinRunners, MaxRunners: s.MaxRunners,
			FileMounts: fileMounts,
			LogLevel:   r.Raw.Server.LogLevel, LogFormat: r.Raw.Server.LogFormat,
			DegradationLadderEnabled: ladderEnabled,
		})
	}
	return out, maxSum, nil
}

func setFloatDefault(dst *float64, fallback float64) {
	if *dst == 0 {
		*dst = fallback
	}
}

// loadCredentials resolves GitHub App auth for every registration's scale
// sets: the primary (top-level github/scale_sets) registration from the
// environment, exactly as before homelab#97, and every additional
// registrations[] entry from its own (non-secret) app.client_id/
// installation_id plus its private_key_file's contents. File reads are
// deliberately deferred to here (not resolve()) so config-shape validation
// never depends on filesystem/mount state, matching the existing env-var
// credential path.
func (r *resolvedOrchestratorConfig) loadCredentials() error {
	needsPrimary := false
	for i := range r.ScaleSets {
		if r.ScaleSets[i].RegistrationName == primaryRegistrationName {
			needsPrimary = true
			break
		}
	}
	if needsPrimary {
		clientID := strings.TrimSpace(os.Getenv("APP_CLIENT_ID"))
		installationRaw := strings.TrimSpace(os.Getenv("APP_INSTALLATION_ID"))
		keyPath := strings.TrimSpace(os.Getenv("APP_PRIVATE_KEY_FILE"))
		if clientID == "" || installationRaw == "" || keyPath == "" {
			return fmt.Errorf("APP_CLIENT_ID, APP_INSTALLATION_ID, and APP_PRIVATE_KEY_FILE are required")
		}
		installationID, err := strconv.ParseInt(installationRaw, 10, 64)
		if err != nil || installationID <= 0 {
			return fmt.Errorf("APP_INSTALLATION_ID must be a positive integer")
		}
		key, err := os.ReadFile(keyPath)
		if err != nil {
			return fmt.Errorf("reading APP_PRIVATE_KEY_FILE: %w", err)
		}
		for i := range r.ScaleSets {
			if r.ScaleSets[i].RegistrationName != primaryRegistrationName {
				continue
			}
			r.ScaleSets[i].GitHubApp = scaleset.GitHubAppAuth{
				ClientID: clientID, InstallationID: installationID, PrivateKey: string(key),
			}
		}
	}

	for _, reg := range r.Raw.Registrations {
		if reg.Disabled {
			continue
		}
		key, err := os.ReadFile(reg.App.PrivateKeyFile)
		if err != nil {
			return fmt.Errorf("registration %q: reading app.private_key_file: %w", reg.Name, err)
		}
		auth := scaleset.GitHubAppAuth{
			ClientID: reg.App.ClientID, InstallationID: reg.App.InstallationID, PrivateKey: string(key),
		}
		matched := false
		for i := range r.ScaleSets {
			if r.ScaleSets[i].RegistrationName == reg.Name {
				r.ScaleSets[i].GitHubApp = auth
				matched = true
			}
		}
		if !matched {
			return fmt.Errorf("registration %q: no resolved scale sets (this is a bug in resolve())", reg.Name)
		}
	}
	return nil
}

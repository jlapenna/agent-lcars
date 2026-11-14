package main

import (
	"fmt"
	"path"
	"regexp"
	"sort"
	"strings"

	core "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	"k8s.io/apimachinery/pkg/util/validation"
)

// queueRunLeaseSeconds mirrors the Work API's RUN_LEASE_MS
// (libs/orchestrator/src/decide.ts): a claimed run's lease is two hours. Every
// queue Job's pod deadline sits at or below it, and a declared runtime's
// strictly below it, so the kubelet ends an attempt before its lease can
// expire under a still-running worker.
const queueRunLeaseSeconds = 2 * 60 * 60

// queueRuntimeSecretMountPath is where a runtime Job sees its declared zone
// Secret items, read-only. Nothing else from any Secret is mounted.
const queueRuntimeSecretMountPath = "/run/claw-secrets"

// queueRuntimeWorkMountPath is the runtime Job's writable emptyDir scratch
// (OpenClaw state, workspace copy, HOME=/work/home). Its sizeLimit is the
// declared ephemeral-storage limit and it is discarded with the Pod. /tmp is a
// second emptyDir, so the container keeps a read-only root filesystem.
const queueRuntimeWorkMountPath = "/work"

// queueRuntimeNamePattern restricts declared runtimes to the claw adapter's
// pipelines for now (claw-investigator, later claw-oncall). The pattern keeps
// a runtime from shadowing any legacy provider pipeline.
var queueRuntimeNamePattern = regexp.MustCompile(`^claw-[a-z0-9-]+$`)

// queueRuntimeImagePattern requires an image pinned by digest. A tag can move
// under a running deployment; a digest is the reviewed artifact.
var queueRuntimeImagePattern = regexp.MustCompile(`^[^@\s]+@sha256:[a-f0-9]{64}$`)

// queueRuntimeCeiling is the per-Job k3s ceiling every declared runtime must
// fit (requests equal limits): 2 CPU, 6 GiB memory, 40 GiB ephemeral storage.
var queueRuntimeCeiling = map[string]string{"cpu": "2", "memory": "6Gi", "ephemeral-storage": "40Gi"}

type queueRuntimeSecretItem struct {
	Key  string `yaml:"key"`
	Path string `yaml:"path"`
}

type queueRuntimeEnv struct {
	Name  string `yaml:"name"`
	Value string `yaml:"value"`
}

// queueRuntimeConfig is one deployment-declared execution runtime, keyed by
// the claimed pipeline name. Everything here comes from the executor's own
// trusted configuration file; no field is ever derived from Work input.
type queueRuntimeConfig struct {
	Image    string            `yaml:"image"`
	Requests map[string]string `yaml:"requests"`
	Limits   map[string]string `yaml:"limits"`
	// ActiveDeadlineSeconds is the Pod's kubelet deadline; it must be strictly
	// below the two-hour run lease.
	ActiveDeadlineSeconds int64 `yaml:"active_deadline_seconds"`
	// SecretName and Items select exactly which keys of which namespace
	// Secret the Job mounts at queueRuntimeSecretMountPath. The launcher
	// exports items whose path starts with env/ as environment variables.
	SecretName string                   `yaml:"secret_name"`
	Items      []queueRuntimeSecretItem `yaml:"items"`
	// Agent optionally mounts the zone-pinned agent definition (OpenClaw
	// config.json, approvals.json, workspace/ files) from a ConfigMap,
	// read-only at queueRuntimeAgentMountPath.
	Agent *queueRuntimeAgentConfig `yaml:"agent,omitempty"`
	Env   []queueRuntimeEnv        `yaml:"env,omitempty"`
}

// queueRuntimeAgentConfig selects the ConfigMap holding an agent definition.
// ConfigMap keys cannot contain '/', so items map flat keys to nested paths
// (workspace-AGENTS.md -> workspace/AGENTS.md); without items every key is
// projected at its own name.
type queueRuntimeAgentConfig struct {
	ConfigMap string                   `yaml:"config_map"`
	Items     []queueRuntimeSecretItem `yaml:"items,omitempty"`
}

// queueRuntimeAgentMountPath is where the agent definition ConfigMap appears.
const queueRuntimeAgentMountPath = "/claw/agent"

// queueRuntimeTurnMargin is how far inside the Pod deadline the launcher's
// outer turn deadline (CLAW_TURN_DEADLINE_SECONDS) sits, so a timed-out turn
// can still be reported before the kubelet kills the Pod.
const queueRuntimeTurnMargin = 300

// queueRuntimeMinTurn is the smallest outer turn deadline handed to a
// launcher; active_deadline_seconds must leave at least this after the margin.
const queueRuntimeMinTurn = 60

// turnDeadlineSeconds is the launcher's outer turn deadline: the Pod deadline
// minus queueRuntimeTurnMargin. validate guarantees it is at least
// queueRuntimeMinTurn.
func (r queueRuntimeConfig) turnDeadlineSeconds() int64 {
	return max(r.ActiveDeadlineSeconds-queueRuntimeTurnMargin, queueRuntimeMinTurn)
}

func (r queueRuntimeConfig) validate(name, legacyCredentialsSecret string) error {
	if !queueRuntimeNamePattern.MatchString(name) || len(name) > validation.DNS1123LabelMaxLength {
		return fmt.Errorf("kubernetes runtime name %q must match %s", name, queueRuntimeNamePattern)
	}
	prefix := "kubernetes runtimes." + name
	if !queueRuntimeImagePattern.MatchString(r.Image) {
		return fmt.Errorf("%s.image must be pinned by digest (<repository>@sha256:<64 hex>)", prefix)
	}
	for _, values := range []map[string]string{r.Requests, r.Limits} {
		for resourceName := range values {
			if _, ok := queueRuntimeCeiling[resourceName]; !ok {
				return fmt.Errorf("%s: unsupported resource %s", prefix, resourceName)
			}
		}
	}
	for resourceName, ceiling := range queueRuntimeCeiling {
		request, requestErr := resource.ParseQuantity(r.Requests[resourceName])
		limit, limitErr := resource.ParseQuantity(r.Limits[resourceName])
		if requestErr != nil || limitErr != nil || request.Sign() <= 0 {
			return fmt.Errorf("%s requires positive requests.%s and limits.%s", prefix, resourceName, resourceName)
		}
		if request.Cmp(limit) != 0 {
			return fmt.Errorf("%s requests.%s must equal limits.%s", prefix, resourceName, resourceName)
		}
		if limit.Cmp(resource.MustParse(ceiling)) > 0 {
			return fmt.Errorf("%s limits.%s exceeds the %s per-Job ceiling", prefix, resourceName, ceiling)
		}
	}
	if r.ActiveDeadlineSeconds < queueRuntimeTurnMargin+queueRuntimeMinTurn || r.ActiveDeadlineSeconds >= queueRunLeaseSeconds {
		return fmt.Errorf("%s.active_deadline_seconds must be at least %d and below the %d s run lease", prefix, queueRuntimeTurnMargin+queueRuntimeMinTurn, queueRunLeaseSeconds)
	}
	if len(validation.IsDNS1123Subdomain(r.SecretName)) != 0 {
		return fmt.Errorf("%s.secret_name must be a valid Secret name", prefix)
	}
	if r.SecretName == legacyCredentialsSecret {
		// The legacy credential Secret holds the telemetry writer and provider
		// keys; a runtime must never be able to select from it.
		return fmt.Errorf("%s.secret_name must not be the legacy credentials_secret", prefix)
	}
	if len(r.Items) == 0 {
		return fmt.Errorf("%s.items must declare at least one Secret key", prefix)
	}
	if err := validateQueueRuntimeItems(prefix+".items", r.Items); err != nil {
		return err
	}
	if r.Agent != nil {
		if len(validation.IsDNS1123Subdomain(r.Agent.ConfigMap)) != 0 {
			return fmt.Errorf("%s.agent.config_map must be a valid ConfigMap name", prefix)
		}
		if err := validateQueueRuntimeItems(prefix+".agent.items", r.Agent.Items); err != nil {
			return err
		}
	}
	// The declared env list and every Secret item under env/ (which the claw
	// launcher exports as an environment variable named by the rest of the
	// path) share one namespace: neither may set a reserved name or repeat
	// the other.
	envNames := map[string]bool{}
	claim := func(source, name string) error {
		if len(validation.IsEnvVarName(name)) != 0 {
			return fmt.Errorf("%s %s name %q is not a valid environment variable name", prefix, source, name)
		}
		if queueRuntimeEnvReserved(name) {
			return fmt.Errorf("%s %s name %q is reserved for the executor or launcher", prefix, source, name)
		}
		if envNames[name] {
			return fmt.Errorf("%s %s repeats environment variable %q", prefix, source, name)
		}
		envNames[name] = true
		return nil
	}
	for _, env := range r.Env {
		if err := claim("env", env.Name); err != nil {
			return err
		}
	}
	for _, item := range r.Items {
		name, ok := strings.CutPrefix(item.Path, queueRuntimeEnvItemPrefix)
		if !ok {
			continue
		}
		if strings.Contains(name, "/") {
			return fmt.Errorf("%s.items path %q must name exactly one variable after %s", prefix, item.Path, queueRuntimeEnvItemPrefix)
		}
		if err := claim("items "+queueRuntimeEnvItemPrefix, name); err != nil {
			return err
		}
	}
	return nil
}

// queueRuntimeEnvItemPrefix marks Secret items the claw launcher exports as
// environment variables (env/LITELLM_API_KEY -> LITELLM_API_KEY).
const queueRuntimeEnvItemPrefix = "env/"

// queueRuntimeEnvReserved names the variables only the executor (LCARS_*,
// RUNNER_MODE, CLAW_TURN_DEADLINE_SECONDS) or the claw launcher (OPENCLAW_*,
// NODE_OPTIONS, PATH, HOME) may set.
func queueRuntimeEnvReserved(name string) bool {
	switch name {
	case "RUNNER_MODE", "CLAW_TURN_DEADLINE_SECONDS", "NODE_OPTIONS", "PATH", "HOME":
		return true
	}
	return strings.HasPrefix(name, "LCARS_") || strings.HasPrefix(name, "OPENCLAW_")
}

func validateQueueRuntimeItems(field string, items []queueRuntimeSecretItem) error {
	keys, paths := map[string]bool{}, map[string]bool{}
	for _, item := range items {
		if len(validation.IsConfigMapKey(item.Key)) != 0 {
			return fmt.Errorf("%s key %q is not a valid key", field, item.Key)
		}
		if !queueRuntimeItemPathValid(item.Path) {
			return fmt.Errorf("%s path %q must be a clean relative path without '..'", field, item.Path)
		}
		if keys[item.Key] || paths[item.Path] {
			return fmt.Errorf("%s must not repeat a key or path", field)
		}
		keys[item.Key], paths[item.Path] = true, true
	}
	// A file cannot also be a directory of another item's file.
	for parent := range paths {
		for child := range paths {
			if strings.HasPrefix(child, parent+"/") {
				return fmt.Errorf("%s path %q is a parent of %q", field, parent, child)
			}
		}
	}
	return nil
}

func queueRuntimeItemPathValid(p string) bool {
	if p == "" || strings.HasPrefix(p, "/") || strings.ContainsAny(p, "\\\x00") || path.Clean(p) != p {
		return false
	}
	// Kubernetes refuses a projected path whose first element starts with
	// "..", (its atomic writer owns ..data and ..<timestamp>); refuse every
	// such segment here so the mistake fails startup, not a Job create.
	for _, segment := range strings.Split(p, "/") {
		if segment == "." || strings.HasPrefix(segment, "..") {
			return false
		}
	}
	return true
}

// admissionShape is the resource shape the pre-claim capacity check (and the
// startup preflight's free-room read) requires of one node. The claimed
// pipeline, and therefore the run's shape, is known only after the claim, so
// this is the per-resource maximum over every shape this executor serves: the
// legacy requests unless runtimes_only, plus every declared runtime. It never
// admits a claim whose eventual shape could not fit any eligible node.
func (c *queueKubernetesConfig) admissionShape() core.ResourceList {
	out := core.ResourceList{}
	merge := func(values map[string]string) {
		for name, quantity := range queueResources(values) {
			if current, ok := out[name]; !ok || quantity.Cmp(current) > 0 {
				out[name] = quantity
			}
		}
	}
	if !c.RuntimesOnly {
		merge(c.Requests)
	}
	for _, name := range c.runtimeNames() {
		merge(c.Runtimes[name].Requests)
	}
	return out
}

func (c *queueKubernetesConfig) runtimeNames() []string {
	names := make([]string, 0, len(c.Runtimes))
	for name := range c.Runtimes {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// runtimeJobShape builds the pipeline-specific half of a declared runtime's
// Job: its pinned image (its own entrypoint; no command override), resources,
// deadline, LCARS run environment plus the declared static environment, only
// the declared zone Secret items and the optional agent ConfigMap. It
// deliberately carries no telemetry writer, provider key, Hindsight token or
// Codex volume.
func (q *kubernetesQueue) runtimeJobShape(l directRunnerLaunch, rt queueRuntimeConfig, runTokenEnv core.EnvVar) (queueJobShape, error) {
	if l.providerAuth != "" {
		return queueJobShape{}, fmt.Errorf("unsupported provider auth %q for runtime pipeline %q", l.providerAuth, l.pipeline)
	}
	mode := int32(0440)
	env := []core.EnvVar{
		{Name: "RUNNER_MODE", Value: "claw"},
		{Name: "LCARS_RUN_ID", Value: l.runID},
		{Name: "LCARS_CONSOLE_URL", Value: l.consoleURL},
		runTokenEnv,
		{Name: "CLAW_TURN_DEADLINE_SECONDS", Value: fmt.Sprint(rt.turnDeadlineSeconds())},
	}
	for _, declared := range rt.Env {
		env = append(env, core.EnvVar{Name: declared.Name, Value: declared.Value})
	}
	// The scratch emptyDir is bounded by the runtime's whole ephemeral-storage
	// limit; the kubelet evicts the Pod if it is exceeded.
	scratch := queueResources(rt.Limits)[core.ResourceEphemeralStorage]
	volumes := []core.Volume{
		{Name: "claw-secrets", VolumeSource: core.VolumeSource{Secret: &core.SecretVolumeSource{SecretName: rt.SecretName, Items: queueRuntimeKeyToPaths(rt.Items), DefaultMode: &mode}}},
		{Name: "work", VolumeSource: core.VolumeSource{EmptyDir: &core.EmptyDirVolumeSource{SizeLimit: &scratch}}},
		{Name: "tmp", VolumeSource: core.VolumeSource{EmptyDir: &core.EmptyDirVolumeSource{}}},
	}
	mounts := []core.VolumeMount{
		{Name: "claw-secrets", MountPath: queueRuntimeSecretMountPath, ReadOnly: true},
		{Name: "work", MountPath: queueRuntimeWorkMountPath},
		{Name: "tmp", MountPath: "/tmp"},
	}
	if rt.Agent != nil {
		// Agent tools (tools/*) run by path under the exec allowlist, so the
		// definition is read+execute with no write. Secrets stay 0440 above:
		// zone credentials are never executable.
		agentMode := int32(0555)
		volumes = append(volumes, core.Volume{Name: "claw-agent", VolumeSource: core.VolumeSource{ConfigMap: &core.ConfigMapVolumeSource{LocalObjectReference: core.LocalObjectReference{Name: rt.Agent.ConfigMap}, Items: queueRuntimeKeyToPaths(rt.Agent.Items), DefaultMode: &agentMode}}})
		mounts = append(mounts, core.VolumeMount{Name: "claw-agent", MountPath: queueRuntimeAgentMountPath, ReadOnly: true})
	}
	return queueJobShape{
		container: "claw", image: rt.Image, pullPolicy: core.PullIfNotPresent,
		env: env, volumes: volumes, mounts: mounts, readOnlyRootFilesystem: true,
		requests: rt.Requests, limits: rt.Limits, deadline: rt.ActiveDeadlineSeconds,
	}, nil
}

func queueRuntimeKeyToPaths(items []queueRuntimeSecretItem) []core.KeyToPath {
	if len(items) == 0 {
		return nil
	}
	out := make([]core.KeyToPath, 0, len(items))
	for _, item := range items {
		out = append(out, core.KeyToPath{Key: item.Key, Path: item.Path})
	}
	return out
}

// queueJobShape is the pipeline-specific part of a queue Job; job() wraps it
// in the shared single-attempt, suspended, non-root Job template.
type queueJobShape struct {
	container        string
	image            string
	pullPolicy       core.PullPolicy
	env              []core.EnvVar
	volumes          []core.Volume
	mounts           []core.VolumeMount
	requests, limits map[string]string
	deadline         int64
	// readOnlyRootFilesystem is set for runtimes, whose only writable paths
	// are their declared emptyDirs.
	readOnlyRootFilesystem bool
}

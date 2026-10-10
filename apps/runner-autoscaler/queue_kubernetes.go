package main

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	auth "k8s.io/api/authorization/v1"
	batch "k8s.io/api/batch/v1"
	core "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/resource"
	meta "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/apimachinery/pkg/util/validation"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
	"k8s.io/client-go/util/retry"
	podresource "k8s.io/component-helpers/resource"
	"k8s.io/klog/v2"
)

const queueJobLabel = "agent-lcars.queue-job"
const queueRunAnnotation = "agent-lcars.run-id"

// queueRunnerAnnotation records the runner name the run was claimed under,
// which its exit report must repeat (see directRunnerLaunch.runner).
const queueRunnerAnnotation = "agent-lcars.claimed-by"

type queueToleration struct {
	Key      string                  `yaml:"key"`
	Operator core.TolerationOperator `yaml:"operator"`
	Value    string                  `yaml:"value,omitempty"`
	Effect   core.TaintEffect        `yaml:"effect"`
}

type queueKubernetesConfig struct {
	Capacity          *queueCapacityConfig `yaml:"capacity,omitempty"`
	Namespace         string               `yaml:"namespace"`
	Kubeconfig        string               `yaml:"kubeconfig,omitempty"`
	CredentialsSecret string               `yaml:"credentials_secret"`
	ServiceAccount    string               `yaml:"service_account"`
	MaxConcurrent     int                  `yaml:"max_concurrent"`
	NodeSelector      map[string]string    `yaml:"node_selector"`
	Tolerations       []queueToleration    `yaml:"tolerations,omitempty"`
	Requests          map[string]string    `yaml:"requests"`
	Limits            map[string]string    `yaml:"limits"`
}

func (c *queueKubernetesConfig) validate() error {
	if err := c.Capacity.validate(); err != nil {
		return err
	}
	if c.Namespace == "" || c.CredentialsSecret == "" || c.ServiceAccount == "" || c.MaxConcurrent < 1 || len(c.NodeSelector) == 0 {
		return fmt.Errorf("kubernetes requires namespace, credentials_secret, service_account, positive max_concurrent and explicit node_selector")
	}
	for _, t := range c.Tolerations {
		// Wildcard tolerations would bypass maintenance/readiness gates.
		if t.Key == "" || (t.Operator != core.TolerationOpExists && t.Operator != core.TolerationOpEqual) || t.Effect != core.TaintEffectNoSchedule {
			return fmt.Errorf("kubernetes tolerations require an explicit key, Exists/Equal operator and NoSchedule effect")
		}
		if len(validation.IsQualifiedName(t.Key)) != 0 || len(validation.IsValidLabelValue(t.Value)) != 0 || (t.Operator == core.TolerationOpExists && t.Value != "") {
			return fmt.Errorf("kubernetes tolerations require a valid key/value and an empty value for Exists")
		}
	}
	for _, values := range []map[string]string{c.Requests, c.Limits} {
		for name, value := range values {
			if name != "cpu" && name != "memory" && name != "ephemeral-storage" {
				return fmt.Errorf("unsupported kubernetes resource %s", name)
			}
			if _, err := resource.ParseQuantity(value); err != nil {
				return fmt.Errorf("invalid kubernetes resource %s", name)
			}
		}
	}
	for _, name := range []string{"cpu", "memory", "ephemeral-storage"} {
		request, err := resource.ParseQuantity(c.Requests[name])
		if err != nil || request.Sign() <= 0 {
			return fmt.Errorf("kubernetes requests.%s must be a positive quantity", name)
		}
		limit, err := resource.ParseQuantity(c.Limits[name])
		if err != nil || limit.Cmp(request) < 0 {
			return fmt.Errorf("kubernetes limits.%s must be at least its request", name)
		}
	}
	return nil
}

func validateKubernetesQueueEnvironment(c *queueKubernetesConfig) error {
	if err := c.validate(); err != nil {
		return err
	}
	console, err := url.Parse(strings.TrimSpace(os.Getenv("LCARS_CONSOLE_URL")))
	if err != nil || console.Host == "" || (console.Scheme != "https" && console.Scheme != "http") {
		return fmt.Errorf("LCARS_CONSOLE_URL must be an absolute HTTP(S) URL")
	}
	if strings.TrimSpace(os.Getenv("GOOGLE_APPLICATION_CREDENTIALS")) == "" {
		return fmt.Errorf("GOOGLE_APPLICATION_CREDENTIALS is required for the queue executor")
	}
	_, err = directRunnerImage()
	if err != nil {
		return err
	}
	if _, err := directRunnerWorkerPolicyProviders(); err != nil {
		return err
	}
	_, err = queueKubernetesRESTConfig(c)
	return err
}

func queueKubernetesRESTConfig(c *queueKubernetesConfig) (*rest.Config, error) {
	var cfg *rest.Config
	var err error
	if c.Kubeconfig != "" {
		cfg, err = clientcmd.BuildConfigFromFlags("", c.Kubeconfig)
	} else {
		cfg, err = rest.InClusterConfig()
	}
	if err != nil {
		return nil, fmt.Errorf("loading Kubernetes queue credentials: %w", err)
	}
	cfg.Timeout = 10 * time.Second
	return cfg, nil
}

// This selector comes only from the trusted executor deployment, never a run
// brief. An empty value explicitly keeps even image-provided defaults disabled.
func directRunnerWorkerPolicyProviders() (string, error) {
	raw := strings.TrimSpace(os.Getenv("LCARS_WORKER_POLICY_PROVIDERS"))
	if raw == "" {
		return "", nil
	}
	seen := map[string]bool{}
	providers := []string{}
	for _, entry := range strings.Split(raw, ",") {
		provider := strings.TrimSpace(entry)
		switch provider {
		case "claude", "codex", "opencode":
		default:
			return "", fmt.Errorf("LCARS_WORKER_POLICY_PROVIDERS must contain only claude, codex, or opencode")
		}
		if !seen[provider] {
			seen[provider] = true
			providers = append(providers, provider)
		}
	}
	sort.Strings(providers)
	return strings.Join(providers, ","), nil
}

type kubernetesQueue struct {
	config                queueKubernetesConfig
	client                kubernetes.Interface
	workerPolicyProviders string
	image                 string
	logger                *slog.Logger
	mu                    sync.Mutex
	held                  int
	capacity              *queueCapacityClient
	receiptMu             sync.Mutex
	// verifyRun checks the existing token against the Work API's read-only
	// brief route, which fences settled runs and expired leases.
	verifyRun func(context.Context, string, string) error
	// exits receives every terminated queue Job this executor's inventory
	// reads observe (nil disables reporting). See runExitReporter.
	exits *runExitReporter
}

func newKubernetesQueue(ctx context.Context, c queueKubernetesConfig, logger *slog.Logger) (*kubernetesQueue, error) {
	cfg, err := queueKubernetesRESTConfig(&c)
	if err != nil {
		return nil, err
	}
	client, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		return nil, err
	}
	image, err := directRunnerImage()
	if err != nil {
		return nil, err
	}
	providers, err := directRunnerWorkerPolicyProviders()
	if err != nil {
		return nil, err
	}
	q := &kubernetesQueue{config: c, client: client, image: image, logger: logger, workerPolicyProviders: providers,
		verifyRun: queueRunFence(strings.TrimSpace(os.Getenv("LCARS_CONSOLE_URL")))}
	if err := q.preflight(ctx); err != nil {
		return nil, err
	}
	return q, nil
}

func (q *kubernetesQueue) preflight(ctx context.Context) error {
	client, c := q.client, q.config
	// Fail before claiming if credentials or API inventory cannot be read. Do
	// not include Secret data in diagnostics.
	secret, err := client.CoreV1().Secrets(c.Namespace).Get(ctx, c.CredentialsSecret, meta.GetOptions{})
	if err != nil {
		return fmt.Errorf("reading queue credential Secret: %w", err)
	}
	for _, key := range []string{"telemetry-writer.json", "claude-code-oauth-token", "opencode-llm-api-key"} {
		if len(secret.Data[key]) == 0 {
			return fmt.Errorf("queue credential Secret missing nonempty key %s", key)
		}
	}
	if _, err := client.CoreV1().ServiceAccounts(c.Namespace).Get(ctx, c.ServiceAccount, meta.GetOptions{}); err != nil {
		return fmt.Errorf("reading queue worker ServiceAccount: %w", err)
	}
	for _, permission := range []auth.ResourceAttributes{
		{Namespace: c.Namespace, Group: "batch", Resource: "jobs", Verb: "create"},
		{Namespace: c.Namespace, Group: "batch", Resource: "jobs", Verb: "update"},
		{Namespace: c.Namespace, Group: "batch", Resource: "jobs", Verb: "delete"},
		{Namespace: c.Namespace, Resource: "secrets", Verb: "create"},
	} {
		check, err := client.AuthorizationV1().SelfSubjectAccessReviews().Create(ctx, &auth.SelfSubjectAccessReview{Spec: auth.SelfSubjectAccessReviewSpec{ResourceAttributes: &permission}}, meta.CreateOptions{})
		if err != nil {
			return fmt.Errorf("checking queue API permissions: %w", err)
		}
		if !check.Status.Allowed {
			return fmt.Errorf("queue API requires %s on %s", permission.Verb, permission.Resource)
		}
	}
	if _, err := q.activeCount(ctx); err != nil {
		return err
	}
	if _, err := q.readyNodes(ctx); err != nil {
		return err
	}
	return nil
}

func queueJobTerminal(j batch.Job) bool {
	for _, c := range j.Status.Conditions {
		if (c.Type == batch.JobComplete || c.Type == batch.JobFailed) && c.Status == core.ConditionTrue {
			return true
		}
	}
	return false
}
func (q *kubernetesQueue) activeCount(ctx context.Context) (int, error) {
	jobs, err := q.client.BatchV1().Jobs(q.config.Namespace).List(ctx, meta.ListOptions{LabelSelector: queueJobLabel + "=true"})
	if err != nil {
		return 0, err
	}
	n := 0
	for _, j := range jobs.Items {
		if q.capacity != nil && j.Annotations[queueBarrierAnnotation] != "" {
			if err := q.verifyRetiredBarrier(ctx, &j); err != nil {
				return 0, err
			}
			continue
		}
		if !queueJobTerminal(j) {
			n++
			continue
		}
		// This read already sees every queue Job's terminal condition (the
		// Job controller sets it when the worker Pod ends, including on
		// eviction, OOM, node loss, and the active deadline). Hand each one
		// to the exit reporter instead of leaving a dead worker's run held
		// until its lease expires. Only a Job whose name is derived from its
		// own run annotation identifies a run.
		if runID := j.Annotations[queueRunAnnotation]; runID != "" && j.Name == queueJobName(runID) {
			q.exits.observeTerminated(runID, j.Annotations[queueRunnerAnnotation])
		}
	}
	return n, nil
}
func (q *kubernetesQueue) tolerations() []core.Toleration {
	out := []core.Toleration{}
	for _, t := range q.config.Tolerations {
		out = append(out, core.Toleration{Key: t.Key, Operator: t.Operator, Value: t.Value, Effect: t.Effect})
	}
	return out
}
func (q *kubernetesQueue) readyNodes(ctx context.Context) (bool, error) {
	return q.nodesFit(ctx, true)
}

func (q *kubernetesQueue) nodesFit(ctx context.Context, requireFree bool) (bool, error) {
	nodes, err := q.client.CoreV1().Nodes().List(ctx, meta.ListOptions{LabelSelector: labels.Set(q.config.NodeSelector).String()})
	if err != nil {
		return false, err
	}
	pods, err := q.client.CoreV1().Pods("").List(ctx, meta.ListOptions{})
	if err != nil {
		return false, err
	}
	for _, node := range nodes.Items {
		if node.Spec.Unschedulable || node.DeletionTimestamp != nil {
			continue
		}
		ready := false
		for _, c := range node.Status.Conditions {
			if c.Type == core.NodeReady && c.Status == core.ConditionTrue {
				ready = true
			}
		}
		if !ready {
			continue
		}
		allowed := true
		for _, taint := range node.Spec.Taints {
			if taint.Effect != core.TaintEffectNoSchedule && taint.Effect != core.TaintEffectNoExecute {
				continue
			}
			tolerated := false
			for _, t := range q.tolerations() {
				if t.ToleratesTaint(klog.FromContext(ctx), &taint, false) {
					tolerated = true
				}
			}
			if !tolerated {
				allowed = false
			}
		}
		// Account exactly like the scheduler: max regular/init requests,
		// restartable sidecars, pod-level requests and pod overhead. Failed and
		// succeeded pods release capacity; terminating pods still occupy it.
		available := node.Status.Allocatable.DeepCopy()
		for _, pod := range pods.Items {
			if !requireFree {
				break
			}
			if pod.Spec.NodeName != node.Name || pod.Status.Phase == core.PodSucceeded || pod.Status.Phase == core.PodFailed {
				continue
			}
			for name, used := range podresource.PodRequests(&pod, podresource.PodResourcesOptions{}) {
				remaining := available[name]
				remaining.Sub(used)
				available[name] = remaining
			}
			remaining := available[core.ResourcePods]
			remaining.Sub(resource.MustParse("1"))
			available[core.ResourcePods] = remaining
		}
		for name, requested := range queueResources(q.config.Requests) {
			remaining := available[name]
			if remaining.Cmp(requested) < 0 {
				allowed = false
			}
		}
		remainingPods := available[core.ResourcePods]
		if remainingPods.Cmp(resource.MustParse("1")) < 0 {
			allowed = false
		}
		if allowed {
			return true, nil
		}
	}
	return false, nil
}

// Keep at most one real claim waiting for scheduler placement. A Job whose
// Pod has not appeared yet counts too; API errors never grant admission.
func (q *kubernetesQueue) pendingPlacement(ctx context.Context) (bool, error) {
	jobs, err := q.client.BatchV1().Jobs(q.config.Namespace).List(ctx, meta.ListOptions{LabelSelector: queueJobLabel + "=true"})
	if err != nil {
		return false, err
	}
	pods, err := q.client.CoreV1().Pods(q.config.Namespace).List(ctx, meta.ListOptions{})
	if err != nil {
		return false, err
	}
	for _, job := range jobs.Items {
		if q.capacity != nil && job.Annotations[queueBarrierAnnotation] != "" {
			if err := q.verifyRetiredBarrier(ctx, &job); err != nil {
				return false, err
			}
			continue
		}
		if queueJobTerminal(job) {
			continue
		}
		runID := job.Annotations[queueRunAnnotation]
		if job.UID == "" || runID == "" || job.Name != queueJobName(runID) {
			return false, fmt.Errorf("queue Job identity conflict during placement admission")
		}
		placed := false
		for _, pod := range pods.Items {
			for _, owner := range pod.OwnerReferences {
				if owner.UID == job.UID && owner.Kind == "Job" && owner.Controller != nil && *owner.Controller && pod.Spec.NodeName != "" && pod.Status.Phase != core.PodSucceeded && pod.Status.Phase != core.PodFailed {
					placed = true
				}
			}
		}
		if !placed {
			return true, nil
		}
	}
	return false, nil
}

func (q *kubernetesQueue) reserve(ctx context.Context) (reservation *directRunnerReservation, err error) {
	defer func() {
		if q.capacity != nil && err != nil {
			q.capacity.publishAvailability(false)
		}
	}()
	if q.capacity != nil {
		if err := q.validateReceiptInventory(ctx); err != nil {
			return nil, err
		}
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	n, err := q.activeCount(ctx)
	if err != nil {
		return nil, err
	}
	if n+q.held >= q.config.MaxConcurrent {
		return nil, nil
	}
	if q.held > 0 {
		return nil, nil
	}
	pending, err := q.pendingPlacement(ctx)
	if err != nil {
		return nil, err
	}
	if pending {
		return nil, nil
	}
	ready, err := q.readyNodes(ctx)
	if err != nil {
		return nil, err
	}
	if !ready {
		// Compete with ARC through the native scheduler instead of racing its
		// already-Pending Pods for a free slot every poll. Still require a
		// Ready, uncordoned, tolerated node whose total budget fits the shape.
		ready, err = q.nodesFit(ctx, false)
		if err != nil {
			return nil, err
		}
		if !ready {
			return nil, nil
		}
	}
	q.held++
	var once sync.Once
	return &directRunnerReservation{release: func() { once.Do(func() { q.mu.Lock(); q.held--; q.mu.Unlock() }) }, launch: func(l directRunnerLaunch) error { return q.launch(ctx, l) }}, nil
}
func queueJobName(runID string) string {
	return fmt.Sprintf("lcars-work-%x", sha256.Sum256([]byte(runID)))[:51]
}
func queueResources(values map[string]string) core.ResourceList {
	out := core.ResourceList{}
	for k, v := range values {
		out[core.ResourceName(k)] = resource.MustParse(v)
	}
	return out
}
func (q *kubernetesQueue) job(l directRunnerLaunch) (*batch.Job, error) {
	var providerKey string
	switch l.pipeline {
	case "claude":
		providerKey = "claude-code-oauth-token"
	case "codex":
	case "opencode":
		providerKey = "opencode-llm-api-key"
	default:
		return nil, fmt.Errorf("no direct-runner provider adapter for pipeline %q", l.pipeline)
	}
	name := queueJobName(l.runID)
	items := []core.KeyToPath{{Key: "telemetry-writer.json", Path: "telemetry-writer.json"}}
	if providerKey != "" {
		items = append(items, core.KeyToPath{Key: providerKey, Path: providerKey})
	}
	zero := int32(0)
	uid := int64(1001)
	gid := int64(1001)
	mode := int32(0440)
	no := false
	yes := true
	ttl := int32(86400)
	deadline := int64(7200)
	one := int32(1)
	env := []core.EnvVar{{Name: "RUNNER_MODE", Value: "direct"}, {Name: "LCARS_RUN_ID", Value: l.runID}, {Name: "LCARS_CONSOLE_URL", Value: l.consoleURL}, {Name: "LCARS_RUN_TOKEN", ValueFrom: &core.EnvVarSource{SecretKeyRef: &core.SecretKeySelector{LocalObjectReference: core.LocalObjectReference{Name: name}, Key: "run-token"}}}}
	env = append(env, core.EnvVar{Name: "LCARS_WORKER_POLICY_PROVIDERS", Value: q.workerPolicyProviders})
	volumes := []core.Volume{{Name: "credentials", VolumeSource: core.VolumeSource{Secret: &core.SecretVolumeSource{SecretName: q.config.CredentialsSecret, Items: items, DefaultMode: &mode}}}, {Name: "work", VolumeSource: core.VolumeSource{EmptyDir: &core.EmptyDirVolumeSource{}}}}
	mounts := []core.VolumeMount{{Name: "credentials", MountPath: "/run/secrets", ReadOnly: true}, {Name: "work", MountPath: "/home/runner/_work"}}
	if l.pipeline == "codex" {
		env = append(env, core.EnvVar{Name: "LCARS_CODEX_VOLATILE_DIR", Value: directRunnerCodexVolatileMountPath})
		size := resource.MustParse("64Mi")
		volumes = append(volumes, core.Volume{Name: "codex-volatile", VolumeSource: core.VolumeSource{EmptyDir: &core.EmptyDirVolumeSource{Medium: core.StorageMediumMemory, SizeLimit: &size}}})
		mounts = append(mounts, core.VolumeMount{Name: "codex-volatile", MountPath: directRunnerCodexVolatileMountPath})
	}
	annotations := map[string]string{queueRunAnnotation: l.runID}
	if l.runner != "" {
		annotations[queueRunnerAnnotation] = l.runner
	}
	// Suspend until the run-token Secret exists. Recovery only unsuspends the
	// same never-started Job; it never recreates or restarts an exited attempt.
	job := &batch.Job{
		ObjectMeta: meta.ObjectMeta{
			Name: name, Namespace: q.config.Namespace,
			Labels:      map[string]string{queueJobLabel: "true"},
			Annotations: annotations,
		},
		Spec: batch.JobSpec{
			Suspend: &yes, BackoffLimit: &zero, Completions: &one, Parallelism: &one,
			TTLSecondsAfterFinished: &ttl, ActiveDeadlineSeconds: &deadline,
			PodReplacementPolicy: ptr(batch.Failed),
			PodFailurePolicy: &batch.PodFailurePolicy{Rules: []batch.PodFailurePolicyRule{{
				Action:          batch.PodFailurePolicyActionFailJob,
				OnPodConditions: []batch.PodFailurePolicyOnPodConditionsPattern{{Type: core.DisruptionTarget, Status: core.ConditionTrue}},
			}}},
			Template: core.PodTemplateSpec{
				ObjectMeta: meta.ObjectMeta{Labels: map[string]string{queueJobLabel: "true"}, Annotations: map[string]string{queueRunAnnotation: l.runID}},
				Spec: core.PodSpec{
					RestartPolicy:      core.RestartPolicyNever,
					ServiceAccountName: q.config.ServiceAccount, AutomountServiceAccountToken: &no,
					NodeSelector: q.config.NodeSelector, Tolerations: q.tolerations(),
					SecurityContext: &core.PodSecurityContext{RunAsUser: &uid, RunAsGroup: &gid, RunAsNonRoot: &yes, FSGroup: &gid},
					// Query external API names before cluster search suffixes; musl can
					// stop on a search response before reaching the absolute name.
					DNSPolicy: core.DNSClusterFirst,
					DNSConfig: &core.PodDNSConfig{Options: []core.PodDNSConfigOption{{Name: "ndots", Value: ptr("1")}}},
					Volumes:   volumes,
					Containers: []core.Container{{
						Name: "direct-runner", Image: q.image, ImagePullPolicy: core.PullAlways,
						Env: env, VolumeMounts: mounts,
						Resources:       core.ResourceRequirements{Requests: queueResources(q.config.Requests), Limits: queueResources(q.config.Limits)},
						SecurityContext: &core.SecurityContext{AllowPrivilegeEscalation: &no, Capabilities: &core.Capabilities{Drop: []core.Capability{"ALL"}}},
					}},
				},
			},
		},
	}
	if l.receipt != nil {
		q.configureReceiptJob(job, l)
	}
	return job, nil
}
func ptr[T any](v T) *T { return &v }

func (q *kubernetesQueue) launch(ctx context.Context, l directRunnerLaunch) error {
	if q.capacity != nil {
		return q.launchReceipt(ctx, l)
	}
	desired, err := q.job(l)
	if err != nil {
		return err
	}
	job, err := q.client.BatchV1().Jobs(q.config.Namespace).Create(ctx, desired, meta.CreateOptions{})
	if err != nil {
		// A timed-out create may have reached the apiserver. Read the same name,
		// never choose a new name and accidentally launch a duplicate attempt.
		job, err = q.client.BatchV1().Jobs(q.config.Namespace).Get(ctx, desired.Name, meta.GetOptions{})
		if err != nil {
			return fmt.Errorf("creating queue Job: %w", err)
		}
	}
	if job.Annotations[queueRunAnnotation] != l.runID || job.Labels[queueJobLabel] != "true" {
		return fmt.Errorf("queue Job identity conflict")
	}
	if job.Spec.Suspend == nil || !*job.Spec.Suspend || queueJobAttempted(job) {
		return nil
	}
	secret := &core.Secret{ObjectMeta: meta.ObjectMeta{Name: job.Name, Namespace: q.config.Namespace, Labels: map[string]string{queueJobLabel: "true"}, OwnerReferences: []meta.OwnerReference{{APIVersion: "batch/v1", Kind: "Job", Name: job.Name, UID: job.UID, Controller: ptr(true)}}}, Immutable: ptr(true), Data: map[string][]byte{"run-token": []byte(l.runToken)}}
	if _, err = q.client.CoreV1().Secrets(q.config.Namespace).Create(ctx, secret, meta.CreateOptions{}); err != nil && !apierrors.IsAlreadyExists(err) {
		return fmt.Errorf("creating queue run credential: %w", err)
	}
	return q.resume(ctx, job)
}
func (q *kubernetesQueue) resume(ctx context.Context, job *batch.Job) error {
	ctx, cancel := context.WithTimeout(ctx, queueStartupRecoveryTimeout)
	defer cancel()
	// Create's resourceVersion is immediately stale if the Job controller
	// writes Suspended status. Re-read and revalidate every bounded conflict
	// retry; never adopt a replacement Job or restart an executed attempt.
	return retry.RetryOnConflict(retry.DefaultBackoff, func() error {
		if err := ctx.Err(); err != nil {
			return err
		}
		current, err := q.client.BatchV1().Jobs(q.config.Namespace).Get(ctx, job.Name, meta.GetOptions{})
		if err != nil {
			return err
		}
		runID := job.Annotations[queueRunAnnotation]
		if job.UID == "" || current.UID != job.UID || runID == "" || current.Name != queueJobName(runID) || current.Labels[queueJobLabel] != "true" || current.Annotations[queueRunAnnotation] != runID || current.Annotations[queueRunnerAnnotation] != job.Annotations[queueRunnerAnnotation] {
			return fmt.Errorf("queue Job identity conflict")
		}
		if current.DeletionTimestamp != nil || current.Spec.Suspend == nil || !*current.Spec.Suspend || queueJobAttempted(current) {
			return nil
		}
		// Re-suspending a Job clears StartTime and removes its Pods. Generation
		// one is the original suspended spec; any later suspended spec could
		// have run, even with zero counters. Already-unsuspended is a no-op.
		if current.Generation != 1 {
			return fmt.Errorf("queue Job no longer has its original suspended specification")
		}
		pods, err := q.client.CoreV1().Pods(q.config.Namespace).List(ctx, meta.ListOptions{})
		if err != nil {
			return err
		}
		for _, pod := range pods.Items {
			for _, owner := range pod.OwnerReferences {
				if owner.Kind == "Job" && owner.UID == current.UID {
					return nil
				}
			}
		}
		secret, err := q.client.CoreV1().Secrets(q.config.Namespace).Get(ctx, current.Name, meta.GetOptions{})
		if err != nil {
			return err
		}
		owned := false
		for _, owner := range secret.OwnerReferences {
			if owner.UID == current.UID && owner.Kind == "Job" && owner.Name == current.Name && owner.APIVersion == "batch/v1" && owner.Controller != nil && *owner.Controller {
				owned = true
			}
		}
		if !owned || secret.Immutable == nil || !*secret.Immutable || len(secret.Data["run-token"]) == 0 {
			return fmt.Errorf("queue run credential identity conflict")
		}
		if q.verifyRun == nil {
			return fmt.Errorf("queue run-token fence unavailable")
		}
		if err := q.verifyRun(ctx, runID, string(secret.Data["run-token"])); err != nil {
			return err
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		current.Spec.Suspend = ptr(false)
		_, err = q.client.BatchV1().Jobs(q.config.Namespace).Update(ctx, current, meta.UpdateOptions{})
		if err == nil {
			q.logger.Info("Started Kubernetes direct runner", slog.String("runId", runID), slog.String("job", current.Name))
		}
		return err
	})
}

func queueJobAttempted(job *batch.Job) bool {
	if job.Status.StartTime != nil || job.Status.Active != 0 || job.Status.Succeeded != 0 || job.Status.Failed != 0 {
		return true
	}
	for _, condition := range job.Status.Conditions {
		if condition.Status == core.ConditionTrue && (condition.Type == batch.JobComplete || condition.Type == batch.JobFailed || condition.Type == batch.JobFailureTarget || condition.Type == batch.JobSuccessCriteriaMet) {
			return true
		}
	}
	return false
}
func (q *kubernetesQueue) recover(ctx context.Context) error {
	if q.capacity != nil {
		return q.reconcileReceipts(ctx)
	}
	jobs, err := q.client.BatchV1().Jobs(q.config.Namespace).List(ctx, meta.ListOptions{LabelSelector: queueJobLabel + "=true"})
	if err != nil {
		return err
	}
	var errs []error
	for _, j := range jobs.Items {
		if time.Since(j.CreationTimestamp.Time) > 2*time.Hour {
			continue
		}
		if queueJobTerminal(j) || j.Spec.Suspend == nil || !*j.Spec.Suspend {
			continue
		}
		if err := q.resume(ctx, &j); err != nil {
			errs = append(errs, fmt.Errorf("recovering suspended queue Job: %w", err))
		}
	}
	return errors.Join(errs...)
}

// Completed Jobs retain pod logs for a day through the TTL controller. A
// crash before Secret creation leaves a suspended Job: after the execution
// lease window its run cannot execute, so remove that never-started shell.
func (q *kubernetesQueue) cleanup(ctx context.Context) error {
	if q.capacity != nil {
		return nil
	} // Retirement owns all receipt-mode cleanup; never delete on age.
	jobs, err := q.client.BatchV1().Jobs(q.config.Namespace).List(ctx, meta.ListOptions{LabelSelector: queueJobLabel + "=true"})
	if err != nil {
		return err
	}
	var completed []batch.Job
	for _, j := range jobs.Items {
		if queueJobTerminal(j) {
			completed = append(completed, j)
			continue
		}
		if j.Spec.Suspend == nil || !*j.Spec.Suspend || j.Status.StartTime != nil || time.Since(j.CreationTimestamp.Time) < 2*time.Hour {
			continue
		}
		uid := j.UID
		rv := j.ResourceVersion
		err = q.client.BatchV1().Jobs(q.config.Namespace).Delete(ctx, j.Name, meta.DeleteOptions{Preconditions: &meta.Preconditions{UID: &uid, ResourceVersion: &rv}, PropagationPolicy: ptr(meta.DeletePropagationBackground)})
		if err != nil && !apierrors.IsNotFound(err) {
			return err
		}
	}
	sort.Slice(completed, func(i, j int) bool { return queueJobFinishedAt(completed[i]).After(queueJobFinishedAt(completed[j])) })
	// Keep a bounded number of recent finished Jobs (and their Pod logs) per
	// capacity slot; the Job TTL controller removes the rest after a day.
	for i, j := range completed {
		finished := queueJobFinishedAt(j)
		if finished.IsZero() || (i < q.config.MaxConcurrent*queueJobRetentionPerSlot && time.Since(finished) < queueJobRetentionAge) {
			continue
		}
		uid, rv := j.UID, j.ResourceVersion
		if err := q.client.BatchV1().Jobs(q.config.Namespace).Delete(ctx, j.Name, meta.DeleteOptions{Preconditions: &meta.Preconditions{UID: &uid, ResourceVersion: &rv}, PropagationPolicy: ptr(meta.DeletePropagationBackground)}); err != nil && !apierrors.IsNotFound(err) {
			return err
		}
	}
	return nil
}

func queueJobFinishedAt(job batch.Job) time.Time {
	var finished time.Time
	for _, c := range job.Status.Conditions {
		if (c.Type == batch.JobComplete || c.Type == batch.JobFailed) && c.Status == core.ConditionTrue && c.LastTransitionTime.Time.After(finished) {
			finished = c.LastTransitionTime.Time
		}
	}
	return finished
}

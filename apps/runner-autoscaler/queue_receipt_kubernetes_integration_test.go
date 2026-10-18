//go:build kubernetes_integration

// Opt-in real-cluster regression for the capacity receipt fence. Ordinary
// package tests never compile this file. The tag exists because a fake cannot
// prove that a write the apiserver accepted survived a lost reply, or that a
// real server rejects a late Create against an installed tombstone.
//
// Nothing here has a fallback target. Activation requires every variable below
// to be set and to agree with the live cluster, so an unset or drifting
// qualification fails the run instead of falling back to a production
// namespace, a mutable tag, or a writer credential:
//
//	LCARS_RECEIPT_K8S_KUBECONFIG      kubeconfig holding only the test context
//	LCARS_RECEIPT_K8S_KUBECONTEXT     context to use, verbatim
//	LCARS_RECEIPT_K8S_NAMESPACE       disposable namespace owned by this suite
//	LCARS_RECEIPT_K8S_NAMESPACE_UID   that namespace's observed UID
//	LCARS_RECEIPT_K8S_LABELS          comma-separated k=v qualifications the namespace must carry
//	LCARS_RECEIPT_K8S_IMAGE           root-qualified immutable digest, e.g. registry/runner@sha256:...
//	LCARS_RECEIPT_K8S_SERVICE_ACCOUNT harmless worker ServiceAccount, no writer rights
//	LCARS_RECEIPT_K8S_FIXTURE_SECRET  exact owned dummy Secret with inert data only
//
//	go test -tags=kubernetes_integration -run TestReceiptKubernetes ./apps/runner-autoscaler
//
// Retained fixture deltas, stated rather than hidden:
//   - The live-Pod Job keeps the production name, labels, annotations, receipt
//     fence, dummy credential mount and SecurityContext, but replaces the
//     direct-runner entrypoint with a reviewed "/bin/sh -c sleep 15; exit 0"
//     and tiny requests. It never runs provider, bootstrap or session work.
//   - The Work API is a real loopback HTTP server, not Firestore, GCS, JWT or
//     any provider proof. Only the Kubernetes half is real.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	batch "k8s.io/api/batch/v1"
	core "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	meta "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/tools/clientcmd"
)

const (
	receiptFixtureSubject = "receipt-fence-executor-subject"
	receiptFixtureToken   = "receipt-fence-original-run-token"
	receiptFixtureRunner  = "receipt-fence-runner"
)

var receiptFencePool = queueCapacityConfig{PoolID: "receipt-fence-pool", Cluster: "receipt-fence-cluster", Version: 1, WorkerAudience: "receipt-fence-worker"}

// receiptKubernetesRuntime carries no usable zero value on purpose: every
// field must be configured and re-verified against the cluster.
type receiptKubernetesRuntime struct {
	kubeconfig     string
	kubecontext    string
	namespace      string
	namespaceUID   string
	qualifications map[string]string
	image          string
	serviceAccount string
	fixtureSecret  string
}

func receiptKubernetesRuntimeFromEnv(t *testing.T) receiptKubernetesRuntime {
	t.Helper()
	rt := receiptKubernetesRuntime{
		kubeconfig:     os.Getenv("LCARS_RECEIPT_K8S_KUBECONFIG"),
		kubecontext:    os.Getenv("LCARS_RECEIPT_K8S_KUBECONTEXT"),
		namespace:      os.Getenv("LCARS_RECEIPT_K8S_NAMESPACE"),
		namespaceUID:   os.Getenv("LCARS_RECEIPT_K8S_NAMESPACE_UID"),
		image:          os.Getenv("LCARS_RECEIPT_K8S_IMAGE"),
		serviceAccount: os.Getenv("LCARS_RECEIPT_K8S_SERVICE_ACCOUNT"),
		fixtureSecret:  os.Getenv("LCARS_RECEIPT_K8S_FIXTURE_SECRET"),
	}
	for _, e := range []struct{ name, value string }{
		{"LCARS_RECEIPT_K8S_KUBECONFIG", rt.kubeconfig},
		{"LCARS_RECEIPT_K8S_KUBECONTEXT", rt.kubecontext},
		{"LCARS_RECEIPT_K8S_NAMESPACE", rt.namespace},
		{"LCARS_RECEIPT_K8S_NAMESPACE_UID", rt.namespaceUID},
		{"LCARS_RECEIPT_K8S_IMAGE", rt.image},
		{"LCARS_RECEIPT_K8S_SERVICE_ACCOUNT", rt.serviceAccount},
		{"LCARS_RECEIPT_K8S_FIXTURE_SECRET", rt.fixtureSecret},
	} {
		if strings.TrimSpace(e.value) == "" {
			t.Fatalf("receipt Kubernetes integration activated but %s is unset; refusing any default target", e.name)
		}
	}
	if fi, err := os.Stat(rt.kubeconfig); err != nil || fi.IsDir() {
		t.Fatalf("LCARS_RECEIPT_K8S_KUBECONFIG must name a readable kubeconfig file: %v", err)
	}
	if !strings.Contains(rt.image, "@sha256:") || strings.Contains(rt.image, ":latest") {
		t.Fatalf("LCARS_RECEIPT_K8S_IMAGE must be a root-qualified immutable digest, got %q", rt.image)
	}
	rt.qualifications = map[string]string{}
	for _, pair := range strings.Split(os.Getenv("LCARS_RECEIPT_K8S_LABELS"), ",") {
		if pair = strings.TrimSpace(pair); pair == "" {
			continue
		}
		k, v, ok := strings.Cut(pair, "=")
		if !ok || k == "" {
			t.Fatalf("LCARS_RECEIPT_K8S_LABELS entry %q is not k=v", pair)
		}
		rt.qualifications[k] = v
	}
	if len(rt.qualifications) == 0 {
		t.Fatal("LCARS_RECEIPT_K8S_LABELS must qualify the disposable namespace; refusing an unqualified namespace")
	}
	return rt
}

// receiptFaultTransport injects at the authenticated Kubernetes request itself.
// A lost reply still forwards the real request and drains the real reply, so
// the apiserver keeps an object the caller cannot see, exactly as a dropped TCP
// reply would.
type receiptFault struct {
	method       string
	path         string
	bodyContains string
	release      chan struct{}
}

type receiptFaultTransport struct {
	base  http.RoundTripper
	mu    sync.Mutex
	armed []*receiptFault
}

func (f *receiptFaultTransport) reset() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.armed = nil
}

// holdBefore forwards nothing until the returned channel is closed.
func (f *receiptFaultTransport) holdBefore(method, path, bodyContains string) chan struct{} {
	release := make(chan struct{})
	f.mu.Lock()
	defer f.mu.Unlock()
	f.armed = append(f.armed, &receiptFault{method: method, path: path, bodyContains: bodyContains, release: release})
	return release
}

// loseReply forwards the real request, drains the real reply, then reports loss.
func (f *receiptFaultTransport) loseReply(method, path, bodyContains string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.armed = append(f.armed, &receiptFault{method: method, path: path, bodyContains: bodyContains})
}

func (f *receiptFaultTransport) take(req *http.Request) *receiptFault {
	f.mu.Lock()
	defer f.mu.Unlock()
	for i, a := range f.armed {
		if a.method != req.Method || (a.path != "" && a.path != req.URL.Path) {
			continue
		}
		if a.bodyContains != "" {
			if req.GetBody == nil {
				continue
			}
			rc, err := req.GetBody()
			if err != nil {
				continue
			}
			body, err := io.ReadAll(rc)
			rc.Close()
			if err != nil || !bytes.Contains(body, []byte(a.bodyContains)) {
				continue
			}
		}
		f.armed = append(f.armed[:i], f.armed[i+1:]...)
		return a
	}
	return nil
}

func (f *receiptFaultTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	fault := f.take(req)
	if fault == nil {
		return f.base.RoundTrip(req)
	}
	if fault.release != nil {
		select {
		case <-fault.release:
		case <-req.Context().Done():
			return nil, req.Context().Err()
		}
	}
	resp, err := f.base.RoundTrip(req)
	if err != nil {
		return nil, err
	}
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	return nil, fmt.Errorf("receipt fence fault: reply lost after forwarding %s %s", req.Method, req.URL.Path)
}

// receiptWorkAPI is the real loopback half of the fence. It records every
// authenticated action in arrival order and can refuse, drop, or answer with
// the identity the server actually holds.
type receiptWorkAPI struct {
	server     *httptest.Server
	ns         string
	mu         sync.Mutex
	seq        []string
	ops        []map[string]any
	releases   []map[string]any
	receipts   []capacityReceipt
	retirement *capacityRetirement
	exit       func(attempt int) (code int, body string, drop bool)
}

func newReceiptWorkAPI(t *testing.T, namespace string) *receiptWorkAPI {
	t.Helper()
	api := &receiptWorkAPI{ns: namespace}
	api.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.Header.Get("Authorization") != "Bearer "+receiptFixtureSubject {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		switch {
		case strings.HasSuffix(req.URL.Path, "/claim-status"):
			api.mu.Lock()
			api.seq = append(api.seq, "claim-status")
			api.mu.Unlock()
			if req.URL.Query().Get("runner") != receiptFixtureRunner || req.URL.Query().Get("claimFingerprint") != queueClaimFingerprint(receiptFixtureToken) {
				t.Error("claim-status projection changed the original claim identity")
			}
			fmt.Fprint(w, `{"status":"live"}`)
		case strings.HasSuffix(req.URL.Path, "/exit"):
			var x map[string]any
			if err := json.NewDecoder(req.Body).Decode(&x); err != nil {
				t.Error(err)
			}
			api.mu.Lock()
			api.seq = append(api.seq, "exit")
			attempt := len(api.seq)
			api.ops = append(api.ops, map[string]any{"action": "exit", "body": x})
			hook := api.exit
			api.mu.Unlock()
			code, body, drop := http.StatusOK, `{"state":"lost"}`, false
			if hook != nil {
				code, body, drop = hook(attempt)
			}
			if drop {
				if conn, _, err := w.(http.Hijacker).Hijack(); err == nil {
					conn.Close()
					return
				}
			}
			if code != http.StatusOK {
				w.WriteHeader(code)
			}
			fmt.Fprint(w, body)
		case req.Method == http.MethodGet:
			api.mu.Lock()
			receipts, err := json.Marshal(api.receipts)
			api.seq = append(api.seq, "inventory")
			api.mu.Unlock()
			if err != nil {
				t.Error(err)
			}
			if receipts == nil {
				receipts = []byte("[]")
			}
			fmt.Fprintf(w, `{"policy":{"poolId":%q,"cluster":%q,"namespace":%q,"version":%d,"maxConcurrent":2,"enforced":true,"inventoryKnown":true},"receipts":%s}`,
				receiptFencePool.PoolID, receiptFencePool.Cluster, api.ns, receiptFencePool.Version, receipts)
		default:
			var x map[string]any
			if err := json.NewDecoder(req.Body).Decode(&x); err != nil {
				t.Error(err)
			}
			api.mu.Lock()
			action, _ := x["action"].(string)
			api.seq = append(api.seq, action)
			api.ops = append(api.ops, x)
			if action == "release" {
				api.releases = append(api.releases, x)
			}
			retirement := api.retirement
			api.mu.Unlock()
			out := map[string]any{"ok": true}
			if action == "inspect-retired" {
				out["retirement"] = retirement
			}
			if err := json.NewEncoder(w).Encode(out); err != nil {
				t.Error(err)
			}
		}
	}))
	t.Cleanup(api.server.Close)
	return api
}

func (a *receiptWorkAPI) setReceipts(receipts ...capacityReceipt) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.receipts = receipts
}

func (a *receiptWorkAPI) setRetirement(r *capacityRetirement) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.retirement = r
}

func (a *receiptWorkAPI) setExit(hook func(attempt int) (int, string, bool)) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.exit = hook
}

func (a *receiptWorkAPI) reset() {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.seq, a.ops, a.releases = nil, nil, nil
}

func (a *receiptWorkAPI) snapshot() (seq []string, ops, releases []map[string]any) {
	a.mu.Lock()
	defer a.mu.Unlock()
	s := make([]string, len(a.seq))
	copy(s, a.seq)
	oc := make([]map[string]any, len(a.ops))
	copy(oc, a.ops)
	rc := make([]map[string]any, len(a.releases))
	copy(rc, a.releases)
	return s, oc, rc
}

func (a *receiptWorkAPI) count(action string) int {
	seq, _, _ := a.snapshot()
	n := 0
	for _, s := range seq {
		if s == action {
			n++
		}
	}
	return n
}

func (a *receiptWorkAPI) index(action string) int {
	seq, _, _ := a.snapshot()
	for i, s := range seq {
		if s == action {
			return i
		}
	}
	return -1
}

func (a *receiptWorkAPI) actions(action string) []map[string]any {
	_, ops, _ := a.snapshot()
	var out []map[string]any
	for _, x := range ops {
		if x["action"] == action {
			out = append(out, x)
		}
	}
	return out
}

// receiptOwnership is the exact allowlist this run created. Cleanup deletes
// nothing it cannot re-identify by name AND UID in the still-qualified
// namespace, and retains anything ambiguous instead of guessing.
type receiptOwnership struct {
	t       *testing.T
	rt      receiptKubernetesRuntime
	q       *kubernetesQueue
	mu      sync.Mutex
	jobs    map[string]types.UID
	secrets map[string]types.UID
	done    bool
}

func (o *receiptOwnership) ownJob(j *batch.Job) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.jobs[j.Name] = j.UID
}

func (o *receiptOwnership) ownSecret(s *core.Secret) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.secrets[s.Name] = s.UID
}

func (o *receiptOwnership) forget(name string) {
	o.mu.Lock()
	defer o.mu.Unlock()
	delete(o.jobs, name)
	delete(o.secrets, name)
}

// cleanup runs on a context of its own: a test-body deadline, a panic, or a
// global go test timeout must not strand cluster objects.
func (o *receiptOwnership) cleanup() {
	o.mu.Lock()
	if o.done {
		o.mu.Unlock()
		return
	}
	o.done = true
	jobs, secrets := map[string]types.UID{}, map[string]types.UID{}
	for n, u := range o.jobs {
		jobs[n] = u
	}
	for n, u := range o.secrets {
		secrets[n] = u
	}
	o.mu.Unlock()

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	ns, err := o.q.client.CoreV1().Namespaces().Get(ctx, o.rt.namespace, meta.GetOptions{})
	if err != nil || ns.UID != types.UID(o.rt.namespaceUID) {
		o.t.Errorf("receipt fence cleanup cannot re-qualify namespace %s (uid %v); retaining %d Job(s) for manual review", o.rt.namespace, o.rt.namespaceUID, len(jobs))
		return
	}
	for name, uid := range jobs {
		current, err := o.q.client.BatchV1().Jobs(o.rt.namespace).Get(ctx, name, meta.GetOptions{})
		if apierrors.IsNotFound(err) {
			continue
		}
		if err != nil {
			o.t.Errorf("receipt fence cleanup cannot identify Job %s; retaining it: %v", name, err)
			continue
		}
		if current.UID != uid || current.Namespace != o.rt.namespace {
			o.t.Errorf("receipt fence cleanup identity drift for Job %s (%s observed, %s owned); retaining it", name, current.UID, uid)
			continue
		}
		policy := meta.DeletePropagationForeground
		preconditions := meta.Preconditions{UID: &uid}
		if rv := current.ResourceVersion; rv != "" {
			preconditions.ResourceVersion = &rv
		}
		if err := o.q.client.BatchV1().Jobs(o.rt.namespace).Delete(ctx, name, meta.DeleteOptions{PropagationPolicy: &policy, Preconditions: &preconditions}); err != nil && !apierrors.IsNotFound(err) && !apierrors.IsConflict(err) {
			o.t.Errorf("receipt fence cleanup failed for Job %s; retaining it: %v", name, err)
		}
	}
	for name, uid := range jobs {
		deadline := time.Now().Add(2 * time.Minute)
		for {
			_, err := o.q.client.BatchV1().Jobs(o.rt.namespace).Get(ctx, name, meta.GetOptions{})
			if apierrors.IsNotFound(err) {
				break
			}
			if time.Now().After(deadline) {
				o.t.Errorf("receipt fence retained Job %s (uid %s) in namespace %s", name, uid, o.rt.namespace)
				break
			}
			time.Sleep(time.Second)
		}
	}
	for name, uid := range secrets {
		current, err := o.q.client.CoreV1().Secrets(o.rt.namespace).Get(ctx, name, meta.GetOptions{})
		if apierrors.IsNotFound(err) {
			continue
		}
		if err != nil || current.UID != uid {
			o.t.Errorf("receipt fence cleanup cannot identify Secret %s; retaining it: %v", name, err)
			continue
		}
		preconditions := meta.Preconditions{UID: &uid}
		if err := o.q.client.CoreV1().Secrets(o.rt.namespace).Delete(ctx, name, meta.DeleteOptions{Preconditions: &preconditions}); err != nil && !apierrors.IsNotFound(err) {
			o.t.Errorf("receipt fence cleanup failed for Secret %s; retaining it: %v", name, err)
		}
	}
}

// receiptFenceQueue builds the production queue against the qualified cluster
// only. Every qualification is re-read from the server before anything is
// written, and the whole run owns a cleanup that survives test-body death.
func receiptFenceQueue(t *testing.T, rt receiptKubernetesRuntime) (*kubernetesQueue, *receiptWorkAPI, *receiptFaultTransport, *receiptOwnership) {
	t.Helper()
	faults := &receiptFaultTransport{}
	loader := clientcmd.NewNonInteractiveDeferredLoadingClientConfig(
		&clientcmd.ClientConfigLoadingRules{ExplicitPath: rt.kubeconfig},
		&clientcmd.ConfigOverrides{CurrentContext: rt.kubecontext})
	cfg, err := loader.ClientConfig()
	if err != nil {
		t.Fatalf("receipt fence refuses an unloadable context: %v", err)
	}
	if cfg.Host == "" {
		t.Fatal("receipt fence refuses an unqualified API host")
	}
	if scoped, _, err := loader.Namespace(); err != nil {
		t.Fatalf("reading the context namespace: %v", err)
	} else if scoped != "" && scoped != rt.namespace {
		t.Fatalf("context %q is namespaced to %q, not the qualified namespace %q", rt.kubecontext, scoped, rt.namespace)
	}
	cfg.Wrap(func(base http.RoundTripper) http.RoundTripper {
		faults.base = base
		return faults
	})
	client, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		t.Fatalf("building the qualified client: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	ns, err := client.CoreV1().Namespaces().Get(ctx, rt.namespace, meta.GetOptions{})
	if err != nil {
		t.Fatalf("qualified namespace %s is unreadable: %v", rt.namespace, err)
	}
	if string(ns.UID) != rt.namespaceUID {
		t.Fatalf("namespace %s has UID %s, not the qualified UID %s", rt.namespace, ns.UID, rt.namespaceUID)
	}
	if ns.DeletionTimestamp != nil || ns.Status.Phase == core.NamespaceTerminating {
		t.Fatalf("namespace %s is terminating", rt.namespace)
	}
	for k, v := range rt.qualifications {
		if ns.Labels[k] != v {
			t.Fatalf("namespace %s lacks qualification %s=%s", rt.namespace, k, v)
		}
	}
	if _, err = client.CoreV1().ServiceAccounts(rt.namespace).Get(ctx, rt.serviceAccount, meta.GetOptions{}); err != nil {
		t.Fatalf("qualified worker ServiceAccount %s is unusable: %v", rt.serviceAccount, err)
	}
	dummy, err := client.CoreV1().Secrets(rt.namespace).Get(ctx, rt.fixtureSecret, meta.GetOptions{})
	if err != nil {
		t.Fatalf("qualified dummy Secret %s is missing: %v", rt.fixtureSecret, err)
	}
	if len(dummy.Data) == 0 || len(dummy.Data["telemetry-writer.json"]) == 0 {
		t.Fatalf("dummy Secret %s must carry only inert data including telemetry-writer.json", rt.fixtureSecret)
	}
	if _, ok := dummy.Data["run-token"]; ok {
		t.Fatalf("dummy Secret %s must not carry a run-token", rt.fixtureSecret)
	}

	api := newReceiptWorkAPI(t, rt.namespace)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	pool := receiptFencePool
	q := &kubernetesQueue{
		client: client, image: rt.image, logger: logger, workerPolicyProviders: "loopback",
		config: queueKubernetesConfig{
			Namespace: rt.namespace, CredentialsSecret: rt.fixtureSecret, ServiceAccount: rt.serviceAccount,
			MaxConcurrent: 2, NodeSelector: map[string]string{"queue-runner": "true"},
			Requests: map[string]string{"cpu": "50m", "memory": "64Mi", "ephemeral-storage": "64Mi"},
			Limits:   map[string]string{"cpu": "200m", "memory": "128Mi", "ephemeral-storage": "256Mi"},
			Capacity: &pool,
		},
		verifyRun: func(context.Context, string, string) error { return nil },
	}
	idToken := func() (string, error) { return receiptFixtureSubject, nil }
	q.capacity = &queueCapacityClient{config: pool, namespace: rt.namespace, maxConcurrent: 2, consoleURL: api.server.URL, idToken: idToken, producerID: newCapacityIdentity(), registered: true}
	q.exits = newRunExitReporter(api.server.URL, receiptFixtureRunner, idToken, logger)
	q.claimSettled = queueClaimStatus(api.server.URL, idToken)

	own := &receiptOwnership{t: t, rt: rt, q: q, jobs: map[string]types.UID{}, secrets: map[string]types.UID{}}
	t.Cleanup(own.cleanup)
	return q, api, faults, own
}

func receiptFenceReceipt(runID, nonce string) capacityReceipt {
	r := capacityReceipt{
		capacityFence: capacityFence{PoolID: receiptFencePool.PoolID, Slot: 0, Revision: 1, RunID: runID, Nonce: nonce},
		JobName:       queueJobName(runID),
		Pipeline:      "codex",
		Runner:        receiptFixtureRunner,
		State:         "placed",
	}
	return r
}

func receiptFenceBindProducer(r *capacityReceipt, producerID string) {
	r.Producers = []capacityProducer{{ProducerID: producerID, Subject: receiptFixtureSubject, Stopped: true}}
}

// receiptFenceSuspendedJob builds the production Job shape for a fence attempt.
// live is the reviewed fixture delta: the entrypoint becomes a bounded shell
// sleep so a real Pod can be observed without running the direct runner.
func receiptFenceSuspendedJob(t *testing.T, q *kubernetesQueue, r capacityReceipt, live bool) *batch.Job {
	t.Helper()
	job, err := q.job(directRunnerLaunch{runID: r.RunID, runToken: receiptFixtureToken, pipeline: r.Pipeline, runner: r.Runner, receipt: &r.capacityFence})
	if err != nil {
		t.Fatal(err)
	}
	if !live {
		return job
	}
	c := &job.Spec.Template.Spec.Containers[0]
	c.Command = []string{"/bin/sh", "-c", "sleep 15; exit 0"}
	c.Args = nil
	c.Env = nil
	job.Spec.ActiveDeadlineSeconds = ptr(int64(120))
	return job
}

func receiptFenceOwnedPods(ctx context.Context, t *testing.T, q *kubernetesQueue, j *batch.Job) []core.Pod {
	t.Helper()
	pods, err := q.client.CoreV1().Pods(q.config.Namespace).List(ctx, meta.ListOptions{LabelSelector: queueJobLabel + "=true"})
	if err != nil {
		t.Fatalf("listing owned Pods: %v", err)
	}
	var out []core.Pod
	for _, p := range pods.Items {
		if podOwnedBy(p, j) {
			out = append(out, p)
		}
	}
	return out
}

func receiptFenceWaitPods(ctx context.Context, t *testing.T, q *kubernetesQueue, j *batch.Job, timeout time.Duration, want func([]core.Pod) bool, what string) []core.Pod {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for {
		pods := receiptFenceOwnedPods(ctx, t, q, j)
		if want(pods) {
			return pods
		}
		if time.Now().After(deadline) {
			var states []string
			for _, p := range pods {
				states = append(states, string(p.UID)+"="+string(p.Status.Phase))
			}
			t.Fatalf("timed out waiting to %s; owned Pods: %v", what, states)
		}
		select {
		case <-ctx.Done():
			t.Fatalf("%s: %v", what, ctx.Err())
		case <-time.After(2 * time.Second):
		}
	}
}

func receiptFenceSecret(q *kubernetesQueue, j *batch.Job) *core.Secret {
	return &core.Secret{ObjectMeta: meta.ObjectMeta{
		Name: j.Name, Namespace: q.config.Namespace,
		OwnerReferences: []meta.OwnerReference{{APIVersion: "batch/v1", Kind: "Job", Name: j.Name, UID: j.UID, Controller: ptr(true)}},
	}, Immutable: ptr(true), Data: map[string][]byte{"run-token": []byte(receiptFixtureToken)}}
}

func receiptFenceWorker(r capacityReceipt, pod core.Pod, generation int, active bool) capacityReceipt {
	c := r
	c.Worker = &capacityWorker{Generation: generation, PodUID: string(pod.UID), JobUID: r.JobUID, Active: active}
	return c
}

func TestReceiptKubernetesWriteFences(t *testing.T) {
	rt := receiptKubernetesRuntimeFromEnv(t)
	q, api, faults, own := receiptFenceQueue(t, rt)
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Minute)
	defer cancel()

	t.Run("accepted-create-with-lost-reply-keeps-storage-debt", func(t *testing.T) {
		faults.reset()
		api.reset()
		r := receiptFenceReceipt("work:receipt-fence-lost-create/r1", "receipt-fence-lost-create-nonce")
		receiptFenceBindProducer(&r, q.capacity.producerID)
		n, err := q.capacity.recovery(ctx, r, "recover")
		if err != nil {
			t.Fatal(err)
		}
		desired := receiptFenceSuspendedJob(t, q, r, false)
		jobsPath := "/apis/batch/v1/namespaces/" + q.config.Namespace + "/jobs"
		faults.loseReply(http.MethodPost, jobsPath, `"name":"`+desired.Name+`"`)
		err = q.capacity.write(ctx, r, n, func() error {
			_, e := q.client.BatchV1().Jobs(q.config.Namespace).Create(ctx, desired, meta.CreateOptions{})
			return e
		})
		if err == nil || capacityDefinitiveKubernetesError(err) {
			t.Fatalf("a lost reply must stay non-definitive so the operation keeps debt: %v", err)
		}
		began, resolved := []string{}, []string{}
		for _, x := range api.actions("operation") {
			id, _ := x["operationId"].(string)
			if x["resolved"] == true {
				resolved = append(resolved, id)
			} else {
				began = append(began, id)
			}
		}
		if len(began) != 1 || len(resolved) != 0 {
			t.Fatalf("the unresolved create lost its storage debt: began=%v resolved=%v", began, resolved)
		}
		if _, _, releases := api.snapshot(); len(releases) != 0 {
			t.Fatalf("an unresolved write released capacity: %v", releases)
		}
		// The apiserver really accepted the create the caller cannot see.
		job, err := q.client.BatchV1().Jobs(q.config.Namespace).Get(ctx, desired.Name, meta.GetOptions{})
		if err != nil {
			t.Fatalf("the accepted create is absent, so this run proves nothing: %v", err)
		}
		own.ownJob(job)
		r.JobUID = string(job.UID)
		if !receiptJobMatches(job, r) {
			t.Fatal("the corroborated Job does not carry the receipt fence")
		}
		if job.Spec.Suspend == nil || !*job.Spec.Suspend || queueJobAttempted(job) || job.Annotations[queueBarrierAnnotation] != "" {
			t.Fatal("write-fence recovery started work")
		}
		if got := receiptFenceOwnedPods(ctx, t, q, job); len(got) != 0 {
			t.Fatalf("write fence produced %d Pod(s)", len(got))
		}
		if _, err = q.client.BatchV1().Jobs(q.config.Namespace).Create(ctx, desired, meta.CreateOptions{}); !apierrors.IsAlreadyExists(err) {
			t.Fatalf("a retry must collide with the accepted object, got %v", err)
		}
	})

	t.Run("late-accepted-create-cannot-pass-the-server-barrier", func(t *testing.T) {
		faults.reset()
		api.reset()
		api.setRetirement(nil)
		r := receiptFenceReceipt("work:receipt-fence-late-create/r1", "receipt-fence-late-create-nonce")
		r.State = "retiring"
		receiptFenceBindProducer(&r, q.capacity.producerID)
		if _, err := q.capacity.recovery(ctx, r, "retire"); err != nil {
			t.Fatal(err)
		}
		desired := receiptFenceSuspendedJob(t, q, r, false)
		jobsPath := "/apis/batch/v1/namespaces/" + q.config.Namespace + "/jobs"
		release := faults.holdBefore(http.MethodPost, jobsPath, `"name":"`+desired.Name+`"`)
		type late struct {
			job *batch.Job
			err error
		}
		done := make(chan late, 1)
		go func() {
			j, e := q.client.BatchV1().Jobs(q.config.Namespace).Create(ctx, desired, meta.CreateOptions{})
			done <- late{j, e}
		}()
		// A real positive GET proves absence while the create is still in flight.
		if _, err := q.client.BatchV1().Jobs(q.config.Namespace).Get(ctx, desired.Name, meta.GetOptions{}); !apierrors.IsNotFound(err) {
			t.Fatalf("absence must be a real NotFound for the exact name, got %v", err)
		}
		tombstone, err := q.installAbsentBarrier(ctx, r)
		if err != nil {
			t.Fatalf("installing the real absent barrier: %v", err)
		}
		own.ownJob(tombstone)
		if tombstone.Annotations[queueBarrierAnnotation] != r.Nonce || tombstone.Spec.Suspend == nil || !*tombstone.Spec.Suspend {
			t.Fatal("the absent-name barrier is not an inert server-owned tombstone")
		}
		close(release)
		got := <-done
		if !apierrors.IsAlreadyExists(got.err) {
			t.Fatalf("the late create must collide with the installed barrier, got %v", got.err)
		}
		after, err := q.client.BatchV1().Jobs(q.config.Namespace).Get(ctx, desired.Name, meta.GetOptions{})
		if err != nil || after.UID != tombstone.UID || after.ResourceVersion != tombstone.ResourceVersion {
			t.Fatalf("the late create displaced the barrier: %v %+v", err, after)
		}
		if pods := receiptFenceOwnedPods(ctx, t, q, after); len(pods) != 0 {
			t.Fatalf("the absent barrier produced %d Pod(s)", len(pods))
		}
		// The barrier is only ever trusted against the retirement the server holds.
		if err := q.verifyRetiredBarrier(ctx, after); err == nil {
			t.Fatal("barrier verified against an unbacked retirement ledger")
		}
		var backed capacityRetirement
		raw := fmt.Sprintf(`{"runId":%q,"nonce":%q,"jobName":%q,"released":true,"barrier":{"uid":%q,"resourceVersion":%q}}`, r.RunID, r.Nonce, after.Name, after.UID, after.ResourceVersion)
		if err := json.Unmarshal([]byte(raw), &backed); err != nil {
			t.Fatal(err)
		}
		api.setRetirement(&backed)
		if err := q.verifyRetiredBarrier(ctx, after); err != nil {
			t.Fatalf("barrier backed by the real observed object was rejected: %v", err)
		}
		if q.verifiedReceiptBarriers[after.Name] != string(after.UID)+"/"+after.ResourceVersion {
			t.Fatal("barrier cache did not record the object the server actually holds")
		}
	})

	t.Run("stale-barrier-write-preserves-the-server-replacement", func(t *testing.T) {
		faults.reset()
		api.reset()
		api.setRetirement(nil)
		r := receiptFenceReceipt("work:receipt-fence-stale-cas/r1", "receipt-fence-stale-cas-nonce")
		r.State = "retiring"
		receiptFenceBindProducer(&r, q.capacity.producerID)
		n, err := q.capacity.recovery(ctx, r, "retire")
		if err != nil {
			t.Fatal(err)
		}
		job, err := q.client.BatchV1().Jobs(q.config.Namespace).Create(ctx, receiptFenceSuspendedJob(t, q, r, false), meta.CreateOptions{})
		if err != nil {
			t.Fatal(err)
		}
		own.ownJob(job)
		r.JobUID = string(job.UID)
		stale := job.DeepCopy()
		// A real server-side replacement moves the identity the barrier write
		// was planned against.
		job.Annotations["agent-lcars.receipt-fence-probe"] = "replacement"
		replaced, err := q.client.BatchV1().Jobs(q.config.Namespace).Update(ctx, job, meta.UpdateOptions{})
		if err != nil {
			t.Fatal(err)
		}
		if replaced.ResourceVersion == stale.ResourceVersion {
			t.Fatal("the real update did not replace the resource version")
		}
		if err = q.retireReceipt(ctx, r, n, stale, nil); err == nil || !strings.Contains(err.Error(), "CAS") {
			t.Fatalf("a stale retirement barrier must be refused, got %v", err)
		}
		after, err := q.client.BatchV1().Jobs(q.config.Namespace).Get(ctx, job.Name, meta.GetOptions{})
		if err != nil || after.ResourceVersion != replaced.ResourceVersion || after.Annotations[queueBarrierAnnotation] != "" {
			t.Fatalf("the refused barrier did not preserve the server replacement: %v %+v", err, after)
		}
		if after.Spec.Suspend == nil || !*after.Spec.Suspend {
			t.Fatal("refused retirement started the object")
		}
		if _, _, releases := api.snapshot(); len(releases) != 0 {
			t.Fatal("refused retirement released capacity")
		}
		if pods := receiptFenceOwnedPods(ctx, t, q, after); len(pods) != 0 {
			t.Fatalf("the CAS fence produced %d Pod(s)", len(pods))
		}
	})

	t.Run("resume-refuses-a-replaced-credential", func(t *testing.T) {
		faults.reset()
		api.reset()
		r := receiptFenceReceipt("work:receipt-fence-replaced-secret/r1", "receipt-fence-replaced-secret-nonce")
		n, err := q.capacity.recovery(ctx, r, "recover")
		if err != nil {
			t.Fatal(err)
		}
		job, err := q.client.BatchV1().Jobs(q.config.Namespace).Create(ctx, receiptFenceSuspendedJob(t, q, r, false), meta.CreateOptions{})
		if err != nil {
			t.Fatal(err)
		}
		own.ownJob(job)
		r.JobUID = string(job.UID)
		if err = q.resumeReceipt(ctx, r, n, job, receiptFenceSecret(q, job)); err == nil {
			t.Fatal("resume proceeded with a credential the server does not hold")
		}
		original, err := q.client.CoreV1().Secrets(q.config.Namespace).Create(ctx, receiptFenceSecret(q, job), meta.CreateOptions{})
		if err != nil {
			t.Fatal(err)
		}
		own.ownSecret(original)
		r.SecretUID = string(original.UID)
		// The credential really is replaced: same name, different identity.
		uid := original.UID
		if err = q.client.CoreV1().Secrets(q.config.Namespace).Delete(ctx, original.Name, meta.DeleteOptions{Preconditions: &meta.Preconditions{UID: &uid}}); err != nil {
			t.Fatal(err)
		}
		replacement, err := q.client.CoreV1().Secrets(q.config.Namespace).Create(ctx, receiptFenceSecret(q, job), meta.CreateOptions{})
		if err != nil {
			t.Fatal(err)
		}
		own.ownSecret(replacement)
		if replacement.UID == original.UID {
			t.Fatal("the fixture replacement did not change the credential identity")
		}
		if err = q.resumeReceipt(ctx, r, n, job, original); err == nil {
			t.Fatal("resume adopted a credential the server has replaced")
		}
		if err = q.resumeReceipt(ctx, r, n, job, replacement); err == nil {
			t.Fatal("resume adopted a credential outside the recorded receipt identity")
		}
		after, err := q.client.BatchV1().Jobs(q.config.Namespace).Get(ctx, job.Name, meta.GetOptions{})
		if err != nil || after.Spec.Suspend == nil || !*after.Spec.Suspend || queueJobAttempted(after) {
			t.Fatalf("a refused resume started work: %v %+v", err, after)
		}
		if pods := receiptFenceOwnedPods(ctx, t, q, after); len(pods) != 0 {
			t.Fatalf("a refused resume produced %d Pod(s)", len(pods))
		}
		fresh, err := q.client.CoreV1().Secrets(q.config.Namespace).Get(ctx, replacement.Name, meta.GetOptions{})
		if err != nil || fresh.UID != replacement.UID {
			t.Fatalf("the refusal did not preserve the replacement credential: %v %+v", err, fresh)
		}
	})
}

// TestReceiptKubernetesRestoredCodexRetirement restores the codex
// direct-runner retirement path that has no compile-time coverage today: a
// receipt with no provider proof, a real Job, a real credential, a real Pod,
// and the production barrier/exit/release order against the real apiserver.
func TestReceiptKubernetesRestoredCodexRetirement(t *testing.T) {
	rt := receiptKubernetesRuntimeFromEnv(t)
	q, api, faults, own := receiptFenceQueue(t, rt)
	faults.reset()
	api.reset()
	api.setRetirement(nil)
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Minute)
	defer cancel()

	r := receiptFenceReceipt("work:receipt-fence-codex-retirement/r1", "receipt-fence-codex-nonce")
	receiptFenceBindProducer(&r, q.capacity.producerID)
	n, err := q.capacity.recovery(ctx, r, "recover")
	if err != nil {
		t.Fatal(err)
	}
	var job *batch.Job
	if err = q.capacity.write(ctx, r, n, func() error {
		var e error
		job, e = q.client.BatchV1().Jobs(q.config.Namespace).Create(ctx, receiptFenceSuspendedJob(t, q, r, true), meta.CreateOptions{})
		return e
	}); err != nil {
		t.Fatalf("the fenced write failed: %v", err)
	}
	own.ownJob(job)
	r.JobUID = string(job.UID)
	var secret *core.Secret
	if err = q.capacity.write(ctx, r, n, func() error {
		var e error
		secret, e = q.client.CoreV1().Secrets(q.config.Namespace).Create(ctx, receiptFenceSecret(q, job), meta.CreateOptions{})
		return e
	}); err != nil {
		t.Fatalf("the fenced credential write failed: %v", err)
	}
	own.ownSecret(secret)
	if err = q.bindReceipt(ctx, r, n, job, secret, nil); err != nil {
		t.Fatal(err)
	}
	r.SecretUID = string(secret.UID)
	if err = q.resumeReceipt(ctx, r, n, job, secret); err != nil {
		t.Fatalf("the fenced resume failed: %v", err)
	}
	pods := receiptFenceWaitPods(ctx, t, q, job, 3*time.Minute, func(p []core.Pod) bool { return len(p) >= 1 }, "observe the real codex fixture Pod")
	pod := pods[0]
	worker := receiptFenceWorker(r, pod, 1, true)

	// A live real Pod must keep both the slot and the logical exit closed.
	api.setReceipts(worker)
	api.reset()
	if err = q.reconcileReceipts(ctx); err != nil {
		t.Fatalf("reconcile with a live Pod: %v", err)
	}
	if api.count("release") != 0 || api.count("exit") != 0 {
		seq, ops, releases := api.snapshot()
		t.Fatalf("a live worker was released or exited: %v %v %v", seq, ops, releases)
	}
	liveJob, err := q.client.BatchV1().Jobs(q.config.Namespace).Get(ctx, job.Name, meta.GetOptions{})
	if err != nil || liveJob.Annotations[queueBarrierAnnotation] != "" {
		t.Fatalf("a live worker gained a retirement barrier: %v %+v", err, liveJob)
	}

	// A claim naming a Pod the server does not own cannot attest anything.
	api.setReceipts(receiptFenceWorker(r, core.Pod{ObjectMeta: meta.ObjectMeta{UID: "not-the-real-pod-uid"}}, 3, true))
	api.reset()
	if err = q.reconcileReceipts(ctx); err == nil || !strings.Contains(err.Error(), "inventory") {
		t.Fatalf("a stale worker claim must make physical inventory untrusted, got %v", err)
	}
	if api.count("release") != 0 || api.count("exit") != 0 {
		t.Fatalf("a stale worker claim released or exited: %v", api.count("release"))
	}

	pods = receiptFenceWaitPods(ctx, t, q, job, 6*time.Minute, func(p []core.Pod) bool {
		return len(p) >= 1 && p[0].Status.Phase == core.PodSucceeded
	}, "observe the real fixture Pod terminate")
	pod = pods[0]
	worker = receiptFenceWorker(r, pod, 1, true)

	// Refusal of the logical exit keeps the slot and the exact barrier.
	api.setReceipts(worker)
	api.reset()
	api.setExit(func(int) (int, string, bool) { return http.StatusConflict, `{"message":"logical exit refused"}`, false })
	if err = q.reconcileReceipts(ctx); err == nil {
		t.Fatal("a refused logical exit released capacity")
	}
	if api.count("release") != 0 {
		t.Fatal("a refused logical exit released capacity")
	}
	barrier, err := q.client.BatchV1().Jobs(q.config.Namespace).Get(ctx, job.Name, meta.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if barrier.UID != types.UID(r.JobUID) || barrier.Annotations[queueBarrierAnnotation] != r.Nonce || barrier.Spec.Suspend == nil || !*barrier.Spec.Suspend {
		t.Fatalf("the exit was attempted without the inert UID barrier: %+v", barrier)
	}
	if q.verifiedReceiptBarriers[job.Name] != "" {
		t.Fatal("an unverified barrier was cached as verified")
	}
	api.setRetirement(nil)

	// A lost logical exit preserves the same UID/resourceVersion barrier.
	barrierRV := barrier.ResourceVersion
	api.reset()
	api.setExit(func(int) (int, string, bool) { return 0, "", true })
	if err = q.reconcileReceipts(ctx); err == nil {
		t.Fatal("a lost logical exit released capacity")
	}
	if api.count("release") != 0 {
		t.Fatal("a lost logical exit released capacity")
	}
	held, err := q.client.BatchV1().Jobs(q.config.Namespace).Get(ctx, job.Name, meta.GetOptions{})
	if err != nil || held.UID != barrier.UID || held.ResourceVersion != barrierRV || held.Annotations[queueBarrierAnnotation] != r.Nonce || held.Spec.Suspend == nil || !*held.Spec.Suspend {
		t.Fatalf("a lost logical exit did not preserve the exact barrier: %v %+v", err, held)
	}

	// The restored pass releases only against the object the server holds.
	api.reset()
	api.setExit(nil)
	api.setReceipts(worker)
	if err = q.reconcileReceipts(ctx); err != nil {
		t.Fatalf("restored codex retirement failed: %v", err)
	}
	seq, ops, releases := api.snapshot()
	if len(releases) != 1 {
		t.Fatalf("expected exactly one release, got %v", releases)
	}
	release := releases[0]
	final, err := q.client.BatchV1().Jobs(q.config.Namespace).Get(ctx, job.Name, meta.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if release["barrierUid"] != string(final.UID) || release["resourceVersion"] != final.ResourceVersion || release["barrierNonce"] != r.Nonce || release["barrierRunId"] != r.RunID || release["jobName"] != final.Name {
		t.Fatalf("the release did not carry the actual inert barrier: %v", release)
	}
	exitIdx, releaseIdx := -1, -1
	for i, s := range seq {
		if s == "exit" && exitIdx < 0 {
			exitIdx = i
		}
		if s == "release" {
			releaseIdx = i
		}
	}
	if exitIdx < 0 || releaseIdx < 0 || exitIdx > releaseIdx {
		t.Fatalf("release did not follow the original logical exit: %v", seq)
	}
	if ops[exitIdx]["runner"] != r.Runner || ops[exitIdx]["claimFingerprint"] != queueClaimFingerprint(receiptFixtureToken) {
		t.Fatalf("the logical exit did not carry the original claim identity: %v", ops[exitIdx])
	}
	if final.Annotations[queueBarrierAnnotation] != r.Nonce || final.Spec.Suspend == nil || !*final.Spec.Suspend {
		t.Fatalf("the permanent barrier did not survive release: %+v", final)
	}
	for _, p := range receiptFenceOwnedPods(ctx, t, q, final) {
		if p.Status.Phase != core.PodSucceeded && p.Status.Phase != core.PodFailed {
			t.Fatalf("release left a %s Pod running", p.Status.Phase)
		}
	}
}

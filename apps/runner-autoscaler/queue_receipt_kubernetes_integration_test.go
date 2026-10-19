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
//	LCARS_RECEIPT_K8S_NODE_SELECTOR  required ROOT-qualified JSON object of existing node labels; no default
//	LCARS_RECEIPT_K8S_IMAGE           root-qualified immutable digest, e.g. registry/runner@sha256:...
//	LCARS_RECEIPT_K8S_SERVICE_ACCOUNT harmless worker ServiceAccount, no writer rights
//	LCARS_RECEIPT_K8S_FIXTURE_SECRET  exact owned dummy Secret: telemetry-writer.json = {} only
//
//	go test -tags=kubernetes_integration -run '^TestReceiptKubernetes$' -count=1 -timeout=420s ./apps/runner-autoscaler
//
// Application bridge (TestReceiptKubernetesApplication, #2312). The matrix above
// scripts the Work API. This separate opt-in family instead talks to the
// PRODUCTION createRunsHandler over loopback with the real CapacityProtocol,
// Orchestrator and an isolated Firestore emulator, owned by
// apps/console/src/lib/queue-receipt-kubernetes.test.ts. It is NEVER run
// directly: that Node test spawns this compiled binary and supplies the
// parent-owned loopback endpoint, a per-invocation random bearer and the
// invocation ID. Consumer sequence (also documented there): first compile
//
//	(cd apps/runner-autoscaler && go test -tags=kubernetes_integration -run '^$' -c -o "$BIN" .)
//
// with BIN an absolute owned path, then run that one Node test through
// tools/firestore-emulator-gate.mjs with FIRESTORE_GATE_EXEC_CMD wrapping
// normal `firebase emulators:exec`, passing every LCARS_RECEIPT_K8S_* value
// above plus LCARS_RECEIPT_K8S_APPLICATION=1 and
// LCARS_RECEIPT_K8S_APPLICATION_BINARY=$BIN. Unset, the family skips and
// contacts nothing; set with a missing or drifting input it FAILS before any
// client is built. Only an exact http://127.0.0.1:<port> parent endpoint is
// accepted, never an arbitrary URL.
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
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	batch "k8s.io/api/batch/v1"
	core "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	meta "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/tools/clientcmd"
	clientcmdapi "k8s.io/client-go/tools/clientcmd/api"
	"k8s.io/client-go/util/retry"
)

const (
	receiptFixtureSubject = "receipt-fence-executor-subject"
	receiptFixtureToken   = "receipt-fence-original-run-token"
	receiptFixtureRunner  = "receipt-fence-runner"
)

// receiptApplicationBearer, when set by the application family, replaces the
// scripted-API subject as the capacity bearer. Empty keeps the old fixtures.
var receiptApplicationBearer string

var receiptFencePool = queueCapacityConfig{PoolID: "receipt-fence-pool", Cluster: "receipt-fence-cluster", Version: 1, WorkerAudience: "receipt-fence-worker"}

// receiptKubernetesRuntime carries no usable zero value on purpose: every
// field must be configured and re-verified against the cluster.
type receiptKubernetesRuntime struct {
	kubeconfig     string
	kubecontext    string
	namespace      string
	namespaceUID   string
	qualifications map[string]string
	nodeSelector   map[string]string
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
		{"LCARS_RECEIPT_K8S_NODE_SELECTOR", os.Getenv("LCARS_RECEIPT_K8S_NODE_SELECTOR")},
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
	if err := json.Unmarshal([]byte(os.Getenv("LCARS_RECEIPT_K8S_NODE_SELECTOR")), &rt.nodeSelector); err != nil || len(rt.nodeSelector) == 0 {
		t.Fatalf("LCARS_RECEIPT_K8S_NODE_SELECTOR must be a nonempty ROOT-qualified JSON string map: %v", err)
	}
	if _, err := meta.LabelSelectorAsSelector(&meta.LabelSelector{MatchLabels: rt.nodeSelector}); err != nil {
		t.Fatalf("invalid qualified node selector: %v", err)
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
	method   string
	path     string
	jobName  string
	lose     bool
	release  chan struct{}
	entered  chan struct{}
	finished chan struct{}
	unblock  sync.Once
	status   int // Written before finished closes; read only after that witness.
}

func (a *receiptFault) releaseRequest() {
	if a.release != nil {
		a.unblock.Do(func() { close(a.release) })
	}
}

func (a *receiptFault) requireFinished(t *testing.T, status int) {
	t.Helper()
	select {
	case <-a.entered:
	default:
		t.Fatal("the armed fault never matched the actual Job request")
	}
	select {
	case <-a.finished:
	default:
		t.Fatal("the matched Job request has not finished")
	}
	if a.status != status {
		t.Fatalf("forwarded Job request returned HTTP %d, want %d", a.status, status)
	}
}

type receiptFaultTransport struct {
	base          http.RoundTripper
	mu            sync.Mutex
	armed         []*receiptFault
	onCreated     func(*batch.Job) error
	lastJobRead   *batch.Job
	beforeRequest func(*http.Request) (*http.Request, error)
	afterResponse func(*http.Request, *http.Response) (*http.Response, error)
}

func (f *receiptFaultTransport) reset() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.armed = nil
}

// holdBefore forwards nothing until releaseRequest; entered witnesses that
// this exact original request, not the later tombstone POST, consumed the hold.
func (f *receiptFaultTransport) holdBefore(method, path, jobName string) *receiptFault {
	a := &receiptFault{method: method, path: path, jobName: jobName,
		release: make(chan struct{}), entered: make(chan struct{}), finished: make(chan struct{})}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.armed = append(f.armed, a)
	return a
}

// loseReply hides only a genuine successful create response. An AlreadyExists
// response remains the real conflict, never an apparent accepted lost reply.
func (f *receiptFaultTransport) loseReply(method, path, jobName string) *receiptFault {
	a := &receiptFault{method: method, path: path, jobName: jobName, lose: true,
		entered: make(chan struct{}), finished: make(chan struct{})}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.armed = append(f.armed, a)
	return a
}

func (f *receiptFaultTransport) take(req *http.Request) *receiptFault {
	f.mu.Lock()
	defer f.mu.Unlock()
	for i, a := range f.armed {
		if a.method != req.Method || a.path != req.URL.Path || req.GetBody == nil {
			continue
		}
		rc, err := req.GetBody()
		if err != nil {
			continue
		}
		var body struct {
			Metadata struct {
				Name string `json:"name"`
			} `json:"metadata"`
		}
		err = json.NewDecoder(io.LimitReader(rc, 1<<20)).Decode(&body)
		rc.Close()
		if err != nil || body.Metadata.Name != a.jobName {
			continue
		}
		f.armed = append(f.armed[:i], f.armed[i+1:]...)
		return a
	}
	return nil
}

// clearJobRead requires this reconciliation to supply its own GET witness;
// it deliberately leaves armed request faults unchanged.
func (f *receiptFaultTransport) clearJobRead() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.lastJobRead = nil
}

// observedJobRead freezes the exact successful GET response the production
// caller received, before a later controller status update can advance its RV.
func (f *receiptFaultTransport) observedJobRead(t *testing.T, namespace, name string) *batch.Job {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.lastJobRead == nil || f.lastJobRead.Namespace != namespace || f.lastJobRead.Name != name || f.lastJobRead.ResourceVersion == "" {
		t.Fatal("the production caller has no exact observed Job version")
	}
	return f.lastJobRead.DeepCopy()
}

func (f *receiptFaultTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if f.beforeRequest != nil {
		var err error
		req, err = f.beforeRequest(req)
		if err != nil {
			return nil, err
		}
	}
	fault := f.take(req)
	if fault != nil {
		close(fault.entered)
		defer close(fault.finished)
		if fault.release != nil {
			select {
			case <-fault.release:
			case <-req.Context().Done():
				return nil, req.Context().Err()
			}
		}
	}
	resp, err := f.base.RoundTrip(req)
	if err != nil {
		return nil, err
	}
	if fault != nil {
		fault.status = resp.StatusCode
	}
	if req.Method == http.MethodPost && strings.HasSuffix(req.URL.Path, "/jobs") && resp.StatusCode == http.StatusCreated {
		// Record ownership from the actual authenticated 201 body before it
		// can be deliberately lost. GET alone never grants cleanup ownership.
		raw, readErr := io.ReadAll(io.LimitReader(resp.Body, (1<<20)+1))
		resp.Body.Close()
		if readErr != nil || len(raw) > 1<<20 {
			return nil, fmt.Errorf("created Job response unreadable or oversized; retain the exact attempted name for review: %v", readErr)
		}
		resp.Body = io.NopCloser(bytes.NewReader(raw))
		var created batch.Job
		if err := json.Unmarshal(raw, &created); err != nil {
			return nil, fmt.Errorf("created Job response cannot establish ownership: %w", err)
		}
		if f.onCreated == nil {
			return nil, fmt.Errorf("created Job has no suite ownership recorder")
		}
		if err := f.onCreated(&created); err != nil {
			return nil, err
		}
	}
	parts := strings.Split(strings.Trim(req.URL.Path, "/"), "/")
	if req.Method == http.MethodGet && resp.StatusCode == http.StatusOK && len(parts) == 7 && parts[0] == "apis" && parts[1] == "batch" && parts[2] == "v1" && parts[3] == "namespaces" && parts[5] == "jobs" {
		// Observe the existing response only; issue no additional API request.
		raw, readErr := io.ReadAll(io.LimitReader(resp.Body, (1<<20)+1))
		resp.Body.Close()
		if readErr != nil || len(raw) > 1<<20 {
			return nil, fmt.Errorf("observed Job response unreadable or oversized: %v", readErr)
		}
		resp.Body = io.NopCloser(bytes.NewReader(raw))
		var observed batch.Job
		if err := json.Unmarshal(raw, &observed); err != nil {
			return nil, fmt.Errorf("observed Job response cannot bind its version: %w", err)
		}
		f.mu.Lock()
		f.lastJobRead = observed.DeepCopy()
		f.mu.Unlock()
	}
	if f.afterResponse != nil {
		resp, err = f.afterResponse(req, resp)
		if err != nil {
			return nil, err
		}
	}
	if fault == nil || !fault.lose || resp.StatusCode != http.StatusCreated {
		return resp, nil // Held late Create must receive the real AlreadyExists.
	}
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	return nil, fmt.Errorf("receipt fence fault: accepted create reply lost after forwarding %s %s", req.Method, req.URL.Path)
}

// receiptWorkAPI is the real loopback half of the fence. It records every
// authenticated action in arrival order and can refuse, drop, or answer with
// the identity the server actually holds.
type receiptWorkAPI struct {
	server           *httptest.Server
	ns               string
	mu               sync.Mutex
	seq              []string
	ops              []map[string]any
	releases         []map[string]any
	receipts         []capacityReceipt
	retirement       *capacityRetirement
	exit             func(attempt int) (code int, body string, drop bool)
	releaseStatus    int
	acceptedReleases int
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
			api.ops = append(api.ops, map[string]any{"action": "exit", "body": x, "path": req.URL.EscapedPath()})
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
			status := http.StatusOK
			if action == "release" {
				api.releases = append(api.releases, x)
				if api.releaseStatus != 0 {
					status = api.releaseStatus
				}
				if status == http.StatusOK {
					api.acceptedReleases++
				}
			}
			retirement := api.retirement
			api.mu.Unlock()
			if status != http.StatusOK {
				w.WriteHeader(status)
				fmt.Fprint(w, `{"message":"fixture release refused"}`)
				return
			}
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

func (a *receiptWorkAPI) setReleaseStatus(status int) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.releaseStatus = status
}

func (a *receiptWorkAPI) acceptedReleaseCount() int {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.acceptedReleases
}

func (a *receiptWorkAPI) reset() {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.seq, a.ops, a.releases = nil, nil, nil
	a.acceptedReleases = 0
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
	t             *testing.T
	rt            receiptKubernetesRuntime
	q             *kubernetesQueue
	mu            sync.Mutex
	jobs          map[string]types.UID
	secrets       map[string]types.UID
	runs          map[string]bool // Exact real-route run IDs the application family seeded.
	done          bool
	invocation    string
	cleanupOnce   sync.Once
	cleanupCtx    context.Context
	cleanupCancel context.CancelFunc
}

// recordCreated is called only from an actual Job POST 201 response, including
// one whose reply is subsequently hidden from the client under test.
func (o *receiptOwnership) recordCreated(j *batch.Job) error {
	if j.UID == "" || j.Namespace != o.rt.namespace || !(strings.HasPrefix(j.Annotations[queueRunAnnotation], "work:receipt-fence-"+o.invocation+"-") || o.runs[j.Annotations[queueRunAnnotation]]) {
		return fmt.Errorf("successful create is outside this invocation's qualified ownership: %s/%s uid=%s", j.Namespace, j.Name, j.UID)
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	if uid, exists := o.jobs[j.Name]; exists && uid != j.UID {
		return fmt.Errorf("successful create changed the owned UID for %s", j.Name)
	}
	o.jobs[j.Name] = j.UID
	o.t.Logf("observed authenticated POST 201 fixture Job namespace=%s name=%s uid=%s resourceVersion=%s", j.Namespace, j.Name, j.UID, j.ResourceVersion)
	return nil
}

func (o *receiptOwnership) ownJob(t *testing.T, j *batch.Job) {
	t.Helper()
	o.mu.Lock()
	defer o.mu.Unlock()
	if j == nil || j.Namespace != o.rt.namespace || j.UID == "" || o.jobs[j.Name] != j.UID {
		t.Fatal("a Job without an exact observed POST 201 UID cannot enter cleanup ownership")
	}
}

// All failure-path joining and object cleanup share one independent 120s
// allowance. t.Cleanup runs for ordinary failures/panics, not process death.
func (o *receiptOwnership) cleanupContext() context.Context {
	o.cleanupOnce.Do(func() {
		o.cleanupCtx, o.cleanupCancel = context.WithTimeout(context.Background(), 120*time.Second)
	})
	return o.cleanupCtx
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

// cleanup is independently bounded after a logical deadline or ordinary test
// failure. A process/global Go timeout can prevent cleanup; retained identities
// must then be inspected by the owning operator, never claimed removed.
func (o *receiptOwnership) cleanup() {
	o.mu.Lock()
	if o.done {
		o.mu.Unlock()
		return
	}
	o.done = true
	o.mu.Unlock()
	ctx := o.cleanupContext()
	defer o.cleanupCancel()
	o.cleanupObjects(ctx)
}

// Between families this uses remaining logical time, not a new cleanup
// allowance. Final/failure cleanup uses the one independent shared context.
func (o *receiptOwnership) cleanupObjects(ctx context.Context) bool {
	o.mu.Lock()
	jobs, secrets := map[string]types.UID{}, map[string]types.UID{}
	for n, u := range o.jobs {
		jobs[n] = u
	}
	for n, u := range o.secrets {
		secrets[n] = u
	}
	o.mu.Unlock()
	ok := true
	ns, err := o.q.client.CoreV1().Namespaces().Get(ctx, o.rt.namespace, meta.GetOptions{})
	if err != nil || ns.UID != types.UID(o.rt.namespaceUID) || ns.DeletionTimestamp != nil {
		o.t.Errorf("cleanup cannot re-qualify namespace %s uid=%s; retaining Jobs=%v Secrets=%v: %v", o.rt.namespace, o.rt.namespaceUID, jobs, secrets, err)
		return false
	}
	for k, v := range o.rt.qualifications {
		if ns.Labels[k] != v {
			o.t.Errorf("cleanup namespace qualification changed %s=%s; retaining Jobs=%v Secrets=%v", k, v, jobs, secrets)
			return false
		}
	}
	for name, uid := range jobs {
		current, err := o.q.client.BatchV1().Jobs(o.rt.namespace).Get(ctx, name, meta.GetOptions{})
		if apierrors.IsNotFound(err) {
			continue
		}
		if err != nil || current.UID != uid || current.Namespace != o.rt.namespace {
			o.t.Errorf("cleanup cannot identify owned Job %s uid=%s; retaining it: %v", name, uid, err)
			ok = false
			continue
		}
		policy := meta.DeletePropagationForeground
		preconditions := meta.Preconditions{UID: &uid}
		if rv := current.ResourceVersion; rv != "" {
			preconditions.ResourceVersion = &rv
		}
		if err := o.q.client.BatchV1().Jobs(o.rt.namespace).Delete(ctx, name, meta.DeleteOptions{PropagationPolicy: &policy, Preconditions: &preconditions}); err != nil && !apierrors.IsNotFound(err) {
			o.t.Errorf("cleanup delete refused for owned Job %s uid=%s; retaining it: %v", name, uid, err)
			ok = false
		}
	}
	// Attempt every exact Secret deletion before waiting for any Job finalizer.
	for name, uid := range secrets {
		current, err := o.q.client.CoreV1().Secrets(o.rt.namespace).Get(ctx, name, meta.GetOptions{})
		if apierrors.IsNotFound(err) {
			continue
		}
		if err != nil || current.UID != uid {
			o.t.Errorf("cleanup cannot identify owned Secret %s uid=%s; retaining it: %v", name, uid, err)
			ok = false
			continue
		}
		if current.ResourceVersion == "" {
			o.t.Errorf("owned Secret has no observed resourceVersion: %s", name)
			ok = false
			continue
		}
		preconditions := meta.Preconditions{UID: &uid, ResourceVersion: &current.ResourceVersion}
		if err := o.q.client.CoreV1().Secrets(o.rt.namespace).Delete(ctx, name, meta.DeleteOptions{Preconditions: &preconditions}); err != nil && !apierrors.IsNotFound(err) {
			o.t.Errorf("cleanup delete refused for owned Secret %s uid=%s; retaining it: %v", name, uid, err)
			ok = false
		}
	}
	// One deadline for all waits. No per-object timeout or context-free sleep.
	for len(jobs)+len(secrets) != 0 {
		for name, uid := range jobs {
			j, err := o.q.client.BatchV1().Jobs(o.rt.namespace).Get(ctx, name, meta.GetOptions{})
			if apierrors.IsNotFound(err) {
				o.t.Logf("cleanup observed NotFound for owned Job namespace=%s name=%s uid=%s", o.rt.namespace, name, uid)
				delete(jobs, name)
			} else if err == nil && j.UID != uid {
				o.t.Errorf("cleanup Job replacement retained: %s observedUID=%s ownedUID=%s", name, j.UID, uid)
				ok = false
				delete(jobs, name) // Foreign replacement is never ours to wait on.
			}
		}
		for name, uid := range secrets {
			x, err := o.q.client.CoreV1().Secrets(o.rt.namespace).Get(ctx, name, meta.GetOptions{})
			if apierrors.IsNotFound(err) {
				o.t.Logf("cleanup observed NotFound for owned Secret namespace=%s name=%s uid=%s", o.rt.namespace, name, uid)
				delete(secrets, name)
			} else if err == nil && x.UID != uid {
				o.t.Errorf("cleanup Secret replacement retained: %s observedUID=%s ownedUID=%s", name, x.UID, uid)
				ok = false
				delete(secrets, name)
			}
		}
		if len(jobs)+len(secrets) == 0 {
			return ok
		}
		select {
		case <-ctx.Done():
			o.t.Errorf("cleanup deadline; unconfirmed owned Jobs=%v Secrets=%v namespace=%s: %v", jobs, secrets, o.rt.namespace, ctx.Err())
			return false
		case <-time.After(time.Second):
		}
	}
	return ok
}

// receiptFenceQueue builds the production queue against the qualified cluster
// only. Every qualification is re-read under the shared logical deadline
// before writes; independent cleanup covers ordinary test failures only.
func receiptFenceQueue(ctx context.Context, t *testing.T, rt receiptKubernetesRuntime) (*kubernetesQueue, *receiptWorkAPI, *receiptFaultTransport, *receiptOwnership) {
	return receiptFenceQueueEndpoint(ctx, t, rt, "", "", true)
}

// Only the subprocess family supplies an already-owned parent loopback endpoint.
// Child cleanup is parent-owned because SIGKILL cannot run t.Cleanup.
func receiptFenceQueueEndpoint(ctx context.Context, t *testing.T, rt receiptKubernetesRuntime, endpoint, invocation string, cleanup bool) (*kubernetesQueue, *receiptWorkAPI, *receiptFaultTransport, *receiptOwnership) {
	t.Helper()
	faults := &receiptFaultTransport{}
	// An omitted namespace in an existing context must not synthesize default.
	// Preserve refusal of an explicitly conflicting context namespace, then
	// select only the already-required disposable target without editing config.
	raw, err := clientcmd.LoadFromFile(rt.kubeconfig)
	if err != nil {
		t.Fatalf("reading the explicit context namespace: %v", err)
	}
	configured, exists := raw.Contexts[rt.kubecontext]
	if !exists || configured == nil {
		t.Fatal("the exact required context is absent")
	}
	if configured.Namespace != "" && configured.Namespace != rt.namespace {
		t.Fatalf("context %q explicitly names namespace %q, not %q", rt.kubecontext, configured.Namespace, rt.namespace)
	}
	loader := clientcmd.NewNonInteractiveDeferredLoadingClientConfig(
		&clientcmd.ClientConfigLoadingRules{ExplicitPath: rt.kubeconfig},
		&clientcmd.ConfigOverrides{CurrentContext: rt.kubecontext, Context: clientcmdapi.Context{Namespace: rt.namespace}})
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
	// Jobs otherwise prefer Protobuf in pinned client-go. The fault matcher
	// and201 ownership recorder deliberately inspect the real JSON wire body.
	cfg.ContentType = "application/json"
	cfg.AcceptContentTypes = "application/json"
	cfg.Wrap(func(base http.RoundTripper) http.RoundTripper {
		faults.base = base
		return faults
	})
	client, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		t.Fatalf("building the qualified client: %v", err)
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
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
	if len(dummy.Data) != 1 || !bytes.Equal(dummy.Data["telemetry-writer.json"], []byte("{}")) {
		t.Fatalf("dummy Secret %s must contain exactly telemetry-writer.json with inert {} bytes", rt.fixtureSecret)
	}

	// This only corroborates the explicit ROOT qualification against the same
	// cluster. ROOT must independently qualify full physical resource fit.
	selector, err := meta.LabelSelectorAsSelector(&meta.LabelSelector{MatchLabels: rt.nodeSelector})
	if err != nil {
		t.Fatalf("invalid qualified node selector: %v", err)
	}
	nodes, err := client.CoreV1().Nodes().List(ctx, meta.ListOptions{LabelSelector: selector.String()})
	if err != nil {
		t.Fatalf("reading qualified existing nodes: %v", err)
	}
	eligible := false
	for _, node := range nodes.Items {
		if node.DeletionTimestamp != nil || node.Spec.Unschedulable {
			continue
		}
		blocked := false
		for _, taint := range node.Spec.Taints {
			if taint.Effect == core.TaintEffectNoSchedule || taint.Effect == core.TaintEffectNoExecute {
				blocked = true
			}
		}
		for _, condition := range node.Status.Conditions {
			if !blocked && condition.Type == core.NodeReady && condition.Status == core.ConditionTrue {
				eligible = true
			}
		}
	}
	if !eligible {
		t.Fatal("qualified node selector has no existing Ready schedulable node without untolerated hard taints")
	}

	var api *receiptWorkAPI
	if endpoint == "" {
		api = newReceiptWorkAPI(t, rt.namespace)
	} else {
		api = &receiptWorkAPI{server: &httptest.Server{URL: endpoint}}
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	pool := receiptFencePool
	q := &kubernetesQueue{
		client: client, image: rt.image, logger: logger, workerPolicyProviders: "loopback",
		config: queueKubernetesConfig{
			Namespace: rt.namespace, CredentialsSecret: rt.fixtureSecret, ServiceAccount: rt.serviceAccount,
			MaxConcurrent: 2, NodeSelector: rt.nodeSelector,
			Requests: map[string]string{"cpu": "50m", "memory": "64Mi", "ephemeral-storage": "64Mi"},
			Limits:   map[string]string{"cpu": "200m", "memory": "128Mi", "ephemeral-storage": "128Mi"},
			Capacity: &pool,
		},
		verifyRun: func(context.Context, string, string) error { return nil },
	}
	idToken := func() (string, error) {
		if receiptApplicationBearer != "" {
			return receiptApplicationBearer, nil
		}
		return receiptFixtureSubject, nil
	}
	q.capacity = &queueCapacityClient{config: pool, namespace: rt.namespace, maxConcurrent: 2, consoleURL: api.server.URL, idToken: idToken, producerID: newCapacityIdentity(), registered: endpoint == ""}
	q.exits = newRunExitReporter(api.server.URL, receiptFixtureRunner, idToken, logger)
	q.claimSettled = queueClaimStatus(api.server.URL, idToken)

	if invocation == "" {
		var nonce [16]byte
		if _, err := rand.Read(nonce[:]); err != nil {
			t.Fatal(err)
		}
		invocation = fmt.Sprintf("%x", nonce)
	}
	own := &receiptOwnership{t: t, rt: rt, q: q, jobs: map[string]types.UID{}, secrets: map[string]types.UID{}, invocation: invocation}
	faults.onCreated = own.recordCreated
	if cleanup {
		t.Cleanup(own.cleanup)
	}
	return q, api, faults, own
}

func receiptFenceNewReceipt(own *receiptOwnership, purpose string) capacityReceipt {
	return receiptFenceReceipt("work:receipt-fence-"+own.invocation+"-"+purpose+"/r1", "receipt-fence-"+own.invocation+"-"+purpose)
}

func receiptFenceRequireAbsent(ctx context.Context, t *testing.T, q *kubernetesQueue, name string) {
	t.Helper()
	if _, err := q.client.BatchV1().Jobs(q.config.Namespace).Get(ctx, name, meta.GetOptions{}); !apierrors.IsNotFound(err) {
		t.Fatalf("the invocation's exact Job name must be absent before create: %v", err)
	}
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

// Controller-owned status and managed fields may change resourceVersion
// without changing the same inert Job. Keep identity, full spec and receipt
// metadata exact; compare protocol RVs to the response actually observed.
func receiptFenceSameJob(before, after *batch.Job) bool {
	return before != nil && after != nil && before.UID != "" && before.UID == after.UID &&
		before.Name == after.Name && before.Namespace == after.Namespace &&
		before.Generation == after.Generation && after.ResourceVersion != "" && after.DeletionTimestamp == nil &&
		reflect.DeepEqual(before.Spec, after.Spec) && reflect.DeepEqual(before.Annotations, after.Annotations) &&
		reflect.DeepEqual(before.Labels, after.Labels)
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

func receiptFenceWaitPods(ctx context.Context, t *testing.T, q *kubernetesQueue, j *batch.Job, want func([]core.Pod) bool, what string) []core.Pod {
	t.Helper()
	for {
		pods := receiptFenceOwnedPods(ctx, t, q, j)
		if want(pods) {
			return pods
		}
		select {
		case <-ctx.Done():
			t.Fatalf("%s: %v", what, ctx.Err())
		case <-time.After(2 * time.Second):
		}
	}
}

func receiptFenceSecret(q *kubernetesQueue, j *batch.Job) *core.Secret {
	return receiptFenceSecretWith(q, j, receiptFixtureToken)
}

func receiptFenceSecretWith(q *kubernetesQueue, j *batch.Job, token string) *core.Secret {
	return &core.Secret{ObjectMeta: meta.ObjectMeta{
		Name: j.Name, Namespace: q.config.Namespace,
		OwnerReferences: []meta.OwnerReference{{APIVersion: "batch/v1", Kind: "Job", Name: j.Name, UID: j.UID, Controller: ptr(true)}},
	}, Immutable: ptr(true), Data: map[string][]byte{"run-token": []byte(token)}}
}

func receiptFenceWorker(r capacityReceipt, pod core.Pod, generation int, active bool) capacityReceipt {
	c := r
	c.Worker = &capacityWorker{Generation: generation, PodUID: string(pod.UID), JobUID: r.JobUID, Active: active}
	return c
}

// All families, including actual controller death/restart, share180s logical
// time and one independent120s cleanup. No process/case resets either clock.
// Run with an outer go test -timeout420s; that is slack, not an extended proof.
func TestReceiptKubernetes(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	defer cancel()
	rt := receiptKubernetesRuntimeFromEnv(t)
	q, api, faults, own := receiptFenceQueue(ctx, t, rt)
	if !t.Run("WriteFences", func(t *testing.T) {
		receiptKubernetesWriteFences(ctx, t, q, api, faults, own)
	}) {
		return
	}
	// Earlier suspended fixtures must not pollute the restored family's real
	// physical inventory. Their removal consumes this same logical budget.
	if !own.cleanupObjects(ctx) {
		return
	}
	if !t.Run("RestoredCodexRetirement", func(t *testing.T) { receiptKubernetesRestoredCodexRetirement(ctx, t, q, api, faults, own) }) {
		return
	}
	if !own.cleanupObjects(ctx) {
		return
	}
	t.Run("ControllerProcessDeath", func(t *testing.T) { receiptKubernetesProcessDeath(ctx, t, rt, q, own) })
}

func receiptKubernetesWriteFences(ctx context.Context, t *testing.T, q *kubernetesQueue, api *receiptWorkAPI, faults *receiptFaultTransport, own *receiptOwnership) {

	if !t.Run("accepted-create-with-lost-reply-keeps-storage-debt", func(t *testing.T) {
		faults.reset()
		api.reset()
		r := receiptFenceNewReceipt(own, "lost-create")
		receiptFenceBindProducer(&r, q.capacity.producerID)
		n, err := q.capacity.recovery(ctx, r, "recover")
		if err != nil {
			t.Fatal(err)
		}
		desired := receiptFenceSuspendedJob(t, q, r, false)
		jobsPath := "/apis/batch/v1/namespaces/" + q.config.Namespace + "/jobs"
		receiptFenceRequireAbsent(ctx, t, q, desired.Name)
		lost := faults.loseReply(http.MethodPost, jobsPath, desired.Name)
		err = q.capacity.write(ctx, r, n, func() error {
			_, e := q.client.BatchV1().Jobs(q.config.Namespace).Create(ctx, desired, meta.CreateOptions{})
			return e
		})
		lost.requireFinished(t, http.StatusCreated)
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
		own.ownJob(t, job)
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
	}) {
		return
	}

	if !t.Run("late-accepted-create-cannot-pass-the-server-barrier", func(t *testing.T) {
		faults.reset()
		api.reset()
		api.setRetirement(nil)
		r := receiptFenceNewReceipt(own, "late-create")
		r.State = "retiring"
		receiptFenceBindProducer(&r, q.capacity.producerID)
		if _, err := q.capacity.recovery(ctx, r, "retire"); err != nil {
			t.Fatal(err)
		}
		desired := receiptFenceSuspendedJob(t, q, r, false)
		jobsPath := "/apis/batch/v1/namespaces/" + q.config.Namespace + "/jobs"
		receiptFenceRequireAbsent(ctx, t, q, desired.Name)
		hold := faults.holdBefore(http.MethodPost, jobsPath, desired.Name)
		createCtx, cancelCreate := context.WithCancel(ctx)
		requestDone := make(chan struct{})
		joined := false
		defer func() {
			cancelCreate()
			hold.releaseRequest()
			if !joined {
				select {
				case <-requestDone:
				case <-own.cleanupContext().Done():
					t.Error("owned late Create did not join within the shared cleanup budget")
				}
			}
		}()
		type late struct {
			job *batch.Job
			err error
		}
		done := make(chan late, 1)
		go func() {
			defer close(requestDone)
			j, e := q.client.BatchV1().Jobs(q.config.Namespace).Create(createCtx, desired, meta.CreateOptions{})
			done <- late{j, e}
		}()
		select {
		case <-hold.entered:
		case <-ctx.Done():
			t.Fatalf("original Create never entered the exact hold: %v", ctx.Err())
		}
		// The actual original POST is now held before forwarding. A positive
		// GET404 precedes the distinct real tombstone Create.
		if _, err := q.client.BatchV1().Jobs(q.config.Namespace).Get(ctx, desired.Name, meta.GetOptions{}); !apierrors.IsNotFound(err) {
			t.Fatalf("absence must be a real NotFound for the exact name, got %v", err)
		}
		tombstone, err := q.installAbsentBarrier(ctx, r)
		if err != nil {
			t.Fatalf("installing the real absent barrier: %v", err)
		}
		own.ownJob(t, tombstone)
		if tombstone.Annotations[queueBarrierAnnotation] != r.Nonce || tombstone.Spec.Suspend == nil || !*tombstone.Spec.Suspend {
			t.Fatal("the absent-name barrier is not an inert server-owned tombstone")
		}
		hold.releaseRequest()
		var got late
		select {
		case got = <-done:
		case <-ctx.Done():
			t.Fatalf("held late Create did not return: %v", ctx.Err())
		}
		select {
		case <-requestDone:
			joined = true
		case <-ctx.Done():
			t.Fatalf("held late Create did not join: %v", ctx.Err())
		}
		hold.requireFinished(t, http.StatusConflict)
		if !apierrors.IsAlreadyExists(got.err) {
			t.Fatalf("the late create must collide with the installed barrier, got %v", got.err)
		}
		after, err := q.client.BatchV1().Jobs(q.config.Namespace).Get(ctx, desired.Name, meta.GetOptions{})
		if err != nil || !receiptFenceSameJob(tombstone, after) || after.Annotations[queueBarrierAnnotation] != r.Nonce || after.Spec.Suspend == nil || !*after.Spec.Suspend || queueJobAttempted(after) {
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
	}) {
		return
	}

	if !t.Run("stale-barrier-write-preserves-the-server-replacement", func(t *testing.T) {
		faults.reset()
		api.reset()
		api.setRetirement(nil)
		r := receiptFenceNewReceipt(own, "stale-cas")
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
		own.ownJob(t, job)
		r.JobUID = string(job.UID)
		var stale, replaced *batch.Job
		// Build the intentional stale write from the exact pre-update version.
		// A controller status conflict during fixture preparation is retried
		// under this same context; production retireReceipt still gets stale.
		err = retry.RetryOnConflict(retry.DefaultBackoff, func() error {
			current, getErr := q.client.BatchV1().Jobs(q.config.Namespace).Get(ctx, job.Name, meta.GetOptions{})
			if getErr != nil {
				return getErr
			}
			if !receiptFenceSameJob(job, current) {
				return fmt.Errorf("the controlled fixture changed before its stale-write update")
			}
			stale = current.DeepCopy()
			current.Annotations["agent-lcars.receipt-fence-probe"] = "replacement"
			var updateErr error
			replaced, updateErr = q.client.BatchV1().Jobs(q.config.Namespace).Update(ctx, current, meta.UpdateOptions{})
			return updateErr
		})
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
		if err != nil || !receiptFenceSameJob(replaced, after) || after.Annotations["agent-lcars.receipt-fence-probe"] != "replacement" || after.Annotations[queueBarrierAnnotation] != "" {
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
	}) {
		return
	}

	if !t.Run("resume-refuses-a-replaced-credential", func(t *testing.T) {
		faults.reset()
		api.reset()
		r := receiptFenceNewReceipt(own, "replaced-secret")
		n, err := q.capacity.recovery(ctx, r, "recover")
		if err != nil {
			t.Fatal(err)
		}
		job, err := q.client.BatchV1().Jobs(q.config.Namespace).Create(ctx, receiptFenceSuspendedJob(t, q, r, false), meta.CreateOptions{})
		if err != nil {
			t.Fatal(err)
		}
		own.ownJob(t, job)
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
	}) {
		return
	}
}

// receiptKubernetesRestoredCodexRetirement exercises the codex retirement
// family with a deliberately harmless shell fixture, not provider/bootstrap: a
// receipt with no provider proof, a real Job, a real credential, a real Pod,
// and the production barrier/exit/release order against the real apiserver.
func receiptKubernetesRestoredCodexRetirement(ctx context.Context, t *testing.T, q *kubernetesQueue, api *receiptWorkAPI, faults *receiptFaultTransport, own *receiptOwnership) {
	faults.reset()
	api.reset()
	api.setRetirement(nil)

	r := receiptFenceNewReceipt(own, "codex-retirement")
	receiptFenceBindProducer(&r, q.capacity.producerID)
	n, err := q.capacity.recovery(ctx, r, "recover")
	if err != nil {
		t.Fatal(err)
	}
	receiptFenceRequireAbsent(ctx, t, q, r.JobName)
	var job *batch.Job
	if err = q.capacity.write(ctx, r, n, func() error {
		var e error
		job, e = q.client.BatchV1().Jobs(q.config.Namespace).Create(ctx, receiptFenceSuspendedJob(t, q, r, true), meta.CreateOptions{})
		return e
	}); err != nil {
		t.Fatalf("the fenced write failed: %v", err)
	}
	own.ownJob(t, job)
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
	pods := receiptFenceWaitPods(ctx, t, q, job, func(p []core.Pod) bool {
		return len(p) == 1 && p[0].DeletionTimestamp == nil && p[0].Status.Phase == core.PodRunning
	}, "observe the real codex fixture Pod")
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

	// PodSucceeded may precede the Job controller's terminal condition. Wait
	// for the production physical-end predicate on fresh SAME-UID objects,
	// under the original shared logical deadline, before testing exit refusal.
	for {
		freshJob, getErr := q.client.BatchV1().Jobs(q.config.Namespace).Get(ctx, job.Name, meta.GetOptions{})
		if getErr != nil {
			t.Fatalf("reading the original fixture Job termination: %v", getErr)
		}
		if freshJob.UID != job.UID || freshJob.DeletionTimestamp != nil {
			t.Fatal("the original fixture Job disappeared, was replaced or is deleting")
		}
		freshPods := receiptFenceOwnedPods(ctx, t, q, freshJob)
		ended, neverStarted := physicalReceiptWorkersEnded(freshJob, freshPods)
		if ended && !neverStarted && len(freshPods) == 1 && freshPods[0].UID == pod.UID && freshPods[0].Status.Phase == core.PodSucceeded {
			job, pods = freshJob, freshPods
			break
		}
		select {
		case <-ctx.Done():
			t.Fatalf("observe complete original Job and owned container termination: %v", ctx.Err())
		case <-time.After(2 * time.Second):
		}
	}
	pod = pods[0]
	worker = receiptFenceWorker(r, pod, 1, true)

	// Refusal of the logical exit keeps the slot and the exact barrier.
	api.setReceipts(worker)
	api.reset()
	api.setExit(func(int) (int, string, bool) { return http.StatusConflict, `{"message":"logical exit refused"}`, false })
	if err = q.reconcileReceipts(ctx); err == nil {
		t.Fatal("a refused logical exit released capacity")
	}
	if api.count("exit") == 0 {
		t.Fatal("the refused logical-exit fault was never exercised")
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

	// A lost logical exit preserves the same inert UID/spec/receipt barrier.
	api.reset()
	api.setExit(func(int) (int, string, bool) { return 0, "", true })
	if err = q.reconcileReceipts(ctx); err == nil {
		t.Fatal("a lost logical exit released capacity")
	}
	if api.count("exit") == 0 {
		t.Fatal("the lost logical-exit fault was never exercised")
	}
	if api.count("release") != 0 {
		t.Fatal("a lost logical exit released capacity")
	}
	held, err := q.client.BatchV1().Jobs(q.config.Namespace).Get(ctx, job.Name, meta.GetOptions{})
	if err != nil || !receiptFenceSameJob(barrier, held) || held.Annotations[queueBarrierAnnotation] != r.Nonce || held.Spec.Suspend == nil || !*held.Spec.Suspend {
		t.Fatalf("a lost logical exit did not preserve the exact barrier: %v %+v", err, held)
	}

	// A successful original exit still cannot release a server-refused slot.
	api.reset()
	api.setExit(nil)
	api.setReleaseStatus(http.StatusConflict)
	api.setReceipts(worker)
	faults.clearJobRead()
	if err = q.reconcileReceipts(ctx); err == nil {
		t.Fatal("a release409 was treated as accepted retirement")
	}
	_, _, refused := api.snapshot()
	if len(refused) != 1 || api.acceptedReleaseCount() != 0 {
		t.Fatalf("release409 must have exactly one refused request and no accepted release: %v", refused)
	}
	refusedObservation := faults.observedJobRead(t, q.config.Namespace, job.Name)
	refusedBarrier, err := q.client.BatchV1().Jobs(q.config.Namespace).Get(ctx, job.Name, meta.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	failedRelease := refused[0]
	if refusedBarrier.UID != barrier.UID || !receiptFenceSameJob(refusedObservation, refusedBarrier) || failedRelease["barrierUid"] != string(refusedObservation.UID) || failedRelease["resourceVersion"] != refusedObservation.ResourceVersion || failedRelease["barrierNonce"] != r.Nonce || failedRelease["barrierRunId"] != r.RunID || failedRelease["jobName"] != refusedBarrier.Name || refusedBarrier.Annotations[queueBarrierAnnotation] != r.Nonce || refusedBarrier.Spec.Suspend == nil || !*refusedBarrier.Spec.Suspend {
		t.Fatalf("release409 did not retain the exact requested UID/resourceVersion barrier: request=%v object=%+v", failedRelease, refusedBarrier)
	}
	if q.verifiedReceiptBarriers[job.Name] != "" {
		t.Fatal("release409 cached the unaccepted barrier as verified")
	}

	// The restored pass releases only against the object the server holds.
	api.reset()
	api.setReleaseStatus(http.StatusOK)
	api.setExit(nil)
	api.setReceipts(worker)
	faults.clearJobRead()
	if err = q.reconcileReceipts(ctx); err != nil {
		t.Fatalf("restored codex retirement failed: %v", err)
	}
	seq, _, releases := api.snapshot()
	if len(releases) != 1 || api.acceptedReleaseCount() != 1 {
		t.Fatalf("expected exactly one release, got %v", releases)
	}
	release := releases[0]
	releasedObservation := faults.observedJobRead(t, q.config.Namespace, job.Name)
	final, err := q.client.BatchV1().Jobs(q.config.Namespace).Get(ctx, job.Name, meta.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if !receiptFenceSameJob(releasedObservation, final) || release["barrierUid"] != string(releasedObservation.UID) || release["resourceVersion"] != releasedObservation.ResourceVersion || release["barrierNonce"] != r.Nonce || release["barrierRunId"] != r.RunID || release["jobName"] != final.Name {
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
	exits := api.actions("exit")
	if len(exits) != 1 {
		t.Fatalf("expected exactly one original logical exit, got %v", exits)
	}
	exitBody, ok := exits[0]["body"].(map[string]any)
	if !ok || exitBody["runner"] != r.Runner || exitBody["claimFingerprint"] != queueClaimFingerprint(receiptFixtureToken) || exits[0]["path"] != "/api/work/v1/runs/"+url.PathEscape(r.RunID)+"/exit" {
		t.Fatalf("the logical exit did not carry the original run/runner/claim identity: %v", exits[0])
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

// Process-death coverage uses THIS executable, a surviving parent Work API and
// actual authenticated Kubernetes responses. Only this family modifies outgoing
// fixture Jobs: Command/Args and activeDeadlineSeconds. It never starts a provider.
const receiptDeathChildEnv = "LCARS_RECEIPT_K8S_PROCESS_CHILD"
const receiptDeathFrameLimit = 64 << 10
const receiptDeathSubject = receiptFixtureSubject

type receiptDeathConfig struct {
	Invocation   string    `json:"invocation"`
	RunID        string    `json:"runId"`
	NamespaceUID string    `json:"namespaceUID"`
	API          string    `json:"api"`
	Checkpoint   string    `json:"checkpoint"`
	Successor    bool      `json:"successor"`
	Deadline     time.Time `json:"deadline"`
	// Application mode talks to the production route: the run token is minted
	// by the claim, so the Secret check binds the captured token, not a fixture.
	Application bool   `json:"application,omitempty"`
	Pool        string `json:"pool,omitempty"`
	Bearer      string `json:"bearer,omitempty"`
	Pipeline    string `json:"pipeline,omitempty"`
	// ExpectedTokenHash is parent-only (never sent to the child).
	ExpectedTokenHash string `json:"-"`
}
type receiptDeathFrame struct {
	Kind       string           `json:"kind"`
	Status     int              `json:"status,omitempty"`
	Namespace  string           `json:"namespace,omitempty"`
	Name       string           `json:"name,omitempty"`
	UID        types.UID        `json:"uid,omitempty"`
	RV         string           `json:"rv,omitempty"`
	RunID      string           `json:"runId"`
	Producer   string           `json:"producer"`
	JobUID     types.UID        `json:"jobUID,omitempty"`
	Immutable  bool             `json:"immutable,omitempty"`
	TokenHash  string           `json:"tokenHash,omitempty"`
	Suspend    bool             `json:"suspend,omitempty"`
	Generation int64            `json:"generation,omitempty"`
	Checkpoint bool             `json:"checkpoint,omitempty"`
	Outcome    queuePollOutcome `json:"outcome,omitempty"`
	Error      string           `json:"error,omitempty"`
}

// LimitReader bounds allocation BEFORE JSON parsing, including a missing newline.
// Each physical pipe record is newline delimited and bounded; no raw Secret data.
func receiptDeathReadFrame(r io.Reader) (receiptDeathFrame, error) {
	var f receiptDeathFrame
	var b []byte
	one := make([]byte, 1)
	for len(b) <= receiptDeathFrameLimit {
		n, err := r.Read(one)
		if n == 1 {
			if one[0] == '\n' {
				if len(b) == 0 {
					return f, fmt.Errorf("empty frame")
				}
				if err := json.Unmarshal(b, &f); err != nil {
					return f, err
				}
				return f, nil
			}
			b = append(b, one[0])
		}
		if err != nil {
			if err == io.EOF && len(b) == 0 {
				return f, io.EOF
			}
			return f, fmt.Errorf("truncated frame: %w", err)
		}
	}
	return f, fmt.Errorf("frame exceeds %d bytes", receiptDeathFrameLimit)
}
func receiptDeathWrite(w io.Writer, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	if len(b) > receiptDeathFrameLimit {
		return fmt.Errorf("oversized IPC frame")
	}
	b = append(b, '\n')
	n, err := w.Write(b)
	if err == nil && n != len(b) {
		err = io.ErrShortWrite
	}
	return err
}
func receiptDeathTokenHash() string {
	h := sha256.Sum256([]byte(receiptFixtureToken))
	return hex.EncodeToString(h[:])
}
func receiptDeathKilled(ps *os.ProcessState) bool {
	if ps == nil {
		return false
	}
	w, ok := ps.Sys().(syscall.WaitStatus)
	return ok && w.Signaled() && w.Signal() == syscall.SIGKILL
}

type receiptDeathOutput struct {
	mu       sync.Mutex
	b        []byte
	overflow bool
}

func (w *receiptDeathOutput) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	n := len(p)
	remaining := (1 << 20) - len(w.b)
	if len(p) > remaining {
		p = p[:remaining]
		w.overflow = true
	}
	w.b = append(w.b, p...)
	return n, nil
}
func (w *receiptDeathOutput) snapshot() (string, bool) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return string(w.b), w.overflow
}

// Parent API state survives both executables. It models only the contract under
// test: unresolved original authority cannot authorize a new producer or release.
// Its exact refusal is asserted, not accepted as an arbitrary "safe" error.
type receiptDeathAPI struct {
	server          *httptest.Server
	mu              sync.Mutex
	ctx             context.Context
	ns              string
	r               capacityReceipt
	checkpoint      string
	claimed         bool
	producer        string
	requestID       string
	registered      map[string]bool
	pending         map[string]bool
	resolved        map[string]bool
	actions         []string
	violations      []string
	refusedRecovery int
	recoverers      []string
	claims          int
	releases        int
	claimEntered    chan struct{}
	claimOnce       sync.Once
}

func newReceiptDeathAPI(ctx context.Context, t *testing.T, ns string, r capacityReceipt, checkpoint string) *receiptDeathAPI {
	a := &receiptDeathAPI{ctx: ctx, ns: ns, r: r, checkpoint: checkpoint, registered: map[string]bool{}, pending: map[string]bool{}, resolved: map[string]bool{}, claimEntered: make(chan struct{})}
	a.server = httptest.NewServer(http.HandlerFunc(a.serve))
	t.Cleanup(a.server.Close)
	return a
}
func (a *receiptDeathAPI) violate(w http.ResponseWriter, why string) {
	a.violations = append(a.violations, why)
	http.Error(w, "invalid controlled transition", http.StatusConflict)
}
func (a *receiptDeathAPI) serve(w http.ResponseWriter, req *http.Request) {
	if req.Header.Get("Authorization") != "Bearer "+receiptDeathSubject {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	if req.Method == http.MethodGet && req.URL.Path == "/api/work/v1/runs/capacity" {
		a.mu.Lock()
		defer a.mu.Unlock()
		receipts := []capacityReceipt{}
		if a.claimed {
			r := a.r
			r.Producers = []capacityProducer{{ProducerID: a.producer, Subject: receiptDeathSubject, PendingWrites: []string{}}}
			for id := range a.pending {
				r.Producers[0].PendingWrites = append(r.Producers[0].PendingWrites, id)
			}
			receipts = append(receipts, r)
		}
		a.actions = append(a.actions, "inventory")
		json.NewEncoder(w).Encode(map[string]any{"policy": map[string]any{"poolId": receiptFencePool.PoolID, "cluster": receiptFencePool.Cluster, "namespace": a.ns, "version": receiptFencePool.Version, "maxConcurrent": 2, "enforced": true, "inventoryKnown": true}, "receipts": receipts})
		return
	}
	var x struct {
		Action         string        `json:"action"`
		ProducerID     string        `json:"producerId"`
		ClaimRequestID string        `json:"claimRequestId"`
		Runner         string        `json:"runner"`
		Version        int           `json:"capacityVersion"`
		Fence          capacityFence `json:"fence"`
		Nonce          string        `json:"recoveryNonce"`
		Operation      string        `json:"operationId"`
		Resolved       bool          `json:"resolved"`
		JobUID         string        `json:"jobUid"`
		JobName        string        `json:"jobName"`
		SecretUID      string        `json:"secretUid"`
		SecretHash     string        `json:"secretTokenHash"`
		Owned          bool          `json:"owned"`
	}
	dec := json.NewDecoder(io.LimitReader(req.Body, receiptDeathFrameLimit+1))
	if err := dec.Decode(&x); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if req.Method == http.MethodPost && req.URL.Path == "/api/work/v1/runs/claim" {
		if !a.registered[x.ProducerID] || x.ClaimRequestID == "" || x.Runner != receiptFixtureRunner || x.Version != receiptFencePool.Version {
			a.violate(w, "claim identity")
			return
		}
		if a.claimed {
			a.violate(w, "duplicate claim")
			return
		}
		a.claimed = true
		a.claims++
		a.producer = x.ProducerID
		a.requestID = x.ClaimRequestID
		a.actions = append(a.actions, "claim")
		if a.checkpoint == "claim" {
			a.claimOnce.Do(func() { close(a.claimEntered) })
			a.mu.Unlock()
			select {
			case <-req.Context().Done():
			case <-a.ctx.Done():
			}
			a.mu.Lock()
			return
		}
		json.NewEncoder(w).Encode(capacityClaimReply{Kind: "claim", Receipt: &a.r.capacityFence, RunID: a.r.RunID, JobName: a.r.JobName, Pipeline: a.r.Pipeline, Token: receiptFixtureToken})
		return
	}
	if req.Method != http.MethodPost || req.URL.Path != "/api/work/v1/runs/capacity" {
		a.violate(w, "unexpected path or method")
		return
	}
	a.actions = append(a.actions, x.Action)
	if x.Action == "register" {
		if x.ProducerID == "" || a.registered[x.ProducerID] {
			a.violate(w, "duplicate/empty register")
			return
		}
		a.registered[x.ProducerID] = true
		json.NewEncoder(w).Encode(capacityReply{OK: true})
		return
	}
	if !a.claimed || x.Fence != a.r.capacityFence {
		a.violate(w, "foreign fence")
		return
	}
	switch x.Action {
	case "recover":
		// A new producer cannot drain the original claim or pending Kubernetes RPC.
		// Its nonce is exact inventory metadata, not a reconstructed old credential.
		a.recoverers = append(a.recoverers, x.Nonce)
		if a.r.Recovery != nil && x.Nonce != a.r.Recovery.Nonce {
			a.violate(w, "recovery nonce changed")
			return
		}
		// Original recovery happens before any write; successor recovery follows
		// registration of a distinct incarnation, with original producer still live.
		if len(a.registered) > 1 {
			if a.checkpoint == "" || a.producer == "" || !a.registered[a.producer] || a.requestID == "" || (a.checkpoint != "claim" && len(a.pending) == 0) {
				a.violate(w, "refusal lacks actual unresolved original authority")
				return
			}
			a.refusedRecovery++
			w.WriteHeader(http.StatusConflict)
			json.NewEncoder(w).Encode(map[string]string{"reason": "original-producer-authority-unresolved"})
			return
		}
		if x.Nonce == "" {
			a.violate(w, "empty nonce")
			return
		}
		if a.r.Recovery == nil {
			a.r.Recovery = &struct {
				Nonce string `json:"nonce"`
			}{Nonce: x.Nonce}
		}
	case "operation":
		if x.ProducerID != a.producer || !a.registered[x.ProducerID] || a.r.Recovery == nil || x.Nonce != a.r.Recovery.Nonce || x.Operation == "" {
			a.violate(w, "operation authority")
			return
		}
		if x.Resolved {
			if !a.pending[x.Operation] || a.resolved[x.Operation] {
				a.violate(w, "unbegun/duplicate resolution")
				return
			}
			delete(a.pending, x.Operation)
			a.resolved[x.Operation] = true
		} else {
			if a.pending[x.Operation] || a.resolved[x.Operation] {
				a.violate(w, "duplicate operation")
				return
			}
			a.pending[x.Operation] = true
		}
	case "bind":
		if a.r.Recovery == nil || x.Nonce != a.r.Recovery.Nonce || !x.Owned || x.JobName != a.r.JobName || x.JobUID == "" || (a.r.JobUID != "" && a.r.JobUID != x.JobUID) {
			a.violate(w, "bind original Job")
			return
		}
		a.r.JobUID = x.JobUID
		if x.SecretUID != "" {
			if x.SecretHash != receiptDeathTokenHash() || (a.r.SecretUID != "" && a.r.SecretUID != x.SecretUID) {
				a.violate(w, "bind original Secret")
				return
			}
			a.r.SecretUID = x.SecretUID
		}
	default:
		if x.Action == "release" {
			a.releases++
		}
		a.violate(w, "unapproved action: "+x.Action)
		return
	}
	json.NewEncoder(w).Encode(capacityReply{OK: true})
}

// This child entrypoint is excluded by the normal exact parent selector. With
// no inherited parent control pipes it skips BEFORE resolving a target/client.
func TestReceiptKubernetesProcessChild(t *testing.T) {
	if os.Getenv(receiptDeathChildEnv) != "1" {
		t.Skip("no parent IPC binding; no Kubernetes access")
	}
	in, out := os.NewFile(3, "receipt-parent-config"), os.NewFile(4, "receipt-child-events")
	if in == nil || out == nil {
		t.Fatal("missing inherited parent pipes")
	}
	defer in.Close()
	defer out.Close()
	var spec receiptDeathConfig
	raw, err := io.ReadAll(io.LimitReader(in, receiptDeathFrameLimit+1))
	if err != nil || len(raw) > receiptDeathFrameLimit || json.Unmarshal(raw, &spec) != nil {
		t.Fatal("invalid bounded parent config")
	}
	if spec.Application {
		if spec.Invocation == "" || spec.Pool == "" || spec.Bearer == "" || spec.Pipeline == "" || len(spec.RunID) != len("work:")+26+len("/r1") || !strings.HasPrefix(spec.RunID, "work:") || !strings.HasSuffix(spec.RunID, "/r1") || spec.NamespaceUID == "" {
			t.Fatal("unbound application invocation")
		}
		receiptFencePool.PoolID = spec.Pool
		receiptApplicationBearer = spec.Bearer
	} else if spec.Invocation == "" || !strings.HasPrefix(spec.RunID, "work:receipt-fence-"+spec.Invocation+"-") || !strings.HasSuffix(spec.RunID, "/r1") || spec.NamespaceUID == "" {
		t.Fatal("unbound invocation")
	}
	u, err := url.Parse(spec.API)
	if err != nil || u.Scheme != "http" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Hostname() != "127.0.0.1" {
		t.Fatal("parent API must be exact loopback")
	}
	if _, err := strconv.Atoi(u.Port()); err != nil {
		t.Fatal("parent API port absent")
	}
	remaining := time.Until(spec.Deadline)
	if remaining <= 0 || remaining > 180*time.Second {
		t.Fatal("invalid shared deadline")
	}
	if spec.Checkpoint != "" && spec.Checkpoint != "claim" && spec.Checkpoint != "job" && spec.Checkpoint != "secret" && spec.Checkpoint != "unsuspend" {
		t.Fatal("unknown checkpoint")
	}
	ctx, cancel := context.WithDeadline(context.Background(), spec.Deadline)
	defer cancel()
	rt := receiptKubernetesRuntimeFromEnv(t)
	if rt.namespaceUID != spec.NamespaceUID {
		t.Fatal("parent namespace UID drift")
	}
	q, _, faults, childOwn := receiptFenceQueueEndpoint(ctx, t, rt, spec.API, spec.Invocation, false)
	if spec.Application {
		childOwn.runs = map[string]bool{spec.RunID: true}
		receiptApplicationCapture(q)
	}
	send := func(f receiptDeathFrame) {
		f.RunID = spec.RunID
		f.Producer = q.capacity.producerID
		if err := receiptDeathWrite(out, f); err != nil {
			t.Fatalf("bounded child IPC: %v", err)
		}
	}
	send(receiptDeathFrame{Kind: "hello"})
	faults.beforeRequest = func(req *http.Request) (*http.Request, error) {
		return receiptDeathInertRequest(req, q, spec, childOwn)
	}
	faults.afterResponse = func(req *http.Request, resp *http.Response) (*http.Response, error) {
		jobsPath := "/apis/batch/v1/namespaces/" + rt.namespace + "/jobs"
		secretsPath := "/api/v1/namespaces/" + rt.namespace + "/secrets"
		kind := ""
		if req.Method == http.MethodPost && req.URL.Path == jobsPath && resp.StatusCode == http.StatusCreated {
			kind = "job"
		}
		if req.Method == http.MethodPost && req.URL.Path == secretsPath && resp.StatusCode == http.StatusCreated {
			kind = "secret"
		}
		if req.Method == http.MethodPut && req.URL.Path == jobsPath+"/"+queueJobName(spec.RunID) && resp.StatusCode == http.StatusOK {
			kind = "unsuspend"
		}
		if kind == "" {
			return resp, nil
		}
		b, err := io.ReadAll(io.LimitReader(resp.Body, (1<<20)+1))
		resp.Body.Close()
		if err != nil || len(b) > 1<<20 {
			return nil, fmt.Errorf("accepted response exceeds bound")
		}
		resp.Body = io.NopCloser(bytes.NewReader(b))
		f := receiptDeathFrame{Kind: kind, Status: resp.StatusCode, Checkpoint: !spec.Successor && spec.Checkpoint == kind}
		if kind == "secret" {
			var s core.Secret
			if json.Unmarshal(b, &s) != nil || s.Immutable == nil || !*s.Immutable {
				return nil, fmt.Errorf("invalid accepted Secret")
			}
			refs := s.OwnerReferences
			if len(refs) != 1 || refs[0].Kind != "Job" || refs[0].Controller == nil || !*refs[0].Controller {
				return nil, fmt.Errorf("foreign accepted Secret owner")
			}
			hash := sha256.Sum256(s.Data["run-token"])
			f.Namespace = s.Namespace
			f.Name = s.Name
			f.UID = s.UID
			f.RV = s.ResourceVersion
			f.JobUID = refs[0].UID
			f.Immutable = true
			f.TokenHash = hex.EncodeToString(hash[:])
		} else {
			var j batch.Job
			if json.Unmarshal(b, &j) != nil || j.Spec.Suspend == nil {
				return nil, fmt.Errorf("invalid accepted Job")
			}
			f.Namespace = j.Namespace
			f.Name = j.Name
			f.UID = j.UID
			f.RV = j.ResourceVersion
			f.Suspend = *j.Spec.Suspend
			f.Generation = j.Generation
		}
		send(f)
		if f.Checkpoint {
			<-ctx.Done()
			resp.Body.Close()
			return nil, ctx.Err()
		}
		if kind == "secret" {
			// Let the controller's initial suspended-status write settle BEFORE the
			// production resume GET/CAS. This is an actual status observation under
			// the same deadline, not an RV equality assumption or an Update retry.
			for {
				current, err := q.client.BatchV1().Jobs(rt.namespace).Get(ctx, queueJobName(spec.RunID), meta.GetOptions{})
				if err != nil {
					return nil, err
				}
				suspended := false
				for _, condition := range current.Status.Conditions {
					if condition.Type == batch.JobSuspended && condition.Status == core.ConditionTrue {
						suspended = true
					}
				}
				if suspended {
					break
				}
				select {
				case <-ctx.Done():
					return nil, ctx.Err()
				case <-time.After(50 * time.Millisecond):
				}
			}
		}
		return resp, nil
	}
	if spec.Successor {
		err := q.reconcileReceipts(ctx)
		f := receiptDeathFrame{Kind: "done"}
		if err != nil {
			f.Error = err.Error()
		}
		send(f)
		return
	}
	outcome, pollErr := pollOnceWithOutcome(queueExecutorConfig{capacity: q.capacity, runnerName: receiptFixtureRunner, consoleURL: spec.API, reserve: func() (*directRunnerReservation, error) { return q.reserve(ctx) }})
	f := receiptDeathFrame{Kind: "done", Outcome: outcome}
	if pollErr != nil {
		f.Error = pollErr.Error()
	}
	send(f)
}

func receiptDeathInertRequest(req *http.Request, q *kubernetesQueue, s receiptDeathConfig, own *receiptOwnership) (*http.Request, error) {
	if req.Method == http.MethodGet {
		return req, nil
	}
	if s.Application {
		// Parent-side production paths that are NOT launch writes: the exact
		// UID/RV/nonce retirement barrier and positively owned conditional
		// cleanup. Everything else still falls through to launch validation.
		if r, handled, err := receiptApplicationParentWrite(req, q, s, own); handled {
			return r, err
		}
	}
	jp := "/apis/batch/v1/namespaces/" + q.config.Namespace + "/jobs"
	sp := "/api/v1/namespaces/" + q.config.Namespace + "/secrets"
	if (req.Method == http.MethodPost && req.URL.Path == sp) || (req.Method == http.MethodPut && req.URL.Path == jp+"/"+queueJobName(s.RunID)) {
		if req.GetBody == nil {
			return nil, fmt.Errorf("unreadable child write")
		}
		rc, err := req.GetBody()
		if err != nil {
			return nil, err
		}
		raw, err := io.ReadAll(io.LimitReader(rc, (1<<20)+1))
		rc.Close()
		if err != nil || len(raw) > 1<<20 {
			return nil, fmt.Errorf("unbounded child write")
		}
		current, err := q.client.BatchV1().Jobs(q.config.Namespace).Get(req.Context(), queueJobName(s.RunID), meta.GetOptions{})
		if err != nil {
			return nil, err
		}
		var fence capacityFence
		if json.Unmarshal([]byte(current.Annotations[queueReceiptAnnotation]), &fence) != nil || !fence.valid(receiptFencePool.PoolID, s.RunID) || current.UID == "" || current.DeletionTimestamp != nil {
			return nil, fmt.Errorf("write without original Job")
		}
		if req.Method == http.MethodPost {
			var got core.Secret
			if json.Unmarshal(raw, &got) != nil || got.Kind != "Secret" || got.APIVersion != "v1" {
				return nil, fmt.Errorf("unexpected Secret shape")
			}
			token, tokenErr := receiptRunTokenFor(s)
			if tokenErr != nil {
				return nil, tokenErr
			}
			expected := receiptFenceSecretWith(q, current, token)
			expected.TypeMeta = got.TypeMeta
			eb, _ := json.Marshal(expected)
			gb, _ := json.Marshal(got)
			if !bytes.Equal(eb, gb) {
				return nil, fmt.Errorf("immutable fixture Secret drift")
			}
			return req, nil
		}
		var got batch.Job
		if json.Unmarshal(raw, &got) != nil || got.Kind != "Job" || got.APIVersion != "batch/v1" || got.UID != current.UID || got.ResourceVersion == "" || got.Spec.Suspend == nil || *got.Spec.Suspend {
			return nil, fmt.Errorf("foreign unsuspend")
		}
		expected := current.DeepCopy()
		expected.TypeMeta = got.TypeMeta
		expected.Spec.Suspend = ptr(false)
		expected.Spec.Template.Annotations[queueJobUIDAnnotation] = string(current.UID)
		// Do not infer a stable controller status RV. The real Update still carries
		// its original nonempty RV; the apiserver alone decides that CAS.
		expected.ResourceVersion = ""
		got.ResourceVersion = ""
		expected.Status = batch.JobStatus{}
		got.Status = batch.JobStatus{}
		expected.ManagedFields = nil
		got.ManagedFields = nil
		eb, _ := json.Marshal(expected)
		gb, _ := json.Marshal(got)
		if !bytes.Equal(eb, gb) {
			return nil, fmt.Errorf("unsuspend changed inert original topology")
		}
		c := got.Spec.Template.Spec.Containers
		if len(c) != 1 || !reflect.DeepEqual(c[0].Command, []string{"/bin/sh", "-c", "sleep 15; exit 0"}) || len(c[0].Args) != 0 || got.Spec.ActiveDeadlineSeconds == nil || *got.Spec.ActiveDeadlineSeconds != 120 {
			return nil, fmt.Errorf("unsuspend escaped bounded inert fixture")
		}
		return req, nil
	}
	if req.Method != http.MethodPost || req.URL.Path != jp || req.GetBody == nil {
		return nil, fmt.Errorf("unexpected child Kubernetes write")
	}
	r, err := req.GetBody()
	if err != nil {
		return nil, err
	}
	b, err := io.ReadAll(io.LimitReader(r, (1<<20)+1))
	r.Close()
	if err != nil || len(b) > 1<<20 {
		return nil, fmt.Errorf("unbounded desired Job")
	}
	var got batch.Job
	if json.Unmarshal(b, &got) != nil {
		return nil, fmt.Errorf("invalid desired Job")
	}
	var fence capacityFence
	if json.Unmarshal([]byte(got.Annotations[queueReceiptAnnotation]), &fence) != nil || !fence.valid(receiptFencePool.PoolID, s.RunID) {
		return nil, fmt.Errorf("unbound desired receipt")
	}
	jobToken, err := receiptRunTokenFor(s)
	if err != nil {
		return nil, err
	}
	jobPipeline := "codex"
	if s.Pipeline != "" {
		jobPipeline = s.Pipeline
	}
	expected, err := q.job(directRunnerLaunch{runID: s.RunID, runToken: jobToken, pipeline: jobPipeline, consoleURL: s.API, runner: receiptFixtureRunner, receipt: &fence})
	if err != nil {
		return nil, err
	}
	if got.Kind != "Job" || got.APIVersion != "batch/v1" {
		return nil, fmt.Errorf("unexpected Job API kind")
	}
	expected.TypeMeta = got.TypeMeta
	eb, err := json.Marshal(expected)
	if err != nil {
		return nil, err
	}
	gb, err := json.Marshal(got)
	if err != nil || !bytes.Equal(eb, gb) {
		return nil, fmt.Errorf("production desired Job shape drift; no fixture rewrite")
	}
	got.Spec.Template.Spec.Containers[0].Command = []string{"/bin/sh", "-c", "sleep 15; exit 0"}
	got.Spec.Template.Spec.Containers[0].Args = nil
	got.Spec.ActiveDeadlineSeconds = ptr(int64(120))
	if jobPipeline == "opencode" {
		if err := receiptApplicationDropProviderKey(&got); err != nil {
			return nil, err
		}
	}
	b, err = json.Marshal(got)
	if err != nil {
		return nil, err
	}
	copy := req.Clone(req.Context())
	copy.Body = io.NopCloser(bytes.NewReader(b))
	copy.ContentLength = int64(len(b))
	copy.GetBody = func() (io.ReadCloser, error) { return io.NopCloser(bytes.NewReader(b)), nil }
	return copy, nil
}

type receiptDeathRead struct {
	frame receiptDeathFrame
	err   error
}
type receiptDeathChild struct {
	cmd                 *exec.Cmd
	events              chan receiptDeathRead
	waited              chan struct{}
	waitErr             error
	stdout, stderr      *receiptDeathOutput
	input, eventsReader *os.File
}

func receiptDeathStart(ctx context.Context, t *testing.T, own *receiptOwnership, s receiptDeathConfig) *receiptDeathChild {
	t.Helper()
	if ctx.Err() != nil {
		t.Fatal(ctx.Err())
	}
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cfgRead, cfgWrite, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	eventRead, eventWrite, err := os.Pipe()
	if err != nil {
		cfgRead.Close()
		cfgWrite.Close()
		t.Fatal(err)
	}
	remaining := time.Until(s.Deadline)
	if remaining <= 0 {
		cfgRead.Close()
		cfgWrite.Close()
		eventRead.Close()
		eventWrite.Close()
		t.Fatal("shared deadline elapsed")
	}
	c := &receiptDeathChild{cmd: exec.Command(exe, "-test.run=^TestReceiptKubernetesProcessChild$", "-test.v", "-test.timeout="+remaining.String()), events: make(chan receiptDeathRead, 33), waited: make(chan struct{}), stdout: &receiptDeathOutput{}, stderr: &receiptDeathOutput{}, input: cfgWrite, eventsReader: eventRead}
	c.cmd.ExtraFiles = []*os.File{cfgRead, eventWrite}
	c.cmd.Stdout = c.stdout
	c.cmd.Stderr = c.stderr
	// Pass qualification paths/identity, never whole environment or credential bytes.
	for _, key := range []string{"PATH", "HOME", "LCARS_RECEIPT_K8S_KUBECONFIG", "LCARS_RECEIPT_K8S_KUBECONTEXT", "LCARS_RECEIPT_K8S_NAMESPACE", "LCARS_RECEIPT_K8S_NAMESPACE_UID", "LCARS_RECEIPT_K8S_LABELS", "LCARS_RECEIPT_K8S_NODE_SELECTOR", "LCARS_RECEIPT_K8S_IMAGE", "LCARS_RECEIPT_K8S_SERVICE_ACCOUNT", "LCARS_RECEIPT_K8S_FIXTURE_SECRET"} {
		if v, ok := os.LookupEnv(key); ok {
			c.cmd.Env = append(c.cmd.Env, key+"="+v)
		}
	}
	c.cmd.Env = append(c.cmd.Env, receiptDeathChildEnv+"=1")
	if err := c.cmd.Start(); err != nil {
		cfgRead.Close()
		cfgWrite.Close()
		eventRead.Close()
		eventWrite.Close()
		t.Fatal(err)
	}
	cfgRead.Close()
	eventWrite.Close()
	go func() { c.waitErr = c.cmd.Wait(); close(c.waited) }()
	t.Cleanup(func() { c.cleanup(t, own) })
	// Config is small and bounded; pipe write also gets the shared absolute limit.
	if err := cfgWrite.SetWriteDeadline(s.Deadline); err != nil {
		c.stop(t, own.cleanupContext())
		t.Fatal(err)
	}
	if err := receiptDeathWrite(cfgWrite, s); err != nil {
		c.stop(t, own.cleanupContext())
		t.Fatal(err)
	}
	cfgWrite.Close()
	go func() {
		defer close(c.events)
		for n := 0; n < 32; n++ {
			f, err := receiptDeathReadFrame(eventRead)
			if err != nil {
				if err == io.EOF {
					return
				}
				c.events <- receiptDeathRead{err: err}
				return
			}
			c.events <- receiptDeathRead{frame: f}
		}
		c.events <- receiptDeathRead{err: fmt.Errorf("more than32 IPC frames")}
	}()
	return c
}

// Expected checkpoint joining uses remaining logical time. Only ordinary failure
// cleanup starts the single independent allowance; normal case completion does
// not consume that future failure budget.
func (c *receiptDeathChild) cleanup(t *testing.T, own *receiptOwnership) {
	select {
	case <-c.waited:
		c.input.Close()
		c.eventsReader.Close()
		return
	default:
		c.stop(t, own.cleanupContext())
	}
}
func (c *receiptDeathChild) stop(t *testing.T, ctx context.Context) {
	t.Helper()
	select {
	case <-c.waited:
	default:
		if err := c.cmd.Process.Kill(); err != nil && err != os.ErrProcessDone {
			t.Errorf("owned child kill: %v", err)
		}
	}
	select {
	case <-c.waited:
	case <-ctx.Done():
		t.Errorf("owned child PID%d could not be reaped within remaining budget: %v", c.cmd.Process.Pid, ctx.Err())
	}
	c.input.Close()
	c.eventsReader.Close()
}
func receiptDeathFrameIdentity(f receiptDeathFrame, s receiptDeathConfig) error {
	if f.RunID != s.RunID || f.Producer == "" {
		return fmt.Errorf("foreign frame run/producer")
	}
	switch f.Kind {
	case "hello", "done":
		return nil
	case "job", "secret", "unsuspend":
	default:
		return fmt.Errorf("unknown frame kind")
	}
	if f.Namespace == "" || f.Name != queueJobName(s.RunID) || f.UID == "" || f.RV == "" {
		return fmt.Errorf("incomplete object frame")
	}
	if (f.Kind == "job" || f.Kind == "secret") && f.Status != http.StatusCreated {
		return fmt.Errorf("no accepted201 ownership")
	}
	if f.Kind == "unsuspend" && f.Status != http.StatusOK {
		return fmt.Errorf("no accepted200 witness")
	}
	return nil
}
func receiptDeathRecord(ctx context.Context, t *testing.T, q *kubernetesQueue, own *receiptOwnership, s receiptDeathConfig, f receiptDeathFrame, seen map[string]receiptDeathFrame) {
	t.Helper()
	if err := receiptDeathFrameIdentity(f, s); err != nil {
		t.Fatal(err)
	}
	if f.Namespace != q.config.Namespace {
		t.Fatal("frame namespace mismatch")
	}
	ns, err := q.client.CoreV1().Namespaces().Get(ctx, q.config.Namespace, meta.GetOptions{})
	if err != nil || string(ns.UID) != own.rt.namespaceUID || ns.DeletionTimestamp != nil {
		t.Fatal("original accepted-response namespace UID drift")
	}
	for key, value := range own.rt.qualifications {
		if ns.Labels[key] != value {
			t.Fatal("accepted-response namespace qualification changed")
		}
	}
	t.Logf("actual accepted response kind=%s status=%d namespace=%s name=%s uid=%s rv=%s originalJobUID=%s suspend=%t generation=%d", f.Kind, f.Status, f.Namespace, f.Name, f.UID, f.RV, f.JobUID, f.Suspend, f.Generation)
	if previous, ok := seen[f.Kind]; ok {
		t.Fatalf("duplicate/conflicting accepted response: oldUID%s newUID%s", previous.UID, f.UID)
	}
	if f.Kind == "secret" {
		j, ok := seen["job"]
		if !ok || f.JobUID != j.UID || !f.Immutable || f.TokenHash != receiptDeathExpectedHash(s) {
			t.Fatal("accepted Secret lacks original owner/immutable token hash")
		}
		actual, err := q.client.CoreV1().Secrets(q.config.Namespace).Get(ctx, f.Name, meta.GetOptions{})
		if err != nil || actual.UID != f.UID || actual.Immutable == nil || !*actual.Immutable {
			t.Fatalf("accepted Secret UID corroboration: %v", err)
		}
		hash := sha256.Sum256(actual.Data["run-token"])
		if hex.EncodeToString(hash[:]) != f.TokenHash {
			t.Fatal("accepted Secret hash changed")
		}
		owned := false
		for _, o := range actual.OwnerReferences {
			owned = owned || (o.Controller != nil && *o.Controller && o.Kind == "Job" && o.UID == f.JobUID)
		}
		if !owned {
			t.Fatal("accepted Secret owner changed")
		}
		own.ownSecret(actual)
	} else {
		actual, err := q.client.BatchV1().Jobs(q.config.Namespace).Get(ctx, f.Name, meta.GetOptions{})
		if err != nil || actual.UID != f.UID || actual.Namespace != f.Namespace || actual.Annotations[queueRunAnnotation] != s.RunID {
			t.Fatalf("accepted Job UID corroboration: %v", err)
		}
		if f.Kind == "job" {
			if !f.Suspend || f.Generation != 1 {
				t.Fatal("accepted original Job was not generation1 suspended")
			}
			if err := own.recordCreated(actual); err != nil {
				t.Fatal(err)
			}
		} else {
			j, ok := seen["job"]
			if !ok || j.UID != f.UID || f.Suspend || f.Generation < 2 || actual.Spec.Suspend == nil || *actual.Spec.Suspend {
				t.Fatal("accepted unsuspend changed original identity")
			}
		}
	}
	seen[f.Kind] = f
}

// Returns only after the exact child is reaped. Checkpoint=true can never be
// satisfied by normal exit, an unentered arm or a synthetic cancellation.
func receiptDeathRun(ctx context.Context, t *testing.T, rt receiptKubernetesRuntime, q *kubernetesQueue, own *receiptOwnership, a *receiptDeathAPI, s receiptDeathConfig, kill bool) (string, receiptDeathFrame, map[string]receiptDeathFrame) {
	t.Helper()
	c := receiptDeathStart(ctx, t, own, s)
	defer c.cleanup(t, own)
	seen := map[string]receiptDeathFrame{}
	producer := ""
	var done receiptDeathFrame
	claimArm := false
	var claimSignal chan struct{}
	if a != nil {
		claimSignal = a.claimEntered
	}
	for {
		if kill && s.Checkpoint == "claim" && claimArm && producer != "" {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatalf("shared logical deadline during actual child: %v", ctx.Err())
		case <-claimSignal:
			claimArm = true
			claimSignal = nil
		case event, ok := <-c.events:
			if !ok {
				if kill {
					t.Fatal("child exited without exact armed checkpoint")
				}
				goto joined
			}
			if event.err != nil {
				t.Fatalf("bounded child IPC: %v", event.err)
			}
			f := event.frame
			if err := receiptDeathFrameIdentity(f, s); err != nil {
				t.Fatal(err)
			}
			if f.Kind == "hello" {
				if producer != "" {
					t.Fatal("duplicate child hello")
				}
				producer = f.Producer
				continue
			}
			if producer == "" || producer != f.Producer {
				t.Fatal("child producer changed or no hello")
			}
			if f.Kind == "done" {
				if done.Kind != "" {
					t.Fatal("duplicate completion frame")
				}
				done = f
				if kill {
					t.Fatal("normal completion cannot satisfy SIGKILL checkpoint")
				}
				continue
			}
			receiptDeathRecord(ctx, t, q, own, s, f, seen)
			if f.Checkpoint {
				if !kill || s.Checkpoint != f.Kind {
					t.Fatal("unrequested checkpoint")
				}
				goto killed
			}
		}
	}
killed:
	if !kill {
		t.Fatal("unexpected kill path")
	}
	c.stop(t, ctx)
	if !receiptDeathKilled(c.cmd.ProcessState) {
		t.Fatal("armed child did not end specifically by SIGKILL")
	}
	t.Logf("checkpoint=%s originalProducer=%s pid=%d actualSIGKILL=true reaped=true", s.Checkpoint, producer, c.cmd.Process.Pid)
	if _, over := c.stdout.snapshot(); over {
		t.Fatal("child stdout overflow")
	}
	if _, over := c.stderr.snapshot(); over {
		t.Fatal("child stderr overflow")
	}
	return producer, done, seen
joined:
	select {
	case <-c.waited:
	case <-ctx.Done():
		t.Fatal("child did not join within logical deadline")
	}
	if c.waitErr != nil || done.Kind != "done" || producer == "" {
		text, _ := c.stderr.snapshot()
		t.Fatalf("normal child completion missing/failed: %v %q", c.waitErr, text)
	}
	if receiptDeathKilled(c.cmd.ProcessState) {
		t.Fatal("normal completion was killed")
	}
	if _, over := c.stdout.snapshot(); over {
		t.Fatal("child stdout overflow")
	}
	if _, over := c.stderr.snapshot(); over {
		t.Fatal("child stderr overflow")
	}
	return producer, done, seen
}
func receiptDeathSnapshot(a *receiptDeathAPI) (capacityReceipt, int, int, int, int, int, []string, []string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	raw, _ := json.Marshal(a.r)
	var r capacityReceipt
	json.Unmarshal(raw, &r)
	return r, a.claims, len(a.pending), len(a.resolved), a.releases, a.refusedRecovery, append([]string{}, a.actions...), append([]string{}, a.violations...)
}
func receiptDeathControls(t *testing.T) {
	t.Helper()
	for name, b := range map[string][]byte{"truncated": []byte(`{"kind":"hello"}`), "malformed": []byte("{\n"), "oversize": append(bytes.Repeat([]byte{'x'}, receiptDeathFrameLimit+1), '\n')} {
		if _, err := receiptDeathReadFrame(bytes.NewReader(b)); err == nil {
			t.Fatalf("%s IPC control accepted", name)
		}
	}
	s := receiptDeathConfig{RunID: "work:receipt-fence-control/r1"}
	for _, f := range []receiptDeathFrame{{Kind: "hello", RunID: "foreign", Producer: "p"}, {Kind: "job", RunID: s.RunID, Producer: "p", Name: queueJobName(s.RunID), Status: 201, RV: "1"}, {Kind: "job", RunID: s.RunID, Producer: "p", Name: queueJobName(s.RunID), Status: 409, UID: "uid", RV: "1", Namespace: "ns"}} {
		if receiptDeathFrameIdentity(f, s) == nil {
			t.Fatal("foreign/missingUID/non201 ownership accepted")
		}
	}
	if receiptDeathKilled(nil) {
		t.Fatal("missing process status is not a SIGKILL")
	}
}
func receiptDeathUnboundChild(ctx context.Context, t *testing.T) {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.CommandContext(ctx, exe, "-test.run=^TestReceiptKubernetesProcessChild$", "-test.v")
	// Intentionally no child-mode environment or inherited config/events pipes.
	out := &receiptDeathOutput{}
	cmd.Stdout = out
	cmd.Stderr = out
	if err := cmd.Run(); err != nil {
		t.Fatalf("unbound child did not refuse cleanly: %v", err)
	}
	text, overflow := out.snapshot()
	if overflow || !strings.Contains(text, "no parent IPC binding; no Kubernetes access") || !strings.Contains(text, "SKIP") || receiptDeathKilled(cmd.ProcessState) {
		t.Fatal("unbound child was not actually skipped before client setup")
	}
}
func receiptDeathInertControls(ctx context.Context, t *testing.T, q *kubernetesQueue, own *receiptOwnership) {
	t.Helper()
	r := receiptFenceNewReceipt(own, "wire-control")
	spec := receiptDeathConfig{RunID: r.RunID, API: q.capacity.consoleURL}
	desired, err := q.job(directRunnerLaunch{runID: r.RunID, runToken: receiptFixtureToken, pipeline: "codex", consoleURL: spec.API, runner: receiptFixtureRunner, receipt: &r.capacityFence})
	if err != nil {
		t.Fatal(err)
	}
	desired.Kind = "Job"
	desired.APIVersion = "batch/v1"
	jp := "http://127.0.0.1/apis/batch/v1/namespaces/" + q.config.Namespace + "/jobs"
	request := func(j *batch.Job, path string) *http.Request {
		b, err := json.Marshal(j)
		if err != nil {
			t.Fatal(err)
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, path, bytes.NewReader(b))
		if err != nil {
			t.Fatal(err)
		}
		return req
	}
	if _, err := receiptDeathInertRequest(request(desired, jp), q, spec, nil); err != nil {
		t.Fatalf("exact production desired shape refused: %v", err)
	}
	changed := desired.DeepCopy()
	changed.Spec.Template.Spec.Containers = append(changed.Spec.Template.Spec.Containers, changed.Spec.Template.Spec.Containers[0])
	if _, err := receiptDeathInertRequest(request(changed, jp), q, spec, nil); err == nil {
		t.Fatal("extra container bypassed inert rewrite fence")
	}
	if _, err := receiptDeathInertRequest(request(desired, jp+"-foreign"), q, spec, nil); err == nil {
		t.Fatal("foreign write path accepted")
	}
}
func receiptKubernetesProcessDeath(ctx context.Context, t *testing.T, rt receiptKubernetesRuntime, q *kubernetesQueue, own *receiptOwnership) {
	t.Helper()
	receiptDeathControls(t)
	receiptDeathUnboundChild(ctx, t)
	receiptDeathInertControls(ctx, t, q, own)
	for _, checkpoint := range []string{"", "claim", "job", "secret", "unsuspend"} {
		name := checkpoint
		if name == "" {
			name = "baseline"
		}
		if !t.Run(name, func(t *testing.T) {
			if ctx.Err() != nil {
				t.Fatal(ctx.Err())
			}
			r := receiptFenceNewReceipt(own, "process-"+name)
			r.State = "claimed"
			receiptFenceRequireAbsent(ctx, t, q, r.JobName)
			if _, err := q.client.CoreV1().Secrets(rt.namespace).Get(ctx, r.JobName, meta.GetOptions{}); !apierrors.IsNotFound(err) {
				t.Fatalf("original exact Secret not absent: %v", err)
			}
			a := newReceiptDeathAPI(ctx, t, rt.namespace, r, checkpoint)
			dl, ok := ctx.Deadline()
			if !ok {
				t.Fatal("missing shared deadline")
			}
			s := receiptDeathConfig{Invocation: own.invocation, RunID: r.RunID, NamespaceUID: rt.namespaceUID, API: a.server.URL, Checkpoint: checkpoint, Deadline: dl}
			original, done, seen := receiptDeathRun(ctx, t, rt, q, own, a, s, checkpoint != "")
			actual, claims, pending, resolved, releases, refused, _, violations := receiptDeathSnapshot(a)
			a.mu.Lock()
			oldProducer, requestID := a.producer, a.requestID
			registered := len(a.registered)
			a.mu.Unlock()
			if original == "" || oldProducer != original || requestID == "" || registered != 1 || claims != 1 || releases != 0 || refused != 0 || len(violations) != 0 {
				t.Fatalf("original production claim ledger mismatch: producer=%t registered=%d claims=%d pending=%d resolved=%d violations=%v", oldProducer == original, registered, claims, pending, resolved, violations)
			}
			t.Logf("production claim checkpoint=%s producer=%s claimRequestId=%s claims=%d pending=%d resolved=%d", name, original, requestID, claims, pending, resolved)
			wantPending, wantResolved := 1, 0
			switch checkpoint {
			case "":
				wantPending, wantResolved = 0, 3
			case "claim":
				wantPending, wantResolved = 0, 0
			case "secret":
				wantResolved = 1
			case "unsuspend":
				wantResolved = 2
			}
			if pending != wantPending || resolved != wantResolved {
				t.Fatalf("exact original write ledger changed: pending%d/%d resolved%d/%d", pending, wantPending, resolved, wantResolved)
			}
			var before *batch.Job
			if checkpoint != "claim" {
				before, _ = q.client.BatchV1().Jobs(rt.namespace).Get(ctx, r.JobName, meta.GetOptions{})
				if before == nil || seen["job"].UID != before.UID || !receiptJobMatches(before, actual) {
					t.Fatal("original accepted Job absent or changed")
				}
				if checkpoint == "" || checkpoint == "unsuspend" {
					if _, ok := seen["unsuspend"]; !ok || before.Spec.Suspend == nil || *before.Spec.Suspend {
						t.Fatal("no actual accepted unsuspend")
					}
					receiptFenceWaitPods(ctx, t, q, before, func(ps []core.Pod) bool { return len(ps) == 1 && ps[0].Status.Phase == core.PodRunning }, "one real inert running Pod")
				} else {
					if before.Spec.Suspend == nil || !*before.Spec.Suspend || len(receiptFenceOwnedPods(ctx, t, q, before)) != 0 {
						t.Fatal("suspended original unexpectedly ran")
					}
				}
			}
			if checkpoint == "" {
				if done.Outcome != queuePollOutcomeClaimed || done.Error != "" || len(seen) != 3 || actual.SecretUID == "" {
					t.Fatalf("baseline did not complete production launch: %+v", done)
				}
			} else {
				successor := s
				successor.Successor = true
				successor.Checkpoint = ""
				fresh, answer, recoverySeen := receiptDeathRun(ctx, t, rt, q, own, a, successor, false)
				after, c, p, res, rel, held, actions, bad := receiptDeathSnapshot(a)
				if fresh == original || answer.Error != "capacity returned HTTP 409" || len(recoverySeen) != 0 || c != claims || p != pending || res != resolved || rel != 0 || held != 1 || len(bad) != 0 || !reflect.DeepEqual(after, actual) {
					t.Fatalf("successor did not preserve exact unresolved authority: error=%q distinct=%t claims%d pending%d resolved%d releases%d held%d actions=%v bad=%v", answer.Error, fresh != original, c, p, res, rel, held, actions, bad)
				}
				a.mu.Lock()
				newRegistered := a.registered[fresh] && len(a.registered) == 2
				lastNonce := ""
				if len(a.recoverers) > 0 {
					lastNonce = a.recoverers[len(a.recoverers)-1]
				}
				a.mu.Unlock()
				if !newRegistered || lastNonce == "" || (actual.Recovery != nil && lastNonce != actual.Recovery.Nonce) {
					t.Fatal("fresh producer did not reconcile authoritative inventory nonce")
				}
				if checkpoint == "claim" {
					receiptFenceRequireAbsent(ctx, t, q, r.JobName)
					if _, err := q.client.CoreV1().Secrets(rt.namespace).Get(ctx, r.JobName, meta.GetOptions{}); !apierrors.IsNotFound(err) {
						t.Fatal("unreplied claim minted a Secret")
					}
				} else {
					afterJob, err := q.client.BatchV1().Jobs(rt.namespace).Get(ctx, r.JobName, meta.GetOptions{})
					if err != nil || !receiptFenceSameJob(before, afterJob) {
						t.Fatalf("successor changed/restarted original Job: %v", err)
					}
				}
			}
			if f, ok := seen["secret"]; ok {
				secret, err := q.client.CoreV1().Secrets(rt.namespace).Get(ctx, r.JobName, meta.GetOptions{})
				job, jobErr := q.client.BatchV1().Jobs(rt.namespace).Get(ctx, r.JobName, meta.GetOptions{})
				if err != nil || jobErr != nil || secret.UID != f.UID || !receiptSecretMatches(secret, job, actual) {
					t.Fatalf("original owned immutable Secret changed after recovery: %v / %v", err, jobErr)
				}
				hash := sha256.Sum256(secret.Data["run-token"])
				if hex.EncodeToString(hash[:]) != f.TokenHash {
					t.Fatal("reconciliation changed original token hash")
				}
			} else if _, err := q.client.CoreV1().Secrets(rt.namespace).Get(ctx, r.JobName, meta.GetOptions{}); !apierrors.IsNotFound(err) {
				t.Fatalf("unknown claim/create fabricated a new Secret: %v", err)
			}
			if before != nil && checkpoint != "" && checkpoint != "unsuspend" && len(receiptFenceOwnedPods(ctx, t, q, before)) != 0 {
				t.Fatal("reconciliation launched a suspended ambiguous attempt")
			}
			// Finish exact-owned cleanup before the next case, preserving one Pod and
			// eight-Job namespace quotas. No new per-case logical/cleanup allowance.
			if !own.cleanupObjects(ctx) {
				t.Fatal("previous owned case did not retire")
			}
			own.forget(r.JobName)
		}) {
			return
		}
	}
}

// ---------------------------------------------------------------------------
// Application bridge (#2312): production HTTP route + isolated Firestore.
//
// SOURCE-ONLY HERE: this family is compile-qualified and REAL KUBERNETES UNRUN
// until Root executes the documented sequence in the file header. It reuses the
// existing runtime qualification, fault transport, ownership/cleanup and
// process-child machinery; the only new control plane is the Node-owned route
// adapter, which this file talks to but never reimplements.
// ---------------------------------------------------------------------------

const (
	receiptApplicationEnv      = "LCARS_RECEIPT_K8S_APPLICATION"
	receiptApplicationPipeline = "opencode"
	receiptApplicationBodyMax  = 1 << 20
)

var (
	receiptApplicationTokenMu    sync.Mutex
	receiptApplicationTokenValue string
)

func receiptApplicationSetToken(token string) {
	receiptApplicationTokenMu.Lock()
	defer receiptApplicationTokenMu.Unlock()
	receiptApplicationTokenValue = token
}

// receiptRunTokenFor is the fixture token for the scripted matrix and the
// really minted claim token (held only in this process's memory) for the
// application family. Token bytes are never logged or sent over IPC.
func receiptRunTokenFor(s receiptDeathConfig) (string, error) {
	if !s.Application {
		return receiptFixtureToken, nil
	}
	receiptApplicationTokenMu.Lock()
	defer receiptApplicationTokenMu.Unlock()
	if receiptApplicationTokenValue == "" {
		return "", fmt.Errorf("no claim token captured from the production route")
	}
	return receiptApplicationTokenValue, nil
}

func receiptDeathExpectedHash(s receiptDeathConfig) string {
	if s.Application {
		return s.ExpectedTokenHash
	}
	return receiptDeathTokenHash()
}

// receiptTokenCapture observes the production claim exchange: the minted token
// (memory only) and the exact claimRequestId, so a later replay can reuse it.
type receiptTokenCapture struct {
	base      http.RoundTripper
	mu        sync.Mutex
	requestID string
	ops       map[string]bool // operationId -> resolved, as the production client sent them.
}

// unresolvedOps is the exact set of operation IDs this producer recorded and
// never resolved. A GET never resolves one; only a resolved=true record does.
func (c *receiptTokenCapture) unresolvedOps() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	var out []string
	for id, resolved := range c.ops {
		if !resolved {
			out = append(out, id)
		}
	}
	sort.Strings(out)
	return out
}

func (c *receiptTokenCapture) lastRequestID() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.requestID
}

func (c *receiptTokenCapture) RoundTrip(req *http.Request) (*http.Response, error) {
	claim := req.Method == http.MethodPost && strings.HasSuffix(req.URL.Path, "/runs/claim")
	if req.Method == http.MethodPost && strings.HasSuffix(req.URL.Path, "/runs/capacity") && req.GetBody != nil {
		if rc, err := req.GetBody(); err == nil {
			var body struct {
				Action      string `json:"action"`
				OperationID string `json:"operationId"`
				Resolved    bool   `json:"resolved"`
			}
			if json.NewDecoder(io.LimitReader(rc, receiptApplicationBodyMax)).Decode(&body) == nil && body.Action == "operation" && body.OperationID != "" {
				c.mu.Lock()
				if c.ops == nil {
					c.ops = map[string]bool{}
				}
				c.ops[body.OperationID] = c.ops[body.OperationID] || body.Resolved
				c.mu.Unlock()
			}
			rc.Close()
		}
	}
	if claim && req.GetBody != nil {
		if rc, err := req.GetBody(); err == nil {
			var body struct {
				ClaimRequestID string `json:"claimRequestId"`
			}
			if json.NewDecoder(io.LimitReader(rc, receiptApplicationBodyMax)).Decode(&body) == nil && body.ClaimRequestID != "" {
				c.mu.Lock()
				c.requestID = body.ClaimRequestID
				c.mu.Unlock()
			}
			rc.Close()
		}
	}
	resp, err := c.base.RoundTrip(req)
	if err != nil || !claim || resp.StatusCode != http.StatusOK {
		return resp, err
	}
	raw, readErr := io.ReadAll(io.LimitReader(resp.Body, receiptApplicationBodyMax+1))
	resp.Body.Close()
	if readErr != nil || len(raw) > receiptApplicationBodyMax {
		return nil, fmt.Errorf("claim response unreadable or oversized")
	}
	resp.Body = io.NopCloser(bytes.NewReader(raw))
	var reply struct {
		Token string `json:"token"`
	}
	if json.Unmarshal(raw, &reply) == nil && reply.Token != "" {
		receiptApplicationSetToken(reply.Token)
	}
	return resp, nil
}

func receiptApplicationCapture(q *kubernetesQueue) *receiptTokenCapture {
	capture := &receiptTokenCapture{base: http.DefaultTransport}
	q.capacity.httpClient = &http.Client{Timeout: 10 * time.Second, Transport: capture,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	return capture
}

type receiptApplication struct {
	endpoint   string
	bearer     string
	invocation string
	client     *http.Client
}

type receiptApplicationCase struct {
	name, runID, poolID, bearer string
}

type receiptApplicationFacts struct {
	Problems []string `json:"problems"`
	Run      *struct {
		State  string `json:"state"`
		Status string `json:"status"`
	} `json:"run"`
	Successor *struct {
		State   string `json:"state"`
		Claimed bool   `json:"claimed"`
	} `json:"successor"`
	Receipt *struct {
		State         string `json:"state"`
		Unplaced      bool   `json:"unplaced"`
		JobUID        string `json:"jobUid"`
		SecretUID     string `json:"secretUid"`
		TokenHash     string `json:"tokenHash"`
		PendingWrites int    `json:"pendingWrites"`
		Producers     []struct {
			ProducerID string   `json:"producerId"`
			Stopped    bool     `json:"stopped"`
			Fenced     bool     `json:"fenced"`
			Pending    []string `json:"pending"`
		} `json:"producers"`
		Barrier *struct {
			UID             string `json:"uid"`
			ResourceVersion string `json:"resourceVersion"`
		} `json:"barrier"`
	} `json:"receipt"`
	RequestRecords int `json:"requestRecords"`
	Retired        *struct {
		Released      bool `json:"released"`
		PendingWrites int  `json:"pendingWrites"`
		Barrier       *struct {
			UID             string `json:"uid"`
			ResourceVersion string `json:"resourceVersion"`
		} `json:"barrier"`
	} `json:"retired"`
	FaultsFired int      `json:"faultsFired"`
	Sequence    []string `json:"sequence"`
}

// receiptApplicationFromEnv fails, never skips or defaults, once enabled. Only
// the exact parent-owned loopback endpoint is accepted.
func receiptApplicationFromEnv(t *testing.T) receiptApplication {
	t.Helper()
	if os.Getenv(receiptApplicationEnv) != "1" {
		t.Fatalf("%s must be exactly 1 when enabled", receiptApplicationEnv)
	}
	a := receiptApplication{
		endpoint:   os.Getenv(receiptApplicationEnv + "_ENDPOINT"),
		bearer:     os.Getenv(receiptApplicationEnv + "_BEARER"),
		invocation: os.Getenv(receiptApplicationEnv + "_INVOCATION"),
	}
	u, err := url.Parse(a.endpoint)
	if err != nil || u.Scheme != "http" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" || u.Hostname() != "127.0.0.1" {
		t.Fatal("application endpoint must be the parent-owned http://127.0.0.1:<port>")
	}
	if _, err := strconv.Atoi(u.Port()); err != nil {
		t.Fatal("application endpoint port absent")
	}
	if len(a.bearer) < 32 || len(a.invocation) < 8 {
		t.Fatal("application bearer/invocation binding absent")
	}
	a.client = &http.Client{Timeout: 20 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	return a
}

// control calls the parent's bounded control surface. Failures never echo the
// request or response bytes.
func (a receiptApplication) control(ctx context.Context, t *testing.T, path string, in, out any) int {
	t.Helper()
	raw, err := json.Marshal(in)
	if err != nil {
		t.Fatal("application control request invalid")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, a.endpoint+path, bytes.NewReader(raw))
	if err != nil {
		t.Fatal("application control request invalid")
	}
	req.Header.Set("Authorization", "Bearer "+a.bearer)
	req.Header.Set("Content-Type", "application/json")
	resp, err := a.client.Do(req)
	if err != nil {
		t.Fatalf("application control %s unavailable", path)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, receiptApplicationBodyMax+1))
	if err != nil || len(body) > receiptApplicationBodyMax {
		t.Fatalf("application control %s response unreadable or oversized", path)
	}
	if out != nil && json.Unmarshal(body, out) != nil {
		t.Fatalf("application control %s response invalid (HTTP %d)", path, resp.StatusCode)
	}
	return resp.StatusCode
}

func (a receiptApplication) seed(ctx context.Context, t *testing.T, name string) receiptApplicationCase {
	t.Helper()
	var out struct {
		RunID  string `json:"runId"`
		PoolID string `json:"poolId"`
		Bearer string `json:"bearer"`
	}
	if status := a.control(ctx, t, "/__bridge/seed", map[string]string{"case": name}, &out); status != http.StatusOK || out.RunID == "" || out.PoolID == "" || out.Bearer == "" {
		t.Fatalf("seeding the native fixture Task for %s failed (HTTP %d)", name, status)
	}
	return receiptApplicationCase{name: name, runID: out.RunID, poolID: out.PoolID, bearer: out.Bearer}
}

func (a receiptApplication) arm(ctx context.Context, t *testing.T, route, mode string) {
	t.Helper()
	if status := a.control(ctx, t, "/__bridge/arm", map[string]string{"route": route, "mode": mode}, nil); status != http.StatusOK {
		t.Fatalf("arming %s %s failed (HTTP %d)", route, mode, status)
	}
}

// verify makes the parent reopen Firestore through a SECOND client and assert
// the one-Task/one-run/one-request/one-receipt invariants plus any binding.
func (a receiptApplication) verify(ctx context.Context, t *testing.T, c receiptApplicationCase, bind map[string]string) receiptApplicationFacts {
	t.Helper()
	return a.verifyPhase(ctx, t, c, "preExit", bind)
}

// verifyPhase is phase-specific: before the real exit route commits there is
// exactly one run; after it the production executorExitedAndRetry settles the
// original lost and mints one undispatched deterministic successor.
func (a receiptApplication) verifyPhase(ctx context.Context, t *testing.T, c receiptApplicationCase, phase string, bind map[string]string) receiptApplicationFacts {
	t.Helper()
	in := map[string]string{"case": c.name, "phase": phase}
	for k, v := range bind {
		in[k] = v
	}
	var facts receiptApplicationFacts
	if status := a.control(ctx, t, "/__bridge/verify", in, &facts); status != http.StatusOK {
		t.Fatalf("reopened Firestore contradicts the exact claim state (HTTP %d): %v", status, facts.Problems)
	}
	return facts
}

// pendingOf returns the durable pending-write operation IDs of one producer.
func (f receiptApplicationFacts) pendingOf(producerID string) []string {
	if f.Receipt == nil {
		return nil
	}
	for _, p := range f.Receipt.Producers {
		if p.ProducerID == producerID {
			out := append([]string{}, p.Pending...)
			sort.Strings(out)
			return out
		}
	}
	return nil
}

func (f receiptApplicationFacts) sequenceIndex(prefix string) int {
	for i, s := range f.Sequence {
		if strings.HasPrefix(s, prefix) {
			return i
		}
	}
	return -1
}

type receiptApplicationWire struct {
	mu       sync.Mutex
	jobPosts []int // Status of every forwarded Job POST, in order.
}

func (w *receiptApplicationWire) jobPostStatuses() []int {
	w.mu.Lock()
	defer w.mu.Unlock()
	return append([]int{}, w.jobPosts...)
}

type receiptApplicationRig struct {
	q       *kubernetesQueue
	faults  *receiptFaultTransport
	own     *receiptOwnership
	capture *receiptTokenCapture
	s       receiptDeathConfig
	wire    *receiptApplicationWire
}

// receiptApplicationQueue builds one production queue for a case: its own pool
// and bearer, ownership of exactly the seeded run, the PARENT transport scope
// (launch validation plus exact retirement/cleanup), captured claim token and
// exact ownership of every accepted Secret.
func receiptApplicationQueue(ctx context.Context, t *testing.T, rt receiptKubernetesRuntime, app receiptApplication, c receiptApplicationCase) *receiptApplicationRig {
	t.Helper()
	receiptFencePool.PoolID = c.poolID
	receiptApplicationBearer = c.bearer
	receiptApplicationSetToken("")
	q, _, faults, own := receiptFenceQueueEndpoint(ctx, t, rt, app.endpoint, app.invocation, true)
	own.runs = map[string]bool{c.runID: true}
	capture := receiptApplicationCapture(q)
	dl, ok := ctx.Deadline()
	if !ok {
		t.Fatal("missing shared deadline")
	}
	s := receiptDeathConfig{Invocation: app.invocation, RunID: c.runID, NamespaceUID: rt.namespaceUID, API: app.endpoint, Deadline: dl,
		Application: true, Pool: c.poolID, Bearer: c.bearer, Pipeline: receiptApplicationPipeline}
	wire := &receiptApplicationWire{}
	faults.beforeRequest = func(req *http.Request) (*http.Request, error) { return receiptDeathInertRequest(req, q, s, own) }
	jobsPath := "/apis/batch/v1/namespaces/" + rt.namespace + "/jobs"
	secretsPath := "/api/v1/namespaces/" + rt.namespace + "/secrets"
	faults.afterResponse = func(req *http.Request, resp *http.Response) (*http.Response, error) {
		if req.Method == http.MethodPost && req.URL.Path == jobsPath {
			wire.mu.Lock()
			wire.jobPosts = append(wire.jobPosts, resp.StatusCode)
			wire.mu.Unlock()
		}
		if req.Method != http.MethodPost || req.URL.Path != secretsPath || resp.StatusCode != http.StatusCreated {
			return resp, nil
		}
		raw, err := io.ReadAll(io.LimitReader(resp.Body, receiptApplicationBodyMax+1))
		resp.Body.Close()
		if err != nil || len(raw) > receiptApplicationBodyMax {
			return nil, fmt.Errorf("accepted Secret response unreadable or oversized")
		}
		resp.Body = io.NopCloser(bytes.NewReader(raw))
		var secret core.Secret
		if json.Unmarshal(raw, &secret) != nil || secret.UID == "" || secret.Name != queueJobName(c.runID) {
			return nil, fmt.Errorf("accepted Secret is outside this case's ownership")
		}
		own.ownSecret(&secret)
		return resp, nil
	}
	return &receiptApplicationRig{q: q, faults: faults, own: own, capture: capture, s: s, wire: wire}
}

func receiptApplicationPoll(ctx context.Context, q *kubernetesQueue, endpoint string) (queuePollOutcome, error) {
	return pollOnceWithOutcome(queueExecutorConfig{capacity: q.capacity, runnerName: receiptFixtureRunner, consoleURL: endpoint,
		reserve: func() (*directRunnerReservation, error) { return q.reserve(ctx) }})
}

func receiptApplicationSecretHash(ctx context.Context, t *testing.T, q *kubernetesQueue, name string) (*core.Secret, string) {
	t.Helper()
	secret, err := q.client.CoreV1().Secrets(q.config.Namespace).Get(ctx, name, meta.GetOptions{})
	if err != nil || secret.Immutable == nil || !*secret.Immutable {
		t.Fatalf("the exact immutable Secret is absent: %v", err)
	}
	sum := sha256.Sum256(secret.Data["run-token"])
	return secret, hex.EncodeToString(sum[:])
}

// receiptApplicationDropProviderKey is the ONE reviewed inert-only delta for
// the opencode pipeline: the dummy credentials Secret holds only
// telemetry-writer.json={}, so the production projection of the unused
// opencode-llm-api-key item could never mount. The volume is byte-checked to be
// exactly the production [telemetry, provider-key] projection and only the
// provider item is removed. The run token Secret, fence and env are untouched
// and no real provider credential is introduced.
func receiptApplicationDropProviderKey(job *batch.Job) error {
	for i := range job.Spec.Template.Spec.Volumes {
		v := &job.Spec.Template.Spec.Volumes[i]
		if v.Name != "credentials" {
			continue
		}
		want := []core.KeyToPath{{Key: "telemetry-writer.json", Path: "telemetry-writer.json"}, {Key: "opencode-llm-api-key", Path: "opencode-llm-api-key"}}
		if v.Secret == nil || !reflect.DeepEqual(v.Secret.Items, want) {
			return fmt.Errorf("credentials projection is not the reviewed production opencode shape")
		}
		v.Secret.Items = want[:1]
		return nil
	}
	return fmt.Errorf("credentials volume absent")
}

type receiptApplicationProbeKey struct{}

// receiptApplicationParentWrite admits exactly the two production parent
// writes that are not launch writes. It never widens the child scope: the
// child (and every launch POST/unsuspend PUT) is still validated above.
func receiptApplicationParentWrite(req *http.Request, q *kubernetesQueue, s receiptDeathConfig, own *receiptOwnership) (*http.Request, bool, error) {
	jp := "/apis/batch/v1/namespaces/" + q.config.Namespace + "/jobs/"
	sp := "/api/v1/namespaces/" + q.config.Namespace + "/secrets/"
	switch {
	case req.Method == http.MethodDelete && (strings.HasPrefix(req.URL.Path, jp) || strings.HasPrefix(req.URL.Path, sp)):
		if own == nil || req.GetBody == nil {
			return nil, true, fmt.Errorf("unowned or unreadable delete")
		}
		isJob := strings.HasPrefix(req.URL.Path, jp)
		name := strings.TrimPrefix(req.URL.Path, sp)
		if isJob {
			name = strings.TrimPrefix(req.URL.Path, jp)
		}
		rc, err := req.GetBody()
		if err != nil {
			return nil, true, err
		}
		raw, err := io.ReadAll(io.LimitReader(rc, 1<<16))
		rc.Close()
		var opts meta.DeleteOptions
		if err != nil || json.Unmarshal(raw, &opts) != nil || opts.Preconditions == nil || opts.Preconditions.UID == nil {
			return nil, true, fmt.Errorf("delete lacks an exact UID precondition")
		}
		own.mu.Lock()
		owned := own.secrets[name]
		if isJob {
			owned = own.jobs[name]
		}
		own.mu.Unlock()
		if name != queueJobName(s.RunID) {
			return nil, true, fmt.Errorf("delete names an object outside this case")
		}
		if owned == "" || *opts.Preconditions.UID != owned {
			// Only an explicitly marked negative probe may carry a foreign UID;
			// the apiserver, not this fence, must then refuse it.
			if req.Context().Value(receiptApplicationProbeKey{}) == true && owned != "" {
				return req, true, nil
			}
			return nil, true, fmt.Errorf("delete precondition is not the positively owned UID")
		}
		if !isJob && opts.Preconditions.ResourceVersion == nil {
			return nil, true, fmt.Errorf("Secret delete lacks an exact resourceVersion")
		}
		return req, true, nil
	case req.Method == http.MethodPut && req.URL.Path == jp+queueJobName(s.RunID):
		if req.GetBody == nil {
			return nil, true, fmt.Errorf("unreadable parent write")
		}
		rc, err := req.GetBody()
		if err != nil {
			return nil, true, err
		}
		raw, err := io.ReadAll(io.LimitReader(rc, (1<<20)+1))
		rc.Close()
		var got batch.Job
		if err != nil || len(raw) > 1<<20 || json.Unmarshal(raw, &got) != nil {
			return nil, true, fmt.Errorf("unreadable parent write")
		}
		if got.Spec.Suspend == nil || !*got.Spec.Suspend {
			return nil, false, nil // The inert unsuspend keeps its existing validation.
		}
		current, err := q.client.BatchV1().Jobs(q.config.Namespace).Get(req.Context(), queueJobName(s.RunID), meta.GetOptions{})
		if err != nil {
			return nil, true, err
		}
		var fence capacityFence
		if json.Unmarshal([]byte(current.Annotations[queueReceiptAnnotation]), &fence) != nil || !fence.valid(receiptFencePool.PoolID, s.RunID) ||
			current.UID == "" || got.UID != current.UID || got.ResourceVersion == "" || current.DeletionTimestamp != nil ||
			current.Annotations[queueBarrierAnnotation] != "" || got.Annotations[queueBarrierAnnotation] != fence.Nonce {
			return nil, true, fmt.Errorf("barrier write is not the exact original UID/RV/nonce transition")
		}
		expected := current.DeepCopy()
		expected.TypeMeta = got.TypeMeta
		expected.Spec.Suspend = ptr(true)
		expected.Spec.TTLSecondsAfterFinished = nil
		expected.Annotations[queueBarrierAnnotation] = fence.Nonce
		for _, j := range []*batch.Job{expected, &got} {
			j.ResourceVersion, j.Generation, j.Status, j.ManagedFields = "", 0, batch.JobStatus{}, nil
		}
		eb, _ := json.Marshal(expected)
		gb, _ := json.Marshal(got)
		if !bytes.Equal(eb, gb) {
			return nil, true, fmt.Errorf("barrier write changed more than suspend/TTL/nonce")
		}
		return req, true, nil
	}
	return nil, false, nil
}

// All cases share ONE 180s logical context and the suite's independent cleanup
// allowance. Each case owns its own pool, so no case consumes another's slot.
func TestReceiptKubernetesApplication(t *testing.T) {
	if os.Getenv(receiptApplicationEnv) == "" {
		t.Skip("application bridge not enabled; no Kubernetes access")
	}
	app := receiptApplicationFromEnv(t)
	rt := receiptKubernetesRuntimeFromEnv(t)
	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	defer cancel()
	for _, c := range []struct {
		name string
		run  func(context.Context, *testing.T, receiptKubernetesRuntime, receiptApplication)
	}{
		{"ClaimLossQuarantine", receiptApplicationClaimLoss},
		{"ClaimReplayRecoversOwnedSecret", receiptApplicationSecretReplay},
		{"AcceptedWriteLostReply", receiptApplicationLostWrite},
		{"ControllerDeathReconcile", receiptApplicationControllerDeath},
		{"PhysicalRetirement", receiptApplicationRetirement},
	} {
		if !t.Run(c.name, func(t *testing.T) { c.run(ctx, t, rt, app) }) {
			return
		}
	}
}

// A. A claim reply lost AFTER the store committed. Before any Secret exists the
// original token is unrecoverable by design: replay must quarantine it and must
// not mint a second token, run or receipt.
func receiptApplicationClaimLoss(ctx context.Context, t *testing.T, rt receiptKubernetesRuntime, app receiptApplication) {
	c := app.seed(ctx, t, "claimLoss")
	rig := receiptApplicationQueue(ctx, t, rt, app, c)
	q, own := rig.q, rig.own
	app.arm(ctx, t, "claim", "drop")
	if _, err := q.capacity.claim(ctx, receiptFixtureRunner); err == nil {
		t.Fatal("the dropped claim reply was observed")
	}
	requestID := q.capacity.requestID
	if requestID == "" {
		t.Fatal("the unresolved claim request ID was not retained")
	}
	before := app.verify(ctx, t, c, nil)
	if before.FaultsFired != 1 || before.Receipt == nil || before.Receipt.State != "unplaced" || before.RequestRecords != 1 || before.Run == nil || before.Run.State != "claimed" {
		t.Fatalf("the committed claim is not the exact unplaced decision: %+v", before)
	}
	var replay capacityClaimReply
	body := map[string]any{"runner": receiptFixtureRunner, "capacityVersion": receiptFencePool.Version, "producerId": q.capacity.producerID, "claimRequestId": requestID}
	if err := q.capacity.call(ctx, http.MethodPost, "/claim", body, &replay); err != nil {
		t.Fatalf("replaying the exact claim request: %v", err)
	}
	if replay.Kind != "quarantined-unrecoverable-token" || replay.Token != "" || replay.RunID != c.runID {
		t.Fatalf("a replay before any Secret must quarantine the unrecoverable token, got kind=%q run=%q tokenReturned=%t", replay.Kind, replay.RunID, replay.Token != "")
	}
	after := app.verify(ctx, t, c, nil)
	if after.RequestRecords != 1 || after.Receipt == nil || after.Receipt.TokenHash != before.Receipt.TokenHash {
		t.Fatalf("the replay minted or replaced credentials: %+v", after)
	}
	receiptFenceRequireAbsent(ctx, t, q, queueJobName(c.runID))
	own.cleanupObjects(ctx)
}

// A (continued). With the exact immutable Secret bound, the same request ID
// recovers the OWNED Secret and returns no token: the original credential is
// preserved, never replaced to satisfy a fixture.
func receiptApplicationSecretReplay(ctx context.Context, t *testing.T, rt receiptKubernetesRuntime, app receiptApplication) {
	c := app.seed(ctx, t, "secretReplay")
	rig := receiptApplicationQueue(ctx, t, rt, app, c)
	q, own := rig.q, rig.own
	outcome, err := receiptApplicationPoll(ctx, q, app.endpoint)
	if err != nil || outcome != queuePollOutcomeClaimed {
		t.Fatalf("production launch through the real route: outcome=%s err=%v", outcome, err)
	}
	requestID := rig.capture.lastRequestID()
	job, err := q.client.BatchV1().Jobs(rt.namespace).Get(ctx, queueJobName(c.runID), meta.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	own.ownJob(t, job)
	secret, hash := receiptApplicationSecretHash(ctx, t, q, job.Name)
	var replay capacityClaimReply
	body := map[string]any{"runner": receiptFixtureRunner, "capacityVersion": receiptFencePool.Version, "producerId": q.capacity.producerID, "claimRequestId": requestID}
	if err := q.capacity.call(ctx, http.MethodPost, "/claim", body, &replay); err != nil {
		t.Fatalf("replaying the exact claim request: %v", err)
	}
	if replay.Kind != "recover-owned-secret" || replay.Token != "" || replay.RunID != c.runID || replay.SecretUID != string(secret.UID) || replay.JobUID != string(job.UID) {
		t.Fatalf("a replay after the Secret bound must recover the owned Secret, got kind=%q tokenReturned=%t", replay.Kind, replay.Token != "")
	}
	facts := app.verify(ctx, t, c, map[string]string{"secretHash": hash, "jobUid": string(job.UID)})
	if facts.RequestRecords != 1 || facts.Receipt == nil || facts.Receipt.SecretUID != string(secret.UID) {
		t.Fatalf("recovery did not preserve the original Secret binding: %+v", facts)
	}
	if !own.cleanupObjects(ctx) {
		t.Fatal("owned launch did not retire")
	}
}

// B1. The apiserver ACCEPTS the Job create (real 201 + UID) and the reply is
// hidden. Production GET-corroborates that exact UID, may bind it and resume
// the never-attempted original, but the unknown Create stays an unresolved
// operation: a GET never drains it. A later duplicate gets the apiserver's
// real AlreadyExists409, which resolves only ITS OWN operation.
func receiptApplicationLostWrite(ctx context.Context, t *testing.T, rt receiptKubernetesRuntime, app receiptApplication) {
	c := app.seed(ctx, t, "lostWrite")
	rig := receiptApplicationQueue(ctx, t, rt, app, c)
	q, faults, own := rig.q, rig.faults, rig.own
	name := queueJobName(c.runID)
	receiptFenceRequireAbsent(ctx, t, q, name)
	lost := faults.loseReply(http.MethodPost, "/apis/batch/v1/namespaces/"+rt.namespace+"/jobs", name)
	outcome, err := receiptApplicationPoll(ctx, q, app.endpoint)
	lost.requireFinished(t, http.StatusCreated)
	if err != nil || outcome != queuePollOutcomeClaimed {
		t.Fatalf("production must recover the exact accepted Job after a hidden create: outcome=%s err=%v", outcome, err)
	}
	job, err := q.client.BatchV1().Jobs(rt.namespace).Get(ctx, name, meta.GetOptions{})
	if err != nil || job.UID == "" {
		t.Fatalf("the accepted Job is not observable: %v", err)
	}
	own.ownJob(t, job) // Ownership came from the real POST 201 body, not this GET.
	unresolved := rig.capture.unresolvedOps()
	if len(unresolved) != 1 {
		t.Fatalf("exactly the lost Create must remain unresolved, got %d operations", len(unresolved))
	}
	producer := q.capacity.producerID
	pending := app.verify(ctx, t, c, nil)
	if pending.Receipt == nil || !reflect.DeepEqual(pending.pendingOf(producer), unresolved) {
		t.Fatalf("the durable pending write is not the exact lost Create: %+v", pending.Receipt)
	}
	if pending.Receipt.JobUID != "" && pending.Receipt.JobUID != string(job.UID) {
		t.Fatalf("the receipt bound a Job other than the accepted original: %s", pending.Receipt.JobUID)
	}
	if pending.Receipt.JobUID != string(job.UID) {
		t.Fatal("production did not bind the GET-corroborated same-UID original")
	}
	// Duplicate of the exact production desired shape, with the ORIGINAL token.
	inv, err := q.capacity.inventory(ctx)
	if err != nil || len(inv.Receipts) != 1 {
		t.Fatalf("authoritative inventory: %v", err)
	}
	r := inv.Receipts[0]
	token, err := receiptRunTokenFor(rig.s)
	if err != nil {
		t.Fatal(err)
	}
	n, err := q.capacity.recovery(ctx, r, "recover")
	if err != nil {
		t.Fatalf("recovery lease for the original producer: %v", err)
	}
	dup, err := q.job(directRunnerLaunch{runID: r.RunID, runToken: token, pipeline: r.Pipeline, consoleURL: app.endpoint, runner: receiptFixtureRunner, receipt: &r.capacityFence})
	if err != nil {
		t.Fatal(err)
	}
	posts := len(rig.wire.jobPostStatuses())
	werr := q.capacity.write(ctx, r, n, func() error {
		_, e := q.client.BatchV1().Jobs(rt.namespace).Create(ctx, dup, meta.CreateOptions{})
		return e
	})
	statuses := rig.wire.jobPostStatuses()
	if !apierrors.IsAlreadyExists(werr) || len(statuses) != posts+1 || statuses[posts] != http.StatusConflict {
		t.Fatalf("the duplicate must reach the apiserver and get its definitive AlreadyExists409, got %v statuses=%v", werr, statuses)
	}
	after := app.verify(ctx, t, c, nil)
	if !reflect.DeepEqual(after.pendingOf(producer), unresolved) || !reflect.DeepEqual(rig.capture.unresolvedOps(), unresolved) {
		t.Fatalf("a definitive409 resolved the unrelated lost write: %+v", after.Receipt)
	}
	same, err := q.client.BatchV1().Jobs(rt.namespace).Get(ctx, name, meta.GetOptions{})
	if err != nil || same.UID != job.UID {
		t.Fatalf("the original Job UID changed: %v", err)
	}
	if !own.cleanupObjects(ctx) {
		t.Fatal("owned lost-write Job did not retire")
	}
}

// B2. Kill only the owned child at the accepted Job-create checkpoint, then
// reconcile a NEW controller incarnation through the real route. The original
// never-attempted Job survives, its original credential is absent so nothing
// may resume, and the dead producer's unresolved write authority is retained.
func receiptApplicationControllerDeath(ctx context.Context, t *testing.T, rt receiptKubernetesRuntime, app receiptApplication) {
	c := app.seed(ctx, t, "controllerDeath")
	rig := receiptApplicationQueue(ctx, t, rt, app, c)
	q, own, s := rig.q, rig.own, rig.s
	s.Checkpoint = "job"
	original, _, seen := receiptDeathRun(ctx, t, rt, q, own, nil, s, true)
	if original == "" || seen["job"].UID == "" {
		t.Fatal("no accepted original Job witness")
	}
	name := queueJobName(c.runID)
	before, err := q.client.BatchV1().Jobs(rt.namespace).Get(ctx, name, meta.GetOptions{})
	if err != nil || before.UID != seen["job"].UID || before.Generation != 1 || before.Spec.Suspend == nil || !*before.Spec.Suspend || queueJobAttempted(before) {
		t.Fatalf("original accepted Job absent or not the never-attempted original: %v", err)
	}
	dead := app.verify(ctx, t, c, nil)
	deadPending := dead.pendingOf(original)
	if dead.Receipt == nil || len(deadPending) != 1 || dead.Receipt.JobUID != "" {
		t.Fatalf("reopened Firestore lost the dead producer's exact pending write: %+v", dead.Receipt)
	}
	successor := s
	successor.Successor, successor.Checkpoint = true, ""
	fresh, done, recoverySeen := receiptDeathRun(ctx, t, rt, q, own, nil, successor, false)
	if fresh == original || len(recoverySeen) != 0 {
		t.Fatalf("successor was not a new incarnation or wrote objects: distinct=%t frames=%d", fresh != original, len(recoverySeen))
	}
	// Recovery reuses the authenticated inventory nonce and both incarnations
	// share the fixture subject, so the only legitimate result is the missing
	// ORIGINAL credential. A bare capacity409 (reason dropped by the client)
	// could be any unrelated conflict and is never accepted.
	if done.Error != "receipt original credential unavailable" {
		t.Fatalf("successor must fail only for the missing original credential, got %q", done.Error)
	}
	after := app.verify(ctx, t, c, nil)
	if after.Receipt == nil || !reflect.DeepEqual(after.pendingOf(original), deadPending) || after.Receipt.JobUID != "" || after.Receipt.SecretUID != "" {
		t.Fatalf("process death discarded or rewrote the unresolved write authority: %+v", after.Receipt)
	}
	same, err := q.client.BatchV1().Jobs(rt.namespace).Get(ctx, name, meta.GetOptions{})
	if err != nil || !receiptFenceSameJob(before, same) || same.Generation != 1 || same.Spec.Suspend == nil || !*same.Spec.Suspend || queueJobAttempted(same) {
		t.Fatalf("successor replaced, attempted or restarted the original Job: %v", err)
	}
	if _, err := q.client.CoreV1().Secrets(rt.namespace).Get(ctx, name, meta.GetOptions{}); !apierrors.IsNotFound(err) {
		t.Fatalf("successor fabricated a Secret for an unbound original: %v", err)
	}
	if pods := receiptFenceOwnedPods(ctx, t, q, same); len(pods) != 0 {
		t.Fatal("successor launched a physical worker")
	}
	if !own.cleanupObjects(ctx) {
		t.Fatal("owned controller-death objects did not retire")
	}
}

// C. A live SAME-UID inert Pod owns capacity: no logical exit, release or
// barrier. Only after fresh terminal Job/container evidence does normal
// reconciliation exit BEFORE release, retain the exact UID/RV barrier and
// commit the retired record. The real exit settles the original lost and mints
// one undispatched deterministic successor; reply loss and 409 are injected
// AFTER that decision committed.
func receiptApplicationRetirement(ctx context.Context, t *testing.T, rt receiptKubernetesRuntime, app receiptApplication) {
	c := app.seed(ctx, t, "retirement")
	rig := receiptApplicationQueue(ctx, t, rt, app, c)
	q, faults, own := rig.q, rig.faults, rig.own
	outcome, err := receiptApplicationPoll(ctx, q, app.endpoint)
	if err != nil || outcome != queuePollOutcomeClaimed {
		t.Fatalf("production launch through the real route: outcome=%s err=%v", outcome, err)
	}
	job, err := q.client.BatchV1().Jobs(rt.namespace).Get(ctx, queueJobName(c.runID), meta.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	own.ownJob(t, job)
	pods := receiptFenceWaitPods(ctx, t, q, job, func(p []core.Pod) bool {
		return len(p) == 1 && p[0].DeletionTimestamp == nil && p[0].Status.Phase == core.PodRunning
	}, "observe the real inert Pod")
	pod := pods[0]

	// Live Pod: no logical exit, no release, no barrier.
	if err := q.reconcileReceipts(ctx); err != nil {
		t.Logf("reconcile with a live Pod: %v", err)
	}
	live := app.verify(ctx, t, c, nil)
	if live.sequenceIndex("exit:") >= 0 || live.sequenceIndex("capacity:release") >= 0 || live.Retired != nil {
		t.Fatalf("a live same-UID Pod was exited or released: %v", live.Sequence)
	}
	if lj, err := q.client.BatchV1().Jobs(rt.namespace).Get(ctx, job.Name, meta.GetOptions{}); err != nil || lj.UID != job.UID || lj.Annotations[queueBarrierAnnotation] != "" {
		t.Fatalf("a live worker gained a retirement barrier: %v", err)
	}

	// Fresh positive terminal evidence on the same objects.
	for {
		fresh, getErr := q.client.BatchV1().Jobs(rt.namespace).Get(ctx, job.Name, meta.GetOptions{})
		if getErr != nil || fresh.UID != job.UID || fresh.DeletionTimestamp != nil {
			t.Fatalf("the original Job disappeared, was replaced or is deleting: %v", getErr)
		}
		freshPods := receiptFenceOwnedPods(ctx, t, q, fresh)
		ended, never := physicalReceiptWorkersEnded(fresh, freshPods)
		if ended && !never && len(freshPods) == 1 && freshPods[0].UID == pod.UID && freshPods[0].Status.Phase == core.PodSucceeded {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatalf("observe terminal original Pod: %v", ctx.Err())
		case <-time.After(2 * time.Second):
		}
	}

	// A 409 and a lost reply after the real exit decision each retain authority.
	// The exit itself COMMITTED, so the original is lost and one retry exists.
	for i, mode := range []string{"409", "drop"} {
		app.arm(ctx, t, "exit", mode)
		if err := q.reconcileReceipts(ctx); err == nil {
			t.Fatalf("reconcile %s reply to the logical exit released capacity", mode)
		}
		held := app.verifyPhase(ctx, t, c, "postExit", nil)
		if held.FaultsFired != i+1 || held.sequenceIndex("exit:200:"+mode) < 0 || held.sequenceIndex("capacity:release:200") >= 0 || (held.Retired != nil && held.Retired.Released) {
			t.Fatalf("%s at the exit route released capacity or was never exercised: %v", mode, held.Sequence)
		}
		barrier, err := q.client.BatchV1().Jobs(rt.namespace).Get(ctx, job.Name, meta.GetOptions{})
		if err != nil || barrier.UID != job.UID || barrier.Annotations[queueBarrierAnnotation] == "" || barrier.Spec.Suspend == nil || !*barrier.Spec.Suspend {
			t.Fatalf("the exit was attempted without the inert UID barrier: %v", err)
		}
	}

	// Real backend rejections: a wrong originalJobUid and a stale fence are each
	// refused with the production 'stale' reason and change nothing.
	inv, err := q.capacity.inventory(ctx)
	if err != nil || len(inv.Receipts) != 1 {
		t.Fatalf("authoritative inventory: %v", err)
	}
	r := inv.Receipts[0]
	n, err := q.capacity.recovery(ctx, r, "recover")
	if err != nil {
		t.Fatal(err)
	}
	snapshot := app.verifyPhase(ctx, t, c, "postExit", nil)
	stale := r.capacityFence
	stale.Nonce = "stale-" + stale.Nonce
	for name, release := range map[string]map[string]any{
		"wrongOriginalJobUid": {"action": "release", "fence": r.capacityFence, "recoveryNonce": n, "barrierUid": string(job.UID), "barrierRunId": r.RunID, "barrierNonce": r.Nonce,
			"resourceVersion": job.ResourceVersion, "jobName": job.Name, "evidence": "uid-rv-inert-job-and-owned-pods", "inert": true, "physicalWorkersEnded": true, "neverStarted": false, "originalJobUid": "not-the-original-job-uid"},
		"staleFence": {"action": "release", "fence": stale, "recoveryNonce": n, "barrierUid": string(job.UID), "barrierRunId": r.RunID, "barrierNonce": r.Nonce,
			"resourceVersion": job.ResourceVersion, "jobName": job.Name, "evidence": "uid-rv-inert-job-and-owned-pods", "inert": true, "physicalWorkersEnded": true, "neverStarted": false, "originalJobUid": r.JobUID},
	} {
		_, err := q.capacity.command(ctx, release)
		still := app.verifyPhase(ctx, t, c, "postExit", nil)
		last := ""
		if len(still.Sequence) > 0 {
			last = still.Sequence[len(still.Sequence)-1]
		}
		if err == nil || err.Error() != "capacity returned HTTP 409" || !strings.HasPrefix(last, "capacity:release:409") || !strings.Contains(last, "stale") {
			t.Fatalf("%s was not refused with the production stale reason: err=%v last=%q", name, err, last)
		}
		if still.Receipt == nil || still.Receipt.State != snapshot.Receipt.State || (still.Retired != nil && still.Retired.Released) {
			t.Fatalf("%s changed authority: %+v", name, still.Receipt)
		}
	}
	// Wrong PHYSICAL UID: the real apiserver refuses a foreign UID precondition.
	// Only this explicitly marked probe may carry one past the local fence.
	probe := context.WithValue(ctx, receiptApplicationProbeKey{}, true)
	foreign := types.UID("00000000-0000-0000-0000-000000000000")
	if err := q.client.BatchV1().Jobs(rt.namespace).Delete(probe, job.Name, meta.DeleteOptions{Preconditions: &meta.Preconditions{UID: &foreign}}); !apierrors.IsConflict(err) {
		t.Fatalf("the apiserver must refuse a foreign Job UID precondition: %v", err)
	}
	if kept, err := q.client.BatchV1().Jobs(rt.namespace).Get(ctx, job.Name, meta.GetOptions{}); err != nil || kept.UID != job.UID {
		t.Fatalf("the foreign-UID probe disturbed the original Job: %v", err)
	}

	// Normal reconciliation now completes the (replayed) exit, then the release.
	faults.clearJobRead()
	if err := q.reconcileReceipts(ctx); err != nil {
		t.Fatalf("normal producer reconciliation after terminal evidence: %v", err)
	}
	observed := faults.observedJobRead(t, rt.namespace, job.Name)
	final := app.verifyPhase(ctx, t, c, "postExit", nil)
	exitAt, releaseAt := -1, -1
	for i, s := range final.Sequence {
		if strings.HasPrefix(s, "exit:200") && exitAt < 0 {
			exitAt = i
		}
		if strings.HasPrefix(s, "capacity:release:200") {
			releaseAt = i
		}
	}
	if exitAt < 0 || releaseAt < 0 || exitAt > releaseAt {
		t.Fatalf("release did not follow the real logical exit: %v", final.Sequence)
	}
	if final.Successor == nil || final.Successor.Claimed {
		t.Fatalf("the exit must leave one undispatched deterministic successor: %+v", final.Successor)
	}
	if final.Retired == nil || !final.Retired.Released || final.Retired.Barrier == nil || final.Retired.Barrier.UID != string(job.UID) || final.Retired.Barrier.ResourceVersion != observed.ResourceVersion {
		t.Fatalf("the retired record does not carry the exact inert UID/RV barrier: %+v", final.Retired)
	}
	end, err := q.client.BatchV1().Jobs(rt.namespace).Get(ctx, job.Name, meta.GetOptions{})
	if err != nil || end.UID != job.UID || end.Annotations[queueBarrierAnnotation] != r.Nonce || end.Spec.Suspend == nil || !*end.Spec.Suspend {
		t.Fatalf("the permanent barrier did not survive release: %v", err)
	}
	if !own.cleanupObjects(ctx) {
		t.Fatal("owned retirement objects did not retire")
	}
}

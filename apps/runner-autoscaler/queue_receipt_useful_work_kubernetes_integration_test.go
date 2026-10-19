//go:build kubernetes_integration

// Go owner of the isolated real-bootstrap useful-work qualification carrier
// (#2312 original AC5/8; Tracks #2312, closes nothing). TEST-ONLY source: it
// adds no production seam, and the existing receipt family
// (queue_receipt_kubernetes_integration_test.go, #2926) is untouched and earns
// no credit here. Its constructor receiptFenceQueueEndpoint is INELIGIBLE for a
// real worker (dummy Secret {}, tiny resources, loopback worker policy,
// verifyRun returning nil), so this file builds the actual queue separately.
//
// Two exact entries, both gated by LCARS_RECEIPT_USEFUL_WORK=1:
//
//	TestReceiptKubernetesUsefulWorkPreflight  read-only; nothing is created.
//	TestReceiptKubernetesUsefulWork           only spawned by the Node owner
//	                                          (queue-receipt-useful-work.test.ts).
//
// LCARS_RECEIPT_USEFUL_WORK_INPUT is an ABSOLUTE PRIVATE FILE (never raw JSON);
// both owners hash the same bytes. Unknown fields are refused at every nesting
// level and trailing JSON is refused. The full test additionally requires the
// Node-supplied invocation descriptor, the fixture bearer on stdin, and ACK
// lines on stdin; frames go to stdout behind an explicit marker.
//
// The real journey: public-identity preflight -> `prepared` ACK -> production
// q.reserve -> q.capacity.claim -> reservation.launch (q.launch ->
// launchReceipt -> resumeReceipt) through a delegating client that changes only
// this invocation's first Jobs Create (public-CA ConfigMap volume/mount,
// CURL_CA_BUNDLE, CODEX_TIMEOUT_SECONDS=900 and the finite 1200s deadline) ->
// real q.reconcileReceipts until activation -> `usefulRecorded` ACK -> physical
// end, quiesce, retirement/release -> conditional cleanup -> `finish` ACK.
//
// Unrun/unclaimed by source verification: everything above. Skip is not PASS.
package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	auth "k8s.io/api/authorization/v1"
	batch "k8s.io/api/batch/v1"
	core "k8s.io/api/core/v1"
	meta "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/kubernetes"
	batchv1 "k8s.io/client-go/kubernetes/typed/batch/v1"
	"k8s.io/client-go/tools/clientcmd"
	clientcmdapi "k8s.io/client-go/tools/clientcmd/api"
)

const (
	usefulWorkEnv           = "LCARS_RECEIPT_USEFUL_WORK"
	usefulWorkInputEnv      = "LCARS_RECEIPT_USEFUL_WORK_INPUT"
	usefulWorkDescriptorEnv = "LCARS_RECEIPT_USEFUL_WORK_DESCRIPTOR"
	usefulWorkFrameMarker   = "@@LCARS-UW-FRAME@@ "
	usefulWorkFrameLimit    = 64 << 10
	usefulWorkProviderS     = 900
	usefulWorkRunDeadlineS  = 1200
	usefulWorkLogical       = 1200 * time.Second
	usefulWorkCleanup       = 180 * time.Second
	usefulWorkPreflightTime = 60 * time.Second
)

// ---- Closed input -------------------------------------------------------

type usefulWorkEvidenceRef struct {
	Path   string `json:"path"`
	Sha256 string `json:"sha256"`
}

type usefulWorkInput struct {
	Reviewed struct {
		SourceCommit     string `json:"sourceCommit"`
		TsSha256         string `json:"tsSha256"`
		GoSha256         string `json:"goSha256"`
		BinarySha256     string `json:"binarySha256"`
		ImageDigest      string `json:"imageDigest"`
		BakedInputSha256 string `json:"bakedInputSha256"`
	} `json:"reviewed"`
	Kube struct {
		Context             string            `json:"context"`
		Cluster             string            `json:"cluster"`
		Kubeconfig          string            `json:"kubeconfig"`
		Namespace           string            `json:"namespace"`
		NamespaceUID        string            `json:"namespaceUid"`
		NamespaceLabels     map[string]string `json:"namespaceLabels"`
		ServiceAccount      string            `json:"serviceAccount"`
		ServiceAccountUID   string            `json:"serviceAccountUid"`
		CredentialSecret    string            `json:"credentialSecret"`
		CredentialSecretUID string            `json:"credentialSecretUid"`
		NodeSelector        map[string]string `json:"nodeSelector"`
		Audience            string            `json:"audience"`
	} `json:"kube"`
	Callback struct {
		IP              string `json:"ip"`
		SAN             string `json:"san"`
		PublicRootsPath string `json:"publicRootsPath"`
		PublicRootsSha  string `json:"publicRootsSha256"`
	} `json:"callback"`
	Binary string `json:"binary"`
	Work   struct {
		Title          string `json:"title"`
		Description    string `json:"description"`
		Need           string `json:"need"`
		Owner          string `json:"owner"`
		ReviewedSha256 string `json:"reviewedSha256"`
	} `json:"work"`
	Evidence struct {
		Authorization     usefulWorkEvidenceRef `json:"authorization"`
		CurrentOwner      usefulWorkEvidenceRef `json:"currentOwner"`
		SourceSnapshot    usefulWorkEvidenceRef `json:"sourceSnapshot"`
		BakedInputs       usefulWorkEvidenceRef `json:"bakedInputs"`
		ParentAdmission   usefulWorkEvidenceRef `json:"parentAdmission"`
		WorkerAdmission   usefulWorkEvidenceRef `json:"workerAdmission"`
		ProviderAdmission usefulWorkEvidenceRef `json:"providerAdmission"`
	} `json:"evidence"`
	EvidenceDir string `json:"evidenceDir"`
}

// strictJSON decodes exactly one value, refusing unknown fields at every level
// and any trailing token (Decoder.More alone is not a trailing-token check).
func strictJSON(raw []byte, v any) error {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return err
	}
	if _, err := dec.Token(); err != io.EOF {
		return errors.New("trailing data after the closed value")
	}
	return nil
}

func usefulWorkDigest(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

func usefulWorkHex(v string, n int) bool {
	if len(v) != n {
		return false
	}
	_, err := hex.DecodeString(v)
	return err == nil && v == strings.ToLower(v)
}

func usefulWorkReadPrivate(path string, limit int64) ([]byte, error) {
	if !strings.HasPrefix(path, "/") {
		return nil, errors.New("path must be absolute")
	}
	fi, err := os.Stat(path)
	if err != nil || !fi.Mode().IsRegular() || fi.Size() > limit || fi.Mode().Perm()&0o077 != 0 {
		return nil, fmt.Errorf("%s must be a private regular file under %d bytes", path, limit)
	}
	return os.ReadFile(path)
}

func usefulWorkTaskHash(in usefulWorkInput) string {
	return usefulWorkDigest([]byte(in.Work.Need + "\n" + in.Work.Owner + "\n" + in.Work.Description))
}

type usefulWorkEvidenceDoc struct {
	Kind       string `json:"kind"`
	Owner      string `json:"owner"`
	ObservedAt string `json:"observedAt"`
	ExpiresAt  string `json:"expiresAt"`
	Scope      struct {
		SourceCommit string `json:"sourceCommit"`
		ImageDigest  string `json:"imageDigest"`
		NamespaceUID string `json:"namespaceUid"`
		WorkSha256   string `json:"workSha256"`
	} `json:"scope"`
	Content json.RawMessage `json:"content"`
}

type usefulWorkAdmission struct {
	Requests     string `json:"requests"`
	Limits       string `json:"limits"`
	Accelerators int    `json:"accelerators"`
	Admitted     bool   `json:"admitted"`
}

// usefulWorkLoadEvidence resolves one receipt to positive, hash-matched,
// scoped and current evidence. A timestamp/owner object alone proves nothing.
func usefulWorkLoadEvidence(kind string, ref usefulWorkEvidenceRef, in usefulWorkInput, now time.Time) error {
	raw, err := usefulWorkReadPrivate(ref.Path, 256<<10)
	if err != nil {
		return fmt.Errorf("%s evidence: %w", kind, err)
	}
	if usefulWorkDigest(raw) != ref.Sha256 {
		return fmt.Errorf("%s evidence differs from its hash", kind)
	}
	var doc usefulWorkEvidenceDoc
	if err := strictJSON(raw, &doc); err != nil {
		return fmt.Errorf("%s evidence: %w", kind, err)
	}
	if doc.Kind != kind || doc.Owner == "" {
		return fmt.Errorf("%s evidence has kind %q or no owner", kind, doc.Kind)
	}
	if doc.Scope.SourceCommit != in.Reviewed.SourceCommit || doc.Scope.ImageDigest != in.Reviewed.ImageDigest ||
		doc.Scope.NamespaceUID != in.Kube.NamespaceUID || doc.Scope.WorkSha256 != in.Work.ReviewedSha256 {
		return fmt.Errorf("%s evidence scope differs from the input", kind)
	}
	expires, err1 := time.Parse(time.RFC3339, doc.ExpiresAt)
	observed, err2 := time.Parse(time.RFC3339, doc.ObservedAt)
	if err1 != nil || err2 != nil || !expires.After(now) || observed.After(now.Add(time.Minute)) {
		return fmt.Errorf("%s evidence is not current", kind)
	}
	switch kind {
	case "sourceSnapshot":
		c2 := struct {
			TsSha256        string `json:"tsSha256"`
			GoSha256        string `json:"goSha256"`
			BinarySha256    string `json:"binarySha256"`
			BuiltFromCommit string `json:"builtFromCommit"`
		}{}
		if err := strictJSON(doc.Content, &c2); err != nil || c2.TsSha256 != in.Reviewed.TsSha256 || c2.GoSha256 != in.Reviewed.GoSha256 ||
			c2.BinarySha256 != in.Reviewed.BinarySha256 || c2.BuiltFromCommit != in.Reviewed.SourceCommit {
			return errors.New("sourceSnapshot content mismatch")
		}
	case "currentOwner":
		var c struct {
			TaskOwner string `json:"taskOwner"`
			Unowned   bool   `json:"unowned"`
		}
		if err := strictJSON(doc.Content, &c); err != nil || c.TaskOwner != in.Work.Owner || !c.Unowned {
			return errors.New("currentOwner content mismatch")
		}
	case "authorization":
		var c struct {
			TaskNeed   string `json:"taskNeed"`
			TaskSha256 string `json:"taskSha256"`
		}
		if err := strictJSON(doc.Content, &c); err != nil || c.TaskNeed != in.Work.Need || c.TaskSha256 != usefulWorkTaskHash(in) {
			return errors.New("authorization content mismatch")
		}
	case "bakedInputs":
		var c struct {
			Bootstrap        string `json:"bootstrapSha256"`
			WorkerActivation string `json:"workerActivationSha256"`
			ProviderProcess  string `json:"providerProcessSha256"`
			PublicRoots      string `json:"publicRootsSha256"`
		}
		if err := strictJSON(doc.Content, &c); err != nil || c.PublicRoots != in.Callback.PublicRootsSha ||
			usefulWorkDigest([]byte(c.Bootstrap+"\n"+c.WorkerActivation+"\n"+c.ProviderProcess+"\n")) != in.Reviewed.BakedInputSha256 {
			return errors.New("bakedInputs content mismatch")
		}
	default: // parent/worker/provider admission
		var c usefulWorkAdmission
		if err := strictJSON(doc.Content, &c); err != nil || c.Requests != "2/6Gi/24Gi" || c.Limits != "2/6Gi/24Gi" || c.Accelerators != 0 || !c.Admitted {
			return fmt.Errorf("%s content mismatch", kind)
		}
	}
	return nil
}

func (in usefulWorkInput) validate(now time.Time) error {
	k := in.Kube
	for name, v := range map[string]string{
		"kube.context": k.Context, "kube.cluster": k.Cluster, "kube.kubeconfig": k.Kubeconfig, "kube.namespace": k.Namespace,
		"kube.namespaceUid": k.NamespaceUID, "kube.serviceAccount": k.ServiceAccount,
		"kube.serviceAccountUid": k.ServiceAccountUID, "kube.credentialSecret": k.CredentialSecret,
		"kube.credentialSecretUid": k.CredentialSecretUID, "kube.audience": k.Audience,
		"callback.ip": in.Callback.IP, "callback.publicRootsPath": in.Callback.PublicRootsPath,
		"binary": in.Binary, "evidenceDir": in.EvidenceDir, "work.title": in.Work.Title,
		"work.description": in.Work.Description, "work.need": in.Work.Need, "work.owner": in.Work.Owner,
	} {
		if strings.TrimSpace(v) == "" {
			return errors.New(name + " is required; refusing any default")
		}
	}
	for name, p := range map[string]string{"kube.kubeconfig": k.Kubeconfig, "callback.publicRootsPath": in.Callback.PublicRootsPath, "binary": in.Binary, "evidenceDir": in.EvidenceDir} {
		if !strings.HasPrefix(p, "/") {
			return errors.New(name + " must be absolute")
		}
	}
	if k.Namespace == "default" || strings.HasPrefix(k.Namespace, "kube-") {
		return errors.New("refusing a default or system namespace")
	}
	if len(k.NamespaceLabels) == 0 || len(k.NodeSelector) == 0 {
		return errors.New("namespace labels and node selector must be explicit")
	}
	img := in.Reviewed.ImageDigest
	if i := strings.LastIndex(img, "@sha256:"); i <= 0 || !usefulWorkHex(img[i+len("@sha256:"):], 64) || strings.Contains(img, ":latest") {
		return errors.New("image must be an immutable digest")
	}
	if len(in.Reviewed.SourceCommit) != 40 || !usefulWorkHex(in.Reviewed.SourceCommit, 40) {
		return errors.New("reviewed source commit must be a full hash")
	}
	for name, h := range map[string]string{
		"tsSha256": in.Reviewed.TsSha256, "goSha256": in.Reviewed.GoSha256, "binarySha256": in.Reviewed.BinarySha256,
		"bakedInputSha256": in.Reviewed.BakedInputSha256, "publicRootsSha256": in.Callback.PublicRootsSha, "work.reviewedSha256": in.Work.ReviewedSha256,
	} {
		if !usefulWorkHex(h, 64) {
			return errors.New(name + " must be a sha256 hex digest")
		}
	}
	if in.Callback.SAN != in.Callback.IP || !usefulWorkPrivateIPv4(in.Callback.IP) {
		return errors.New("callback SAN must equal an exact private callback IP")
	}
	if usefulWorkTaskHash(in) != in.Work.ReviewedSha256 {
		return errors.New("task need/owner/description differ from the reviewed hash")
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	if b, err := os.ReadFile(exe); err != nil || usefulWorkDigest(b) != in.Reviewed.BinarySha256 {
		return errors.New("running test binary differs from the reviewed hash")
	}
	if b, err := os.ReadFile(in.Callback.PublicRootsPath); err != nil || usefulWorkDigest(b) != in.Callback.PublicRootsSha {
		return errors.New("public roots differ from the exact image bundle hash")
	}
	for kind, ref := range map[string]usefulWorkEvidenceRef{
		"authorization": in.Evidence.Authorization, "currentOwner": in.Evidence.CurrentOwner, "sourceSnapshot": in.Evidence.SourceSnapshot,
		"bakedInputs": in.Evidence.BakedInputs, "parentAdmission": in.Evidence.ParentAdmission,
		"workerAdmission": in.Evidence.WorkerAdmission, "providerAdmission": in.Evidence.ProviderAdmission,
	} {
		if err := usefulWorkLoadEvidence(kind, ref, in, now); err != nil {
			return err
		}
	}
	return nil
}

func usefulWorkPrivateIPv4(ip string) bool {
	var a, b, c, d int
	if n, err := fmt.Sscanf(ip, "%d.%d.%d.%d", &a, &b, &c, &d); err != nil || n != 4 || fmt.Sprintf("%d.%d.%d.%d", a, b, c, d) != ip {
		return false
	}
	return a == 10 || (a == 172 && b >= 16 && b <= 31) || (a == 192 && b == 168)
}

func usefulWorkParse(raw []byte, now time.Time) (usefulWorkInput, error) {
	var in usefulWorkInput
	if err := strictJSON(raw, &in); err != nil {
		return in, err
	}
	return in, in.validate(now)
}

// usefulWorkEnabled applies the strict opt-in and loads the shared input file.
// Unset skips BEFORE any file, client, Secret or API access.
func usefulWorkEnabled(t *testing.T) (usefulWorkInput, string) {
	t.Helper()
	switch v, set := os.LookupEnv(usefulWorkEnv); {
	case !set:
		t.Skip("useful-work family not enabled; no Kubernetes access")
	case v != "1":
		t.Fatalf("%s must be unset or exactly 1", usefulWorkEnv)
	}
	raw, err := usefulWorkReadPrivate(os.Getenv(usefulWorkInputEnv), 256<<10)
	if err != nil {
		t.Fatalf("%s must name an absolute private input file: %v", usefulWorkInputEnv, err)
	}
	in, err := usefulWorkParse(raw, time.Now())
	if err != nil {
		t.Fatalf("useful-work input refused: %v", err)
	}
	return in, usefulWorkDigest(raw)
}

type usefulWorkDescriptor struct {
	Invocation    string `json:"invocation"`
	InputSha256   string `json:"inputSha256"`
	PoolID        string `json:"poolId"`
	Cluster       string `json:"cluster"`
	RunID         string `json:"runId"`
	WorkID        string `json:"workId"`
	ControllerURL string `json:"controllerUrl"`
	CallbackURL   string `json:"callbackUrl"`
	CABundlePath  string `json:"caBundlePath"`
}

func usefulWorkDescribe(in usefulWorkInput, inputSha string) (usefulWorkDescriptor, error) {
	var d usefulWorkDescriptor
	if err := strictJSON([]byte(os.Getenv(usefulWorkDescriptorEnv)), &d); err != nil {
		return d, err
	}
	switch {
	case len(d.Invocation) < 8 || d.PoolID == "" || d.RunID == "" || d.WorkID == "" || d.CABundlePath == "":
		return d, errors.New("descriptor is incomplete")
	case d.InputSha256 != inputSha:
		return d, errors.New("descriptor binds a different input than this child loaded")
	case !strings.HasPrefix(d.ControllerURL, "http://127.0.0.1:"):
		return d, errors.New("controller must be the parent's loopback HTTP listener")
	case !strings.HasPrefix(d.CallbackURL, "https://"+in.Callback.IP+":"):
		return d, errors.New("callback must be the qualified private HTTPS listener")
	}
	return d, nil
}

// ---- Kubernetes client and read-only identity preflight -------------------

func usefulWorkClient(ctx context.Context, t *testing.T, in usefulWorkInput) *kubernetes.Clientset {
	t.Helper()
	k := in.Kube
	raw, err := clientcmd.LoadFromFile(k.Kubeconfig)
	if err != nil {
		t.Fatalf("reading the explicit kubeconfig: %v", err)
	}
	if c, ok := raw.Contexts[k.Context]; !ok || c == nil {
		t.Fatal("the exact required context is absent")
	} else if c.Namespace != "" && c.Namespace != k.Namespace {
		t.Fatalf("context %q names namespace %q, not %q", k.Context, c.Namespace, k.Namespace)
	} else if cl, ok := raw.Clusters[c.Cluster]; !ok || cl == nil || c.Cluster != k.Cluster {
		t.Fatalf("context %q does not name the qualified cluster", k.Context)
	}
	cfg, err := clientcmd.NewNonInteractiveDeferredLoadingClientConfig(
		&clientcmd.ClientConfigLoadingRules{ExplicitPath: k.Kubeconfig},
		&clientcmd.ConfigOverrides{CurrentContext: k.Context, Context: clientcmdapi.Context{Namespace: k.Namespace}}).ClientConfig()
	if err != nil || cfg.Host == "" {
		t.Fatalf("unloadable or unqualified context: %v", err)
	}
	if cfg.Insecure || (len(cfg.CAData) == 0 && cfg.CAFile == "") {
		t.Fatal("the cluster must be CA-verified; refusing insecure TLS")
	}
	client, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		t.Fatal(err)
	}
	ns, err := client.CoreV1().Namespaces().Get(ctx, k.Namespace, meta.GetOptions{})
	if err != nil {
		t.Fatalf("qualified namespace is unreadable: %v", err)
	}
	if string(ns.UID) != k.NamespaceUID || ns.DeletionTimestamp != nil || ns.Status.Phase == core.NamespaceTerminating {
		t.Fatalf("namespace %s does not match the qualified UID or is terminating", k.Namespace)
	}
	for key, v := range k.NamespaceLabels {
		if ns.Labels[key] != v {
			t.Fatalf("namespace lacks qualification %s=%s", key, v)
		}
	}
	sa, err := client.CoreV1().ServiceAccounts(k.Namespace).Get(ctx, k.ServiceAccount, meta.GetOptions{})
	if err != nil || string(sa.UID) != k.ServiceAccountUID {
		t.Fatalf("ServiceAccount %s is missing or its UID differs: %v", k.ServiceAccount, err)
	}
	secret, err := client.CoreV1().Secrets(k.Namespace).Get(ctx, k.CredentialSecret, meta.GetOptions{})
	if err != nil || string(secret.UID) != k.CredentialSecretUID {
		t.Fatalf("credential Secret %s is missing or its UID differs: %v", k.CredentialSecret, err)
	}
	// Presence only: values are never copied into a message or retained.
	for _, key := range []string{"telemetry-writer.json", "claude-code-oauth-token", "opencode-llm-api-key"} {
		if len(secret.Data[key]) == 0 {
			t.Fatalf("credential Secret lacks nonempty key %s", key)
		}
	}
	return client
}

type usefulWorkIdentity struct {
	Issuer  string
	JWKSURI string
	JWKS    map[string]any
}

// usefulWorkPublicIdentity reads the actual cluster issuer and public JWKS over
// the authenticated, CA-verified REST client. No TokenRequest, signer or key.
func usefulWorkPublicIdentity(ctx context.Context, t *testing.T, client *kubernetes.Clientset) usefulWorkIdentity {
	t.Helper()
	rest := client.Discovery().RESTClient()
	get := func(path string) []byte {
		b, err := rest.Get().AbsPath(path).SetHeader("Accept", "application/json").DoRaw(ctx)
		if err != nil || len(b) > 256<<10 {
			t.Fatalf("reading %s: %v", path, err)
		}
		return b
	}
	var cfg struct {
		Issuer  string `json:"issuer"`
		JWKSURI string `json:"jwks_uri"`
	}
	if err := json.Unmarshal(get("/.well-known/openid-configuration"), &cfg); err != nil || !strings.HasPrefix(cfg.Issuer, "https://") || !strings.HasPrefix(cfg.JWKSURI, "https://") {
		t.Fatalf("cluster issuer metadata is unusable: %v", err)
	}
	var jwks map[string]any
	if err := json.Unmarshal(get("/openid/v1/jwks"), &jwks); err != nil {
		t.Fatalf("cluster JWKS is unreadable: %v", err)
	}
	keys, _ := jwks["keys"].([]any)
	if len(keys) == 0 {
		t.Fatal("cluster publishes no signing keys")
	}
	for _, k := range keys {
		m, _ := k.(map[string]any)
		for _, private := range []string{"d", "p", "q", "dp", "dq", "qi", "k"} {
			if _, bad := m[private]; bad {
				t.Fatal("JWKS carries a private member")
			}
		}
	}
	return usefulWorkIdentity{Issuer: cfg.Issuer, JWKSURI: cfg.JWKSURI, JWKS: map[string]any{"keys": keys}}
}

func usefulWorkCapabilities(ctx context.Context, t *testing.T, client *kubernetes.Clientset, ns string) {
	t.Helper()
	for _, a := range []auth.ResourceAttributes{
		{Group: "batch", Resource: "jobs", Verb: "create"}, {Group: "batch", Resource: "jobs", Verb: "get"},
		{Group: "batch", Resource: "jobs", Verb: "update"}, {Group: "batch", Resource: "jobs", Verb: "delete"},
		{Group: "batch", Resource: "jobs", Verb: "list"}, {Resource: "pods", Verb: "list"},
		{Resource: "secrets", Verb: "create"}, {Resource: "secrets", Verb: "get"}, {Resource: "secrets", Verb: "delete"},
		{Resource: "configmaps", Verb: "create"}, {Resource: "configmaps", Verb: "get"}, {Resource: "configmaps", Verb: "delete"},
	} {
		a.Namespace = ns
		review, err := client.AuthorizationV1().SelfSubjectAccessReviews().Create(ctx, &auth.SelfSubjectAccessReview{Spec: auth.SelfSubjectAccessReviewSpec{ResourceAttributes: &a}}, meta.CreateOptions{})
		if err != nil || !review.Status.Allowed {
			t.Fatalf("operator lacks %s on %s/%s: %v", a.Verb, a.Group, a.Resource, err)
		}
	}
}

func usefulWorkEligibleNode(ctx context.Context, t *testing.T, client *kubernetes.Clientset, selector map[string]string) {
	t.Helper()
	nodes, err := client.CoreV1().Nodes().List(ctx, meta.ListOptions{LabelSelector: meta.FormatLabelSelector(&meta.LabelSelector{MatchLabels: selector})})
	if err != nil {
		t.Fatalf("reading qualified nodes: %v", err)
	}
	for _, n := range nodes.Items {
		blocked := n.DeletionTimestamp != nil || n.Spec.Unschedulable
		for _, taint := range n.Spec.Taints {
			blocked = blocked || taint.Effect == core.TaintEffectNoSchedule || taint.Effect == core.TaintEffectNoExecute
		}
		ready := false
		for _, c := range n.Status.Conditions {
			ready = ready || (c.Type == core.NodeReady && c.Status == core.ConditionTrue)
		}
		if !blocked && ready {
			return
		}
	}
	t.Fatal("no existing Ready schedulable node matches the qualified selector")
}

func TestReceiptKubernetesUsefulWorkPreflight(t *testing.T) {
	in, _ := usefulWorkEnabled(t)
	ctx, cancel := context.WithTimeout(context.Background(), usefulWorkPreflightTime)
	defer cancel()
	client := usefulWorkClient(ctx, t, in)
	usefulWorkPublicIdentity(ctx, t, client)
	usefulWorkCapabilities(ctx, t, client, in.Kube.Namespace)
	usefulWorkEligibleNode(ctx, t, client, in.Kube.NodeSelector)
}

// ---- Delegating client: the one allowed Job create delta -------------------

// The wrapper delegates all real API traffic. Only this invocation's first
// Jobs Create is changed, and only by the whitelist below.
type usefulWorkDelta struct {
	mu       sync.Mutex
	base     kubernetes.Interface
	ns       string
	cmName   string
	bundle   string
	expected *batch.Job
	created  bool
	cmUID    string
	cmRV     string
	jobUID   string
	err      error
}

type usefulWorkClientWrap struct {
	kubernetes.Interface
	d *usefulWorkDelta
}

func (c usefulWorkClientWrap) BatchV1() batchv1.BatchV1Interface {
	return usefulWorkBatch{c.Interface.BatchV1(), c.d}
}

type usefulWorkBatch struct {
	batchv1.BatchV1Interface
	d *usefulWorkDelta
}

func (b usefulWorkBatch) Jobs(ns string) batchv1.JobInterface {
	return usefulWorkJobs{b.BatchV1Interface.Jobs(ns), b.d}
}

type usefulWorkJobs struct {
	batchv1.JobInterface
	d *usefulWorkDelta
}

func usefulWorkApplyDelta(job *batch.Job, configMap string) (*batch.Job, error) {
	out := job.DeepCopy()
	pod := &out.Spec.Template.Spec
	if len(pod.Containers) != 1 || len(pod.InitContainers) != 0 || len(pod.EphemeralContainers) != 0 {
		return nil, errors.New("Job must have exactly one direct-runner container")
	}
	c := &pod.Containers[0]
	for _, e := range c.Env {
		if e.Name == "CURL_CA_BUNDLE" || e.Name == "CODEX_TIMEOUT_SECONDS" {
			return nil, fmt.Errorf("production Job already sets %s", e.Name)
		}
	}
	const dir = "/etc/lcars-public-ca"
	c.Env = append(c.Env, core.EnvVar{Name: "CURL_CA_BUNDLE", Value: dir + "/ca-bundle.pem"}, core.EnvVar{Name: "CODEX_TIMEOUT_SECONDS", Value: fmt.Sprint(usefulWorkProviderS)})
	c.VolumeMounts = append(c.VolumeMounts, core.VolumeMount{Name: "public-ca", MountPath: dir, ReadOnly: true})
	pod.Volumes = append(pod.Volumes, core.Volume{Name: "public-ca", VolumeSource: core.VolumeSource{ConfigMap: &core.ConfigMapVolumeSource{LocalObjectReference: core.LocalObjectReference{Name: configMap}}}})
	deadline := int64(usefulWorkRunDeadlineS)
	// Keep the location q.job negotiated: Pod clock when placement-aware, else
	// Job clock. Never both.
	if pod.ActiveDeadlineSeconds != nil {
		pod.ActiveDeadlineSeconds = &deadline
	} else {
		out.Spec.ActiveDeadlineSeconds = &deadline
	}
	return out, nil
}

func (j usefulWorkJobs) Create(ctx context.Context, job *batch.Job, opts meta.CreateOptions) (*batch.Job, error) {
	d := j.d
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.expected == nil || job.Name != d.expected.Name {
		return nil, errors.New("unexpected Job create outside this invocation")
	}
	if !reflect.DeepEqual(job, d.expected) {
		d.err = errors.New("Job body differs from the production q.job body")
		return nil, d.err
	}
	delta, err := usefulWorkApplyDelta(job, d.cmName)
	if err != nil {
		d.err = err
		return nil, err
	}
	if !d.created {
		immutable := true
		cm, err := d.base.CoreV1().ConfigMaps(d.ns).Create(ctx, &core.ConfigMap{
			ObjectMeta: meta.ObjectMeta{Name: d.cmName, Namespace: d.ns, Labels: map[string]string{"agent-lcars.useful-work": "true"}},
			Immutable:  &immutable, Data: map[string]string{"ca-bundle.pem": d.bundle},
		}, meta.CreateOptions{})
		if err != nil {
			d.err = err
			return nil, err
		}
		d.created, d.cmUID, d.cmRV = true, string(cm.UID), cm.ResourceVersion
	}
	created, err := j.JobInterface.Create(ctx, delta, opts)
	if err == nil {
		d.jobUID = string(created.UID)
	}
	return created, err
}

// ---- Controller protocol ----------------------------------------------------

type usefulWorkLink struct {
	t    *testing.T
	inv  string
	seq  int
	acks chan string
	errs chan error
}

func (l *usefulWorkLink) emit(kind string, fields map[string]any) {
	l.t.Helper()
	l.seq++
	fields["v"], fields["invocation"], fields["seq"], fields["kind"] = 1, l.inv, l.seq, kind
	b, err := json.Marshal(fields)
	if err != nil || len(b)+len(usefulWorkFrameMarker) > usefulWorkFrameLimit {
		l.t.Fatalf("frame %s is unmarshalable or exceeds its bound: %v", kind, err)
	}
	fmt.Fprintf(os.Stdout, "\n%s%s\n", usefulWorkFrameMarker, b)
}

func (l *usefulWorkLink) await(ctx context.Context, name string) {
	l.t.Helper()
	select {
	case got := <-l.acks:
		if got != name {
			l.t.Fatalf("parent sent ACK %q, expected %q", got, name)
		}
	case err := <-l.errs:
		l.t.Fatalf("control pipe failed while waiting for %s: %v", name, err)
	case <-ctx.Done():
		l.t.Fatalf("timed out waiting for the parent's %s ACK", name)
	}
}

func usefulWorkOpenLink(t *testing.T, d usefulWorkDescriptor) (*usefulWorkLink, string) {
	t.Helper()
	r := bufio.NewReaderSize(os.Stdin, usefulWorkFrameLimit)
	line, err := r.ReadBytes('\n')
	if err != nil {
		t.Fatalf("controller handshake missing on stdin: %v", err)
	}
	var hello struct {
		ControllerBearer string `json:"controllerBearer"`
		Invocation       string `json:"invocation"`
	}
	if err := strictJSON(line, &hello); err != nil || hello.ControllerBearer == "" || hello.Invocation != d.Invocation {
		t.Fatalf("controller handshake invalid: %v", err)
	}
	l := &usefulWorkLink{t: t, inv: d.Invocation, acks: make(chan string, 8), errs: make(chan error, 1)}
	go func() {
		for {
			line, err := r.ReadBytes('\n')
			if err != nil {
				l.errs <- err
				return
			}
			var a struct {
				Ack        string `json:"ack"`
				Invocation string `json:"invocation"`
			}
			if err := strictJSON(line, &a); err != nil || a.Invocation != l.inv {
				l.errs <- errors.New("malformed or foreign ACK")
				return
			}
			l.acks <- a.Ack
		}
	}()
	return l, hello.ControllerBearer
}

// ---- The full journey ----------------------------------------------------------

var usefulWorkProfile = map[string]string{"cpu": "2", "memory": "6Gi", "ephemeral-storage": "24Gi"}

func usefulWorkPoll(ctx context.Context, every time.Duration, step func() (bool, error)) error {
	tick := time.NewTicker(every)
	defer tick.Stop()
	for {
		done, err := step()
		if err != nil {
			return err
		}
		if done {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-tick.C:
		}
	}
}

func TestReceiptKubernetesUsefulWork(t *testing.T) {
	in, inputSha := usefulWorkEnabled(t)
	d, err := usefulWorkDescribe(in, inputSha)
	if err != nil {
		t.Fatalf("this entry is only spawned by the Node owner: %v", err)
	}
	link, bearer := usefulWorkOpenLink(t, d)
	start := time.Now()
	logical, cancel := context.WithDeadline(context.Background(), start.Add(usefulWorkLogical))
	defer cancel()

	// 1. Read-only identity preflight, bound to the invocation, then ACK.
	client := usefulWorkClient(logical, t, in)
	usefulWorkCapabilities(logical, t, client, in.Kube.Namespace)
	usefulWorkEligibleNode(logical, t, client, in.Kube.NodeSelector)
	id := usefulWorkPublicIdentity(logical, t, client)
	jwksBytes, _ := json.Marshal(id.JWKS)
	link.emit("publicIdentity", map[string]any{
		"inputSha256": inputSha, "poolId": d.PoolID, "issuer": id.Issuer, "jwksUri": id.JWKSURI, "jwks": id.JWKS,
		"jwksSha256": usefulWorkDigest(jwksBytes), "namespace": in.Kube.Namespace, "serviceAccountUid": in.Kube.ServiceAccountUID,
	})
	link.await(logical, "prepared")

	// 2. The ACTUAL queue: full normal envelope, real credential Secret, exact
	// image, real fences. Controller calls stay on the parent's loopback.
	pool := queueCapacityConfig{PoolID: d.PoolID, Cluster: d.Cluster, Version: 1, WorkerAudience: in.Kube.Audience}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	idToken := func() (string, error) { return bearer, nil }
	runner := "useful-work-" + d.Invocation
	delta := &usefulWorkDelta{base: client, ns: in.Kube.Namespace, cmName: "lcars-uw-public-ca-" + d.Invocation}
	if b, err := os.ReadFile(d.CABundlePath); err != nil || len(b) == 0 {
		t.Fatalf("public CA bundle unreadable: %v", err)
	} else {
		delta.bundle = string(b)
	}
	q := &kubernetesQueue{
		client: usefulWorkClientWrap{client, delta}, image: in.Reviewed.ImageDigest, logger: logger, workerPolicyProviders: "codex",
		config: queueKubernetesConfig{
			Namespace: in.Kube.Namespace, CredentialsSecret: in.Kube.CredentialSecret, ServiceAccount: in.Kube.ServiceAccount,
			MaxConcurrent: 1, NodeSelector: in.Kube.NodeSelector, Requests: usefulWorkProfile, Limits: usefulWorkProfile, Capacity: &pool,
		},
		verifyRun: queueRunFence(d.ControllerURL),
	}
	q.capacity = &queueCapacityClient{config: pool, namespace: in.Kube.Namespace, maxConcurrent: 1, consoleURL: d.ControllerURL, idToken: idToken, producerID: newCapacityIdentity()}
	q.exits = newRunExitReporter(d.ControllerURL, runner, idToken, logger)
	q.claimSettled = queueClaimStatus(d.ControllerURL, idToken)
	if err := q.config.validate(); err != nil {
		t.Fatalf("the normal envelope is refused by the production validator: %v", err)
	}
	if err := q.preflight(logical); err != nil {
		t.Fatalf("production queue preflight refused: %v", err)
	}
	reservation, err := q.reserve(logical)
	if err != nil {
		t.Fatalf("reserve refused: %v", err)
	}
	if reservation == nil {
		t.Fatal("no reservation: the normal 2CPU/6Gi/24Gi envelope does not fit; no claim is made")
	}
	defer reservation.release()

	// 3. Real claim of the run the parent requested and confirmed.
	var claim capacityClaimReply
	if err := usefulWorkPoll(logical, 3*time.Second, func() (bool, error) {
		var e error
		claim, e = q.capacity.claim(logical, runner, true)
		return e == nil && claim.Kind != "wait", e
	}); err != nil {
		t.Fatalf("capacity claim did not complete: %v", err)
	}
	if claim.Kind != "claim" || claim.RunID != d.RunID || claim.Pipeline != "codex" || claim.Token == "" || claim.Receipt == nil {
		t.Fatalf("claim %q is not the requested codex run (run=%q pipeline=%q)", claim.Kind, claim.RunID, claim.Pipeline)
	}
	link.emit("claimed", map[string]any{"runId": claim.RunID, "producerId": q.capacity.producerID, "jobName": claim.JobName})

	// 4. Launch through production q.launch -> launchReceipt -> resumeReceipt.
	launch := directRunnerLaunch{placementAware: claim.PlacementAware, runID: claim.RunID, runToken: claim.Token, pipeline: claim.Pipeline, consoleURL: d.CallbackURL, runner: runner, receipt: claim.Receipt}
	expected, err := q.job(launch)
	if err != nil {
		t.Fatalf("production q.job refused the launch: %v", err)
	}
	delta.mu.Lock()
	delta.expected = expected
	delta.mu.Unlock()
	if err := reservation.launch(launch); err != nil {
		t.Fatalf("launch refused (retaining any created object): %v", err)
	}
	delta.mu.Lock()
	if delta.err != nil {
		t.Fatalf("Job create delta violated: %v", delta.err)
	}
	cmUID, cmRV := delta.cmUID, delta.cmRV
	delta.mu.Unlock()
	job, err := client.BatchV1().Jobs(in.Kube.Namespace).Get(logical, claim.JobName, meta.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	secret, err := client.CoreV1().Secrets(in.Kube.Namespace).Get(logical, claim.JobName, meta.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	link.emit("jobAccepted", map[string]any{"runId": claim.RunID, "jobUid": string(job.UID), "secretUid": string(secret.UID), "configMapUid": cmUID, "claimFingerprint": queueClaimFingerprint(claim.Token)})

	// 5. Real reconcile until the original Pod activates and finishes. Finite
	// shared deadline; never an unbounded replay.
	var (
		seen             = map[string]bool{}
		podUID           string
		ended            bool
		exitCode         int32 = -1
		reconcileFailure error
	)
	ownedPods := func(j *batch.Job) []core.Pod {
		list, err := client.CoreV1().Pods(in.Kube.Namespace).List(logical, meta.ListOptions{LabelSelector: queueJobLabel + "=true"})
		if err != nil {
			return nil
		}
		var out []core.Pod
		for _, p := range list.Items {
			if podOwnedBy(p, j) {
				out = append(out, p)
			}
		}
		return out
	}
	err = usefulWorkPoll(logical, 5*time.Second, func() (bool, error) {
		if e := q.reconcileReceipts(logical); e != nil {
			reconcileFailure = e // transient until the deadline; reported below
		}
		current, e := client.BatchV1().Jobs(in.Kube.Namespace).Get(logical, claim.JobName, meta.GetOptions{})
		if e != nil || current.UID != job.UID {
			return false, fmt.Errorf("original Job identity changed or unreadable: %v", e)
		}
		pods := ownedPods(current)
		if len(pods) > 1 {
			return false, errors.New("more than one Pod owned by the original Job")
		}
		if len(pods) == 1 {
			p := pods[0]
			podUID = string(p.UID)
			if len(p.Spec.Containers) != 1 || p.Spec.Containers[0].Image != in.Reviewed.ImageDigest {
				return false, errors.New("Pod spec image differs from the immutable reviewed image")
			}
			var cs *core.ContainerStatus
			if len(p.Status.ContainerStatuses) == 1 {
				cs = &p.Status.ContainerStatuses[0]
			}
			if cs != nil && cs.ImageID != "" && !seen["pod"] {
				if !strings.Contains(cs.ImageID, in.Reviewed.ImageDigest[strings.LastIndex(in.Reviewed.ImageDigest, "@sha256:")+1:]) {
					return false, fmt.Errorf("actual imageID %q is not the reviewed digest", cs.ImageID)
				}
				seen["pod"] = true
				link.emit("podObserved", map[string]any{"runId": claim.RunID, "podUid": podUID, "imageId": cs.ImageID})
			}
			if inv, e := q.capacity.inventory(logical); e == nil && !seen["activated"] {
				for _, r := range inv.Receipts {
					if r.RunID == claim.RunID && r.Worker != nil && r.Worker.Active && r.Worker.PodUID == podUID && r.Worker.JobUID == string(job.UID) {
						seen["activated"] = true
						link.emit("workerActivated", map[string]any{"runId": claim.RunID, "generation": r.Worker.Generation, "podUid": podUID})
					}
				}
			}
			if cs != nil && !seen["provider"] && (cs.State.Running != nil || cs.State.Terminated != nil) {
				at := time.Now()
				if cs.State.Running != nil {
					at = cs.State.Running.StartedAt.Time
				} else {
					at = cs.State.Terminated.StartedAt.Time
				}
				seen["provider"] = true
				link.emit("providerObserved", map[string]any{"runId": claim.RunID, "containerStartedAt": at.UTC().Format(time.RFC3339)})
			}
			if cs != nil && cs.State.Terminated != nil {
				exitCode = cs.State.Terminated.ExitCode
			}
		}
		done, _ := physicalReceiptWorkersEnded(current, pods)
		ended = done && len(pods) == 1
		return ended, nil
	})
	if err != nil || !seen["activated"] {
		t.Fatalf("worker did not activate and end within the shared deadline (activated=%v, reconcile=%v): %v", seen["activated"], reconcileFailure, err)
	}
	if exitCode != 0 {
		t.Fatalf("worker container exited %d; the report is not a success and all identities are retained", exitCode)
	}
	link.emit("usefulCompleted", map[string]any{"runId": claim.RunID})
	// The parent reads the finished report from the SECOND Store client and
	// runs canonical credential recovery BEFORE any physical retirement.
	link.await(logical, "usefulRecorded")
	link.emit("physicalEnded", map[string]any{"runId": claim.RunID, "podUid": podUID, "exitCode": int(exitCode)})

	// 6. Quiesce, retire and release through the real reconcile path.
	cleanup, ccancel := context.WithTimeout(context.Background(), usefulWorkCleanup)
	defer ccancel()
	if err := q.quiesceReceipts(cleanup); err != nil {
		t.Fatalf("quiesce refused (identities retained): %v", err)
	}
	var retired capacityReply
	if err := usefulWorkPoll(cleanup, 4*time.Second, func() (bool, error) {
		if e := q.reconcileReceipts(cleanup); e != nil {
			return false, nil
		}
		r, e := q.capacity.command(cleanup, map[string]any{"action": "inspect-retired", "runId": claim.RunID})
		if e != nil || r.Retirement == nil {
			return false, nil
		}
		retired = r
		return r.Retirement.Released, nil
	}); err != nil {
		t.Fatalf("no positive retirement/release evidence (identities retained): %v", err)
	}
	final, err := client.BatchV1().Jobs(in.Kube.Namespace).Get(cleanup, claim.JobName, meta.GetOptions{})
	if err != nil || final.UID != job.UID {
		t.Fatalf("original Job identity changed before cleanup: %v", err)
	}
	barrier := final.Annotations[queueBarrierAnnotation] != ""
	link.emit("retired", map[string]any{"runId": claim.RunID, "released": retired.Retirement.Released, "barrier": barrier})

	// 7. Conditional cleanup of exactly the objects this invocation created. The
	// Job stays: its inert name barrier is intentionally preserved by production.
	var removed, retained []string
	retained = append(retained, "job:"+string(job.UID)+"(barrier)")
	del := func(kind, name, uid, rv string, f func(meta.DeleteOptions) error) {
		u, r := types.UID(uid), rv
		if err := f(meta.DeleteOptions{Preconditions: &meta.Preconditions{UID: &u, ResourceVersion: &r}}); err != nil {
			retained = append(retained, kind+":"+uid)
			return
		}
		removed = append(removed, kind+":"+uid)
	}
	if s, err := client.CoreV1().Secrets(in.Kube.Namespace).Get(cleanup, claim.JobName, meta.GetOptions{}); err == nil && string(s.UID) == string(secret.UID) && receiptSecretMatches(s, final, capacityReceipt{capacityFence: *claim.Receipt, JobName: claim.JobName, JobUID: string(job.UID), SecretUID: string(secret.UID)}) {
		del("secret", s.Name, string(s.UID), s.ResourceVersion, func(o meta.DeleteOptions) error {
			return client.CoreV1().Secrets(in.Kube.Namespace).Delete(cleanup, s.Name, o)
		})
	} else {
		retained = append(retained, "secret:"+string(secret.UID))
	}
	if cm, err := client.CoreV1().ConfigMaps(in.Kube.Namespace).Get(cleanup, delta.cmName, meta.GetOptions{}); err == nil && string(cm.UID) == cmUID && cm.ResourceVersion == cmRV {
		del("configmap", cm.Name, cmUID, cm.ResourceVersion, func(o meta.DeleteOptions) error {
			return client.CoreV1().ConfigMaps(in.Kube.Namespace).Delete(cleanup, cm.Name, o)
		})
	} else {
		retained = append(retained, "configmap:"+cmUID)
	}
	link.emit("cleanup", map[string]any{"runId": claim.RunID, "removed": removed, "retained": retained})
	// The Store, handlers and this lifecycle stay alive until the final ACK.
	link.await(cleanup, "finish")
}

// Offline unit controls: no cluster, no opt-in, never journey evidence.
func TestUsefulWorkUnitControls(t *testing.T) {
	t.Run("strict JSON refuses unknown, trailing and null shapes", func(t *testing.T) {
		var in usefulWorkInput
		for name, raw := range map[string]string{
			"unknown top":    `{"extra":1}`,
			"unknown nested": `{"kube":{"bogus":1}}`,
			"trailing":       `{} {}`,
			"trailing token": `{} 1`,
		} {
			if strictJSON([]byte(raw), &in) == nil {
				t.Errorf("%s was accepted", name)
			}
		}
		if err := in.validate(time.Now()); err == nil {
			t.Error("an empty (null/absent) input validated")
		}
	})
	t.Run("callback must be an exact private IPv4", func(t *testing.T) {
		for ip, want := range map[string]bool{"10.0.0.5": true, "172.16.1.1": true, "192.168.1.1": true, "8.8.8.8": false, "127.0.0.1": false, "010.0.0.5": false, "10.0.0": false} {
			if usefulWorkPrivateIPv4(ip) != want {
				t.Errorf("%s: want %v", ip, want)
			}
		}
	})
	t.Run("delta keeps the negotiated deadline location and refuses extras", func(t *testing.T) {
		q := &kubernetesQueue{image: "r/x@sha256:" + strings.Repeat("a", 64), config: queueKubernetesConfig{Namespace: "n", ServiceAccount: "s", CredentialsSecret: "c", Requests: usefulWorkProfile, Limits: usefulWorkProfile}}
		for _, aware := range []bool{false, true} {
			job, err := q.job(directRunnerLaunch{runID: "work:x/r1", pipeline: "codex", consoleURL: "https://10.0.0.5:1", placementAware: aware})
			if err != nil {
				t.Fatal(err)
			}
			out, err := usefulWorkApplyDelta(job, "cm")
			if err != nil {
				t.Fatal(err)
			}
			podClock, jobClock := out.Spec.Template.Spec.ActiveDeadlineSeconds, out.Spec.ActiveDeadlineSeconds
			if (podClock == nil) == (jobClock == nil) || (aware && podClock == nil) || (!aware && jobClock == nil) {
				t.Errorf("aware=%v: exactly one clock must carry the deadline", aware)
			}
			if len(out.Spec.Template.Spec.Containers) != 1 || len(out.Spec.Template.Spec.Containers[0].Env) != len(job.Spec.Template.Spec.Containers[0].Env)+2 {
				t.Error("delta changed more than CURL_CA_BUNDLE and CODEX_TIMEOUT_SECONDS")
			}
			if _, err := usefulWorkApplyDelta(out, "cm"); err == nil {
				t.Error("a second delta was accepted")
			}
		}
	})
	t.Run("evidence must match its hash and scope", func(t *testing.T) {
		var in usefulWorkInput
		dir := t.TempDir()
		path := dir + "/e.json"
		if err := os.WriteFile(path, []byte(`{"kind":"currentOwner"}`), 0o600); err != nil {
			t.Fatal(err)
		}
		ref := usefulWorkEvidenceRef{Path: path, Sha256: strings.Repeat("0", 64)}
		if usefulWorkLoadEvidence("currentOwner", ref, in, time.Now()) == nil {
			t.Error("a hash mismatch was accepted")
		}
		ref.Sha256 = usefulWorkDigest([]byte(`{"kind":"currentOwner"}`))
		if usefulWorkLoadEvidence("currentOwner", ref, in, time.Now()) == nil {
			t.Error("evidence without scope/owner was accepted")
		}
		if os.Chmod(path, 0o644) != nil || usefulWorkLoadEvidence("currentOwner", ref, in, time.Now()) == nil {
			t.Error("a non-private evidence file was accepted")
		}
	})
}

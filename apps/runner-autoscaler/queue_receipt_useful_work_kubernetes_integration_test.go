//go:build kubernetes_integration

// Go owner of the isolated real-bootstrap useful-work qualification carrier
// (#2312 original AC5/8; Tracks #2312, closes nothing). TEST-ONLY source: it
// adds no production seam, and the existing receipt family
// (queue_receipt_kubernetes_integration_test.go, #2926) is untouched and earns
// no credit here. Its constructor receiptFenceQueueEndpoint is INELIGIBLE for a
// real worker (dummy Secret {}, tiny resources, loopback worker policy,
// verifyRun returning nil), so this file builds the actual queue separately.
//
// Two exact entries, both gated by LCARS_RECEIPT_USEFUL_WORK=1 and the private
// closed JSON in LCARS_RECEIPT_USEFUL_WORK_INPUT (field names match the zod
// schema in apps/console/src/lib/queue-receipt-useful-work.test.ts, which owns
// the reviewed-hash binding):
//
//	TestReceiptKubernetesUsefulWorkPreflight  read-only; nothing is created.
//	TestReceiptKubernetesUsefulWork           only spawned by the Node owner.
//
// IMPLEMENTED: closed input, exact namespace UID/labels, ServiceAccount UID,
// existing credential Secret UID and normal key set, immutable image,
// Ready/schedulable node, the full 2CPU/6Gi/24Gi requests=limits queue
// configuration, real queue construction, and q.reserve before anything else.
//
// NOT IMPLEMENTED (the Node owner's checks fail honestly rather than pass):
// the public-CA/CURL_CA_BUNDLE Job transport, claim/launchReceipt, JWT
// preflight over the apiserver JWKS, controller frames, real provider
// credentials, Pod/activation observation and conditional cleanup. The Work
// test therefore stops after reserve with a failure and creates NO Job, Secret
// or ConfigMap, so nothing here can leave a leftover or earn journey credit.
package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"log/slog"
	"os"
	"strings"
	"testing"
	"time"

	core "k8s.io/api/core/v1"
	meta "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/tools/clientcmd"
	clientcmdapi "k8s.io/client-go/tools/clientcmd/api"
)

const (
	usefulWorkEnv      = "LCARS_RECEIPT_USEFUL_WORK"
	usefulWorkInputEnv = "LCARS_RECEIPT_USEFUL_WORK_INPUT"
)

// usefulWorkInput is the closed qualification input. Unknown fields are
// refused; there is no zero-value default for any field.
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
	Binary string          `json:"binary"`
	Work   json.RawMessage `json:"work"`
	// Receipts are verified by the Node owner against current source and owner;
	// Go only requires that they are present and binds nothing from them.
	Receipts json.RawMessage `json:"receipts"`
}

// usefulWorkProfile is the canonical normal native envelope: requests=limits
// 2 CPU / 6Gi memory / 24Gi ephemeral storage, no accelerators.
var usefulWorkProfile = map[string]string{"cpu": "2", "memory": "6Gi", "ephemeral-storage": "24Gi"}

func parseUsefulWorkInput(raw string) (usefulWorkInput, error) {
	var in usefulWorkInput
	dec := json.NewDecoder(strings.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&in); err != nil {
		return in, err
	}
	if dec.More() {
		return in, errUsefulWork("trailing data after the closed input")
	}
	return in, in.validate()
}

type errUsefulWork string

func (e errUsefulWork) Error() string { return string(e) }

func (in usefulWorkInput) validate() error {
	k := in.Kube
	for name, v := range map[string]string{
		"kube.context": k.Context, "kube.kubeconfig": k.Kubeconfig, "kube.namespace": k.Namespace,
		"kube.namespaceUid": k.NamespaceUID, "kube.serviceAccount": k.ServiceAccount,
		"kube.serviceAccountUid": k.ServiceAccountUID, "kube.credentialSecret": k.CredentialSecret,
		"kube.credentialSecretUid": k.CredentialSecretUID, "kube.audience": k.Audience,
		"callback.ip": in.Callback.IP, "callback.publicRootsPath": in.Callback.PublicRootsPath,
		"binary": in.Binary,
	} {
		if strings.TrimSpace(v) == "" {
			return errUsefulWork(name + " is required; refusing any default")
		}
	}
	if k.Namespace == "default" || strings.HasPrefix(k.Namespace, "kube-") {
		return errUsefulWork("refusing a default or system namespace")
	}
	if len(k.NamespaceLabels) == 0 || len(k.NodeSelector) == 0 {
		return errUsefulWork("namespace labels and node selector must be explicit")
	}
	img := in.Reviewed.ImageDigest
	if !strings.Contains(img, "@sha256:") || strings.Contains(img, ":latest") {
		return errUsefulWork("image must be an immutable digest")
	}
	if in.Callback.SAN != in.Callback.IP {
		return errUsefulWork("callback SAN must equal the exact callback IP")
	}
	if len(in.Work) == 0 || len(in.Receipts) == 0 {
		return errUsefulWork("work and receipts are required")
	}
	return nil
}

func usefulWorkEnabled(t *testing.T) usefulWorkInput {
	t.Helper()
	switch v, set := os.LookupEnv(usefulWorkEnv); {
	case !set:
		t.Skip("useful-work family not enabled; no Kubernetes access")
	case v != "1":
		t.Fatalf("%s must be unset or exactly 1", usefulWorkEnv)
	}
	in, err := parseUsefulWorkInput(os.Getenv(usefulWorkInputEnv))
	if err != nil {
		t.Fatalf("useful-work input refused: %v", err)
	}
	return in
}

// usefulWorkClient builds the explicit-context client and verifies, read-only,
// every qualified identity. It creates, updates and deletes nothing.
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
	}
	cfg, err := clientcmd.NewNonInteractiveDeferredLoadingClientConfig(
		&clientcmd.ClientConfigLoadingRules{ExplicitPath: k.Kubeconfig},
		&clientcmd.ConfigOverrides{CurrentContext: k.Context, Context: clientcmdapi.Context{Namespace: k.Namespace}}).ClientConfig()
	if err != nil || cfg.Host == "" {
		t.Fatalf("unloadable or unqualified context: %v", err)
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
	// Presence only: the values are never read into a message or retained.
	for _, key := range []string{"telemetry-writer.json", "claude-code-oauth-token", "opencode-llm-api-key"} {
		if len(secret.Data[key]) == 0 {
			t.Fatalf("credential Secret lacks nonempty key %s", key)
		}
	}
	if len(secret.Data["telemetry-writer.json"]) <= 2 || bytes.Equal(secret.Data["telemetry-writer.json"], []byte("{}")) {
		t.Fatal("credential Secret is the inert fixture, not the normal credential")
	}
	return client
}

func usefulWorkSha256(path string) (string, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:]), nil
}

func TestReceiptKubernetesUsefulWorkPreflight(t *testing.T) {
	in := usefulWorkEnabled(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	if got, err := usefulWorkSha256(in.Callback.PublicRootsPath); err != nil || got != in.Callback.PublicRootsSha {
		t.Fatalf("public roots differ from the exact image bundle hash: %v", err)
	}
	client := usefulWorkClient(ctx, t, in)
	nodes, err := client.CoreV1().Nodes().List(ctx, meta.ListOptions{LabelSelector: meta.FormatLabelSelector(&meta.LabelSelector{MatchLabels: in.Kube.NodeSelector})})
	if err != nil {
		t.Fatalf("reading qualified nodes: %v", err)
	}
	eligible := false
	for _, n := range nodes.Items {
		blocked := n.DeletionTimestamp != nil || n.Spec.Unschedulable
		for _, taint := range n.Spec.Taints {
			blocked = blocked || taint.Effect == core.TaintEffectNoSchedule || taint.Effect == core.TaintEffectNoExecute
		}
		for _, c := range n.Status.Conditions {
			if !blocked && c.Type == core.NodeReady && c.Status == core.ConditionTrue {
				eligible = true
			}
		}
	}
	if !eligible {
		t.Fatal("no existing Ready schedulable node matches the qualified selector")
	}
}

// usefulWorkQueue constructs the ACTUAL queue configuration: the full normal
// envelope with requests equal to limits, the exact image, the real credential
// Secret and ServiceAccount, and a pool of one. Controller calls use the
// parent's loopback URL; Pod-facing URLs are separate.
func usefulWorkQueue(ctx context.Context, t *testing.T, in usefulWorkInput, client *kubernetes.Clientset, controllerURL, bearer string) *kubernetesQueue {
	t.Helper()
	pool := queueCapacityConfig{PoolID: "useful-work-" + newCapacityIdentity()[:8], Cluster: "useful-work-cluster", Version: 1, WorkerAudience: in.Kube.Audience}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	idToken := func() (string, error) { return bearer, nil }
	q := &kubernetesQueue{
		client: client, image: in.Reviewed.ImageDigest, logger: logger, workerPolicyProviders: "codex",
		config: queueKubernetesConfig{
			Namespace: in.Kube.Namespace, CredentialsSecret: in.Kube.CredentialSecret, ServiceAccount: in.Kube.ServiceAccount,
			MaxConcurrent: 1, NodeSelector: in.Kube.NodeSelector,
			Requests: usefulWorkProfile, Limits: usefulWorkProfile, Capacity: &pool,
		},
		verifyRun: queueRunFence(controllerURL),
	}
	q.capacity = &queueCapacityClient{config: pool, namespace: in.Kube.Namespace, maxConcurrent: 1, consoleURL: controllerURL, idToken: idToken, producerID: newCapacityIdentity()}
	q.exits = newRunExitReporter(controllerURL, "useful-work-runner", idToken, logger)
	q.claimSettled = queueClaimStatus(controllerURL, idToken)
	if err := q.config.validate(); err != nil {
		t.Fatalf("the normal envelope is refused by the production validator: %v", err)
	}
	if err := q.preflight(ctx); err != nil {
		t.Fatalf("production queue preflight refused: %v", err)
	}
	return q
}

func TestReceiptKubernetesUsefulWork(t *testing.T) {
	in := usefulWorkEnabled(t)
	controller := os.Getenv("LCARS_RECEIPT_USEFUL_WORK_CONTROLLER")
	if !strings.HasPrefix(controller, "http://127.0.0.1:") || os.Getenv("LCARS_RECEIPT_USEFUL_WORK_CALLBACK") == "" {
		t.Fatal("TestReceiptKubernetesUsefulWork is only spawned by the Node owner with its loopback controller and callback")
	}
	var stdin struct {
		ControllerBearer string `json:"controllerBearer"`
	}
	if err := json.NewDecoder(io.LimitReader(os.Stdin, 4096)).Decode(&stdin); err != nil || stdin.ControllerBearer == "" {
		t.Fatalf("controller bearer must arrive on the private stdin pipe: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	client := usefulWorkClient(ctx, t, in)
	q := usefulWorkQueue(ctx, t, in, client, controller, stdin.ControllerBearer)
	reservation, err := q.reserve(ctx)
	if err != nil {
		t.Fatalf("reserve refused: %v", err)
	}
	if reservation == nil {
		t.Fatal("no reservation: the normal envelope does not fit; no claim is made")
	}
	reservation.release()
	t.Fatal("qualification incomplete: claim, CA-delta launch, JWT preflight, worker activation, provider observation and cleanup are not implemented in this carrier; no Job, Secret or ConfigMap was created")
}

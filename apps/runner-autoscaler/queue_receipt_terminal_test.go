package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	batch "k8s.io/api/batch/v1"
	core "k8s.io/api/core/v1"
	meta "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/kubernetes/fake"
	clienttesting "k8s.io/client-go/testing"
)

// Required Verify consumes this owning HTTP/Kubernetes regression. Unavailable
// original credential evidence must not turn an exit refusal into release.
func TestReceiptRetirementRequiresOriginalClaimAuthority(t *testing.T) {
	for _, kind := range []string{
		"original-secret", "legacy-secret-fingerprint", "missing-live", "missing-settled",
		"quarantined-live", "missing-unavailable", "missing-foreign", "missing-replaced",
		"missing-proof", "secret-unavailable", "secret-fingerprint-conflict", "exit-forbidden",
		"exit-unknown", "exit-nonterminal",
	} {
		t.Run(kind, func(t *testing.T) {
			q, r, _ := receiptFixture(t)
			r.State, r.Pipeline = "retiring", "codex"
			r.Producers = []capacityProducer{{ProducerID: "original-producer", Subject: "original-subject", Stopped: true}}
			j, err := q.job(directRunnerLaunch{runID: r.RunID, runToken: "original-token", pipeline: r.Pipeline, runner: r.Runner, receipt: &r.capacityFence})
			if err != nil {
				t.Fatal(err)
			}
			j.UID, j.ResourceVersion, j.Generation = "original-job", "17", 2
			j.Spec.Suspend = ptr(false)
			j.Status.Conditions = []batch.JobCondition{{Type: batch.JobComplete, Status: core.ConditionTrue}}
			r.JobUID, r.SecretUID = string(j.UID), "original-secret"
			r.Worker = &capacityWorker{Generation: 4, JobUID: r.JobUID, PodUID: "original-pod", Active: true}
			p := &core.Pod{ObjectMeta: meta.ObjectMeta{Name: "original-pod", Namespace: q.config.Namespace, UID: "original-pod", OwnerReferences: []meta.OwnerReference{{APIVersion: "batch/v1", Kind: "Job", Name: j.Name, UID: j.UID, Controller: ptr(true)}}},
				Spec:   core.PodSpec{Containers: []core.Container{{Name: "direct-runner"}}},
				Status: core.PodStatus{Phase: core.PodSucceeded, ContainerStatuses: []core.ContainerStatus{{Name: "direct-runner", State: core.ContainerState{Terminated: &core.ContainerStateTerminated{FinishedAt: meta.Now()}}}}}}
			k := q.client.(*fake.Clientset)
			for _, obj := range []runtime.Object{j, p} {
				if err := k.Tracker().Add(obj); err != nil {
					t.Fatal(err)
				}
			}
			if !strings.HasPrefix(kind, "missing") && kind != "secret-unavailable" {
				s := &core.Secret{ObjectMeta: meta.ObjectMeta{Name: j.Name, Namespace: q.config.Namespace, UID: "original-secret", OwnerReferences: p.OwnerReferences}, Immutable: ptr(true), Data: map[string][]byte{"run-token": []byte("original-token")}}
				if kind == "quarantined-live" {
					s.UID = "replacement-secret"
					s.OwnerReferences = nil
				}
				if kind == "secret-fingerprint-conflict" {
					s.Data["run-token"] = []byte("replacement-token")
				}
				if err := k.Tracker().Add(s); err != nil {
					t.Fatal(err)
				}
			}
			if kind == "legacy-secret-fingerprint" {
				delete(j.Annotations, queueClaimAnnotation)
				if err := k.Tracker().Update(batch.SchemeGroupVersion.WithResource("jobs"), j, q.config.Namespace); err != nil {
					t.Fatal(err)
				}
			}
			if kind == "secret-unavailable" {
				k.PrependReactor("get", "secrets", func(clienttesting.Action) (bool, runtime.Object, error) {
					return true, nil, fmt.Errorf("Secret transport unavailable")
				})
			}
			exits, proofs, releases := 0, 0, 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				if req.Header.Get("Authorization") != "Bearer original-executor-subject" {
					t.Error("retirement changed authenticated claim subject")
				}
				w.Header().Set("Content-Type", "application/json")
				if strings.HasSuffix(req.URL.Path, "/claim-status") {
					proofs++
					if req.URL.Query().Get("runner") != r.Runner || req.URL.Query().Get("claimFingerprint") != queueClaimFingerprint("original-token") {
						t.Error("proof changed original claim identity")
					}
					if kind == "missing-unavailable" || kind == "missing-foreign" {
						if kind == "missing-foreign" {
							w.WriteHeader(403)
						} else {
							w.WriteHeader(503)
						}
						return
					}
					fp := queueClaimFingerprint("original-token")
					if kind == "missing-replaced" {
						fp = queueClaimFingerprint("replacement-token")
					}
					status := "live"
					if kind == "missing-settled" {
						status = "settled"
					}
					json.NewEncoder(w).Encode(map[string]string{"runId": r.RunID, "runner": r.Runner, "claimFingerprint": fp, "status": status})
					return
				}
				if req.Method == http.MethodGet {
					json.NewEncoder(w).Encode(map[string]any{"policy": map[string]any{"poolId": "pool", "cluster": "cluster", "namespace": q.config.Namespace, "version": 1, "maxConcurrent": 2, "enforced": true, "inventoryKnown": true}, "receipts": []capacityReceipt{*r}})
					return
				}
				var x map[string]any
				if err := json.NewDecoder(req.Body).Decode(&x); err != nil {
					t.Error(err)
				}
				if strings.HasSuffix(req.URL.Path, "/exit") {
					exits++
					if r.Worker.Active || x["runner"] != r.Runner || x["claimFingerprint"] != queueClaimFingerprint("original-token") {
						t.Error("exit lacked retired original claim identity")
					}
					switch kind {
					case "exit-forbidden":
						w.WriteHeader(403)
						return
					case "exit-unknown":
						w.WriteHeader(404)
						fmt.Fprint(w, `{"message":"unknown run"}`)
						return
					case "exit-nonterminal":
						fmt.Fprint(w, `{"state":"running"}`)
						return
					}
					fmt.Fprint(w, `{"state":"lost"}`)
					return
				}
				switch x["action"] {
				case "worker-retired":
					if x["generation"] != float64(4) || x["podUid"] != string(p.UID) {
						t.Error("retirement changed original worker generation")
					}
					r.Worker.Active = false
				case "release":
					releases++
					if x["barrierUid"] != string(j.UID) || x["resourceVersion"] != j.ResourceVersion {
						t.Error("release changed original physical barrier")
					}
				}
				fmt.Fprint(w, `{"ok":true}`)
			}))
			defer server.Close()
			idToken := func() (string, error) { return "original-executor-subject", nil }
			q.capacity.consoleURL, q.capacity.idToken = server.URL, idToken
			q.capacity.registered = true
			q.exits = newRunExitReporter(server.URL, "replacement-runner", idToken, discardLogger())
			if kind != "missing-proof" {
				q.claimSettled = queueClaimStatus(server.URL, idToken)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			err = q.reconcileReceipts(ctx)
			allowed := kind == "original-secret" || kind == "legacy-secret-fingerprint" || kind == "missing-live" || kind == "missing-settled" || kind == "quarantined-live"
			if (err == nil) != allowed || (releases == 1) != allowed {
				t.Fatalf("authority result: err=%v releases=%d exits=%d proofs=%d", err, releases, exits, proofs)
			}
			if kind == "missing-settled" && exits != 0 {
				t.Fatal("already settled original claim re-settled")
			}
			if (kind == "original-secret" || kind == "legacy-secret-fingerprint" || kind == "missing-live" || kind == "quarantined-live") && exits != 1 {
				t.Fatal("original logical exit did not progress")
			}
			if !allowed && !strings.HasPrefix(kind, "exit-") && exits != 0 {
				t.Fatal("unavailable claim authority attempted logical exit")
			}
			barrier, getErr := k.BatchV1().Jobs(q.config.Namespace).Get(context.Background(), j.Name, meta.GetOptions{})
			if getErr != nil || barrier.UID != j.UID || barrier.Annotations[queueBarrierAnnotation] != r.Nonce || barrier.Spec.Suspend == nil || !*barrier.Spec.Suspend {
				t.Fatal("retirement discarded original barrier", getErr)
			}
		})
	}
}

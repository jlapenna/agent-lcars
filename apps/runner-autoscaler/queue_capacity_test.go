package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	batch "k8s.io/api/batch/v1"
	core "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	meta "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/kubernetes/fake"
	clienttesting "k8s.io/client-go/testing"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

func receiptFixture(t *testing.T) (*kubernetesQueue, *capacityReceipt, *[]map[string]any) {
	t.Helper()
	q, k := kubeQueueFixture(queueReadyNode())
	cfg := queueCapacityConfig{PoolID: "pool", Cluster: "cluster", Version: 1, WorkerAudience: "bound-worker"}
	q.config.Capacity = &cfg
	r := &capacityReceipt{capacityFence: capacityFence{PoolID: "pool", Slot: 0, Revision: 1, RunID: "work:receipt/r1", Nonce: "receipt-nonce-123456"}, Pipeline: "claude", Runner: "runner", State: "unplaced"}
	r.JobName = queueJobName(r.RunID)
	ops := &[]map[string]any{}
	var mu sync.Mutex
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		if req.Header.Get("Authorization") != "Bearer fixture-token" {
			w.WriteHeader(401)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		if req.Method == http.MethodGet {
			fmt.Fprintf(w, `{"policy":{"poolId":"pool","cluster":"cluster","namespace":"lcars-work","version":1,"maxConcurrent":2,"enforced":true,"inventoryKnown":true},"receipts":[]}`)
			return
		}
		var x map[string]any
		json.NewDecoder(req.Body).Decode(&x)
		*ops = append(*ops, x)
		fmt.Fprint(w, `{"ok":true}`)
	}))
	t.Cleanup(s.Close)
	q.capacity = &queueCapacityClient{config: cfg, namespace: q.config.Namespace, maxConcurrent: 2, consoleURL: s.URL, producerID: "producer", idToken: func() (string, error) { return "fixture-token", nil }}
	k.PrependReactor("create", "jobs", func(a clienttesting.Action) (bool, runtime.Object, error) {
		j := a.(clienttesting.CreateAction).GetObject().(*batch.Job)
		j.ResourceVersion = "1"
		return false, nil, nil
	})
	k.PrependReactor("create", "secrets", func(a clienttesting.Action) (bool, runtime.Object, error) {
		s := a.(clienttesting.CreateAction).GetObject().(*core.Secret)
		s.UID = "secret-uid"
		return false, nil, nil
	})
	return q, r, ops
}
func TestReceiptLaunchRecordsAndFencesEachWrite(t *testing.T) {
	q, r, ops := receiptFixture(t)
	if err := q.launchReceipt(context.Background(), directRunnerLaunch{runID: r.RunID, runToken: "sensitive-run-token", pipeline: r.Pipeline, runner: r.Runner, consoleURL: q.capacity.consoleURL, receipt: &r.capacityFence}); err != nil {
		t.Fatal(err)
	}
	j, err := q.client.BatchV1().Jobs(q.config.Namespace).Get(context.Background(), r.JobName, meta.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if j.Spec.Suspend == nil || *j.Spec.Suspend || j.Spec.TTLSecondsAfterFinished != nil || j.Spec.Template.Annotations[queueJobUIDAnnotation] != string(j.UID) {
		t.Fatal("receipt Job not safely activated")
	}
	pending, resolved := 0, 0
	for _, x := range *ops {
		if x["action"] == "operation" {
			if x["resolved"] == true {
				resolved++
			} else {
				pending++
			}
		}
	}
	if pending != 3 || resolved != 3 {
		t.Fatalf("writes pending=%d resolved=%d", pending, resolved)
	}
	b, _ := json.Marshal(ops)
	if containsBytes(b, []byte("sensitive-run-token")) {
		t.Fatal("run token leaked into capacity commands")
	}
}
func containsBytes(x, y []byte) bool {
	for i := 0; i+len(y) <= len(x); i++ {
		if string(x[i:i+len(y)]) == string(y) {
			return true
		}
	}
	return false
}
func TestReceiptUnknownWriteCannotAcknowledgeQuiescence(t *testing.T) {
	q, r, ops := receiptFixture(t)
	err := q.capacity.write(context.Background(), *r, "recovery-nonce-123456", func() error { return io.EOF })
	if err == nil || len(*ops) != 1 || (*ops)[0]["resolved"] != false {
		t.Fatal("ambiguous RPC was falsely drained")
	}
}
func TestReceiptDefinitiveRejectionResolvesOnlyItsOperation(t *testing.T) {
	for _, err := range []error{apierrors.NewAlreadyExists(batch.Resource("jobs"), "job"), apierrors.NewConflict(batch.Resource("jobs"), "job", errors.New("RV")), apierrors.NewForbidden(batch.Resource("jobs"), "job", errors.New("denied"))} {
		q, r, ops := receiptFixture(t)
		if got := q.capacity.write(context.Background(), *r, "recovery-nonce-123456", func() error { return err }); got == nil {
			t.Fatal("lost rejection")
		}
		if len(*ops) != 2 || (*ops)[0]["operationId"] != (*ops)[1]["operationId"] || (*ops)[1]["resolved"] != true {
			t.Fatal("definitive response did not settle exact write")
		}
	}
}
func TestReceiptResumeRejectsReplacementAndStaleBarrier(t *testing.T) {
	for _, kind := range []string{"replacement", "retirement", "executed", "generation", "foreign-secret", "duplicate-pod"} {
		t.Run(kind, func(t *testing.T) {
			q, r, _ := receiptFixture(t)
			j, _ := q.job(directRunnerLaunch{runID: r.RunID, pipeline: r.Pipeline, runner: r.Runner, receipt: &r.capacityFence})
			j.UID = "original"
			j.ResourceVersion = "1"
			j.Generation = 1
			r.JobUID = "original"
			s := &core.Secret{ObjectMeta: meta.ObjectMeta{Name: j.Name, Namespace: q.config.Namespace, UID: "secret", OwnerReferences: []meta.OwnerReference{{APIVersion: "batch/v1", Kind: "Job", Name: j.Name, UID: j.UID, Controller: ptr(true)}}}, Immutable: ptr(true), Data: map[string][]byte{"run-token": []byte("token")}}
			r.SecretUID = "secret"
			original := j.DeepCopy()
			switch kind {
			case "replacement":
				j.UID = "replacement"
			case "retirement":
				j.Annotations[queueBarrierAnnotation] = r.Nonce
			case "executed":
				j.Status.Active = 1
			case "generation":
				j.Generation = 2
			case "foreign-secret":
				s.OwnerReferences[0].UID = "other"
			case "duplicate-pod":
				q.client.CoreV1().Pods(q.config.Namespace).Create(context.Background(), &core.Pod{ObjectMeta: meta.ObjectMeta{Name: "pod", OwnerReferences: s.OwnerReferences}}, meta.CreateOptions{})
			}
			if err := q.client.(*fake.Clientset).Tracker().Add(j); err != nil {
				t.Fatal(err)
			}
			if err := q.client.(*fake.Clientset).Tracker().Add(s); err != nil {
				t.Fatal(err)
			}
			before := len(q.client.(*fake.Clientset).Actions())
			_ = q.resumeReceipt(context.Background(), *r, "recovery-nonce-123456", original, s)
			for _, a := range q.client.(*fake.Clientset).Actions()[before:] {
				if a.GetVerb() == "update" && a.GetResource().Resource == "jobs" {
					t.Fatal("unsafe unsuspend emitted")
				}
			}
		})
	}
}

func TestReceiptClaimResponseLossReplaysExactRequest(t *testing.T) {
	var requests []string
	calls := 0
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			fmt.Fprint(w, `{"policy":{"poolId":"pool","cluster":"cluster","namespace":"ns","version":1,"maxConcurrent":1,"enforced":true,"inventoryKnown":true},"receipts":[]}`)
			return
		}
		var x map[string]any
		json.NewDecoder(r.Body).Decode(&x)
		if x["action"] == "register" {
			fmt.Fprint(w, `{"ok":true}`)
			return
		}
		requests = append(requests, x["claimRequestId"].(string))
		calls++
		if calls == 1 {
			conn, _, _ := w.(http.Hijacker).Hijack()
			conn.Close()
			return
		}
		fmt.Fprintf(w, `{"kind":"quarantined-unrecoverable-token","runId":"work:lost/r1","jobName":%q,"receipt":{"poolId":"pool","slot":0,"revision":1,"runId":"work:lost/r1","nonce":"receipt-nonce-123456"}}`, queueJobName("work:lost/r1"))
	}))
	defer s.Close()
	c := &queueCapacityClient{config: queueCapacityConfig{PoolID: "pool", Cluster: "cluster", Version: 1}, namespace: "ns", maxConcurrent: 1, consoleURL: s.URL, producerID: "incarnation", idToken: func() (string, error) { return "token", nil }}
	if _, err := c.claim(context.Background(), "runner"); err == nil {
		t.Fatal("lost response incorrectly accepted")
	}
	if x, err := c.claim(context.Background(), "runner"); err != nil || x.Kind != "quarantined-unrecoverable-token" {
		t.Fatalf("replay=%+v error=%v", x, err)
	}
	if len(requests) != 2 || requests[0] == "" || requests[0] != requests[1] {
		t.Fatal("response loss claimed under a different request")
	}
}
func TestReceiptPolicyMismatchBlocksClaimBeforeLaunch(t *testing.T) {
	for _, field := range []string{"poolId", "cluster", "namespace", "version", "maxConcurrent", "enforced", "inventoryKnown"} {
		t.Run(field, func(t *testing.T) {
			claims := 0
			p := map[string]any{"poolId": "pool", "cluster": "cluster", "namespace": "ns", "version": 1, "maxConcurrent": 1, "enforced": true, "inventoryKnown": true}
			switch field {
			case "version", "maxConcurrent":
				p[field] = 2
			case "enforced", "inventoryKnown":
				p[field] = false
			default:
				p[field] = "foreign"
			}
			s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodGet {
					claims++
				}
				json.NewEncoder(w).Encode(map[string]any{"policy": p, "receipts": []any{}})
			}))
			defer s.Close()
			c := &queueCapacityClient{config: queueCapacityConfig{PoolID: "pool", Cluster: "cluster", Version: 1}, namespace: "ns", maxConcurrent: 1, consoleURL: s.URL, idToken: func() (string, error) { return "token", nil }}
			if _, err := c.claim(context.Background(), "runner"); err == nil || claims != 0 {
				t.Fatal("mismatched server contract dispatched a claim")
			}
		})
	}
}
func TestReceiptPhysicalRetirementRequiresAllOwnedWorkersEnded(t *testing.T) {
	for _, kind := range []string{"never-started", "active", "completed-live-pod", "completed-terminal-pod", "completed-no-pod", "terminating-pod"} {
		t.Run(kind, func(t *testing.T) {
			j := &batch.Job{ObjectMeta: meta.ObjectMeta{Name: "job", UID: "job-uid", Generation: 1}, Spec: batch.JobSpec{Suspend: ptr(true)}}
			p := core.Pod{ObjectMeta: meta.ObjectMeta{Name: "worker", UID: "pod", OwnerReferences: []meta.OwnerReference{{APIVersion: "batch/v1", Kind: "Job", Name: j.Name, UID: j.UID, Controller: ptr(true)}}}, Spec: core.PodSpec{Containers: []core.Container{{Name: "runner"}}}, Status: core.PodStatus{Phase: core.PodRunning, ContainerStatuses: []core.ContainerStatus{{Name: "runner", State: core.ContainerState{Running: &core.ContainerStateRunning{}}}}}}
			var pods []core.Pod
			if kind != "never-started" {
				j.Generation = 2
				j.Spec.Suspend = ptr(false)
				j.Status.Active = 1
				pods = []core.Pod{p}
			}
			if kind == "completed-no-pod" {
				pods = nil
			}
			if kind == "completed-live-pod" || kind == "completed-terminal-pod" || kind == "completed-no-pod" || kind == "terminating-pod" {
				j.Status.Active = 0
				j.Status.Conditions = []batch.JobCondition{{Type: batch.JobComplete, Status: core.ConditionTrue}}
			}
			if kind == "completed-terminal-pod" || kind == "terminating-pod" {
				pods[0].Status.Phase = core.PodSucceeded
				pods[0].Status.ContainerStatuses[0].State = core.ContainerState{Terminated: &core.ContainerStateTerminated{FinishedAt: meta.Now()}}
			}
			if kind == "terminating-pod" {
				at := meta.Now()
				pods[0].DeletionTimestamp = &at
			}
			ended, never := physicalReceiptWorkersEnded(j, pods)
			if ended != (kind == "never-started" || kind == "completed-terminal-pod") || never != (kind == "never-started") {
				t.Fatalf("physical=%v never=%v", ended, never)
			}
		})
	}
}

func TestReceiptLateCreateAfterGet404CannotCrossNameBarrier(t *testing.T) {
	q, r, ops := receiptFixture(t)
	k := q.client.(*fake.Clientset)
	var delayed *batch.Job
	first := true
	k.PrependReactor("create", "jobs", func(a clienttesting.Action) (bool, runtime.Object, error) {
		if first {
			first = false
			delayed = a.(clienttesting.CreateAction).GetObject().(*batch.Job).DeepCopy()
			return true, nil, io.EOF
		}
		return false, nil, nil
	})
	if err := q.launchReceipt(context.Background(), directRunnerLaunch{runID: r.RunID, runToken: "lost-token", pipeline: r.Pipeline, runner: r.Runner, receipt: &r.capacityFence}); err == nil {
		t.Fatal("ambiguous Create/GET404 treated as no worker")
	}
	if len(*ops) < 2 || (*ops)[len(*ops)-1]["resolved"] != false {
		t.Fatal("late create debt lost")
	}
	j, err := q.installAbsentBarrier(context.Background(), *r)
	if err != nil {
		t.Fatal(err)
	}
	if j.Spec.Suspend == nil || !*j.Spec.Suspend || j.Spec.TTLSecondsAfterFinished != nil || len(j.Spec.Template.Spec.Volumes) != 0 || len(j.Spec.Template.Spec.Containers[0].Env) != 0 || j.Spec.Template.Spec.Containers[0].Command[0] != "/bin/false" {
		t.Fatal("barrier can execute a credentialed provider")
	}
	if _, err = k.BatchV1().Jobs(q.config.Namespace).Create(context.Background(), delayed, meta.CreateOptions{}); !apierrors.IsAlreadyExists(err) {
		t.Fatal("late original Create crossed deterministic name barrier")
	}
}
func TestReceiptServerRetirementRequiredToExemptBarrier(t *testing.T) {
	q, r, _ := receiptFixture(t)
	j, err := q.installAbsentBarrier(context.Background(), *r)
	if err != nil {
		t.Fatal(err)
	}
	if err = q.verifyRetiredBarrier(context.Background(), j); err == nil {
		t.Fatal("a barrier label bypassed server retirement")
	}
	verifications := 0
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		verifications++
		json.NewEncoder(w).Encode(map[string]any{"ok": true, "retirement": map[string]any{"runId": r.RunID, "nonce": r.Nonce, "jobName": j.Name, "released": true, "retainBarrier": true, "barrier": map[string]string{"uid": string(j.UID), "resourceVersion": j.ResourceVersion}}})
	}))
	defer s.Close()
	q.capacity.consoleURL = s.URL
	if err = q.verifyRetiredBarrier(context.Background(), j); err != nil {
		t.Fatal("exact server-retired barrier remains unavailable", err)
	}
	var checks sync.WaitGroup
	failures := make(chan error, 100)
	for i := 0; i < 100; i++ {
		checks.Add(1)
		go func() {
			defer checks.Done()
			if e := q.verifyRetiredBarrier(context.Background(), j); e != nil {
				failures <- e
			}
		}()
	}
	checks.Wait()
	close(failures)
	for e := range failures {
		t.Fatal(e)
	}

	if verifications != 1 {
		t.Fatalf("unchanged barriers repeated remote verification: %d", verifications)
	}
	changed := j.DeepCopy()
	changed.ResourceVersion = "2"
	if err = q.verifyRetiredBarrier(context.Background(), changed); err != nil {
		t.Fatal(err)
	}
	if verifications != 2 {
		t.Fatal("changed object bypassed authenticated verification")
	}
	replacement := j.DeepCopy()
	replacement.UID = "replacement"
	if err = q.verifyRetiredBarrier(context.Background(), replacement); err == nil {
		t.Fatal("replacement tombstone UID was adopted")
	}
}

func TestReceiptHealthRejectsUnknownPhysicalInventory(t *testing.T) {
	for _, kind := range []string{"jobs-list-failed", "unrecognized-job", "pods-list-failed"} {
		t.Run(kind, func(t *testing.T) {
			q, _, _ := receiptFixture(t)
			ready := false
			q.capacity.available = func(v bool) { ready = v }
			k := q.client.(*fake.Clientset)
			switch kind {
			case "jobs-list-failed":
				k.PrependReactor("list", "jobs", func(clienttesting.Action) (bool, runtime.Object, error) { return true, nil, io.EOF })
			case "unrecognized-job":
				if err := k.Tracker().Add(&batch.Job{ObjectMeta: meta.ObjectMeta{Name: "unknown", Namespace: q.config.Namespace, Labels: map[string]string{queueJobLabel: "true"}}}); err != nil {
					t.Fatal(err)
				}
			case "pods-list-failed":
				k.PrependReactor("list", "pods", func(clienttesting.Action) (bool, runtime.Object, error) { return true, nil, io.EOF })
			}
			var err error
			if kind == "pods-list-failed" {
				err = q.reconcileReceipts(context.Background())
			} else {
				err = q.validateReceiptInventory(context.Background())
			}
			if err == nil {
				t.Fatal("probe did not reach refused physical inventory")
			}
			if ready {
				t.Fatalf("receipt readiness stayed true after %s; physical inventory error=%v", kind, err)
			}
		})
	}
}

func TestReceiptStopReplyLossCannotStrandIncarnation(t *testing.T) {
	testReceiptStopReplyRecovery(t, true)
}

func TestReceiptStopReplyRecoveryEmptyQueue(t *testing.T) {
	testReceiptStopReplyRecovery(t, false)
}

func testReceiptStopReplyRecovery(t *testing.T, admit bool) {
	t.Helper()
	for _, kind := range []string{"healthy", "lost-reply", "lost-reply-receipt-already-released"} {
		t.Run(kind, func(t *testing.T) {
			q, r, _ := receiptFixture(t)
			q.claimSettled = func(context.Context, string, string, string) (bool, error) { return true, nil }
			old := q.capacity.producerID
			oldRequest := ""
			nextFence := capacityFence{PoolID: "pool", Slot: 0, Revision: 2, RunID: "work:after-stop/r1", Nonce: "next-receipt-nonce-123456"}
			next := capacityClaimReply{Kind: "claim", RunID: nextFence.RunID, JobName: queueJobName(nextFence.RunID), Receipt: &nextFence, Pipeline: "codex", Token: "next-run-token"}
			q.capacity.registered = true
			r.Producers = []capacityProducer{{ProducerID: old, Subject: "subject", PendingWrites: []string{}}}
			j, _ := q.job(directRunnerLaunch{runID: r.RunID, runToken: "original-token", pipeline: r.Pipeline, runner: r.Runner, receipt: &r.capacityFence})
			j.UID = "original-job"
			j.ResourceVersion = "1"
			j.Generation = 1
			r.JobUID = string(j.UID)
			if err := q.client.(*fake.Clientset).Tracker().Add(j); err != nil {
				t.Fatal(err)
			}
			var mu sync.Mutex
			stopped := false
			released := false
			stopCalls, registerCalls, claimCalls := 0, 0, 0
			registeredProducer := ""
			s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				mu.Lock()
				defer mu.Unlock()
				if req.Header.Get("Authorization") != "Bearer fixture-token" {
					t.Error("unauthenticated recovery request")
					w.WriteHeader(http.StatusUnauthorized)
					return
				}
				w.Header().Set("Content-Type", "application/json")
				if req.Method == http.MethodGet {
					receipts := []capacityReceipt{}
					if !released {
						receipts = append(receipts, *r)
					}
					json.NewEncoder(w).Encode(map[string]any{"policy": map[string]any{"poolId": "pool", "cluster": "cluster", "namespace": q.config.Namespace, "version": 1, "maxConcurrent": 2, "enforced": true, "inventoryKnown": true}, "receipts": receipts})
					return
				}
				var x map[string]any
				json.NewDecoder(req.Body).Decode(&x)
				switch x["action"] {
				case "register":
					registerCalls++
					registeredProducer, _ = x["producerId"].(string)
					if !stopped || registeredProducer == "" {
						t.Error("registered before durable closure")
					}
					if x["producerId"] == old {
						t.Error("reregistered stopped identity")
					}
				case "inspect-producer":
					json.NewEncoder(w).Encode(map[string]any{"ok": true, "producer": capacityProducerStatus{PoolID: "pool", ProducerID: old, Subject: "subject", Closed: stopped}})
					return
				case "inspect-retired":
					json.NewEncoder(w).Encode(map[string]any{"ok": true, "retirement": map[string]any{"runId": r.RunID, "nonce": r.Nonce, "jobName": r.JobName, "released": released, "retainBarrier": false, "barrier": map[string]string{"uid": r.JobUID, "resourceVersion": "1"}}})
					return
				case "stop-producer":
					stopCalls++
					stopped = true
					r.Producers[0].Stopped = true
					if kind != "healthy" {
						conn, _, _ := w.(http.Hijacker).Hijack()
						conn.Close()
						return
					}
				case "retire":
					r.State = "retiring"
				case "release":
					released = true
				}
				if req.URL.Path == "/api/work/v1/runs/claim" {
					if !stopped {
						if oldRequest != "" || x["producerId"] != old {
							t.Error("unexpected pre-recovery claim")
						}
						oldRequest, _ = x["claimRequestId"].(string)
						fmt.Fprint(w, `{"kind":"wait","reason":"queue"}`)
						return
					}
					claimCalls++
					if stopped && x["producerId"] == old {
						w.WriteHeader(409)
						fmt.Fprint(w, `{"error":"closed producer"}`)
						return
					}
					requestID, _ := x["claimRequestId"].(string)
					if !released || registerCalls != 1 || x["producerId"] != registeredProducer || requestID == "" || requestID == oldRequest || x["runner"] != "runner" || x["capacityVersion"] != float64(1) {
						t.Error("claim lacked fresh registered producer/request identity")
					}
					if admit {
						json.NewEncoder(w).Encode(next)
					} else {
						fmt.Fprint(w, `{"kind":"wait","reason":"queue"}`)
					}
					return
				}
				fmt.Fprint(w, `{"ok":true}`)
			}))
			defer s.Close()
			q.capacity.consoleURL = s.URL
			// Settle a real request under the old incarnation so the post-recovery
			// request must differ from an observed identity, not a dummy sentinel.
			initialReply, err := q.capacity.claim(context.Background(), "runner")
			mu.Lock()
			observedOldRequest := oldRequest
			mu.Unlock()
			if err != nil || initialReply.Kind != "wait" || observedOldRequest == "" {
				t.Fatal("pre-recovery request did not settle", err)
			}
			firstErr := q.reconcileReceipts(context.Background())
			if (firstErr == nil) != (kind == "healthy") {
				t.Fatalf("stop schedule not exercised: kind=%s error=%v", kind, firstErr)
			}
			mu.Lock()
			observedStopped := stopped
			mu.Unlock()
			if !observedStopped {
				t.Fatal("server did not durably close incarnation")
			}
			if kind == "lost-reply-receipt-already-released" {
				// Another recovery owner finishes the physical retirement before this
				// process can observe the stopped producer on an active receipt.
				if err := q.retireReceipt(context.Background(), *r, "other-recovery-nonce-123456", j, nil); err != nil {
					t.Fatal("physical retirement setup", err)
				}
			}
			if err := q.reconcileReceipts(context.Background()); err != nil {
				t.Fatal("known stopped receipt could not retire", err)
			}
			mu.Lock()
			observedReleased := released
			mu.Unlock()
			if !observedReleased {
				t.Fatal("fixture receipt not physically released")
			}
			reply, err := q.capacity.claim(context.Background(), "runner")
			if err != nil {
				t.Fatalf("durably stopped incarnation stranded subsequent claim after successful reconciliation: producer=%s unchanged=%v error=%v", q.capacity.producerID, q.capacity.producerID == old, err)
			}

			if admit {
				if reply.Kind != "claim" {
					t.Fatalf("post-recovery admission: kind=%q, want claim", reply.Kind)
				}
				if reply.RunID != next.RunID || reply.RunID == r.RunID || reply.JobName != next.JobName || reply.Receipt == nil || *reply.Receipt != nextFence || reply.Token != next.Token || reply.Pipeline != next.Pipeline {
					t.Fatal("admitted claim lost the distinct Run, exact receipt fence or credential/pipeline")
				}
				if err := q.launchReceipt(context.Background(), directRunnerLaunch{runID: reply.RunID, runToken: reply.Token, pipeline: reply.Pipeline, runner: "runner", consoleURL: s.URL, receipt: reply.Receipt}); err != nil {
					t.Fatal("admitted worker launch", err)
				}
				job, err := q.client.BatchV1().Jobs(q.config.Namespace).Get(context.Background(), reply.JobName, meta.GetOptions{})
				if err != nil || job.Spec.Suspend == nil || *job.Spec.Suspend {
					t.Fatal("admitted worker Job was not activated", err)
				}
				secret, err := q.client.CoreV1().Secrets(q.config.Namespace).Get(context.Background(), reply.JobName, meta.GetOptions{})
				if err != nil || string(secret.Data["run-token"]) != reply.Token {
					t.Fatal("admitted worker credential was not delivered", err)
				}
			} else if reply.Kind != "wait" || reply.Reason != "queue" || reply.Receipt != nil || reply.Token != "" {
				t.Fatal("empty queue did not remain a non-admission wait")
			}
			jobCreates, secretCreates := 0, 0
			for _, action := range q.client.(*fake.Clientset).Actions() {
				if action.GetVerb() == "create" {
					switch action.GetResource().Resource {
					case "jobs":
						jobCreates++
					case "secrets":
						secretCreates++
					}
				}
			}
			wantCreates := 0
			if admit {
				wantCreates = 1
			}
			if jobCreates != wantCreates || secretCreates != wantCreates || q.capacity.requestID != "" {
				t.Fatalf("duplicate launch or unresolved claim: jobs=%d secrets=%d request=%q", jobCreates, secretCreates, q.capacity.requestID)
			}

			mu.Lock()
			observedStops, observedRegisters, observedClaims := stopCalls, registerCalls, claimCalls
			mu.Unlock()
			if observedStops != 1 || observedRegisters != 1 || observedClaims != 1 || q.capacity.producerID == old {
				t.Fatalf("closure repeated a write or stranded progress: stops=%d registers=%d claims=%d", observedStops, observedRegisters, observedClaims)
			}
		})
	}
}

func TestReceiptReadinessRequiresCompleteInventoryAndRecovers(t *testing.T) {
	q, _, _ := receiptFixture(t)
	ready := false
	q.capacity.available = func(v bool) { ready = v }
	if _, err := q.capacity.inventory(context.Background()); err != nil {
		t.Fatal(err)
	}
	if ready {
		t.Fatal("application response alone published healthy")
	}
	k := q.client.(*fake.Clientset)
	failed := true
	k.PrependReactor("list", "pods", func(clienttesting.Action) (bool, runtime.Object, error) {
		if failed {
			return true, nil, io.EOF
		}
		return false, nil, nil
	})
	if err := q.validateReceiptInventory(context.Background()); err == nil || ready {
		t.Fatal("unreadable Pods inventory stayed healthy")
	}
	failed = false
	if err := q.validateReceiptInventory(context.Background()); err != nil || !ready {
		t.Fatal("fully valid inventory did not restore health", err)
	}
	failed = true
	if err := q.reconcileReceipts(context.Background()); err == nil || ready {
		t.Fatal("failed recovery did not clear existing health")
	}
	failed = false
	if err := q.reconcileReceipts(context.Background()); err != nil || !ready {
		t.Fatal("successful recovery did not restore health", err)
	}
	// Existing singleton path has no capacity/readiness projection attached.
	legacy, _ := kubeQueueFixture(queueReadyNode())
	if reservation, err := legacy.reserve(context.Background()); err != nil || reservation == nil {
		t.Fatal("legacy singleton reserve regressed", err)
	} else {
		reservation.release()
	}
}
func TestReceiptClosedIncarnationAfterReceiptGone(t *testing.T) {
	for _, kind := range []string{"closed", "unknown", "open", "foreign-pool", "foreign-subject", "foreign-producer", "pending-write", "pending-request"} {
		t.Run(kind, func(t *testing.T) {
			q, _, _ := receiptFixture(t)
			c := q.capacity
			old := c.producerID
			c.registered = true
			c.stopping = &capacityStopAttempt{ProducerID: old, Subject: "subject"}
			registrations, claims := 0, 0
			status := &capacityProducerStatus{PoolID: "pool", ProducerID: old, Subject: "subject", Closed: true}
			switch kind {
			case "unknown":
				status = nil
			case "open":
				status.Closed = false
			case "foreign-pool":
				status.PoolID = "foreign"
			case "foreign-subject":
				status.Subject = "foreign"
			case "foreign-producer":
				status.ProducerID = "foreign"
			case "pending-request":
				c.requestID = "exact-ambiguous-claim-request"
			}
			inv := capacityInventory{}
			if kind == "pending-write" {
				inv.Receipts = []capacityReceipt{{Producers: []capacityProducer{{ProducerID: old, Subject: "subject", Stopped: true, PendingWrites: []string{"unknown-create"}}}}}
			}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				var x map[string]any
				if req.Method == http.MethodGet {
					fmt.Fprint(w, `{"policy":{"poolId":"pool","cluster":"cluster","namespace":"lcars-work","version":1,"maxConcurrent":2,"enforced":true,"inventoryKnown":true},"receipts":[]}`)
					return
				}
				json.NewDecoder(req.Body).Decode(&x)
				switch x["action"] {
				case "inspect-producer":
					json.NewEncoder(w).Encode(map[string]any{"ok": true, "producer": status})
					return
				case "register":
					registrations++
					if x["producerId"] == old {
						t.Error("reregistered closed producer")
					}
				}
				if req.URL.Path == "/api/work/v1/runs/claim" {
					claims++
					if x["producerId"] == old {
						t.Error("claimed with closed producer")
					}
					fmt.Fprint(w, `{"kind":"wait","reason":"queue"}`)
					return
				}
				fmt.Fprint(w, `{"ok":true}`)
			}))
			defer server.Close()
			c.consoleURL = server.URL
			err := c.reconcileProducer(context.Background(), inv)
			if kind != "closed" {
				if err == nil || c.producerID != old || registrations != 0 || claims != 0 {
					t.Fatalf("unsafe rotation on %s: %v", kind, err)
				}
				if kind == "pending-request" && c.requestID != "exact-ambiguous-claim-request" {
					t.Fatal("ambiguous request identity discarded")
				}
				return
			}
			if err != nil || c.producerID == old || c.registered || c.stopping != nil {
				t.Fatal("authenticated durable closure did not rotate after receipt gone", err)
			}
			if _, err = c.claim(context.Background(), "runner"); err != nil || registrations != 1 || claims != 1 {
				t.Fatalf("new producer did not register before next claim: registers=%d claims=%d err=%v", registrations, claims, err)
			}
		})
	}
}

// Required Verify's Go suite consumes this composition regression: a retained
// physical barrier must not strand exact logical exit and credential cleanup.
func TestReceiptRetainedBarrierRetriesOriginalClaimExit(t *testing.T) {
	for _, kind := range []string{"logical-conflict", "logical-transport", "release-refused"} {
		t.Run(kind, func(t *testing.T) {
			q, r, _ := receiptFixture(t)
			r.State = "retiring"
			r.Producers = []capacityProducer{{ProducerID: "original-producer", Subject: "original-subject", Stopped: true}}
			j, err := q.job(directRunnerLaunch{runID: r.RunID, runToken: "original-token", pipeline: r.Pipeline, runner: r.Runner, receipt: &r.capacityFence})
			if err != nil {
				t.Fatal(err)
			}
			j.UID = "original-job-uid"
			j.ResourceVersion = "1"
			j.Generation = 2
			j.Spec.Suspend = ptr(false)
			j.Status.Conditions = []batch.JobCondition{{Type: batch.JobComplete, Status: core.ConditionTrue}}
			r.JobUID = string(j.UID)
			r.Worker = &capacityWorker{Generation: 1, JobUID: r.JobUID, PodUID: "original-pod-uid", Active: true}
			pod := &core.Pod{ObjectMeta: meta.ObjectMeta{Name: "original-pod", Namespace: q.config.Namespace, UID: "original-pod-uid", OwnerReferences: []meta.OwnerReference{{APIVersion: "batch/v1", Kind: "Job", Name: j.Name, UID: j.UID, Controller: ptr(true)}}}, Spec: core.PodSpec{Containers: []core.Container{{Name: "direct-runner"}}}, Status: core.PodStatus{Phase: core.PodSucceeded, ContainerStatuses: []core.ContainerStatus{{Name: "direct-runner", State: core.ContainerState{Terminated: &core.ContainerStateTerminated{ExitCode: 0, FinishedAt: meta.Now()}}}}}}
			k := q.client.(*fake.Clientset)
			if err = k.Tracker().Add(j); err != nil {
				t.Fatal(err)
			}
			if err = k.Tracker().Add(pod); err != nil {
				t.Fatal(err)
			}
			secret := &core.Secret{ObjectMeta: meta.ObjectMeta{Name: j.Name, Namespace: q.config.Namespace, UID: "original-secret", OwnerReferences: pod.OwnerReferences}, Immutable: ptr(true), Data: map[string][]byte{"run-token": []byte("original-token")}}
			r.SecretUID = string(secret.UID)
			if err := k.Tracker().Add(secret); err != nil {
				t.Fatal(err)
			}
			var mu sync.Mutex
			exits, releases := 0, 0
			released, cleaned := false, false
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				mu.Lock()
				defer mu.Unlock()
				w.Header().Set("Content-Type", "application/json")
				if req.Method == http.MethodGet {
					receipts := []capacityReceipt{*r}
					if released {
						receipts = []capacityReceipt{}
					}
					json.NewEncoder(w).Encode(map[string]any{"policy": map[string]any{"poolId": "pool", "cluster": "cluster", "namespace": q.config.Namespace, "version": 1, "maxConcurrent": 2, "enforced": true, "inventoryKnown": true}, "receipts": receipts})
					return
				}
				var x map[string]any
				if err := json.NewDecoder(req.Body).Decode(&x); err != nil {
					t.Error(err)
					w.WriteHeader(400)
					return
				}
				if strings.HasSuffix(req.URL.Path, "/exit") {
					exits++
					if r.Worker.Active || x["runner"] != r.Runner || x["claimFingerprint"] != queueClaimFingerprint("original-token") {
						t.Error("exit changed original claim or preceded worker retirement")
					}
					if exits == 1 && kind != "release-refused" {
						if kind == "logical-transport" {
							conn, _, _ := w.(http.Hijacker).Hijack()
							conn.Close()
						} else {
							w.WriteHeader(409)
						}
						return
					}
					cleaned = true
					fmt.Fprint(w, `{"state":"lost"}`)
					return
				}
				switch x["action"] {
				case "inspect-retired":
					json.NewEncoder(w).Encode(map[string]any{"ok": true, "retirement": map[string]any{"runId": r.RunID, "nonce": r.Nonce, "jobName": r.JobName, "released": released, "barrier": map[string]string{"uid": r.JobUID, "resourceVersion": "1"}}})
					return
				case "worker-retired":
					r.Worker.Active = false
				case "release":
					releases++
					if !cleaned {
						t.Error("physical release preceded logical settlement")
					}
					if kind == "release-refused" && releases == 1 {
						w.WriteHeader(409)
						return
					}
					released = true
				}
				fmt.Fprint(w, `{"ok":true}`)
			}))
			defer server.Close()
			q.capacity.consoleURL = server.URL
			q.exits = testExitReporter(server.URL)
			err = q.reconcileReceipts(context.Background())
			if err == nil {
				t.Fatal("initial refusal schedule not exercised")
			}
			if kind != "release-refused" && releases != 0 {
				t.Fatal("logical refusal attempted final release")
			}
			q.exits.wg.Wait()
			barrier, err := q.client.BatchV1().Jobs(q.config.Namespace).Get(context.Background(), j.Name, meta.GetOptions{})
			if err != nil || barrier.Annotations[queueBarrierAnnotation] != r.Nonce || barrier.UID != j.UID {
				t.Fatal("release refusal discarded original barrier", err)
			}
			for i := 0; i < 3; i++ {
				_ = q.reconcileReceipts(context.Background())
				q.exits.wg.Wait()
				mu.Lock()
				done := released
				mu.Unlock()
				if done {
					break
				}
			}
			mu.Lock()
			defer mu.Unlock()
			if !released || !cleaned || exits < 2 || releases < 1 || (kind == "release-refused" && releases < 2) {
				t.Fatalf("retained barrier stranded cleanup: released=%v cleaned=%v exits=%d releases=%d", released, cleaned, exits, releases)
			}
		})
	}
}

func TestReceiptRecoveryReplaysActiveLeaseAfterLostReplyAndRestart(t *testing.T) {
	q, r, _ := receiptFixture(t)
	var mu sync.Mutex
	original := ""
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		var x map[string]any
		json.NewDecoder(req.Body).Decode(&x)
		calls++
		nonce, _ := x["recoveryNonce"].(string)
		if original == "" {
			original = nonce
		}
		if nonce != original {
			w.WriteHeader(409)
			return
		}
		if calls == 1 {
			conn, _, _ := w.(http.Hijacker).Hijack()
			conn.Close()
			return
		}
		fmt.Fprint(w, `{"ok":true}`)
	}))
	defer server.Close()
	q.capacity.consoleURL = server.URL
	first, err := q.capacity.recovery(context.Background(), *r, "recover")
	if err == nil {
		t.Fatal("lost acquisition reply not injected")
	}
	second, err := q.capacity.recovery(context.Background(), *r, "retire")
	if err != nil || second != first {
		t.Fatal("active lease nonce rotated after lost reply", err)
	}
	// Durable authenticated inventory, rather than a process-local cache,
	// preserves the lease acquired by the original controller incarnation.
	if err := json.Unmarshal([]byte(fmt.Sprintf(`{"nonce":%q}`, first)), &r.Recovery); err != nil {
		t.Fatal(err)
	}
	q.capacity.producerID = "restarted-controller"
	third, err := q.capacity.recovery(context.Background(), *r, "recover")
	if err != nil || third != first {
		t.Fatal("restart discarded durable recovery identity", err)
	}
}

func TestReceiptProducerRotationPreservesConcurrentUsefulWork(t *testing.T) {
	for _, kind := range []string{"suspended-owned-secret", "started-awaiting-attestation"} {
		t.Run(kind, func(t *testing.T) {
			q, finished, _ := receiptFixture(t)
			q.claimSettled = func(_ context.Context, runID, runner, fingerprint string) (bool, error) {
				if runID != finished.RunID || runner != finished.Runner || fingerprint != queueClaimFingerprint("finished-token") {
					t.Error("retirement proof changed finished claim")
				}
				return true, nil
			}
			originalProducer := q.capacity.producerID
			q.capacity.registered = true
			finished.Producers = []capacityProducer{{ProducerID: originalProducer, Subject: "subject"}}
			target := *finished
			target.RunID = "work:concurrent/r1"
			target.Slot = 1
			target.Nonce = "target-receipt-nonce-123456"
			target.JobName = queueJobName(target.RunID)
			finishedJob, err := q.job(directRunnerLaunch{runID: finished.RunID, runToken: "finished-token", pipeline: finished.Pipeline, runner: finished.Runner, receipt: &finished.capacityFence})
			if err != nil {
				t.Fatal(err)
			}
			finishedJob.UID = "finished-job"
			finishedJob.ResourceVersion = "1"
			finishedJob.Generation = 2
			finishedJob.Spec.Suspend = ptr(false)
			finishedJob.Status.Conditions = []batch.JobCondition{{Type: batch.JobComplete, Status: core.ConditionTrue}}
			finished.JobUID = string(finishedJob.UID)
			targetJob, err := q.job(directRunnerLaunch{runID: target.RunID, runToken: "target-token", pipeline: target.Pipeline, runner: target.Runner, receipt: &target.capacityFence})
			if err != nil {
				t.Fatal(err)
			}
			targetJob.UID = "target-job"
			targetJob.ResourceVersion = "1"
			targetJob.Generation = 1
			target.JobUID = string(targetJob.UID)
			terminalPod := &core.Pod{ObjectMeta: meta.ObjectMeta{Name: "finished-pod", Namespace: q.config.Namespace, UID: "finished-pod", OwnerReferences: []meta.OwnerReference{{APIVersion: "batch/v1", Kind: "Job", Name: finishedJob.Name, UID: finishedJob.UID, Controller: ptr(true)}}}, Spec: core.PodSpec{Containers: []core.Container{{Name: "direct-runner"}}}, Status: core.PodStatus{Phase: core.PodSucceeded, ContainerStatuses: []core.ContainerStatus{{Name: "direct-runner", State: core.ContainerState{Terminated: &core.ContainerStateTerminated{FinishedAt: meta.Now()}}}}}}
			secret := &core.Secret{ObjectMeta: meta.ObjectMeta{Name: target.JobName, Namespace: q.config.Namespace, UID: "target-secret", OwnerReferences: []meta.OwnerReference{{APIVersion: "batch/v1", Kind: "Job", Name: targetJob.Name, UID: targetJob.UID, Controller: ptr(true)}}}, Immutable: ptr(true), Data: map[string][]byte{"run-token": []byte("target-token")}}
			k := q.client.(*fake.Clientset)
			if kind == "started-awaiting-attestation" {
				targetJob.Generation = 2
				targetJob.Spec.Suspend = ptr(false)
				runningPod := terminalPod.DeepCopy()
				runningPod.Name = "target-pod"
				runningPod.UID = "target-pod"
				runningPod.OwnerReferences[0].Name = targetJob.Name
				runningPod.OwnerReferences[0].UID = targetJob.UID
				runningPod.Spec.NodeName = "node"
				runningPod.Status.Phase = core.PodRunning
				runningPod.Status.ContainerStatuses[0].State = core.ContainerState{Running: &core.ContainerStateRunning{}}
				if err = k.Tracker().Add(runningPod); err != nil {
					t.Fatal(err)
				}
			}
			for _, obj := range []runtime.Object{finishedJob, targetJob, terminalPod, secret} {
				if err = k.Tracker().Add(obj); err != nil {
					t.Fatal(err)
				}
			}
			var mu sync.Mutex
			stops, attestations, authorizations, targetRetirements := 0, 0, 0, 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				mu.Lock()
				defer mu.Unlock()
				if req.Method == http.MethodGet {
					json.NewEncoder(w).Encode(map[string]any{"policy": map[string]any{"poolId": "pool", "cluster": "cluster", "namespace": q.config.Namespace, "version": 1, "maxConcurrent": 2, "enforced": true, "inventoryKnown": true}, "receipts": []capacityReceipt{*finished, target}})
					return
				}
				var x map[string]any
				json.NewDecoder(req.Body).Decode(&x)
				f, _ := x["fence"].(map[string]any)
				switch x["action"] {
				case "stop-producer":
					stops++
					finished.Producers[0].Stopped = true
					// stopProducer closes its incarnation across every receipt.
					target.Producers = []capacityProducer{{ProducerID: originalProducer, Subject: "subject", Stopped: true}}
				case "attest":
					if f["runId"] == target.RunID && x["podUid"] == "target-pod" {
						attestations++
					}
				case "authorize-producer":
					if f["runId"] == target.RunID && x["producerId"] != originalProducer {
						authorizations++
					}
				case "retire", "release":
					if f["runId"] == target.RunID {
						targetRetirements++
					}
				}
				fmt.Fprint(w, `{"ok":true}`)
			}))
			defer server.Close()
			q.capacity.consoleURL = server.URL
			if err = q.reconcileReceipts(context.Background()); err != nil {
				t.Fatal(err)
			}
			got, err := q.client.BatchV1().Jobs(q.config.Namespace).Get(context.Background(), target.JobName, meta.GetOptions{})
			if err != nil || got.UID != targetJob.UID || got.Spec.Suspend == nil || *got.Spec.Suspend || got.Annotations[queueBarrierAnnotation] != "" {
				t.Fatal("concurrent useful work was retired or stranded", err)
			}
			mu.Lock()
			defer mu.Unlock()
			if stops != 1 || targetRetirements != 0 {
				t.Fatalf("rotation stops=%d target retirements=%d", stops, targetRetirements)
			}
			if kind == "suspended-owned-secret" && authorizations != 1 {
				t.Fatal("original suspended work was not adopted by new producer")
			}
			if kind == "started-awaiting-attestation" && attestations != 1 {
				t.Fatal("already-started original Pod lost attestation")
			}
		})
	}
}

func TestReceiptAbsentJobClosesOnlyDefinitivelyDrainedClaim(t *testing.T) {
	for _, kind := range []string{"drained", "ambiguous-write", "unresolved-claim"} {
		t.Run(kind, func(t *testing.T) {
			q, r, _ := receiptFixture(t)
			q.capacity.registered = true
			original := q.capacity.producerID
			r.Producers = []capacityProducer{{ProducerID: original, Subject: "subject"}}
			if kind == "ambiguous-write" {
				r.Producers[0].PendingWrites = []string{"unknown-create"}
			}
			if kind == "unresolved-claim" {
				q.capacity.requestID = "original-claim-request"
			}
			var mu sync.Mutex
			stopped, released := false, false
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				mu.Lock()
				defer mu.Unlock()
				if req.Method == http.MethodGet {
					json.NewEncoder(w).Encode(map[string]any{"policy": map[string]any{"poolId": "pool", "cluster": "cluster", "namespace": q.config.Namespace, "version": 1, "maxConcurrent": 2, "enforced": true, "inventoryKnown": true}, "receipts": []capacityReceipt{*r}})
					return
				}
				var x map[string]any
				json.NewDecoder(req.Body).Decode(&x)
				switch x["action"] {
				case "stop-producer":
					stopped = true
					r.Producers[0].Stopped = true
				case "retire":
					r.State = "retiring"
				case "release":
					released = true
				}
				fmt.Fprint(w, `{"ok":true}`)
			}))
			defer server.Close()
			q.capacity.consoleURL = server.URL
			err := q.reconcileReceipts(context.Background())
			mu.Lock()
			defer mu.Unlock()
			if kind != "drained" {
				if stopped || released || err == nil || q.capacity.producerID != original {
					t.Fatal("unknown claim/write was falsely drained", err)
				}
				if kind == "unresolved-claim" && q.capacity.requestID != "original-claim-request" {
					t.Fatal("claim request identity discarded")
				}
				if _, getErr := q.client.BatchV1().Jobs(q.config.Namespace).Get(context.Background(), r.JobName, meta.GetOptions{}); !apierrors.IsNotFound(getErr) {
					t.Fatal("unknown claim/write installed an unproved barrier", getErr)
				}
				return
			}
			if err != nil || !stopped || !released || q.capacity.producerID == original {
				t.Fatal("definitively drained pre-Job claim stranded admission", err)
			}
			barrier, err := q.client.BatchV1().Jobs(q.config.Namespace).Get(context.Background(), r.JobName, meta.GetOptions{})
			if err != nil || barrier.Spec.Suspend == nil || !*barrier.Spec.Suspend || barrier.Annotations[queueBarrierAnnotation] != r.Nonce || barrier.Spec.Template.Spec.Containers[0].Command[0] != "/bin/false" {
				t.Fatal("absence retired without inert deterministic barrier", err)
			}
		})
	}
}

// A synthetic Kubernetes terminated status is not positive runtime evidence.
// Neither it nor incomplete container inventory may retire an active permit.
func TestReceiptUnknownTerminationCannotRetireWorker(t *testing.T) {
	for _, kind := range []string{"healthy", "runtime-unknown", "missing-finish", "missing-init-status", "running-ephemeral", "node-lost"} {
		t.Run(kind, func(t *testing.T) {
			q, r, ops := receiptFixture(t)
			q.claimSettled = func(context.Context, string, string, string) (bool, error) { return true, nil }
			r.Producers = []capacityProducer{{ProducerID: "original", Subject: "subject", Stopped: true}}
			j, err := q.job(directRunnerLaunch{runID: r.RunID, runToken: "original-token", pipeline: r.Pipeline, runner: r.Runner, receipt: &r.capacityFence})
			if err != nil {
				t.Fatal(err)
			}
			j.UID = "original-job"
			j.ResourceVersion = "1"
			j.Generation = 2
			j.Spec.Suspend = ptr(false)
			j.Status.Conditions = []batch.JobCondition{{Type: batch.JobComplete, Status: core.ConditionTrue}}
			r.JobUID = string(j.UID)
			r.Worker = &capacityWorker{Generation: 1, PodUID: "original-pod", JobUID: r.JobUID, Active: true}
			p := core.Pod{ObjectMeta: meta.ObjectMeta{Name: "original-pod", UID: "original-pod", Namespace: q.config.Namespace, OwnerReferences: []meta.OwnerReference{{APIVersion: "batch/v1", Kind: "Job", Name: j.Name, UID: j.UID, Controller: ptr(true)}}}, Spec: *j.Spec.Template.Spec.DeepCopy(), Status: core.PodStatus{Phase: core.PodSucceeded, ContainerStatuses: []core.ContainerStatus{{Name: "direct-runner", State: core.ContainerState{Terminated: &core.ContainerStateTerminated{ExitCode: 0, FinishedAt: meta.Now()}}}}}}
			switch kind {
			case "runtime-unknown":
				p.Status.Phase = core.PodFailed
				p.Status.ContainerStatuses[0].State.Terminated.Reason = "ContainerStatusUnknown"
			case "missing-finish":
				p.Status.ContainerStatuses[0].State.Terminated.FinishedAt = meta.Time{}
			case "missing-init-status":
				p.Spec.InitContainers = []core.Container{{Name: "bootstrap"}}
			case "running-ephemeral":
				p.Spec.EphemeralContainers = []core.EphemeralContainer{{EphemeralContainerCommon: core.EphemeralContainerCommon{Name: "debug-worker"}}}
				p.Status.EphemeralContainerStatuses = []core.ContainerStatus{{Name: "debug-worker", State: core.ContainerState{Running: &core.ContainerStateRunning{}}}}
			case "node-lost":
				p.Status.Phase = core.PodFailed
				p.Status.Reason = "NodeLost"
			}
			if err = q.client.(*fake.Clientset).Tracker().Add(j); err != nil {
				t.Fatal(err)
			}
			err = q.retireReceipt(context.Background(), *r, "recovery-nonce-123456", j, []core.Pod{p})
			if kind == "healthy" {
				if err != nil {
					t.Fatal("positive physical runtime evidence refused", err)
				}
				return
			}
			if err == nil {
				t.Fatal("unknown/incomplete physical evidence retired an active worker")
			}
			for _, op := range *ops {
				if op["action"] == "worker-retired" || op["action"] == "release" {
					t.Fatal("unknown evidence transferred worker/capacity authority", op)
				}
			}
		})
	}
}

func TestReceiptDeadlineResumesAfterAttemptedReceipt(t *testing.T) {
	q, r, _ := receiptFixture(t)
	first := *r
	first.JobName = queueJobName(first.RunID)
	second := *r
	second.Slot = 1
	second.RunID = "work:second/r1"
	second.JobName = queueJobName(second.RunID)
	if first.JobName > second.JobName {
		first, second = second, first
	}
	q.capacity.registered = true
	q.capacity.requestID = "unresolved-claim" // closure is separately fenced
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var attempts []string
	var attemptsMu sync.Mutex
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.Method == http.MethodGet {
			json.NewEncoder(w).Encode(map[string]any{"policy": map[string]any{"poolId": "pool", "cluster": "cluster", "namespace": q.config.Namespace, "version": 1, "maxConcurrent": 2, "enforced": true, "inventoryKnown": true}, "receipts": []capacityReceipt{first, second}})
			return
		}
		var op struct {
			Action string        `json:"action"`
			Fence  capacityFence `json:"fence"`
		}
		json.NewDecoder(req.Body).Decode(&op)
		if op.Action == "recover" {
			attemptsMu.Lock()
			attempts = append(attempts, op.Fence.RunID)
			if len(attempts) == 1 {
				cancel()
			}
			attemptsMu.Unlock()
		}
		fmt.Fprint(w, `{ "ok":true }`)
	}))
	defer s.Close()
	q.capacity.consoleURL = s.URL
	_ = q.reconcileReceipts(ctx)
	_ = q.reconcileReceipts(context.Background())
	attemptsMu.Lock()
	defer attemptsMu.Unlock()
	if len(attempts) < 2 || attempts[0] != first.RunID || attempts[1] != second.RunID {
		t.Fatalf("deadline starved later receipt: %v", attempts)
	}
}

// Retirement can be the first observer of a failed Job. It must preserve the
// pre-start scheduler cause before releasing the exact receipt, even when the
// immutable Secret has already disappeared and claim authority is projected.
func TestReceiptRetirementPreservesSchedulerPreemption(t *testing.T) {
	for _, deleting := range []bool{false, true} {
		deleting := deleting
		for _, authority := range []string{"secret", "projection", "exit-refused"} {
			del := deleting
			delName := "retained"
			if !del {
				delName = "live"
			}
			t.Run(delName+"/"+authority, func(t *testing.T) {
				q, r, ops := receiptFixture(t)
				r.Producers = []capacityProducer{{ProducerID: "original", Subject: "subject", Stopped: true}}
				j, err := q.job(directRunnerLaunch{runID: r.RunID, runToken: "original-token", pipeline: r.Pipeline, runner: r.Runner, receipt: &r.capacityFence})
				if err != nil {
					t.Fatal(err)
				}
				j.UID = "original-job"
				j.ResourceVersion = "1"
				j.Generation = 2
				j.Spec.Suspend = ptr(false)
				j.Status.Conditions = []batch.JobCondition{{Type: batch.JobFailed, Status: core.ConditionTrue}}
				r.JobUID = string(j.UID)
				p := disruptedPod("original-pod", string(j.UID), true, schedulerPreemptionReason, nil)
				p.OwnerReferences[0].Name = j.Name
				p.OwnerReferences[0].APIVersion = "batch/v1"
				p.Spec = *j.Spec.Template.Spec.DeepCopy()
				p.Status.Phase = core.PodFailed
				if del {
					at := meta.Now()
					p.DeletionTimestamp = &at
				}
				r.Worker = &capacityWorker{Generation: 1, PodUID: string(p.UID), JobUID: r.JobUID, Active: true}
				k := q.client.(*fake.Clientset)
				if err = k.Tracker().Add(j); err != nil {
					t.Fatal(err)
				}
				if authority == "secret" {
					secret := &core.Secret{ObjectMeta: meta.ObjectMeta{Name: j.Name, Namespace: q.config.Namespace, UID: "original-secret", OwnerReferences: p.OwnerReferences}, Immutable: ptr(true), Data: map[string][]byte{"run-token": []byte("original-token")}}
					r.SecretUID = string(secret.UID)
					if err = k.Tracker().Add(secret); err != nil {
						t.Fatal(err)
					}
				} else {
					q.claimSettled = func(_ context.Context, runID, runner, fingerprint string) (bool, error) {
						if runID != r.RunID || runner != r.Runner || fingerprint != queueClaimFingerprint("original-token") {
							t.Error("claim authority changed")
						}
						return false, nil
					}
				}
				reports := 0
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
					reports++
					var body struct {
						Runner           string          `json:"runner"`
						ClaimFingerprint string          `json:"claimFingerprint"`
						Disruption       *exitDisruption `json:"disruption"`
					}
					if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
						t.Error(err)
					}
					if body.Runner != r.Runner || body.ClaimFingerprint != queueClaimFingerprint("original-token") || req.Header.Get("Authorization") != "Bearer google-id-token" {
						t.Error("original exit authority changed")
					}
					d := body.Disruption
					if d == nil || d.JobUID != r.JobUID || d.PodUID != string(p.UID) || d.Kind != schedulerPreemptionKind || d.ObservedAt != "2026-08-15T12:00:00Z" {
						t.Errorf("lost disruption receipt: %+v", d)
					}
					for _, op := range *ops {
						if op["action"] == "release" {
							t.Error("capacity released before logical exit")
						}
					}
					if authority == "exit-refused" {
						w.WriteHeader(http.StatusForbidden)
						return
					}
					fmt.Fprint(w, `{"state":"lost"}`)
				}))
				defer server.Close()
				q.exits = testExitReporter(server.URL)
				err = q.retireReceipt(context.Background(), *r, "recovery-nonce-123456", j, []core.Pod{*p})
				if (err != nil) != (authority == "exit-refused") {
					t.Fatalf("retirement error=%v", err)
				}
				if reports != 1 {
					t.Fatalf("exit reports=%d", reports)
				}
				released := false
				for _, op := range *ops {
					if op["action"] == "release" {
						released = true
					}
				}
				if released != (authority != "exit-refused") {
					t.Fatal("receipt release ignored logical exit result")
				}
				barrier, getErr := k.BatchV1().Jobs(q.config.Namespace).Get(context.Background(), j.Name, meta.GetOptions{})
				if getErr != nil || barrier.UID != j.UID || barrier.Spec.Suspend == nil || !*barrier.Spec.Suspend || barrier.Annotations[queueBarrierAnnotation] != r.Nonce {
					t.Fatal("exact inert barrier lost", getErr)
				}
			})
		}
	}
}

func TestReceiptPreemptionRetirementRejectsAmbiguousNonexecution(t *testing.T) {
	for _, kind := range []string{"eligible", "running", "deleting", "deleting-nonterminal", "deleting-runtime-exit", "not-terminal", "node-lost", "other-cause", "executed", "history", "restart", "container-id", "started", "init", "ephemeral", "extra-container", "extra-status", "other-pod", "replacement-uid"} {
		t.Run(kind, func(t *testing.T) {
			j := queueJob("original-job")
			j.Status.Conditions = []batch.JobCondition{{Type: batch.JobFailed, Status: core.ConditionTrue}}
			p := disruptedPod("original-pod", "original-job", true, schedulerPreemptionReason, nil)
			p.Status.Phase = core.PodFailed
			p.OwnerReferences[0].APIVersion = "batch/v1"
			p.Spec.Containers = []core.Container{{Name: directRunnerContainer}}
			pods := []core.Pod{*p}
			status := core.ContainerStatus{Name: directRunnerContainer}
			switch kind {
			case "running":
				p.Status.Phase = core.PodRunning
			case "deleting":
				at := meta.Now()
				p.DeletionTimestamp = &at
			case "deleting-nonterminal":
				at := meta.Now()
				p.DeletionTimestamp = &at
				p.Status.Phase = core.PodRunning
			case "deleting-runtime-exit":
				at := meta.Now()
				p.DeletionTimestamp = &at
				status.State.Terminated = &core.ContainerStateTerminated{Reason: "Error", FinishedAt: meta.Now()}
				p.Status.ContainerStatuses = []core.ContainerStatus{status}
			case "not-terminal":
				j.Status.Conditions = nil
			case "node-lost":
				p.Status.Reason = "NodeLost"
			case "other-cause":
				p.Status.Conditions[0].Reason = "EvictionByEvictionAPI"
			case "executed":
				status.State.Terminated = &core.ContainerStateTerminated{Reason: "ContainerStatusUnknown"}
			case "history":
				status.LastTerminationState.Terminated = &core.ContainerStateTerminated{}
			case "restart":
				status.RestartCount = 1
			case "container-id":
				status.ContainerID = "containerd://executed"
			case "started":
				status.Started = ptr(true)
			case "init":
				p.Spec.InitContainers = []core.Container{{Name: "setup"}}
			case "ephemeral":
				p.Spec.EphemeralContainers = []core.EphemeralContainer{{EphemeralContainerCommon: core.EphemeralContainerCommon{Name: "debug"}}}
			case "extra-container":
				p.Spec.Containers = append(p.Spec.Containers, core.Container{Name: "sidecar"})
			case "extra-status":
				p.Status.ContainerStatuses = []core.ContainerStatus{{Name: "unknown"}}
			case "other-pod":
				pods = append(pods, *disruptedPod("second-pod", "original-job", true, schedulerPreemptionReason, nil))
			case "replacement-uid":
				j.UID = "replacement-job"
			}
			if kind == "executed" || kind == "history" || kind == "restart" || kind == "container-id" || kind == "started" {
				p.Status.ContainerStatuses = []core.ContainerStatus{status}
			}
			pods[0] = *p
			ended, never := physicalReceiptWorkersEnded(&j, pods)
			wantEnded := kind == "eligible" || kind == "deleting"
			if ended != wantEnded || never {
				t.Fatalf("kind=%s ended=%v never=%v wantEnded=%v", kind, ended, never, wantEnded)
			}
		})
	}
}

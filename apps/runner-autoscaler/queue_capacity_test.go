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
			p := core.Pod{ObjectMeta: meta.ObjectMeta{Name: "worker", UID: "pod", OwnerReferences: []meta.OwnerReference{{APIVersion: "batch/v1", Kind: "Job", Name: j.Name, UID: j.UID, Controller: ptr(true)}}}, Status: core.PodStatus{Phase: core.PodRunning, ContainerStatuses: []core.ContainerStatus{{Name: "runner", State: core.ContainerState{Running: &core.ContainerStateRunning{}}}}}}
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
				pods[0].Status.ContainerStatuses[0].State = core.ContainerState{Terminated: &core.ContainerStateTerminated{}}
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
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"ok": true, "retirement": map[string]any{"runId": r.RunID, "nonce": r.Nonce, "jobName": j.Name, "released": true, "retainBarrier": true, "barrier": map[string]string{"uid": string(j.UID), "resourceVersion": j.ResourceVersion}}})
	}))
	defer s.Close()
	q.capacity.consoleURL = s.URL
	if err = q.verifyRetiredBarrier(context.Background(), j); err != nil {
		t.Fatal("exact server-retired barrier remains unavailable", err)
	}
	replacement := j.DeepCopy()
	replacement.UID = "replacement"
	if err = q.verifyRetiredBarrier(context.Background(), replacement); err == nil {
		t.Fatal("replacement tombstone UID was adopted")
	}
}

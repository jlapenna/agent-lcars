package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	core "k8s.io/api/core/v1"
	meta "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
)

func TestPlacementObservationsRequireSingleOwnedLivePod(t *testing.T) {
	for _, scenario := range []string{"pending", "assigned", "absent", "foreign", "duplicate", "terminal", "deleting", "started-unassigned", "suspended", "modified-job"} {
		t.Run(scenario, func(t *testing.T) {
			q, _ := kubeQueueFixture()
			job, err := q.job(directRunnerLaunch{runID: "octo/example#7/r1", runToken: "token", pipeline: "opencode", runner: "executor"})
			if err != nil {
				t.Fatal(err)
			}
			job.UID = "original-job"
			job.Generation = 2
			job.Spec.Suspend = ptr(false)
			pod := core.Pod{ObjectMeta: meta.ObjectMeta{Name: "worker", UID: "pod-uid", OwnerReferences: []meta.OwnerReference{{APIVersion: "batch/v1", Kind: "Job", Name: job.Name, UID: job.UID, Controller: ptr(true)}}}, Status: core.PodStatus{Phase: core.PodPending}}
			switch scenario {
			case "assigned":
				pod.Spec.NodeName = "eligible"
			case "foreign":
				pod.OwnerReferences[0].UID = types.UID("foreign-job")
			case "terminal":
				pod.Status.Phase = core.PodFailed
			case "deleting":
				now := meta.Now()
				pod.DeletionTimestamp = &now
			case "started-unassigned":
				now := meta.Now()
				pod.Status.StartTime = &now
			case "suspended":
				job.Spec.Suspend = ptr(true)
				job.Generation = 1
			case "modified-job":
				job.Generation = 3
			}
			pods := &core.PodList{Items: []core.Pod{pod}}
			if scenario == "absent" {
				pods.Items = nil
			}
			if scenario == "duplicate" {
				pods.Items = append(pods.Items, pod)
			}
			calls := 0
			q.reportStartupPlacement = func(_ context.Context, o placementObservation) error {
				calls++
				if o.RunID != "octo/example#7/r1" || o.JobUID != "original-job" || o.Runner != "executor" || o.ClaimFingerprint != queueClaimFingerprint("token") || o.Placed != (scenario == "assigned") {
					t.Fatalf("wrong observation: %+v", o)
				}
				return nil
			}
			if err := q.observeJobStartupPlacement(context.Background(), job, pods); err != nil {
				t.Fatal(err)
			}
			want := 0
			if scenario == "pending" || scenario == "assigned" {
				want = 1
			}
			if calls != want {
				t.Fatalf("calls=%d want=%d", calls, want)
			}
		})
	}
}

// Every Job bounds runtime on the Pod (kubelet clock, after assignment), never
// on the Job's scheduling-inclusive clock: unassigned Pending time is fenced by
// the server's placement observations instead.
func TestPlacementRuntimeDeadlineIsOnThePod(t *testing.T) {
	q, _ := kubeQueueFixture()
	job, err := q.job(directRunnerLaunch{runID: "octo/example#7/r1", pipeline: "opencode"})
	if err != nil {
		t.Fatal(err)
	}
	if job.Spec.ActiveDeadlineSeconds != nil || job.Spec.Template.Spec.ActiveDeadlineSeconds == nil || *job.Spec.Template.Spec.ActiveDeadlineSeconds != 7200 {
		t.Fatal("runtime unbounded or counts Job scheduling wait")
	}
	if _, retired := job.Annotations["agent-lcars.placement-aware"]; retired {
		t.Fatal("placement negotiation annotation is retired; every Job is placement-aware")
	}
}

func TestPlacementReporterValidatesIdentityAndNeverFollowsRedirects(t *testing.T) {
	for _, scenario := range []string{"valid", "wrong-job", "redirect", "refused"} {
		t.Run(scenario, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.EscapedPath() != "/api/work/v1/runs/octo%2Fexample%237%2Fr1/startup-placement" || r.Method != http.MethodPost || r.Header.Get("Authorization") != "Bearer executor-token" {
					t.Fatal("wrong placement authority")
				}
				var o placementObservation
				if json.NewDecoder(r.Body).Decode(&o) != nil || o.JobUID != "original-job" {
					t.Fatal("wrong observation body")
				}
				if scenario == "redirect" {
					w.Header().Set("Location", "/secret-leak")
					w.WriteHeader(http.StatusFound)
					return
				}
				if scenario == "refused" {
					w.WriteHeader(http.StatusConflict)
					return
				}
				uid := "original-job"
				if scenario == "wrong-job" {
					uid = "replacement-job"
				}
				_ = json.NewEncoder(w).Encode(map[string]string{"runId": o.RunID, "jobUid": uid, "expiresAt": "2026-10-11T20:00:00Z"})
			}))
			defer srv.Close()
			report := queueStartupPlacementReporter(srv.URL, func() (string, error) { return "executor-token", nil })
			err := report(context.Background(), placementObservation{RunID: "octo/example#7/r1", JobUID: "original-job"})
			if (err == nil) != (scenario == "valid") {
				t.Fatalf("err=%v", err)
			}
		})
	}
}

func TestPlacementClaimNegotiationRequiresAcknowledgement(t *testing.T) {
	for _, acknowledge := range []bool{true, false} {
		t.Run(fmt.Sprint(acknowledge), func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var body map[string]any
				if json.NewDecoder(r.Body).Decode(&body) != nil || body["placementAware"] != true {
					t.Fatal("missing placement negotiation")
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"runId": "work:01PLACEMENTTEST/r1", "pipeline": "opencode", "token": "token", "placementAware": acknowledge})
			}))
			defer srv.Close()
			calls := 0
			cfg := queueExecutorConfig{consoleURL: srv.URL, runnerName: "executor", idToken: func() (string, error) { return "executor-token", nil }, reserve: reserveFor(func(directRunnerLaunch) error {
				calls++
				return nil
			})}
			_, err := pollOnceWithOutcome(cfg)
			if (err == nil) != acknowledge || (calls == 1) != acknowledge {
				t.Fatalf("calls=%d err=%v", calls, err)
			}
		})
	}
}

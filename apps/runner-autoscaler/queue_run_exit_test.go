package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	batch "k8s.io/api/batch/v1"
	core "k8s.io/api/core/v1"
	meta "k8s.io/apimachinery/pkg/apis/meta/v1"
)

type exitReportRecorder struct {
	mu           sync.Mutex
	paths        []string
	runners      []string
	fingerprints []string
	bearers      []string
	statuses     []int
}

func (r *exitReportRecorder) server(t *testing.T) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		var body map[string]string
		_ = json.NewDecoder(req.Body).Decode(&body)
		r.mu.Lock()
		r.paths = append(r.paths, req.URL.EscapedPath())
		r.runners = append(r.runners, body["runner"])
		r.fingerprints = append(r.fingerprints, body["claimFingerprint"])
		r.bearers = append(r.bearers, req.Header.Get("Authorization"))
		status := http.StatusOK
		if len(r.statuses) > 0 {
			status, r.statuses = r.statuses[0], r.statuses[1:]
		}
		r.mu.Unlock()
		switch status {
		case http.StatusOK:
			w.WriteHeader(status)
			_, _ = w.Write([]byte(`{"runId":"x","state":"lost"}`))
		case http.StatusConflict: // stands in for the route's pipeline-grant 403
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte(`{"defined":true,"code":"FORBIDDEN","status":403,"message":"pipeline not granted to this executor"}`))
		case http.StatusNotFound:
			w.WriteHeader(status)
			_, _ = w.Write([]byte(`{"defined":true,"code":"NOT_FOUND","status":404,"message":"unknown run"}`))
		case http.StatusGone: // stands in for a console without the route
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`<html>404: This page could not be found.</html>`))
		default:
			w.WriteHeader(status)
		}
	}))
	t.Cleanup(server.Close)
	return server
}

func (r *exitReportRecorder) requests() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.paths...)
}

func testExitReporter(url string) *runExitReporter {
	return newRunExitReporter(url, "executor-1", func() (string, error) { return "google-id-token", nil }, discardLogger())
}

func TestRunExitReporterReportsEachRunOnceWithExecutorIdentity(t *testing.T) {
	recorder := &exitReportRecorder{}
	reporter := testExitReporter(recorder.server(t).URL)

	// A native run id contains a slash; it must stay one escaped segment.
	for range 3 {
		reporter.observeTerminated("work:01QUEUEEXITREPORT00000001/r1", "", "")
		reporter.wg.Wait()
	}

	got := recorder.requests()
	if len(got) != 1 || got[0] != "/api/work/v1/runs/work:01QUEUEEXITREPORT00000001%2Fr1/exit" {
		t.Fatalf("exit reports = %v, want exactly one escaped report", got)
	}
	if recorder.runners[0] != "executor-1" || recorder.bearers[0] != "Bearer google-id-token" {
		t.Fatalf("runner=%q bearer=%q", recorder.runners[0], recorder.bearers[0])
	}
}

func TestRunExitReporterRetriesAFailedReportOnTheNextObservation(t *testing.T) {
	recorder := &exitReportRecorder{statuses: []int{http.StatusServiceUnavailable}}
	reporter := testExitReporter(recorder.server(t).URL)

	for range 3 {
		reporter.observeTerminated("run-retry", "", "")
		reporter.wg.Wait()
	}

	if got := recorder.requests(); len(got) != 2 {
		t.Fatalf("exit reports = %v, want the failed report retried exactly once", got)
	}
}

func TestRunExitReporterTreatsUnknownRunAsDelivered(t *testing.T) {
	recorder := &exitReportRecorder{statuses: []int{http.StatusNotFound}}
	reporter := testExitReporter(recorder.server(t).URL)

	for range 2 {
		reporter.observeTerminated("run-gone", "", "")
		reporter.wg.Wait()
	}

	if got := recorder.requests(); len(got) != 1 {
		t.Fatalf("exit reports = %v, want a 404 never retried", got)
	}
}

func TestRunExitReporterTreatsNotClaimant403AsFinal(t *testing.T) {
	recorder := &exitReportRecorder{statuses: []int{http.StatusForbidden}}
	reporter := testExitReporter(recorder.server(t).URL)

	for range 3 {
		reporter.observeTerminated("run-claimed-elsewhere", "", "")
		reporter.wg.Wait()
	}

	// Claim ownership never changes, so retrying every inventory read would
	// only repeat the refusal; lease expiry settles such a run instead.
	if got := recorder.requests(); len(got) != 1 {
		t.Fatalf("exit reports = %v, want a 403 never retried", got)
	}
}

func TestRunExitReporterRetriesAPipelineGrant403(t *testing.T) {
	recorder := &exitReportRecorder{statuses: []int{http.StatusConflict}}
	reporter := testExitReporter(recorder.server(t).URL)

	for range 3 {
		reporter.observeTerminated("run-grant-restored", "", "")
		reporter.wg.Wait()
	}

	// A restored grant must still settle the run on a later observation.
	if got := recorder.requests(); len(got) != 2 {
		t.Fatalf("exit reports = %v, want the grant 403 retried until delivered", got)
	}
}

func TestRunExitReporterReportsUnderTheClaimedRunnerName(t *testing.T) {
	recorder := &exitReportRecorder{}
	reporter := testExitReporter(recorder.server(t).URL)

	// A Job claimed by an earlier executor process (another container
	// hostname) must be reported under that claim's name, not this one's.
	reporter.observeTerminated("run-from-previous-process", "executor-0", "")
	reporter.wg.Wait()

	if len(recorder.runners) != 1 || recorder.runners[0] != "executor-0" {
		t.Fatalf("runners = %v, want the claim's runner name", recorder.runners)
	}
}

func TestRunExitReporterRetriesARouteMissing404(t *testing.T) {
	recorder := &exitReportRecorder{statuses: []int{http.StatusGone}}
	reporter := testExitReporter(recorder.server(t).URL)

	for range 2 {
		reporter.observeTerminated("run-before-console-rollout", "", "")
		reporter.wg.Wait()
	}

	if got := recorder.requests(); len(got) != 2 {
		t.Fatalf("exit reports = %v, want a bare 404 retried", got)
	}
}

func TestRunExitReporterForgetsRunsPastEvidenceRetention(t *testing.T) {
	recorder := &exitReportRecorder{}
	reporter := testExitReporter(recorder.server(t).URL)
	now := time.Date(2026, 10, 5, 12, 0, 0, 0, time.UTC)
	reporter.now = func() time.Time { return now }

	reporter.observeTerminated("run-old", "", "")
	reporter.wg.Wait()
	now = now.Add(runExitReportedRetention + time.Minute)
	reporter.observeTerminated("run-new", "", "")
	reporter.wg.Wait()

	reporter.mu.Lock()
	_, kept := reporter.reported[exitClaimKey("run-old", "")]
	reporter.mu.Unlock()
	if kept {
		t.Fatal("reported set retained a run past the queue's evidence retention")
	}
}

func TestNilRunExitReporterIsANoOp(t *testing.T) {
	var reporter *runExitReporter
	reporter.observeTerminated("run", "", "")
}

func queueJobFor(runID string, condition batch.JobConditionType) *batch.Job {
	job := &batch.Job{ObjectMeta: meta.ObjectMeta{
		Name:        queueJobName(runID),
		Namespace:   "lcars-work",
		Labels:      map[string]string{queueJobLabel: "true"},
		Annotations: map[string]string{queueRunAnnotation: runID},
	}}
	if condition != "" {
		job.Status.Conditions = []batch.JobCondition{{Type: condition, Status: core.ConditionTrue}}
	}
	return job
}

func TestKubernetesQueueRecordsTheClaimingRunnerOnTheJob(t *testing.T) {
	q, _ := kubeQueueFixture()
	job, err := q.job(directRunnerLaunch{runID: "work:claimant/r1", pipeline: "claude", runner: "executor-0"})
	if err != nil {
		t.Fatal(err)
	}
	if job.Annotations[queueRunnerAnnotation] != "executor-0" || job.Annotations[queueRunAnnotation] != "work:claimant/r1" {
		t.Fatalf("annotations = %v", job.Annotations)
	}
}

func TestKubernetesInventoryReportsUnderTheJobsClaimingRunner(t *testing.T) {
	claimed := queueJobFor("run-claimed", batch.JobFailed)
	claimed.Annotations[queueRunnerAnnotation] = "executor-0"
	claimed.Annotations[queueClaimAnnotation] = queueClaimFingerprint("original-job-token")
	q, _ := kubeQueueFixture(claimed)
	recorder := &exitReportRecorder{}
	q.exits = testExitReporter(recorder.server(t).URL)

	if _, err := q.activeCount(context.Background()); err != nil {
		t.Fatal(err)
	}
	q.exits.wg.Wait()

	if len(recorder.runners) != 1 || recorder.runners[0] != "executor-0" || recorder.fingerprints[0] != queueClaimFingerprint("original-job-token") {
		t.Fatalf("runners = %v, want the Job's recorded claimant", recorder.runners)
	}
}

func TestKubernetesInventoryReportsEveryTerminatedJobOnce(t *testing.T) {
	impostor := queueJobFor("run-impostor", batch.JobFailed)
	impostor.Name = "lcars-work-not-derived-from-its-run"
	q, _ := kubeQueueFixture(
		queueJobFor("run-active", ""),
		queueJobFor("run-failed", batch.JobFailed),
		queueJobFor("run-complete", batch.JobComplete),
		impostor,
	)
	recorder := &exitReportRecorder{}
	q.exits = testExitReporter(recorder.server(t).URL)

	for range 2 {
		n, err := q.activeCount(context.Background())
		if err != nil || n != 1 {
			t.Fatalf("activeCount = %d, %v; want the one running Job", n, err)
		}
		q.exits.wg.Wait()
	}

	got := map[string]bool{}
	for _, path := range recorder.requests() {
		got[path] = true
	}
	want := map[string]bool{
		"/api/work/v1/runs/run-failed/exit":   true,
		"/api/work/v1/runs/run-complete/exit": true,
	}
	if len(recorder.requests()) != len(want) || !got["/api/work/v1/runs/run-failed/exit"] || !got["/api/work/v1/runs/run-complete/exit"] {
		t.Fatalf("exit reports = %v, want %v once each", recorder.requests(), want)
	}
}

func TestRunExitReporterKeysDeliveryByOriginalClaimFingerprint(t *testing.T) {
	recorder := &exitReportRecorder{statuses: []int{http.StatusForbidden}}
	reporter := testExitReporter(recorder.server(t).URL)
	for _, fingerprint := range []string{queueClaimFingerprint("old"), queueClaimFingerprint("old"), queueClaimFingerprint("new"), queueClaimFingerprint("new")} {
		reporter.observeTerminated("same-run", "same-runner", fingerprint)
		reporter.wg.Wait()
	}
	if len(recorder.requests()) != 2 || recorder.fingerprints[0] != queueClaimFingerprint("old") || recorder.fingerprints[1] != queueClaimFingerprint("new") {
		t.Fatalf("fingerprints=%v; want each original claim once", recorder.fingerprints)
	}
}

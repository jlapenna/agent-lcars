package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus/testutil"
	batch "k8s.io/api/batch/v1"
	core "k8s.io/api/core/v1"
	meta "k8s.io/apimachinery/pkg/apis/meta/v1"
)

func TestRunExitOutcomeIsBounded(t *testing.T) {
	yes, no := true, false
	for _, c := range []struct {
		state string
		ok    *bool
		want  string
	}{
		{"finished", &yes, "succeeded"},
		{"finished", &no, "failed"},
		{"finished", nil, "finished"},
		{"lost", nil, "lost"},
		{"canceled", nil, "canceled"},
		{"unknown-run", nil, "unknown_run"},
		{stateNotClaimant, nil, "not_claimant"},
		{"running", nil, "other"},
		{"a free-form state", nil, "other"},
	} {
		if got := runExitOutcome(c.state, c.ok); got != c.want {
			t.Errorf("runExitOutcome(%q, %v) = %q, want %q", c.state, c.ok, got, c.want)
		}
	}
}

func TestQueueJobRecordsItsPipelineForExitMetrics(t *testing.T) {
	q, _ := kubeQueueFixture()
	job, err := q.job(directRunnerLaunch{runID: "work:pipeline/r1", pipeline: "claude", runner: "executor-0"})
	if err != nil {
		t.Fatal(err)
	}
	if job.Annotations[queuePipelineAnnotation] != "claude" {
		t.Fatalf("annotations = %v", job.Annotations)
	}
}

func TestJobExitMetaMeasuresStartToTerminalCondition(t *testing.T) {
	start := time.Date(2026, 11, 18, 10, 0, 0, 0, time.UTC)
	job := batch.Job{ObjectMeta: meta.ObjectMeta{Annotations: map[string]string{queuePipelineAnnotation: "claw-default"}}}
	if got := jobExitMeta(job); got.pipeline != "claw-default" || got.duration != 0 {
		t.Fatalf("unstarted Job meta = %+v", got)
	}
	job.Status.StartTime = &meta.Time{Time: start}
	job.Status.Conditions = []batch.JobCondition{
		{Type: batch.JobSuspended, Status: core.ConditionFalse, LastTransitionTime: meta.Time{Time: start.Add(time.Second)}},
		{Type: batch.JobComplete, Status: core.ConditionTrue, LastTransitionTime: meta.Time{Time: start.Add(39 * time.Second)}},
	}
	if got := jobExitMeta(job); got.duration != 39*time.Second {
		t.Fatalf("duration = %v, want 39s", got.duration)
	}
}

func TestDeliveredExitCountsItsPipelineAndResult(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"runId":"x","state":"finished","ok":false}`))
	}))
	t.Cleanup(server.Close)
	job := queueJobFor("run-metrics", batch.JobFailed)
	job.Annotations[queuePipelineAnnotation] = "claw-metrics-test"
	q, _ := kubeQueueFixture(job)
	q.exits = testExitReporter(server.URL)
	counter := queueExecutorRunExitsTotal.WithLabelValues("claw-metrics-test", "failed")
	before := testutil.ToFloat64(counter)

	for range 2 {
		if _, err := q.activeCount(context.Background()); err != nil {
			t.Fatal(err)
		}
		q.exits.wg.Wait()
	}

	if got := testutil.ToFloat64(counter) - before; got != 1 {
		t.Fatalf("failed exits counted %v times, want once", got)
	}
	if testutil.ToFloat64(queueExecutorRunExitTimestamp.WithLabelValues("claw-metrics-test", "failed")) == 0 {
		t.Fatal("last exit timestamp not set")
	}
}

func TestUndeliveredExitIsNotCounted(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
	}))
	t.Cleanup(server.Close)
	reporter := testExitReporter(server.URL)
	counter := queueExecutorRunExitsTotal.WithLabelValues("claw-undelivered-test", "other")
	before := testutil.ToFloat64(counter)
	reporter.observeExit("run-undelivered", "", testClaimFingerprint, exitMeta{pipeline: "claw-undelivered-test"})
	reporter.wg.Wait()
	if got := testutil.ToFloat64(counter) - before; got != 0 {
		t.Fatalf("undelivered exit counted %v", got)
	}
}

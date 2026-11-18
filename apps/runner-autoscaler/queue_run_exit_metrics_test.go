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

func TestRunExitStreakCountsFailuresInReportOrder(t *testing.T) {
	initRunExitMetrics([]string{"claw-streak-test"})
	streak := queueExecutorRunConsecutiveFailures.WithLabelValues("claw-streak-test")
	if testutil.ToFloat64(streak) != 0 || testutil.ToFloat64(queueExecutorRunExitsTotal.WithLabelValues("claw-streak-test", "lost")) != 0 {
		t.Fatal("a declared runtime must start at zero, not absent")
	}
	if testutil.ToFloat64(queueExecutorRunExitMetricsSupported) != 1 {
		t.Fatal("support gauge not set")
	}
	at := time.Unix(1_800_000_000, 0)
	for _, step := range []struct {
		outcome string
		want    float64
	}{
		{"failed", 1}, {"lost", 2}, {"unknown_run", 2}, {"finished", 2}, {"canceled", 0},
		{"lost", 1}, {"succeeded", 0}, {"failed", 1},
	} {
		recordRunExit(exitMeta{pipeline: "claw-streak-test"}, step.outcome, at)
		if got := testutil.ToFloat64(streak); got != step.want {
			t.Fatalf("after %s streak = %v, want %v", step.outcome, got, step.want)
		}
	}
}

func TestUnattributedExitsJoinNoRuntimeStreak(t *testing.T) {
	recordRunExit(exitMeta{}, "lost", time.Unix(1_800_000_000, 0))
	recordRunExit(exitMeta{}, "failed", time.Unix(1_800_000_000, 0))
	if got := testutil.ToFloat64(queueExecutorRunConsecutiveFailures.WithLabelValues("unknown")); got != 0 {
		t.Fatalf("unknown streak = %v, want 0", got)
	}
	if testutil.ToFloat64(queueExecutorRunExitsTotal.WithLabelValues("unknown", "lost")) < 1 {
		t.Fatal("unattributed exits must still count in the totals")
	}
}

func TestReplayedExitIsNotCountedAgain(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"runId":"x","state":"finished","ok":false,"replayed":true}`))
	}))
	t.Cleanup(server.Close)
	reporter := testExitReporter(server.URL)
	counter := queueExecutorRunExitsTotal.WithLabelValues("claw-replay-test", "failed")
	before := testutil.ToFloat64(counter)
	reporter.observeExit("run-replayed", "", testClaimFingerprint, exitMeta{pipeline: "claw-replay-test"})
	reporter.wg.Wait()
	if !reporter.delivered("run-replayed", testClaimFingerprint) {
		t.Fatal("a replay is still a delivered report")
	}
	if got := testutil.ToFloat64(counter) - before; got != 0 {
		t.Fatalf("replayed exit counted %v", got)
	}
}

func TestDeclaredRuntimesStartWithDurationBaselines(t *testing.T) {
	initRunExitMetrics([]string{"claw-histogram-test"})
	if n := testutil.CollectAndCount(queueExecutorRunDurationSeconds, "github_runner_autoscaler_queue_executor_run_duration_seconds"); n < len(runExitOutcomes) {
		t.Fatalf("duration histograms = %d, want a child per outcome", n)
	}
}

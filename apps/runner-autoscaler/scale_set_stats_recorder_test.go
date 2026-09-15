package main

import (
	"bytes"
	"io"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/actions/scaleset"
	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/testutil"
	dto "github.com/prometheus/client_model/go"
)

// testSessionID is an arbitrary non-nil session UUID for tests that don't
// care about the session_info gauge and just need a valid session identity
// to construct a recorder.
var testSessionID = uuid.MustParse("00000000-0000-0000-0000-0000000000aa")

// sessionInfoSeriesForScaleSet counts github_runner_autoscaler_scale_set_session_info
// series whose scale_set label matches, without going through WithLabelValues
// (which would recreate a deleted series as a side effect of merely reading it).
func sessionInfoSeriesForScaleSet(scaleSet string) int {
	ch := make(chan prometheus.Metric, 16)
	go func() {
		scaleSetSessionInfoGauge.Collect(ch)
		close(ch)
	}()
	count := 0
	for m := range ch {
		var metric dto.Metric
		if err := m.Write(&metric); err != nil {
			continue
		}
		for _, l := range metric.GetLabel() {
			if l.GetName() == "scale_set" && l.GetValue() == scaleSet {
				count++
			}
		}
	}
	return count
}

func TestScaleSetStatsRecorderRecordStatisticsSetsAllSevenFields(t *testing.T) {
	const scaleSet = "stats-test-fields"
	r := newScaleSetStatsRecorder(scaleSet, testSessionID, slog.New(slog.NewTextHandler(io.Discard, nil)))

	r.RecordStatistics(&scaleset.RunnerScaleSetStatistic{
		TotalAvailableJobs:     1,
		TotalAcquiredJobs:      2,
		TotalAssignedJobs:      3,
		TotalRunningJobs:       4,
		TotalRegisteredRunners: 5,
		TotalBusyRunners:       6,
		TotalIdleRunners:       7,
	})

	for field, want := range map[string]float64{
		statsFieldAvailableJobs:     1,
		statsFieldAcquiredJobs:      2,
		statsFieldAssignedJobs:      3,
		statsFieldRunningJobs:       4,
		statsFieldRegisteredRunners: 5,
		statsFieldBusyRunners:       6,
		statsFieldIdleRunners:       7,
	} {
		if got := testutil.ToFloat64(scaleSetStatsGauge.WithLabelValues(scaleSet, field)); got != want {
			t.Errorf("scale_set_stats{field=%q} = %v, want %v", field, got, want)
		}
	}
}

// The initial RecordStatistics call reflects session creation, not a
// message the listener actually processed, so it must not move
// last_message_timestamp_seconds -- only session_started_timestamp_seconds,
// set at construction. See the incident in agent-lcars#1716: a restart's
// fresh session reported initial statistics with no message ever arriving
// after it, and last_message must not look freshly alive when that happens.
func TestScaleSetStatsRecorderTimestamps(t *testing.T) {
	const scaleSet = "stats-test-timestamps"
	fakeNow := time.Unix(1_000_000, 0)
	r := newScaleSetStatsRecorder(scaleSet, testSessionID, slog.New(slog.NewTextHandler(io.Discard, nil)))
	r.now = func() time.Time { return fakeNow }
	// The constructor already stamped session-started with the real clock;
	// re-stamp deterministically for this test's assertions.
	scaleSetSessionStartedTimestampGauge.WithLabelValues(scaleSet).Set(float64(fakeNow.Unix()))
	scaleSetLastMessageTimestampGauge.WithLabelValues(scaleSet).Set(0)

	stat := &scaleset.RunnerScaleSetStatistic{TotalAssignedJobs: 1}

	// Initial session statistics: session-started is set, last-message is not.
	r.RecordStatistics(stat)
	if got := testutil.ToFloat64(scaleSetSessionStartedTimestampGauge.WithLabelValues(scaleSet)); got != float64(fakeNow.Unix()) {
		t.Fatalf("session_started_timestamp_seconds = %v, want %v", got, fakeNow.Unix())
	}
	if got := testutil.ToFloat64(scaleSetLastMessageTimestampGauge.WithLabelValues(scaleSet)); got != 0 {
		t.Fatalf("last_message_timestamp_seconds after initial statistics = %v, want 0 (unset)", got)
	}

	// A later polled message's statistics: last-message now updates.
	laterNow := fakeNow.Add(90 * time.Second)
	r.now = func() time.Time { return laterNow }
	r.RecordStatistics(stat)
	if got := testutil.ToFloat64(scaleSetLastMessageTimestampGauge.WithLabelValues(scaleSet)); got != float64(laterNow.Unix()) {
		t.Fatalf("last_message_timestamp_seconds after message statistics = %v, want %v", got, laterNow.Unix())
	}

	// RecordJobStarted/RecordJobCompleted are an independent message signal.
	evenLaterNow := laterNow.Add(30 * time.Second)
	r.now = func() time.Time { return evenLaterNow }
	r.RecordJobStarted(&scaleset.JobStarted{})
	if got := testutil.ToFloat64(scaleSetLastMessageTimestampGauge.WithLabelValues(scaleSet)); got != float64(evenLaterNow.Unix()) {
		t.Fatalf("last_message_timestamp_seconds after RecordJobStarted = %v, want %v", got, evenLaterNow.Unix())
	}

	yetLaterNow := evenLaterNow.Add(30 * time.Second)
	r.now = func() time.Time { return yetLaterNow }
	r.RecordJobCompleted(&scaleset.JobCompleted{})
	if got := testutil.ToFloat64(scaleSetLastMessageTimestampGauge.WithLabelValues(scaleSet)); got != float64(yetLaterNow.Unix()) {
		t.Fatalf("last_message_timestamp_seconds after RecordJobCompleted = %v, want %v", got, yetLaterNow.Unix())
	}
}

func TestScaleSetStatsRecorderRecordDesiredRunnersDoesNotSetDesiredRunnersGauge(t *testing.T) {
	const scaleSet = "stats-test-desired"
	before := testutil.ToFloat64(desiredRunnersGauge.WithLabelValues(scaleSet))

	r := newScaleSetStatsRecorder(scaleSet, testSessionID, slog.New(slog.NewTextHandler(io.Discard, nil)))
	r.RecordDesiredRunners(4)

	if got := testutil.ToFloat64(desiredRunnersGauge.WithLabelValues(scaleSet)); got != before {
		t.Fatalf("desired_runners{%s} changed from %v to %v; RecordDesiredRunners must leave the scaler-owned gauge alone", scaleSet, before, got)
	}
}

// agent-lcars#1716's cheap early signal: available jobs piling up while the
// listener thinks nothing is desired, for two consecutive polls, logs once
// at INFO -- not on the first poll, not again on every subsequent poll
// while the condition persists, but again if it clears and reoccurs.
func TestScaleSetStatsRecorderStrandedQueueLogsOncePerChange(t *testing.T) {
	const scaleSet = "stats-test-stranded"
	var logBuf bytes.Buffer
	r := newScaleSetStatsRecorder(scaleSet, testSessionID, slog.New(slog.NewTextHandler(&logBuf, nil)))
	logBuf.Reset() // construction itself logs the new session's ID (agent-lcars#1975); not under test here.

	strandedStat := &scaleset.RunnerScaleSetStatistic{TotalAvailableJobs: 3}
	healthyStat := &scaleset.RunnerScaleSetStatistic{TotalAvailableJobs: 0}

	// desiredRunners stays 0 (zero value) throughout: never call
	// RecordDesiredRunners with a nonzero count.

	r.RecordStatistics(strandedStat) // poll 1: streak = 1, no log yet
	if logBuf.Len() != 0 {
		t.Fatalf("logged after only one stranded poll: %s", logBuf.String())
	}

	r.RecordStatistics(strandedStat) // poll 2: streak = 2, logs
	logged := logBuf.String()
	if !strings.Contains(logged, "level=INFO") || !strings.Contains(logged, "available jobs with zero desired runners") {
		t.Fatalf("expected an INFO stranded-queue log after two consecutive polls, got: %q", logged)
	}
	logBuf.Reset()

	r.RecordStatistics(strandedStat) // poll 3: still stranded, must not re-log
	if logBuf.Len() != 0 {
		t.Fatalf("re-logged on a third consecutive stranded poll (no change): %s", logBuf.String())
	}

	r.RecordStatistics(healthyStat) // condition clears
	if logBuf.Len() != 0 {
		t.Fatalf("logged when the stranded condition cleared: %s", logBuf.String())
	}

	r.RecordStatistics(strandedStat) // poll 1 of a new streak: no log yet
	if logBuf.Len() != 0 {
		t.Fatalf("logged after only one stranded poll of the new streak: %s", logBuf.String())
	}
	r.RecordStatistics(strandedStat) // poll 2 of the new streak: logs again
	if logged := logBuf.String(); !strings.Contains(logged, "level=INFO") {
		t.Fatalf("expected a fresh INFO log for the reoccurring stranded condition, got: %q", logged)
	}
}

func TestScaleSetStatsRecorderStrandedQueueDoesNotLogWithDesiredRunners(t *testing.T) {
	const scaleSet = "stats-test-not-stranded"
	var logBuf bytes.Buffer
	r := newScaleSetStatsRecorder(scaleSet, testSessionID, slog.New(slog.NewTextHandler(&logBuf, nil)))
	logBuf.Reset() // construction itself logs the new session's ID (agent-lcars#1975); not under test here.
	r.RecordDesiredRunners(2)

	stat := &scaleset.RunnerScaleSetStatistic{TotalAvailableJobs: 5}
	r.RecordStatistics(stat)
	r.RecordStatistics(stat)

	if logBuf.Len() != 0 {
		t.Fatalf("logged the stranded-queue signal despite nonzero desired runners: %s", logBuf.String())
	}
}

// agent-lcars#1975: GitHub Support ticket #4758522 asked the fleet to name
// the affected scale set's listener session ID on a stranded-job recurrence.
// Constructing a recorder for a scale set publishes that session's ID as an
// info series so the sweeper (and a human reading Prometheus) can find it.
func TestScaleSetStatsRecorderSessionInfoGaugePublishesSessionID(t *testing.T) {
	const scaleSet = "stats-test-session-info"
	sessionID := uuid.MustParse("11111111-1111-1111-1111-111111111111")

	newScaleSetStatsRecorder(scaleSet, sessionID, slog.New(slog.NewTextHandler(io.Discard, nil)))

	if got := testutil.ToFloat64(scaleSetSessionInfoGauge.WithLabelValues(scaleSet, sessionID.String())); got != 1 {
		t.Fatalf("scale_set_session_info{scale_set=%q,session_id=%q} = %v, want 1", scaleSet, sessionID, got)
	}
}

// A session recreation (reconnect after the listener session expired or
// errored) must retire the previous session_id series for this scale set --
// otherwise every reconnect over a runner's lifetime accumulates one more
// stale series naming a session ID GitHub no longer recognizes.
func TestScaleSetStatsRecorderSessionInfoGaugeRetiresPreviousSessionOnRecreation(t *testing.T) {
	const scaleSet = "stats-test-session-recreate"
	sessionID1 := uuid.MustParse("22222222-2222-2222-2222-222222222222")
	sessionID2 := uuid.MustParse("33333333-3333-3333-3333-333333333333")

	newScaleSetStatsRecorder(scaleSet, sessionID1, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if got := testutil.ToFloat64(scaleSetSessionInfoGauge.WithLabelValues(scaleSet, sessionID1.String())); got != 1 {
		t.Fatalf("first session series not published: got %v, want 1", got)
	}

	newScaleSetStatsRecorder(scaleSet, sessionID2, slog.New(slog.NewTextHandler(io.Discard, nil)))

	if got := sessionInfoSeriesForScaleSet(scaleSet); got != 1 {
		t.Fatalf("scale_set_session_info series for %q after recreation = %d, want exactly 1", scaleSet, got)
	}
	if got := testutil.ToFloat64(scaleSetSessionInfoGauge.WithLabelValues(scaleSet, sessionID2.String())); got != 1 {
		t.Fatalf("new session series not published: got %v, want 1", got)
	}
}

// A nil/zero session UUID (the constructor's zero value, never expected from
// a real GitHub session) must not publish a series -- an unset session_id
// label would be as useless as the missing evidence this metric exists to
// capture, and would falsely claim "session 00000000-..." exists.
func TestScaleSetStatsRecorderSessionInfoGaugeSkipsZeroUUID(t *testing.T) {
	const scaleSet = "stats-test-session-zero"

	newScaleSetStatsRecorder(scaleSet, uuid.Nil, slog.New(slog.NewTextHandler(io.Discard, nil)))

	if got := sessionInfoSeriesForScaleSet(scaleSet); got != 0 {
		t.Fatalf("scale_set_session_info series for %q with a nil session ID = %d, want 0", scaleSet, got)
	}
}

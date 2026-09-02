package main

import (
	"bytes"
	"io"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/actions/scaleset"
	"github.com/prometheus/client_golang/prometheus/testutil"
)

func TestScaleSetStatsRecorderRecordStatisticsSetsAllSevenFields(t *testing.T) {
	const scaleSet = "stats-test-fields"
	r := newScaleSetStatsRecorder(scaleSet, slog.New(slog.NewTextHandler(io.Discard, nil)))

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
	r := newScaleSetStatsRecorder(scaleSet, slog.New(slog.NewTextHandler(io.Discard, nil)))
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

	r := newScaleSetStatsRecorder(scaleSet, slog.New(slog.NewTextHandler(io.Discard, nil)))
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
	r := newScaleSetStatsRecorder(scaleSet, slog.New(slog.NewTextHandler(&logBuf, nil)))

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
	r := newScaleSetStatsRecorder(scaleSet, slog.New(slog.NewTextHandler(&logBuf, nil)))
	r.RecordDesiredRunners(2)

	stat := &scaleset.RunnerScaleSetStatistic{TotalAvailableJobs: 5}
	r.RecordStatistics(stat)
	r.RecordStatistics(stat)

	if logBuf.Len() != 0 {
		t.Fatalf("logged the stranded-queue signal despite nonzero desired runners: %s", logBuf.String())
	}
}

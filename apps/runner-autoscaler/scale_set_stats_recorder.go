package main

import (
	"log/slog"
	"sync"
	"time"

	"github.com/actions/scaleset"
)

// The complete set of `field` label values scaleSetStatsGauge is ever set
// with. Named constants (rather than literals at each call site) keep the
// label bounded -- see the placementReason* pattern in metrics.go.
const (
	statsFieldAvailableJobs     = "available_jobs"
	statsFieldAcquiredJobs      = "acquired_jobs"
	statsFieldAssignedJobs      = "assigned_jobs"
	statsFieldRunningJobs       = "running_jobs"
	statsFieldRegisteredRunners = "registered_runners"
	statsFieldBusyRunners       = "busy_runners"
	statsFieldIdleRunners       = "idle_runners"
)

// scaleSetStatsRecorder implements listener.MetricsRecorder for one scale
// set's listener session (agent-lcars#1716). It exports the full
// RunnerScaleSetStatistic that the library's own discard recorder throws
// away: the incident that motivated this file had a scale set's listener
// healthy and polling on schedule while GitHub silently stopped routing it
// queued jobs. Every dashboard read "no demand" because only
// TotalAssignedJobs ever left the listener (into HandleDesiredRunnerCount),
// and TotalAssignedJobs is necessarily 0 for a job GitHub never assigned --
// TotalAvailableJobs was the field that would have shown the truth.
//
// One recorder is constructed per listener session (see
// runListenerSupervisor in orchestrator.go), so sawInitialStatistics
// naturally starts false on every reconnect: listener.Listener.Run calls
// RecordStatistics exactly once with the freshly (re)created session's own
// statistics before it ever enters its poll loop, and every call after that
// corresponds to a real polled message. That distinction is what keeps
// github_runner_autoscaler_scale_set_last_message_timestamp_seconds from
// jumping to "now" immediately after a restart before any message has
// actually arrived -- the exact ambiguity ("a fresh session whose initial
// statistics reported totalAssignedJobs=0, and no JobAvailable ever
// arrived") that hid the incident behind a healthy-looking listener.
type scaleSetStatsRecorder struct {
	scaleSet string
	logger   *slog.Logger
	now      func() time.Time

	mu                   sync.Mutex
	sawInitialStatistics bool
	lastDesiredRunners   int
	strandedSignalStreak int
	strandedSignalLogged bool
}

// newScaleSetStatsRecorder constructs a recorder for one listener session
// and immediately records the session-start timestamp. Callers construct a
// fresh recorder per session (matching listener.New's own per-session
// lifecycle) rather than reusing one across reconnects.
func newScaleSetStatsRecorder(scaleSet string, logger *slog.Logger) *scaleSetStatsRecorder {
	r := &scaleSetStatsRecorder{scaleSet: scaleSet, logger: logger, now: time.Now}
	scaleSetSessionStartedTimestampGauge.WithLabelValues(scaleSet).Set(float64(r.now().Unix()))
	return r
}

// RecordStatistics implements listener.MetricsRecorder. It is called once
// with the initial session's own statistics and then once per subsequent
// polled message (listener.Listener.handleStatistics).
func (r *scaleSetStatsRecorder) RecordStatistics(statistics *scaleset.RunnerScaleSetStatistic) {
	if statistics == nil {
		return
	}

	scaleSetStatsGauge.WithLabelValues(r.scaleSet, statsFieldAvailableJobs).Set(float64(statistics.TotalAvailableJobs))
	scaleSetStatsGauge.WithLabelValues(r.scaleSet, statsFieldAcquiredJobs).Set(float64(statistics.TotalAcquiredJobs))
	scaleSetStatsGauge.WithLabelValues(r.scaleSet, statsFieldAssignedJobs).Set(float64(statistics.TotalAssignedJobs))
	scaleSetStatsGauge.WithLabelValues(r.scaleSet, statsFieldRunningJobs).Set(float64(statistics.TotalRunningJobs))
	scaleSetStatsGauge.WithLabelValues(r.scaleSet, statsFieldRegisteredRunners).Set(float64(statistics.TotalRegisteredRunners))
	scaleSetStatsGauge.WithLabelValues(r.scaleSet, statsFieldBusyRunners).Set(float64(statistics.TotalBusyRunners))
	scaleSetStatsGauge.WithLabelValues(r.scaleSet, statsFieldIdleRunners).Set(float64(statistics.TotalIdleRunners))

	r.mu.Lock()
	isInitialSessionStatistics := !r.sawInitialStatistics
	r.sawInitialStatistics = true
	desiredRunners := r.lastDesiredRunners
	r.mu.Unlock()

	// Only a statistics report that arrived attached to an actual polled
	// message counts as "the listener heard from GitHub" -- the initial
	// session statistics reflect session creation, which is already covered
	// by scaleSetSessionStartedTimestampGauge.
	if !isInitialSessionStatistics {
		r.markMessageProcessed()
	}

	r.checkStrandedQueueSignal(statistics, desiredRunners)
}

// RecordJobStarted and RecordJobCompleted implement listener.MetricsRecorder.
// Both fire only from within handleMessage (never for the initial session),
// so -- independent of the RecordStatistics initial/message distinction
// above -- they are an unambiguous second signal that a message was
// processed. In practice they land on the same message RecordStatistics
// already timestamped; recording it again here is a harmless idempotent
// overwrite with the same wall-clock second, not a competing source of
// truth.
func (r *scaleSetStatsRecorder) RecordJobStarted(*scaleset.JobStarted) {
	r.markMessageProcessed()
}

func (r *scaleSetStatsRecorder) RecordJobCompleted(*scaleset.JobCompleted) {
	r.markMessageProcessed()
}

func (r *scaleSetStatsRecorder) markMessageProcessed() {
	scaleSetLastMessageTimestampGauge.WithLabelValues(r.scaleSet).Set(float64(r.now().Unix()))
}

// RecordDesiredRunners implements listener.MetricsRecorder. It deliberately
// does NOT set github_runner_autoscaler_desired_runners: Scaler.HandleDesiredRunnerCount
// (scaler.go) already sets that gauge from its own target-runner-count
// computation (min(maxRunners, minRunners+count)), which is not always
// bit-identical to the count this hook receives (e.g. a partially failed
// scale-up returns the actual post-attempt runner count rather than the
// target). Setting the same series from both places would just race two
// slightly different computations to overwrite each other. This method only
// remembers the latest value for the stranded-queue log check below.
func (r *scaleSetStatsRecorder) RecordDesiredRunners(count int) {
	r.mu.Lock()
	r.lastDesiredRunners = count
	r.mu.Unlock()
}

// checkStrandedQueueSignal logs once at INFO when TotalAvailableJobs > 0
// while the listener's last known desired-runner count is 0, for two
// consecutive RecordStatistics calls in a row -- a cheap early signal for
// the agent-lcars#1716 stranded-queue symptom (GitHub is offering jobs to
// this scale set that never turn into runner demand). "Once per change"
// means the log fires on the transition into the condition, not on every
// poll for as long as it persists; it can fire again after the condition
// clears and reoccurs.
func (r *scaleSetStatsRecorder) checkStrandedQueueSignal(statistics *scaleset.RunnerScaleSetStatistic, desiredRunners int) {
	r.mu.Lock()
	defer r.mu.Unlock()

	if statistics.TotalAvailableJobs == 0 || desiredRunners != 0 {
		r.strandedSignalStreak = 0
		r.strandedSignalLogged = false
		return
	}

	r.strandedSignalStreak++
	if r.strandedSignalStreak < 2 || r.strandedSignalLogged {
		return
	}
	r.strandedSignalLogged = true
	r.logger.Info("Scale set reports available jobs with zero desired runners for two consecutive polls",
		slog.String("scale_set", r.scaleSet),
		slog.Int("available_jobs", statistics.TotalAvailableJobs),
		slog.Int("acquired_jobs", statistics.TotalAcquiredJobs),
		slog.Int("assigned_jobs", statistics.TotalAssignedJobs),
		slog.Int("running_jobs", statistics.TotalRunningJobs),
		slog.Int("registered_runners", statistics.TotalRegisteredRunners),
		slog.Int("desired_runners", desiredRunners),
	)
}

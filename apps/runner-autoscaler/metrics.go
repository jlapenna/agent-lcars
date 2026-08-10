package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// The complete set of `reason` label values placementBlocked is ever
// incremented with. Keeping them here — rather than as literals at each
// scaler.go call site — is what keeps the label bounded: a reason invented
// inline would silently add a new Prometheus time series per scale set.
const (
	placementReasonFleetLimit = "fleet_limit"
	placementReasonHostLimits = "host_limits"
	// A shared-workdir scale set allows at most one runner per host, so it
	// can exhaust placement while every host is reachable and under its
	// own runner limit. Distinct from host_limits for that reason.
	placementReasonSharedWorkDirExclusive = "shared_workdir_exclusive"
	// Every eligible host was withheld by its operator-defined readiness
	// gate. Distinct from unreachability: these hosts answered fine, the
	// operator's own signal said not to use them.
	placementReasonReadiness = "readiness"
	// Every reachable, within-limit host was excluded because scoreHostLoad
	// found it hard-overloaded (load/CPU/PSI/memory/swap pressure past the
	// *Hard threshold) or still inside its post-overload cooldown window --
	// see hostLoad.overloaded and applyOverloadCooldown. Deliberately
	// distinct from a host with no telemetry at all: missing telemetry only
	// adds hostLoadPolicy.telemetryPenalty (a small deprioritization) and
	// never excludes the host, because telemetry trouble must fail open, not
	// closed (see probeHostLoad).
	placementReasonOverload = "overload"
	// The shared pnpm content-addressable store's last-known size (from the
	// most recent idle-host sweep) is at or above its configured budget
	// (agent-lcars#852) on every host that would otherwise have shared-
	// workdir placement capacity. Distinct from shared_workdir_exclusive:
	// that reason means every host already has an active runner; this one
	// means a host is free but its store needs to prune/evict before it is
	// safe to grow further.
	placementReasonPnpmStoreBudget = "pnpm_store_budget"
)

// The complete set of `result` label values pnpmStorePruneTotal and
// pnpmStoreEvictionTotal are ever incremented with -- bounded the same way
// as the placementReason* constants above.
const (
	pnpmMaintenanceResultSuccess = "success"
	pnpmMaintenanceResultFailure = "failure"
	// skipped: maintenance was not attempted this sweep (workdir was under
	// cap, the store directory does not exist yet, or -- prune only -- the
	// runner_image has no pnpm binary, e.g. a third-party share_workdir
	// pool's own image). Distinct from failure: nothing was attempted, so
	// nothing went wrong.
	pnpmMaintenanceResultSkipped = "skipped"
)

// The complete set of `reason` label values workdirSweepFailuresTotal is
// ever incremented with, mapped 1:1 from sweepHostWorkDir's own error
// paths so a bash-produced free-form error string never reaches a metric
// label.
const (
	sweepFailureReasonContainerCreate   = "container_create"
	sweepFailureReasonContainerStart    = "container_start"
	sweepFailureReasonContainerWait     = "container_wait"
	sweepFailureReasonExitNonzero       = "exit_nonzero"
	sweepFailureReasonLogsRead          = "logs_read"
	sweepFailureReasonOutputUnparseable = "output_unparseable"
)

// The complete set of `reason` label values runnerDiedIdleTotal is ever
// incremented with, for the same bounded-cardinality reason as the
// placementReason* constants above: pruneDeadIdleRunners' own log message
// embeds a free-form container status string that must never reach a metric
// label directly.
const (
	runnerDeadReasonNotRunning = "not_running"
	runnerDeadReasonNotFound   = "not_found"
)

const (
	checkpointRestoreRestored   = "restored"
	checkpointRestoreAbsent     = "absent"
	checkpointRestoreUnreadable = "unreadable"
)

var (
	metricsOnce                   sync.Once
	orchestratorSchedulerReady    atomic.Bool
	orchestratorExpectedListeners atomic.Int64
	orchestratorListenerStates    sync.Map // map[string]bool

	runnersIdleGauge = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "github_runner_autoscaler_runners_idle",
			Help: "Number of idle runner containers tracked by host and scale set.",
		},
		[]string{"scale_set", "host"},
	)
	runnersBusyGauge = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "github_runner_autoscaler_runners_busy",
			Help: "Number of busy runner containers tracked by host and scale set.",
		},
		[]string{"scale_set", "host"},
	)
	runnersTotalGauge = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "github_runner_autoscaler_runners_total",
			Help: "Total number of runner containers tracked for a scale set.",
		},
		[]string{"scale_set"},
	)
	desiredRunnersGauge = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "github_runner_autoscaler_desired_runners",
			Help: "Desired number of runners requested by GitHub Actions listener.",
		},
		[]string{"scale_set"},
	)
	minRunnersGauge = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "github_runner_autoscaler_min_runners",
			Help: "Minimum runner count configured for a scale set.",
		},
		[]string{"scale_set"},
	)
	maxRunnersGauge = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "github_runner_autoscaler_max_runners",
			Help: "Maximum runner count configured for a scale set.",
		},
		[]string{"scale_set"},
	)
	jobsStartedCounter = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "github_runner_autoscaler_jobs_started_total",
			Help: "Total count of jobs started for a scale set.",
		},
		[]string{"scale_set"},
	)
	jobsCompletedCounter = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "github_runner_autoscaler_jobs_completed_total",
			Help: "Total count of jobs completed for a scale set.",
		},
		[]string{"scale_set"},
	)
	runnerStartDuration = prometheus.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:    "github_runner_autoscaler_runner_start_duration_seconds",
			Help:    "Histogram of duration in seconds to create and start a runner container.",
			Buckets: prometheus.DefBuckets,
		},
		[]string{"scale_set", "host"},
	)
	runnerStartFailures = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "github_runner_autoscaler_runner_start_failures_total",
			Help: "Total number of failed runner start attempts.",
		},
		[]string{"scale_set", "host"},
	)
	runnerDiedIdleTotal = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "github_runner_autoscaler_runner_died_idle_total",
			Help: "Idle runner containers found dead before ever completing a job (crashed, exited, or vanished before GitHub sent a completion), by host and reason: " +
				runnerDeadReasonNotRunning + ", " + runnerDeadReasonNotFound + ".",
		},
		[]string{"scale_set", "host", "reason"},
	)
	hostReachableGauge = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "github_runner_autoscaler_host_reachable",
			Help: "1 if placement docker host ping succeeded, 0 otherwise.",
		},
		[]string{"host"},
	)
	hostExternalsHealthyGauge = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "github_runner_autoscaler_host_externals_healthy",
			Help: "1 when the shared externals/node24 runtime last verified healthy (and self-healed if needed) on a ShareWorkDir host's periodic idle-maintenance sweep, 0 when it was still broken after a repair attempt.",
		},
		[]string{"host"},
	)
	hostReadyGauge = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "github_runner_autoscaler_host_ready",
			Help: "For hosts with require_readiness: 1 if the operator's readiness signal currently permits placement, 0 otherwise. Absent for hosts without the gate.",
		},
		[]string{"host"},
	)
	hostNormalizedLoadGauge = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "github_runner_autoscaler_host_normalized_load",
			Help: "Latest node_load1 divided by logical CPU count used for placement.",
		},
		[]string{"host"},
	)
	hostCPUUtilizationGauge = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "github_runner_autoscaler_host_cpu_utilization_ratio",
		Help: "Recent host CPU utilization ratio derived from node-exporter counters.",
	}, []string{"host"})
	hostPressureGauge = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "github_runner_autoscaler_host_pressure_ratio",
		Help: "Recent host PSI stall ratio by resource.",
	}, []string{"host", "resource"})
	hostMemoryAvailableGauge = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "github_runner_autoscaler_host_memory_available_ratio",
		Help: "Host available-memory ratio used by placement.",
	}, []string{"host"})
	hostSwapRateGauge = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "github_runner_autoscaler_host_swap_pages_per_second",
		Help: "Host swap-in plus swap-out pages per second used by placement.",
	}, []string{"host"})
	hostTelemetryGauge = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "github_runner_autoscaler_host_telemetry_available",
		Help: "1 when the latest placement host telemetry probe succeeded.",
	}, []string{"host"})
	hostCooldownGauge = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "github_runner_autoscaler_host_cooldown",
		Help: "1 while a host remains in overload cooldown.",
	}, []string{"host"})
	hostLoadPenaltyGauge = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "github_runner_autoscaler_host_load_penalty",
			Help: "Virtual runner-count penalty applied from host load, including overload cooldown.",
		},
		[]string{"host"},
	)
	hostFleetRunnersGauge = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "github_runner_autoscaler_host_fleet_runners",
			Help: "Running autoscaled runner containers across every scale set on a host.",
		},
		[]string{"host"},
	)
	drainingGauge = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "github_runner_autoscaler_draining",
			Help: "1 while this scale-set listener is draining and refusing new runner placements.",
		},
		[]string{"scale_set"},
	)
	drainAutoClearedTotal = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "github_runner_autoscaler_drain_auto_cleared_total",
			Help: "Stuck drains the watchdog self-healed after the scale set sat draining at zero runners past drainStuckTimeout (homelab#321), by scale set. Sustained nonzero indicates deploy.sh keeps getting interrupted before its recreate step.",
		},
		[]string{"scale_set"},
	)
	placementDecisions = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "github_runner_autoscaler_placement_decisions_total",
			Help: "Runner placement decisions by destination host.",
		},
		[]string{"scale_set", "host"},
	)
	workdirBytesGauge = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "github_runner_autoscaler_workdir_bytes",
			Help: "Size in bytes of the shared /home/runner/_work directory after the last sweep, by host.",
		},
		[]string{"host"},
	)
	workdirSweptBytesTotal = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "github_runner_autoscaler_workdir_swept_bytes_total",
			Help: "Total bytes reclaimed from the shared /home/runner/_work directory by the periodic sweep, by host.",
		},
		[]string{"host"},
	)
	// pnpmStoreBytesGauge/pnpmStoreBudgetBytesGauge/pnpmStorePruneTotal/
	// pnpmStoreEvictionTotal (agent-lcars#853) instrument the shared pnpm
	// content-addressable store specifically, one tenant of the workdir
	// gauges above. Measured by the same helper-container script as
	// workdirBytesGauge (workDirSweepScript/sweepHostWorkDir), so these stay
	// exactly as fresh: every periodic idle sweep, plus immediately after
	// each job completes on that host.
	pnpmStoreBytesGauge = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "github_runner_autoscaler_pnpm_store_bytes",
			Help: "Size in bytes of the shared pnpm content-addressable store after the last sweep, by host.",
		},
		[]string{"host"},
	)
	pnpmStoreBudgetBytesGauge = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "github_runner_autoscaler_pnpm_store_budget_bytes",
			Help: "Configured pnpm-store budget in bytes for a fleet host (fleet.hosts[].pnpm_store_budget, or the default when unset). pickHostLocked refuses a new shared-workdir placement on a host at or above this threshold -- see placement_blocked_total{reason=\"" + placementReasonPnpmStoreBudget + "\"}.",
		},
		[]string{"host"},
	)
	pnpmStorePruneTotal = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "github_runner_autoscaler_pnpm_store_prune_total",
			Help: "Idle-host `pnpm store prune` attempts by the workdir sweep, by host and result: " +
				pnpmMaintenanceResultSuccess + ", " + pnpmMaintenanceResultFailure + ", " + pnpmMaintenanceResultSkipped + ".",
		},
		[]string{"host", "result"},
	)
	pnpmStoreEvictionTotal = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "github_runner_autoscaler_pnpm_store_eviction_total",
			Help: "Idle-host full pnpm-store evictions by the workdir sweep -- the last resort when prune alone does not clear the workdir cap -- by host and result: " +
				pnpmMaintenanceResultSuccess + ", " + pnpmMaintenanceResultFailure + ", " + pnpmMaintenanceResultSkipped + ".",
		},
		[]string{"host", "result"},
	)
	workdirSweepSuccessTotal = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "github_runner_autoscaler_workdir_sweep_success_total",
			Help: "Idle-host workdir maintenance sweeps that completed and reported a usable result, by host.",
		},
		[]string{"host"},
	)
	workdirSweepFailuresTotal = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "github_runner_autoscaler_workdir_sweep_failures_total",
			Help: "Idle-host workdir maintenance sweeps that failed before producing a usable result, by host and reason: " +
				sweepFailureReasonContainerCreate + ", " + sweepFailureReasonContainerStart + ", " +
				sweepFailureReasonContainerWait + ", " + sweepFailureReasonExitNonzero + ", " +
				sweepFailureReasonLogsRead + ", " + sweepFailureReasonOutputUnparseable + ".",
		},
		[]string{"host", "reason"},
	)
	reservationGauge = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "github_runner_autoscaler_scheduler_reservations",
		Help: "In-flight runner start reservations by scale set and host.",
	}, []string{"scale_set", "host"})
	placementBlocked = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "github_runner_autoscaler_placement_blocked_total",
		Help: "Placement attempts blocked by a fleet scheduling invariant, by reason: " +
			placementReasonFleetLimit + ", " + placementReasonHostLimits + ", " +
			placementReasonSharedWorkDirExclusive + ", " + placementReasonReadiness + ", " +
			placementReasonOverload + ", " + placementReasonPnpmStoreBudget + ".",
	}, []string{"scale_set", "reason"})
	listenerUpGauge = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "github_runner_autoscaler_listener_up",
		Help: "1 while the GitHub message listener for a scale set is connected and running.",
	}, []string{"scale_set"})
	listenerRestarts = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "github_runner_autoscaler_listener_restarts_total",
		Help: "Listener reconnection attempts after an unexpected failure.",
	}, []string{"scale_set"})
	quiesceGenerationTimeouts = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "github_runner_autoscaler_quiesce_generation_timeouts_total",
		Help: "Control-plane quiesces that checkpointed and exited while the runtime generation was still running.",
	})
	pendingRunnersGauge = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "github_runner_autoscaler_scheduler_pending_runners",
		Help: "Runner deficit still waiting for a safe fleet placement.",
	}, []string{"scale_set"})
	githubUnavailableRunnersGauge = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "github_runner_autoscaler_github_unavailable_runners",
		Help: "Number of locally tracked runner containers older than the startup grace period that GitHub reports offline or no longer lists.",
	}, []string{"scale_set", "host", "reason"})
	runnerStatusProbeUpGauge = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "github_runner_autoscaler_runner_status_probe_up",
		Help: "1 when the latest registration-scoped GitHub runner-status reconciliation succeeded, 0 when it failed.",
	}, []string{"registration"})
	fleetMaxRunnersGauge = prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "github_runner_autoscaler_fleet_max_runners",
		Help: "Configured hard maximum runner count across the fleet.",
	})
	checkpointWriteFailures = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "github_runner_autoscaler_checkpoint_write_failures_total",
		Help: "Total number of failed control-plane checkpoint write attempts.",
	})
	checkpointLastWriteTimestamp = prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "github_runner_autoscaler_checkpoint_last_write_timestamp_seconds",
		Help: "Unix timestamp of the last successful control-plane checkpoint write.",
	})
	checkpointRestoreStatus = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "github_runner_autoscaler_checkpoint_restore_status",
		Help: "One-hot checkpoint restore outcome at boot, by status: restored, absent, or unreadable.",
	}, []string{"status"})
)

func setCheckpointRestoreStatus(status string) {
	for _, candidate := range []string{checkpointRestoreRestored, checkpointRestoreAbsent, checkpointRestoreUnreadable} {
		value := 0.0
		if candidate == status {
			value = 1
		}
		checkpointRestoreStatus.WithLabelValues(candidate).Set(value)
	}
}

func registerMetrics() {
	metricsOnce.Do(func() {
		prometheus.MustRegister(
			runnersIdleGauge,
			runnersBusyGauge,
			runnersTotalGauge,
			desiredRunnersGauge,
			minRunnersGauge,
			maxRunnersGauge,
			jobsStartedCounter,
			jobsCompletedCounter,
			runnerStartDuration,
			runnerStartFailures,
			runnerDiedIdleTotal,
			hostReachableGauge,
			hostExternalsHealthyGauge,
			hostReadyGauge,
			hostNormalizedLoadGauge,
			hostCPUUtilizationGauge,
			hostPressureGauge,
			hostMemoryAvailableGauge,
			hostSwapRateGauge,
			hostTelemetryGauge,
			hostCooldownGauge,
			hostLoadPenaltyGauge,
			hostFleetRunnersGauge,
			drainingGauge,
			drainAutoClearedTotal,
			placementDecisions,
			workdirBytesGauge,
			workdirSweptBytesTotal,
			pnpmStoreBytesGauge,
			pnpmStoreBudgetBytesGauge,
			pnpmStorePruneTotal,
			pnpmStoreEvictionTotal,
			workdirSweepSuccessTotal,
			workdirSweepFailuresTotal,
			reservationGauge,
			placementBlocked,
			listenerUpGauge,
			listenerRestarts,
			quiesceGenerationTimeouts,
			pendingRunnersGauge,
			githubUnavailableRunnersGauge,
			runnerStatusProbeUpGauge,
			fleetMaxRunnersGauge,
			checkpointWriteFailures,
			checkpointLastWriteTimestamp,
			checkpointRestoreStatus,
		)
	})
}

// startMetricsServer binds addr and serves /metrics, /healthz, and /readyz
// until ctx is done. It returns the actual bound address (which can differ
// from addr when addr's port is "0", e.g. in tests that need a free port
// rather than a fixed one) so callers -- and TestMetricsAndHealthzServer in
// particular -- never have to guess or hard-code a port. An empty addr
// disables the server (returns "", nil).
func startMetricsServer(ctx context.Context, addr string, logger *slog.Logger) (string, error) {
	if addr == "" {
		return "", nil
	}

	registerMetrics()

	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.Handler())
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("OK\n"))
	})
	mux.HandleFunc("/readyz", func(w http.ResponseWriter, r *http.Request) {
		ready := orchestratorSchedulerReady.Load()
		connected := int64(0)
		orchestratorListenerStates.Range(func(_, value any) bool {
			if up, _ := value.(bool); up {
				connected++
			}
			return true
		})
		if !ready || connected != orchestratorExpectedListeners.Load() {
			http.Error(w, "DEGRADED", http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("READY\n"))
	})

	// Listen synchronously (rather than inside srv.ListenAndServe(), which
	// would hide both the bound address and any bind failure inside the
	// goroutine below) so a caller can learn the real address -- including
	// the OS-assigned port when addr ends in ":0" -- before this function
	// returns, and so a bind failure surfaces here instead of only in a log
	// line after the fact.
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return "", fmt.Errorf("listening on %q: %w", addr, err)
	}
	boundAddr := ln.Addr().String()

	srv := &http.Server{
		Handler: mux,
	}

	go func() {
		logger.Info("Starting metrics and healthz HTTP server", slog.String("addr", boundAddr))
		if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("Metrics HTTP server error", slog.String("error", err.Error()))
		}
	}()

	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := srv.Shutdown(shutdownCtx); err != nil {
			logger.Error("Metrics HTTP server shutdown error", slog.String("error", err.Error()))
		}
	}()

	return boundAddr, nil
}

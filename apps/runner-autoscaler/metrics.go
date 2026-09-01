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
	// A lower-priority scale set yielded the next safe capacity slot while a
	// higher-priority scale set had pending demand and no runner of its own.
	// This is a scheduler decision, not a host admission failure.
	placementReasonPriorityReservation = "priority_reservation"
	// Every otherwise-eligible host lacked enough physical-memory budget for
	// the candidate's declared reservation after running and in-flight runner
	// reservations plus the configured safety margin were accounted for.
	placementReasonMemoryReservation = "memory_reservation"
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
)

// The complete set of `reason` label values runnerDiedIdleTotal and
// trackedRunnerMismatchTotal are ever incremented with, for the same bounded
// cardinality reason as the placementReason* constants above:
// reconcileTrackedRunners' own log message embeds a free-form container status
// string that must never reach a metric label directly.
const (
	runnerDeadReasonNotRunning = "not_running"
	runnerDeadReasonNotFound   = "not_found"
)

// The state label on trackedRunnerMismatchTotal reflects the authoritative
// in-memory state just before it was reconciled away. Keeping it bounded makes
// it possible to distinguish an exited busy runner (the #387 incident) from
// the existing idle-runner crash-loop signal.
const (
	runnerTrackedStateIdle = "idle"
	runnerTrackedStateBusy = "busy"
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
	trackedRunnerMismatchTotal = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "github_runner_autoscaler_tracked_runner_mismatch_total",
			Help: "Tracked runner entries reconciled because authoritative Docker state found their container stopped or missing, by scale set, host, tracked state, and reason.",
		},
		[]string{"scale_set", "host", "state", "reason"},
	)
	githubUnavailableRunnersReapedTotal = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "github_runner_autoscaler_github_unavailable_runners_reaped_total",
			Help: "Idle runner containers destroyed because GitHub reported them offline or stopped listing them for longer than the reap threshold, by scale set, host, and reason.",
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
	hostMemoryReservedGauge = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "github_runner_autoscaler_host_memory_reserved_bytes",
			Help: "Aggregate declared memory reservation of running and in-flight autoscaled runners on a host, observed during placement.",
		},
		[]string{"host"},
	)
	hostMemoryBudgetGauge = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "github_runner_autoscaler_host_memory_budget_bytes",
			Help: "Docker-reported physical host memory available to declared runner reservations after the configured safety margin.",
		},
		[]string{"host"},
	)
	scaleSetMemoryReservationGauge = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "github_runner_autoscaler_scale_set_memory_reservation_bytes",
			Help: "Per-runner memory reservation the scheduler charges against a host's budget when placing this scale set's runners; zero when the scale set is unbounded (agent-lcars#1683).",
		},
		[]string{"scale_set"},
	)
	scaleSetMemoryLimitGauge = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "github_runner_autoscaler_scale_set_memory_limit_bytes",
			Help: "Docker cgroup memory ceiling applied to each of this scale set's runner containers; zero when unbounded.",
		},
		[]string{"scale_set"},
	)
	scaleSetInfoGauge = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "github_runner_autoscaler_scale_set_info",
			Help: "Static description of a declared scale set: the registration and GitHub repository (owner/name) it serves. Always 1; join on repository against GitHub Actions queue metrics.",
		},
		[]string{"scale_set", "registration", "repository"},
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
	reservationGauge = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "github_runner_autoscaler_scheduler_reservations",
		Help: "In-flight runner start reservations by scale set and host.",
	}, []string{"scale_set", "host"})
	placementBlocked = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "github_runner_autoscaler_placement_blocked_total",
		Help: "Placement attempts blocked by a fleet scheduling invariant, by reason: " +
			placementReasonFleetLimit + ", " + placementReasonHostLimits + ", " +
			placementReasonMemoryReservation + ", " + placementReasonReadiness + ", " + placementReasonOverload + ", " +
			placementReasonPriorityReservation + ".",
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
	pendingSinceTimestampGauge = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "github_runner_autoscaler_scheduler_pending_since_timestamp_seconds",
		Help: "Unix timestamp when the current uninterrupted runner deficit began, or 0 when no runner is pending.",
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
	queueExecutorReadyGauge = prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "github_runner_autoscaler_queue_executor_ready",
		Help: "1 when the direct-runner queue executor has a complete configuration and a usable claim token source; 0 when disabled or misconfigured.",
	})
	queueExecutorStateGauge = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "github_runner_autoscaler_queue_executor_state",
		Help: "One-hot queue executor startup state: disabled, misconfigured, or ready.",
	}, []string{"state"})
	queueExecutorPollsTotal = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "github_runner_autoscaler_queue_executor_polls_total",
		Help: "Queue executor claim polls by non-claim outcome: draining, idle_204, idle_empty, or poll_error.",
	}, []string{"outcome"})
	queueExecutorClaimsTotal = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "github_runner_autoscaler_queue_executor_claims_total",
		Help: "Successful queue claims returned by the control plane before direct-runner launch.",
	})
	queueExecutorLaunchesTotal = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "github_runner_autoscaler_queue_executor_launches_total",
		Help: "Direct-runner launch attempts after a successful claim, by outcome: success or error.",
	}, []string{"outcome"})
	scheduleTicksTotal = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "github_runner_autoscaler_schedule_ticks_total",
		Help: "Server-owned Work API schedule tick attempts by outcome.",
	}, []string{"outcome"})
)

func setQueueExecutorStartupState(state queueExecutorStartupState) {
	for _, candidate := range []queueExecutorStartupState{
		queueExecutorStateDisabled,
		queueExecutorStateMisconfigured,
		queueExecutorStateReady,
	} {
		value := 0.0
		if candidate == state {
			value = 1
		}
		queueExecutorStateGauge.WithLabelValues(string(candidate)).Set(value)
	}
	if state == queueExecutorStateReady {
		queueExecutorReadyGauge.Set(1)
		return
	}
	queueExecutorReadyGauge.Set(0)
}

func recordQueueExecutorPollOutcome(outcome queuePollOutcome) {
	switch outcome {
	case queuePollOutcomeClaimed:
		queueExecutorLaunchesTotal.WithLabelValues("success").Inc()
	case queuePollOutcomeLaunchErr:
		queueExecutorLaunchesTotal.WithLabelValues("error").Inc()
	case queuePollOutcomeDraining, queuePollOutcomeIdle204, queuePollOutcomeIdleEmpty, queuePollOutcomePollError:
		queueExecutorPollsTotal.WithLabelValues(string(outcome)).Inc()
	}
}

func recordScheduleTick(success bool) {
	outcome := "error"
	if success {
		outcome = "success"
	}
	scheduleTicksTotal.WithLabelValues(outcome).Inc()
}

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
			trackedRunnerMismatchTotal,
			githubUnavailableRunnersReapedTotal,
			hostReachableGauge,
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
			hostMemoryReservedGauge,
			hostMemoryBudgetGauge,
			scaleSetMemoryReservationGauge,
			scaleSetMemoryLimitGauge,
			scaleSetInfoGauge,
			drainingGauge,
			drainAutoClearedTotal,
			placementDecisions,
			reservationGauge,
			placementBlocked,
			listenerUpGauge,
			listenerRestarts,
			quiesceGenerationTimeouts,
			pendingRunnersGauge,
			pendingSinceTimestampGauge,
			githubUnavailableRunnersGauge,
			runnerStatusProbeUpGauge,
			fleetMaxRunnersGauge,
			checkpointWriteFailures,
			checkpointLastWriteTimestamp,
			checkpointRestoreStatus,
			queueExecutorReadyGauge,
			queueExecutorStateGauge,
			queueExecutorPollsTotal,
			queueExecutorClaimsTotal,
			queueExecutorLaunchesTotal,
			scheduleTicksTotal,
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

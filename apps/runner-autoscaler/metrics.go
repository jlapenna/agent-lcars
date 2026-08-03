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
	reservationGauge = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "github_runner_autoscaler_scheduler_reservations",
		Help: "In-flight runner start reservations by scale set and host.",
	}, []string{"scale_set", "host"})
	placementBlocked = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "github_runner_autoscaler_placement_blocked_total",
		Help: "Placement attempts blocked by a fleet scheduling invariant, by reason: " +
			placementReasonFleetLimit + ", " + placementReasonHostLimits + ", " +
			placementReasonSharedWorkDirExclusive + ", " + placementReasonReadiness + ", " +
			placementReasonOverload + ".",
	}, []string{"scale_set", "reason"})
	listenerUpGauge = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "github_runner_autoscaler_listener_up",
		Help: "1 while the GitHub message listener for a scale set is connected and running.",
	}, []string{"scale_set"})
	listenerRestarts = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "github_runner_autoscaler_listener_restarts_total",
		Help: "Listener reconnection attempts after an unexpected failure.",
	}, []string{"scale_set"})
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
)

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
			placementDecisions,
			workdirBytesGauge,
			workdirSweptBytesTotal,
			reservationGauge,
			placementBlocked,
			listenerUpGauge,
			listenerRestarts,
			pendingRunnersGauge,
			githubUnavailableRunnersGauge,
			runnerStatusProbeUpGauge,
			fleetMaxRunnersGauge,
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

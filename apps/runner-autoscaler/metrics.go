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

var (
	metricsOnce                sync.Once
	orchestratorSchedulerReady atomic.Bool

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
		Help: "Queue executor claim polls by non-claim outcome: draining, capacity_wait, idle_204, idle_empty, or poll_error.",
	}, []string{"outcome"})
	queueExecutorClaimsTotal = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "github_runner_autoscaler_queue_executor_claims_total",
		Help: "Successful queue claims returned by the control plane before direct-runner launch, by provider pipeline.",
	}, []string{"pipeline"})
	queueExecutorLaunchesTotal = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "github_runner_autoscaler_queue_executor_launches_total",
		Help: "Direct-runner launch attempts after a successful claim, by outcome: success or error.",
	}, []string{"outcome"})
	queueExecutorHostUnreadyTotal = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "github_runner_autoscaler_queue_executor_host_unready_total",
		Help: "Capacity-reservation checks that skipped one host because its readiness probe failed or returned a value other than 1, by host. Incremented on every claim-poll tick that reaches a gated host, not only on a successful claim/launch.",
	}, []string{"host"})
	scheduleTicksTotal = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "github_runner_autoscaler_schedule_ticks_total",
		Help: "Server-owned Work API schedule tick attempts by outcome.",
	}, []string{"outcome"})
	maintenanceTicksTotal = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "github_runner_autoscaler_maintenance_ticks_total",
		Help: "Server-owned control-plane maintenance tick attempts by outcome.",
	}, []string{"outcome"})
	maintenanceLastSuccessTimestamp = prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "github_runner_autoscaler_maintenance_last_success_timestamp_seconds",
		Help: "Unix timestamp of the most recent successful control-plane maintenance tick.",
	})
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
	case queuePollOutcomeDraining, queuePollOutcomeCapacityWait, queuePollOutcomeIdle204, queuePollOutcomeIdleEmpty, queuePollOutcomePollError:
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

func recordMaintenanceTick(success bool) {
	outcome := "error"
	if success {
		outcome = "success"
		maintenanceLastSuccessTimestamp.SetToCurrentTime()
	}
	maintenanceTicksTotal.WithLabelValues(outcome).Inc()
}

func registerMetrics() {
	metricsOnce.Do(func() {
		prometheus.MustRegister(
			queueExecutorReadyGauge,
			queueExecutorStateGauge,
			queueExecutorPollsTotal,
			queueExecutorClaimsTotal,
			queueExecutorLaunchesTotal,
			queueExecutorHostUnreadyTotal,
			scheduleTicksTotal,
			maintenanceTicksTotal,
			maintenanceLastSuccessTimestamp,
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
		if !orchestratorSchedulerReady.Load() {
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

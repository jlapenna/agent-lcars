package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"sync/atomic"
	"syscall"
)

// runOrchestrator runs the LCARS queue executor and schedule ticker -- the
// whole of this process's job since homelab#1623 Phase 3 retired the custom
// GitHub Actions scale-set runner management (every lane now runs on Actions
// Runner Controller). It starts the metrics/healthz server, launches the
// queue executor's poller and the schedule ticker when their environment is
// configured, and then just watches for SIGUSR1 (pause/resume direct-runner
// claims), SIGHUP (revalidate the configuration file), and shutdown.
func runOrchestrator(ctx context.Context, resolved resolvedOrchestratorConfig) error {
	logger := slog.Default().With("component", "orchestrator")

	orchestratorSchedulerReady.Store(true)
	defer orchestratorSchedulerReady.Store(false)

	if _, err := startMetricsServer(ctx, resolved.Raw.Server.MetricsAddr, logger); err != nil {
		return fmt.Errorf("starting metrics server: %w", err)
	}

	statusPublisher, err := newConsoleStatusPublisher(ctx, logger)
	if err != nil {
		// Console observability is deliberately fail-soft: a bad/missing
		// telemetry credential must never keep an otherwise healthy queue
		// executor from claiming and launching direct runners.
		logger.Warn("Console status publication disabled; queue executor continues", slog.String("error", err.Error()))
		statusPublisher = noopConsoleStatusPublisher{}
	}
	defer func() { _ = statusPublisher.Close() }()

	// queueDraining pauses the queue executor's poller without touching the
	// rest of the process: SIGUSR1 toggles it (see the signal loop below).
	// This is the whole of what used to be the fleet-wide scale-set drain --
	// there is no scale-set listener left here to drain.
	var queueDraining atomic.Bool
	queueStatus := newQueueExecutorStatusSource(
		queueDraining.Load,
		logger.With("component", "queue-executor-status"),
	)
	// Publish even while disabled or misconfigured: a v2 queue-executor
	// snapshot says explicitly that no direct worker is ready, rather than
	// leaving a consumer unable to distinguish that condition from a stale
	// telemetry writer.
	go runQueueExecutorStatusPublisher(ctx, statusPublisher, queueStatus)
	go runARCLaneStatusPublisher(ctx, statusPublisher, resolved.Raw.ARCLanes, logger)

	// Native work items: the durable queue executor claims and launches direct
	// runners, while the schedule ticker calls the Work API's schedule route.
	// Both use the same server-owned API and Google ID-token path, but the
	// server grants work.executor and work.cron independently.
	// These values are read once at startup, not on SIGHUP: changing an
	// LCARS_QUEUE_*/LCARS_CONSOLE_URL/LCARS_WORK_AUDIENCE value, or the
	// kubernetes stanza, needs a full daemon restart rather than a
	// config-file replace-and-SIGHUP (see the SIGHUP case below).
	consoleURL := strings.TrimSpace(os.Getenv("LCARS_CONSOLE_URL"))
	keyPath := strings.TrimSpace(os.Getenv("GOOGLE_APPLICATION_CREDENTIALS"))
	startQueuePoller, queueStartupState, queueDisabledReason := queueExecutorStartupStatus(
		consoleURL,
		keyPath,
	)
	// Do not advertise ready merely because the process configuration parses:
	// direct work cannot be claimed until the Kubernetes preflight below has
	// proven the worker credentials, account, and API grants.
	if queueStartupState != queueExecutorStateReady {
		setQueueExecutorStartupState(queueStartupState)
	}
	if queueDisabledReason != "" {
		if queueStartupState == queueExecutorStateDisabled {
			logger.Info("Queue executor disabled", slog.String("reason", queueDisabledReason))
		} else {
			logger.Error("Queue executor misconfigured", slog.String("reason", queueDisabledReason))
		}
	}
	// Schedule ticking needs only the Console URL and the existing Google key;
	// it must not be coupled to the Kubernetes preflight. The cluster can be
	// temporarily unavailable while the server still safely owns schedule
	// admission and queue state.
	if consoleURL != "" && keyPath != "" {
		audience := queueExecutorAudience(os.Getenv("LCARS_WORK_AUDIENCE"))
		// Built once here, not per request: see newDirectRunnerIDTokenSource's
		// doc comment. A bad/missing key fails this the same way a bad
		// configuration fails startup elsewhere in this function -- loudly, at
		// startup, rather than silently every 15s.
		tokenSource, tokenErr := newDirectRunnerIDTokenSource(ctx, keyPath, audience)
		if tokenErr != nil {
			setQueueExecutorStartupState(queueExecutorStateMisconfigured)
			logger.Error("Queue executor disabled: could not build the claim ID token source", slog.Any("error", tokenErr))
		} else {
			// Schedule ticking needs no cluster access or provider credential.
			// Keep it independent from direct-runner launch preflight so a
			// temporary cluster fault cannot couple the two together. The API enforces the
			// distinct work.cron grant on this same Google identity.
			go runScheduleTicker(ctx, scheduleTickerConfig{
				consoleURL: consoleURL,
				idToken: func() (string, error) {
					return idTokenFromSource(tokenSource)
				},
			}, logger.With("component", "schedule-ticker"))

			if startQueuePoller {
				hostname, hostErr := os.Hostname()
				runnerName := queueExecutorRunnerName(hostname, hostErr)
				queue, err := newKubernetesQueue(ctx, *resolved.Raw.Kubernetes, logger)
				if err != nil {
					setQueueExecutorStartupState(queueExecutorStateMisconfigured)
					logger.Error("Queue executor Kubernetes preflight failed", slog.Any("error", err))
				} else {
					// Set before any goroutine can read the Job inventory.
					queue.exits = newRunExitReporter(consoleURL, runnerName, func() (string, error) {
						return idTokenFromSource(tokenSource)
					}, logger.With("component", "run-exit-reporter"))
					queue.claimSettled = queueClaimStatus(consoleURL, func() (string, error) {
						return idTokenFromSource(tokenSource)
					})
					queueStatus.configureCapacity(queue.config.MaxConcurrent, queue.activeCount)
					go queue.runPlacementObserver(ctx, queuePlacementReporter(consoleURL, func() (string, error) {
						return idTokenFromSource(tokenSource)
					}))
					setQueueExecutorStartupState(queueExecutorStateReady)
					queueStatus.ready.Store(true)
					go runQueueExecutorPoller(ctx, queueExecutorConfig{
						consoleURL: consoleURL, runnerName: runnerName,
						idToken: func() (string, error) { return idTokenFromSource(tokenSource) },
						reserve: func() (*directRunnerReservation, error) { return queue.reserve(ctx) },
						recover: queue.recover, cleanup: queue.cleanup, draining: queueDraining.Load,
					}, queueClaimPollInterval, logger)
				}
			}
		}
	} else if consoleURL != "" {
		logger.Error("Schedule ticker disabled: GOOGLE_APPLICATION_CREDENTIALS is required")
	}

	drainSignals := make(chan os.Signal, 1)
	reloadSignals := make(chan os.Signal, 1)
	signal.Notify(drainSignals, syscall.SIGUSR1)
	signal.Notify(reloadSignals, syscall.SIGHUP)
	defer signal.Stop(drainSignals)
	defer signal.Stop(reloadSignals)
	paused := false

	for {
		select {
		case <-ctx.Done():
			logger.Info("Shutting down queue executor")
			return nil
		case <-drainSignals:
			// Toggle, mirroring the fleet-wide drain's old "first SIGUSR1
			// begins, second SIGUSR1 ends" contract: a deploy script that
			// already sends SIGUSR1 once before replacing this container keeps
			// working unchanged, and an operator can still send a second one to
			// resume claims without a restart.
			paused = !paused
			queueDraining.Store(paused)
			if paused {
				logger.Info("Queue executor claims paused (SIGUSR1)")
			} else {
				logger.Info("Queue executor claims resumed (second SIGUSR1)")
			}
		case <-reloadSignals:
			// Every value the running executor uses was captured at startup, so
			// a reload only validates the replaced file and reports whether a
			// restart would accept it.
			if _, reloadErr := loadOrchestratorConfig(orchestratorConfigPath); reloadErr != nil {
				logger.Error("Configuration reload rejected", slog.Any("error", reloadErr))
				continue
			}
			logger.Info("Configuration file validated; restart the daemon to apply it")
		}
	}
}

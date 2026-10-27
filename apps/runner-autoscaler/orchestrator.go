package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"strings"
	"time"
)

// runOrchestrator runs the LCARS queue executor and schedule ticker -- the
// whole of this process's job since homelab#1623 Phase 3 retired the custom
// GitHub Actions scale-set runner management (every lane now runs on Actions
// Runner Controller). It starts the metrics/healthz server, launches the
// schedule ticker and the queue executor's poller, and then waits for
// shutdown. validateQueueExecutorEnvironment has already refused an
// unconfigured executor before this runs, so the only states here are
// misconfigured (a credential, token source or preflight failed) and ready.
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

	queueStatus := newQueueExecutorStatusSource(logger.With("component", "queue-executor-status"))
	// Publish even while misconfigured: a v2 queue-executor snapshot says
	// explicitly that no direct worker is ready, rather than leaving a
	// consumer unable to distinguish that condition from a stale telemetry
	// writer.
	go runQueueExecutorStatusPublisher(ctx, statusPublisher, queueStatus)
	go runARCLaneStatusPublisher(ctx, statusPublisher, resolved.Raw.ARCLanes, logger)

	// Native work items: the durable queue executor claims and launches direct
	// runners, while the schedule ticker calls the Work API's schedule route.
	// Both use the same server-owned API and Google ID-token path, but the
	// server grants work.executor and work.cron independently.
	// These values are read once at startup: changing an
	// LCARS_QUEUE_*/LCARS_CONSOLE_URL/LCARS_WORK_AUDIENCE value, or the
	// kubernetes stanza, needs a full daemon restart.
	consoleURL := strings.TrimSpace(os.Getenv("LCARS_CONSOLE_URL"))
	keyPath := strings.TrimSpace(os.Getenv("GOOGLE_APPLICATION_CREDENTIALS"))
	// Do not advertise ready merely because the process configuration parses:
	// direct work cannot be claimed until the Kubernetes preflight below has
	// proven the worker credentials, account, and API grants.
	setQueueExecutorStartupState(queueExecutorStateMisconfigured)
	audience := queueExecutorAudience(os.Getenv("LCARS_WORK_AUDIENCE"))
	// Built once here, not per request: see newDirectRunnerIDTokenSource's
	// doc comment. A bad/missing key fails this the same way a bad
	// configuration fails startup elsewhere in this function -- loudly, at
	// startup, rather than silently every 15s.
	tokenSource, tokenErr := newDirectRunnerIDTokenSource(ctx, keyPath, audience)
	if tokenErr != nil {
		logger.Error("Queue executor misconfigured: could not build the claim ID token source", slog.Any("error", tokenErr))
	} else {
		// Schedule ticking needs only the Console URL and the existing Google
		// key, no cluster access or provider credential. Keep it independent
		// from direct-runner launch preflight so a temporary cluster fault
		// cannot couple the two together: the server still safely owns schedule
		// admission and queue state. The API enforces the distinct work.cron
		// grant on this same Google identity.
		go runScheduleTicker(ctx, scheduleTickerConfig{
			consoleURL: consoleURL,
			idToken: func() (string, error) {
				return idTokenFromSource(tokenSource)
			},
		}, logger.With("component", "schedule-ticker"))

		hostname, hostErr := os.Hostname()
		runnerName := queueExecutorRunnerName(hostname, hostErr)
		queue, err := newKubernetesQueue(ctx, *resolved.Raw.Kubernetes, logger)
		if err != nil {
			logger.Error("Queue executor Kubernetes preflight failed", slog.Any("error", err))
		} else {
			// Set before any goroutine can read the Job inventory.
			queue.exits = newRunExitReporter(consoleURL, runnerName, func() (string, error) {
				return idTokenFromSource(tokenSource)
			}, logger.With("component", "run-exit-reporter"))
			queue.exits.sessions = newLostRunSessionEnder(statusPublisher, logger.With("component", "lost-run-sessions"))
			queue.reportStartupPlacement = queueStartupPlacementReporter(consoleURL, func() (string, error) { return idTokenFromSource(tokenSource) })
			queue.claimSettled = queueClaimStatus(consoleURL, func() (string, error) {
				return idTokenFromSource(tokenSource)
			})
			pollDone := make(chan struct{})
			if queue.config.Capacity != nil {
				queue.capacity = &queueCapacityClient{config: *queue.config.Capacity, namespace: queue.config.Namespace, maxConcurrent: queue.config.MaxConcurrent, consoleURL: consoleURL, producerID: newCapacityIdentity(), available: func(available bool) {
					queueStatus.ready.Store(available)
					if available {
						setQueueExecutorStartupState(queueExecutorStateReady)
					} else {
						setQueueExecutorStartupState(queueExecutorStateMisconfigured)
					}
				}, idToken: func() (string, error) { return idTokenFromSource(tokenSource) }}
				// The server endpoint owns global pool/domain occupancy.
				// Instance health must not multiply its capacity totals.
				defer func() {
					select {
					case <-pollDone:
					case <-time.After(35 * time.Second):
						logger.Warn("Receipt poller shutdown unproven")
						return
					}
					shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
					defer cancel()
					if err := queue.quiesceReceipts(shutdownCtx); err != nil {
						logger.Warn("Receipt producer quiescence unproven", slog.Any("error", err))
					}
				}()
			} else {
				queueStatus.configureCapacity(queue.config.MaxConcurrent, queue.activeCount)
			}
			// Only a writing publisher has somewhere to put the inventory.
			if hosts, ok := statusPublisher.(hostStatusPublisher); ok {
				go runHostStatusPublisher(ctx, hosts, queue.client, logger.With("component", "host-status"))
			}
			go queue.runPlacementObserver(ctx, queuePlacementReporter(consoleURL, func() (string, error) {
				return idTokenFromSource(tokenSource)
			}))
			setQueueExecutorStartupState(queueExecutorStateReady)
			queueStatus.ready.Store(queue.capacity == nil)
			go func() {
				defer close(pollDone)
				runQueueExecutorPoller(ctx, queueExecutorConfig{
					consoleURL: consoleURL, runnerName: runnerName, placementAware: true,
					idToken:  func() (string, error) { return idTokenFromSource(tokenSource) },
					reserve:  func() (*directRunnerReservation, error) { return queue.reserve(ctx) },
					capacity: queue.capacity, recover: queue.recover,
				}, queueClaimPollInterval, logger)
			}()
		}
	}

	<-ctx.Done()
	logger.Info("Shutting down queue executor")
	return nil
}

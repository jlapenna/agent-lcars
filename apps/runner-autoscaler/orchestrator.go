package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math/rand/v2"
	"os"
	"os/signal"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/actions/scaleset"
	"github.com/actions/scaleset/listener"
	dockerclient "github.com/docker/docker/client"
	"github.com/docker/go-units"
	"github.com/google/uuid"
)

type scaleSetRuntime struct {
	mu          sync.RWMutex
	config      Config
	scaler      *Scaler
	client      *scaleset.Client
	initialized bool
}

// runtimeGeneration owns all work that reads a particular resolved config.
// Stopping it before replacing the runtimes guarantees a reload never races a
// listener, sampler, or sweeper that still refers to the previous settings.
type runtimeGeneration struct {
	cancel context.CancelFunc
	done   <-chan struct{}
}

func runOrchestrator(ctx context.Context, resolved resolvedOrchestratorConfig) error {
	logger := resolved.ScaleSets[0].Logger().With("component", "orchestrator")
	placementHosts, err := newDockerHostPool(resolved.DockerHosts)
	if err != nil {
		return fmt.Errorf("connecting fleet docker hosts: %w", err)
	}
	fleet := newFleetCoordinator(0, nil, nil, nil)
	configureFleet(fleet, resolved)
	managedHosts := placementHosts

	// Load before building runtimes: the scalers consult their slice of it
	// during cleanupOrphans' boot pass. A missing file is a normal first
	// boot; a corrupt or wrong-version one is logged and then treated the
	// same way, falling adoption back to the ContainerTop probe rather than
	// refusing to start over state the fleet can survive without.
	checkpoints := newCheckpointStore(resolved.Raw.Server.StatePath, logger)
	restored, loadErr := loadCheckpoint(resolved.Raw.Server.StatePath)
	switch {
	case loadErr != nil:
		setCheckpointRestoreStatus(checkpointRestoreUnreadable)
		logger.Error("Ignoring unreadable control-plane checkpoint; adopting runners from Docker instead",
			slog.String("path", resolved.Raw.Server.StatePath), slog.Any("error", loadErr))
	case restored == nil:
		setCheckpointRestoreStatus(checkpointRestoreAbsent)
		logger.Info("No control-plane checkpoint found; this is a first boot for this state path",
			slog.String("path", resolved.Raw.Server.StatePath))
	default:
		setCheckpointRestoreStatus(checkpointRestoreRestored)
		fleet.restore(restored.Fleet, time.Now())
		logger.Info("Restored control-plane checkpoint",
			slog.Time("written_at", restored.WrittenAt), slog.Int("scale_sets", len(restored.ScaleSets)))
	}

	runtimes, err := buildOrchestratorRuntimes(resolved, managedHosts, placementHosts, fleet, checkpoints, restored)
	if err != nil {
		return err
	}
	statusPublisher, err := newConsoleStatusPublisher(ctx, logger)
	if err != nil {
		// Console observability is deliberately fail-soft: a bad/missing
		// telemetry credential must never keep an otherwise healthy runner
		// fleet from accepting GitHub work.
		logger.Warn("Console status publication disabled; runner placement continues", slog.String("error", err.Error()))
		statusPublisher = noopConsoleStatusPublisher{}
	}
	defer func() { _ = statusPublisher.Close() }()
	checkpoints.setSnapshot(orchestratorSnapshot(runtimes, fleet))
	pullConfiguredRunnerImages(ctx, placementHosts, resolved.ScaleSets, logger)

	orchestratorSchedulerReady.Store(true)
	defer orchestratorSchedulerReady.Store(false)

	if _, err := startMetricsServer(ctx, resolved.Raw.Server.MetricsAddr, logger); err != nil {
		return fmt.Errorf("starting metrics server: %w", err)
	}

	generation := startRuntimeGeneration(ctx, runtimes, logger, statusPublisher)

	// queueDraining mirrors the fleet's own SIGUSR1 drain flag for the queue
	// executor's poller goroutine below: a claim minted moments before this
	// instance is replaced is just another launch failure to recover from
	// (see queueExecutorConfig.launch's doc comment), so a drain stops the
	// poller from claiming at all -- the same "stop accepting new work"
	// BeginDrain already gives every GitHub-mode scale set. atomic because
	// it is written only by this function's own select loop below (the
	// SIGUSR1 case, and the drain watchdog's self-heal branch) and read
	// only by the poller goroutine, which run concurrently. Live config
	// reloads (SIGHUP) do NOT reach the poller at all -- see this block's
	// own comment just below, and the README's "Queue executor" section.
	var queueDraining atomic.Bool
	queueStatus := newQueueExecutorStatusSource(
		resolved,
		queueDraining.Load,
		newDockerClient,
		logger.With("component", "queue-executor-status"),
	)
	// Publish even while disabled or misconfigured: a v2 queue-executor
	// snapshot says explicitly that no direct worker is ready, rather than
	// leaving a consumer unable to distinguish that condition from a stale
	// telemetry writer. It shares the existing bounded runner-status store.
	go runQueueExecutorStatusPublisher(ctx, statusPublisher, queueStatus)

	// Native work items queue executor: a durable goroutine that polls the
	// console's run-claim API and launches direct-mode containers, entirely
	// outside the GitHub scale-set state machine above. It starts whenever
	// its console and credential configuration is complete; the console's
	// authenticated work.executor grant is the sole claim capability source.
	// These values are read once at startup, not on SIGHUP, so changing an
	// LCARS_QUEUE_*/LCARS_CONSOLE_URL/LCARS_WORK_AUDIENCE value (or the Docker
	// host pool launchDirectRunner reads from `resolved`) needs a full daemon
	// restart rather than a config-file replace-and-SIGHUP.
	consoleURL := strings.TrimSpace(os.Getenv("LCARS_CONSOLE_URL"))
	keyPath := strings.TrimSpace(os.Getenv("GOOGLE_APPLICATION_CREDENTIALS"))
	startQueuePoller, queueStartupState, queueDisabledReason := queueExecutorStartupStatus(
		consoleURL,
		keyPath,
		os.Getenv("LCARS_QUEUE_TELEMETRY_WRITER_HOST_PATH"),
	)
	setQueueExecutorStartupState(queueStartupState)
	if queueDisabledReason != "" {
		if queueStartupState == queueExecutorStateDisabled {
			logger.Info("Queue executor disabled", slog.String("reason", queueDisabledReason))
		} else {
			logger.Error("Queue executor misconfigured", slog.String("reason", queueDisabledReason))
		}
	}
	if startQueuePoller {
		audience := queueExecutorAudience(os.Getenv("LCARS_WORK_AUDIENCE"))
		hostname, hostErr := os.Hostname()
		runnerName := queueExecutorRunnerName(hostname, hostErr)
		// Captured by value at startup, not read from the outer `resolved`
		// directly: a config reload later in this function's select loop
		// reassigns `resolved` from this same goroutine, and closing over
		// that variable instead of a snapshot would race the poller
		// goroutine's reads of it.
		queueExecutorResolved := resolved
		// Built once here, not per poll: see newDirectRunnerIDTokenSource's
		// doc comment. A bad/missing key fails this the same way a bad
		// GitHub credential fails registration elsewhere in this
		// function -- loudly, at startup, rather than silently every 15s.
		tokenSource, tokenErr := newDirectRunnerIDTokenSource(ctx, keyPath, audience)
		if tokenErr != nil {
			setQueueExecutorStartupState(queueExecutorStateMisconfigured)
			logger.Error("Queue executor disabled: could not build the claim ID token source", slog.Any("error", tokenErr))
		} else {
			queueStatus.ready.Store(true)
			go runQueueExecutorPoller(ctx, queueExecutorConfig{
				consoleURL: consoleURL,
				runnerName: runnerName,
				idToken: func() (string, error) {
					return idTokenFromSource(tokenSource)
				},
				launch: func(l directRunnerLaunch) error {
					return launchDirectRunner(ctx, queueExecutorResolved, l, logger)
				},
				draining: queueDraining.Load,
				cleanup: func(cleanupCtx context.Context) error {
					return cleanupExitedDirectRunners(cleanupCtx, queueExecutorResolved, newDockerClient, time.Now())
				},
			}, 15*time.Second, logger)
		}
	}

	drainSignals := make(chan os.Signal, 1)
	reloadSignals := make(chan os.Signal, 1)
	signal.Notify(drainSignals, syscall.SIGUSR1)
	signal.Notify(reloadSignals, syscall.SIGHUP)
	defer signal.Stop(drainSignals)
	defer signal.Stop(reloadSignals)
	draining := false
	// drainZeroSince tracks how long the fleet has sat globally drained with
	// zero runners across every scale set; see drainStuckTimeout's doc
	// comment for why this decision must be fleet-wide rather than made
	// independently by each Scaler. Read and written only by this loop.
	var drainZeroSince time.Time
	drainWatchdog := time.NewTicker(drainWatchdogInterval)
	defer drainWatchdog.Stop()
	checkpointTicker := time.NewTicker(checkpointFlushInterval)
	defer checkpointTicker.Stop()

	for {
		select {
		case <-ctx.Done():
			quiesce(ctx, generation, runtimes, checkpoints, logger)
			return nil
		case <-checkpointTicker.C:
			// Runner transitions checkpoint synchronously; this tick exists
			// only to keep the fleet telemetry half (overload cooldowns, host
			// samples) reasonably fresh.
			checkpoints.flush()
		case <-drainSignals:
			if draining {
				continue
			}
			draining = true
			queueDraining.Store(true)
			drainZeroSince = time.Time{}
			logger.Info("Global drain requested")
			for _, runtime := range runtimes {
				runtime.scaler.BeginDrain(context.WithoutCancel(ctx))
			}
		case <-drainWatchdog.C:
			now := time.Now()
			nextZeroSince, selfHeal := drainWatchdogTick(draining, fleetRunnerCount(runtimes), drainZeroSince, now)
			stuckFor := now.Sub(drainZeroSince)
			drainZeroSince = nextZeroSince
			if !selfHeal {
				continue
			}
			draining = false
			queueDraining.Store(false)
			for _, runtime := range runtimes {
				runtime.scaler.EndDrain()
			}
			logger.Warn("Fleet drain self-healed after sitting at zero runners past the stuck timeout; a deploy was likely interrupted before its recreate step",
				slog.Duration("stuck_for", stuckFor))
		case <-reloadSignals:
			next, reloadErr := loadOrchestratorConfig(orchestratorConfigPath)
			if reloadErr == nil {
				reloadErr = next.loadCredentials()
			}
			if reloadErr == nil {
				reloadErr = validateReloadCompatibility(resolved, next)
			}
			if reloadErr != nil {
				logger.Error("Configuration reload rejected; keeping current configuration", slog.Any("error", reloadErr))
				continue
			}
			nextPlacementHosts, poolErr := newDockerHostPool(next.DockerHosts)
			if poolErr != nil {
				logger.Error("Configuration reload rejected; keeping current configuration", slog.Any("error", poolErr))
				continue
			}

			// The old generation is stopped, but no runner is drained or
			// removed. The new scalers adopt the still-running containers
			// during initialization before accepting new work.
			generation.cancel()
			<-generation.done
			nextManagedHosts := mergeDockerHosts(nextPlacementHosts, managedHosts, trackedRunnerHosts(runtimes))
			configureFleet(fleet, next)
			// Hand the outgoing generation's live state to the replacement
			// scalers as their adoption source. A reload re-adopts through
			// the same cleanupOrphans boot pass a restart uses, so without
			// this it would re-derive idle/busy from the ContainerTop probe
			// and inherit the same misclassification -- despite the answer
			// being known exactly, in memory, microseconds earlier.
			handover := orchestratorSnapshot(runtimes, fleet)()
			nextRuntimes, buildErr := buildOrchestratorRuntimes(next, nextManagedHosts, nextPlacementHosts, fleet, checkpoints, &handover)
			if buildErr != nil {
				// This should be impossible after loadOrchestratorConfig and
				// compatibility validation. Keep the old config live if an
				// internal construction error nevertheless occurs.
				logger.Error("Configuration reload could not build runtimes; restoring current configuration", slog.Any("error", buildErr))
				closeDockerHostClients(nextPlacementHosts)
				configureFleet(fleet, resolved)
				generation = startRuntimeGeneration(ctx, runtimes, logger, statusPublisher)
				continue
			}
			closeUnusedDockerHostClients(managedHosts, nextManagedHosts)
			resolved, runtimes = next, nextRuntimes
			checkpoints.setSnapshot(orchestratorSnapshot(runtimes, fleet))
			managedHosts, placementHosts = nextManagedHosts, nextPlacementHosts
			logger = resolved.ScaleSets[0].Logger().With("component", "orchestrator")
			pullConfiguredRunnerImages(ctx, placementHosts, resolved.ScaleSets, logger)
			if draining {
				// The replacement scalers re-adopt already-running containers
				// during initialization (see initializeGitHubScaleSet), which
				// takes a moment and would otherwise read as a momentary,
				// spurious fleet-wide zero. Restart the stuck-drain clock so
				// the watchdog measures from after adoption, not before it.
				drainZeroSince = time.Time{}
				for _, runtime := range runtimes {
					runtime.scaler.BeginDrain(context.WithoutCancel(ctx))
				}
			}
			generation = startRuntimeGeneration(ctx, runtimes, logger, statusPublisher)
			logger.Info("Configuration reloaded without draining runners")
		}
	}
}

// orchestratorSnapshot builds the closure the checkpoint store flushes. It
// reads whichever runtimes are live when it runs, so a config reload replaces
// it rather than leaving the store writing a stale generation's runners.
func orchestratorSnapshot(runtimes []*scaleSetRuntime, fleet *FleetCoordinator) func() checkpointFile {
	return func() checkpointFile {
		cp := checkpointFile{
			Version:   checkpointVersion,
			WrittenAt: time.Now(),
			ScaleSets: make(map[string]checkpointScaleSet, len(runtimes)),
			Fleet:     fleet.snapshot(),
		}
		for _, runtime := range runtimes {
			cp.ScaleSets[runtime.config.ScaleSetName] = runtime.scaler.snapshotRunners()
		}
		return cp
	}
}

// quiesceTimeout bounds how long shutdown waits for the runtime generation to
// unwind before checkpointing and exiting anyway. It sits well inside Docker's
// default 10s stop grace period: overrunning that grace turns an orderly exit
// into a SIGKILL, which would discard the very checkpoint this path exists to
// write. Listeners that have not noticed cancellation by then are abandoned
// rather than waited on -- their work is a long-poll against GitHub, and the
// replacement process re-establishes it regardless.
const (
	quiesceTimeout = 3 * time.Second
	// Leave enough of the quiesce window for the generation wait to observe
	// the listener exiting and for the checkpoint write itself. Session close
	// survives cancellation of the listener context, but it must not outlive
	// the shutdown budget it is part of.
	sessionCloseTimeout = quiesceTimeout - 500*time.Millisecond
)

// quiesce is the fast shutdown path, and the reason an aggressive restart no
// longer needs a fleet drain. It stops accepting new work, gives in-flight
// control-plane operations a bounded moment to settle, writes the checkpoint,
// and returns.
//
// It deliberately does NOT remove idle runners, which is what SIGTERM used to
// do. An idle runner is a warm, already-registered container: destroying it
// throws away capacity the replacement process could adopt in milliseconds,
// and doing so was pure loss once the checkpoint made adoption reliable.
// Busy runners were already preserved for adoption; now idle ones are too.
//
// Draining the fleet (SIGUSR1) remains available for the cases that genuinely
// need an empty fleet -- removing a scale set, decommissioning a host -- and
// is unchanged.
func quiesce(ctx context.Context, generation runtimeGeneration, runtimes []*scaleSetRuntime, checkpoints *checkpointStore, logger *slog.Logger) {
	quiesceWithGenerationTimeout(ctx, generation, runtimes, checkpoints, logger, time.After(quiesceTimeout))
}

// quiesceWithGenerationTimeout keeps quiesce's production timeout policy
// explicit while allowing the hung-generation behavior to be exercised without
// a wall-clock-sensitive test sleep.
func quiesceWithGenerationTimeout(ctx context.Context, generation runtimeGeneration, runtimes []*scaleSetRuntime, checkpoints *checkpointStore, logger *slog.Logger, generationTimeout <-chan time.Time) {
	started := time.Now()
	logger.Info("Quiescing control plane; preserving all runners for adoption by the next instance")

	// Refuse new placements first, so nothing new is created during the
	// window between cancelling the generation and writing the checkpoint.
	for _, runtime := range runtimes {
		runtime.scaler.stopPlacing()
	}
	generation.cancel()

	select {
	case <-generation.done:
	case <-generationTimeout:
		quiesceGenerationTimeouts.Inc()
		logger.Warn("Runtime generation did not stop within the quiesce timeout; checkpointing and exiting anyway",
			slog.Duration("timeout", quiesceTimeout))
	}

	checkpoints.flush()
	logger.Info("Control plane quiesced", slog.Duration("took", time.Since(started)))
}

func buildOrchestratorRuntimes(resolved resolvedOrchestratorConfig, dockerHosts, placementHosts []DockerHost, fleet *FleetCoordinator, checkpoints *checkpointStore, restored *checkpointFile) ([]*scaleSetRuntime, error) {
	runtimes := make([]*scaleSetRuntime, 0, len(resolved.ScaleSets))
	for _, base := range resolved.ScaleSets {
		c := base
		c.DockerHosts = append([]string(nil), resolved.DockerHosts...)
		c.SparkMetricsURL = resolved.Raw.Fleet.Placement.SparkMetricsURL
		c.HostMetricsURLTemplate = resolved.Raw.Fleet.Placement.HostMetricsURLTemplate
		c.HostMetricsTimeouts = make(map[string]time.Duration, len(resolved.HostMetricsTimeouts))
		for host, timeout := range resolved.HostMetricsTimeouts {
			c.HostMetricsTimeouts[host] = timeout
		}
		c.HostLoadPolicy = resolved.Placement
		c.HostMemoryExempt = append([]string(nil), resolved.Raw.Fleet.Placement.HostMemoryExempt...)
		c.ReadinessMetricsURL = resolved.Raw.Fleet.Placement.ReadinessMetricsURL
		c.ReadinessMetric = resolved.Raw.Fleet.Placement.ReadinessMetric
		c.ReadinessMaxAge = resolved.ReadinessMaxAge
		runtime, err := buildScaleSetRuntime(c, dockerHosts, placementHosts, fleet, checkpoints, restored.runners(c.ScaleSetName))
		if err != nil {
			return nil, fmt.Errorf("initializing scale set %q: %w", c.ScaleSetName, err)
		}
		runtimes = append(runtimes, runtime)
	}
	return runtimes, nil
}

// mergeDockerHosts returns the new placement pool plus any removed host that
// still owns a tracked runner. A retained host is no longer a placement
// candidate, but the replacement scaler needs its client to adopt the runner
// and remove it normally on JobCompleted.
func mergeDockerHosts(next, previous []DockerHost, retain map[string]bool) []DockerHost {
	merged := append([]DockerHost(nil), next...)
	known := make(map[string]bool, len(merged))
	for _, host := range merged {
		known[host.Name] = true
	}
	for _, host := range previous {
		if retain[host.Name] && !known[host.Name] {
			merged = append(merged, host)
			known[host.Name] = true
		}
	}
	return merged
}

func trackedRunnerHosts(runtimes []*scaleSetRuntime) map[string]bool {
	hosts := map[string]bool{}
	for _, runtime := range runtimes {
		for host := range runtime.scaler.runners.hosts() {
			hosts[host] = true
		}
	}
	return hosts
}

func closeUnusedDockerHostClients(previous, next []DockerHost) {
	keep := map[*dockerclient.Client]bool{}
	for _, host := range next {
		keep[host.Client] = true
	}
	closed := map[*dockerclient.Client]bool{}
	for _, host := range previous {
		if host.Client != nil && !keep[host.Client] && !closed[host.Client] {
			_ = host.Client.Close()
			closed[host.Client] = true
		}
	}
}

func closeDockerHostClients(hosts []DockerHost) {
	closeUnusedDockerHostClients(hosts, nil)
}

func configureFleet(fleet *FleetCoordinator, resolved resolvedOrchestratorConfig) {
	order := make([]string, 0, len(resolved.ScaleSets))
	for _, c := range resolved.ScaleSets {
		order = append(order, c.ScaleSetName)
	}
	fleet.mu.Lock()
	fleet.maxRunners = resolved.Raw.Fleet.MaxRunners
	fleet.hostRunnerLimits = resolved.RunnerLimits
	fleet.mainsRequired = resolved.MainsRequired
	fleet.metricsViaSSH = resolved.MetricsViaSSH
	fleet.readinessRequired = resolved.ReadinessRequired
	fleet.gate = newWeightedPlacementGate(resolved.Weights, order)
	fleet.mu.Unlock()
	fleetMaxRunnersGauge.Set(float64(resolved.Raw.Fleet.MaxRunners))
}

func pullConfiguredRunnerImages(ctx context.Context, dockerHosts []DockerHost, scaleSets []Config, logger *slog.Logger) {
	seenImages := map[string]bool{}
	for _, c := range scaleSets {
		if !seenImages[c.RunnerImage] {
			seenImages[c.RunnerImage] = true
			go pullRunnerImages(ctx, dockerHosts, c.RunnerImage, logger)
		}
	}
}

// validateReloadCompatibility rejects changes that would leave existing
// runner containers ambiguous. Docker hosts may change: removed hosts are
// cordoned and retained only while they own tracked runners. The metrics bind
// is a process-lifetime resource, and removing or moving a scale set could
// orphan containers that are still executing jobs.
func validateReloadCompatibility(current, next resolvedOrchestratorConfig) error {
	if current.Raw.Server.MetricsAddr != next.Raw.Server.MetricsAddr {
		return fmt.Errorf("server.metrics_addr cannot change during a live reload")
	}
	// The checkpoint store binds its path once at startup, so a reload that
	// moved it would leave every subsequent checkpoint going to the OLD file
	// while the config claimed otherwise -- and a later restart would then
	// adopt from a path nothing had written since the reload. Process-lifetime
	// for the same reason metrics_addr is: the resource is bound before the
	// reload path can reach it.
	if current.Raw.Server.StatePath != next.Raw.Server.StatePath {
		return fmt.Errorf("server.state_path cannot change during a live reload")
	}
	currentTargets, _, _ := ParseDockerHosts(current.DockerHosts)
	nextTargets, _, _ := ParseDockerHosts(next.DockerHosts)
	for name, currentTarget := range currentTargets {
		if nextTarget, ok := nextTargets[name]; ok && nextTarget != currentTarget {
			return fmt.Errorf("fleet host %q cannot change Docker transport during a live reload; remove it and add the replacement with a new name", name)
		}
	}
	nextByName := make(map[string]Config, len(next.ScaleSets))
	for _, c := range next.ScaleSets {
		nextByName[c.ScaleSetName] = c
	}
	for _, currentSet := range current.ScaleSets {
		nextSet, ok := nextByName[currentSet.ScaleSetName]
		if !ok {
			return fmt.Errorf("scale set %q cannot be removed during a live reload", currentSet.ScaleSetName)
		}
		if currentSet.RegistrationName != nextSet.RegistrationName || currentSet.RegistrationURL != nextSet.RegistrationURL || currentSet.RunnerGroup != nextSet.RunnerGroup {
			return fmt.Errorf("scale set %q cannot change GitHub registration or runner group during a live reload", currentSet.ScaleSetName)
		}
	}
	return nil
}

func startRuntimeGeneration(parent context.Context, runtimes []*scaleSetRuntime, logger *slog.Logger, statusPublisher consoleStatusPublisher) runtimeGeneration {
	ctx, cancel := context.WithCancel(parent)
	var wg sync.WaitGroup
	orchestratorExpectedListeners.Store(int64(len(runtimes)))
	// All scalers share the coordinator's telemetry maps, so exactly one
	// sampler populates fleet load/cooldown state for every listener.
	wg.Add(1)
	go func() { defer wg.Done(); runtimes[0].scaler.RunHostSampler(ctx) }()
	wg.Add(1)
	go func() { defer wg.Done(); runConsoleStatusPublisher(ctx, runtimes, statusPublisher) }()
	wg.Add(1)
	go func() { defer wg.Done(); runFleetOrphanSweeper(ctx, runtimes) }()
	wg.Add(1)
	go func() { defer wg.Done(); runFleetTrackedRunnerReconciler(ctx, runtimes) }()
	startGitHubRunnerStatusMonitors(ctx, runtimes, logger, &wg)
	for _, runtime := range runtimes {
		wg.Add(1)
		go func(rt *scaleSetRuntime) { defer wg.Done(); runListenerSupervisor(ctx, rt, logger) }(runtime)
	}
	done := make(chan struct{})
	go func() { wg.Wait(); close(done) }()
	return runtimeGeneration{cancel: cancel, done: done}
}

func buildScaleSetRuntime(c Config, dockerHosts, placementHosts []DockerHost, fleet *FleetCoordinator, checkpoints *checkpointStore, boot map[string]checkpointRunner) (*scaleSetRuntime, error) {
	if err := c.Validate(); err != nil {
		return nil, err
	}
	logger := c.Logger().With("scale_set", c.ScaleSetName, "registration", c.RegistrationName)
	memory := int64(0)
	var err error
	if c.RunnerMemory != "" {
		memory, err = units.RAMInBytes(c.RunnerMemory)
		if err != nil {
			return nil, err
		}
	}
	shmSize := int64(0)
	if c.RunnerShmSize != "" {
		shmSize, err = units.RAMInBytes(c.RunnerShmSize)
		if err != nil {
			return nil, err
		}
	}
	scaler := &Scaler{
		scaleSetName: c.ScaleSetName, registrationName: c.RegistrationName, registrationURL: c.RegistrationURL, logger: logger.With("component", "scaler"),
		runners:     runnerState{idle: map[string]runnerRef{}, busy: map[string]runnerRef{}},
		runnerImage: c.RunnerImage, runnerMemory: memory, runnerPidsLimit: c.RunnerPidsLimit, runnerShmSize: shmSize,
		minRunners: c.MinRunners, maxRunners: c.MaxRunners,
		dockerHosts: dockerHosts, placementHosts: placementHosts, fileMounts: c.FileMounts,
		sparkMetricsURL: c.SparkMetricsURL, hostMetricsURLTemplate: c.HostMetricsURLTemplate,
		hostLoadPolicy:      c.HostLoadPolicy,
		hostMetricsTimeouts: c.HostMetricsTimeouts,
		hostMemoryExempt:    stringSet(c.HostMemoryExempt),
		readinessMetricsURL: c.ReadinessMetricsURL,
		readinessMetric:     c.ReadinessMetric,
		readinessMaxAge:     c.ReadinessMaxAge,
		hostRunnerLimits:    fleet.hostRunnerLimits,
		fleet:               fleet,
		checkpoints:         checkpoints, bootCheckpoint: boot,
	}
	drainingGauge.WithLabelValues(c.ScaleSetName).Set(0)
	listenerUpGauge.WithLabelValues(c.ScaleSetName).Set(0)
	return &scaleSetRuntime{config: c, scaler: scaler}, nil
}

func initializeGitHubScaleSet(ctx context.Context, runtime *scaleSetRuntime) error {
	client, err := runtime.config.ScalesetClient()
	if err != nil {
		return err
	}
	runnerGroupID := 1
	if runtime.config.RunnerGroup != scaleset.DefaultRunnerGroup {
		group, groupErr := client.GetRunnerGroupByName(ctx, runtime.config.RunnerGroup)
		if groupErr != nil {
			return groupErr
		}
		runnerGroupID = group.ID
	}
	set, err := client.GetRunnerScaleSet(ctx, runnerGroupID, runtime.config.ScaleSetName)
	if err != nil {
		return err
	}
	if set == nil {
		set, err = client.CreateRunnerScaleSet(ctx, &scaleset.RunnerScaleSet{
			Name: runtime.config.ScaleSetName, RunnerGroupID: runnerGroupID, Labels: runtime.config.BuildLabels(),
			RunnerSetting: scaleset.RunnerSetting{DisableUpdate: true},
		})
		if err != nil {
			return err
		}
		runtime.scaler.logger.Info("Created runner scale set", slog.Int("scaleSetID", set.ID))
	} else {
		warnIfAdoptedLabelsDiffer(runtime.scaler.logger, set.Labels, runtime.config.BuildLabels())
		runtime.scaler.logger.Info("Adopted runner scale set", slog.Int("scaleSetID", set.ID))
	}
	client.SetSystemInfo(systemInfo(set.ID))
	runtime.mu.Lock()
	runtime.client = client
	runtime.scaler.scalesetClient = client
	runtime.scaler.scaleSetID = set.ID
	runtime.initialized = true
	runtime.mu.Unlock()
	runtime.scaler.cleanupOrphans(ctx, true)
	// A config reload can occur while SIGUSR1 drain is already active. The
	// replacement scaler adopts runners after runOrchestrator reapplies the
	// drain flag, so remove any newly adopted idle capacity here rather than
	// leaving it behind until GitHub happens to send another desired-count
	// message. Busy runners remain protected by removeIdleRunners.
	if runtime.scaler.draining.Load() {
		runtime.scaler.removeIdleRunners(context.WithoutCancel(ctx))
	}
	return nil
}

type messageSessionCloser interface {
	Close(context.Context) error
}

// closeMessageSession gives GitHub a fresh, bounded window to release the
// server-side owner after listener cancellation. WithoutCancel is intentional:
// the listener's parent is already cancelled when orderly shutdown reaches
// this point, but carrying that cancellation into Close would prevent the
// release attempt entirely.
func closeMessageSession(ctx context.Context, session messageSessionCloser, timeout time.Duration) error {
	closeCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), timeout)
	defer cancel()
	return session.Close(closeCtx)
}

func runListenerSupervisor(ctx context.Context, runtime *scaleSetRuntime, logger *slog.Logger) {
	backoff := time.Second
	owner, err := os.Hostname()
	if err != nil {
		owner = uuid.NewString()
	}
	owner += "-" + runtime.config.ScaleSetName
	for ctx.Err() == nil {
		runtime.mu.RLock()
		initialized, client := runtime.initialized, runtime.client
		runtime.mu.RUnlock()
		var sessionErr error
		if !initialized {
			sessionErr = initializeGitHubScaleSet(ctx, runtime)
			runtime.mu.RLock()
			client = runtime.client
			runtime.mu.RUnlock()
		}
		if sessionErr != nil {
			listenerUpGauge.WithLabelValues(runtime.config.ScaleSetName).Set(0)
			orchestratorListenerStates.Store(runtime.config.ScaleSetName, false)
		} else {
			session, err := client.MessageSessionClient(ctx, runtime.scaler.scaleSetID, owner)
			sessionErr = err
			if sessionErr == nil {
				setListener, listenerErr := listener.New(session, listener.Config{
					ScaleSetID: runtime.scaler.scaleSetID,
					MaxRunners: runtime.config.MaxRunners,
					Logger:     runtime.scaler.logger.With("component", "listener"),
				})
				if listenerErr == nil {
					listenerUpGauge.WithLabelValues(runtime.config.ScaleSetName).Set(1)
					orchestratorListenerStates.Store(runtime.config.ScaleSetName, true)
					listenerErr = setListener.Run(ctx, runtime.scaler)
				}
				listenerUpGauge.WithLabelValues(runtime.config.ScaleSetName).Set(0)
				orchestratorListenerStates.Store(runtime.config.ScaleSetName, false)
				_ = closeMessageSession(ctx, session, sessionCloseTimeout)
				sessionErr = listenerErr
			}
		}
		if ctx.Err() != nil || errors.Is(sessionErr, context.Canceled) {
			return
		}
		listenerRestarts.WithLabelValues(runtime.config.ScaleSetName).Inc()
		orchestratorListenerStates.Store(runtime.config.ScaleSetName, false)
		logger.Error("Scale-set listener failed; other listeners remain active",
			slog.String("scale_set", runtime.config.ScaleSetName), slog.Any("error", sessionErr), slog.Duration("retry_in", backoff))
		jitter := 0.8 + rand.Float64()*0.4
		timer := time.NewTimer(time.Duration(float64(backoff) * jitter))
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
		backoff = min(time.Minute, backoff*2)
	}
}

func runFleetOrphanSweeper(ctx context.Context, runtimes []*scaleSetRuntime) {
	ticker := time.NewTicker(orphanSweepInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			for _, runtime := range runtimes {
				runtime.mu.RLock()
				initialized := runtime.initialized
				runtime.mu.RUnlock()
				if initialized {
					runtime.scaler.cleanupOrphans(ctx, false)
				}
			}
		}
	}
}

// trackedRunnerReconcileInterval bounds how long a stale checkpoint/runtime
// entry can suppress placement when GitHub has no completion event to deliver.
// It is intentionally much shorter than orphanSweepInterval: this loop is a
// read-only Docker inspect pass over the already-tracked (and fleet-bounded)
// set, whereas orphan cleanup lists and may remove every owned container.
const trackedRunnerReconcileInterval = time.Minute

// runFleetTrackedRunnerReconciler continuously compares each initialized scale
// set's in-memory map with Docker. Run once immediately so a checkpoint that
// retained a container which exited during a restart cannot strand the first
// queued job while waiting for a later desired-count callback.
func runFleetTrackedRunnerReconciler(ctx context.Context, runtimes []*scaleSetRuntime) {
	reconcile := func() {
		for _, runtime := range runtimes {
			runtime.mu.RLock()
			initialized := runtime.initialized
			scaler := runtime.scaler
			runtime.mu.RUnlock()
			if initialized {
				scaler.reconcileTrackedRunners(ctx)
			}
		}
	}

	reconcile()
	ticker := time.NewTicker(trackedRunnerReconcileInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			reconcile()
		}
	}
}

// fleetRunnerCount sums tracked runners across every scale set, mirroring
// what drain-and-restart.sh's own fleet_runner_count gate waits to see reach
// zero (across every scale set, not just one) before it recreates the
// container. Used by runOrchestrator's drain watchdog for the same reason:
// see drainStuckTimeout's doc comment.
func fleetRunnerCount(runtimes []*scaleSetRuntime) int {
	total := 0
	for _, runtime := range runtimes {
		total += runtime.scaler.runners.count()
	}
	return total
}

// drainWatchdogTick decides what runOrchestrator's drain watchdog should do
// on one tick, given the current draining state, the fleet's current runner
// count, when the fleet was first observed at zero while draining
// (zeroSince, zero value = not yet observed), and now. It returns the
// zeroSince value to carry into the next tick and whether the fleet drain
// should self-heal on this tick. Pure and side-effect-free -- runOrchestrator
// applies the result (flips draining, calls EndDrain on every scaler, logs)
// and is the only production caller, always passing time.Now(); tests call
// this directly instead of driving a live ticker.
func drainWatchdogTick(draining bool, fleetRunnerCount int, zeroSince, now time.Time) (nextZeroSince time.Time, selfHeal bool) {
	if !draining || fleetRunnerCount > 0 {
		return time.Time{}, false
	}
	if zeroSince.IsZero() {
		return now, false
	}
	if now.Sub(zeroSince) < drainStuckTimeout {
		return zeroSince, false
	}
	return time.Time{}, true
}

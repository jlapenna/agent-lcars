package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math/rand/v2"
	"os"
	"os/signal"
	"sync"
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
	fleet := newFleetCoordinator(0, nil, nil, nil, nil, nil)
	configureFleet(fleet, resolved)
	managedHosts := placementHosts
	runtimes, err := buildOrchestratorRuntimes(resolved, managedHosts, placementHosts, fleet)
	if err != nil {
		return err
	}
	pullConfiguredRunnerImages(ctx, placementHosts, resolved.ScaleSets, logger)

	orchestratorSchedulerReady.Store(true)
	defer orchestratorSchedulerReady.Store(false)

	if _, err := startMetricsServer(ctx, resolved.Raw.Server.MetricsAddr, logger); err != nil {
		return fmt.Errorf("starting metrics server: %w", err)
	}

	generation := startRuntimeGeneration(ctx, runtimes, logger)
	drainSignals := make(chan os.Signal, 1)
	reloadSignals := make(chan os.Signal, 1)
	signal.Notify(drainSignals, syscall.SIGUSR1)
	signal.Notify(reloadSignals, syscall.SIGHUP)
	defer signal.Stop(drainSignals)
	defer signal.Stop(reloadSignals)
	draining := false

	for {
		select {
		case <-ctx.Done():
			generation.cancel()
			<-generation.done
			for _, runtime := range runtimes {
				runtime.scaler.shutdown(context.WithoutCancel(ctx))
			}
			return nil
		case <-drainSignals:
			if draining {
				continue
			}
			draining = true
			logger.Info("Global drain requested")
			for _, runtime := range runtimes {
				runtime.scaler.BeginDrain(context.WithoutCancel(ctx))
			}
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
			nextRuntimes, buildErr := buildOrchestratorRuntimes(next, nextManagedHosts, nextPlacementHosts, fleet)
			if buildErr != nil {
				// This should be impossible after loadOrchestratorConfig and
				// compatibility validation. Keep the old config live if an
				// internal construction error nevertheless occurs.
				logger.Error("Configuration reload could not build runtimes; restoring current configuration", slog.Any("error", buildErr))
				closeDockerHostClients(nextPlacementHosts)
				configureFleet(fleet, resolved)
				generation = startRuntimeGeneration(ctx, runtimes, logger)
				continue
			}
			closeUnusedDockerHostClients(managedHosts, nextManagedHosts)
			resolved, runtimes = next, nextRuntimes
			managedHosts, placementHosts = nextManagedHosts, nextPlacementHosts
			logger = resolved.ScaleSets[0].Logger().With("component", "orchestrator")
			pullConfiguredRunnerImages(ctx, placementHosts, resolved.ScaleSets, logger)
			if draining {
				for _, runtime := range runtimes {
					runtime.scaler.BeginDrain(context.WithoutCancel(ctx))
				}
			}
			generation = startRuntimeGeneration(ctx, runtimes, logger)
			logger.Info("Configuration reloaded without draining runners")
		}
	}
}

func buildOrchestratorRuntimes(resolved resolvedOrchestratorConfig, dockerHosts, placementHosts []DockerHost, fleet *FleetCoordinator) ([]*scaleSetRuntime, error) {
	runtimes := make([]*scaleSetRuntime, 0, len(resolved.ScaleSets))
	for _, base := range resolved.ScaleSets {
		c := base
		c.DockerHosts = append([]string(nil), resolved.DockerHosts...)
		c.SparkMetricsURL = resolved.Raw.Fleet.Placement.SparkMetricsURL
		c.HostMetricsURLTemplate = resolved.Raw.Fleet.Placement.HostMetricsURLTemplate
		c.HostLoadPolicy = resolved.Placement
		c.HostMemoryExempt = append([]string(nil), resolved.Raw.Fleet.Placement.HostMemoryExempt...)
		c.ReadinessMetricsURL = resolved.Raw.Fleet.Placement.ReadinessMetricsURL
		c.ReadinessMetric = resolved.Raw.Fleet.Placement.ReadinessMetric
		c.ReadinessMaxAge = resolved.ReadinessMaxAge
		runtime, err := buildScaleSetRuntime(c, dockerHosts, placementHosts, fleet)
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
	fleet.workDirSizeCaps = resolved.WorkDirSizeCaps
	fleet.dockerSocketGIDs = resolved.DockerSocketGID
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

func startRuntimeGeneration(parent context.Context, runtimes []*scaleSetRuntime, logger *slog.Logger) runtimeGeneration {
	ctx, cancel := context.WithCancel(parent)
	var wg sync.WaitGroup
	orchestratorExpectedListeners.Store(int64(len(runtimes)))
	// All scalers share the coordinator's telemetry maps, so exactly one
	// sampler populates fleet load/cooldown state for every listener.
	wg.Add(1)
	go func() { defer wg.Done(); runtimes[0].scaler.RunHostSampler(ctx) }()
	wg.Add(1)
	go func() { defer wg.Done(); runFleetOrphanSweeper(ctx, runtimes) }()
	wg.Add(1)
	go func() { defer wg.Done(); runFleetDrainWatchdog(ctx, runtimes) }()
	startGitHubRunnerStatusMonitors(ctx, runtimes, logger, &wg)
	for _, runtime := range runtimes {
		if runtime.config.ShareWorkDir {
			wg.Add(1)
			go func(scaler *Scaler) { defer wg.Done(); scaler.RunWorkDirSweeper(ctx) }(runtime.scaler)
			break
		}
	}
	for _, runtime := range runtimes {
		wg.Add(1)
		go func(rt *scaleSetRuntime) { defer wg.Done(); runListenerSupervisor(ctx, rt, logger) }(runtime)
	}
	done := make(chan struct{})
	go func() { wg.Wait(); close(done) }()
	return runtimeGeneration{cancel: cancel, done: done}
}

func buildScaleSetRuntime(c Config, dockerHosts, placementHosts []DockerHost, fleet *FleetCoordinator) (*scaleSetRuntime, error) {
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
		scaleSetName: c.ScaleSetName, registrationName: c.RegistrationName, logger: logger.With("component", "scaler"),
		runners:     runnerState{idle: map[string]runnerRef{}, busy: map[string]runnerRef{}},
		runnerImage: c.RunnerImage, runnerMemory: memory, runnerPidsLimit: c.RunnerPidsLimit, runnerShmSize: shmSize,
		minRunners: c.MinRunners, maxRunners: c.MaxRunners,
		dockerHosts: dockerHosts, placementHosts: placementHosts, mountDockerSocket: c.MountDockerSocket, shareWorkDir: c.ShareWorkDir, fileMounts: c.FileMounts,
		sparkMetricsURL: c.SparkMetricsURL, hostMetricsURLTemplate: c.HostMetricsURLTemplate,
		hostLoadPolicy:      c.HostLoadPolicy,
		hostMemoryExempt:    stringSet(c.HostMemoryExempt),
		readinessMetricsURL: c.ReadinessMetricsURL,
		readinessMetric:     c.ReadinessMetric,
		readinessMaxAge:     c.ReadinessMaxAge,
		workDirSizeCapBytes: defaultWorkDirSizeCapBytes,
		workDirSizeCaps:     fleet.workDirSizeCaps, hostRunnerLimits: fleet.hostRunnerLimits,
		fleet: fleet,
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
				_ = session.Close(context.Background())
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

// runFleetDrainWatchdog polls every scale set for a stuck drain (see
// (*Scaler).checkDrainWatchdog / drainStuckTimeout) and self-heals it. Runs
// unconditionally, independent of runtime.initialized: a scale set can be
// left draining before its GitHub registration ever completes, since
// runOrchestrator's SIGUSR1 handler calls BeginDrain on every runtime
// regardless of initialization state.
func runFleetDrainWatchdog(ctx context.Context, runtimes []*scaleSetRuntime) {
	ticker := time.NewTicker(drainWatchdogInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			now := time.Now()
			for _, runtime := range runtimes {
				runtime.scaler.checkDrainWatchdog(now)
			}
		}
	}
}

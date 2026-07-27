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

func runOrchestrator(ctx context.Context, resolved resolvedOrchestratorConfig) error {
	logger := resolved.ScaleSets[0].Logger().With("component", "orchestrator")
	dockerHosts, err := newDockerHostPool(resolved.DockerHosts)
	if err != nil {
		return fmt.Errorf("connecting fleet docker hosts: %w", err)
	}
	order := make([]string, 0, len(resolved.ScaleSets))
	for _, c := range resolved.ScaleSets {
		order = append(order, c.ScaleSetName)
	}
	fleet := newFleetCoordinator(
		resolved.Raw.Fleet.MaxRunners,
		resolved.RunnerLimits,
		resolved.WorkDirSizeCaps,
		resolved.DockerSocketGID,
		resolved.Weights,
		order,
	)
	fleetMaxRunnersGauge.Set(float64(resolved.Raw.Fleet.MaxRunners))

	// Pull each distinct image once across the fleet rather than once per
	// listener. Pulling is intentionally asynchronous and bounded per host.
	seenImages := map[string]bool{}
	for _, c := range resolved.ScaleSets {
		if !seenImages[c.RunnerImage] {
			seenImages[c.RunnerImage] = true
			go pullRunnerImages(ctx, dockerHosts, c.RunnerImage, logger)
		}
	}

	runtimes := make([]*scaleSetRuntime, 0, len(resolved.ScaleSets))
	orchestratorExpectedListeners.Store(int64(len(resolved.ScaleSets)))
	orchestratorSchedulerReady.Store(true)
	defer orchestratorSchedulerReady.Store(false)
	for _, base := range resolved.ScaleSets {
		c := base
		c.DockerHosts = append([]string(nil), resolved.DockerHosts...)
		c.SparkMetricsURL = resolved.Raw.Fleet.Placement.SparkMetricsURL
		c.HostMetricsURLTemplate = resolved.Raw.Fleet.Placement.HostMetricsURLTemplate
		c.HostLoadPolicy = resolved.Placement
		c.HostMemoryExempt = append([]string(nil), resolved.Raw.Fleet.Placement.HostMemoryExempt...)

		runtime, initErr := buildScaleSetRuntime(c, dockerHosts, fleet)
		if initErr != nil {
			return fmt.Errorf("initializing scale set %q: %w", c.ScaleSetName, initErr)
		}
		runtimes = append(runtimes, runtime)
	}

	startMetricsServer(ctx, resolved.Raw.Server.MetricsAddr, logger)
	// All scalers share the coordinator's telemetry maps, so exactly one
	// sampler populates fleet load/cooldown state for every listener.
	go runtimes[0].scaler.RunHostSampler(ctx)
	go runFleetOrphanSweeper(ctx, runtimes)
	for _, runtime := range runtimes {
		if runtime.config.MountDockerSocket {
			go runtime.scaler.RunWorkDirSweeper(ctx)
			break
		}
	}

	drainSignals := make(chan os.Signal, 1)
	signal.Notify(drainSignals, syscall.SIGUSR1)
	defer signal.Stop(drainSignals)
	go func() {
		select {
		case <-ctx.Done():
		case <-drainSignals:
			logger.Info("Global drain requested")
			for _, runtime := range runtimes {
				runtime.scaler.BeginDrain(context.WithoutCancel(ctx))
			}
		}
	}()

	var wg sync.WaitGroup
	for _, runtime := range runtimes {
		wg.Add(1)
		go func(rt *scaleSetRuntime) {
			defer wg.Done()
			runListenerSupervisor(ctx, rt, logger)
		}(runtime)
	}
	<-ctx.Done()
	for _, runtime := range runtimes {
		runtime.scaler.shutdown(context.WithoutCancel(ctx))
	}
	wg.Wait()
	return nil
}

func buildScaleSetRuntime(c Config, dockerHosts []DockerHost, fleet *FleetCoordinator) (*scaleSetRuntime, error) {
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
	scaler := &Scaler{
		scaleSetName: c.ScaleSetName, registrationName: c.RegistrationName, logger: logger.With("component", "scaler"),
		runners:     runnerState{idle: map[string]runnerRef{}, busy: map[string]runnerRef{}},
		runnerImage: c.RunnerImage, runnerMemory: memory,
		minRunners: c.MinRunners, maxRunners: c.MaxRunners,
		dockerHosts: dockerHosts, mountDockerSocket: c.MountDockerSocket, shareWorkDir: c.ShareWorkDir, fileMounts: c.FileMounts,
		sparkMetricsURL: c.SparkMetricsURL, hostMetricsURLTemplate: c.HostMetricsURLTemplate,
		hostLoadPolicy:      c.HostLoadPolicy,
		hostMemoryExempt:    stringSet(c.HostMemoryExempt),
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

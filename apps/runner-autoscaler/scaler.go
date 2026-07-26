package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/actions/scaleset"
	"github.com/actions/scaleset/listener"
	cerrdefs "github.com/containerd/errdefs"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/filters"
	"github.com/docker/docker/api/types/image"
	dockerclient "github.com/docker/docker/client"
	"github.com/google/uuid"
)

type Scaler struct {
	scaleSetName string
	// registrationName is a homelab addition (homelab#97): which GitHub
	// registration (see Config.RegistrationName) this scale set's listener
	// belongs to. Purely descriptive -- used in container labels/names and
	// log attribution, never in placement/ownership logic, which stays keyed
	// on the process-wide-unique scaleSetName (see runnerScaleSetLabelKey).
	registrationName string
	runners          runnerState
	runnerImage      string
	runnerMemory     int64
	scaleSetID       int
	// Homelab change: a pool of docker hosts (local + SSH-proxied remotes)
	// instead of a single client, so ONE scale set/label can spread runners
	// across the whole fleet — see hosts.go. Order is round-robin fallback;
	// startRunner actually picks the LEAST LOADED host each time.
	dockerHosts    []DockerHost
	scalesetClient *scaleset.Client
	minRunners     int
	maxRunners     int
	// mountDockerSocket: see Config.MountDockerSocket. Applied at ContainerCreate
	// against whichever host's daemon actually places the runner — the bind
	// source path is resolved by THAT daemon, so this is correct for every
	// host in the pool, not just "local".
	mountDockerSocket bool
	// fileMounts: see Config.FileMounts. Appended to the container's binds
	// with an explicit :ro, independently of mountDockerSocket -- the
	// socketless build-client lane uses these and nothing else.
	fileMounts []FileMount
	// workDirSizeCapBytes: size ceiling for the shared /home/runner/_work
	// directory bind-mounted into every runner when MountDockerSocket is
	// set -- that shared dir has no per-container lifecycle to clean it up,
	// unlike a normal container's writable layer. Only enforced by
	// RunWorkDirSweeper, which is only started when mountDockerSocket is true.
	workDirSizeCapBytes int64
	workDirSizeCaps     map[string]int64
	hostRunnerLimits    map[string]int
	// hostImageLocks prevent multiple scale-set listeners from concurrently
	// pulling the same image after a host-side prune removes it.
	hostImageLocks sync.Map // map[host+image]*sync.Mutex
	// Homelab change: URL to probe for spark inference load. When spark is
	// running active vLLM inference requests, or is short on host memory /
	// swapping, pickHost adds a virtual load penalty so other idle fleet
	// hosts are preferred.
	sparkMetricsURL string
	// hostMetricsURLTemplate feeds generic fleet load into placement instead
	// of treating runner count as a sufficient proxy for host saturation.
	hostMetricsURLTemplate string
	draining               atomic.Bool
	hostLoadPolicy         hostLoadPolicy
	hostMemoryExempt       map[string]bool
	logger                 *slog.Logger
	// fleet is shared by every scale-set listener in orchestrator mode. Tests
	// and single-scaler construction paths get an equivalent private instance
	// lazily through coordinator().
	fleet          *FleetCoordinator
	localFleetOnce sync.Once
	localFleet     *FleetCoordinator
}

// scaleSetLabel returns the Prometheus label value identifying this scaler:
// scaleSetName, or "default" for the zero-value Scaler private tests build
// without one.
func (a *Scaler) scaleSetLabel() string {
	if a.scaleSetName == "" {
		return "default"
	}
	return a.scaleSetName
}

func (a *Scaler) coordinator() *FleetCoordinator {
	if a.fleet != nil {
		return a.fleet
	}
	a.localFleetOnce.Do(func() {
		a.localFleet = newFleetCoordinator(a.maxRunners, a.hostRunnerLimits, a.workDirSizeCaps, map[string]string{}, map[string]int{a.scaleSetName: 1}, []string{a.scaleSetName})
	})
	return a.localFleet
}

const (
	hostMetricsTimeout = time.Second
	hostSampleInterval = 15 * time.Second
	// defaultWorkDirSizeCapBytes is the shared /home/runner/_work size
	// ceiling when a fleet host has no per-host override (see
	// resolvedOrchestratorConfig.WorkDirSizeCaps / FleetCoordinator.workDirSizeCaps).
	defaultWorkDirSizeCapBytes = 50 * 1024 * 1024 * 1024
)

type hostLoad struct {
	normalizedLoad  float64
	cpuUtilization  float64
	cpuPressure     float64
	memoryPressure  float64
	memoryAvailable float64
	swapPagesPerSec float64
	penalty         int
	overloaded      bool
	observedAt      time.Time
}

type hostSample struct {
	at             time.Time
	idleSeconds    float64
	cpuPressure    float64
	memoryPressure float64
	swapPages      float64
}

type hostLoadPolicy struct {
	loadSoft, loadBusy, loadHard float64
	cpuSoft, cpuHard             float64
	psiSoft, psiHard             float64
	memorySoft, memoryHard       float64
	swapSoft, swapHard           float64
	cooldown                     time.Duration
	telemetryPenalty             int
}

func defaultHostLoadPolicy() hostLoadPolicy {
	return hostLoadPolicy{
		loadSoft: .75, loadBusy: 1, loadHard: 1.5,
		cpuSoft: .85, cpuHard: .95,
		psiSoft: .10, psiHard: .25,
		memorySoft: .15, memoryHard: .08,
		swapSoft: 10, swapHard: 100,
		cooldown: 2 * time.Minute, telemetryPenalty: 1,
	}
}

func (a *Scaler) policy() hostLoadPolicy {
	if a.hostLoadPolicy.loadHard == 0 {
		return defaultHostLoadPolicy()
	}
	return a.hostLoadPolicy
}

func maxPenalty(current, next int) int {
	if next > current {
		return next
	}
	return current
}

func (a *Scaler) scoreHostLoad(host string, load hostLoad) hostLoad {
	p := a.policy()
	load.penalty, load.overloaded = 0, false
	band := func(value, soft, hard float64) {
		switch {
		case value >= hard:
			load.penalty, load.overloaded = 100, true
		case value >= soft:
			load.penalty = maxPenalty(load.penalty, 10)
		}
	}
	switch {
	case load.normalizedLoad >= p.loadHard:
		load.penalty, load.overloaded = 100, true
	case load.normalizedLoad >= p.loadBusy:
		load.penalty = 10
	case load.normalizedLoad >= p.loadSoft:
		load.penalty = 2
	}
	band(load.cpuUtilization, p.cpuSoft, p.cpuHard)
	band(load.cpuPressure, p.psiSoft, p.psiHard)
	band(load.memoryPressure, p.psiSoft, p.psiHard)
	// Spark's unified LLM allocation makes generic available-memory ratios a
	// poor admission signal; its dedicated inference/swap probe remains the
	// authority while CPU/PSI still participate here.
	if !a.hostMemoryExempt[host] {
		if load.memoryAvailable <= p.memoryHard {
			load.penalty, load.overloaded = 100, true
		} else if load.memoryAvailable <= p.memorySoft {
			load.penalty = maxPenalty(load.penalty, 10)
		}
	}
	if load.swapPagesPerSec >= p.swapHard {
		load.penalty, load.overloaded = 100, true
	} else if load.swapPagesPerSec >= p.swapSoft {
		load.penalty = maxPenalty(load.penalty, 10)
	}
	return load
}

// probeHostLoad reads node_load1 and derives the logical CPU count from the
// number of idle CPU series. It fails open: telemetry trouble must not turn a
// healthy Docker host into a fleet outage.
func (a *Scaler) probeHostLoad(ctx context.Context, host string) (hostLoad, error) {
	if a.hostMetricsURLTemplate == "" {
		return hostLoad{}, nil
	}
	probeCtx, cancel := context.WithTimeout(ctx, hostMetricsTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(probeCtx, http.MethodGet, fmt.Sprintf(a.hostMetricsURLTemplate, host), nil)
	if err != nil {
		return hostLoad{}, err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return hostLoad{}, err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return hostLoad{}, fmt.Errorf("metrics returned HTTP %d", resp.StatusCode)
	}

	var load1, idleSeconds, memAvailable, memTotal, cpuPressure, memoryPressure, swapIn, swapOut float64
	var haveLoad bool
	cpus := make(map[string]struct{})
	scanner := bufio.NewScanner(resp.Body)
	for scanner.Scan() {
		line := scanner.Text()
		switch {
		case strings.HasPrefix(line, "node_load1 "):
			load1, haveLoad = parseMetricValue(line)
		case strings.HasPrefix(line, "node_cpu_seconds_total{") && strings.Contains(line, `mode="idle"`):
			if value, ok := parseMetricValue(line); ok {
				idleSeconds += value
			}
			start := strings.Index(line, `cpu="`)
			if start >= 0 {
				start += len(`cpu="`)
				if end := strings.Index(line[start:], `"`); end >= 0 {
					cpus[line[start:start+end]] = struct{}{}
				}
			}
		case strings.HasPrefix(line, "node_memory_MemAvailable_bytes "):
			memAvailable, _ = parseMetricValue(line)
		case strings.HasPrefix(line, "node_memory_MemTotal_bytes "):
			memTotal, _ = parseMetricValue(line)
		case strings.HasPrefix(line, "node_pressure_cpu_waiting_seconds_total "):
			cpuPressure, _ = parseMetricValue(line)
		case strings.HasPrefix(line, "node_pressure_memory_waiting_seconds_total "):
			memoryPressure, _ = parseMetricValue(line)
		case strings.HasPrefix(line, "node_vmstat_pswpin "):
			swapIn, _ = parseMetricValue(line)
		case strings.HasPrefix(line, "node_vmstat_pswpout "):
			swapOut, _ = parseMetricValue(line)
		}
	}
	if err := scanner.Err(); err != nil {
		return hostLoad{}, err
	}
	if !haveLoad || len(cpus) == 0 {
		return hostLoad{}, fmt.Errorf("metrics missing node_load1 or idle CPU series")
	}
	now := time.Now()
	load := hostLoad{normalizedLoad: load1 / float64(len(cpus)), memoryAvailable: 1, observedAt: now}
	if memTotal > 0 {
		load.memoryAvailable = memAvailable / memTotal
	}
	current := hostSample{at: now, idleSeconds: idleSeconds, cpuPressure: cpuPressure, memoryPressure: memoryPressure, swapPages: swapIn + swapOut}
	fleet := a.coordinator()
	fleet.hostSampleMu.Lock()
	if previous, ok := fleet.hostSamples[host]; ok {
		elapsed := now.Sub(previous.at).Seconds()
		// Concurrent startup/placement probes can finish milliseconds apart.
		// Counter deltas across such a tiny window amplify scrape skew into
		// impossible CPU/swap rates and a false overload cooldown.
		if elapsed >= hostSampleInterval.Seconds()/2 {
			load.cpuUtilization = min(1, max(0, 1-((idleSeconds-previous.idleSeconds)/(elapsed*float64(len(cpus))))))
			load.cpuPressure = max(0, (cpuPressure-previous.cpuPressure)/elapsed)
			load.memoryPressure = max(0, (memoryPressure-previous.memoryPressure)/elapsed)
			load.swapPagesPerSec = max(0, ((swapIn+swapOut)-previous.swapPages)/elapsed)
		}
	}
	if fleet.hostSamples == nil {
		fleet.hostSamples = make(map[string]hostSample)
	}
	fleet.hostSamples[host] = current
	load = a.scoreHostLoad(host, load)
	load = a.applyOverloadCooldown(host, load, now)
	if fleet.hostLoadCache == nil {
		fleet.hostLoadCache = make(map[string]hostLoad)
	}
	fleet.hostLoadCache[host] = load
	fleet.hostSampleMu.Unlock()
	a.recordHostLoadMetrics(host, load, true)
	return load, nil
}

func (a *Scaler) recordHostLoadMetrics(host string, load hostLoad, available bool) {
	if available {
		hostTelemetryGauge.WithLabelValues(host).Set(1)
	} else {
		hostTelemetryGauge.WithLabelValues(host).Set(0)
		return
	}
	hostNormalizedLoadGauge.WithLabelValues(host).Set(load.normalizedLoad)
	hostCPUUtilizationGauge.WithLabelValues(host).Set(load.cpuUtilization)
	hostPressureGauge.WithLabelValues(host, "cpu").Set(load.cpuPressure)
	hostPressureGauge.WithLabelValues(host, "memory").Set(load.memoryPressure)
	hostMemoryAvailableGauge.WithLabelValues(host).Set(load.memoryAvailable)
	hostSwapRateGauge.WithLabelValues(host).Set(load.swapPagesPerSec)
	hostLoadPenaltyGauge.WithLabelValues(host).Set(float64(load.penalty))
	if load.overloaded {
		hostCooldownGauge.WithLabelValues(host).Set(1)
	} else {
		hostCooldownGauge.WithLabelValues(host).Set(0)
	}
}

func (a *Scaler) currentHostLoad(ctx context.Context, host string) (hostLoad, error) {
	fleet := a.coordinator()
	fleet.hostSampleMu.Lock()
	cached, ok := fleet.hostLoadCache[host]
	fleet.hostSampleMu.Unlock()
	if ok && time.Since(cached.observedAt) < 2*hostSampleInterval {
		return cached, nil
	}
	return a.probeHostLoad(ctx, host)
}

func (a *Scaler) RunHostSampler(ctx context.Context) {
	sample := func() {
		var wg sync.WaitGroup
		for _, h := range a.dockerHosts {
			wg.Add(1)
			go func(host string) {
				defer wg.Done()
				if _, err := a.probeHostLoad(ctx, host); err != nil {
					a.recordHostLoadMetrics(host, hostLoad{}, false)
				}
			}(h.Name)
		}
		wg.Wait()
	}
	sample()
	ticker := time.NewTicker(hostSampleInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			sample()
		}
	}
}

func (a *Scaler) applyOverloadCooldown(host string, load hostLoad, now time.Time) hostLoad {
	fleet := a.coordinator()
	fleet.overloadMu.Lock()
	defer fleet.overloadMu.Unlock()
	if fleet.overloadedUntil == nil {
		fleet.overloadedUntil = make(map[string]time.Time)
	}
	if load.overloaded {
		fleet.overloadedUntil[host] = now.Add(a.policy().cooldown)
		return load
	}
	if until := fleet.overloadedUntil[host]; now.Before(until) {
		load.penalty = 100
		load.overloaded = true
	}
	return load
}

func (a *Scaler) updateRunnerMetrics() {
	scaleSet := a.scaleSetLabel()

	a.runners.mu.Lock()
	idleCount := len(a.runners.idle)
	busyCount := len(a.runners.busy)

	idleByHost := make(map[string]int)
	busyByHost := make(map[string]int)
	for _, ref := range a.runners.idle {
		idleByHost[ref.host]++
	}
	for _, ref := range a.runners.busy {
		busyByHost[ref.host]++
	}
	a.runners.mu.Unlock()

	runnersTotalGauge.WithLabelValues(scaleSet).Set(float64(idleCount + busyCount))

	for _, h := range a.dockerHosts {
		runnersIdleGauge.WithLabelValues(scaleSet, h.Name).Set(float64(idleByHost[h.Name]))
		runnersBusyGauge.WithLabelValues(scaleSet, h.Name).Set(float64(busyByHost[h.Name]))
	}
}

func (a *Scaler) HandleDesiredRunnerCount(ctx context.Context, count int) (int, error) {
	// Correct currentCount against reality BEFORE comparing it to demand --
	// see pruneDeadIdleRunners for why a stale idle entry can otherwise
	// pin desired == current forever and starve every future scale-up.
	a.pruneDeadIdleRunners(ctx)
	currentCount := a.runners.count()
	if a.draining.Load() {
		a.removeIdleRunners(context.WithoutCancel(ctx))
		return a.runners.count(), nil
	}
	targetRunnerCount := min(a.maxRunners, a.minRunners+count)

	scaleSet := a.scaleSetLabel()
	desiredRunnersGauge.WithLabelValues(scaleSet).Set(float64(targetRunnerCount))
	minRunnersGauge.WithLabelValues(scaleSet).Set(float64(a.minRunners))
	maxRunnersGauge.WithLabelValues(scaleSet).Set(float64(a.maxRunners))
	pendingRunnersGauge.WithLabelValues(scaleSet).Set(float64(max(0, targetRunnerCount-currentCount)))
	defer func() {
		pendingRunnersGauge.WithLabelValues(scaleSet).Set(float64(max(0, targetRunnerCount-a.runners.count())))
	}()
	defer a.updateRunnerMetrics()

	switch {
	case targetRunnerCount == currentCount:
		// No scaling needed
		return currentCount, nil
	case targetRunnerCount > currentCount:
		// Scale up
		scaleUp := targetRunnerCount - currentCount
		a.logger.Info(
			"Scaling up runners",
			slog.Int("currentCount", currentCount),
			slog.Int("desiredCount", targetRunnerCount),
			slog.Int("scaleUp", scaleUp),
		)

		for range scaleUp {
			if _, err := a.startRunner(ctx); err != nil {
				// Best-effort: a single failed placement (e.g. the host
				// pickHost chose became unreachable in the window between
				// its reachability check and the actual ContainerCreate)
				// must not abort the WHOLE scale-up batch and bubble a
				// fatal error out of the listener -- that previously killed
				// runner-autoscaler-e2e-docker's ability to place ANY
				// runner on ANY host, not just the one that failed (see
				// HandleJobCompleted below for the same class of bug and
				// the incident that surfaced both). Log and keep trying the
				// remaining slots; this reconciliation loop is
				// level-triggered, so a shortfall here is picked up again
				// on the next HandleDesiredRunnerCount call regardless.
				a.logger.Error("Failed to start runner during scale-up; continuing with remaining slots", slog.String("error", err.Error()))
				if errors.Is(err, errFleetAtCapacity) {
					// Unlike a transient single-host failure, this means no
					// host in the fleet had room for the LAST attempt either
					// -- every remaining slot this loop would try is racing
					// against the same wall and would just repeat the same
					// concurrent host-probe round trip for nothing.
					break
				}
				continue
			}
		}

		return a.runners.count(), nil
	default:
		// No need to handle scale down events, since:
		// 1. JobCompleted events will first remove runners
		// 2. If the count is still below the current runner count, the JobCompleted event will be delivered in the next batch.
		// 3. Removal after JobCompleted events is handled synchronously.
		// 4. If the job is cancelled, the JobCompleted event will still be delivered.
	}
	return a.runners.count(), nil
}

// pruneDeadIdleRunners checks every runner currently tracked as idle
// against its actual container state and drops any whose container has
// stopped or vanished. Without this, such an entry sits "idle" forever:
// the ONLY other path that removes an idle/busy entry is HandleJobCompleted,
// which requires GitHub to send a completion message correlated by runner
// name -- a runner whose container never actually ran a real job (see
// below) never gets one, so it silently pins currentCount above reality
// and HandleDesiredRunnerCount concludes no scale-up is needed when one
// clearly is.
//
// Confirmed live during the members#2986 landing: a control-plane restart
// mid-session made the fresh listener adopt GitHub's "assigned jobs" count
// from BEFORE the restart, which could point at work already resolved
// elsewhere in the gap -- the two runners spun up to satisfy that stale
// count got no real job, exited, and their dead-but-still-"idle" entries
// blocked every subsequent scale-up on that scale set for ~20 minutes
// until a manual `docker restart` reset the in-memory state. This makes
// that recovery automatic instead of requiring a human to notice and
// intervene.
//
// A transport error from the inspect call (an SSH hiccup reaching a fleet
// host -- this fleet has had exactly that with spark) is deliberately NOT
// treated as "container gone": only a successful inspect showing a
// non-running state, or a definitive not-found, counts as death. Anything
// else leaves the entry tracked and gets logged instead -- otherwise a
// host having a bad moment over SSH would mass-deregister every healthy
// idle runner placed on it.
func (a *Scaler) pruneDeadIdleRunners(ctx context.Context) {
	type idleEntry struct {
		name string
		ref  runnerRef
	}
	a.runners.mu.Lock()
	snapshot := make([]idleEntry, 0, len(a.runners.idle))
	for name, ref := range a.runners.idle {
		snapshot = append(snapshot, idleEntry{name, ref})
	}
	a.runners.mu.Unlock()

	for _, e := range snapshot {
		client, err := a.hostClient(e.ref.host)
		if err != nil {
			continue
		}
		// 5s cap: this function runs on the listener's message-handling
		// path (HandleDesiredRunnerCount), so an inspect against a
		// wedged-but-still-connectable host must not block it for the
		// kernel TCP timeout.
		inspectCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		info, inspectErr := client.ContainerInspect(inspectCtx, e.ref.containerID)
		cancel()

		if inspectErr == nil && info.State != nil && info.State.Running {
			continue
		}
		if inspectErr != nil && !cerrdefs.IsNotFound(inspectErr) {
			a.logger.Warn("Could not inspect idle runner; keeping it tracked",
				slog.String("name", e.name), slog.String("host", e.ref.host), slog.String("error", inspectErr.Error()))
			continue
		}
		reason := "container no longer exists"
		if inspectErr == nil {
			reason = fmt.Sprintf("container state is %q, not running", info.State.Status)
		}
		a.logger.Warn("Pruning idle runner whose container is not actually running",
			slog.String("name", e.name), slog.String("host", e.ref.host), slog.String("reason", reason))
		a.runners.markDone(e.name)
		a.deregisterRunner(ctx, e.name)
	}
}

func (a *Scaler) HandleJobStarted(ctx context.Context, jobInfo *scaleset.JobStarted) error {
	scaleSet := a.scaleSetLabel()
	jobsStartedCounter.WithLabelValues(scaleSet).Inc()
	a.logger.Info(
		"Job started",
		slog.Int64("runnerRequestId", jobInfo.RunnerRequestID),
		slog.String("jobId", jobInfo.JobID),
	)
	if !a.runners.markBusy(jobInfo.RunnerName) {
		if a.runners.isBusy(jobInfo.RunnerName) {
			// Tracked and already busy -- e.g. a duplicate/replayed
			// JobStarted message. Not the same problem as a runner GitHub
			// knows about that this control plane has no record of at all.
			a.logger.Info("Received job started for already-busy runner", slog.String("runnerName", jobInfo.RunnerName))
		} else {
			a.logger.Warn("Received job started for untracked runner", slog.String("runnerName", jobInfo.RunnerName))
		}
	}
	a.updateRunnerMetrics()
	return nil
}

func (a *Scaler) HandleJobCompleted(ctx context.Context, jobInfo *scaleset.JobCompleted) error {
	scaleSet := a.scaleSetLabel()
	jobsCompletedCounter.WithLabelValues(scaleSet).Inc()
	a.logger.Info("Job completed", slog.Int64("runnerRequestId", jobInfo.RunnerRequestID), slog.String("jobId", jobInfo.JobID))

	runner, ok := a.runners.markDone(jobInfo.RunnerName)
	a.updateRunnerMetrics()
	if !ok {
		a.logger.Warn("Job completed for untracked runner", slog.String("runnerName", jobInfo.RunnerName))
		return nil
	}
	// Best-effort cleanup from here down: a host being unreachable exactly
	// when ITS job finishes must never be fatal to the whole listener --
	// HandleJobCompleted errors bubble straight out of listener.Run() and
	// previously killed the ENTIRE scale set's ability to place runners on
	// every OTHER (perfectly healthy) host too, not just this one. Live
	// incident: spark going unresponsive mid-run crash-looped
	// runner-autoscaler-e2e-docker 13 times, stalling ALL e2e-docker
	// placement fleet-wide for ~90 minutes even though
	// pike/laforge/janeway/homelab were fine the whole time. A container
	// left behind here is swept by cleanupOrphans on the next restart, so
	// nothing is silently lost -- just logged and cleaned up later.
	client, err := a.hostClient(runner.host)
	if err != nil {
		a.logger.Error("Failed to get docker host client for completed-runner cleanup; container will be swept by the next cleanupOrphans pass", slog.String("host", runner.host), slog.String("error", err.Error()))
		return nil
	}
	if err := client.ContainerRemove(ctx, runner.containerID, container.RemoveOptions{Force: true}); err != nil {
		a.logger.Error("Failed to remove completed runner container; will be swept by the next cleanupOrphans pass", slog.String("host", runner.host), slog.String("containerID", runner.containerID), slog.String("error", err.Error()))
		return nil
	}
	if a.mountDockerSocket {
		// Completion is the natural maintenance boundary. Run asynchronously so
		// a large du/rm cannot stall GitHub's listener; the per-host lock blocks
		// new placement only while an idle-host sweep is actually in progress.
		go func() {
			sweepCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Minute)
			defer cancel()
			a.sweepHostIfIdle(sweepCtx, client, runner.host)
		}()
	}

	return nil
}

// deregisterRunner best-effort removes a runner's GitHub registration by
// name. GenerateJitRunnerConfig registers the runner with GitHub BEFORE its
// container ever starts, so any container that dies without completing a
// real job (crash-looping image, dead host, killed on shutdown) never
// triggers HandleJobCompleted -- the only other path that would otherwise
// leave GitHub's registration alone to expire naturally. Without this call,
// every such runner sits in GitHub's runner list as a permanent "offline"
// ghost forever. Confirmed live 2026-07-18: a host-specific permission bug
// crash-looped every e2e-docker runner placed on one fleet host, and
// pruneDeadIdleRunners' local-only cleanup left 32 such ghosts behind in a
// few hours (see jlapenna/homelab's docs/incidents.md for the postmortem).
func (a *Scaler) deregisterRunner(ctx context.Context, name string) {
	runner, err := a.scalesetClient.GetRunnerByName(ctx, name)
	if err != nil {
		a.logger.Warn("Failed to look up runner on GitHub for deregistration", slog.String("name", name), slog.String("error", err.Error()))
		return
	}
	if runner == nil {
		return
	}
	if err := a.scalesetClient.RemoveRunner(ctx, int64(runner.ID)); err != nil {
		a.logger.Warn("Failed to deregister runner from GitHub", slog.String("name", name), slog.String("error", err.Error()))
		return
	}
	a.logger.Info("Deregistered dead runner from GitHub", slog.String("name", name))
}

// hostClient looks up a DockerHost's client by name. Returns an error on an unknown host.
func (a *Scaler) hostClient(name string) (*dockerclient.Client, error) {
	for _, h := range a.dockerHosts {
		if h.Name == name {
			return h.Client, nil
		}
	}
	return nil, fmt.Errorf("unknown docker host %q", name)
}

// parseMetricValue extracts the trailing numeric value from a Prometheus
// exposition line (with or without a {labels} block).
func parseMetricValue(line string) (float64, bool) {
	fields := strings.Fields(line)
	if len(fields) < 2 {
		return 0, false
	}
	val, err := strconv.ParseFloat(fields[len(fields)-1], 64)
	if err != nil {
		return 0, false
	}
	return val, true
}

// isSparkLoaded probes spark's metrics URL for signals that it's a bad
// placement target right now: active vLLM inference requests. Absolute free
// memory and allocated swap are deliberately ignored because resident model
// weights and K/V cache make those normal on Spark. The fleet sampler handles
// actual CPU, PSI, load, and active swap-I/O pressure independently.
func (a *Scaler) isSparkLoaded(ctx context.Context) bool {
	if a.sparkMetricsURL == "" {
		return false
	}
	reqCtx, cancel := context.WithTimeout(ctx, 1*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, a.sparkMetricsURL, nil)
	if err != nil {
		return false
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return false
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		return false
	}

	scanner := bufio.NewScanner(resp.Body)
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "#") || line == "" {
			continue
		}
		switch {
		case strings.HasPrefix(line, "vllm:num_requests_running"), strings.HasPrefix(line, "vllm:num_requests_waiting"):
			if val, ok := parseMetricValue(line); ok && val > 0 {
				a.logger.Info("Spark has active inference load, deprioritizing placement",
					slog.String("metric", strings.Fields(line)[0]),
					slog.Float64("value", val),
				)
				return true
			}
		}
	}
	return false
}

// pickHost returns the fleet member this call should place a runner on: the
// reachable host with the fewest runners currently placed on it (idle+busy),
// so a burst of jobs spreads across every active configured host. If spark
// is running active vLLM inference requests (or is low on memory / under
// swap pressure), a virtual load penalty (+100) is applied to spark so other
// idle fleet hosts are preferred over it.
//
// When mountDockerSocket is set, reachable hosts that already have >=1
// runner from this scale set placed on them are excluded outright rather
// than just deprioritized: socket-mounted runners share the placement
// host's /home/runner/_work bind mount, so two same-scale-set runners on one
// host resolve the same repo to the same checkout directory
// (_PipelineMapping) and can corrupt each other's checkout mid-job. This
// mirrors the one-per-host layout the retired static runners used. If that
// leaves zero candidate hosts, pickHost returns an error -- the caller's
// reconciliation is level-triggered, so it retries once a host frees up.
//
// Returns an error rather than falling back to dockerHosts[0] when every
// configured host is unreachable, so the caller can skip the placement
// attempt entirely instead of burning a GitHub JIT registration on a
// container that cannot possibly start.
func (a *Scaler) pickHost(ctx context.Context) (string, error) {
	fleet := a.coordinator()
	fleet.mu.Lock()
	defer fleet.mu.Unlock()
	return a.pickHostLocked(ctx, fleet)
}

// errFleetAtCapacity marks a pickHostLocked failure as capacity-shaped
// (every host unreachable, or the fleet/host/socket limit is exhausted) so
// HandleDesiredRunnerCount's scale-up loop can stop retrying immediately
// instead of repeating the same doomed probe-and-decide round trip against a
// wall that a fixed number of retries within this call cannot resolve.
var errFleetAtCapacity = errors.New("no docker host has placement capacity right now")

// pickHostLocked selects against a Docker recount plus in-flight reservations.
// The caller must hold fleet.mu through the subsequent reservation update.
func (a *Scaler) pickHostLocked(ctx context.Context, fleet *FleetCoordinator) (string, error) {
	counts := a.runners.countsByHost()

	type pingResult struct {
		host                 DockerHost
		ok                   bool
		err                  error
		load                 hostLoad
		loadErr              error
		fleetRunners         int
		sharedWorkDirRunners int
	}

	ch := make(chan pingResult, len(a.dockerHosts))
	var wg sync.WaitGroup

	for _, h := range a.dockerHosts {
		wg.Add(1)
		go func(dh DockerHost) {
			defer wg.Done()
			// 5s, not 2s: a cold SSH handshake (ControlPersist=60s expired
			// since the last placement on this host) can take longer than
			// 2s and would otherwise flap a perfectly healthy host to
			// "unreachable".
			pingCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
			_, err := dh.Client.Ping(pingCtx)
			cancel()
			load, loadErr := a.currentHostLoad(ctx, dh.Name)
			fleetRunners := 0
			sharedWorkDirRunners := 0
			if err == nil {
				allRunners, listErr := dh.Client.ContainerList(ctx, container.ListOptions{
					Filters: filters.NewArgs(filters.Arg("label", runnerScaleSetLabelKey)),
				})
				if listErr != nil {
					loadErr = errors.Join(loadErr, fmt.Errorf("counting fleet runners: %w", listErr))
				} else {
					fleetRunners = len(allRunners)
					for _, runner := range allRunners {
						if runner.Labels[runnerSharedWorkDirLabelKey] == "true" {
							sharedWorkDirRunners++
						}
					}
				}
			}
			ch <- pingResult{host: dh, ok: err == nil, err: err, load: load, loadErr: loadErr, fleetRunners: fleetRunners, sharedWorkDirRunners: sharedWorkDirRunners}
		}(h)
	}

	var sparkLoaded bool
	if a.sparkMetricsURL != "" {
		wg.Add(1)
		go func() {
			defer wg.Done()
			sparkLoaded = a.isSparkLoaded(ctx)
		}()
	}

	wg.Wait()
	close(ch)

	var results []pingResult
	hostLoads := make(map[string]hostLoad, len(a.dockerHosts))
	fleetCounts := make(map[string]int, len(a.dockerHosts))
	sharedWorkDirCounts := make(map[string]int, len(a.dockerHosts))
	scaleSet := a.scaleSetLabel()
	for res := range ch {
		results = append(results, res)
		if res.ok {
			fleetCounts[res.host.Name] = res.fleetRunners
			sharedWorkDirCounts[res.host.Name] = res.sharedWorkDirRunners
			hostFleetRunnersGauge.WithLabelValues(res.host.Name).Set(float64(res.fleetRunners))
			if res.loadErr != nil {
				res.load.penalty = a.policy().telemetryPenalty
				hostLoads[res.host.Name] = res.load
				hostLoadPenaltyGauge.WithLabelValues(res.host.Name).Set(float64(res.load.penalty))
				hostTelemetryGauge.WithLabelValues(res.host.Name).Set(0)
				a.logger.Warn("Host load metrics unavailable; applying uncertainty penalty", slog.String("host", res.host.Name), slog.Int("penalty", res.load.penalty), slog.String("error", res.loadErr.Error()))
			} else {
				res.load = a.applyOverloadCooldown(res.host.Name, res.load, time.Now())
				hostLoads[res.host.Name] = res.load
				a.recordHostLoadMetrics(res.host.Name, res.load, true)
				log := a.logger.Debug
				if res.load.penalty > 0 {
					log = a.logger.Info
				}
				log("Measured placement host load", slog.String("host", res.host.Name), slog.Float64("normalized_load", res.load.normalizedLoad), slog.Int("penalty", res.load.penalty))
			}
			hostReachableGauge.WithLabelValues(res.host.Name).Set(1)
		} else {
			hostReachableGauge.WithLabelValues(res.host.Name).Set(0)
			a.logger.Warn("Docker host is unreachable, skipping placement", slog.String("host", res.host.Name), slog.String("error", res.err.Error()))
		}
	}
	// Restore configured fleet order after concurrent probes so response
	// timing cannot bias equal-score placement toward the fastest endpoint.
	var reachableHosts []DockerHost
	for _, configured := range a.dockerHosts {
		for _, res := range results {
			if res.ok && res.host.Name == configured.Name {
				reachableHosts = append(reachableHosts, configured)
				break
			}
		}
	}

	if len(reachableHosts) == 0 {
		return "", fmt.Errorf("all %d configured docker hosts are unreachable: %w", len(a.dockerHosts), errFleetAtCapacity)
	}
	actualTotal := 0
	for _, h := range a.dockerHosts {
		if n, ok := fleetCounts[h.Name]; ok {
			fleet.lastFleetCounts[h.Name] = n
		}
		actualTotal += fleet.lastFleetCounts[h.Name]
	}
	reservedTotal := 0
	for _, n := range fleet.reservations {
		reservedTotal += n
	}
	if fleet.maxRunners > 0 && actualTotal+reservedTotal >= fleet.maxRunners {
		placementBlocked.WithLabelValues(scaleSet, "fleet_limit").Inc()
		return "", fmt.Errorf("fleet reached configured runner limit %d: %w", fleet.maxRunners, errFleetAtCapacity)
	}
	var withinHostLimits []DockerHost
	for _, h := range reachableHosts {
		if fleet.startInFlight[h.Name] {
			continue
		}
		limit, limited := a.hostRunnerLimits[h.Name]
		if !limited {
			limit, limited = fleet.hostRunnerLimits[h.Name]
		}
		if !limited || fleetCounts[h.Name]+fleet.reservations[h.Name] < limit {
			withinHostLimits = append(withinHostLimits, h)
		}
	}
	if len(withinHostLimits) == 0 {
		placementBlocked.WithLabelValues(scaleSet, "host_limits").Inc()
		return "", fmt.Errorf("every reachable docker host is at its configured runner limit: %w", errFleetAtCapacity)
	}

	candidates := withinHostLimits
	if a.mountDockerSocket {
		var withCapacity []DockerHost
		// Preserve the fleet-wide policy filter above. Iterating reachableHosts
		// here used to reintroduce hosts already removed by runner_limit, which
		// let E2E placements bypass Janeway's limit while other scale sets
		// enforced it correctly.
		for _, h := range withinHostLimits {
			if counts[h.Name] == 0 && sharedWorkDirCounts[h.Name] == 0 && fleet.socketReservations[h.Name] == 0 {
				withCapacity = append(withCapacity, h)
			}
		}
		if len(withCapacity) == 0 {
			return "", fmt.Errorf("mount-docker-socket scale set %q: every reachable docker host already has a runner placed: %w", scaleSet, errFleetAtCapacity)
		}
		candidates = withCapacity
	}

	effectiveCount := func(hostName string) int {
		c := fleetCounts[hostName] + fleet.reservations[hostName] + hostLoads[hostName].penalty
		if hostName == "spark" && sparkLoaded {
			c += 100
		}
		return c
	}

	bestCount := effectiveCount(candidates[0].Name)
	var tied []string
	for _, h := range candidates {
		c := effectiveCount(h.Name)
		if c < bestCount {
			bestCount, tied = c, []string{h.Name}
		} else if c == bestCount {
			tied = append(tied, h.Name)
		}
	}
	fleet.placementMu.Lock()
	best := tied[fleet.placementCursor%len(tied)]
	fleet.placementCursor++
	fleet.placementMu.Unlock()
	placementDecisions.WithLabelValues(scaleSet, best).Inc()
	return best, nil
}

// runnerScaleSetLabelKey tags every container with the listener that owns it.
// The single orchestrator still needs this boundary so per-set lifecycle and
// GitHub deregistration never cross-kill another set's runners.
const (
	runnerScaleSetLabelKey      = "autoscaler.scale-set"
	runnerSharedWorkDirLabelKey = "autoscaler.shared-workdir"
	// runnerRegistrationLabelKey is a homelab#97 addition: which GitHub
	// registration (account/repo) minted this runner. Purely descriptive --
	// ownership/orphan-cleanup logic keys off runnerScaleSetLabelKey alone,
	// since scale-set names are already process-wide unique.
	runnerRegistrationLabelKey = "autoscaler.registration"
)

const (
	// orphanSweepInterval is how often RunOrphanSweeper reaps runner
	// containers leaked outside the normal HandleJobCompleted path.
	orphanSweepInterval = 30 * time.Minute
	// orphanMinAge is the minimum container age the periodic sweep (boot
	// false) will act on, so it can't race startRunner's create->addIdle
	// window or kill a still-running job from a previous incarnation of
	// this same scale set.
	orphanMinAge = 10 * time.Minute
)

// cleanupOrphans removes runner containers on the fleet that this scale set
// owns (per runnerScaleSetLabelKey) but no longer has any live tracked
// record of. A container labeled for a DIFFERENT scale set is always
// skipped outright -- that's the cross-kill runnerScaleSetLabelKey exists to
// prevent, see its doc comment.
//
// boot=true is the startup pass. Running containers are adopted as busy so a
// control-plane restart never destroys in-flight CI and never double-scales
// GitHub's already-assigned jobs. Only stopped leftovers are removed.
//
// boot=false is RunOrphanSweeper's periodic pass: reaps containers leaked
// when HandleJobCompleted's own ContainerRemove call fails (see its doc
// comment -- previously such a container lingered until the next process
// restart, potentially weeks). On top of the ownership check above, it
// additionally requires the container be untracked in a.runners, not in the
// running state, and older than orphanMinAge -- those three guards are what
// keep a periodic pass safe to run against containers that might be mid
// create/start or mid-job, unlike the boot pass which only ever runs before
// any runner has been started.
func (a *Scaler) cleanupOrphans(ctx context.Context, boot bool) {
	a.logger.Info("Checking for orphaned runner containers across docker hosts", slog.Bool("boot", boot))
	for _, h := range a.dockerHosts {
		containers, err := h.Client.ContainerList(ctx, container.ListOptions{All: true})
		if err != nil {
			a.logger.Warn("Failed to list containers on docker host during orphan cleanup", slog.String("host", h.Name), slog.String("error", err.Error()))
			continue
		}
		for _, c := range containers {
			if owner := c.Labels[runnerScaleSetLabelKey]; owner != a.scaleSetName {
				// Unlabeled (not a runner container we manage) or belongs
				// to a different control plane's scale set.
				continue
			}

			var cleanName string
			for _, name := range c.Names {
				cleanName = strings.TrimPrefix(name, "/")
				break
			}
			if cleanName == "" {
				continue
			}
			if boot && c.State == container.StateRunning {
				top, topErr := h.Client.ContainerTop(ctx, c.ID, []string{"-eo", "pid,args"})
				if topErr == nil && !topHasRunnerWorker(top) {
					a.runners.addIdle(cleanName, h.Name, c.ID)
					a.logger.Info("Adopted idle runner from previous control-plane instance", slog.String("host", h.Name), slog.String("name", cleanName), slog.String("containerID", c.ID))
				} else {
					a.runners.mu.Lock()
					a.runners.busy[cleanName] = runnerRef{host: h.Name, containerID: c.ID}
					a.runners.mu.Unlock()
					a.logger.Info("Adopted busy runner from previous control-plane instance", slog.String("host", h.Name), slog.String("name", cleanName), slog.String("containerID", c.ID), slog.Any("top_error", topErr))
				}
				continue
			}

			if !boot {
				if a.runners.isTracked(cleanName) {
					continue
				}
				if c.State == container.StateRunning {
					continue
				}
				if time.Since(time.Unix(c.Created, 0)) <= orphanMinAge {
					continue
				}
			}

			a.logger.Info("Removing orphaned runner container", slog.String("host", h.Name), slog.String("name", cleanName), slog.String("containerID", c.ID))
			if err := h.Client.ContainerRemove(ctx, c.ID, container.RemoveOptions{Force: true}); err != nil {
				a.logger.Error("Failed to remove orphaned runner container", slog.String("host", h.Name), slog.String("name", cleanName), slog.String("error", err.Error()))
			}
			a.deregisterRunner(ctx, cleanName)
		}
	}
	a.updateRunnerMetrics()
}

func topHasRunnerWorker(top container.TopResponse) bool {
	for _, process := range top.Processes {
		for _, field := range process {
			if strings.Contains(field, "Runner.Worker") {
				return true
			}
		}
	}
	return false
}

// RunOrphanSweeper periodically reaps runner containers leaked outside the
// normal HandleJobCompleted path (see cleanupOrphans's boot=false doc for
// the leak this closes). Started unconditionally for every scale set, not
// just the socket-mounted one -- any scale set can leak a container this
// way. Deliberately does NOT run an initial sweep on entry: the boot-time
// cleanupOrphans(ctx, true) call in main.go's run() already covers startup.
func (a *Scaler) RunOrphanSweeper(ctx context.Context) {
	ticker := time.NewTicker(orphanSweepInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			a.cleanupOrphans(ctx, false)
		}
	}
}

// dockerSafeNamePart replaces every character Docker container names
// disallow ([^a-zA-Z0-9_.-]) with '-', so a config-supplied scale set name
// (homelab#97: now used as a --name component, not just a label/metric
// value) can never produce an invalid container name.
func dockerSafeNamePart(s string) string {
	return strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '_', r == '.', r == '-':
			return r
		default:
			return '-'
		}
	}, s)
}

// runnerBinds builds the bind list for a spawned runner. Split out of
// startRunner so the privilege-sensitive part -- root-equivalent socket
// access versus scoped read-only files -- is unit testable without a
// docker daemon.
//
// File mounts are ALWAYS :ro. Config validation already bounds their
// sources to fleet.file_mount_allowlist and rejects the docker socket
// outright; read-only is the last of those three guards and the cheapest.
func runnerBinds(mountDockerSocket bool, fileMounts []FileMount) []string {
	var binds []string
	if mountDockerSocket {
		binds = []string{
			"/home/runner/_work:/home/runner/_work",
			"/home/runner/externals:/home/runner/externals",
			dockerSocketPath + ":" + dockerSocketPath,
		}
	}
	for _, m := range fileMounts {
		binds = append(binds, fmt.Sprintf("%s:%s:ro", m.HostPath, m.ContainerPath))
	}
	return binds
}

func (a *Scaler) startRunner(ctx context.Context) (string, error) {
	if a.draining.Load() {
		return "", fmt.Errorf("scale set %q is draining", a.scaleSetName)
	}
	start := time.Now()
	scaleSet := a.scaleSetLabel()
	// Prefixed with the scale set name (homelab#97): once multiple scale
	// sets -- and, with multiple registrations, multiple GitHub
	// accounts/repos -- share one process's `docker ps` output, a bare
	// `runner-<uuid8>` name is indistinguishable between them. scaleSetName
	// is already validated process-wide-unique (see resolveScaleSets), so
	// this is also enough to disambiguate registrations without a separate
	// prefix -- sanitized because it now flows into a Docker identifier, not
	// just a Prometheus label/GitHub scale-set name.
	name := fmt.Sprintf("runner-%s-%s", dockerSafeNamePart(a.scaleSetName), uuid.NewString()[:8])
	reservation, err := a.coordinator().reserve(ctx, a)
	if err != nil {
		// No GitHub JIT registration has been generated yet at this point,
		// so failing here (instead of pickHost's old dead-host fallback)
		// costs nothing but a retry -- this reconciliation is
		// level-triggered, so HandleDesiredRunnerCount picks the shortfall
		// back up on its next call.
		runnerStartFailures.WithLabelValues(scaleSet, "none").Inc()
		return "", fmt.Errorf("failed to pick a placement host: %w", err)
	}
	host := reservation.host
	defer reservation.release(scaleSet)
	if a.mountDockerSocket {
		workDirLock := a.hostWorkDirLock(host)
		workDirLock.Lock()
		defer workDirLock.Unlock()
	}
	client, err := a.hostClient(host)
	if err != nil {
		runnerStartFailures.WithLabelValues(scaleSet, host).Inc()
		return "", fmt.Errorf("failed to get docker host client for host %q: %w", host, err)
	}
	// pickHost may precede slow workdir maintenance or image operations by
	// minutes. Re-read the daemon immediately before registering/creating a
	// runner so capacity consumed during that delay is not ignored.
	if err := a.checkHostRunnerLimit(ctx, client, host); err != nil {
		runnerStartFailures.WithLabelValues(scaleSet, host).Inc()
		return "", err
	}
	// The fleet's scheduled `docker image prune -a` can remove a runner image
	// whenever that host happens to have no active runner. Startup refreshes
	// alone are therefore insufficient for a long-lived control plane: verify
	// the selected host immediately before minting the one-shot JIT config and
	// recover the image on demand when pruning removed it.
	if err := a.ensureRunnerImage(ctx, client, host); err != nil {
		runnerStartFailures.WithLabelValues(scaleSet, host).Inc()
		return "", err
	}

	jit, err := a.scalesetClient.GenerateJitRunnerConfig(
		ctx,
		&scaleset.RunnerScaleSetJitRunnerSetting{
			Name: name,
		},
		a.scaleSetID,
	)
	if err != nil {
		runnerStartFailures.WithLabelValues(scaleSet, host).Inc()
		return "", fmt.Errorf("failed to generate JIT config: %w", err)
	}

	binds := runnerBinds(a.mountDockerSocket, a.fileMounts)
	var groupAdd []string
	if a.mountDockerSocket {
		gid, gidErr := a.coordinator().socketGID(host)
		if gidErr != nil {
			return "", gidErr
		}
		groupAdd = []string{gid}
		if err := a.ensureWorkDirOwnership(ctx, client, host); err != nil {
			a.logger.Warn("Failed to normalize shared workdir ownership before runner start", slog.String("host", host), slog.String("error", err.Error()))
		}
	}
	hostConfig := &container.HostConfig{
		Binds:    binds,
		GroupAdd: groupAdd,
		Resources: container.Resources{
			Memory: a.runnerMemory,
		},
	}

	c, err := client.ContainerCreate(
		ctx,
		&container.Config{
			Image: a.runnerImage,
			User:  "runner",
			Cmd:   []string{"/home/runner/run.sh"},
			Labels: map[string]string{
				runnerScaleSetLabelKey:      a.scaleSetName,
				runnerRegistrationLabelKey:  a.registrationName,
				runnerSharedWorkDirLabelKey: strconv.FormatBool(a.mountDockerSocket),
			},
			Env: []string{
				fmt.Sprintf("ACTIONS_RUNNER_INPUT_JITCONFIG=%s", jit.EncodedJITConfig),
			},
		},
		hostConfig,
		nil, nil,
		name,
	)
	if err != nil {
		runnerStartFailures.WithLabelValues(scaleSet, host).Inc()
		// GenerateJitRunnerConfig above already registered `name` with GitHub.
		// This runner never reaches a.runners.addIdle, so it's invisible to
		// pruneDeadIdleRunners' cleanup pass too -- without this call it's a
		// permanent offline ghost (see deregisterRunner's doc comment; this
		// exact gap caused a 2852->4250+ runaway registration count during
		// the 2026-07-20 missing-image outage, homelab#46). On SIGTERM, ctx
		// is already canceled here -- often WHY ContainerCreate just failed
		// -- so cleanup uses a detached context, same as
		// ensureWorkDirOwnership/sweepHostWorkDir's deferred removes;
		// otherwise the deregister would fail instantly for the same reason
		// and leak the exact ghost this call exists to prevent.
		cleanupCtx := context.WithoutCancel(ctx)
		a.deregisterRunner(cleanupCtx, name)
		return "", fmt.Errorf("failed to create runner container on host %q: %w", host, err)
	}

	if err := client.ContainerStart(ctx, c.ID, container.StartOptions{}); err != nil {
		runnerStartFailures.WithLabelValues(scaleSet, host).Inc()
		// Same ghost-registration gap and detached-context reasoning as
		// above, plus the container itself now exists (created but never
		// started) and needs cleanup too.
		cleanupCtx := context.WithoutCancel(ctx)
		a.deregisterRunner(cleanupCtx, name)
		if rmErr := client.ContainerRemove(cleanupCtx, c.ID, container.RemoveOptions{Force: true}); rmErr != nil {
			a.logger.Warn("Failed to remove container that failed to start", slog.String("host", host), slog.String("containerID", c.ID), slog.String("error", rmErr.Error()))
		}
		return "", fmt.Errorf("failed to start runner container on host %q: %w", host, err)
	}

	runnerStartDuration.WithLabelValues(scaleSet, host).Observe(time.Since(start).Seconds())
	a.logger.Info("Placed runner", slog.String("name", name), slog.String("host", host))
	a.runners.addIdle(name, host, c.ID)
	a.updateRunnerMetrics()
	return name, nil
}

func (a *Scaler) ensureRunnerImage(ctx context.Context, client *dockerclient.Client, host string) error {
	key := host + "\x00" + a.runnerImage
	lockValue, _ := a.hostImageLocks.LoadOrStore(key, &sync.Mutex{})
	lock := lockValue.(*sync.Mutex)
	lock.Lock()
	defer lock.Unlock()

	if _, err := client.ImageInspect(ctx, a.runnerImage); err == nil {
		return nil
	} else if !cerrdefs.IsNotFound(err) {
		return fmt.Errorf("failed to inspect runner image %q on host %q: %w", a.runnerImage, host, err)
	}

	a.logger.Warn("Runner image missing on selected host; pulling it on demand",
		slog.String("host", host), slog.String("image", a.runnerImage))
	pull, err := client.ImagePull(ctx, a.runnerImage, image.PullOptions{})
	if err != nil {
		return fmt.Errorf("failed to pull runner image %q on host %q: %w", a.runnerImage, host, err)
	}
	defer func() { _ = pull.Close() }()
	if _, err := io.Copy(io.Discard, pull); err != nil {
		return fmt.Errorf("failed while pulling runner image %q on host %q: %w", a.runnerImage, host, err)
	}
	if _, err := client.ImageInspect(ctx, a.runnerImage); err != nil {
		return fmt.Errorf("runner image %q is still unavailable on host %q after pull: %w", a.runnerImage, host, err)
	}
	logDigests(ctx, a.logger, DockerHost{Name: host, Client: client}, a.runnerImage)
	return nil
}

func (a *Scaler) checkHostRunnerLimit(ctx context.Context, client *dockerclient.Client, host string) error {
	limit, limited := a.hostRunnerLimits[host]
	if !limited {
		return nil
	}
	runners, err := client.ContainerList(ctx, container.ListOptions{
		Filters: filters.NewArgs(filters.Arg("label", runnerScaleSetLabelKey)),
	})
	if err != nil {
		return fmt.Errorf("rechecking runner limit on host %q: %w", host, err)
	}
	if len(runners) >= limit {
		return fmt.Errorf("host %q reached runner limit %d before container creation", host, limit)
	}
	return nil
}

// ensureWorkDirOwnership chowns BOTH shared bind mounts used when
// mountDockerSocket is set (_work and externals) to runner:runner, but only
// when top-level ownership is actually wrong. A host whose
// /home/runner/{_work,externals} paths don't already exist (e.g. one never
// running the pre-autoscaler static runner) gets them auto-created by
// dockerd on first bind-mount, owned root:root -- entrypoint.sh's populate
// step then fails "Permission denied" as the non-root runner user, and every
// runner placed there crash-loops before ever reaching a real job (see
// deregisterRunner's doc comment for the GitHub-ghost fallout this causes).
// Confirmed live 2026-07-18: this used to chown only _work, leaving
// externals root-owned on a newly onboarded host -- 100% of e2e-docker
// placements on it failed (see jlapenna/homelab's docs/incidents.md for the
// postmortem).
//
// The recursive chown only RUNS when the top-level directory's ownership
// doesn't already match runner:runner -- i.e. only on a host's first-ever
// placement, the fresh-dir case above. Without that guard this ran `chown -R`
// over the whole shared _work + externals tree (potentially tens of GB /
// hundreds of thousands of files, e.g. .pnpm-store) on EVERY socket-mounted
// placement. Root-owned files deep inside an already-runner-owned tree (e.g.
// written by a docker-using job running as root) are out of scope for this
// guard, same as they always were on the retired static runners -- this only
// ever protected against the fresh-mount case.
func (a *Scaler) ensureWorkDirOwnership(ctx context.Context, client *dockerclient.Client, host string) error {
	const script = `set -e
want="$(id -u runner):$(id -g runner)"
for d in /home/runner/_work /home/runner/externals; do
  if [ "$(stat -c %u:%g "$d")" != "$want" ]; then
    chown -R runner:runner "$d"
  fi
done
`
	resp, err := client.ContainerCreate(ctx,
		&container.Config{
			Image:      a.runnerImage,
			User:       "root",
			Entrypoint: []string{"sh", "-c"},
			Cmd:        []string{script},
		},
		&container.HostConfig{
			Binds: []string{
				"/home/runner/_work:/home/runner/_work",
				"/home/runner/externals:/home/runner/externals",
			},
		},
		nil, nil, "",
	)
	if err != nil {
		return fmt.Errorf("creating workdir-chown helper on host %q: %w", host, err)
	}
	defer func() {
		_ = client.ContainerRemove(context.WithoutCancel(ctx), resp.ID, container.RemoveOptions{Force: true})
	}()
	if err := client.ContainerStart(ctx, resp.ID, container.StartOptions{}); err != nil {
		return fmt.Errorf("starting workdir-chown helper on host %q: %w", host, err)
	}
	statusCh, errCh := client.ContainerWait(ctx, resp.ID, container.WaitConditionNotRunning)
	select {
	case err := <-errCh:
		if err != nil {
			return fmt.Errorf("waiting for workdir-chown helper on host %q: %w", host, err)
		}
	case status := <-statusCh:
		if status.StatusCode != 0 {
			return fmt.Errorf("workdir-chown helper on host %q exited %d", host, status.StatusCode)
		}
	}
	return nil
}

// workDirSweepInterval is how often RunWorkDirSweeper checks the shared
// /home/runner/_work directory against workDirSizeCapBytes. A constant
// rather than a flag: one less number to tune per deployment.
const workDirSweepInterval = 15 * time.Minute

// RunWorkDirSweeper periodically enforces workDirSizeCapBytes on the shared
// /home/runner/_work directory across the fleet. Only started when
// mountDockerSocket is true (see main.go) -- that's the only scale set that
// bind-mounts the shared dir in the first place. Runs an initial sweep
// immediately so a restart doesn't wait a full interval to reclaim space.
func (a *Scaler) RunWorkDirSweeper(ctx context.Context) {
	a.SweepWorkDirs(ctx)
	ticker := time.NewTicker(workDirSweepInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			a.SweepWorkDirs(ctx)
		}
	}
}

// SweepWorkDirs checks/reclaims the shared /home/runner/_work directory on
// every fleet host. A host is swept only while it has no E2E runner, idle or
// busy. The per-host lock is also held across startRunner's create->addIdle
// window, so a runner cannot appear after this check and race cache deletion.
// A continuously busy host can defer cleanup; disk-pressure handling must
// drain that host rather than delete files underneath a running job.
func (a *Scaler) SweepWorkDirs(ctx context.Context) {
	for _, h := range a.dockerHosts {
		a.sweepHostIfIdle(ctx, h.Client, h.Name)
	}
}

func (a *Scaler) sweepHostIfIdle(ctx context.Context, client *dockerclient.Client, host string) {
	workDirLock := a.hostWorkDirLock(host)
	workDirLock.Lock()
	defer workDirLock.Unlock()
	fleet := a.coordinator()
	fleet.mu.Lock()
	pending := fleet.socketReservations[host]
	fleet.mu.Unlock()
	if a.runners.hasHost(host) {
		a.logger.Debug("Skipping workdir sweep while tracked shared-workdir runner is active", slog.String("host", host))
		return
	}
	sharedRunners, err := client.ContainerList(ctx, container.ListOptions{
		Filters: filters.NewArgs(filters.Arg("label", runnerSharedWorkDirLabelKey+"=true")),
	})
	if err != nil {
		a.logger.Warn("Skipping workdir sweep because shared-runner inventory failed", slog.String("host", host), slog.String("error", err.Error()))
		return
	}
	if pending > 0 || len(sharedRunners) > 0 {
		a.logger.Debug("Skipping workdir sweep while host has a shared-workdir runner or reservation", slog.String("host", host))
		return
	}
	if err := a.sweepHostWorkDir(ctx, client, host); err != nil {
		a.logger.Warn("Workdir sweep failed", slog.String("host", host), slog.String("error", err.Error()))
	}
}

func (a *Scaler) hostWorkDirLock(host string) *sync.Mutex {
	lock, _ := a.coordinator().hostWorkDirLocks.LoadOrStore(host, &sync.Mutex{})
	return lock.(*sync.Mutex)
}

// sweepStaleMinutes is the mtime staleness threshold sweepHostWorkDir uses to
// decide a top-level workdir entry is abandoned rather than a live checkout.
// Must exceed the longest read-only stretch of any fleet CI job: read-mostly
// phases (e2e suites, docker builds) can go well past 5 minutes without
// touching the checkout's mtime under relatime, and a threshold shorter than
// that window lets the sweep rm -rf a LIVE checkout mid-job during cap
// pressure. 60 minutes comfortably exceeds every known fleet job's
// read-only stretch while still reclaiming space well within a day.
const sweepStaleMinutes = 60

// sweepHostWorkDir always clears /home/runner/_work/_temp's contents (always
// safe -- GitHub Actions' own scratch dir) and, only once the shared
// directory exceeds workDirSizeCapBytes, deletes every top-level entry that
// isn't a known persistent cache (_tool, _actions, _PipelineMapping,
// .pnpm-store, cache) AND hasn't been modified in the last sweepStaleMinutes
// minutes. SweepWorkDirs' host-idle gate protects live jobs; the mtime check
// prevents recently-finished data from being discarded immediately. A
// finished job's leftover checkout eventually becomes a candidate.
// Deleting a checkout costs a fresh clone next time it's needed -- the same
// class of thing a non-shared runner container's writable layer would have
// discarded on its own when removed. See jlapenna/homelab's docs/incidents.md
// 2026-07-18: this shared dir has no per-container lifecycle, so without this
// nothing else ever reclaims it.
func (a *Scaler) sweepHostWorkDir(ctx context.Context, client *dockerclient.Client, host string) error {
	capBytes := a.workDirSizeCapBytes
	if override, ok := a.workDirSizeCaps[host]; ok {
		capBytes = override
	}
	script := fmt.Sprintf(`set -e
rm -rf /home/runner/_work/_temp/* 2>/dev/null || true
before=$(du -sb /home/runner/_work 2>/dev/null | cut -f1); before=${before:-0}
cap=%d
if [ "$before" -gt "$cap" ]; then
  # E2E caches are intentionally host-local (node_modules and browser HOME
  # are unsafe/slow on network storage), but they are not immortal. Evict
  # stale per-project caches first until this host is back under its cap.
  for d in /home/runner/_work/cache/e2e-docker/*/; do
    [ -d "$d" ] || continue
    current=$(du -sb /home/runner/_work 2>/dev/null | cut -f1); current=${current:-0}
    [ "$current" -le "$cap" ] && break
    if ! find "$d" -mmin -%d 2>/dev/null | grep -q .; then
      rm -rf "$d"
    fi
  done
  for d in /home/runner/_work/*/; do
    name=$(basename "$d")
    case "$name" in
      _tool|_actions|_PipelineMapping|.pnpm-store|cache|_temp) ;;
      *)
        if ! find "$d" -mmin -%d 2>/dev/null | grep -q .; then
          rm -rf "$d"
        fi
        ;;
    esac
  done
fi
after=$(du -sb /home/runner/_work 2>/dev/null | cut -f1); after=${after:-0}
echo "SWEEP before=$before after=$after cap=$cap"
`, capBytes, sweepStaleMinutes, sweepStaleMinutes)

	resp, err := client.ContainerCreate(ctx,
		&container.Config{
			Image:      a.runnerImage,
			User:       "root",
			Entrypoint: []string{"sh", "-c"},
			Cmd:        []string{script},
			Tty:        true,
		},
		&container.HostConfig{
			Binds: []string{"/home/runner/_work:/home/runner/_work"},
		},
		nil, nil, "",
	)
	if err != nil {
		return fmt.Errorf("creating workdir-sweep helper on host %q: %w", host, err)
	}
	defer func() {
		_ = client.ContainerRemove(context.WithoutCancel(ctx), resp.ID, container.RemoveOptions{Force: true})
	}()
	if err := client.ContainerStart(ctx, resp.ID, container.StartOptions{}); err != nil {
		return fmt.Errorf("starting workdir-sweep helper on host %q: %w", host, err)
	}
	statusCh, errCh := client.ContainerWait(ctx, resp.ID, container.WaitConditionNotRunning)
	select {
	case err := <-errCh:
		if err != nil {
			return fmt.Errorf("waiting for workdir-sweep helper on host %q: %w", host, err)
		}
	case status := <-statusCh:
		if status.StatusCode != 0 {
			return fmt.Errorf("workdir-sweep helper on host %q exited %d", host, status.StatusCode)
		}
	}

	logs, err := client.ContainerLogs(ctx, resp.ID, container.LogsOptions{ShowStdout: true})
	if err != nil {
		return fmt.Errorf("reading workdir-sweep helper logs on host %q: %w", host, err)
	}
	defer func() { _ = logs.Close() }()
	out, err := io.ReadAll(logs)
	if err != nil {
		return fmt.Errorf("reading workdir-sweep helper output on host %q: %w", host, err)
	}

	before, after, ok := parseSweepOutput(string(out))
	if !ok {
		a.logger.Warn("Could not parse workdir-sweep output", slog.String("host", host), slog.String("output", strings.TrimSpace(string(out))))
		return nil
	}
	workdirBytesGauge.WithLabelValues(host).Set(float64(after))
	if reclaimed := before - after; reclaimed > 0 {
		workdirSweptBytesTotal.WithLabelValues(host).Add(float64(reclaimed))
		a.logger.Info("Swept shared workdir", slog.String("host", host), slog.Int64("before_bytes", before), slog.Int64("after_bytes", after), slog.Int64("reclaimed_bytes", reclaimed))
	}
	return nil
}

var sweepOutputRe = regexp.MustCompile(`SWEEP before=(\d+) after=(\d+)`)

func parseSweepOutput(out string) (before, after int64, ok bool) {
	m := sweepOutputRe.FindStringSubmatch(out)
	if m == nil {
		return 0, 0, false
	}
	before, errB := strconv.ParseInt(m[1], 10, 64)
	after, errA := strconv.ParseInt(m[2], 10, 64)
	if errB != nil || errA != nil {
		return 0, 0, false
	}
	return before, after, true
}

// removeIdleRunners removes only runners that GitHub has not assigned. Busy
// runners are deliberately preserved across SIGTERM and adopted on startup.
func (a *Scaler) removeIdleRunners(ctx context.Context) {
	a.runners.mu.Lock()
	idle := make(map[string]runnerRef, len(a.runners.idle))
	for name, r := range a.runners.idle {
		idle[name] = r
	}
	clear(a.runners.idle)
	a.runners.mu.Unlock()

	for name, r := range idle {
		a.logger.Info("Removing runner", slog.String("name", name), slog.String("host", r.host), slog.String("containerID", r.containerID))
		client, err := a.hostClient(r.host)
		if err != nil {
			a.logger.Error("Failed to get docker host client for runner shutdown", slog.String("name", name), slog.String("host", r.host), slog.String("error", err.Error()))
			return
		}
		if err := client.ContainerRemove(ctx, r.containerID, container.RemoveOptions{Force: true}); err != nil {
			a.logger.Error("Failed to remove runner container", slog.String("name", name), slog.String("host", r.host), slog.String("error", err.Error()))
		}
		a.deregisterRunner(ctx, name)
	}
	a.updateRunnerMetrics()
}

// BeginDrain is idempotent. It refuses future scale-ups and removes idle
// capacity while allowing assigned jobs to finish normally. Operators send
// SIGUSR1, wait for runners_total=0, then recreate the container.
func (a *Scaler) BeginDrain(ctx context.Context) {
	if !a.draining.CompareAndSwap(false, true) {
		return
	}
	scaleSet := a.scaleSetLabel()
	drainingGauge.WithLabelValues(scaleSet).Set(1)
	a.logger.Info("Drain started; refusing new runner placements")
	a.removeIdleRunners(ctx)
}

func (a *Scaler) shutdown(ctx context.Context) {
	a.logger.Info("Shutting down control plane; preserving busy runners for startup adoption")
	a.removeIdleRunners(ctx)
}

var _ listener.Scaler = (*Scaler)(nil)

// runnerRef records where a runner lives: which host's docker client owns it
// and its container ID on that host.
type runnerRef struct {
	host        string
	containerID string
}

type runnerState struct {
	mu   sync.Mutex
	idle map[string]runnerRef
	busy map[string]runnerRef
}

func (r *runnerState) count() int {
	r.mu.Lock()
	count := len(r.idle) + len(r.busy)
	r.mu.Unlock()
	return count
}

// countsByHost returns the number of idle+busy runners per host name, used
// by pickHost to balance placement.
func (r *runnerState) countsByHost() map[string]int {
	r.mu.Lock()
	defer r.mu.Unlock()
	counts := make(map[string]int)
	for _, ref := range r.idle {
		counts[ref.host]++
	}
	for _, ref := range r.busy {
		counts[ref.host]++
	}
	return counts
}

func (r *runnerState) hasHost(host string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, ref := range r.idle {
		if ref.host == host {
			return true
		}
	}
	for _, ref := range r.busy {
		if ref.host == host {
			return true
		}
	}
	return false
}

// isTracked reports whether name is currently tracked as idle or busy. Used
// by cleanupOrphans' periodic pass to avoid racing startRunner's
// create->addIdle window.
func (r *runnerState) isTracked(name string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.idle[name]; ok {
		return true
	}
	_, ok := r.busy[name]
	return ok
}

// isBusy reports whether name is currently tracked as busy. Used by
// HandleJobStarted to distinguish an already-busy runner (informational)
// from a genuinely untracked one (a real anomaly worth a Warn).
func (r *runnerState) isBusy(name string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	_, ok := r.busy[name]
	return ok
}

func (r *runnerState) markBusy(name string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	ref, ok := r.idle[name]
	if !ok {
		return false
	}
	delete(r.idle, name)
	r.busy[name] = ref
	return true
}

func (r *runnerState) markDone(name string) (runnerRef, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.markDoneUnlocked(name)
}

func (r *runnerState) markDoneUnlocked(name string) (runnerRef, bool) {
	ref, ok := r.busy[name]
	if ok {
		delete(r.busy, name)
		return ref, true
	}
	ref, ok = r.idle[name]
	if ok {
		delete(r.idle, name)
		return ref, true
	}
	return runnerRef{}, false
}

func (r *runnerState) addIdle(name, host, containerID string) {
	r.mu.Lock()
	r.idle[name] = runnerRef{host: host, containerID: containerID}
	r.mu.Unlock()
}

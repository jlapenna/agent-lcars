package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net/http"
	"os/exec"
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
	// registrationURL is the non-secret GitHub organization/repository URL for
	// this scale set's registration. The console publishes it as an optional
	// operator link; it is never used for listener ownership or credentials.
	registrationURL string
	runners         runnerState
	runnerImage     string
	runnerMemory    int64
	// runnerPidsLimit: see Config.RunnerPidsLimit. Zero means no limit.
	runnerPidsLimit int64
	// runnerShmSize: see Config.RunnerShmSize. Zero means Docker's own
	// default (64m).
	runnerShmSize int64
	scaleSetID    int
	// Homelab change: a pool of docker hosts (local + SSH-proxied remotes)
	// instead of a single client, so ONE scale set/label can spread runners
	// across the whole fleet — see hosts.go. Order is round-robin fallback;
	// startRunner actually picks the LEAST LOADED host each time.
	dockerHosts []DockerHost
	// placementHosts is the subset of dockerHosts eligible for new runners.
	// During a live fleet shrink, dockerHosts retains a removed host only long
	// enough to finish and clean up its existing runners; placementHosts
	// cordons it immediately so no new work can land there.
	placementHosts []DockerHost
	scalesetClient *scaleset.Client
	minRunners     int
	maxRunners     int
	// queuedJobs is GitHub's latest desired-count signal: jobs waiting for
	// this scale set, before minRunners' warm capacity is added.
	queuedJobs atomic.Int64
	// shareWorkDir: see Config.ShareWorkDir. Gates everything that exists
	// because the host workdir is SHARED.
	shareWorkDir bool
	// fileMounts: see Config.FileMounts. Appended to the container's binds
	// with an explicit :ro -- the build-client lane uses these and nothing
	// else.
	fileMounts []FileMount
	// workDirSizeCapBytes: size ceiling for the shared /home/runner/_work
	// directory bind-mounted into every runner when ShareWorkDir is
	// set -- that shared dir has no per-container lifecycle to clean it up,
	// unlike a normal container's writable layer. Only enforced by
	// RunWorkDirSweeper, which is only started when ShareWorkDir is true
	// (split from the old MountDockerSocket flag in agent-lcars#101/#136;
	// MountDockerSocket itself was later removed entirely).
	workDirSizeCapBytes int64
	workDirSizeCaps     map[string]int64
	// pnpmStoreBudgetBytes/pnpmStoreBudgets (agent-lcars#852): the budget
	// pickHostLocked enforces against the shared pnpm content-addressable
	// store's LAST KNOWN size (cached by sweepHostWorkDir, refreshed on
	// every idle-host sweep and immediately after each job completes on
	// that host). A host at or above budget is excluded from new
	// shared-workdir placements -- see pnpmStoreOverBudget -- so a fat
	// store never grows further from a NEW job while the existing idle
	// sweep prunes/evicts it back down. Mirrors workDirSizeCapBytes/
	// workDirSizeCaps exactly, one level down: the store is one tenant of
	// the shared workdir, not an independent cap.
	pnpmStoreBudgetBytes int64
	pnpmStoreBudgets     map[string]int64
	hostRunnerLimits     map[string]int
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
	// quiescing refuses new placements during the fast shutdown path without
	// draining's destructive half. draining tears idle capacity down because
	// an operator asked for an empty fleet; quiescing only closes the window
	// between cancelling the listeners and writing the checkpoint, so a
	// placement cannot start after the state it would appear in was recorded.
	quiescing           atomic.Bool
	hostLoadPolicy      hostLoadPolicy
	hostMetricsTimeouts map[string]time.Duration
	hostMemoryExempt    map[string]bool
	// readiness* configure the operator-defined placement gate applied to
	// hosts that set require_readiness. See hostReady.
	readinessMetricsURL string
	readinessMetric     string
	readinessMaxAge     time.Duration
	logger              *slog.Logger
	// fleet is shared by every scale-set listener in orchestrator mode. Tests
	// and single-scaler construction paths get an equivalent private instance
	// lazily through coordinator().
	fleet          *FleetCoordinator
	localFleetOnce sync.Once
	localFleet     *FleetCoordinator
	// checkpoints persists runner state so a restart adopts the real
	// idle/busy split instead of re-deriving it from a process probe. Nil in
	// tests and single-scaler construction paths, where checkpoint() is a
	// no-op.
	checkpoints *checkpointStore
	// tearingDown names runners whose state has already been dropped from
	// a.runners but whose container removal has not finished yet. Every
	// teardown path untracks first and removes after, so in between the
	// container is running and untracked -- indistinguishable, to the
	// periodic sweep, from one the boot pass missed. Without this the sweep
	// would adopt a runner mid-teardown and be left holding an entry for a
	// container that no longer exists.
	tearingDown sync.Map // map[string]struct{}
	// bootCheckpoint is this scale set's slice of the checkpoint loaded at
	// startup, consulted only by cleanupOrphans' boot pass. Empty on a first
	// boot or an unreadable checkpoint, which falls adoption back to the
	// ContainerTop probe. Written once before any goroutine starts, then
	// read-only.
	bootCheckpoint map[string]checkpointRunner
}

// Docker's SSH ConnectTimeout only bounds the TCP connection. These caller
// deadlines also cover SSH banner exchange and a daemon that accepts a
// request but never completes it.
const (
	dockerInspectTimeout            = 10 * time.Second
	dockerContainerOperationTimeout = 30 * time.Second
	dockerContainerWaitTimeout      = 2 * time.Minute
	dockerImagePullTimeout          = 90 * time.Second
)

// beginTeardown marks a runner as being removed. Must be called BEFORE the
// call that drops it from a.runners, so the untracked window is never
// observable without the mark. endTeardown clears it once the container is
// actually gone.
func (a *Scaler) beginTeardown(name string) { a.tearingDown.Store(name, struct{}{}) }

func (a *Scaler) endTeardown(name string) { a.tearingDown.Delete(name) }

func (a *Scaler) isTearingDown(name string) bool {
	_, ok := a.tearingDown.Load(name)
	return ok
}

// adoptRunner records a runner recovered from a previous control-plane
// instance with a known idle/busy state, rather than inferring one.
func (a *Scaler) adoptRunner(name, host, containerID string, startedAt time.Time, busy bool, jobID ...string) {
	if !busy {
		a.runners.addIdle(name, host, containerID, startedAt)
		return
	}
	a.runners.mu.Lock()
	ref := runnerRef{host: host, containerID: containerID, startedAt: startedAt}
	if len(jobID) > 0 {
		ref.jobID = jobID[0]
	}
	a.runners.busy[name] = ref
	a.runners.mu.Unlock()
}

// checkpoint persists the current state immediately. Called after every
// idle/busy transition rather than on a timer: a transition lost to a kill is
// exactly the misclassification the checkpoint exists to prevent, and a
// runner recorded idle while GitHub has already assigned it a job is the case
// that makes an aggressive restart unsafe.
//
// Must not be called while holding runners.mu -- the snapshot takes it.
func (a *Scaler) checkpoint() {
	a.checkpoints.flush()
}

// snapshotRunners records the authoritative idle/busy split for this scale
// set. This is the half of the checkpoint Docker genuinely cannot reproduce:
// a container's existence is visible to ContainerList, but whether GitHub has
// assigned it a job is known only from the JobStarted/JobCompleted messages
// this process received.
func (a *Scaler) snapshotRunners() checkpointScaleSet {
	a.runners.mu.Lock()
	defer a.runners.mu.Unlock()
	runners := make(map[string]checkpointRunner, len(a.runners.idle)+len(a.runners.busy))
	for name, ref := range a.runners.idle {
		runners[name] = checkpointRunner{Host: ref.host, ContainerID: ref.containerID, StartedAt: ref.startedAt, Busy: false}
	}
	for name, ref := range a.runners.busy {
		runners[name] = checkpointRunner{Host: ref.host, ContainerID: ref.containerID, StartedAt: ref.startedAt, Busy: true, JobID: ref.jobID}
	}
	return checkpointScaleSet{Draining: a.draining.Load(), Runners: runners}
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
		a.localFleet = newFleetCoordinator(a.maxRunners, a.hostRunnerLimits, a.workDirSizeCaps, map[string]int{a.scaleSetName: 1}, []string{a.scaleSetName})
		a.localFleet.pnpmStoreBudgets = a.pnpmStoreBudgets
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
	// defaultPnpmStoreBudgetBytes is the shared pnpm-store budget
	// (agent-lcars#852) when a fleet host has no per-host pnpm_store_budget
	// override. 20 GiB comfortably fits under every workdir_size_cap
	// deployed today (the smallest is 30 GiB), leaving headroom for
	// checkouts, _tool/_actions caches, and e2e artifacts sharing the same
	// tree, while still bounding the store itself well below the point a
	// fat store alone could exhaust a tight host.
	defaultPnpmStoreBudgetBytes = 20 * 1024 * 1024 * 1024
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
	// Swap page rate DEPRIORITIZES but never excludes.
	// node_vmstat_pswpin/pswpout are kernel-global counters summed across
	// every swap device, so they cannot distinguish zram (compressed RAM,
	// microsecond latency) from a disk-backed swap file.
	//
	// pike runs both: Ubuntu's zram-config package puts /dev/zram0 at
	// priority 5 with vm.swappiness=180, so pages land in compressed RAM
	// first and its disk /swap.img (priority -1) stays nearly untouched.
	// Measured 2026-08-04: 12.4G of pages held in 5.4G of RAM via lzo-rle
	// against just 1.2G of 16G on the disk file, sustaining 634 pages/sec
	// averaged over 7 days. The old hard threshold read that healthy,
	// deliberate compression traffic as thrashing and removed the fleet's
	// most CPU-idle host (16 cores, 0.55 normalized load that same week)
	// from the candidate set 25.1% of the time.
	//
	// Memory PSI measures the actual stall rather than a proxy for it, and
	// put pike over psiHard only 1.7% of the time -- ~15x less often. So
	// the hard gate belongs to PSI and available-memory, which measure harm
	// directly and do not care which device backed the page. A host that is
	// genuinely thrashing to disk still stalls, so PSI still excludes it;
	// short of that it merely loses ties via the penalty here.
	if load.swapPagesPerSec >= p.swapHard {
		load.penalty = maxPenalty(load.penalty, 100)
	} else if load.swapPagesPerSec >= p.swapSoft {
		load.penalty = maxPenalty(load.penalty, 10)
	}
	return load
}

// probeHostLoad reads node_load1 and derives the logical CPU count from the
// number of idle CPU series. It fails open: telemetry trouble must not turn a
// healthy Docker host into a fleet outage.
func (a *Scaler) probeHostLoad(ctx context.Context, host string) (hostLoad, error) {
	if a.hostMetricsURLTemplate == "" && !a.coordinator().metricsViaSSH[host] {
		return hostLoad{}, nil
	}
	metrics, err := a.hostMetrics(ctx, host)
	if err != nil {
		return hostLoad{}, err
	}

	var load1, idleSeconds, memAvailable, memTotal, cpuPressure, memoryPressure, swapIn, swapOut float64
	var haveLoad bool
	cpus := make(map[string]struct{})
	scanner := bufio.NewScanner(bytes.NewReader(metrics))
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

// applyOverloadCooldown is the single authority that arms or extends a
// host's cooldown window: callers must pass a load whose .overloaded bit
// reflects a FRESH, raw scoreHostLoad result, measured right now, not a
// value that has already been through this function (directly or via the
// hostLoadCache). It is the arm/extend side of the state machine --
// refreshOverloadCooldown is the read-only side placement uses to re-check
// an existing window against the current time.
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

// refreshOverloadCooldown re-evaluates whether host should still be treated
// as overloaded for placement, against the live cooldown expiry, WITHOUT
// ever arming or extending it. currentHostLoad's cache can be up to
// 2*hostSampleInterval (30s) stale, and a cached entry's .overloaded bit is
// not necessarily a fresh raw reading -- probeHostLoad sets it via
// applyOverloadCooldown's check-only branch whenever a host's raw signal has
// already recovered but its cooldown window has not yet elapsed, and that
// cooldown-derived true then gets cached exactly like a genuine raw breach
// would.
//
// pickHostLocked used to feed that cached value straight back into
// applyOverloadCooldown to keep the cooldown check live against wall-clock
// time between probes. Because applyOverloadCooldown cannot distinguish "a
// fresh raw breach" from "an echo of my own prior cooldown-forcing," every
// such re-read re-armed the timer to now+cooldown -- so as long as placement
// kept retrying faster than the cooldown duration (guaranteed whenever
// there is pending demand), a host that had genuinely recovered could never
// actually exit cooldown (agent-lcars#259 follow-up).
//
// This performs only the read side: an .overloaded=false cached sample is
// left untouched (it can only have been produced when no cooldown was
// active, and cooldown windows never restart on their own, so it stays
// correct at any later time). An .overloaded=true sample is re-derived
// purely from whether `now` is still before the cooldown recorded by the
// last FRESH probe -- letting a window that has genuinely elapsed since the
// cached read expire on schedule, without ever writing overloadedUntil.
func (a *Scaler) refreshOverloadCooldown(host string, load hostLoad, now time.Time) hostLoad {
	if !load.overloaded {
		return load
	}
	fleet := a.coordinator()
	fleet.overloadMu.Lock()
	until := fleet.overloadedUntil[host]
	fleet.overloadMu.Unlock()
	if now.Before(until) {
		return load
	}
	load.overloaded = false
	load.penalty = 0
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

// runnersChanged is the single hook every runner state transition goes
// through: it republishes the gauges and persists the new state. Keeping both
// on one call is deliberate -- a transition that updated the metrics but not
// the checkpoint would leave the fleet looking correct while a restart
// silently misclassifies the runner, which is the exact failure the
// checkpoint exists to prevent. Add new transitions here, not to
// updateRunnerMetrics.
func (a *Scaler) runnersChanged() {
	a.updateRunnerMetrics()
	a.checkpoint()
}

func (a *Scaler) HandleDesiredRunnerCount(ctx context.Context, count int) (int, error) {
	a.queuedJobs.Store(int64(count))
	// Correct idle currentCount against reality BEFORE comparing it to demand --
	// a stale idle entry can otherwise pin desired == current forever and starve
	// every future scale-up. Busy entries are deliberately left to the periodic
	// full reconciliation: probing them here would put one slow Docker/SSH
	// inspect per busy runner on the listener callback's critical path.
	a.reconcileIdleRunners(ctx)
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
	defer a.runnersChanged()

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

// reconcileTrackedRunners checks every tracked runner -- idle and busy --
// against its authoritative Docker state and drops entries whose containers
// have stopped or vanished. HandleJobCompleted is normally the path that
// removes an idle/busy entry, but it can never arrive when the container dies
// after GitHub assigned a job and before the listener receives completion.
// Leaving that busy entry counted was the homelab#387 incident: desired count
// matched stale in-memory state while no corresponding runner existed.
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
// else leaves the entry tracked and gets logged instead -- otherwise a host
// having a bad moment over SSH would mass-deregister every healthy runner.
func (a *Scaler) reconcileTrackedRunners(ctx context.Context) {
	a.reconcileRunners(ctx, true)
}

// reconcileIdleRunners is the latency-sensitive listener-path subset of
// reconcileTrackedRunners. It clears entries which immediately block a
// scale-up, while the one-minute tracked-runner reconciler handles busy
// entries without serializing a desired-count callback behind Docker/SSH I/O.
func (a *Scaler) reconcileIdleRunners(ctx context.Context) {
	a.reconcileRunners(ctx, false)
}

func (a *Scaler) reconcileRunners(ctx context.Context, includeBusy bool) {
	type trackedEntry struct {
		name string
		ref  runnerRef
	}
	a.runners.mu.Lock()
	snapshot := make([]trackedEntry, 0, len(a.runners.idle)+len(a.runners.busy))
	for name, ref := range a.runners.idle {
		snapshot = append(snapshot, trackedEntry{name, ref})
	}
	if includeBusy {
		for name, ref := range a.runners.busy {
			snapshot = append(snapshot, trackedEntry{name, ref})
		}
	}
	a.runners.mu.Unlock()

	changed := false
	for _, e := range snapshot {
		client, err := a.hostClient(e.ref.host)
		if err != nil {
			continue
		}
		// Cap each Docker/SSH inspect so the listener's immediate idle pass
		// and the periodic full pass never inherit a kernel TCP timeout.
		inspectCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		info, inspectErr := client.ContainerInspect(inspectCtx, e.ref.containerID)
		cancel()

		if inspectErr == nil && info.State != nil && info.State.Running {
			continue
		}
		if inspectErr != nil && !cerrdefs.IsNotFound(inspectErr) {
			a.logger.Warn("Could not inspect tracked runner; keeping it tracked",
				slog.String("name", e.name), slog.String("host", e.ref.host), slog.String("error", inspectErr.Error()))
			continue
		}
		reason := "container no longer exists"
		metricReason := runnerDeadReasonNotFound
		if inspectErr == nil {
			reason = fmt.Sprintf("container state is %q, not running", info.State.Status)
			metricReason = runnerDeadReasonNotRunning
		}
		runner, state, ok := a.runners.markDoneWithState(e.name)
		if !ok {
			// HandleJobCompleted may have reconciled this snapshot entry while
			// ContainerInspect was in flight. It owns cleanup in that case.
			continue
		}
		a.logger.Warn("Reconciling tracked runner whose container is not actually running",
			slog.String("name", e.name), slog.String("host", runner.host), slog.String("state", state), slog.String("reason", reason))
		trackedRunnerMismatchTotal.WithLabelValues(a.scaleSetLabel(), runner.host, state, metricReason).Inc()
		if state == runnerTrackedStateIdle {
			// Keep the established crash-loop signal for idle runners while the
			// new mismatch metric covers both idle and busy state.
			runnerDiedIdleTotal.WithLabelValues(a.scaleSetLabel(), runner.host, metricReason).Inc()
		}
		a.deregisterRunner(ctx, e.name)
		changed = true
	}
	if changed {
		a.runnersChanged()
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
	if !a.runners.markBusy(jobInfo.RunnerName, jobInfo.JobID) {
		if a.runners.isBusy(jobInfo.RunnerName) {
			// Tracked and already busy -- e.g. a duplicate/replayed
			// JobStarted message. Not the same problem as a runner GitHub
			// knows about that this control plane has no record of at all.
			a.logger.Info("Received job started for already-busy runner", slog.String("runnerName", jobInfo.RunnerName))
		} else {
			a.logger.Warn("Received job started for untracked runner", slog.String("runnerName", jobInfo.RunnerName))
		}
	}
	a.runnersChanged()
	return nil
}

func (a *Scaler) HandleJobCompleted(ctx context.Context, jobInfo *scaleset.JobCompleted) error {
	scaleSet := a.scaleSetLabel()
	jobsCompletedCounter.WithLabelValues(scaleSet).Inc()
	a.logger.Info("Job completed", slog.Int64("runnerRequestId", jobInfo.RunnerRequestID), slog.String("jobId", jobInfo.JobID))

	// Marked before markDone and held until the container is gone: between
	// those two the container is running and untracked, which the periodic
	// sweep would otherwise adopt as a runner the boot pass had missed.
	a.beginTeardown(jobInfo.RunnerName)
	defer a.endTeardown(jobInfo.RunnerName)

	runner, ok := a.runners.markDone(jobInfo.RunnerName)
	a.runnersChanged()
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
	if a.shareWorkDir {
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
	// Bounded for the same reason removeIdleRunners' teardown is: both of
	// these are GitHub round trips reached from the drain path, which runs
	// inline in runOrchestrator's select loop. Best-effort already, so a
	// timeout costs nothing a slow API call would not have cost anyway --
	// the runner just stays a GitHub-side ghost until a later sweep.
	ctx, cancel := context.WithTimeout(ctx, deregisterRunnerTimeout)
	defer cancel()
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

func (a *Scaler) placementDockerHosts() []DockerHost {
	// Unit tests and the single-scaler path construct Scaler directly. Their
	// zero-value placementHosts retains the historical "all hosts place"
	// behavior.
	if len(a.placementHosts) == 0 {
		return a.dockerHosts
	}
	return a.placementHosts
}

func (a *Scaler) placementHostSet() map[string]bool {
	hosts := a.placementDockerHosts()
	set := make(map[string]bool, len(hosts))
	for _, host := range hosts {
		set[host.Name] = true
	}
	return set
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

// sparkIdleGPUWatts is the power-draw ceiling, in watts, below which spark's
// GB10 is considered idle rather than serving inference.
//
// llama-swap's GB10 readings are mostly unusable: gpu_util_percent,
// gpu_memory_used_bytes and gpu_memory_total_bytes all report 0 on this
// hardware (the Grace-Blackwell unified-memory design has no discrete VRAM
// pool to report), so the usual "is the GPU busy" signals are dead ends.
// Power draw is the one that actually tracks work: an idle module sits at
// ~10W (measured 9.94W on 2026-07-26 with a model resident but no requests
// in flight), against a ~140W module TDP under load. 30W leaves generous
// headroom over the idle floor while still tripping well before the GPU is
// saturated.
const sparkIdleGPUWatts = 30.0

// isSparkLoaded probes spark's metrics URL for signals that it's a bad
// placement target right now: active inference. Absolute free memory and
// allocated swap are deliberately ignored because resident model weights and
// K/V cache make those normal on Spark. The fleet sampler handles actual CPU,
// PSI, load, and active swap-I/O pressure independently.
//
// Two exposition formats are accepted, because the inference server behind
// this endpoint has changed once already and silently broke this probe:
//
//   - vLLM (`vllm:num_requests_running` / `_waiting`) — the original shape.
//   - llama-swap (`llamaswap_gpu_power_draw_watts`) — what spark:8000 serves
//     today. It publishes no request-count metric at all, so power draw
//     stands in for one; see sparkIdleGPUWatts.
//
// Matching both matters: the vLLM-only version of this function returned
// false on every call for as long as llama-swap has been the server, which
// silently disabled spark's inference protection entirely. The unit tests
// did not catch it because they feed synthetic `vllm:` lines rather than a
// real payload.
func (a *Scaler) isSparkLoaded(ctx context.Context) bool {
	return a.isSparkLoadedAbove(ctx, sparkIdleGPUWatts)
}

// isSparkLoadedAbove is isSparkLoaded with the idle ceiling injected. The
// seam exists so the probe can be re-verified against the LIVE spark
// endpoint by forcing the ceiling under the current idle draw: a probe that
// fires then is demonstrably parsing the real payload, not just synthetic
// fixtures. That distinction is not academic here -- the registry write-auth
// change (homelab#160/#163) was reverted precisely because it was validated
// against a path production does not use. The committed tests stay hermetic
// per agent-lcars#121; the live check is run by hand.
func (a *Scaler) isSparkLoadedAbove(ctx context.Context, ceiling float64) bool {
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
		case strings.HasPrefix(line, "llamaswap_gpu_power_draw_watts"):
			if val, ok := parseMetricValue(line); ok && val > ceiling {
				a.logger.Info("Spark has active inference load, deprioritizing placement",
					slog.String("metric", strings.Fields(line)[0]),
					slog.Float64("value", val),
					slog.Float64("idle_ceiling_watts", ceiling),
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
// Hard overload is different from a soft penalty: a host scoreHostLoad marks
// hard-overloaded (load/CPU/PSI/memory pressure past its *Hard threshold --
// swap rate is deliberately excluded, see scoreHostLoad), or one still
// inside applyOverloadCooldown's post-overload
// window, is removed from the candidate set entirely rather than merely
// deprioritized -- a virtual penalty only changes which candidate wins a
// tie, so with a soft penalty alone a lowest-effective-count comparison
// among a fully pressured fleet still placed a runner on whichever
// overloaded host looked (barely) least bad (agent-lcars#259). If that
// leaves zero candidates, pickHost reports fleet-at-capacity
// (placementReasonOverload) and leaves demand pending rather than placing
// anyway; the caller's reconciliation is level-triggered, so it retries once
// a host's pressure or cooldown clears.
//
// This is intentionally separate from missing telemetry: a host whose probe
// fails outright only gets hostLoadPolicy.telemetryPenalty, a small
// deprioritization, and stays a candidate -- see probeHostLoad's "fails
// open" comment. Confirmed overload (we HAVE pressure data and it is bad) is
// the opposite of absent data, and conflating the two would turn a telemetry
// outage into a fleet outage.
//
// When shareWorkDir is set, reachable hosts that already have >=1 runner
// from this scale set placed on them are excluded outright rather than just
// deprioritized: shared-workdir runners share the placement host's
// /home/runner/_work bind mount, so two same-scale-set runners on one host
// resolve the same repo to the same checkout directory (_PipelineMapping)
// and can corrupt each other's checkout mid-job. This mirrors the
// one-per-host layout the retired static runners used. If that leaves zero
// candidate hosts, pickHost returns an error -- the caller's reconciliation
// is level-triggered, so it retries once a host frees up.
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
	placementHosts := a.placementHostSet()

	type pingResult struct {
		host                 DockerHost
		ok                   bool
		eligible             bool
		err                  error
		load                 hostLoad
		loadErr              error
		fleetRunners         int
		sharedWorkDirRunners int
		// readinessBlocked distinguishes "this host was withheld by its
		// readiness gate" from "this host is unreachable", so exhausting the
		// fleet reports the real cause instead of blaming the network.
		readinessBlocked bool
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
			eligible := err == nil && placementHosts[dh.Name]
			if eligible && fleet.mainsRequired[dh.Name] {
				if mainsErr := a.hostOnMains(ctx, dh.Name); mainsErr != nil {
					eligible = false
					loadErr = errors.Join(loadErr, fmt.Errorf("mains power required: %w", mainsErr))
				}
			}
			readinessBlocked := false
			if eligible && fleet.readinessRequired[dh.Name] {
				if readyErr := a.hostReady(ctx, dh.Name); readyErr != nil {
					eligible = false
					readinessBlocked = true
					hostReadyGauge.WithLabelValues(dh.Name).Set(0)
					loadErr = errors.Join(loadErr, fmt.Errorf("host readiness required: %w", readyErr))
				} else {
					hostReadyGauge.WithLabelValues(dh.Name).Set(1)
				}
			}
			ch <- pingResult{host: dh, ok: err == nil, eligible: eligible, err: err, load: load, loadErr: loadErr, fleetRunners: fleetRunners, sharedWorkDirRunners: sharedWorkDirRunners, readinessBlocked: readinessBlocked}
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
				// Read-only re-check against wall-clock time, NOT
				// applyOverloadCooldown: res.load may be a cache read up to
				// 2*hostSampleInterval stale, and its .overloaded bit may
				// already be cooldown-derived rather than a fresh raw
				// reading. Feeding that back into applyOverloadCooldown
				// would re-arm the cooldown from an echo of itself every
				// time placement re-reads it -- see refreshOverloadCooldown.
				res.load = a.refreshOverloadCooldown(res.host.Name, res.load, time.Now())
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
			if res.ok && res.eligible && res.host.Name == configured.Name {
				reachableHosts = append(reachableHosts, configured)
				break
			}
		}
	}

	if len(reachableHosts) == 0 {
		// A host withheld by its readiness gate is reachable and healthy, so
		// reporting it as "unreachable" would send whoever reads this at the
		// network instead of at the signal that actually withheld it.
		readinessBlocked := 0
		for _, res := range results {
			if res.readinessBlocked {
				readinessBlocked++
			}
		}
		if readinessBlocked > 0 {
			placementBlocked.WithLabelValues(scaleSet, placementReasonReadiness).Inc()
			return "", fmt.Errorf("no docker host is eligible (%d withheld by their readiness gate): %w", readinessBlocked, errFleetAtCapacity)
		}
		return "", fmt.Errorf("all %d configured docker hosts are unreachable: %w", len(placementHosts), errFleetAtCapacity)
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
		placementBlocked.WithLabelValues(scaleSet, placementReasonFleetLimit).Inc()
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
		placementBlocked.WithLabelValues(scaleSet, placementReasonHostLimits).Inc()
		return "", fmt.Errorf("every reachable docker host is at its configured runner limit: %w", errFleetAtCapacity)
	}

	// Hard-overloaded hosts (and hosts still inside their post-overload
	// cooldown -- see applyOverloadCooldown) are excluded outright, not just
	// deprioritized by their virtual penalty. Without this, "lowest
	// effective count wins" still placed a runner on the least-bad-looking
	// overloaded host once every candidate was pressured (agent-lcars#259).
	// A host with merely MISSING telemetry is not touched here: it only
	// carries hostLoadPolicy.telemetryPenalty and stays a candidate, per
	// probeHostLoad's fail-open policy.
	var notOverloaded []DockerHost
	for _, h := range withinHostLimits {
		if !hostLoads[h.Name].overloaded {
			notOverloaded = append(notOverloaded, h)
		}
	}
	if len(notOverloaded) == 0 {
		placementBlocked.WithLabelValues(scaleSet, placementReasonOverload).Inc()
		return "", fmt.Errorf("every reachable docker host within its runner limit is hard-overloaded or in overload cooldown: %w", errFleetAtCapacity)
	}
	withinHostLimits = notOverloaded

	candidates := withinHostLimits
	if a.shareWorkDir {
		var withCapacity []DockerHost
		// Preserve the fleet-wide policy filter above. Iterating reachableHosts
		// here used to reintroduce hosts already removed by runner_limit, which
		// let E2E placements bypass Janeway's limit while other scale sets
		// enforced it correctly.
		for _, h := range withinHostLimits {
			if counts[h.Name] == 0 && sharedWorkDirCounts[h.Name] == 0 && fleet.sharedWorkDirReservations[h.Name] == 0 {
				withCapacity = append(withCapacity, h)
			}
		}
		if len(withCapacity) == 0 {
			// Exclusivity saturation is a real placement-capacity cause and
			// belongs alongside fleet_limit/host_limits, not only in the logs:
			// without its own reason, a pending backlog on a shared-workdir
			// scale set is indistinguishable in Prometheus from a listener or
			// host outage.
			placementBlocked.WithLabelValues(scaleSet, placementReasonSharedWorkDirExclusive).Inc()
			return "", fmt.Errorf("shared-workdir scale set %q: every reachable docker host already has a runner placed: %w", scaleSet, errFleetAtCapacity)
		}
		candidates = withCapacity

		// agent-lcars#852: refuse a NEW shared-workdir placement on a host
		// whose pnpm store is already at/over budget, rather than let it grow
		// further before the next idle sweep prunes/evicts it. Every
		// candidate here is already confirmed idle (the loop above), so
		// excluding one here never touches an active job -- it just leaves
		// that host idle a little longer, which is exactly what lets the
		// sweep clear it.
		var underPnpmBudget []DockerHost
		for _, h := range candidates {
			if !a.pnpmStoreOverBudget(fleet, h.Name) {
				underPnpmBudget = append(underPnpmBudget, h)
			}
		}
		if len(underPnpmBudget) == 0 {
			placementBlocked.WithLabelValues(scaleSet, placementReasonPnpmStoreBudget).Inc()
			return "", fmt.Errorf("shared-workdir scale set %q: every host with placement capacity is over its pnpm store budget: %w", scaleSet, errFleetAtCapacity)
		}
		candidates = underPnpmBudget
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

// pnpmStoreOverBudget reports whether host's last-known shared pnpm-store
// size is at or above its configured budget (agent-lcars#852). Reads
// fleet.pnpmStoreBytes, a cache populated by sweepHostWorkDir on every
// idle-host sweep -- periodic (workDirSweepInterval) and immediately after
// each job completes on that host (see HandleJobCompleted) -- rather than
// measuring live: the sweep already keeps this fresh at every natural
// idle boundary, and a synchronous du(1) here would add filesystem latency
// to every placement decision for no material gain in freshness.
//
// A host with no cached measurement yet (never swept, e.g. brand new or
// freshly booted) fails OPEN, same policy as probeHostLoad's missing-
// telemetry handling: excluding it would otherwise permanently lock out a
// host until its first sweep, which only runs once it has capacity to be
// picked in the first place.
func (a *Scaler) pnpmStoreOverBudget(fleet *FleetCoordinator, host string) bool {
	fleet.pnpmStoreMu.Lock()
	bytes, ok := fleet.pnpmStoreBytes[host]
	fleet.pnpmStoreMu.Unlock()
	if !ok {
		return false
	}
	budget := a.resolvedPnpmStoreBudget(host)
	if budget <= 0 {
		return false
	}
	return bytes >= budget
}

// resolvedPnpmStoreBudget returns host's effective pnpm-store budget: its
// per-host override if configured, else the scale set's default
// (pnpmStoreBudgetBytes, itself defaultPnpmStoreBudgetBytes unless the
// process overrides it). Shared by pnpmStoreOverBudget (the placement gate)
// and sweepHostWorkDir (which threads it into workDirSweepScript as the
// SECOND, independent maintenance trigger) so the two can never resolve a
// different number for the same host.
func (a *Scaler) resolvedPnpmStoreBudget(host string) int64 {
	if override, has := a.pnpmStoreBudgets[host]; has {
		return override
	}
	return a.pnpmStoreBudgetBytes
}

// hostOnMains is deliberately fail-closed for mains-required hosts: a missing
// or unreadable exporter signal must never spend the workstation battery.
func (a *Scaler) hostOnMains(ctx context.Context, host string) error {
	metrics, err := a.hostMetrics(ctx, host)
	if err != nil {
		return err
	}
	s := bufio.NewScanner(bytes.NewReader(metrics))
	seen := false
	for s.Scan() {
		line := s.Text()
		if strings.HasPrefix(line, "node_power_supply_online{") {
			seen = true
			if value, ok := parseMetricValue(line); ok && value > 0 {
				return nil
			}
		}
	}
	if err := s.Err(); err != nil {
		return err
	}
	if !seen {
		return errors.New("mains telemetry missing")
	}
	return errors.New("host is on battery")
}

// readinessClockSkewTolerance is how far ahead of the reader a readiness
// timestamp may sit before the signal is rejected as broken rather than
// fresh. Generous enough for ordinary NTP drift between two machines, far
// tighter than any plausible max-age.
const readinessClockSkewTolerance = 2 * time.Minute

// metricLabelValue returns the value of the named label in a Prometheus
// exposition line, and whether that exact label was present.
//
// Deliberately parses the label set instead of substring-matching
// `name="value"`: label keys are matched whole, so a series carrying
// target_host or node_host cannot answer for a query about host.
func metricLabelValue(line, label string) (string, bool) {
	open := strings.Index(line, "{")
	if open < 0 {
		return "", false
	}
	close := strings.LastIndex(line, "}")
	if close < open {
		return "", false
	}

	body := line[open+1 : close]
	inQuotes := false
	escaped := false
	start := 0
	for i := 0; i <= len(body); i++ {
		// Split on commas outside quotes -- a label VALUE may legitimately
		// contain a comma, so a plain strings.Split would corrupt the pair.
		if i < len(body) {
			c := body[i]
			switch {
			case escaped:
				escaped = false
				continue
			case c == '\\' && inQuotes:
				escaped = true
				continue
			case c == '"':
				inQuotes = !inQuotes
				continue
			case c != ',' || inQuotes:
				continue
			}
		}
		key, value, found := strings.Cut(body[start:i], "=")
		start = i + 1
		if !found || strings.TrimSpace(key) != label {
			continue
		}
		value = strings.TrimSpace(value)
		if unquoted, err := strconv.Unquote(value); err == nil {
			return unquoted, true
		}
		return strings.Trim(value, `"`), true
	}
	return "", false
}

// hostReady consults the operator-supplied readiness signal for a host that
// set require_readiness, returning nil only when that host may take work.
//
// The autoscaler deliberately holds no opinion about what readiness means --
// it reads a gauge the operator publishes and honors the verdict. Reachability
// is not always enough to decide a host should run CI: a laptop reachable over
// a mesh VPN may be reachable from anywhere, including places its owner would
// rather it not be building.
//
// Fail-CLOSED, for the same reason as hostOnMains: an unreadable signal is not
// evidence of readiness, and treating it as such defeats the gate precisely
// when the machinery behind it is broken.
func (a *Scaler) hostReady(ctx context.Context, host string) error {
	if a.readinessMetricsURL == "" || a.readinessMetric == "" {
		return errors.New("readiness gate is not configured")
	}

	reqCtx, cancel := context.WithTimeout(ctx, hostMetricsTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, a.readinessMetricsURL, nil)
	if err != nil {
		return err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("read readiness metrics: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("readiness metrics returned HTTP %d", resp.StatusCode)
	}

	wantPrefix := fmt.Sprintf("%s{", a.readinessMetric)
	stampPrefix := a.readinessMetric + "_timestamp_seconds"

	var (
		ready     bool
		seen      bool
		stamp     float64
		stampSeen bool
		scanner   = bufio.NewScanner(resp.Body)
	)
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "#") {
			continue
		}
		switch {
		case strings.HasPrefix(line, wantPrefix):
			// Require an exact `host` label rather than testing for the
			// substring `host="..."`: a series carrying some other label
			// that merely ends in "host" (target_host, node_host) would
			// otherwise satisfy the gate, letting a mislabelled signal make
			// the host placeable instead of failing closed.
			if got, ok := metricLabelValue(line, "host"); !ok || got != host {
				continue
			}
			seen = true
			if value, ok := parseMetricValue(line); ok && value > 0 {
				ready = true
			}
		case strings.HasPrefix(line, stampPrefix):
			if value, ok := parseMetricValue(line); ok {
				stamp, stampSeen = value, true
			}
		}
	}
	if err := scanner.Err(); err != nil {
		return err
	}

	if !seen {
		return fmt.Errorf("readiness metric %q missing for host %q", a.readinessMetric, host)
	}
	if a.readinessMaxAge > 0 {
		if !stampSeen {
			return fmt.Errorf("readiness freshness metric %q missing", stampPrefix)
		}
		age := time.Since(time.Unix(int64(stamp), 0))
		// A timestamp materially in the future is not evidence of freshness:
		// time.Since goes negative, so the staleness test below could never
		// fire and a publisher that later died would stay "fresh" until the
		// local clock caught up. Emitting milliseconds where seconds are
		// expected lands ~55000 years ahead and would disable the gate
		// outright, so treat it as a broken signal. The tolerance absorbs
		// ordinary NTP skew between publisher and reader.
		if age < -readinessClockSkewTolerance {
			return fmt.Errorf("readiness signal timestamp is %s in the future", (-age).Round(time.Second))
		}
		// A publisher that stops updating leaves its last reading served
		// indefinitely; without this the gate would keep honoring a verdict
		// that stopped tracking reality.
		if age > a.readinessMaxAge {
			return fmt.Errorf("readiness signal is stale by %s", age.Round(time.Second))
		}
	}
	if !ready {
		return errors.New("host is not ready for placement")
	}
	return nil
}

// hostMetrics reads node-exporter through HTTP by default. WSL guests can opt
// into the same pinned SSH transport as their Docker daemon, avoiding a
// Windows-side port forward solely for safe placement telemetry.
func (a *Scaler) hostMetrics(ctx context.Context, host string) ([]byte, error) {
	timeout := hostMetricsTimeout
	if configured, ok := a.hostMetricsTimeouts[host]; ok {
		timeout = configured
	}
	probeCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	fleet := a.coordinator()
	if fleet.metricsViaSSH[host] {
		var target string
		for _, h := range a.dockerHosts {
			if h.Name == host {
				target = h.Target
				break
			}
		}
		if !strings.HasPrefix(target, "ssh://") {
			return nil, fmt.Errorf("host %q has no SSH Docker target", host)
		}
		sshTimeoutSeconds := max(1, int(math.Ceil(timeout.Seconds())))
		cmd := exec.CommandContext(probeCtx, "ssh", "-i", fleetSSHKeyPath,
			"-o", "IdentitiesOnly=yes", "-o", "UserKnownHostsFile="+fleetKnownHostsPath,
			"-o", "StrictHostKeyChecking=yes", "-o", "ControlMaster=no",
			"-o", fmt.Sprintf("ConnectTimeout=%d", sshTimeoutSeconds), strings.TrimPrefix(target, "ssh://"),
			fmt.Sprintf("curl -fsS --max-time %d http://127.0.0.1:9100/metrics", sshTimeoutSeconds))
		output, err := cmd.Output()
		if err != nil {
			return nil, fmt.Errorf("read metrics over SSH: %w", err)
		}
		return output, nil
	}
	if a.hostMetricsURLTemplate == "" {
		return nil, errors.New("host metrics URL template is not configured")
	}
	req, err := http.NewRequestWithContext(probeCtx, http.MethodGet, fmt.Sprintf(a.hostMetricsURLTemplate, host), nil)
	if err != nil {
		return nil, err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("metrics returned HTTP %d", resp.StatusCode)
	}
	return io.ReadAll(resp.Body)
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
	// One goroutine per host, mirroring pickHostLocked and pullRunnerImages.
	// Serially, a single wedged fleet host stalled every host after it in the
	// list -- and because initializeGitHubScaleSet runs this before its
	// listener connects, every scale set paid that stall independently before
	// it could accept work (agent-lcars#511: ~70s to reach all listeners up,
	// with the process itself down for barely a second).
	var wg sync.WaitGroup
	for _, h := range a.dockerHosts {
		wg.Add(1)
		go func(h DockerHost) {
			defer wg.Done()
			a.cleanupOrphansOnHost(ctx, h, boot)
		}(h)
	}
	wg.Wait()
	a.runnersChanged()
}

// hostReachableTimeout bounds the reachability probe that gates each host's
// orphan sweep. Same 5s budget pickHostLocked uses, for the same reason: a
// cold SSH handshake can exceed a tighter bound and would flap a healthy host.
const hostReachableTimeout = 5 * time.Second

// orphanSweepHostTimeout bounds the actual sweep work per host, after the
// reachability probe has passed. The probe alone is not enough -- a host can
// answer a ping and then wedge mid-transfer, and SSH's ConnectTimeout covers
// only TCP connect, not a server that accepts the connection and never
// completes the banner exchange (the live agent-lcars#511 failure mode).
const orphanSweepHostTimeout = 60 * time.Second

// cleanupOrphansOnHost runs the sweep for one fleet host. Safe to call
// concurrently for different hosts: every runnerState mutation below takes
// its mutex, and each host owns a disjoint set of containers.
func (a *Scaler) cleanupOrphansOnHost(ctx context.Context, h DockerHost, boot bool) {
	// Fail fast on an unreachable host rather than blocking the sweep on it.
	// Skipping means its containers are not adopted on this pass -- already
	// the behavior when the list call itself errored, and the periodic
	// sweeper plus the next reconcile pick them up, so no guarantee changes.
	pingCtx, cancelPing := context.WithTimeout(ctx, hostReachableTimeout)
	_, pingErr := h.Client.Ping(pingCtx)
	cancelPing()
	if pingErr != nil {
		a.logger.Warn("Skipping unreachable docker host during orphan cleanup",
			slog.String("host", h.Name), slog.String("error", pingErr.Error()))
		return
	}

	ctx, cancel := context.WithTimeout(ctx, orphanSweepHostTimeout)
	defer cancel()

	containers, err := h.Client.ContainerList(ctx, container.ListOptions{All: true})
	if err != nil {
		a.logger.Warn("Failed to list containers on docker host during orphan cleanup", slog.String("host", h.Name), slog.String("error", err.Error()))
		return
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
			a.adoptRunningContainer(ctx, h, c, cleanName, a.bootCheckpoint)
			continue
		}

		if !boot {
			if a.runners.isTracked(cleanName) {
				continue
			}
			// Untracked because it is being torn down right now, not
			// because the boot pass missed it. Adopting here would leave
			// an entry pointing at a container that is about to vanish.
			if a.isTearingDown(cleanName) {
				continue
			}
			if time.Since(time.Unix(c.Created, 0)) <= orphanMinAge {
				continue
			}
			if c.State == container.StateRunning {
				// Adopt rather than skip. A running container this scale
				// set owns but is not tracking is not a container to leave
				// alone: it counts against neither host limits nor fleet
				// capacity, and when its job finishes HandleJobCompleted
				// finds no entry to reconcile, so the container is never
				// removed and leaks until the process restarts.
				//
				// Reachable only when the boot pass missed it -- the host
				// was unreachable, or its list call failed. Before the
				// per-host reachability gate that was rare enough to go
				// unnoticed; the gate makes skipping a host cheap and
				// therefore more likely, so this pass has to be able to
				// recover from it rather than waiting for a restart.
				//
				// The orphanMinAge check above (10 minutes) already ran, so
				// this cannot race startRunner's create->addIdle window,
				// which closes in seconds.
				//
				// Deliberately probe rather than consult the checkpoint:
				// the checkpoint's value is at boot, for a runner GitHub
				// assigned a job to seconds ago. This container has been
				// running for over ten minutes, so that window is long
				// past and a live probe is the more current answer.
				a.adoptRunningContainer(ctx, h, c, cleanName, nil)
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

// adoptRunningContainer records a running container this scale set owns but
// is not currently tracking, classifying it idle or busy.
//
// recorded is the checkpoint to trust when it holds an entry, or nil to
// classify purely by probe. A checkpoint entry is authoritative because it
// records the split this process observed from GitHub's JobStarted/
// JobCompleted messages, whereas ContainerTop can only report whether a
// Runner.Worker process exists YET -- so a runner GitHub has already assigned
// a job to, but which is still pulling its image or checking out, probes as
// idle. Anything that reaps idle capacity then kills a live job, which is the
// misclassification that used to make a restart require a full drain.
//
// A probe error classifies busy: refusing to remove a runner that turns out
// to be idle costs one runner slot until its next reconcile, while removing
// one that turns out to be busy kills a job.
func (a *Scaler) adoptRunningContainer(ctx context.Context, h DockerHost, c container.Summary, cleanName string, recorded map[string]checkpointRunner) {
	startedAt := time.Unix(c.Created, 0)
	if entry, ok := recorded[cleanName]; ok {
		a.adoptRunner(cleanName, h.Name, c.ID, startedAt, entry.Busy, entry.JobID)
		a.logger.Info("Adopted runner from checkpoint",
			slog.String("host", h.Name), slog.String("name", cleanName),
			slog.String("containerID", c.ID), slog.Bool("busy", entry.Busy))
		return
	}
	top, topErr := h.Client.ContainerTop(ctx, c.ID, []string{"-eo", "pid,args"})
	if topErr == nil && !topHasRunnerWorker(top) {
		a.adoptRunner(cleanName, h.Name, c.ID, startedAt, false)
		a.logger.Info("Adopted idle runner from previous control-plane instance",
			slog.String("host", h.Name), slog.String("name", cleanName), slog.String("containerID", c.ID))
		return
	}
	a.adoptRunner(cleanName, h.Name, c.ID, startedAt, true)
	a.logger.Info("Adopted busy runner from previous control-plane instance",
		slog.String("host", h.Name), slog.String("name", cleanName),
		slog.String("containerID", c.ID), slog.Any("top_error", topErr))
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
// just a shareWorkDir one (unlike RunWorkDirSweeper) -- any scale set can
// leak a container this way. Deliberately does NOT run an initial sweep on
// entry: the boot-time cleanupOrphans(ctx, true) call in main.go's run()
// already covers startup.
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
// startRunner so the shared-workdir bind versus scoped read-only file
// mounts are unit testable without a docker daemon.
//
// File mounts are ALWAYS :ro. Config validation already bounds their
// sources to fleet.file_mount_allowlist and rejects the docker socket
// outright; read-only is the last of those two guards and the cheapest.
func runnerBinds(shareWorkDir bool, fileMounts []FileMount) []string {
	var binds []string
	if shareWorkDir {
		binds = append(binds,
			"/home/runner/_work:/home/runner/_work",
			"/home/runner/externals:/home/runner/externals",
		)
	}
	for _, m := range fileMounts {
		binds = append(binds, fmt.Sprintf("%s:%s:ro", m.HostPath, m.ContainerPath))
	}
	return binds
}

// runnerHostConfig builds the HostConfig for a newly created runner
// container. Extracted from startRunner (mirroring runnerBinds above) so the
// resource-limit wiring is unit-testable without a live Docker API. A zero
// pidsLimit means "no limit" -- container.Resources.PidsLimit is a pointer
// specifically so that omitting it (nil) reads as "don't change/unlimited"
// to the Docker API, which a literal 0 would not.
func runnerHostConfig(binds []string, memory, pidsLimit, shmSize int64) *container.HostConfig {
	resources := container.Resources{Memory: memory}
	if pidsLimit > 0 {
		limit := pidsLimit
		resources.PidsLimit = &limit
	}
	return &container.HostConfig{
		Binds:     binds,
		ShmSize:   shmSize,
		Resources: resources,
	}
}

func (a *Scaler) startRunner(ctx context.Context) (string, error) {
	if a.draining.Load() {
		return "", fmt.Errorf("scale set %q is draining", a.scaleSetName)
	}
	if a.quiescing.Load() {
		return "", fmt.Errorf("scale set %q is quiescing for shutdown", a.scaleSetName)
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
	if a.shareWorkDir {
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

	binds := runnerBinds(a.shareWorkDir, a.fileMounts)
	// Docker creates a missing _work/externals as root:root on a host's
	// first placement, and the runner is non-root -- so a shared-workdir
	// pool could not create the entrypoint lock or populate externals, and
	// every placement would crash-loop.
	if a.shareWorkDir {
		if err := a.ensureWorkDirOwnership(ctx, client, host); err != nil {
			a.logger.Warn("Failed to normalize shared workdir ownership before runner start", slog.String("host", host), slog.String("error", err.Error()))
		}
	}
	hostConfig := runnerHostConfig(binds, a.runnerMemory, a.runnerPidsLimit, a.runnerShmSize)

	c, err := a.createContainerWithImageRecovery(
		ctx,
		client,
		host,
		&container.Config{
			Image: a.runnerImage,
			User:  "runner",
			Cmd:   []string{"/home/runner/run.sh"},
			Labels: map[string]string{
				runnerScaleSetLabelKey:      a.scaleSetName,
				runnerRegistrationLabelKey:  a.registrationName,
				runnerSharedWorkDirLabelKey: strconv.FormatBool(a.shareWorkDir),
			},
			Env: []string{
				fmt.Sprintf("ACTIONS_RUNNER_INPUT_JITCONFIG=%s", jit.EncodedJITConfig),
			},
		},
		hostConfig,
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

	startCtx, cancelStart := context.WithTimeout(ctx, dockerContainerOperationTimeout)
	err = client.ContainerStart(startCtx, c.ID, container.StartOptions{})
	cancelStart()
	if err != nil {
		runnerStartFailures.WithLabelValues(scaleSet, host).Inc()
		// Same ghost-registration gap and detached-context reasoning as
		// above, plus the container itself now exists (created but never
		// started) and needs cleanup too.
		cleanupCtx := context.WithoutCancel(ctx)
		a.deregisterRunner(cleanupCtx, name)
		removeCtx, cancelRemove := context.WithTimeout(cleanupCtx, dockerContainerOperationTimeout)
		rmErr := client.ContainerRemove(removeCtx, c.ID, container.RemoveOptions{Force: true})
		cancelRemove()
		if rmErr != nil {
			a.logger.Warn("Failed to remove container that failed to start", slog.String("host", host), slog.String("containerID", c.ID), slog.String("error", rmErr.Error()))
		}
		return "", fmt.Errorf("failed to start runner container on host %q: %w", host, err)
	}

	runnerStartDuration.WithLabelValues(scaleSet, host).Observe(time.Since(start).Seconds())
	a.logger.Info("Placed runner", slog.String("name", name), slog.String("host", host))
	a.runners.addIdle(name, host, c.ID, time.Now())
	a.runnersChanged()
	return name, nil
}

// isDigestRef reports whether an image reference pins a content digest
// (name@sha256:...), which makes it immutable and therefore safe to serve
// from the local cache without consulting the registry.
func isDigestRef(ref string) bool {
	at := strings.LastIndex(ref, "@")
	if at < 0 {
		return false
	}
	// Guard against a digest-looking fragment inside a registry host:port or
	// path segment by requiring the '@' to precede an algo:hex form.
	return strings.Contains(ref[at+1:], ":")
}

func (a *Scaler) ensureRunnerImage(ctx context.Context, client *dockerclient.Client, host string) error {
	key := host + "\x00" + a.runnerImage
	lockValue, _ := a.hostImageLocks.LoadOrStore(key, &sync.Mutex{})
	lock := lockValue.(*sync.Mutex)
	if !lockMutexContext(ctx, lock) {
		return fmt.Errorf("waiting to prepare runner image %q on host %q: %w", a.runnerImage, host, ctx.Err())
	}
	defer lock.Unlock()

	// A DIGEST reference is immutable, so a local hit is authoritative and
	// re-pulling could never change the bytes. Skip the registry round-trip.
	//
	// A TAG is not. Treating a local hit as authoritative there is
	// agent-lcars#139: the tag moves in the registry, every host keeps
	// booting whatever it pulled first, and nothing surfaces the
	// divergence. Observed 2026-07-27 with e2e-runner:latest -- four of five
	// hosts served a stale image for hours while the fixed one sat published,
	// and a CI job failed against code that had already been corrected. The
	// only thing that ever refreshed a tag was the twice-daily prune
	// deleting it locally so this function's not-found path finally ran,
	// which also means a rebuilt image published to REMOVE something (a CVE
	// fix, or #138 stripping the Docker CLI) did not take effect until an
	// unrelated GC happened to fire.
	//
	// So: always pull for a tag. Layers are already local in the common
	// case, making this a manifest check rather than a transfer.
	if isDigestRef(a.runnerImage) {
		inspectCtx, cancelInspect := context.WithTimeout(ctx, dockerInspectTimeout)
		_, err := client.ImageInspect(inspectCtx, a.runnerImage)
		cancelInspect()
		if err == nil {
			return nil
		} else if !cerrdefs.IsNotFound(err) {
			return fmt.Errorf("failed to inspect runner image %q on host %q: %w", a.runnerImage, host, err)
		}
	}

	a.logger.Info("Refreshing runner image on selected host",
		slog.String("host", host), slog.String("image", a.runnerImage))
	// Keep the deadline alive while consuming the response: Docker can accept
	// ImagePull and then wedge part-way through the progress stream.
	pullCtx, cancelPull := context.WithTimeout(ctx, dockerImagePullTimeout)
	pull, err := client.ImagePull(pullCtx, a.runnerImage, image.PullOptions{})
	if err != nil {
		cancelPull()
		return fmt.Errorf("failed to pull runner image %q on host %q: %w", a.runnerImage, host, err)
	}
	defer func() {
		_ = pull.Close()
		cancelPull()
	}()
	// Docker streams pull progress as newline-delimited JSON and reports
	// registry/auth/manifest failures INSIDE that stream -- ImagePull itself
	// returns a nil error for them. Discarding the body would swallow that,
	// and because a refreshed TAG is normally already present locally, the
	// ImageInspect below would then succeed against the STALE image and this
	// function would return nil. That is exactly the bug #139 exists to fix,
	// reintroduced one layer down: before this change the pull only ran when
	// the image was ABSENT, so a failed pull surfaced as a failed inspect.
	dec := json.NewDecoder(pull)
	for {
		var msg struct {
			Error       string `json:"error"`
			ErrorDetail struct {
				Message string `json:"message"`
			} `json:"errorDetail"`
		}
		if decErr := dec.Decode(&msg); errors.Is(decErr, io.EOF) {
			break
		} else if decErr != nil {
			return fmt.Errorf("failed while reading pull progress for runner image %q on host %q: %w", a.runnerImage, host, decErr)
		}
		if detail := msg.Error; detail != "" {
			return fmt.Errorf("pull of runner image %q on host %q failed: %s", a.runnerImage, host, detail)
		}
		if detail := msg.ErrorDetail.Message; detail != "" {
			return fmt.Errorf("pull of runner image %q on host %q failed: %s", a.runnerImage, host, detail)
		}
	}
	inspectCtx, cancelInspect := context.WithTimeout(ctx, dockerInspectTimeout)
	_, err = client.ImageInspect(inspectCtx, a.runnerImage)
	cancelInspect()
	if err != nil {
		return fmt.Errorf("runner image %q is still unavailable on host %q after pull: %w", a.runnerImage, host, err)
	}
	logDigests(ctx, a.logger, DockerHost{Name: host, Client: client}, a.runnerImage)
	return nil
}

// createContainerWithImageRecovery closes the remaining inspect/create race
// around ensureRunnerImage (#478). A host-side `docker image prune -a` runs
// outside this process and can delete an otherwise valid, digest-pinned image
// after ensureRunnerImage's successful inspect but before ContainerCreate
// takes Docker's own reference to it. The daemon then returns not-found even
// though preparation succeeded moments earlier.
//
// Retry exactly once and only for not-found. Re-preparing through the normal
// host+image lock preserves the existing pull serialization and streamed-error
// handling; a second miss or any other create error stays loud. All three
// containers built from runnerImage use this boundary (the real JIT runner,
// workdir ownership helper, and workdir sweep helper), so the same external
// prune cannot reappear under a different caller.
func (a *Scaler) createContainerWithImageRecovery(
	ctx context.Context,
	client *dockerclient.Client,
	host string,
	config *container.Config,
	hostConfig *container.HostConfig,
	name string,
) (container.CreateResponse, error) {
	create := func() (container.CreateResponse, error) {
		createCtx, cancelCreate := context.WithTimeout(ctx, dockerContainerOperationTimeout)
		defer cancelCreate()
		return client.ContainerCreate(createCtx, config, hostConfig, nil, nil, name)
	}

	response, err := create()
	if err == nil || !cerrdefs.IsNotFound(err) {
		return response, err
	}

	a.logger.Warn(
		"Runner image disappeared before container creation; preparing it again",
		slog.String("host", host),
		slog.String("image", a.runnerImage),
		slog.String("error", err.Error()),
	)
	if prepareErr := a.ensureRunnerImage(ctx, client, host); prepareErr != nil {
		return response, fmt.Errorf(
			"runner image disappeared before container creation (%v) and recovery failed: %w",
			err,
			prepareErr,
		)
	}
	return create()
}

func (a *Scaler) checkHostRunnerLimit(ctx context.Context, client *dockerclient.Client, host string) error {
	limit, limited := a.hostRunnerLimits[host]
	if !limited {
		return nil
	}
	listCtx, cancelList := context.WithTimeout(ctx, dockerInspectTimeout)
	runners, err := client.ContainerList(listCtx, container.ListOptions{
		Filters: filters.NewArgs(filters.Arg("label", runnerScaleSetLabelKey)),
	})
	cancelList()
	if err != nil {
		return fmt.Errorf("rechecking runner limit on host %q: %w", host, err)
	}
	if len(runners) >= limit {
		return fmt.Errorf("host %q reached runner limit %d before container creation", host, limit)
	}
	return nil
}

// ensureWorkDirOwnership chowns BOTH shared bind mounts used when
// shareWorkDir is set (_work and externals) to runner:runner, but only
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
// hundreds of thousands of files, e.g. .pnpm-store) on EVERY shared-workdir
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
	resp, err := a.createContainerWithImageRecovery(
		ctx,
		client,
		host,
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
		"",
	)
	if err != nil {
		return fmt.Errorf("creating workdir-chown helper on host %q: %w", host, err)
	}
	defer func() {
		removeCtx, cancelRemove := context.WithTimeout(context.WithoutCancel(ctx), dockerContainerOperationTimeout)
		defer cancelRemove()
		_ = client.ContainerRemove(removeCtx, resp.ID, container.RemoveOptions{Force: true})
	}()
	startCtx, cancelStart := context.WithTimeout(ctx, dockerContainerOperationTimeout)
	err = client.ContainerStart(startCtx, resp.ID, container.StartOptions{})
	cancelStart()
	if err != nil {
		return fmt.Errorf("starting workdir-chown helper on host %q: %w", host, err)
	}
	waitCtx, cancelWait := context.WithTimeout(ctx, dockerContainerWaitTimeout)
	defer cancelWait()
	statusCh, errCh := client.ContainerWait(waitCtx, resp.ID, container.WaitConditionNotRunning)
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

// workDirSweepTimeout bounds one fleet-wide maintenance pass. A slow Docker
// daemon, image registry, or du must not pin the periodic sweeper indefinitely.
const workDirSweepTimeout = 10 * time.Minute

// RunWorkDirSweeper periodically enforces workDirSizeCapBytes on the shared
// /home/runner/_work directory across the fleet. Only started when
// shareWorkDir is true (see orchestrator.go's runOrchestrator) -- that's the
// only scale set that bind-mounts the shared dir in the first place. Runs an
// initial sweep immediately so a restart doesn't wait a full interval to
// reclaim space.
func (a *Scaler) RunWorkDirSweeper(ctx context.Context) {
	a.sweepWorkDirsWithTimeout(ctx, workDirSweepTimeout)
	ticker := time.NewTicker(workDirSweepInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			a.sweepWorkDirsWithTimeout(ctx, workDirSweepTimeout)
		}
	}
}

func (a *Scaler) sweepWorkDirsWithTimeout(ctx context.Context, timeout time.Duration) {
	sweepCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	a.SweepWorkDirs(sweepCtx)
}

// SweepWorkDirs checks/reclaims the shared /home/runner/_work directory on
// every fleet host. A host is swept only while it has no E2E runner, idle or
// busy. The per-host lock is also held across startRunner's create->addIdle
// window, so a runner cannot appear after this check and race cache deletion.
// A continuously busy host can defer cleanup; disk-pressure handling must
// drain that host rather than delete files underneath a running job.
func (a *Scaler) SweepWorkDirs(ctx context.Context) {
	// A removed host stays in dockerHosts only to finish and clean up an
	// existing runner. It is deliberately not swept: once cordoned, the
	// autoscaler must not make unrelated filesystem changes on it.
	for _, h := range a.placementDockerHosts() {
		a.sweepHostIfIdle(ctx, h.Client, h.Name)
	}
}

func (a *Scaler) sweepHostIfIdle(ctx context.Context, client *dockerclient.Client, host string) {
	if a.runners.hasHost(host) {
		a.logger.Debug("Skipping workdir sweep while tracked shared-workdir runner is active", slog.String("host", host))
		return
	}
	// Preparing the helper image can require a multi-gigabyte pull after the
	// fleet's scheduled prune. Keep that network and disk work outside the
	// workdir exclusion lock so a newly reserved runner can start meanwhile.
	// Once preparation finishes, the checks under the lock below make the
	// sweep stand down if placement claimed the host in the meantime.
	if err := a.ensureRunnerImage(ctx, client, host); err != nil {
		a.logger.Warn("Skipping workdir sweep because runner image preparation failed", slog.String("host", host), slog.String("error", err.Error()))
		return
	}
	workDirLock := a.hostWorkDirLock(host)
	if !lockMutexContext(ctx, workDirLock) {
		a.logger.Debug("Skipping workdir sweep while waiting for workdir lock", slog.String("host", host), slog.String("error", ctx.Err().Error()))
		return
	}
	defer workDirLock.Unlock()
	fleet := a.coordinator()
	fleet.mu.Lock()
	pending := fleet.sharedWorkDirReservations[host]
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

func lockMutexContext(ctx context.Context, lock *sync.Mutex) bool {
	if lock.TryLock() {
		return true
	}
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return false
		case <-ticker.C:
			if lock.TryLock() {
				return true
			}
		}
	}
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
//
// The pnpm content-addressable store's own maintenance (prune, then evict as
// a last resort) is gated SEPARATELY, on pnpmBudgetBytes OR capBytes,
// whichever is exceeded (agent-lcars#852): the store can drift over its own
// (deliberately tighter) budget while the rest of the shared workdir stays
// comfortably under its cap, and nothing else would ever shrink it back down
// in that case. Without this second trigger, pickHostLocked's placement-time
// budget gate (pnpmStoreOverBudget) could block a host indefinitely -- the
// generic cap-only condition below would never fire to let prune/evict run,
// so the very sweep the gate depends on to self-heal would never happen. A
// future install can restore an evicted store, whereas leaving it to consume
// the host filesystem (or leaving a host permanently excluded from
// placement) can prevent every unrelated runner from starting.
func workDirSweepScript(capBytes, pnpmBudgetBytes int64) string {
	return fmt.Sprintf(`set -e
rm -rf /home/runner/_work/_temp/* 2>/dev/null || true
before=$(du -sb /home/runner/_work 2>/dev/null | cut -f1); before=${before:-0}
cap=%d
pnpm_budget=%d
pnpm_store=/home/runner/_work/.pnpm-store
pnpm_store_bytes=$(du -sb "$pnpm_store" 2>/dev/null | cut -f1); pnpm_store_bytes=${pnpm_store_bytes:-0}
pnpm_prune=skipped
pnpm_evict=skipped
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

# The shared pnpm content-addressable store is not tied to a runner
# container. First let pnpm remove packages no project references. If the
# store (or the whole workdir) is still over its threshold, evict the store
# entirely: all of its contents are reproducible and the next install will
# repopulate it. sweepHostIfIdle holds the same host lock used by runner
# placement, so this cannot race an install or a newly starting
# shared-workdir runner.
#
# Both steps report a result (success/failure/skipped) instead of relying on
# set -e -- a failing "pnpm store prune" or "rm -rf" must not abort this
# script before the SWEEP/PNPM_* lines below print, or the whole sweep (and
# its metrics) goes dark instead of just this one step (agent-lcars#853).
if [ -d "$pnpm_store" ] && { [ "$before" -gt "$cap" ] || [ "$pnpm_store_bytes" -gt "$pnpm_budget" ]; }; then
  if command -v pnpm >/dev/null 2>&1; then
    if pnpm --store-dir "$pnpm_store" store prune; then
      pnpm_prune=success
    else
      pnpm_prune=failure
    fi
  fi
  current=$(du -sb /home/runner/_work 2>/dev/null | cut -f1); current=${current:-0}
  current_pnpm=$(du -sb "$pnpm_store" 2>/dev/null | cut -f1); current_pnpm=${current_pnpm:-0}
  if [ "$current" -gt "$cap" ] || [ "$current_pnpm" -gt "$pnpm_budget" ]; then
    if rm -rf "$pnpm_store"; then
      pnpm_evict=success
    else
      pnpm_evict=failure
    fi
  fi
fi
after=$(du -sb /home/runner/_work 2>/dev/null | cut -f1); after=${after:-0}
# Measured unconditionally (not just when maintenance ran): the steady-state
# size is exactly what operators watch for sustained growth (agent-lcars
# #853), not only the value at the moment maintenance ran.
pnpm_store_bytes=$(du -sb "$pnpm_store" 2>/dev/null | cut -f1); pnpm_store_bytes=${pnpm_store_bytes:-0}
echo "SWEEP before=$before after=$after cap=$cap"
echo "PNPM_STORE_BYTES=$pnpm_store_bytes"
echo "PNPM_PRUNE=$pnpm_prune"
echo "PNPM_EVICT=$pnpm_evict"

# Proactively verify (and repair) the shared required Actions Node runtimes as
# part of this same idle-host maintenance pass (agent-lcars#392), using the
# identical self-heal logic and lock file entrypoint.sh uses (baked into
# this same image), so a broken host is caught between real jobs instead of
# only when one happens to hit it, and this can never race a booting
# runner's own repair attempt.
#
# Guarded: this file is only baked into agent-lcars' own homelab-runner
# image. RunWorkDirSweeper (and this script) also runs against any other
# share_workdir pool's own configured runner_image -- e.g.
# homelab-autoscale-e2e's supersprinklesracing/sprinkles/e2e-runner, which
# has no reason to carry an agent-lcars-specific health check. Without this
# guard the sweep died here on every attempt, on every host, before ever
# reaching the disk-cap eviction above (agent-lcars#464).
if [ -f /usr/local/lib/agent-lcars/externals-health.sh ]; then
  . /usr/local/lib/agent-lcars/externals-health.sh
  repair_externals_if_needed
  if required_node_runtimes_run; then
    echo "EXTERNALS_HEALTHY=1"
  else
    echo "EXTERNALS_HEALTHY=0"
  fi
else
  echo "EXTERNALS_HEALTHY_SKIPPED"
fi
`, capBytes, pnpmBudgetBytes, sweepStaleMinutes, sweepStaleMinutes)
}

func (a *Scaler) sweepHostWorkDir(ctx context.Context, client *dockerclient.Client, host string) error {
	capBytes := a.workDirSizeCapBytes
	if override, ok := a.workDirSizeCaps[host]; ok {
		capBytes = override
	}
	script := workDirSweepScript(capBytes, a.resolvedPnpmStoreBudget(host))

	resp, err := a.createContainerWithImageRecovery(
		ctx,
		client,
		host,
		&container.Config{
			Image:      a.runnerImage,
			User:       "root",
			Entrypoint: []string{"sh", "-c"},
			Cmd:        []string{script},
			Tty:        true,
		},
		&container.HostConfig{
			Binds: []string{
				"/home/runner/_work:/home/runner/_work",
				"/home/runner/externals:/home/runner/externals",
			},
		},
		"",
	)
	if err != nil {
		workdirSweepFailuresTotal.WithLabelValues(host, sweepFailureReasonContainerCreate).Inc()
		return fmt.Errorf("creating workdir-sweep helper on host %q: %w", host, err)
	}
	defer func() {
		removeCtx, cancelRemove := context.WithTimeout(context.WithoutCancel(ctx), dockerContainerOperationTimeout)
		defer cancelRemove()
		_ = client.ContainerRemove(removeCtx, resp.ID, container.RemoveOptions{Force: true})
	}()
	startCtx, cancelStart := context.WithTimeout(ctx, dockerContainerOperationTimeout)
	err = client.ContainerStart(startCtx, resp.ID, container.StartOptions{})
	cancelStart()
	if err != nil {
		workdirSweepFailuresTotal.WithLabelValues(host, sweepFailureReasonContainerStart).Inc()
		return fmt.Errorf("starting workdir-sweep helper on host %q: %w", host, err)
	}
	waitCtx, cancelWait := context.WithTimeout(ctx, dockerContainerWaitTimeout)
	defer cancelWait()
	statusCh, errCh := client.ContainerWait(waitCtx, resp.ID, container.WaitConditionNotRunning)
	select {
	case err := <-errCh:
		if err != nil {
			workdirSweepFailuresTotal.WithLabelValues(host, sweepFailureReasonContainerWait).Inc()
			return fmt.Errorf("waiting for workdir-sweep helper on host %q: %w", host, err)
		}
	case status := <-statusCh:
		if status.StatusCode != 0 {
			workdirSweepFailuresTotal.WithLabelValues(host, sweepFailureReasonExitNonzero).Inc()
			return fmt.Errorf("workdir-sweep helper on host %q exited %d", host, status.StatusCode)
		}
	}

	logs, err := client.ContainerLogs(ctx, resp.ID, container.LogsOptions{ShowStdout: true})
	if err != nil {
		workdirSweepFailuresTotal.WithLabelValues(host, sweepFailureReasonLogsRead).Inc()
		return fmt.Errorf("reading workdir-sweep helper logs on host %q: %w", host, err)
	}
	defer func() { _ = logs.Close() }()
	out, err := io.ReadAll(logs)
	if err != nil {
		workdirSweepFailuresTotal.WithLabelValues(host, sweepFailureReasonLogsRead).Inc()
		return fmt.Errorf("reading workdir-sweep helper output on host %q: %w", host, err)
	}

	before, after, ok := parseSweepOutput(string(out))
	if !ok {
		workdirSweepFailuresTotal.WithLabelValues(host, sweepFailureReasonOutputUnparseable).Inc()
		a.logger.Warn("Could not parse workdir-sweep output", slog.String("host", host), slog.String("output", strings.TrimSpace(string(out))))
		return nil
	}
	workdirSweepSuccessTotal.WithLabelValues(host).Inc()
	workdirBytesGauge.WithLabelValues(host).Set(float64(after))
	if reclaimed := before - after; reclaimed > 0 {
		workdirSweptBytesTotal.WithLabelValues(host).Add(float64(reclaimed))
		a.logger.Info("Swept shared workdir", slog.String("host", host), slog.Int64("before_bytes", before), slog.Int64("after_bytes", after), slog.Int64("reclaimed_bytes", reclaimed))
	}
	a.recordPnpmStoreSweepResult(host, string(out))

	if externalsHealthSkipped(string(out)) {
		// This runner_image has no agent-lcars externals-health.sh baked in
		// (e.g. homelab-autoscale-e2e's third-party-built e2e-runner) -- the
		// check never applies here, not a failure worth a WARN. Delete rather
		// than leave any prior value in place: validateReloadCompatibility
		// permits a scale set's runner_image to change on a live reload, and
		// this gauge is a process-lifetime resource that survives generation
		// replacement -- if this host previously reported 0/1 under an image
		// that HAD the health script, an image swap to one that doesn't must
		// not leave that now-inapplicable reading exported forever.
		hostExternalsHealthyGauge.DeleteLabelValues(host)
		return nil
	}
	healthy, healthOK := parseExternalsHealthOutput(string(out))
	if !healthOK {
		a.logger.Warn("Could not parse externals-health output", slog.String("host", host), slog.String("output", strings.TrimSpace(string(out))))
		return nil
	}
	if healthy {
		hostExternalsHealthyGauge.WithLabelValues(host).Set(1)
	} else {
		hostExternalsHealthyGauge.WithLabelValues(host).Set(0)
		a.logger.Warn("Shared required Actions Node runtime is still unhealthy after a repair attempt", slog.String("host", host))
	}
	return nil
}

// recordPnpmStoreSweepResult parses workDirSweepScript's PNPM_* lines and
// updates the pnpm-store metrics plus the fleet's cached last-known size
// (agent-lcars#852/#853). Best-effort: an unparseable/missing PNPM_STORE_
// BYTES line only logs a Warn (the sweep itself already succeeded per
// parseSweepOutput above -- this is observability on top of it, not a
// second sweep-level failure mode with its own metric).
func (a *Scaler) recordPnpmStoreSweepResult(host, out string) {
	if bytes, ok := parsePnpmStoreBytes(out); ok {
		pnpmStoreBytesGauge.WithLabelValues(host).Set(float64(bytes))
		fleet := a.coordinator()
		fleet.pnpmStoreMu.Lock()
		if fleet.pnpmStoreBytes == nil {
			fleet.pnpmStoreBytes = map[string]int64{}
		}
		fleet.pnpmStoreBytes[host] = bytes
		fleet.pnpmStoreMu.Unlock()
	} else {
		a.logger.Warn("Could not parse pnpm store size from workdir-sweep output", slog.String("host", host), slog.String("output", strings.TrimSpace(out)))
	}
	if result, ok := parsePnpmMaintenanceResult(pnpmPruneResultRe, out); ok {
		pnpmStorePruneTotal.WithLabelValues(host, result).Inc()
	}
	if result, ok := parsePnpmMaintenanceResult(pnpmEvictResultRe, out); ok {
		pnpmStoreEvictionTotal.WithLabelValues(host, result).Inc()
		if result == pnpmMaintenanceResultSuccess {
			a.logger.Info("Evicted shared pnpm store", slog.String("host", host))
		} else if result == pnpmMaintenanceResultFailure {
			a.logger.Warn("Failed to evict shared pnpm store", slog.String("host", host))
		}
	}
}

var pnpmStoreBytesRe = regexp.MustCompile(`PNPM_STORE_BYTES=(\d+)`)

func parsePnpmStoreBytes(out string) (int64, bool) {
	m := pnpmStoreBytesRe.FindStringSubmatch(out)
	if m == nil {
		return 0, false
	}
	n, err := strconv.ParseInt(m[1], 10, 64)
	if err != nil {
		return 0, false
	}
	return n, true
}

var (
	pnpmPruneResultRe = regexp.MustCompile(`PNPM_PRUNE=(success|failure|skipped)`)
	pnpmEvictResultRe = regexp.MustCompile(`PNPM_EVICT=(success|failure|skipped)`)
)

func parsePnpmMaintenanceResult(re *regexp.Regexp, out string) (string, bool) {
	m := re.FindStringSubmatch(out)
	if m == nil {
		return "", false
	}
	return m[1], true
}

func externalsHealthSkipped(out string) bool {
	return strings.Contains(out, "EXTERNALS_HEALTHY_SKIPPED")
}

var externalsHealthRe = regexp.MustCompile(`EXTERNALS_HEALTHY=([01])`)

func parseExternalsHealthOutput(out string) (healthy, ok bool) {
	m := externalsHealthRe.FindStringSubmatch(out)
	if m == nil {
		return false, false
	}
	return m[1] == "1", true
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

// removeIdleRunnerTimeout bounds each idle runner's teardown. This whole
// function runs inline in runOrchestrator's select loop (BeginDrain is called
// from the SIGUSR1 case), so an unbounded ContainerRemove against a host that
// accepts the connection and then black-holes it stalls SIGHUP, SIGTERM and
// the drain watchdog for the kernel TCP timeout -- i.e. a single sick host
// could block the shutdown path this change exists to make fast.
const removeIdleRunnerTimeout = 15 * time.Second

// deregisterRunnerTimeout bounds the two GitHub calls deregisterRunner makes.
// See removeIdleRunnerTimeout for why anything on the drain path needs one.
const deregisterRunnerTimeout = 15 * time.Second

// removeIdleRunners removes only runners that GitHub has not assigned. Busy
// runners are deliberately preserved and adopted on startup.
//
// Note this is now a DRAIN-only path (SIGUSR1). An orderly shutdown no longer
// calls it: see quiesce, which preserves idle runners for adoption instead of
// destroying capacity the next process could pick up immediately.
func (a *Scaler) removeIdleRunners(ctx context.Context) {
	a.runners.mu.Lock()
	idle := make(map[string]runnerRef, len(a.runners.idle))
	for name, r := range a.runners.idle {
		idle[name] = r
		// Marked while still holding the lock, so no window exists where a
		// name is out of a.runners without being marked -- see
		// tearingDown's doc comment.
		a.beginTeardown(name)
	}
	clear(a.runners.idle)
	a.runners.mu.Unlock()
	defer func() {
		for name := range idle {
			a.endTeardown(name)
		}
	}()

	for name, r := range idle {
		a.logger.Info("Removing runner", slog.String("name", name), slog.String("host", r.host), slog.String("containerID", r.containerID))
		client, err := a.hostClient(r.host)
		if err != nil {
			// One unreachable host must not abandon the remaining runners.
			// The idle map was already cleared above, so returning here left
			// every container after this one running AND untracked -- invisible
			// until some later boot's cleanupOrphans swept it up, while the
			// drain gate this feeds waited for a fleet count that had stopped
			// reflecting them.
			a.logger.Error("Failed to get docker host client for runner shutdown", slog.String("name", name), slog.String("host", r.host), slog.String("error", err.Error()))
			continue
		}
		removeCtx, cancel := context.WithTimeout(ctx, removeIdleRunnerTimeout)
		if err := client.ContainerRemove(removeCtx, r.containerID, container.RemoveOptions{Force: true}); err != nil {
			a.logger.Error("Failed to remove runner container", slog.String("name", name), slog.String("host", r.host), slog.String("error", err.Error()))
		}
		cancel()
		a.deregisterRunner(ctx, name)
	}
	a.runnersChanged()
}

// reapUnavailableRunner destroys a single idle runner that GitHub has stopped
// seeing, and reports whether it did.
//
// This is the GitHub-side counterpart to reconcileRunners, which reconciles
// against authoritative *Docker* state. That one collects runners whose
// container has stopped or vanished; this one collects the opposite and
// previously unhandled disagreement -- container healthy and listening, GitHub
// reporting offline or no longer listing it. That split-brain does not resolve
// itself from either side: GitHub never dispatches to a runner it considers
// gone, while this control plane keeps the runner in runners_total and lets it
// satisfy desired_runners, so no replacement is placed and the queued job waits
// forever (2026-08-16: three and a half hours, cleared only by hand).
//
// Only idle runners are taken, and idleness is re-checked here under the lock
// rather than trusted from the caller's poll snapshot -- a job may have been
// assigned in between, and killing a busy runner to settle a reporting
// disagreement would destroy real work. See the caller for why a busy runner
// needs no equivalent handling.
func (a *Scaler) reapUnavailableRunner(ctx context.Context, name, reason string) bool {
	a.runners.mu.Lock()
	ref, ok := a.runners.idle[name]
	if !ok {
		a.runners.mu.Unlock()
		return false
	}
	delete(a.runners.idle, name)
	// Marked while still holding the lock, for the same reason
	// removeIdleRunners does: no window may exist where a name is out of
	// a.runners without being marked. See tearingDown's doc comment.
	a.beginTeardown(name)
	a.runners.mu.Unlock()
	defer a.endTeardown(name)

	githubUnavailableRunnersReapedTotal.WithLabelValues(a.scaleSetLabel(), ref.host, reason).Inc()

	client, err := a.hostClient(ref.host)
	if err != nil {
		// The runner is already untracked, so leaving the container behind
		// would strand it. cleanupOrphans sweeps it on a later boot; log loudly
		// rather than silently reinstating capacity GitHub cannot reach.
		a.logger.Error("Failed to get docker host client to reap an unavailable runner",
			slog.String("name", name), slog.String("host", ref.host), slog.String("error", err.Error()))
	} else {
		removeCtx, cancel := context.WithTimeout(ctx, removeIdleRunnerTimeout)
		if err := client.ContainerRemove(removeCtx, ref.containerID, container.RemoveOptions{Force: true}); err != nil {
			a.logger.Error("Failed to remove the container of an unavailable runner",
				slog.String("name", name), slog.String("host", ref.host), slog.String("error", err.Error()))
		}
		cancel()
	}
	a.deregisterRunner(ctx, name)
	a.runnersChanged()
	return true
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

// drainWatchdogInterval is how often runOrchestrator's drain watchdog polls
// the fleet-wide runner count for a stuck drain (see drainStuckTimeout).
const drainWatchdogInterval = time.Minute

// drainStuckTimeout is how long the fleet may sit globally drained with zero
// runners across every scale set before runOrchestrator concludes the
// operator's drain-and-restart cycle was interrupted before its recreate
// step (homelab#321: Ctrl-C, an SSH drop, or the unreachable-host refusal
// drain-and-restart.sh used to hit before homelab#320 all leave BeginDrain's
// effects in place forever otherwise) and self-heals by clearing drain mode
// fleet-wide. This must be evaluated fleet-wide, not per scale set: BeginDrain
// is applied to every scale set at once, but they can reach zero runners at
// different times depending on how long each one's in-flight jobs take
// (drain-and-restart.sh's own fleet_runner_count gate sums across every scale
// set the same way). Clearing an individual scale set the moment it alone
// goes idle would let it accept new placements again while a sibling scale
// set is still legitimately draining a long-running job -- reopening exactly
// the job-interruption hazard drain mode exists to prevent, and starving the
// fleet-wide zero the operator's own drain-and-restart.sh is waiting for.
// The threshold itself sits comfortably above the few-second window between
// the fleet reaching zero and the operator's recreate step, and well below
// RunnerAutoscalerDrainStuck's 30-minute alert threshold, so a stuck drain
// self-heals well before a human would need to notice the ticket.
const drainStuckTimeout = 5 * time.Minute

// EndDrain clears drain mode. Idempotent; a no-op if not currently draining.
// Called by runOrchestrator's fleet-wide drain watchdog once every scale set
// has sat at zero runners past drainStuckTimeout -- see drainStuckTimeout's
// doc comment for why that decision is made fleet-wide rather than by each
// Scaler independently. A normal deploy never reaches this path: it recreates
// the whole process, which starts fresh with draining already false.
func (a *Scaler) EndDrain() {
	if !a.draining.CompareAndSwap(true, false) {
		return
	}
	scaleSet := a.scaleSetLabel()
	drainingGauge.WithLabelValues(scaleSet).Set(0)
	drainAutoClearedTotal.WithLabelValues(scaleSet).Inc()
}

// stopPlacing refuses new placements for the rest of this process's life. It
// is the shutdown counterpart to BeginDrain, minus the teardown: see the
// quiescing field and quiesce's doc comment for why an orderly exit now keeps
// idle runners instead of removing them.
func (a *Scaler) stopPlacing() {
	a.quiescing.Store(true)
}

var _ listener.Scaler = (*Scaler)(nil)

// runnerRef records where a runner lives: which host's docker client owns it
// and its container ID on that host.
type runnerRef struct {
	host        string
	containerID string
	// jobID is populated only while the runner is busy. It is opaque GitHub
	// listener data, useful for matching the console's live runner work but
	// never used to make scheduling or cleanup decisions.
	jobID string
	// startedAt is the container creation time, not the control-plane
	// adoption time. A restart must not grant an hours-old runner a fresh
	// startup grace period and hide an existing GitHub disconnect.
	startedAt time.Time
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

func (r *runnerState) hosts() map[string]bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	hosts := make(map[string]bool)
	for _, ref := range r.idle {
		hosts[ref.host] = true
	}
	for _, ref := range r.busy {
		hosts[ref.host] = true
	}
	return hosts
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

func (r *runnerState) markBusy(name string, jobID ...string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	ref, ok := r.idle[name]
	if !ok {
		return false
	}
	delete(r.idle, name)
	if len(jobID) > 0 {
		ref.jobID = jobID[0]
	}
	r.busy[name] = ref
	return true
}

func (r *runnerState) markDone(name string) (runnerRef, bool) {
	ref, _, ok := r.markDoneWithState(name)
	return ref, ok
}

// markDoneWithState removes a tracked runner and returns the state it held at
// the instant of removal. Runtime reconciliation uses that state for its
// bounded Prometheus label; it must not trust a stale snapshot because a
// JobStarted event may have moved the runner from idle to busy while Docker
// inspection was in flight.
func (r *runnerState) markDoneWithState(name string) (runnerRef, string, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if ref, ok := r.busy[name]; ok {
		delete(r.busy, name)
		return ref, runnerTrackedStateBusy, true
	}
	if ref, ok := r.idle[name]; ok {
		delete(r.idle, name)
		return ref, runnerTrackedStateIdle, true
	}
	return runnerRef{}, "", false
}

func (r *runnerState) addIdle(name, host, containerID string, startedAt time.Time) {
	r.mu.Lock()
	r.idle[name] = runnerRef{host: host, containerID: containerID, startedAt: startedAt}
	r.mu.Unlock()
}

package main

import (
	"context"
	"fmt"
	"log/slog"
	"os/exec"
	"regexp"
	"strings"

	dockerclient "github.com/docker/docker/client"
)

// defaultRunnerCgroupParent is the systemd slice every runner container is
// created under when fleet.placement.runner_cgroup_parent is not configured
// (agent-lcars#1700). Docker's systemd cgroup driver requires a bare slice
// name (no slashes) ending in ".slice", and systemd creates that slice unit
// on demand the first time anything references it -- see README "Host-level
// runner slice" for the citations -- so no host provisioning step is needed
// for the slice to exist. Only its memory.max/memory.high properties need an
// explicit step, which is what ensureRunnerSlice below performs.
const defaultRunnerCgroupParent = "homelab-runners.slice"

// runnerCgroupParentPattern bounds fleet.placement.runner_cgroup_parent to a
// bare systemd slice name: alphanumeric plus "_.-", ending in ".slice", no
// slashes. Docker itself rejects a non-".slice" name under the systemd
// cgroup driver; the no-slashes, no-shell-metacharacters restriction here
// additionally keeps the value safe to interpolate into the remote shell
// command line defaultRunnerSliceApplier sends over SSH.
var runnerCgroupParentPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]*\.slice$`)

// runnerSliceMemoryHighFraction is how far below memory.max the slice's
// memory.high (the soft reclaim/throttle threshold) sits, so cgroup memory
// pressure inside the runner slice starts before the hard ceiling memory.max
// enforces (agent-lcars#1700).
const runnerSliceMemoryHighFraction = 0.95

// runnerSliceApplierFunc applies one host's collective runner-slice memory
// bound. Injectable on Scaler (see runnerSliceApplier) so tests exercise
// ensureRunnerSlice without shelling out to systemctl; nil selects
// defaultRunnerSliceApplier.
type runnerSliceApplierFunc func(ctx context.Context, host DockerHost, sliceName string, memoryMax, memoryHigh int64) error

// runnerSliceBudget computes a host's collective runner-slice bound from its
// physical memory and the configured safety margin: memory.max leaves the
// same margin outside the slice that per-host reservation admission already
// leaves outside declared reservations (resolvedMemorySafetyMargin), and
// memory.high sits runnerSliceMemoryHighFraction below that.
func runnerSliceBudget(physicalMemoryBytes int64, margin float64) (memoryMax, memoryHigh int64) {
	memoryMax = int64(float64(physicalMemoryBytes) * (1 - margin))
	memoryHigh = int64(float64(memoryMax) * runnerSliceMemoryHighFraction)
	return memoryMax, memoryHigh
}

// applyRunnerSlice reads host's physical memory and, if a runner cgroup
// slice is configured, ensures its collective memory bound reflects it. A
// physical-memory read failure is handled exactly like an applier failure --
// logged at WARN, the bounded gauge dropped to 0 -- because this must never
// block the placement that pickHostLocked already admitted; the per-container
// ceiling on the runner about to be created still holds regardless.
func (a *Scaler) applyRunnerSlice(ctx context.Context, client *dockerclient.Client, host DockerHost) {
	if a.runnerCgroupParent == "" {
		return
	}
	info, err := client.Info(ctx)
	if err != nil || info.MemTotal <= 0 {
		a.logger.Warn("Runner slice bound skipped: host physical memory unavailable",
			slog.String("host", host.Name), slog.String("slice", a.runnerCgroupParent), slog.Any("error", err))
		runnerSliceBoundedGauge.WithLabelValues(host.Name).Set(0)
		return
	}
	memoryMax, _ := runnerSliceBudget(info.MemTotal, a.resolvedMemorySafetyMargin())
	a.ensureRunnerSlice(ctx, host, memoryMax)
}

// ensureRunnerSlice applies host's collective runner-slice memory bound
// before the first placement on that host and again whenever memoryMax
// changes (a re-measured physical total, or a reloaded safety margin). It is
// idempotent: while the applier has already succeeded for this exact
// memoryMax, it does not run again.
//
// Applier failure is never placement-blocking -- see applyRunnerSlice's doc
// comment -- and is not cached as success, so the next placement on this
// host retries; a transitory failure (an SSH hiccup, a momentarily
// unreachable host) self-heals without operator intervention.
func (a *Scaler) ensureRunnerSlice(ctx context.Context, host DockerHost, memoryMax int64) {
	if a.runnerCgroupParent == "" {
		return
	}
	if last, ok := a.runnerSliceBudgets.Load(host.Name); ok && last.(int64) == memoryMax {
		return
	}
	memoryHigh := int64(float64(memoryMax) * runnerSliceMemoryHighFraction)
	applier := a.runnerSliceApplier
	if applier == nil {
		applier = defaultRunnerSliceApplier
	}
	if err := applier(ctx, host, a.runnerCgroupParent, memoryMax, memoryHigh); err != nil {
		a.logger.Warn("Failed to apply runner slice memory bound; this runner's own ceiling still holds",
			slog.String("host", host.Name), slog.String("slice", a.runnerCgroupParent),
			slog.Int64("memory_max_bytes", memoryMax), slog.Int64("memory_high_bytes", memoryHigh),
			slog.String("error", err.Error()))
		runnerSliceBoundedGauge.WithLabelValues(host.Name).Set(0)
		return
	}
	a.runnerSliceBudgets.Store(host.Name, memoryMax)
	runnerSliceBoundedGauge.WithLabelValues(host.Name).Set(1)
	runnerSliceMemoryMaxGauge.WithLabelValues(host.Name).Set(float64(memoryMax))
}

// defaultRunnerSliceApplier is the production runnerSliceApplierFunc: it
// runs `systemctl set-property` on the host itself, locally for a "local"
// Docker target or over the same pinned fleet SSH target/key
// newDockerClient uses for a "ssh://..." target -- see hosts.go. Docker does
// not set limits on a --cgroup-parent slice itself (only ON the containers
// placed under it), so this is the step that actually bounds the slice
// collectively.
func defaultRunnerSliceApplier(ctx context.Context, host DockerHost, sliceName string, memoryMax, memoryHigh int64) error {
	args := []string{"set-property", sliceName,
		fmt.Sprintf("MemoryMax=%d", memoryMax),
		fmt.Sprintf("MemoryHigh=%d", memoryHigh),
	}
	if host.Target == "local" || host.Target == "" {
		out, err := exec.CommandContext(ctx, "systemctl", args...).CombinedOutput()
		if err != nil {
			return fmt.Errorf("systemctl set-property %s on host %q: %w (%s)", sliceName, host.Name, err, strings.TrimSpace(string(out)))
		}
		return nil
	}
	if !strings.HasPrefix(host.Target, "ssh://") {
		return fmt.Errorf("host %q has neither a local nor an ssh:// docker target to apply the runner slice bound over", host.Name)
	}
	remoteCmd := "systemctl " + strings.Join(args, " ")
	out, err := exec.CommandContext(ctx, "ssh",
		"-i", fleetSSHKeyPath,
		"-o", "IdentitiesOnly=yes",
		"-o", "UserKnownHostsFile="+fleetKnownHostsPath,
		"-o", "StrictHostKeyChecking=yes",
		"-o", "ControlMaster=no",
		"-o", "ConnectTimeout=10",
		strings.TrimPrefix(host.Target, "ssh://"), remoteCmd,
	).CombinedOutput()
	if err != nil {
		return fmt.Errorf("ssh systemctl set-property %s on host %q: %w (%s)", sliceName, host.Name, err, strings.TrimSpace(string(out)))
	}
	return nil
}

package main

import (
	"regexp"
)

// There is no fleet-named default runner cgroup slice (agent-lcars#1728):
// omitting fleet.placement.runner_cgroup_parent resolves to "", i.e. no
// collective host-level slice bound -- Docker's own default cgroup parent
// applies to each runner container individually instead. A fleet that wants
// the collective bound (agent-lcars#1700) must set the key explicitly.
// Docker's systemd cgroup driver requires a bare slice name (no slashes)
// ending in ".slice" for whatever value IS configured, and systemd creates
// that slice unit on demand the first time anything references it -- see
// README "Host-level runner slice" for the citations -- so no host
// provisioning step is needed for the slice to exist. Bounding its
// memory.max/memory.high is a separate step this controller cannot perform
// itself (agent-lcars#1712): see runnerSliceBudget below.

// runnerCgroupParentPattern bounds fleet.placement.runner_cgroup_parent to a
// bare systemd slice name: alphanumeric plus "_.-", ending in ".slice", no
// slashes -- what Docker itself requires under the systemd cgroup driver.
var runnerCgroupParentPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]*\.slice$`)

// runnerSliceMemoryHighFraction is how far below memory.max the slice's
// memory.high (the soft reclaim/throttle threshold) sits, so cgroup memory
// pressure inside the runner slice starts before the hard ceiling memory.max
// enforces (agent-lcars#1700).
const runnerSliceMemoryHighFraction = 0.95

// runnerSliceBudget computes a host's collective runner-slice bound from its
// physical memory and the configured safety margin: memory.max leaves the
// same margin outside the slice that per-host reservation admission already
// leaves outside declared reservations (resolvedMemorySafetyMargin), and
// memory.high sits runnerSliceMemoryHighFraction below that.
//
// This controller only ever DECLARES these numbers (published as the
// github_runner_autoscaler_runner_slice_expected_memory_max_bytes and
// _expected_memory_high_bytes gauges in scaler.go's pickHostLocked, next to
// the other host-memory-observation gauges) -- it does not, and structurally
// cannot, apply them to the host itself. An earlier version of this file set
// the slice's memory properties directly against the host, either locally or
// over the fleet SSH automation key; that failed on every host, on every
// placement, because the fleet's privilege model does not and should not
// grant the controller that authority: the controller image has no way to
// change live systemd unit properties and no systemd bus access, and the SSH
// forced-command dispatcher
// (homelab's ansible/roles/users/files/homelab-fleet-ssh-command) authorizes
// exactly two commands, neither of them a unit-property change -- widening
// that allowlist would hand the controller root-equivalent authority over
// every host (homelab#1061). Host resource policy belongs to Ansible: a
// static unit file declares and enforces the bound (jlapenna/homelab#1102),
// and Prometheus verifies the declared numbers against cAdvisor's
// container_spec_memory_limit_bytes{id="/homelab.slice/<slice>"} series,
// which already exports the nested slice cgroup with no new emitter needed
// (agent-lcars#1712).
func runnerSliceBudget(physicalMemoryBytes int64, margin float64) (memoryMax, memoryHigh int64) {
	memoryMax = int64(float64(physicalMemoryBytes) * (1 - margin))
	memoryHigh = int64(float64(memoryMax) * runnerSliceMemoryHighFraction)
	return memoryMax, memoryHigh
}

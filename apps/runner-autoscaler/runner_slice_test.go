package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/prometheus/client_golang/prometheus/testutil"
)

// TestRunnerSliceBudget pins the arithmetic agent-lcars#1700 specifies:
// memory.max leaves the same safety margin outside the slice that per-host
// reservation admission already leaves outside declared reservations, and
// memory.high sits 5% below memory.max.
func TestRunnerSliceBudget(t *testing.T) {
	memoryMax, memoryHigh := runnerSliceBudget(100_000_000_000, 0.10)
	if memoryMax != 90_000_000_000 {
		t.Fatalf("memoryMax = %d, want %d", memoryMax, int64(90_000_000_000))
	}
	if memoryHigh != 85_500_000_000 {
		t.Fatalf("memoryHigh = %d, want %d", memoryHigh, int64(85_500_000_000))
	}
}

// TestPickHostPublishesRunnerSliceExpectedBudget covers the replacement
// contract for agent-lcars#1712: with a runner cgroup slice configured, the
// autoscaler DECLARES (never applies -- there is no systemctl call left in
// this package, see TestNoSystemctlReferenceRemains below) the host's
// collective runner-slice memory bound as a gauge pair labeled by host and
// slice, computed from the host's physical memory and the configured safety
// margin exactly like runnerSliceBudget.
func TestPickHostPublishesRunnerSliceExpectedBudget(t *testing.T) {
	scaler := memoryBoundScaler(t, "e2e", 16*gibibyte, 2*gibibyte, nil)
	scaler.runnerCgroupParent = "homelab-runners.slice"
	scaler.memorySafetyMargin = 0.10

	if _, err := scaler.pickHost(context.Background()); err != nil {
		t.Fatalf("pickHost() error = %v", err)
	}

	wantMax, wantHigh := runnerSliceBudget(16*gibibyte, 0.10)
	if got := testutil.ToFloat64(runnerSliceExpectedMemoryMaxGauge.WithLabelValues("janeway", "homelab-runners.slice")); got != float64(wantMax) {
		t.Errorf("runner_slice_expected_memory_max_bytes = %v, want %v", got, wantMax)
	}
	if got := testutil.ToFloat64(runnerSliceExpectedMemoryHighGauge.WithLabelValues("janeway", "homelab-runners.slice")); got != float64(wantHigh) {
		t.Errorf("runner_slice_expected_memory_high_bytes = %v, want %v", got, wantHigh)
	}
}

// TestPickHostOmitsRunnerSliceExpectedBudgetWhenDisabled covers
// fleet.placement.runner_cgroup_parent == "" (the default before #1700 and
// still available as an explicit opt-out): nothing is published for either
// gauge, on a host name that no other test in this package touches so a
// stray series from elsewhere cannot make this pass by accident.
func TestPickHostOmitsRunnerSliceExpectedBudgetWhenDisabled(t *testing.T) {
	scaler := memoryBoundScaler(t, "e2e", 16*gibibyte, 2*gibibyte, nil)
	scaler.dockerHosts[0].Name = "slice-disabled-host"
	scaler.runnerCgroupParent = ""

	if _, err := scaler.pickHost(context.Background()); err != nil {
		t.Fatalf("pickHost() error = %v", err)
	}

	if got := testutil.ToFloat64(runnerSliceExpectedMemoryMaxGauge.WithLabelValues("slice-disabled-host", "homelab-runners.slice")); got != 0 {
		t.Errorf("runner_slice_expected_memory_max_bytes = %v, want 0 (unset) when the slice is disabled", got)
	}
	if got := testutil.ToFloat64(runnerSliceExpectedMemoryHighGauge.WithLabelValues("slice-disabled-host", "homelab-runners.slice")); got != 0 {
		t.Errorf("runner_slice_expected_memory_high_bytes = %v, want 0 (unset) when the slice is disabled", got)
	}
}

// TestNoSystemctlReferenceRemains pins the removal half of agent-lcars#1712:
// the controller must never invoke systemctl (or shell out to it over SSH)
// against a fleet host -- that authority was the root cause this issue
// removes, not just a bug to patch (see runnerSliceBudget's doc comment).
// Scoped to non-test *.go sources in this package so a test fixture or this
// very sentence describing the constraint can still say the word.
func TestNoSystemctlReferenceRemains(t *testing.T) {
	matches, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatalf("glob *.go: %v", err)
	}
	if len(matches) == 0 {
		t.Fatal("glob *.go matched nothing -- test is not running from the package directory")
	}
	for _, path := range matches {
		if strings.HasSuffix(path, "_test.go") {
			continue
		}
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("reading %s: %v", path, err)
		}
		if strings.Contains(string(data), "systemctl") {
			t.Errorf("%s still references systemctl; the controller must only declare the runner slice bound, never apply it", path)
		}
	}
}

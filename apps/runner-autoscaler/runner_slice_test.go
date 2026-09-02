package main

import (
	"context"
	"errors"
	"io"
	"log/slog"
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

// TestApplyRunnerSliceCalledOncePerHostAndOnBudgetChange covers the
// idempotency contract: ensureRunnerSlice (via applyRunnerSlice, which reads
// the host's physical memory from the fake Docker server) must apply the
// slice bound on the first placement, must NOT re-apply it while the budget
// is unchanged, and must re-apply it once the host's reported physical
// memory (and so the computed budget) changes.
func TestApplyRunnerSliceCalledOncePerHostAndOnBudgetChange(t *testing.T) {
	fake := newFakeDockerServer(t)
	fake.setMemoryTotal(100_000_000_000)
	client := fake.client(t)
	host := DockerHost{Name: "slice-host-budget", Target: "local", Client: client}

	type call struct {
		sliceName             string
		memoryMax, memoryHigh int64
	}
	var calls []call
	scaler := &Scaler{
		runnerCgroupParent: "homelab-runners.slice",
		memorySafetyMargin: 0.10,
		logger:             slog.New(slog.NewTextHandler(io.Discard, nil)),
		runnerSliceApplier: func(_ context.Context, h DockerHost, sliceName string, memoryMax, memoryHigh int64) error {
			calls = append(calls, call{sliceName, memoryMax, memoryHigh})
			return nil
		},
	}

	scaler.applyRunnerSlice(context.Background(), client, host)
	if len(calls) != 1 {
		t.Fatalf("applier calls after first placement = %d, want 1", len(calls))
	}
	wantMax, wantHigh := runnerSliceBudget(100_000_000_000, 0.10)
	if calls[0].memoryMax != wantMax || calls[0].memoryHigh != wantHigh {
		t.Fatalf("applier called with (max=%d, high=%d), want (max=%d, high=%d)", calls[0].memoryMax, calls[0].memoryHigh, wantMax, wantHigh)
	}
	if calls[0].sliceName != "homelab-runners.slice" {
		t.Fatalf("slice name = %q, want %q", calls[0].sliceName, "homelab-runners.slice")
	}
	if got := testutil.ToFloat64(runnerSliceBoundedGauge.WithLabelValues(host.Name)); got != 1 {
		t.Fatalf("runner_slice_bounded = %v, want 1", got)
	}
	if got := testutil.ToFloat64(runnerSliceMemoryMaxGauge.WithLabelValues(host.Name)); got != float64(wantMax) {
		t.Fatalf("runner_slice_memory_max_bytes = %v, want %v", got, wantMax)
	}

	// Second placement on the same host, same physical memory: the applier
	// must not be called again.
	scaler.applyRunnerSlice(context.Background(), client, host)
	if len(calls) != 1 {
		t.Fatalf("applier calls after unchanged budget = %d, want still 1", len(calls))
	}

	// The host's physical memory (and so the computed budget) changes: the
	// applier must run again, with the new bytes.
	fake.setMemoryTotal(200_000_000_000)
	scaler.applyRunnerSlice(context.Background(), client, host)
	if len(calls) != 2 {
		t.Fatalf("applier calls after budget change = %d, want 2", len(calls))
	}
	newMax, newHigh := runnerSliceBudget(200_000_000_000, 0.10)
	if calls[1].memoryMax != newMax || calls[1].memoryHigh != newHigh {
		t.Fatalf("second applier call = (max=%d, high=%d), want (max=%d, high=%d)", calls[1].memoryMax, calls[1].memoryHigh, newMax, newHigh)
	}
	if got := testutil.ToFloat64(runnerSliceMemoryMaxGauge.WithLabelValues(host.Name)); got != float64(newMax) {
		t.Fatalf("runner_slice_memory_max_bytes after change = %v, want %v", got, newMax)
	}
}

// TestApplyRunnerSliceDisabledIsNoop covers fleet.placement.runner_cgroup_parent
// == "" (explicitly disabled): the applier must never be invoked and no
// Docker Info() round trip should even be attempted.
func TestApplyRunnerSliceDisabledIsNoop(t *testing.T) {
	fake := newFakeDockerServer(t)
	client := fake.client(t)
	host := DockerHost{Name: "slice-host-disabled", Target: "local", Client: client}

	called := false
	scaler := &Scaler{
		runnerCgroupParent: "",
		logger:             slog.New(slog.NewTextHandler(io.Discard, nil)),
		runnerSliceApplier: func(context.Context, DockerHost, string, int64, int64) error {
			called = true
			return nil
		},
	}

	scaler.applyRunnerSlice(context.Background(), client, host)
	if called {
		t.Fatal("applier must not be called when runner_cgroup_parent is disabled")
	}
}

// TestApplyRunnerSliceApplierErrorSetsGaugeZeroAndDoesNotBlock is the other
// half of the acceptance criteria: when the applier fails (e.g. systemctl
// unreachable over SSH, or the host lacks systemd), applyRunnerSlice must
// not return an error or panic -- startRunner calls it without checking a
// return value, precisely so a slice-bound failure can never block placing
// the runner under its own per-container ceiling -- and must record the
// failure as the exported gauge going to 0, not as an application that
// should be treated as done: the very next placement retries.
func TestApplyRunnerSliceApplierErrorSetsGaugeZeroAndDoesNotBlock(t *testing.T) {
	fake := newFakeDockerServer(t)
	fake.setMemoryTotal(64_000_000_000)
	client := fake.client(t)
	host := DockerHost{Name: "slice-host-err", Target: "ssh://homelab@example.lan", Client: client}

	calls := 0
	scaler := &Scaler{
		runnerCgroupParent: "homelab-runners.slice",
		memorySafetyMargin: 0.10,
		logger:             slog.New(slog.NewTextHandler(io.Discard, nil)),
		runnerSliceApplier: func(context.Context, DockerHost, string, int64, int64) error {
			calls++
			return errors.New("systemctl: permission denied")
		},
	}

	scaler.applyRunnerSlice(context.Background(), client, host)
	if calls != 1 {
		t.Fatalf("applier calls = %d, want 1", calls)
	}
	if got := testutil.ToFloat64(runnerSliceBoundedGauge.WithLabelValues(host.Name)); got != 0 {
		t.Fatalf("runner_slice_bounded = %v, want 0 after applier error", got)
	}

	// A failed application must not be cached as done -- placement retries
	// on the next call with the same budget.
	scaler.applyRunnerSlice(context.Background(), client, host)
	if calls != 2 {
		t.Fatalf("applier calls after retry = %d, want 2 (a failed application must not be treated as idempotently applied)", calls)
	}
}

// TestApplyRunnerSlicePhysicalMemoryUnavailable covers the other failure
// mode -- Docker's own /info call failing or reporting no memory -- which
// must degrade exactly like an applier failure rather than panicking or
// propagating an error startRunner would have to handle.
func TestApplyRunnerSlicePhysicalMemoryUnavailable(t *testing.T) {
	fake := newFakeDockerServer(t)
	fake.setMemoryTotal(0)
	client := fake.client(t)
	host := DockerHost{Name: "slice-host-no-mem", Target: "local", Client: client}

	called := false
	scaler := &Scaler{
		runnerCgroupParent: "homelab-runners.slice",
		logger:             slog.New(slog.NewTextHandler(io.Discard, nil)),
		runnerSliceApplier: func(context.Context, DockerHost, string, int64, int64) error {
			called = true
			return nil
		},
	}

	scaler.applyRunnerSlice(context.Background(), client, host)
	if called {
		t.Fatal("applier must not be called when physical memory could not be read")
	}
	if got := testutil.ToFloat64(runnerSliceBoundedGauge.WithLabelValues(host.Name)); got != 0 {
		t.Fatalf("runner_slice_bounded = %v, want 0 when physical memory is unavailable", got)
	}
}

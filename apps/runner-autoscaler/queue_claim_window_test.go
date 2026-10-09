package main

import (
	"errors"
	"testing"
	"time"
)

func TestQueueClaimWindowUsesExistingCountersAndExactObservedInterval(t *testing.T) {
	counts := [3]uint64{100, 20, 40}
	var failure error
	source := &queueExecutorStatusSource{claimCounters: func() ([3]uint64, error) { return counts, failure }}
	now := time.Date(2026, 10, 9, 12, 0, 0, 0, time.UTC)
	if got := source.claimWindow(now); got != nil {
		t.Fatal("initial baseline must be unavailable, not zero claims")
	}
	counts = [3]uint64{103, 20, 41}
	got := source.claimWindow(now.Add(10 * time.Second))
	if got == nil || got.Claude != 3 || got.Codex != 0 || got.OpenCode != 1 || got.WindowStart != now.Format(time.RFC3339Nano) || got.WindowEnd != now.Add(10*time.Second).Format(time.RFC3339Nano) {
		t.Fatalf("wrong claim window: %#v", got)
	}
	// Drain changes admission, not history; a measured zero is valid after
	// the full interval rolls beyond all observed claims.
	for i := 2; i <= 94; i++ {
		got = source.claimWindow(now.Add(time.Duration(i) * 10 * time.Second))
	}
	if got == nil || got.Claude != 0 || got.OpenCode != 0 {
		t.Fatalf("old claims retained: %#v", got)
	}
	start, _ := time.Parse(time.RFC3339Nano, got.WindowStart)
	end, _ := time.Parse(time.RFC3339Nano, got.WindowEnd)
	if end.Sub(start) > 15*time.Minute || len(source.claimSamples) > 92 {
		t.Fatal("window or memory is unbounded")
	}
	failure = errors.New("metric unavailable")
	if source.claimWindow(now.Add(950*time.Second)) != nil {
		t.Fatal("failed metric became a zero")
	}
	failure = nil
	if source.claimWindow(now.Add(960*time.Second)) != nil {
		t.Fatal("failed metric did not reset baseline")
	}
	counts[0] = 1
	if source.claimWindow(now.Add(970*time.Second)) != nil {
		t.Fatal("counter reset must be unavailable")
	}
	if source.claimWindow(now.Add(2*time.Hour)) != nil {
		t.Fatal("gap must reset baseline")
	}
}

func TestClaimWindowDoesNotForceUnchangedStatusWrites(t *testing.T) {
	start := time.Date(2026, 10, 9, 12, 0, 0, 0, time.UTC)
	gate := newStatusWriteGate(consoleStatusHeartbeat)
	status := consoleQueueExecutorStatus{Claims: &consoleClaimWindow{Claude: 1, WindowStart: "a", WindowEnd: "b"}}
	gate.recordWritten("queue", status, start)
	status.Claims = &consoleClaimWindow{Claude: 1, WindowStart: "c", WindowEnd: "d"}
	if gate.shouldWrite("queue", status, start.Add(10*time.Second)) {
		t.Fatal("only interval timestamps changed")
	}
	status.Claims.Claude = 2
	if !gate.shouldWrite("queue", status, start.Add(10*time.Second)) {
		t.Fatal("changed counter must publish")
	}
	status.Claims = nil
	if !gate.shouldWrite("queue", status, start.Add(10*time.Second)) {
		t.Fatal("unavailability must publish")
	}
}

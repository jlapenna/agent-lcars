package main

import (
	"testing"
	"time"
)

func TestRunnerWindowSamplesOnceAMinuteAndKeepsThirty(t *testing.T) {
	var w runnerWindow
	start := time.Date(2026, 10, 14, 12, 0, 0, 0, time.UTC)
	var window *consoleRunnerWindow
	// 40 minutes of 10s ticks: one sample a minute, the last 30 kept.
	for tick := 0; tick <= 40*6; tick++ {
		window = w.observe(start.Add(time.Duration(tick)*consoleStatusInterval), tick%7, tick%3)
	}
	if got := len(window.Samples); got != histogramWindowIntervals {
		t.Fatalf("samples = %d, want %d", got, histogramWindowIntervals)
	}
	last := window.Samples[len(window.Samples)-1]
	if last.At != start.Add(40*time.Minute).Format(time.RFC3339Nano) {
		t.Fatalf("last sample at %s", last.At)
	}
	if last.Registered != (40*6)%7 || last.Running != (40*6)%3 {
		t.Fatalf("last sample = %+v", last)
	}
}

func TestRunnerWindowDropsSamplesOlderThanThirtyMinutes(t *testing.T) {
	var w runnerWindow
	start := time.Date(2026, 10, 14, 12, 0, 0, 0, time.UTC)
	w.observe(start, 3, 1)
	// A 45-minute scrape outage: the old sample falls out of the window.
	window := w.observe(start.Add(45*time.Minute), 4, 2)
	if len(window.Samples) != 1 || window.Samples[0].Registered != 4 {
		t.Fatalf("window = %+v", window.Samples)
	}
}

func TestRunnerWindowToleratesTickJitter(t *testing.T) {
	var w runnerWindow
	start := time.Date(2026, 10, 14, 12, 0, 0, 0, time.UTC)
	w.observe(start, 1, 0)
	// A tick landing a few seconds early still opens the next minute.
	window := w.observe(start.Add(time.Minute-3*time.Second), 2, 1)
	if len(window.Samples) != 2 {
		t.Fatalf("samples = %d, want 2", len(window.Samples))
	}
}

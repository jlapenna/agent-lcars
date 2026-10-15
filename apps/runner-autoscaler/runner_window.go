package main

import "time"

// consoleRunnerWindow is a lane's runner counts over the last 30 minutes, at
// most one sample a minute, for the console's Runners online and Busy
// sparklines. A minute without a successful scrape has no sample, and the
// console leaves that bar empty rather than guessing.
type consoleRunnerWindow struct {
	Samples []consoleRunnerSample `firestore:"samples"`
}

type consoleRunnerSample struct {
	At         string `firestore:"at"`
	Registered int    `firestore:"registered"`
	Running    int    `firestore:"running"`
}

type runnerSample struct {
	at                  time.Time
	registered, running int
}

// runnerWindow keeps one lane's samples. Like histogramWindow, the lane's
// sampling goroutine owns it, so it needs no lock.
type runnerWindow struct {
	samples []runnerSample
}

// observe records a successful scrape and returns the published window.
// Samples land on histogramWindow's once-a-minute cadence, so the document
// changes once a minute however often the lane is scraped.
func (w *runnerWindow) observe(now time.Time, registered, running int) *consoleRunnerWindow {
	if n := len(w.samples); n == 0 || now.Sub(w.samples[n-1].at) >= histogramSampleSpacing-consoleStatusInterval/2 {
		w.samples = append(w.samples, runnerSample{at: now, registered: registered, running: running})
	}
	cutoff := now.Add(-histogramWindowSpan)
	for len(w.samples) > 0 && (!w.samples[0].at.After(cutoff) || len(w.samples) > histogramWindowIntervals) {
		w.samples = w.samples[1:]
	}
	window := &consoleRunnerWindow{Samples: make([]consoleRunnerSample, 0, len(w.samples))}
	for _, sample := range w.samples {
		window.Samples = append(window.Samples, consoleRunnerSample{
			At:         sample.at.UTC().Format(time.RFC3339Nano),
			Registered: sample.registered,
			Running:    sample.running,
		})
	}
	return window
}

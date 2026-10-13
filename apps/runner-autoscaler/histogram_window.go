package main

import "time"

const (
	// The console's telemetry readouts cover the last 30 minutes.
	histogramWindowSpan = 30 * time.Minute
	// One recorded snapshot per minute bounds the published window to 30
	// intervals however often the source is sampled.
	histogramSampleSpacing = time.Minute
	// The console accepts at most this many intervals per window.
	histogramWindowIntervals = 30
)

// cumulativeHistogram is one sample of a Prometheus-style cumulative
// histogram: an ARC listener's job-startup buckets, or this process's own
// Work API latency.
type cumulativeHistogram struct {
	// Finite upper bounds in seconds, ascending.
	bounds []float64
	// Cumulative counts per bound; the final entry is the +Inf bucket,
	// so len(counts) == len(bounds)+1.
	counts []int64
}

// consoleHistogramWindow is a histogram over the last 30 minutes, one entry
// per recorded interval. The console sums ARC lanes per interval for CI wait
// p50, and reads the executor's Work API latency for Work API p95.
type consoleHistogramWindow struct {
	Bounds []float64 `firestore:"bounds"`
	// When the oldest interval began. After a start or reset the window
	// covers less than 30 minutes, and the console says so.
	StartedAt string                     `firestore:"startedAt"`
	Intervals []consoleHistogramInterval `firestore:"intervals"`
}

type consoleHistogramInterval struct {
	EndedAt string `firestore:"endedAt"`
	// Cumulative counts of observations in this interval, as in
	// cumulativeHistogram.counts.
	Counts []int64 `firestore:"counts"`
}

type histogramSnapshot struct {
	at time.Time
	// nil: the source reported nothing yet, which is zero observations.
	hist *cumulativeHistogram
}

// histogramWindow keeps one source's recorded snapshots. Each source's
// sampling goroutine owns its own window, so it needs no lock.
type histogramWindow struct {
	snapshots []histogramSnapshot
	last      *cumulativeHistogram
	// Zero until the first successful scrape, and again after a reset.
	lastAt time.Time
}

// reset forgets the window, for a sample whose histogram cannot be used.
func (w *histogramWindow) reset() {
	*w = histogramWindow{}
}

// observe records a successful sample and returns the published window, or
// nil while no interval is known or the source has never reported (for an
// ARC listener, absent and disabled metrics look the same).
func (w *histogramWindow) observe(now time.Time, hist *cumulativeHistogram) *consoleHistogramWindow {
	// A source restart zeroes its counters. Any decrease, or a change of
	// bucket layout, starts the window again rather than inventing a delta.
	// So does a gap in successful samples: an interval spanning it would
	// count observations from outside the window, and could hide a restart.
	if !w.lastAt.IsZero() && (now.Sub(w.lastAt) > 2*histogramSampleSpacing || !histogramContinues(w.last, hist)) {
		w.snapshots = nil
	}
	w.last, w.lastAt = hist, now
	// Sample times jitter around the 10s tick; without the slack every other
	// minute would wait a seventh tick and leave a gap in the sparkline.
	// Appending and trimming together changes the window once per minute.
	if n := len(w.snapshots); n == 0 || now.Sub(w.snapshots[n-1].at) >= histogramSampleSpacing-consoleStatusInterval/2 {
		w.snapshots = append(w.snapshots, histogramSnapshot{at: now, hist: hist})
		cutoff := now.Add(-histogramWindowSpan)
		for len(w.snapshots) > 1 && (!w.snapshots[1].at.After(cutoff) || len(w.snapshots) > histogramWindowIntervals+1) {
			w.snapshots = w.snapshots[1:]
		}
	}
	latest := w.snapshots[len(w.snapshots)-1].hist
	if latest == nil || len(w.snapshots) < 2 {
		return nil
	}
	window := &consoleHistogramWindow{
		Bounds:    append([]float64(nil), latest.bounds...),
		StartedAt: w.snapshots[0].at.UTC().Format(time.RFC3339Nano),
	}
	for i := 1; i < len(w.snapshots); i++ {
		before, after := w.snapshots[i-1].hist, w.snapshots[i].hist
		counts := make([]int64, len(latest.counts))
		if after != nil {
			for j := range counts {
				counts[j] = after.counts[j]
				if before != nil {
					counts[j] -= before.counts[j]
				}
			}
		}
		window.Intervals = append(window.Intervals, consoleHistogramInterval{
			EndedAt: w.snapshots[i].at.UTC().Format(time.RFC3339Nano),
			Counts:  counts,
		})
	}
	return window
}

// histogramContinues reports whether next can follow prev on the same
// counters: no bucket decreased and the bounds are unchanged. A first report
// after none (nil prev) always continues, from zero.
func histogramContinues(prev, next *cumulativeHistogram) bool {
	if prev == nil {
		return true
	}
	if next == nil || len(prev.bounds) != len(next.bounds) {
		return false
	}
	for i, bound := range prev.bounds {
		if next.bounds[i] != bound {
			return false
		}
	}
	for i, count := range prev.counts {
		if next.counts[i] < count {
			return false
		}
	}
	return true
}

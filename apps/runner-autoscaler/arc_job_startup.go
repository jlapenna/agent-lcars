package main

import (
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"
)

// The listener's own histogram of the time from a job being assigned to a
// runner until that runner starts it. Homelab's "Runner fleet (ARC)"
// dashboard reads the same series for its fleet-wide job-startup p50.
const arcJobStartupBucketMetric = "gha_job_startup_duration_seconds_bucket"

const (
	// The console's CI wait readout covers the last 30 minutes.
	jobStartupWindowSpan = 30 * time.Minute
	// One recorded snapshot per minute bounds the published window to 30
	// intervals however often the listener is scraped.
	jobStartupSampleSpacing = time.Minute
	// The console accepts at most this many intervals per lane.
	jobStartupIntervals = 30
)

// jobStartupHistogram is one scrape's cumulative startup histogram, summed
// over every label set the listener reports (one per repository and job).
type jobStartupHistogram struct {
	// Finite upper bounds in seconds, ascending.
	bounds []float64
	// Cumulative job counts per bound; the final entry is the +Inf bucket,
	// so len(counts) == len(bounds)+1.
	counts []int64
}

// consoleJobStartupWindow is the lane's job-startup histogram over the last
// 30 minutes, one entry per recorded interval. The console sums lanes per
// interval to draw the fleet's CI wait p50 and its sparkline.
type consoleJobStartupWindow struct {
	Bounds    []float64                   `firestore:"bounds"`
	Intervals []consoleJobStartupInterval `firestore:"intervals"`
}

type consoleJobStartupInterval struct {
	EndedAt string `firestore:"endedAt"`
	// Cumulative counts of jobs that started in this interval, as in
	// jobStartupHistogram.counts.
	Counts []int64 `firestore:"counts"`
}

// parseJobStartupSample folds one exposition line, already split into name
// and value by splitPrometheusSample, into the per-bound sums. It reports
// false for any sample that is not a startup bucket.
func parseJobStartupSample(line, name, rest string, sums map[string]int64) (bool, error) {
	if name != arcJobStartupBucketMetric {
		return false, nil
	}
	le, ok := prometheusLabel(line[len(name):], "le")
	if !ok {
		return true, fmt.Errorf("ARC metric %s has no le label", name)
	}
	fields := strings.Fields(rest)
	if len(fields) == 0 {
		return true, fmt.Errorf("ARC metric %s has no value", name)
	}
	value, err := strconv.ParseFloat(fields[0], 64)
	if err != nil || math.IsNaN(value) || math.IsInf(value, 0) || value < 0 || value > math.MaxInt32 || value != math.Trunc(value) {
		return true, fmt.Errorf("ARC metric %s is not a nonnegative count", name)
	}
	sums[le] += int64(value)
	return true, nil
}

// prometheusLabel returns one label's value from labels, which starts with a
// sample's `{...}` label set. It walks every name="value" pair, honouring
// escapes, so a repository or job name can never pose as another label.
func prometheusLabel(labels, key string) (string, bool) {
	if !strings.HasPrefix(labels, "{") {
		return "", false
	}
	rest := labels[1:]
	for {
		rest = strings.TrimLeft(rest, " ,")
		if strings.HasPrefix(rest, "}") {
			return "", false
		}
		eq := strings.Index(rest, `="`)
		if eq <= 0 {
			return "", false
		}
		name := strings.TrimSpace(rest[:eq])
		var value strings.Builder
		i := eq + 2
		for ; i < len(rest) && rest[i] != '"'; i++ {
			if rest[i] == '\\' && i+1 < len(rest) {
				i++
			}
			value.WriteByte(rest[i])
		}
		if i >= len(rest) {
			return "", false
		}
		if name == key {
			return value.String(), true
		}
		rest = rest[i+1:]
	}
}

// jobStartupFromSums turns per-`le` sums into a histogram. No sample at all
// is a nil histogram: the listener has not reported a job start since it
// began. A partial or non-cumulative histogram is an error.
func jobStartupFromSums(sums map[string]int64) (*jobStartupHistogram, error) {
	if len(sums) == 0 {
		return nil, nil
	}
	infinite, ok := sums["+Inf"]
	if !ok {
		return nil, fmt.Errorf("ARC job startup histogram has no +Inf bucket")
	}
	bounds := make([]float64, 0, len(sums)-1)
	byBound := map[float64]int64{}
	for le, count := range sums {
		if le == "+Inf" {
			continue
		}
		bound, err := strconv.ParseFloat(le, 64)
		if err != nil || math.IsNaN(bound) || math.IsInf(bound, 0) || bound < 0 {
			return nil, fmt.Errorf("ARC job startup histogram has invalid bound %q", le)
		}
		if _, duplicate := byBound[bound]; duplicate {
			return nil, fmt.Errorf("ARC job startup histogram repeats bound %q", le)
		}
		byBound[bound] = count
		bounds = append(bounds, bound)
	}
	if len(bounds) == 0 || len(bounds) > 64 {
		return nil, fmt.Errorf("ARC job startup histogram has %d finite buckets", len(bounds))
	}
	sort.Float64s(bounds)
	counts := make([]int64, 0, len(bounds)+1)
	for _, bound := range bounds {
		counts = append(counts, byBound[bound])
	}
	counts = append(counts, infinite)
	for i := 1; i < len(counts); i++ {
		if counts[i] < counts[i-1] {
			return nil, fmt.Errorf("ARC job startup histogram is not cumulative")
		}
	}
	return &jobStartupHistogram{bounds: bounds, counts: counts}, nil
}

type jobStartupSnapshot struct {
	at time.Time
	// nil: the listener reported no job start yet, which is zero jobs.
	hist *jobStartupHistogram
}

// jobStartupWindow keeps one lane's recorded snapshots. Each lane's scrape
// goroutine owns its own window, so it needs no lock.
type jobStartupWindow struct {
	snapshots []jobStartupSnapshot
	last      *jobStartupHistogram
	// Zero until the first successful scrape, and again after a reset.
	lastAt time.Time
}

// reset forgets the window, for a scrape whose histogram cannot be used.
func (w *jobStartupWindow) reset() {
	*w = jobStartupWindow{}
}

// observe records a successful scrape and returns the lane's published
// window, or nil while no interval is known or the listener has never
// reported a start (absent and disabled metrics look the same).
func (w *jobStartupWindow) observe(now time.Time, hist *jobStartupHistogram) *consoleJobStartupWindow {
	// A listener restart zeroes its counters. Any decrease, or a change of
	// bucket layout, starts the window again rather than inventing a delta.
	// So does a gap in successful scrapes: an interval spanning it would
	// count jobs from outside the window, and could hide a restart.
	if !w.lastAt.IsZero() && (now.Sub(w.lastAt) > 2*jobStartupSampleSpacing || !jobStartupContinues(w.last, hist)) {
		w.snapshots = nil
	}
	w.last, w.lastAt = hist, now
	// Scrape times jitter around the 10s tick; without the slack every other
	// minute would wait a seventh tick and leave a gap in the sparkline.
	// Appending and trimming together changes the window once per minute.
	if n := len(w.snapshots); n == 0 || now.Sub(w.snapshots[n-1].at) >= jobStartupSampleSpacing-consoleStatusInterval/2 {
		w.snapshots = append(w.snapshots, jobStartupSnapshot{at: now, hist: hist})
		cutoff := now.Add(-jobStartupWindowSpan)
		for len(w.snapshots) > 1 && (!w.snapshots[1].at.After(cutoff) || len(w.snapshots) > jobStartupIntervals+1) {
			w.snapshots = w.snapshots[1:]
		}
	}
	latest := w.snapshots[len(w.snapshots)-1].hist
	if latest == nil || len(w.snapshots) < 2 {
		return nil
	}
	window := &consoleJobStartupWindow{Bounds: append([]float64(nil), latest.bounds...)}
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
		window.Intervals = append(window.Intervals, consoleJobStartupInterval{
			EndedAt: w.snapshots[i].at.UTC().Format(time.RFC3339Nano),
			Counts:  counts,
		})
	}
	return window
}

// jobStartupContinues reports whether next can follow prev on the same
// counters: no bucket decreased and the bounds are unchanged. A first report
// after none (nil prev) always continues, from zero.
func jobStartupContinues(prev, next *jobStartupHistogram) bool {
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

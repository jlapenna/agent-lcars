package main

import (
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
)

// The listener's own histogram of the time from a job being assigned to a
// runner until that runner starts it. Homelab's "Runner fleet (ARC)"
// dashboard reads the same series for its fleet-wide job-startup p50.
const arcJobStartupBucketMetric = "gha_job_startup_duration_seconds_bucket"

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
func jobStartupFromSums(sums map[string]int64) (*cumulativeHistogram, error) {
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
	return &cumulativeHistogram{bounds: bounds, counts: counts}, nil
}

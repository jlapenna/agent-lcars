package main

import (
	"net/http"
	"strings"
	"sync"
	"time"
)

// Upper bounds in seconds for Work API response times: the console's Work
// API p95 readout reads milliseconds to seconds, and anything past the last
// bound is a timeout in all but name.
var workAPILatencyBounds = []float64{0.025, 0.05, 0.1, 0.15, 0.2, 0.3, 0.5, 0.75, 1, 2, 5, 10}

// latencyRecorder counts response times into fixed buckets for the life of
// the process. Counts only grow, so histogramWindow can difference any two
// samples of it.
type latencyRecorder struct {
	bounds []float64
	mu     sync.Mutex
	// Per bucket, not cumulative; the last entry is past every bound.
	counts []int64
}

func newLatencyRecorder(bounds []float64) *latencyRecorder {
	return &latencyRecorder{bounds: bounds, counts: make([]int64, len(bounds)+1)}
}

func (r *latencyRecorder) record(d time.Duration) {
	seconds := d.Seconds()
	bucket := len(r.bounds)
	for i, bound := range r.bounds {
		if seconds <= bound {
			bucket = i
			break
		}
	}
	r.mu.Lock()
	r.counts[bucket]++
	r.mu.Unlock()
}

// histogram returns the counts so far in cumulative form. It is never nil:
// a process that has made no call has observed zero calls.
func (r *latencyRecorder) histogram() *cumulativeHistogram {
	r.mu.Lock()
	defer r.mu.Unlock()
	counts := make([]int64, len(r.counts))
	var sum int64
	for i, count := range r.counts {
		sum += count
		counts[i] = sum
	}
	return &cumulativeHistogram{bounds: append([]float64(nil), r.bounds...), counts: counts}
}

// workAPILatency records every Work API call this process makes: the queue
// executor's claims, placements, fences and exits, and the schedule ticks.
var workAPILatency = newLatencyRecorder(workAPILatencyBounds)

// workAPITimingTransport times requests to the console's Work API, from
// sending the request to receiving the response headers. A request that
// fails without a response is not a latency and is not recorded.
type workAPITimingTransport struct {
	base     http.RoundTripper
	recorder *latencyRecorder
}

func (t workAPITimingTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if !strings.HasPrefix(req.URL.Path, "/api/work/") {
		return t.base.RoundTrip(req)
	}
	start := time.Now()
	resp, err := t.base.RoundTrip(req)
	if err == nil {
		t.recorder.record(time.Since(start))
	}
	return resp, err
}

// timeWorkAPICalls wraps the default transport, which every Work API client
// in this process uses (none sets its own), so no call site has to opt in.
// Call it once from main before any client is used.
func timeWorkAPICalls() {
	http.DefaultTransport = workAPITimingTransport{base: http.DefaultTransport, recorder: workAPILatency}
}

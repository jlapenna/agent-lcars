package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"reflect"
	"testing"
	"time"
)

type stubRoundTripper struct {
	delay time.Duration
	err   error
}

func (s stubRoundTripper) RoundTrip(*http.Request) (*http.Response, error) {
	time.Sleep(s.delay)
	if s.err != nil {
		return nil, s.err
	}
	return &http.Response{StatusCode: http.StatusOK, Body: http.NoBody}, nil
}

func TestLatencyRecorderBucketsCumulatively(t *testing.T) {
	recorder := newLatencyRecorder([]float64{0.1, 1})
	for _, d := range []time.Duration{50 * time.Millisecond, 100 * time.Millisecond, 500 * time.Millisecond, 3 * time.Second} {
		recorder.record(d)
	}
	got := recorder.histogram()
	if !reflect.DeepEqual(got.counts, []int64{2, 3, 4}) || !reflect.DeepEqual(got.bounds, []float64{0.1, 1}) {
		t.Fatalf("histogram = %#v", got)
	}
}

func TestWorkAPITimingTransportRecordsAnsweredAndTimedOutWorkAPICalls(t *testing.T) {
	recorder := newLatencyRecorder([]float64{0.001, 10})
	answered := workAPITimingTransport{base: stubRoundTripper{delay: 2 * time.Millisecond}, recorder: recorder}
	failed := workAPITimingTransport{base: stubRoundTripper{err: errors.New("dial")}, recorder: recorder}
	timedOut := workAPITimingTransport{base: stubRoundTripper{delay: 2 * time.Millisecond, err: context.DeadlineExceeded}, recorder: recorder}
	for _, call := range []struct {
		transport workAPITimingTransport
		url       string
	}{
		{answered, "https://console.example/api/work/v1/runs/claim"},
		{answered, "http://listener.example:30081/metrics"},
		{failed, "https://console.example/api/work/v1/runs/claim"},
		{timedOut, "https://console.example/api/work/v1/runs/claim"},
	} {
		req, err := http.NewRequest(http.MethodPost, call.url, http.NoBody)
		if err != nil {
			t.Fatal(err)
		}
		if resp, err := call.transport.RoundTrip(req); err == nil {
			resp.Body.Close()
		}
	}
	if got := recorder.histogram().counts; !reflect.DeepEqual(got, []int64{0, 2, 2}) {
		t.Fatalf("recorded %v, want the answered and the timed-out Work API calls in (1ms, 10s]", got)
	}
}

func TestQueueExecutorStatusPublishesWorkAPILatencyWindow(t *testing.T) {
	recorder := newLatencyRecorder([]float64{0.1, 1})
	source := newQueueExecutorStatusSource(slog.Default())
	source.claimCounters = nil
	source.latency = recorder.histogram
	start := time.Date(2026, 10, 13, 12, 0, 0, 0, time.UTC)
	if got := source.snapshot(t.Context(), start).WorkAPILatency; got != nil {
		t.Fatalf("published a window from one snapshot: %#v", got)
	}
	recorder.record(40 * time.Millisecond)
	recorder.record(400 * time.Millisecond)
	got := source.snapshot(t.Context(), start.Add(time.Minute)).WorkAPILatency
	want := &consoleHistogramWindow{
		Bounds:    []float64{0.1, 1},
		StartedAt: "2026-10-13T12:00:00Z",
		Intervals: []consoleHistogramInterval{{EndedAt: "2026-10-13T12:01:00Z", Counts: []int64{1, 2, 2}}},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("window = %#v, want %#v", got, want)
	}
}

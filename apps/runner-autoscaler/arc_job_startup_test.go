package main

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"
)

// startupBuckets renders the listener's startup histogram for two jobs, each
// with its own label set, as ARC exposes it.
func startupBuckets(a, b [3]int) string {
	var out strings.Builder
	for _, job := range []struct {
		name   string
		counts [3]int
	}{{"build", a}, {"test", b}} {
		for i, le := range []string{"1", "10", "+Inf"} {
			fmt.Fprintf(&out, "gha_job_startup_duration_seconds_bucket{job_name=%q,le=%q,repository=\"agent-lcars\"} %d\n", job.name, le, job.counts[i])
		}
		fmt.Fprintf(&out, "gha_job_startup_duration_seconds_count{job_name=%q} %d\n", job.name, job.counts[2])
	}
	return out.String()
}

func TestARCLaneStatusSumsJobStartupHistogramAcrossLabelSets(t *testing.T) {
	body := arcMetricsFixture + startupBuckets([3]int{1, 2, 3}, [3]int{0, 4, 4})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, body) }))
	defer server.Close()
	lane := arcLaneConfig{Name: "test", RegistrationURL: "https://github.com/example/repo", MetricsURL: server.URL}
	window := &jobStartupWindow{}
	start := time.Date(2026, 10, 13, 12, 0, 0, 0, time.UTC)
	status, err := fetchARCLaneStatus(context.Background(), server.Client(), lane, start, window)
	if err != nil {
		t.Fatal(err)
	}
	if status.JobStartup != nil {
		t.Fatalf("published a window from one snapshot: %#v", status.JobStartup)
	}
	body = arcMetricsFixture + startupBuckets([3]int{2, 4, 6}, [3]int{0, 5, 7})
	status, err = fetchARCLaneStatus(context.Background(), server.Client(), lane, start.Add(time.Minute), window)
	if err != nil {
		t.Fatal(err)
	}
	want := &consoleJobStartupWindow{
		Bounds:    []float64{1, 10},
		StartedAt: "2026-10-13T12:00:00Z",
		Intervals: []consoleJobStartupInterval{{EndedAt: "2026-10-13T12:01:00Z", Counts: []int64{1, 3, 6}}},
	}
	if !reflect.DeepEqual(status.JobStartup, want) {
		t.Fatalf("window = %#v, want %#v", status.JobStartup, want)
	}
}

func TestARCLaneStatusKeepsCapacityWhenJobStartupHistogramIsMalformed(t *testing.T) {
	for _, tc := range []struct{ name, startup string }{
		{"no +Inf", "gha_job_startup_duration_seconds_bucket{le=\"1\"} 1\n"},
		{"no le", "gha_job_startup_duration_seconds_bucket{job_name=\"build\"} 1\ngha_job_startup_duration_seconds_bucket{le=\"+Inf\"} 1\n"},
		{"not cumulative", "gha_job_startup_duration_seconds_bucket{le=\"1\"} 3\ngha_job_startup_duration_seconds_bucket{le=\"+Inf\"} 2\n"},
		{"fractional", "gha_job_startup_duration_seconds_bucket{le=\"1\"} 0.5\ngha_job_startup_duration_seconds_bucket{le=\"+Inf\"} 1\n"},
		{"bad bound", "gha_job_startup_duration_seconds_bucket{le=\"soon\"} 0\ngha_job_startup_duration_seconds_bucket{le=\"+Inf\"} 1\n"},
		{"le only inside a job name", "gha_job_startup_duration_seconds_bucket{job_name=\"x,le=\\\"1\"} 1\ngha_job_startup_duration_seconds_bucket{le=\"+Inf\"} 1\n"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, arcMetricsFixture+tc.startup) }))
			defer server.Close()
			window := &jobStartupWindow{}
			window.observe(time.Now().Add(-time.Minute), nil)
			status, err := fetchARCLaneStatus(context.Background(), server.Client(), arcLaneConfig{Name: "test", RegistrationURL: "https://github.com/example/repo", MetricsURL: server.URL}, time.Now(), window)
			if err != nil {
				t.Fatalf("a bad startup histogram cost the lane its capacity: %v", err)
			}
			if status.RegisteredRunners != 2 || status.JobStartup != nil || len(window.snapshots) != 0 {
				t.Fatalf("published or kept startup data from a malformed histogram: %#v %#v", status, window)
			}
		})
	}
}

func hist(counts ...int64) *jobStartupHistogram {
	return &jobStartupHistogram{bounds: []float64{1, 10}, counts: counts}
}

func TestJobStartupWindowRecordsOneSnapshotPerMinuteAndKeepsThirtyMinutes(t *testing.T) {
	window := &jobStartupWindow{}
	start := time.Date(2026, 10, 13, 12, 0, 0, 0, time.UTC)
	var published *consoleJobStartupWindow
	total := int64(0)
	for tick := 0; tick <= 40*6; tick++ {
		if tick%6 == 0 {
			total++
		}
		published = window.observe(start.Add(time.Duration(tick)*10*time.Second), hist(0, total, total))
	}
	if len(published.Intervals) != 30 {
		t.Fatalf("kept %d intervals, want 30", len(published.Intervals))
	}
	if got := published.Intervals[29].EndedAt; got != "2026-10-13T12:40:00Z" {
		t.Fatalf("latest interval ended %s", got)
	}
	for _, interval := range published.Intervals {
		if !reflect.DeepEqual(interval.Counts, []int64{0, 1, 1}) {
			t.Fatalf("interval %s counts %v, want one job", interval.EndedAt, interval.Counts)
		}
	}
}

func TestJobStartupWindowChangesOncePerMinuteDespiteScrapeJitter(t *testing.T) {
	window := &jobStartupWindow{}
	start := time.Date(2026, 10, 13, 12, 0, 0, 0, time.UTC)
	var previous *consoleJobStartupWindow
	changes := 0
	for tick := 0; tick <= 60*6; tick++ {
		// Each scrape starts a little early or late on the 10s tick.
		jitter := time.Duration((tick%3)-1) * time.Millisecond
		published := window.observe(start.Add(time.Duration(tick)*consoleStatusInterval+jitter), hist(0, 1, 1))
		if !reflect.DeepEqual(published, previous) {
			changes++
		}
		previous = published
	}
	if changes > 61 {
		t.Fatalf("window changed %d times in an hour, want one per minute", changes)
	}
	if len(previous.Intervals) != 30 {
		t.Fatalf("kept %d intervals, want 30", len(previous.Intervals))
	}
}

func TestJobStartupWindowRestartsAfterAScrapeGap(t *testing.T) {
	window := &jobStartupWindow{}
	start := time.Date(2026, 10, 13, 12, 0, 0, 0, time.UTC)
	window.observe(start, hist(0, 1, 1))
	if got := window.observe(start.Add(time.Minute), hist(0, 2, 2)); got == nil {
		t.Fatal("no window before the gap")
	}
	if got := window.observe(start.Add(2*time.Hour), hist(0, 90, 90)); got != nil {
		t.Fatalf("published two hours of jobs as one interval: %#v", got)
	}
	got := window.observe(start.Add(2*time.Hour+time.Minute), hist(0, 91, 91))
	if got == nil || len(got.Intervals) != 1 || got.Intervals[0].Counts[2] != 1 {
		t.Fatalf("window did not resume after the gap: %#v", got)
	}
}

func TestJobStartupWindowRestartsOnCounterResetAndLayoutChange(t *testing.T) {
	start := time.Date(2026, 10, 13, 12, 0, 0, 0, time.UTC)
	for _, tc := range []struct {
		name string
		next *jobStartupHistogram
	}{
		{"decrease", hist(0, 1, 1)},
		{"bounds", &jobStartupHistogram{bounds: []float64{1, 30}, counts: []int64{5, 9, 9}}},
		{"vanished", nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			window := &jobStartupWindow{}
			window.observe(start, hist(4, 8, 8))
			if got := window.observe(start.Add(time.Minute), hist(5, 9, 9)); got == nil {
				t.Fatal("no window before the reset")
			}
			if got := window.observe(start.Add(2*time.Minute), tc.next); got != nil {
				t.Fatalf("published a delta across a reset: %#v", got)
			}
		})
	}
}

func TestJobStartupWindowCountsFirstReportAfterNoneFromZero(t *testing.T) {
	window := &jobStartupWindow{}
	start := time.Date(2026, 10, 13, 12, 0, 0, 0, time.UTC)
	if got := window.observe(start, nil); got != nil {
		t.Fatalf("published a window with no reported histogram: %#v", got)
	}
	got := window.observe(start.Add(time.Minute), hist(1, 2, 2))
	if got == nil || len(got.Intervals) != 1 || !reflect.DeepEqual(got.Intervals[0].Counts, []int64{1, 2, 2}) {
		t.Fatalf("first report did not count from zero: %#v", got)
	}
}

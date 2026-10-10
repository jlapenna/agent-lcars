package main

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

const arcMetricsFixture = `# TYPE gha_assigned_jobs gauge
gha_assigned_jobs{name="test-listener",namespace="arc-runners"} 3
gha_running_jobs{name="test-listener"} 1
gha_idle_runners{name="test-listener"} 1
gha_registered_runners{name="test-listener"} 2
gha_desired_runners{name="test-listener"} 3
gha_min_runners{name="test-listener"} 0
gha_max_runners{name="test-listener"} 4
`

func TestARCLaneStatusMapsListenerCapacityAndRejectsUncertainMetrics(t *testing.T) {
	for _, tc := range []struct {
		name, body string
		bad        bool
	}{
		{"valid", arcMetricsFixture, false},
		{"missing", strings.ReplaceAll(arcMetricsFixture, "gha_running_jobs{name=\"test-listener\"} 1\n", ""), true},
		{"NaN", strings.ReplaceAll(arcMetricsFixture, "} 4\n", "} NaN\n"), true},
		{"negative", strings.ReplaceAll(arcMetricsFixture, "} 4\n", "} -1\n"), true},
		{"ambiguous", arcMetricsFixture + "gha_running_jobs{name=\"other\"} 1\n", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, tc.body) }))
			defer server.Close()
			now := time.Now()
			status, err := fetchARCLaneStatus(context.Background(), server.Client(), arcLaneConfig{Name: "test", RegistrationURL: "https://github.com/example/repo", MetricsURL: server.URL}, now)
			if tc.bad {
				if err == nil {
					t.Fatalf("accepted uncertain scrape: %#v", status)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if status.Kind != "arc-lane" || status.SchemaVersion != 3 || status.Lane != "test" || status.PendingJobs != 2 || status.RunningJobs != 1 || status.IdleRunners != 1 || status.RegisteredRunners != 2 || status.DesiredRunners != 3 || status.MaxRunners != 4 || !status.ExpireAt.Equal(now.Add(consoleStatusTTL)) {
				t.Fatalf("incorrect capacity: %#v", status)
			}
		})
	}
}

type captureARCLanePublisher struct{ statuses chan consoleARCLaneStatus }

func (p captureARCLanePublisher) PublishARCLane(_ context.Context, status consoleARCLaneStatus) {
	p.statuses <- status
}
func (captureARCLanePublisher) PublishQueueExecutor(context.Context, consoleQueueExecutorStatus) {}
func (captureARCLanePublisher) Enabled() bool                                                    { return true }
func (captureARCLanePublisher) Close() error                                                     { return nil }

func TestSurvivingARCLanePublishesAuthoritativeInventoryWhenOtherScrapeFails(t *testing.T) {
	good := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, arcMetricsFixture) }))
	defer good.Close()
	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusServiceUnavailable) }))
	defer bad.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	publisher := captureARCLanePublisher{statuses: make(chan consoleARCLaneStatus, 2)}
	done := make(chan struct{})
	go func() {
		runARCLaneStatusPublisher(ctx, publisher, []arcLaneConfig{
			{Name: "good", RegistrationURL: "https://github.com/example/repo", MetricsURL: good.URL},
			{Name: "bad", RegistrationURL: "https://github.com/example/repo", MetricsURL: bad.URL},
		}, slog.Default())
		close(done)
	}()
	select {
	case status := <-publisher.statuses:
		if status.Lane != "good" || status.ExpectedLanes != "bad,good" {
			t.Fatalf("lost configured missing lane: %#v", status)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("publisher did not publish surviving lane")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("publisher did not stop")
	}
}

func TestARCLaneInventoryUsesExistingChangeAndHeartbeatWriteGate(t *testing.T) {
	now := time.Now()
	status := consoleARCLaneStatus{SchemaVersion: 3, Kind: "arc-lane", Lane: "good", ExpectedLanes: "good"}
	gate := newStatusWriteGate(consoleStatusHeartbeat)
	gate.recordWritten("arc-good", status, now)
	if gate.shouldWrite("arc-good", status, now.Add(consoleStatusInterval)) {
		t.Fatal("inventory added duplicate writes")
	}
	status.ExpectedLanes = "bad,good"
	if !gate.shouldWrite("arc-good", status, now.Add(consoleStatusInterval)) {
		t.Fatal("inventory change did not publish")
	}
	gate.recordWritten("arc-good", status, now)
	if !gate.shouldWrite("arc-good", status, now.Add(consoleStatusHeartbeat)) {
		t.Fatal("inventory missed heartbeat")
	}
}

func TestARCLaneStatusFailsHTTPAndBoundsUnavailableListener(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusServiceUnavailable) }))
	defer server.Close()
	_, err := fetchARCLaneStatus(context.Background(), server.Client(), arcLaneConfig{MetricsURL: server.URL}, time.Now())
	if err == nil {
		t.Fatal("accepted failed listener")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = fetchARCLaneStatus(ctx, server.Client(), arcLaneConfig{MetricsURL: server.URL}, time.Now())
	if err == nil {
		t.Fatal("ignored cancelled scrape")
	}
}

func TestARCLaneConfigurationRejectsDuplicateNamesAndUnsafeURLs(t *testing.T) {
	valid := arcLaneConfig{Name: "ci-light", RegistrationURL: "https://github.com/example/repo", MetricsURL: "http://cluster:30081/metrics"}
	if err := validateARCLanes([]arcLaneConfig{valid}); err != nil {
		t.Fatal(err)
	}
	if err := validateARCLanes([]arcLaneConfig{valid, valid}); err == nil {
		t.Fatal("accepted duplicate lanes")
	}
	valid.MetricsURL = "http://user:password@cluster/metrics"
	if err := validateARCLanes([]arcLaneConfig{valid}); err == nil {
		t.Fatal("accepted credentials in URL")
	}
}

func TestSplitPrometheusSample(t *testing.T) {
	for _, tc := range []struct {
		line, name, rest string
		ok               bool
	}{
		{line: "gha_running_jobs 3", name: "gha_running_jobs", rest: "3", ok: true},
		{line: `gha_running_jobs{name="lane"} 2 1700000000`, name: "gha_running_jobs", rest: " 2 1700000000", ok: true},
		{line: `gha_running_jobs{reason="on 1 battery"} 0`, name: "gha_running_jobs", rest: " 0", ok: true},
		{line: "gha_running_jobs", ok: false},
		{line: `gha_running_jobs{name="unterminated 1`, ok: false},
	} {
		name, rest, ok := splitPrometheusSample(tc.line)
		if ok != tc.ok || (ok && (name != tc.name || rest != tc.rest)) {
			t.Errorf("splitPrometheusSample(%q) = (%q, %q, %v), want (%q, %q, %v)", tc.line, name, rest, ok, tc.name, tc.rest, tc.ok)
		}
	}
}

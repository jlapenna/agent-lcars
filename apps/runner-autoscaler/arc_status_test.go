package main

import (
	"context"
	"fmt"
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
			if status.Kind != "arc-lane" || status.SchemaVersion != 3 || status.Lane != "test" || status.PendingJobs != 2 || status.RunningJobs != 1 || status.IdleRunners != 1 || status.RegisteredRunners != 2 || status.DesiredRunners != 3 || status.MaxRunners != 4 || !status.ExpireAt.Equal(now.Add(30*time.Second)) {
				t.Fatalf("incorrect capacity: %#v", status)
			}
		})
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

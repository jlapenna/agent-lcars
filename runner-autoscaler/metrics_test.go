package main

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"
)

func TestMetricsAndHealthzServer(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	logger := slog.New(slog.NewTextHandler(os.Stdout, nil))
	addr := "127.0.0.1:28080"
	startMetricsServer(ctx, addr, logger)

	// Record a test metric so label vector produces output
	desiredRunnersGauge.WithLabelValues("test-scaleset").Set(2)

	// Give the server a brief moment to start
	time.Sleep(100 * time.Millisecond)

	// Test /healthz
	resp, err := http.Get("http://" + addr + "/healthz")
	if err != nil {
		t.Fatalf("failed to GET /healthz: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		t.Errorf("expected /healthz status 200, got %d", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	if string(body) != "OK\n" {
		t.Errorf("expected /healthz body OK\\n, got %q", string(body))
	}

	orchestratorSchedulerReady.Store(true)
	orchestratorExpectedListeners.Store(2)
	orchestratorListenerStates.Store("a", true)
	orchestratorListenerStates.Store("b", false)
	degraded, err := http.Get("http://" + addr + "/readyz")
	if err != nil {
		t.Fatal(err)
	}
	_ = degraded.Body.Close()
	if degraded.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("degraded /readyz status = %d, want 503", degraded.StatusCode)
	}
	orchestratorListenerStates.Store("b", true)
	ready, err := http.Get("http://" + addr + "/readyz")
	if err != nil {
		t.Fatal(err)
	}
	_ = ready.Body.Close()
	if ready.StatusCode != http.StatusOK {
		t.Fatalf("ready /readyz status = %d, want 200", ready.StatusCode)
	}
	orchestratorSchedulerReady.Store(false)

	// Test /metrics
	respMetrics, err := http.Get("http://" + addr + "/metrics")
	if err != nil {
		t.Fatalf("failed to GET /metrics: %v", err)
	}
	defer func() { _ = respMetrics.Body.Close() }()

	if respMetrics.StatusCode != http.StatusOK {
		t.Errorf("expected /metrics status 200, got %d", respMetrics.StatusCode)
	}
	metricsBody, _ := io.ReadAll(respMetrics.Body)
	if !strings.Contains(string(metricsBody), "github_runner_autoscaler_desired_runners") {
		t.Errorf("expected /metrics response to contain github_runner_autoscaler_desired_runners, got:\n%s", string(metricsBody))
	}
}

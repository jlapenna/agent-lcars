package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestParsePrometheusMetricValue(t *testing.T) {
	tests := []struct {
		name      string
		body      string
		metric    string
		wantValue float64
		wantFound bool
	}{
		{name: "bare metric value 1", body: "host_ready 1\n", metric: "host_ready", wantValue: 1, wantFound: true},
		{name: "bare metric value 0", body: "host_ready 0\n", metric: "host_ready", wantValue: 0, wantFound: true},
		{name: "labeled metric ignores labels", body: `host_ready{host="laptop"} 1` + "\n", metric: "host_ready", wantValue: 1, wantFound: true},
		{name: "help and type comments ignored", body: "# HELP host_ready docs\n# TYPE host_ready gauge\n\nhost_ready 1\n", metric: "host_ready", wantValue: 1, wantFound: true},
		{name: "metric absent", body: "other_metric 1\n", metric: "host_ready", wantFound: false},
		{name: "empty body", body: "", metric: "host_ready", wantFound: false},
		{name: "optional timestamp ignored", body: "host_ready 1 1700000000000\n", metric: "host_ready", wantValue: 1, wantFound: true},
		{name: "first matching sample wins", body: "host_ready 1\nhost_ready 0\n", metric: "host_ready", wantValue: 1, wantFound: true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			value, found, err := parsePrometheusMetricValue(strings.NewReader(tc.body), tc.metric)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if found != tc.wantFound {
				t.Fatalf("found = %v, want %v", found, tc.wantFound)
			}
			if found && value != tc.wantValue {
				t.Fatalf("value = %v, want %v", value, tc.wantValue)
			}
		})
	}
}

// TestFetchHostReadiness covers the table the design calls for: metric 1 is
// eligible, 0 is not, a missing metric is an error (never silently
// eligible), and both an HTTP error status and an unreachable/slow endpoint
// fail closed rather than defaulting to ready.
func TestFetchHostReadiness(t *testing.T) {
	t.Run("metric value 1 is ready", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			_, _ = w.Write([]byte("host_ready 1\n"))
		}))
		defer server.Close()
		ready, err := fetchHostReadiness(context.Background(), nil, hostReadinessConfig{url: server.URL, metric: "host_ready"})
		if err != nil || !ready {
			t.Fatalf("ready = (%v, %v), want (true, nil)", ready, err)
		}
	})

	t.Run("metric value 0 is not ready", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			_, _ = w.Write([]byte("host_ready 0\n"))
		}))
		defer server.Close()
		ready, err := fetchHostReadiness(context.Background(), nil, hostReadinessConfig{url: server.URL, metric: "host_ready"})
		if err != nil || ready {
			t.Fatalf("ready = (%v, %v), want (false, nil)", ready, err)
		}
	})

	t.Run("missing metric is an error, not silently ready", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			_, _ = w.Write([]byte("other_metric 1\n"))
		}))
		defer server.Close()
		ready, err := fetchHostReadiness(context.Background(), nil, hostReadinessConfig{url: server.URL, metric: "host_ready"})
		if err == nil || ready {
			t.Fatalf("ready = (%v, %v), want an error and false", ready, err)
		}
	})

	t.Run("http error status fails closed", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusInternalServerError)
		}))
		defer server.Close()
		ready, err := fetchHostReadiness(context.Background(), nil, hostReadinessConfig{url: server.URL, metric: "host_ready"})
		if err == nil || ready {
			t.Fatalf("ready = (%v, %v), want an error and false", ready, err)
		}
	})

	t.Run("unreachable endpoint fails closed", func(t *testing.T) {
		ready, err := fetchHostReadiness(context.Background(), nil, hostReadinessConfig{url: "http://127.0.0.1:1/metrics", metric: "host_ready"})
		if err == nil || ready {
			t.Fatalf("ready = (%v, %v), want an error and false", ready, err)
		}
	})

	t.Run("slow endpoint times out and fails closed", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			time.Sleep(200 * time.Millisecond)
			_, _ = w.Write([]byte("host_ready 1\n"))
		}))
		defer server.Close()
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
		defer cancel()
		ready, err := fetchHostReadiness(ctx, nil, hostReadinessConfig{url: server.URL, metric: "host_ready"})
		if err == nil || ready {
			t.Fatalf("ready = (%v, %v), want a timeout error and false", ready, err)
		}
	})
}

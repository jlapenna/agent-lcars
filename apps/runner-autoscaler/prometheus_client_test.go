package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestPrometheusClientInstantQuerySuccess(t *testing.T) {
	var gotQuery string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotQuery = r.URL.Query().Get("query")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"success","data":{"resultType":"vector","result":[{"metric":{},"value":[1735689600,"4566323200.5"]}]}}`))
	}))
	defer srv.Close()

	client := newPrometheusClient(srv.URL)
	got, err := client.InstantQuery(context.Background(), `quantile(0.95, foo)`)
	if err != nil {
		t.Fatalf("InstantQuery() error = %v", err)
	}
	if got != 4566323200.5 {
		t.Fatalf("InstantQuery() = %v, want 4566323200.5", got)
	}
	if gotQuery != "quantile(0.95, foo)" {
		t.Fatalf("server received query %q, want the exact PromQL text", gotQuery)
	}
}

func TestPrometheusClientInstantQueryErrorStatus(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"error","errorType":"bad_data","error":"parse error at char 1"}`))
	}))
	defer srv.Close()

	client := newPrometheusClient(srv.URL)
	_, err := client.InstantQuery(context.Background(), "not promql")
	if err == nil || !strings.Contains(err.Error(), "parse error at char 1") {
		t.Fatalf("InstantQuery() error = %v, want it to surface Prometheus's own error message", err)
	}
}

func TestPrometheusClientInstantQueryHTTPErrorStatus(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte("upstream unavailable"))
	}))
	defer srv.Close()

	client := newPrometheusClient(srv.URL)
	_, err := client.InstantQuery(context.Background(), "up")
	if err == nil || !strings.Contains(err.Error(), "503") {
		t.Fatalf("InstantQuery() error = %v, want it to report the HTTP status", err)
	}
}

func TestPrometheusClientInstantQueryEmptyResultIsAnError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"success","data":{"resultType":"vector","result":[]}}`))
	}))
	defer srv.Close()

	client := newPrometheusClient(srv.URL)
	_, err := client.InstantQuery(context.Background(), "up")
	if err == nil || !strings.Contains(err.Error(), "no samples") {
		t.Fatalf("InstantQuery() error = %v, want a distinct \"no samples\" error (not a silent zero)", err)
	}
}

func TestPrometheusClientInstantQueryTimeout(t *testing.T) {
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-release // never responds inside the test's timeout budget
	}))
	// A single deferred close, in this order: srv.Close() blocks until every
	// outstanding request finishes, so the handler must be released FIRST or
	// this deadlocks against its own cleanup.
	defer func() {
		close(release)
		srv.Close()
	}()

	client := newPrometheusClientWithTimeout(srv.URL, 20*time.Millisecond)
	start := time.Now()
	_, err := client.InstantQuery(context.Background(), "up")
	if err == nil {
		t.Fatal("InstantQuery() error = nil, want a timeout error")
	}
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("InstantQuery() took %v, want it bounded by the client's own timeout, not the caller's context", elapsed)
	}
}

func TestPrometheusClientInstantQueryMalformedJSON(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{not json`))
	}))
	defer srv.Close()

	client := newPrometheusClient(srv.URL)
	_, err := client.InstantQuery(context.Background(), "up")
	if err == nil || !strings.Contains(err.Error(), "decoding prometheus response") {
		t.Fatalf("InstantQuery() error = %v, want a decode error", err)
	}
}

func TestPrometheusClientInstantQueryNonStringValue(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		// Spec-violating: Prometheus always encodes the sample value as a
		// JSON string, never a bare number. Guard against a future or
		// nonstandard server that does.
		_, _ = w.Write([]byte(`{"status":"success","data":{"resultType":"vector","result":[{"metric":{},"value":[1735689600,4.5]}]}}`))
	}))
	defer srv.Close()

	client := newPrometheusClient(srv.URL)
	_, err := client.InstantQuery(context.Background(), "up")
	if err == nil || !strings.Contains(err.Error(), "non-string sample value") {
		t.Fatalf("InstantQuery() error = %v, want a non-string-value error", err)
	}
}

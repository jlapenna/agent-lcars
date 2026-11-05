package main

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

const credentialObservationFixture = `{"version":1,"observedAt":"2026-11-05T00:00:00Z","configured":true,"metadataAvailable":true,"dependency":"ready","counts":{"total":2,"ready":1,"disabled":1,"unpromoted":0,"expired":0,"expiring":1,"unknown":0},"deliveries":17,"deliveryTimed":12,"deliveryDurationSeconds":2.5,"admissionRefusals":2,"deliveryRefusals":3,"lastDeliveryAt":"2026-11-04T23:59:00Z","lastRefusalAt":"2026-11-04T23:59:30Z"}`

func credentialFixture(t *testing.T, body string) *jobCredentialObservation {
	t.Helper()
	var observation jobCredentialObservation
	if err := json.Unmarshal([]byte(body), &observation); err != nil {
		t.Fatal(err)
	}
	return &observation
}

func credentialScrape(t *testing.T, metrics *jobCredentialMetrics) string {
	t.Helper()
	registry := prometheus.NewRegistry()
	registry.MustRegister(metrics)
	response := httptest.NewRecorder()
	promhttp.HandlerFor(registry, promhttp.HandlerOpts{}).ServeHTTP(response, httptest.NewRequest("GET", "/metrics", nil))
	if response.Code != 200 {
		t.Fatalf("scrape status %d", response.Code)
	}
	return response.Body.String()
}

func TestJobCredentialMetricsDurableCountersAndMissingObservation(t *testing.T) {
	now, _ := time.Parse(time.RFC3339, "2026-11-05T00:01:00Z")
	for i := 0; i < 2; i++ { // A new runner must expose the same durable counters.
		metrics := newJobCredentialMetrics()
		if !metrics.record(credentialFixture(t, credentialObservationFixture), now) {
			t.Fatal("valid observation refused")
		}
		body := credentialScrape(t, metrics)
		for _, sample := range []string{
			"# TYPE lcars_job_credentials_deliveries_total counter",
			"lcars_job_credentials_deliveries_total 17\n",
			"lcars_job_credentials_refusals_total{stage=\"admission\"} 2\n",
			"lcars_job_credentials_delivery_duration_seconds_total 2.5\n",
			"lcars_job_credentials_delivery_duration_observations_total 12\n",
			"lcars_job_credentials_last_refusal_timestamp_seconds 1.79383677e+09\n",
		} {
			if !strings.Contains(body, sample) {
				t.Fatalf("missing public sample %q in %s", sample, body)
			}
		}
		if metrics.record(nil, now.Add(time.Hour)) {
			t.Fatal("missing reply was healthy")
		}
		stale := credentialScrape(t, metrics)
		if !strings.Contains(stale, "lcars_job_credentials_read_available 0\n") || !strings.Contains(stale, "lcars_job_credentials_observed_timestamp_seconds 1.7938368e+09\n") || !strings.Contains(stale, "lcars_job_credentials_deliveries_total 17\n") {
			t.Fatalf("missing reply lost the stale evidence: %s", stale)
		}
	}
}

func TestJobCredentialMetricsUnknownIdleDisabledAndInvalidData(t *testing.T) {
	now, _ := time.Parse(time.RFC3339, "2026-11-05T00:01:00Z")
	metrics := newJobCredentialMetrics()
	initial := credentialScrape(t, metrics)
	if strings.Contains(initial, "lcars_job_credentials_configured ") || !strings.Contains(initial, "lcars_job_credentials_read_available 0\n") {
		t.Fatal("unobserved state was presented as disabled or healthy")
	}
	for _, body := range []string{
		`{"version":1,"observedAt":"2026-11-05T00:00:00Z","configured":false,"metadataAvailable":false,"dependency":"disabled"}`,
		`{"version":1,"observedAt":"2026-11-05T00:00:00Z","configured":true,"metadataAvailable":false,"dependency":"unknown"}`,
		`{"version":1,"observedAt":"2026-11-05T00:00:00Z","configured":true,"metadataAvailable":true,"dependency":"idle","counts":{"total":0,"ready":0,"disabled":0,"unpromoted":0,"expired":0,"expiring":0,"unknown":0},"deliveries":0,"deliveryTimed":0,"deliveryDurationSeconds":0,"admissionRefusals":0,"deliveryRefusals":0}`,
	} {
		if !metrics.record(credentialFixture(t, body), now) {
			t.Fatalf("valid state refused: %s", body)
		}
	}
	if !strings.Contains(credentialScrape(t, metrics), "lcars_job_credentials_last_delivery_timestamp_seconds 0\n") {
		t.Fatal("idle state invented a completed delivery")
	}
	for _, bad := range []string{
		strings.Replace(credentialObservationFixture, `"configured":true,`, "", 1),
		strings.Replace(credentialObservationFixture, `"ready":1`, `"ready":500`, 1),
		strings.Replace(credentialObservationFixture, `"deliveries":17,`, "", 1),
		strings.Replace(credentialObservationFixture, `"deliveryTimed":12`, `"deliveryTimed":99`, 1),
		strings.Replace(credentialObservationFixture, `"observedAt":"2026-11-05T00:00:00Z"`, `"observedAt":"2026-11-05T01:00:00Z"`, 1),
		strings.Replace(credentialObservationFixture, `"lastRefusalAt":"2026-11-04T23:59:30Z"`, `"lastRefusalAt":""`, 1),
	} {
		if metrics.record(credentialFixture(t, bad), now) {
			t.Fatal("invalid credential observation was accepted")
		}
	}
}

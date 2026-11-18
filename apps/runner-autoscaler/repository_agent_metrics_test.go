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

const repositoryAgentFixture = `{"version":1,"observedAt":"2026-11-18T10:00:00Z","agents":{"enabled":2,"vetoed":0,"invalid":1,"unavailable":0,"removed":0},"sources":[{"repository":"jlapenna/homelab","attemptedAt":"2026-11-18T09:59:00Z","succeededAt":"2026-11-18T09:59:00Z"},{"repository":"jlapenna/agent-lcars","attemptedAt":"2026-11-18T09:58:00Z","failedAt":"2026-11-18T09:58:00Z","succeededAt":"2026-11-18T09:00:00Z"}]}`

func repositoryAgentScrape(t *testing.T, m *repositoryAgentMetrics) string {
	t.Helper()
	registry := prometheus.NewRegistry()
	registry.MustRegister(m)
	response := httptest.NewRecorder()
	promhttp.HandlerFor(registry, promhttp.HandlerOpts{}).ServeHTTP(response, httptest.NewRequest("GET", "/metrics", nil))
	return response.Body.String()
}

func repositoryAgentObservationFrom(t *testing.T, body string) *repositoryAgentObservation {
	t.Helper()
	var o repositoryAgentObservation
	if err := json.Unmarshal([]byte(body), &o); err != nil {
		t.Fatal(err)
	}
	return &o
}

func TestRepositoryAgentMetricsExportCatalogHealth(t *testing.T) {
	now, _ := time.Parse(time.RFC3339, "2026-11-18T10:01:00Z")
	m := newRepositoryAgentMetrics()
	if !strings.Contains(repositoryAgentScrape(t, m), "lcars_repository_agents_read_available 0\n") {
		t.Fatal("an unobserved catalog must read unavailable, not healthy")
	}
	if !m.record(repositoryAgentObservationFrom(t, repositoryAgentFixture), now) {
		t.Fatal("valid observation refused")
	}
	scrape := repositoryAgentScrape(t, m)
	for _, want := range []string{
		"lcars_repository_agents_read_available 1\n",
		"lcars_repository_agents_observed_timestamp_seconds 1.794996e+09\n",
		`lcars_repository_agents{state="enabled"} 2` + "\n",
		`lcars_repository_agents{state="invalid"} 1` + "\n",
		`lcars_repository_agent_source_last_failure_timestamp_seconds{repository="jlapenna/agent-lcars"} 1.79499588e+09` + "\n",
		`lcars_repository_agent_source_last_failure_timestamp_seconds{repository="jlapenna/homelab"} 0` + "\n",
		`lcars_repository_agent_source_last_success_timestamp_seconds{repository="jlapenna/homelab"} 1.79499594e+09` + "\n",
	} {
		if !strings.Contains(scrape, want) {
			t.Errorf("scrape lacks %q:\n%s", want, scrape)
		}
	}

	// A failed read keeps the last snapshot (with its own timestamp) but
	// clears read_available.
	if m.record(nil, now) {
		t.Fatal("missing observation accepted")
	}
	scrape = repositoryAgentScrape(t, m)
	if !strings.Contains(scrape, "lcars_repository_agents_read_available 0\n") || !strings.Contains(scrape, `lcars_repository_agents{state="enabled"} 2`) {
		t.Fatalf("stale snapshot handling wrong:\n%s", scrape)
	}
}

func TestRepositoryAgentMetricsRejectMalformedObservations(t *testing.T) {
	now, _ := time.Parse(time.RFC3339, "2026-11-18T10:01:00Z")
	for name, body := range map[string]string{
		"future":       strings.Replace(repositoryAgentFixture, `"observedAt":"2026-11-18T10:00:00Z"`, `"observedAt":"2026-11-19T10:00:00Z"`, 1),
		"version":      strings.Replace(repositoryAgentFixture, `"version":1`, `"version":2`, 1),
		"missingCount": strings.Replace(repositoryAgentFixture, `"removed":0`, `"other":0`, 1),
		"badRepo":      strings.Replace(repositoryAgentFixture, `jlapenna/homelab`, `https://github.com/x`, 1),
		"duplicate":    strings.Replace(repositoryAgentFixture, `jlapenna/agent-lcars`, `jlapenna/homelab`, 1),
		"badTime":      strings.Replace(repositoryAgentFixture, `"failedAt":"2026-11-18T09:58:00Z"`, `"failedAt":"yesterday"`, 1),
	} {
		if newRepositoryAgentMetrics().record(repositoryAgentObservationFrom(t, body), now) {
			t.Errorf("%s: malformed observation accepted", name)
		}
	}
}

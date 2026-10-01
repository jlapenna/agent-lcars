package main

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// defaultReadinessMetric is used when fleet.hosts[].readiness_url is set but
// readiness_metric is not (see FleetHostConfig.ReadinessMetric).
const defaultReadinessMetric = "host_ready"

// hostReadinessFetchTimeout bounds each per-launch readiness probe. It must
// fail fast rather than stall a claim: the same "a black-holing host must not
// hang the caller" reasoning newDockerClient's ConnectTimeout=10s applies to
// an SSH Docker target, scaled down for a plain HTTP GET against a textfile
// endpoint that should answer immediately.
const hostReadinessFetchTimeout = 3 * time.Second

// hostReadinessConfig is one host's optional per-launch readiness gate,
// resolved from fleet.hosts[].readiness_url/readiness_metric by
// orchestrator_config.go's resolve(). A host with no entry in
// resolvedOrchestratorConfig.Readiness has no gate and is always eligible --
// today's behavior, unchanged for every deployment that does not set
// readiness_url.
type hostReadinessConfig struct {
	url    string
	metric string
}

// fetchHostReadiness fetches cfg.url -- a Prometheus-exposition HTTP endpoint,
// e.g. a node-exporter textfile collector -- and reports whether cfg.metric is
// present there with value exactly 1. It knows nothing about what produces
// that metric (Tailscale LAN presence, mains power, or anything else): that
// is deployment knowledge that belongs to whatever publishes readiness_url,
// never to this binary (AGENTS.md's cross-repository independence rule). A
// nil client defaults to one scoped to hostReadinessFetchTimeout.
func fetchHostReadiness(ctx context.Context, client *http.Client, cfg hostReadinessConfig) (bool, error) {
	if client == nil {
		client = &http.Client{Timeout: hostReadinessFetchTimeout}
	}
	fetchCtx, cancel := context.WithTimeout(ctx, hostReadinessFetchTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(fetchCtx, http.MethodGet, cfg.url, nil)
	if err != nil {
		return false, fmt.Errorf("building readiness request: %w", err)
	}
	resp, err := client.Do(req)
	if err != nil {
		return false, fmt.Errorf("fetching readiness metrics: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return false, fmt.Errorf("readiness endpoint returned status %d", resp.StatusCode)
	}
	value, found, err := parsePrometheusMetricValue(resp.Body, cfg.metric)
	if err != nil {
		return false, fmt.Errorf("parsing readiness metrics: %w", err)
	}
	if !found {
		return false, fmt.Errorf("readiness metric %q not present", cfg.metric)
	}
	return value == 1, nil
}

// parsePrometheusMetricValue does a minimal, label-blind scan of a
// Prometheus text-exposition body for the first sample of the given metric
// name. Label values are never matched or required: this design's per-host
// distinction comes entirely from each host having its own readiness_url
// (see FleetHostConfig.ReadinessURL), not from a label inside the response
// body, so a bare `metric_name 1` line is exactly as valid as one carrying
// labels.
func parsePrometheusMetricValue(body io.Reader, metric string) (value float64, found bool, err error) {
	scanner := bufio.NewScanner(body)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		name, rest, ok := splitPrometheusSample(line)
		if !ok || name != metric {
			continue
		}
		fields := strings.Fields(rest)
		if len(fields) == 0 {
			continue
		}
		v, parseErr := strconv.ParseFloat(fields[0], 64)
		if parseErr != nil {
			continue
		}
		return v, true, nil
	}
	if scanErr := scanner.Err(); scanErr != nil {
		return 0, false, scanErr
	}
	return 0, false, nil
}

// splitPrometheusSample splits one exposition line into its metric name and
// everything after it (the value, and an optional trailing timestamp).
// Naively splitting the whole line on whitespace (as an earlier version of
// this function did) misparses a labeled sample whose label VALUE itself
// contains a space followed by a token that looks like "1": a quoted value
// like `reason="on 1 battery"` would make `host_ready{reason="on 1
// battery"} 0` falsely report ready, since the second field of the whole
// line is "1", not the real value "0" after the closing brace. Finding the
// LAST '}' on the line and treating everything after it as the value fixes
// that: a label value is vanishingly unlikely to itself contain an
// unescaped '}', and even a line with no labels at all still works, since
// braceIdx is then -1 and this falls back to splitting on the first
// whitespace run.
func splitPrometheusSample(line string) (name, rest string, ok bool) {
	braceIdx := strings.IndexByte(line, '{')
	spaceIdx := strings.IndexAny(line, " \t")
	if braceIdx < 0 || (spaceIdx >= 0 && spaceIdx < braceIdx) {
		if spaceIdx < 0 {
			return "", "", false
		}
		return line[:spaceIdx], line[spaceIdx+1:], true
	}
	closeIdx := strings.LastIndexByte(line, '}')
	if closeIdx < braceIdx {
		return "", "", false
	}
	return line[:braceIdx], line[closeIdx+1:], true
}

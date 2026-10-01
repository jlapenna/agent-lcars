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
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		name := fields[0]
		if idx := strings.IndexByte(name, '{'); idx >= 0 {
			name = name[:idx]
		}
		if name != metric {
			continue
		}
		v, parseErr := strconv.ParseFloat(fields[1], 64)
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

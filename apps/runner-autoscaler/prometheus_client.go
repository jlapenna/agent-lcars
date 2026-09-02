package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"
)

// prometheusInstantQueryTimeout bounds every rung-2 Prometheus lookup
// (agent-lcars#1697, docs/fleet-scheduler-redesign.md#D): the ladder must
// never block a placement decision on Prometheus being slow or down, so
// every query this client issues carries this deadline regardless of the
// caller's own context.
const prometheusInstantQueryTimeout = 5 * time.Second

// prometheusClient issues read-only instant queries against a Prometheus
// server's HTTP API. It exists so the degradation ladder's rung 2 (observed
// p95 memory) can be refreshed on a timer, independent of placement itself,
// and so that refresh is unit-testable against an httptest server rather
// than a real Prometheus.
type prometheusClient struct {
	baseURL    string
	httpClient *http.Client
	// timeout is prometheusInstantQueryTimeout in production; tests inject a
	// much shorter value via newPrometheusClientWithTimeout so a deliberately
	// slow httptest handler doesn't make the suite wait out the real 5s.
	timeout time.Duration
}

// newPrometheusClient builds a client against baseURL (e.g.
// "http://prometheus:9090", no trailing slash required), applying
// prometheusInstantQueryTimeout to every query.
func newPrometheusClient(baseURL string) *prometheusClient {
	return newPrometheusClientWithTimeout(baseURL, prometheusInstantQueryTimeout)
}

// newPrometheusClientWithTimeout is newPrometheusClient with an injectable
// per-query timeout, for tests that need to exercise the timeout path
// quickly rather than waiting out the real production deadline.
func newPrometheusClientWithTimeout(baseURL string, timeout time.Duration) *prometheusClient {
	return &prometheusClient{baseURL: baseURL, httpClient: http.DefaultClient, timeout: timeout}
}

// prometheusQueryResponse is the subset of Prometheus's
// /api/v1/query response shape this client consumes. See
// https://prometheus.io/docs/prometheus/latest/querying/api/#instant-queries.
type prometheusQueryResponse struct {
	Status string `json:"status"`
	Error  string `json:"error"`
	Data   struct {
		ResultType string `json:"resultType"`
		Result     []struct {
			Value [2]any `json:"value"`
		} `json:"result"`
	} `json:"data"`
}

// InstantQuery evaluates query against Prometheus's instant-query endpoint
// and returns the single scalar/vector value it resolves to. It always
// applies prometheusInstantQueryTimeout on top of ctx, so a caller's own
// (longer) deadline can never let one slow query stall a refresh pass.
//
// An empty result vector (the query matched no series -- e.g. a scale set
// with no runner history yet) is an error, not a zero value: rung 2 treats
// "no sample" and "a sample of zero" differently, and conflating them would
// let a brand-new lane with no data silently admit at an observed p95 of 0.
func (c *prometheusClient) InstantQuery(ctx context.Context, query string) (float64, error) {
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+"/api/v1/query", nil)
	if err != nil {
		return 0, fmt.Errorf("building prometheus query request: %w", err)
	}
	q := req.URL.Query()
	q.Set("query", query)
	req.URL.RawQuery = q.Encode()

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return 0, fmt.Errorf("querying prometheus: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return 0, fmt.Errorf("reading prometheus response: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return 0, fmt.Errorf("prometheus query returned status %d: %s", resp.StatusCode, string(body))
	}

	var parsed prometheusQueryResponse
	if err := json.Unmarshal(body, &parsed); err != nil {
		return 0, fmt.Errorf("decoding prometheus response: %w", err)
	}
	if parsed.Status != "success" {
		if parsed.Error != "" {
			return 0, fmt.Errorf("prometheus query failed: %s", parsed.Error)
		}
		return 0, fmt.Errorf("prometheus query returned status %q", parsed.Status)
	}
	if len(parsed.Data.Result) == 0 {
		return 0, fmt.Errorf("prometheus query %q returned no samples", query)
	}
	// value[0] is the sample's unix timestamp (a float64); value[1] is the
	// sample's value, encoded as a JSON string per the API's own
	// convention (it preserves precision that a bare JSON number cannot).
	raw, ok := parsed.Data.Result[0].Value[1].(string)
	if !ok {
		return 0, fmt.Errorf("prometheus query %q returned a non-string sample value", query)
	}
	value, err := strconv.ParseFloat(raw, 64)
	if err != nil {
		return 0, fmt.Errorf("parsing prometheus sample value %q: %w", raw, err)
	}
	return value, nil
}

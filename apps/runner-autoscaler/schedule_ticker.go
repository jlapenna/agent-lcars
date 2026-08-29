package main

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"
)

// scheduleTickInterval keeps the native schedule cadence independent of
// GitHub's best-effort scheduler. The Work API determines whether a slot is
// due and mints deterministic item ids, so an autoscaler restart or a second
// healthy autoscaler can safely call it again.
const scheduleTickInterval = 5 * time.Minute

// scheduleTickResponseBodyLimit prevents an unexpected proxy or server
// response from making the daemon retain unbounded error data. Successful
// responses are intentionally not interpreted here: the Work API owns all
// schedule state and is the sole authority for tick results.
const scheduleTickResponseBodyLimit = 64 << 10

// scheduleTickerConfig is deliberately narrower than queueExecutorConfig:
// ticking schedules only needs the existing Work API URL and its Google ID
// token path. It neither claims a run nor knows any provider or repository.
type scheduleTickerConfig struct {
	consoleURL string
	httpClient *http.Client
	idToken    func() (string, error)
}

// tickSchedulesOnce invokes the one server-owned schedule ingress route. The
// caller must hold work.cron; work.executor alone is intentionally rejected by
// the API, keeping the daemon's schedule authority separate from its ability
// to claim queued runs.
func tickSchedulesOnce(cfg scheduleTickerConfig) error {
	client := cfg.httpClient
	if client == nil {
		client = &http.Client{Timeout: 60 * time.Second}
	}
	token, err := cfg.idToken()
	if err != nil {
		return fmt.Errorf("minting schedule tick id token: %w", err)
	}
	req, err := http.NewRequest(
		http.MethodPost,
		strings.TrimRight(cfg.consoleURL, "/")+"/api/work/v1/schedules/tick",
		bytes.NewReader([]byte("{}")),
	)
	if err != nil {
		return fmt.Errorf("building schedule tick request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("schedule tick request: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusOK {
		return nil
	}
	body, readErr := io.ReadAll(io.LimitReader(resp.Body, scheduleTickResponseBodyLimit))
	if readErr != nil {
		return fmt.Errorf("reading schedule tick error response: %w", readErr)
	}
	return fmt.Errorf("schedule tick returned %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
}

// runScheduleTicker makes one tick at startup to recover the latest due slot
// after a daemon restart, then continues at the documented five-minute
// cadence. Errors are level-triggered: a transient failure never stops later
// ticks, and the bounded metric makes the failure visible to the operations
// consumer.
func runScheduleTicker(ctx context.Context, cfg scheduleTickerConfig, logger *slog.Logger) {
	tick := func() {
		if err := tickSchedulesOnce(cfg); err != nil {
			recordScheduleTick(false)
			logger.Warn("schedule tick failed", slog.String("error", err.Error()))
			return
		}
		recordScheduleTick(true)
	}
	tick()
	ticker := time.NewTicker(scheduleTickInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			tick()
		}
	}
}

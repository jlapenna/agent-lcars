package main

import (
	"bytes"
	"context"
	"encoding/json"
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
// response from making the daemon retain unbounded error data. The ticker
// reads the same bounded envelope for every status: a 200 can still carry
// one or more per-schedule failures that need operations attention.
const scheduleTickResponseBodyLimit = 64 << 10

// scheduleTickFailureDetailsLimit bounds the structured failure evidence the
// daemon returns to its logger. It is independent from the response cap so a
// response containing many small per-schedule errors cannot make one ticker
// log entry disproportionately large.
const scheduleTickFailureDetailsLimit = 4 << 10

// scheduleTickResponse is deliberately only the part of the Work API reply
// the daemon needs to classify a tick. Schedule state stays owned by the API;
// this is not a local schedule model or a provider/repository policy.
type scheduleTickResponse struct {
	Errors *[]scheduleTickFailure `json:"errors"`
}

type scheduleTickFailure struct {
	ScheduleID string `json:"scheduleId"`
	Message    string `json:"message"`
}

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
	body, err := readBoundedScheduleTickResponse(resp.Body)
	if err != nil {
		return fmt.Errorf("reading schedule tick response: %w", err)
	}
	if resp.StatusCode == http.StatusOK {
		result, err := parseScheduleTickResponse(body)
		if err != nil {
			return err
		}
		if len(*result.Errors) > 0 {
			return fmt.Errorf(
				"schedule tick completed with %d per-schedule errors: %s",
				len(*result.Errors),
				scheduleTickFailureDetails(*result.Errors),
			)
		}
		return nil
	}
	return fmt.Errorf("schedule tick returned %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
}

func readBoundedScheduleTickResponse(body io.Reader) ([]byte, error) {
	response, err := io.ReadAll(io.LimitReader(body, scheduleTickResponseBodyLimit+1))
	if err != nil {
		return nil, err
	}
	if len(response) > scheduleTickResponseBodyLimit {
		return nil, fmt.Errorf("response exceeds %d-byte limit", scheduleTickResponseBodyLimit)
	}
	return response, nil
}

func parseScheduleTickResponse(body []byte) (scheduleTickResponse, error) {
	var result scheduleTickResponse
	if err := json.Unmarshal(body, &result); err != nil {
		return scheduleTickResponse{}, fmt.Errorf("decoding schedule tick response: %w", err)
	}
	if result.Errors == nil {
		return scheduleTickResponse{}, fmt.Errorf("decoding schedule tick response: missing errors array")
	}
	return result, nil
}

func scheduleTickFailureDetails(failures []scheduleTickFailure) string {
	var details strings.Builder
	for i, failure := range failures {
		if i > 0 {
			details.WriteString("; ")
		}
		entry := fmt.Sprintf("scheduleId=%q message=%q", failure.ScheduleID, failure.Message)
		remaining := scheduleTickFailureDetailsLimit - details.Len()
		if remaining <= 0 {
			break
		}
		if len(entry) > remaining {
			details.WriteString(entry[:remaining])
			break
		}
		details.WriteString(entry)
	}
	return details.String()
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

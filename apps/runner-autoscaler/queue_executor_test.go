package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus/testutil"
)

// discardLogger matches this package's own test convention
// (slog.New(slog.NewTextHandler(io.Discard, nil)), see checkpoint_test.go)
// for a logger tests don't care to inspect.
// reserveFor is a capacity reservation that always has room and launches
// through launch, for tests that exercise the claim protocol rather than a
// backend's capacity accounting.
func reserveFor(launch func(directRunnerLaunch) error) func() (*directRunnerReservation, error) {
	return func() (*directRunnerReservation, error) {
		return &directRunnerReservation{release: func() {}, launch: launch}, nil
	}
}

func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func TestPollOnceClaimsAndLaunches(t *testing.T) {
	var gotBody map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/work/v1/runs/claim" {
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"runId":     "work:01QUEUEEXECUTORTESTFIX01/r1",
			"workId":    "01QUEUEEXECUTORTESTFIX01",
			"pipeline":  "claude",
			"token":     "test-token",
			"expiresAt": "2026-08-27T01:00:00.000Z",
		})
	}))
	defer server.Close()

	var launched []directRunnerLaunch
	cfg := queueExecutorConfig{
		consoleURL: server.URL,
		runnerName: "test-runner",
		idToken:    func() (string, error) { return "fake-id-token", nil },
		reserve: reserveFor(func(l directRunnerLaunch) error {
			launched = append(launched, l)
			return nil
		}),
	}
	if err := pollOnce(cfg); err != nil {
		t.Fatalf("pollOnce: %v", err)
	}
	if len(launched) != 1 {
		t.Fatalf("expected one launch, got %d", len(launched))
	}
	if launched[0].runID != "work:01QUEUEEXECUTORTESTFIX01/r1" || launched[0].runToken != "test-token" {
		t.Fatalf("unexpected launch: %+v", launched[0])
	}
	if launched[0].pipeline != "claude" {
		t.Fatalf("expected pipeline %q, got %+v", "claude", launched[0])
	}
	if launched[0].consoleURL != server.URL {
		t.Fatalf("expected consoleURL %q to be threaded through to the launch, got %+v", server.URL, launched[0])
	}
	if gotBody["runner"] != "test-runner" {
		t.Fatalf("expected runner in claim body, got %v", gotBody)
	}
	// The exit report must repeat the claim's runner name, so the launch
	// carries the exact name the claim body sent.
	if launched[0].runner != "test-runner" {
		t.Fatalf("expected the claim's runner name on the launch, got %+v", launched[0])
	}
}

func TestTickSchedulesOnceUsesWorkAPIAndGoogleBearer(t *testing.T) {
	var gotMethod, gotPath, gotBearer, gotContentType string
	var gotBody []byte
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod = r.Method
		gotPath = r.URL.Path
		gotBearer = r.Header.Get("Authorization")
		gotContentType = r.Header.Get("Content-Type")
		gotBody, _ = io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ticked":0,"minted":[],"errors":[]}`))
	}))
	defer server.Close()

	err := tickSchedulesOnce(scheduleTickerConfig{
		consoleURL: server.URL + "/",
		idToken:    func() (string, error) { return "google-id-token", nil },
	})
	if err != nil {
		t.Fatalf("tickSchedulesOnce: %v", err)
	}
	if gotMethod != http.MethodPost || gotPath != "/api/work/v1/schedules/tick" {
		t.Fatalf("request = %s %s, want POST /api/work/v1/schedules/tick", gotMethod, gotPath)
	}
	if gotBearer != "Bearer google-id-token" {
		t.Fatalf("Authorization = %q", gotBearer)
	}
	if gotContentType != "application/json" || string(gotBody) != "{}" {
		t.Fatalf("request body/content type = %q/%q, want application/json/{}", gotContentType, gotBody)
	}
}

func TestTickMaintenanceOnceUsesWorkAPIAndGoogleBearer(t *testing.T) {
	var gotPath, gotBearer string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotBearer = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"lost":[],"retried":[],"dispatched":[],"reported":[],"outboxProcessed":0,"outboxContinuationNeeded":false}`))
	}))
	defer server.Close()

	err := tickMaintenanceOnce(scheduleTickerConfig{
		consoleURL: server.URL,
		idToken:    func() (string, error) { return "google-id-token", nil },
	})
	if err != nil {
		t.Fatalf("tickMaintenanceOnce: %v", err)
	}
	if gotPath != "/api/work/v1/maintenance/tick" || gotBearer != "Bearer google-id-token" {
		t.Fatalf("request path/bearer = %q/%q", gotPath, gotBearer)
	}
}

func TestTickMaintenanceOnceReportsOutboxFailures(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"lost":[],"retried":[],"dispatched":[],"reported":[],"outboxProcessed":1,"outboxContinuationNeeded":true,"outboxDrainFailed":[{"entryId":"dispatch/run-1","error":"unavailable"}]}`))
	}))
	defer server.Close()
	err := tickMaintenanceOnce(scheduleTickerConfig{
		consoleURL: server.URL,
		idToken:    func() (string, error) { return "token", nil },
	})
	if err == nil || !strings.Contains(err.Error(), "1 outbox failures") {
		t.Fatalf("tickMaintenanceOnce error = %v", err)
	}
}

func TestTickSchedulesOnceReportsNonSuccess(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte("work.cron scope required"))
	}))
	defer server.Close()

	err := tickSchedulesOnce(scheduleTickerConfig{
		consoleURL: server.URL,
		idToken:    func() (string, error) { return "google-id-token", nil },
	})
	if err == nil || !strings.Contains(err.Error(), "401") || !strings.Contains(err.Error(), "work.cron") {
		t.Fatalf("tickSchedulesOnce error = %v, want bounded unauthorized diagnostic", err)
	}
}

func TestTickSchedulesOnceReportsPartialScheduleFailures(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ticked":2,"minted":[],"errors":[{"scheduleId":"01J5Z3K9QX8F0N2B4V6C8D1E3G","message":"store unavailable"}]}`))
	}))
	defer server.Close()

	err := tickSchedulesOnce(scheduleTickerConfig{
		consoleURL: server.URL,
		idToken:    func() (string, error) { return "google-id-token", nil },
	})
	if err == nil ||
		!strings.Contains(err.Error(), "1 per-schedule errors") ||
		!strings.Contains(err.Error(), "01J5Z3K9QX8F0N2B4V6C8D1E3G") ||
		!strings.Contains(err.Error(), "store unavailable") {
		t.Fatalf("tickSchedulesOnce error = %v, want partial schedule failure", err)
	}
}

func TestTickSchedulesOnceRejectsMalformedOrOversizedSuccessResponse(t *testing.T) {
	cases := []struct {
		name string
		body string
		want string
	}{
		{
			name: "malformed JSON",
			body: `{"errors":`,
			want: "decoding schedule tick response",
		},
		{
			name: "missing errors array",
			body: `{"ticked":0}`,
			want: "missing errors array",
		},
		{
			name: "oversized response",
			body: `{"errors":[],"padding":"` + strings.Repeat("x", scheduleTickResponseBodyLimit) + `"}`,
			want: "exceeds",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(tc.body))
			}))
			defer server.Close()

			err := tickSchedulesOnce(scheduleTickerConfig{
				consoleURL: server.URL,
				idToken:    func() (string, error) { return "google-id-token", nil },
			})
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("tickSchedulesOnce error = %v, want %q", err, tc.want)
			}
		})
	}
}

func TestScheduleTickMetricsExposeSuccessAndError(t *testing.T) {
	success := testutil.ToFloat64(scheduleTicksTotal.WithLabelValues("success"))
	failure := testutil.ToFloat64(scheduleTicksTotal.WithLabelValues("error"))
	recordScheduleTick(true)
	recordScheduleTick(false)
	if got := testutil.ToFloat64(scheduleTicksTotal.WithLabelValues("success")); got != success+1 {
		t.Fatalf("schedule tick success metric = %v, want %v", got, success+1)
	}
	if got := testutil.ToFloat64(scheduleTicksTotal.WithLabelValues("error")); got != failure+1 {
		t.Fatalf("schedule tick error metric = %v, want %v", got, failure+1)
	}
}

func TestMaintenanceTickMetricsExposeSuccessErrorAndFreshness(t *testing.T) {
	success := testutil.ToFloat64(maintenanceTicksTotal.WithLabelValues("success"))
	failure := testutil.ToFloat64(maintenanceTicksTotal.WithLabelValues("error"))
	recordMaintenanceTick(true)
	recordMaintenanceTick(false)
	if got := testutil.ToFloat64(maintenanceTicksTotal.WithLabelValues("success")); got != success+1 {
		t.Fatalf("maintenance tick success metric = %v, want %v", got, success+1)
	}
	if got := testutil.ToFloat64(maintenanceTicksTotal.WithLabelValues("error")); got != failure+1 {
		t.Fatalf("maintenance tick error metric = %v, want %v", got, failure+1)
	}
	if got := testutil.ToFloat64(maintenanceLastSuccessTimestamp); got <= 0 {
		t.Fatalf("maintenance last success timestamp = %v, want positive", got)
	}
}

// TestPollOnceNoQueuedRunLaunchesNothing covers both shapes the console
// answers "nothing queued for these pipelines" with: a 200 with an empty
// body (what it actually sends today) and a bare 204 (still tolerated, in
// case that ever changes back).
func TestPollOnceNoQueuedRunLaunchesNothing(t *testing.T) {
	cases := []struct {
		name   string
		status int
	}{
		{"200 with an empty body", http.StatusOK},
		{"204", http.StatusNoContent},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(tc.status)
			}))
			defer server.Close()

			launchCount := 0
			cfg := queueExecutorConfig{
				consoleURL: server.URL,
				runnerName: "test-runner",
				idToken:    func() (string, error) { return "fake-id-token", nil },
				reserve:    reserveFor(func(directRunnerLaunch) error { launchCount++; return nil }),
			}
			if err := pollOnce(cfg); err != nil {
				t.Fatalf("pollOnce: %v", err)
			}
			if launchCount != 0 {
				t.Fatalf("expected no launch, got %d", launchCount)
			}
		})
	}
}

func TestPollOnceWithOutcomeDistinguishesIdleClaimAndLaunchFailure(t *testing.T) {
	cases := []struct {
		name        string
		status      int
		body        string
		launchErr   error
		draining    bool
		wantOutcome queuePollOutcome
		wantErr     bool
	}{
		{name: "draining", draining: true, wantOutcome: queuePollOutcomeDraining},
		{name: "idle 204", status: http.StatusNoContent, wantOutcome: queuePollOutcomeIdle204},
		{name: "idle empty", status: http.StatusOK, wantOutcome: queuePollOutcomeIdleEmpty},
		{name: "poll error", status: http.StatusUnauthorized, wantOutcome: queuePollOutcomePollError, wantErr: true},
		{name: "claimed and launched", status: http.StatusOK, body: `{"runId":"work:01QUEUEOUTCOME/r1","token":"token","pipeline":"claude"}`, wantOutcome: queuePollOutcomeClaimed},
		{name: "claimed launch error", status: http.StatusOK, body: `{"runId":"work:01QUEUEOUTCOME/r1","token":"token","pipeline":"claude"}`, launchErr: errors.New("job create failed"), wantOutcome: queuePollOutcomeLaunchErr, wantErr: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(tc.body))
			}))
			defer server.Close()

			outcome, err := pollOnceWithOutcome(queueExecutorConfig{
				consoleURL: server.URL,
				runnerName: "test-runner",
				idToken:    func() (string, error) { return "fake-id-token", nil },
				reserve:    reserveFor(func(directRunnerLaunch) error { return tc.launchErr }),
				draining: func() bool {
					return tc.draining
				},
			})
			if outcome != tc.wantOutcome {
				t.Errorf("outcome = %q, want %q", outcome, tc.wantOutcome)
			}
			if (err != nil) != tc.wantErr {
				t.Errorf("err = %v, want error=%v", err, tc.wantErr)
			}
			if tc.draining && calls != 0 {
				t.Errorf("draining poll made %d HTTP calls, want 0", calls)
			}
		})
	}
}

func TestQueueExecutorMetricsExposeReadinessAndPollOutcomes(t *testing.T) {
	setQueueExecutorStartupState(queueExecutorStateMisconfigured)
	if got := testutil.ToFloat64(queueExecutorReadyGauge); got != 0 {
		t.Fatalf("queue readiness while misconfigured = %v, want 0", got)
	}
	if got := testutil.ToFloat64(queueExecutorStateGauge.WithLabelValues(string(queueExecutorStateMisconfigured))); got != 1 {
		t.Fatalf("misconfigured state gauge = %v, want 1", got)
	}
	setQueueExecutorStartupState(queueExecutorStateReady)
	if got := testutil.ToFloat64(queueExecutorReadyGauge); got != 1 {
		t.Fatalf("queue readiness while ready = %v, want 1", got)
	}

	for _, outcome := range []queuePollOutcome{
		queuePollOutcomeIdle204,
		queuePollOutcomeIdleEmpty,
		queuePollOutcomePollError,
		queuePollOutcomeClaimed,
		queuePollOutcomeLaunchErr,
	} {
		var counter float64
		switch outcome {
		case queuePollOutcomeClaimed:
			counter = testutil.ToFloat64(queueExecutorLaunchesTotal.WithLabelValues("success"))
		case queuePollOutcomeLaunchErr:
			counter = testutil.ToFloat64(queueExecutorLaunchesTotal.WithLabelValues("error"))
		default:
			counter = testutil.ToFloat64(queueExecutorPollsTotal.WithLabelValues(string(outcome)))
		}
		recordQueueExecutorPollOutcome(outcome)
		var got float64
		switch outcome {
		case queuePollOutcomeClaimed:
			got = testutil.ToFloat64(queueExecutorLaunchesTotal.WithLabelValues("success"))
		case queuePollOutcomeLaunchErr:
			got = testutil.ToFloat64(queueExecutorLaunchesTotal.WithLabelValues("error"))
		default:
			got = testutil.ToFloat64(queueExecutorPollsTotal.WithLabelValues(string(outcome)))
		}
		if got != counter+1 {
			t.Errorf("metric for %q = %v, want %v", outcome, got, counter+1)
		}
	}
}

// TestPollOnceMissingRequiredFieldsLaunchesNothing proves a 200 that
// decodes fine but is missing runId/token (e.g. a stray `{}`, or a future
// console bug) is treated the same as "nothing queued" -- pollOnce must
// never hand launch() a directRunnerLaunch with an empty run id or token.
func TestPollOnceMissingRequiredFieldsLaunchesNothing(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{}`))
	}))
	defer server.Close()

	launchCount := 0
	cfg := queueExecutorConfig{
		consoleURL: server.URL,
		runnerName: "test-runner",
		idToken:    func() (string, error) { return "fake-id-token", nil },
		reserve:    reserveFor(func(directRunnerLaunch) error { launchCount++; return nil }),
	}
	if err := pollOnce(cfg); err != nil {
		t.Fatalf("pollOnce: %v", err)
	}
	if launchCount != 0 {
		t.Fatalf("expected no launch for a claim response missing runId/token, got %d", launchCount)
	}
}

// TestPollOnceDrainingSkipsClaim proves pollOnce short-circuits before ever
// making the claim HTTP call while cfg.draining reports true -- the
// SIGUSR1-drain gate (Task's final-review fix). A nil draining (every
// other test in this file) must keep behaving exactly as before; see those
// tests for that coverage.
func TestPollOnceDrainingSkipsClaim(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	launchCount := 0
	cfg := queueExecutorConfig{
		consoleURL: server.URL,
		runnerName: "test-runner",
		idToken:    func() (string, error) { return "fake-id-token", nil },
		reserve:    reserveFor(func(directRunnerLaunch) error { launchCount++; return nil }),
		draining:   func() bool { return true },
	}
	if err := pollOnce(cfg); err != nil {
		t.Fatalf("pollOnce: %v", err)
	}
	if calls != 0 {
		t.Fatalf("expected pollOnce to skip the claim request entirely while draining, got %d calls", calls)
	}
	if launchCount != 0 {
		t.Fatalf("expected no launch while draining, got %d", launchCount)
	}
}

// TestPollOnceUnauthorizedIsError covers a claim call the console rejects
// (e.g. an expired or malformed ID token): pollOnce must report the failure
// rather than silently treating it as "nothing queued", and must never
// launch anything on the strength of a rejected claim.
func TestPollOnceUnauthorizedIsError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer server.Close()

	launchCount := 0
	cfg := queueExecutorConfig{
		consoleURL: server.URL,
		runnerName: "test-runner",
		idToken:    func() (string, error) { return "fake-id-token", nil },
		reserve:    reserveFor(func(directRunnerLaunch) error { launchCount++; return nil }),
	}
	err := pollOnce(cfg)
	if err == nil {
		t.Fatalf("expected an error for a 401 claim response")
	}
	if !strings.Contains(err.Error(), "401") {
		t.Errorf("expected the error to mention the 401 status, got %q", err.Error())
	}
	if launchCount != 0 {
		t.Fatalf("expected no launch on 401, got %d", launchCount)
	}
}

// TestPollOnceClaimRequestBodyShape pins the claim request body's shape
// (runner only). The server derives claimable pipelines from the authenticated
// work.executor grant, so a poller cannot supply a competing local allowlist.
// It also guards against a token field: there is none to leak yet at claim
// time, but threading a stale token through would violate its boundary.
func TestPollOnceClaimRequestBodyShape(t *testing.T) {
	var gotBody map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	cfg := queueExecutorConfig{
		consoleURL: server.URL,
		runnerName: "runner-a",
		idToken:    func() (string, error) { return "fake-id-token", nil },
		reserve:    reserveFor(func(directRunnerLaunch) error { return nil }),
	}
	if err := pollOnce(cfg); err != nil {
		t.Fatalf("pollOnce: %v", err)
	}
	if gotBody["runner"] != "runner-a" {
		t.Fatalf("expected runner %q, got %v", "runner-a", gotBody)
	}
	if _, supplied := gotBody["pipelines"]; supplied {
		t.Fatalf("claim request body must not supply pipelines, got %v", gotBody)
	}
	if _, leaked := gotBody["token"]; leaked {
		t.Fatalf("claim request body must never carry a run token, got %v", gotBody)
	}
}

// TestPollOnceClaimResponseTooLargeIsError proves pollOnce bounds how much
// of a claim response it will decode (claimResponseBodyLimit): a response
// whose JSON object cannot close within that bound must error out rather
// than launch on a partially-decoded value. The oversized field lives
// INSIDE the JSON object (not as harmless trailing padding after a
// complete, valid object) so truncating at the limit actually breaks
// decoding -- json.Decoder.Decode stops after one complete value and
// ignores anything after it, so padding appended past a complete object
// would prove nothing here.
func TestPollOnceClaimResponseTooLargeIsError(t *testing.T) {
	hugeWorkID := strings.Repeat("x", claimResponseBodyLimit+1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"runId":     "work:01QUEUEEXECUTORTESTFIX05/r1",
			"workId":    hugeWorkID,
			"pipeline":  "claude",
			"token":     "test-token",
			"expiresAt": "2026-08-27T01:00:00.000Z",
		})
	}))
	defer server.Close()

	launchCount := 0
	cfg := queueExecutorConfig{
		consoleURL: server.URL,
		runnerName: "test-runner",
		idToken:    func() (string, error) { return "fake-id-token", nil },
		reserve:    reserveFor(func(directRunnerLaunch) error { launchCount++; return nil }),
	}
	err := pollOnce(cfg)
	if err == nil {
		t.Fatalf("expected an error for a claim response over claimResponseBodyLimit")
	}
	if launchCount != 0 {
		t.Fatalf("expected no launch for an oversized claim response, got %d", launchCount)
	}
}

func TestDirectRunnerImage(t *testing.T) {
	t.Run("required", func(t *testing.T) {
		t.Setenv("LCARS_QUEUE_RUNNER_IMAGE", "")
		if _, err := directRunnerImage(); err == nil {
			t.Fatalf("expected an error when LCARS_QUEUE_RUNNER_IMAGE is unset")
		}
	})
	t.Run("passes through a configured image", func(t *testing.T) {
		t.Setenv("LCARS_QUEUE_RUNNER_IMAGE", "docker-registry.lan.jlapenna.net/homelab-runner:jit-node24")
		got, err := directRunnerImage()
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got != "docker-registry.lan.jlapenna.net/homelab-runner:jit-node24" {
			t.Errorf("got %q", got)
		}
	})
}

func TestQueueExecutorStartupStatusDistinguishesDisabledFromMisconfigured(t *testing.T) {
	cases := []struct {
		name       string
		consoleURL string
		keyPath    string
		wantStart  bool
		wantState  queueExecutorStartupState
	}{
		{"no queue deployment", "", "/run/writer.json", false, queueExecutorStateDisabled},
		{"incomplete queue deployment", "https://lcars.example", "", false, queueExecutorStateMisconfigured},
		{"ready", "https://lcars.example", "/run/writer.json", true, queueExecutorStateReady},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			start, state, _ := queueExecutorStartupStatus(tc.consoleURL, tc.keyPath)
			if start != tc.wantStart || state != tc.wantState {
				t.Fatalf("queueExecutorStartupStatus() = (%v, %q), want (%v, %q)", start, state, tc.wantStart, tc.wantState)
			}
		})
	}
}

// TestQueueExecutorAudience pins LCARS_WORK_AUDIENCE's default, matching
// the console's own AGENT_LCARS_WORK_AUDIENCE fallback (route.ts).
func TestQueueExecutorAudience(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want string
	}{
		{"unset defaults to agent-lcars-work", "", "agent-lcars-work"},
		{"whitespace only defaults to agent-lcars-work", "   ", "agent-lcars-work"},
		{"configured value passes through", "custom-audience", "custom-audience"},
		{"configured value is trimmed", "  custom-audience  ", "custom-audience"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := queueExecutorAudience(tc.raw); got != tc.want {
				t.Errorf("queueExecutorAudience(%q) = %q, want %q", tc.raw, got, tc.want)
			}
		})
	}
}

// TestQueueExecutorRunnerName pins the os.Hostname failure fallback: a
// hostname lookup that errors (or somehow returns "") must not crash or
// disable the queue executor, just fall back to a fixed name.
func TestQueueExecutorRunnerName(t *testing.T) {
	cases := []struct {
		name     string
		hostname string
		err      error
		want     string
	}{
		{"hostname resolved", "runner-1", nil, "runner-1"},
		{"hostname lookup errored", "", errors.New("boom"), "autoscaler"},
		{"empty hostname with no error", "", nil, "autoscaler"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := queueExecutorRunnerName(tc.hostname, tc.err); got != tc.want {
				t.Errorf("queueExecutorRunnerName(%q, %v) = %q, want %q", tc.hostname, tc.err, got, tc.want)
			}
		})
	}
}

// TestNewDirectRunnerIDTokenSourceErrors pins the plumbing runOrchestrator
// relies on to disable the queue poller (rather than start it and fail
// every poll) when the credentials file is missing or unreadable: a bad
// keyPath must surface as an error from the builder itself, not lazily on
// first .Token() call.
func TestNewDirectRunnerIDTokenSourceErrors(t *testing.T) {
	_, err := newDirectRunnerIDTokenSource(context.Background(), "/nonexistent/telemetry-writer.json", "agent-lcars-work")
	if err == nil {
		t.Fatalf("expected an error building an id token source from a nonexistent key file")
	}
}

func TestQueueExecutorPollerCleanupDoesNotBlockClaims(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	cleanupStarted := make(chan struct{})
	cleanupDone := make(chan struct{})
	claimObserved := make(chan struct{}, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case claimObserved <- struct{}{}:
		default:
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	go runQueueExecutorPoller(ctx, queueExecutorConfig{
		consoleURL: server.URL,
		runnerName: "test-runner",
		idToken:    func() (string, error) { return "token", nil },
		reserve:    reserveFor(func(directRunnerLaunch) error { return nil }),
		cleanup: func(cleanupCtx context.Context) error {
			close(cleanupStarted)
			<-cleanupCtx.Done()
			close(cleanupDone)
			return cleanupCtx.Err()
		},
	}, 5*time.Millisecond, discardLogger())

	select {
	case <-cleanupStarted:
	case <-time.After(time.Second):
		t.Fatal("cleanup did not start")
	}
	select {
	case <-claimObserved:
	case <-time.After(time.Second):
		t.Fatal("claim polling was blocked behind cleanup")
	}
	cancel()
	select {
	case <-cleanupDone:
	case <-time.After(time.Second):
		t.Fatal("cleanup did not stop with the poller context")
	}
}

func TestQueueExecutorPollerRecoversEachTickWithoutOverlapOrBlockingClaims(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	started := make(chan context.Context, 4)
	release := make(chan struct{})
	claims := make(chan struct{}, 10)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case claims <- struct{}{}:
		default:
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	done := make(chan struct{})
	go func() {
		defer close(done)
		runQueueExecutorPoller(ctx, queueExecutorConfig{
			consoleURL: server.URL,
			runnerName: "executor",
			idToken:    func() (string, error) { return "token", nil },
			reserve:    reserveFor(func(directRunnerLaunch) error { return nil }),
			recover: func(recoveryCtx context.Context) error {
				started <- recoveryCtx
				select {
				case <-release:
					return fmt.Errorf("transient API failure")
				case <-recoveryCtx.Done():
					return recoveryCtx.Err()
				}
			},
		}, 5*time.Millisecond, discardLogger())
	}()
	var recoveryCtx context.Context
	select {
	case recoveryCtx = <-started:
	case <-time.After(time.Second):
		t.Fatal("startup recovery did not start")
	}
	deadline, ok := recoveryCtx.Deadline()
	if !ok || time.Until(deadline) > queueStartupRecoveryTimeout {
		t.Fatal("recovery sweep has no finite bound")
	}
	for range 3 {
		select {
		case <-claims:
		case <-time.After(time.Second):
			t.Fatal("recovery blocked claim polling")
		}
	}
	select {
	case <-started:
		t.Fatal("overlapping recovery sweep")
	default:
	}
	release <- struct{}{}
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("ordinary tick did not retry failed recovery")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("poller did not stop")
	}
	select {
	case <-recoveryCtx.Done():
	case <-time.After(time.Second):
		t.Fatal("recovery did not honor cancellation")
	}
}

func TestQueueExecutorPollerSkipsRecoveryWhileDraining(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	recovery := make(chan struct{}, 1)
	done := make(chan struct{})
	go func() {
		defer close(done)
		runQueueExecutorPoller(ctx, queueExecutorConfig{
			draining: func() bool { return true },
			recover:  func(context.Context) error { recovery <- struct{}{}; return nil },
		}, 5*time.Millisecond, discardLogger())
	}()
	select {
	case <-recovery:
		t.Fatal("draining executor resumed work")
	case <-time.After(30 * time.Millisecond):
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("draining poller did not stop")
	}
}

func TestPollOnceLeavesClaimQueuedUntilReservedCapacityIsAvailable(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"runId":"work:01CAPACITYWAIT/r1","token":"token","pipeline":"opencode"}`)
	}))
	defer server.Close()

	capacity := false
	launches := 0
	tokens := 0
	cfg := queueExecutorConfig{
		consoleURL: server.URL,
		runnerName: "test-runner",
		idToken: func() (string, error) {
			tokens++
			return "token", nil
		},
		reserve: func() (*directRunnerReservation, error) {
			if !capacity {
				return nil, nil
			}
			return &directRunnerReservation{
				release: func() {},
				launch:  func(directRunnerLaunch) error { launches++; return nil },
			}, nil
		},
	}

	outcome, err := pollOnceWithOutcome(cfg)
	if err != nil || outcome != queuePollOutcomeCapacityWait {
		t.Fatalf("full-capacity poll = (%q, %v), want capacity_wait", outcome, err)
	}
	if tokens != 0 || requests != 0 || launches != 0 {
		t.Fatalf("full capacity performed work: tokens=%d requests=%d launches=%d", tokens, requests, launches)
	}

	capacity = true
	outcome, err = pollOnceWithOutcome(cfg)
	if err != nil || outcome != queuePollOutcomeClaimed {
		t.Fatalf("available-capacity poll = (%q, %v), want claimed", outcome, err)
	}
	if tokens != 1 || requests != 1 || launches != 1 {
		t.Fatalf("available capacity did not launch exactly once: tokens=%d requests=%d launches=%d", tokens, requests, launches)
	}
}

func TestPollOnceReleasesReservationOnEveryExit(t *testing.T) {
	tests := []struct {
		name      string
		status    int
		body      string
		tokenErr  error
		launchErr error
		wantError bool
	}{
		{name: "idle 204", status: http.StatusNoContent},
		{name: "idle empty", status: http.StatusOK, body: `{}`},
		{name: "authentication error", tokenErr: errors.New("no identity"), wantError: true},
		{name: "claim rejected", status: http.StatusUnauthorized, wantError: true},
		{name: "launch error", status: http.StatusOK, body: `{"runId":"work:01RELEASE/r1","token":"token","pipeline":"codex"}`, launchErr: errors.New("job create failed"), wantError: true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			releases := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(tc.status)
				_, _ = io.WriteString(w, tc.body)
			}))
			defer server.Close()
			_, err := pollOnceWithOutcome(queueExecutorConfig{
				consoleURL: server.URL,
				runnerName: "test-runner",
				idToken:    func() (string, error) { return "token", tc.tokenErr },
				reserve: func() (*directRunnerReservation, error) {
					return &directRunnerReservation{
						release: func() { releases++ },
						launch:  func(directRunnerLaunch) error { return tc.launchErr },
					}, nil
				},
			})
			if (err != nil) != tc.wantError {
				t.Fatalf("poll error = %v, wantError=%v", err, tc.wantError)
			}
			if releases != 1 {
				t.Fatalf("reservation releases = %d, want 1", releases)
			}
		})
	}
}

func TestPollOnceDoesNotClaimWhenCapacityInventoryFails(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	outcome, err := pollOnceWithOutcome(queueExecutorConfig{
		consoleURL: server.URL,
		runnerName: "test-runner",
		idToken:    func() (string, error) { return "token", nil },
		reserve: func() (*directRunnerReservation, error) {
			return nil, errors.New("listing queue Jobs: apiserver unavailable")
		},
	})
	if err == nil || outcome != queuePollOutcomePollError {
		t.Fatalf("inventory-failed poll = (%q, %v), want poll_error", outcome, err)
	}
	if requests != 0 {
		t.Fatalf("inventory failure made %d claim requests, want 0", requests)
	}
}

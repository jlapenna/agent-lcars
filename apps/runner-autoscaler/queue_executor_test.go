package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/docker/docker/api/types/container"
	dockerclient "github.com/docker/docker/client"
	"github.com/prometheus/client_golang/prometheus/testutil"
)

// discardLogger matches this package's own test convention
// (slog.New(slog.NewTextHandler(io.Discard, nil)), see checkpoint_test.go)
// for a logger tests don't care to inspect.
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
		launch: func(l directRunnerLaunch) error {
			launched = append(launched, l)
			return nil
		},
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
				launch:     func(directRunnerLaunch) error { launchCount++; return nil },
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
		{name: "claimed launch error", status: http.StatusOK, body: `{"runId":"work:01QUEUEOUTCOME/r1","token":"token","pipeline":"claude"}`, launchErr: errors.New("docker unavailable"), wantOutcome: queuePollOutcomeLaunchErr, wantErr: true},
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
				launch:     func(directRunnerLaunch) error { return tc.launchErr },
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
		launch:     func(directRunnerLaunch) error { launchCount++; return nil },
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
		launch:     func(directRunnerLaunch) error { launchCount++; return nil },
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
		launch:     func(directRunnerLaunch) error { launchCount++; return nil },
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
		launch:     func(directRunnerLaunch) error { return nil },
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
		launch:     func(directRunnerLaunch) error { launchCount++; return nil },
	}
	err := pollOnce(cfg)
	if err == nil {
		t.Fatalf("expected an error for a claim response over claimResponseBodyLimit")
	}
	if launchCount != 0 {
		t.Fatalf("expected no launch for an oversized claim response, got %d", launchCount)
	}
}

func TestDirectRunnerImageFor(t *testing.T) {
	resolved := resolvedOrchestratorConfig{
		ScaleSets: []Config{
			{ScaleSetName: "claude-actions", Labels: []string{"claude"}, RunnerImage: "registry/claude-image:latest"},
			{ScaleSetName: "codex-actions", Labels: []string{"codex"}, RunnerImage: "registry/codex-image:latest"},
		},
	}

	t.Run("matches a scale set labelled for the pipeline", func(t *testing.T) {
		image, err := directRunnerImageFor(resolved, "claude")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if image != "registry/claude-image:latest" {
			t.Errorf("expected the claude-labelled scale set's image, got %q", image)
		}
	})

	t.Run("matches case-insensitively", func(t *testing.T) {
		image, err := directRunnerImageFor(resolved, "CODEX")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if image != "registry/codex-image:latest" {
			t.Errorf("expected the codex-labelled scale set's image, got %q", image)
		}
	})

	t.Run("falls back to the first scale set when no label matches", func(t *testing.T) {
		image, err := directRunnerImageFor(resolved, "opencode")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if image != "registry/claude-image:latest" {
			t.Errorf("expected the fallback (first) scale set's image, got %q", image)
		}
	})

	t.Run("errors when no scale set is configured at all", func(t *testing.T) {
		_, err := directRunnerImageFor(resolvedOrchestratorConfig{}, "claude")
		if err == nil {
			t.Fatalf("expected an error with no configured scale sets")
		}
	})
}

func TestDirectRunnerMaxConcurrent(t *testing.T) {
	cases := []struct {
		name string
		env  string
		want int
	}{
		{"unset defaults to 1", "", 1},
		{"valid override", "3", 3},
		{"zero falls back to 1", "0", 1},
		{"negative falls back to 1", "-1", 1},
		{"non-numeric falls back to 1", "many", 1},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("LCARS_QUEUE_MAX_CONCURRENT", tc.env)
			if got := directRunnerMaxConcurrent(); got != tc.want {
				t.Errorf("directRunnerMaxConcurrent() = %d, want %d", got, tc.want)
			}
		})
	}
}

// TestQueueExecutorStartupDecision proves durable startup depends on the
// connection and credential configuration it actually consumes, never a local
// pipeline allowlist. The authenticated work.executor grant supplies that
// capability to every claim request.
func TestQueueExecutorStartupDecision(t *testing.T) {
	cases := []struct {
		name       string
		consoleURL string
		keyPath    string
		writerKey  string
		wantStart  bool
		wantReason bool
	}{
		{"complete configuration", "https://lcars.example", "/run/writer.json", "/host/writer.json", true, false},
		{"missing console URL", "", "/run/writer.json", "/host/writer.json", false, true},
		{"missing ID-token credentials", "https://lcars.example", "", "/host/writer.json", false, true},
		{"missing Docker writer credential", "https://lcars.example", "/run/writer.json", "", false, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			start, reason := queueExecutorStartupDecision(tc.consoleURL, tc.keyPath, tc.writerKey)
			if start != tc.wantStart {
				t.Errorf("start = %v, want %v", start, tc.wantStart)
			}
			if (reason != "") != tc.wantReason {
				t.Errorf("reason = %q, want non-empty: %v", reason, tc.wantReason)
			}
		})
	}
}

func TestQueueExecutorStartupStatusDistinguishesDisabledFromMisconfigured(t *testing.T) {
	cases := []struct {
		name       string
		consoleURL string
		keyPath    string
		writerKey  string
		wantStart  bool
		wantState  queueExecutorStartupState
	}{
		{"no queue deployment", "", "/run/writer.json", "/host/writer.json", false, queueExecutorStateDisabled},
		{"incomplete queue deployment", "https://lcars.example", "", "/host/writer.json", false, queueExecutorStateMisconfigured},
		{"ready", "https://lcars.example", "/run/writer.json", "/host/writer.json", true, queueExecutorStateReady},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			start, state, _ := queueExecutorStartupStatus(tc.consoleURL, tc.keyPath, tc.writerKey)
			if start != tc.wantStart || state != tc.wantState {
				t.Fatalf("queueExecutorStartupStatus() = (%v, %q), want (%v, %q)", start, state, tc.wantStart, tc.wantState)
			}
		})
	}
}

// A Codex-only executor has no Claude credential by design: a provider's
// host secret is resolved only when that provider is launched. Startup must
// therefore depend on the queue's shared transport credentials alone.
func TestQueueExecutorStartupAllowsCodexOnlyDeployment(t *testing.T) {
	start, state, reason := queueExecutorStartupStatus(
		"https://lcars.example",
		"/run/telemetry-writer.json",
		"/host/telemetry-writer.json",
	)
	if !start || state != queueExecutorStateReady || reason != "" {
		t.Fatalf("Codex-only queue startup = (%v, %q, %q), want (true, %q, empty)", start, state, reason, queueExecutorStateReady)
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

func TestDirectRunnerTelemetryWriterHostPath(t *testing.T) {
	t.Run("required", func(t *testing.T) {
		t.Setenv("LCARS_QUEUE_TELEMETRY_WRITER_HOST_PATH", "")
		if _, err := directRunnerTelemetryWriterHostPath(); err == nil {
			t.Fatalf("expected an error when the host path env var is unset")
		}
	})
	t.Run("passes through a configured path", func(t *testing.T) {
		t.Setenv("LCARS_QUEUE_TELEMETRY_WRITER_HOST_PATH", "/secrets/telemetry-writer.json")
		got, err := directRunnerTelemetryWriterHostPath()
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got != "/secrets/telemetry-writer.json" {
			t.Errorf("got %q", got)
		}
	})
}

func TestDirectRunnerClaudeTokenHostPath(t *testing.T) {
	t.Run("required", func(t *testing.T) {
		t.Setenv("LCARS_QUEUE_CLAUDE_TOKEN_HOST_PATH", "")
		if _, err := directRunnerClaudeTokenHostPath(); err == nil {
			t.Fatalf("expected an error when the host path env var is unset")
		}
	})
	t.Run("passes through a configured path", func(t *testing.T) {
		t.Setenv("LCARS_QUEUE_CLAUDE_TOKEN_HOST_PATH", "/secrets/claude-code-oauth-token")
		got, err := directRunnerClaudeTokenHostPath()
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got != "/secrets/claude-code-oauth-token" {
			t.Errorf("got %q", got)
		}
	})
}

func TestDirectRunnerOpenCodeTokenHostPath(t *testing.T) {
	t.Run("required", func(t *testing.T) {
		t.Setenv("LCARS_QUEUE_OPENCODE_KEY_HOST_PATH", "")
		if _, err := directRunnerOpenCodeTokenHostPath(); err == nil {
			t.Fatalf("expected an error when the host path env var is unset")
		}
	})
	t.Run("passes through a configured path", func(t *testing.T) {
		t.Setenv("LCARS_QUEUE_OPENCODE_KEY_HOST_PATH", "/secrets/opencode-llm-api-key")
		got, err := directRunnerOpenCodeTokenHostPath()
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got != "/secrets/opencode-llm-api-key" {
			t.Errorf("got %q", got)
		}
	})
}

func TestDirectRunnerProviderCredentialBinds(t *testing.T) {
	t.Setenv("LCARS_QUEUE_CLAUDE_TOKEN_HOST_PATH", "/secrets/claude-code-oauth-token")
	t.Setenv("LCARS_QUEUE_OPENCODE_KEY_HOST_PATH", "/secrets/opencode-llm-api-key")

	claude, err := directRunnerProviderCredentialBinds("claude")
	if err != nil {
		t.Fatalf("claude binds: %v", err)
	}
	wantClaude := "/secrets/claude-code-oauth-token:" + directRunnerClaudeTokenMountPath + ":ro"
	if len(claude) != 1 || claude[0] != wantClaude {
		t.Fatalf("claude binds = %v, want [%s]", claude, wantClaude)
	}

	codex, err := directRunnerProviderCredentialBinds("codex")
	if err != nil {
		t.Fatalf("codex binds: %v", err)
	}
	if len(codex) != 0 {
		t.Fatalf("codex must receive no provider credential mounts, got %v", codex)
	}

	opencode, err := directRunnerProviderCredentialBinds("opencode")
	if err != nil {
		t.Fatalf("opencode binds: %v", err)
	}
	wantOpenCode := "/secrets/opencode-llm-api-key:" + directRunnerOpenCodeTokenMountPath + ":ro"
	if len(opencode) != 1 || opencode[0] != wantOpenCode {
		t.Fatalf("opencode binds = %v, want [%s]", opencode, wantOpenCode)
	}

	if _, err := directRunnerProviderCredentialBinds("unknown"); err == nil {
		t.Fatal("expected an unknown provider adapter to fail closed")
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

// TestLaunchDirectRunnerOnHostLogsPlacementWithoutToken proves a successful
// launch logs the run id and host (so an operator can find "which run
// landed where" without grepping Docker), and proves the run token -- a
// live credential -- never appears in that log line.
func TestLaunchDirectRunnerOnHostLogsPlacementWithoutToken(t *testing.T) {
	f := newFakeDockerServer(t)
	newClient := func(target string) (*dockerclient.Client, error) { return f.client(t), nil }

	var logBuf bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&logBuf, nil))

	l := directRunnerLaunch{
		runID:    "work:01QUEUEEXECUTORTESTFIX06/r1",
		runToken: "super-secret-run-token",
		pipeline: "claude",
	}
	err := launchDirectRunnerOnHost(context.Background(), newClient, "host-a", "unused-target", "registry/claude-image:latest", "/secrets/telemetry-writer.json", []string{"/secrets/claude-code-oauth-token:" + directRunnerClaudeTokenMountPath + ":ro"}, 1, l, logger)
	if err != nil {
		t.Fatalf("launchDirectRunnerOnHost: %v", err)
	}

	logged := logBuf.String()
	if !strings.Contains(logged, "Placed direct runner") {
		t.Errorf("expected a placement log line, got %q", logged)
	}
	if !strings.Contains(logged, l.runID) {
		t.Errorf("expected the log line to name the run id, got %q", logged)
	}
	if !strings.Contains(logged, "host-a") {
		t.Errorf("expected the log line to name the host, got %q", logged)
	}
	if strings.Contains(logged, l.runToken) {
		t.Fatalf("run token must never be logged, got %q", logged)
	}
}

// TestLaunchDirectRunnerOnHostCreatesAndStartsWithEnv is the "fake launcher
// interface asserting the docker-run env" case: it exercises
// launchDirectRunnerOnHost against fakeDockerServer end to end and checks
// exactly what a real docker daemon would have received -- image, the
// RUNNER_MODE=direct/LCARS_RUN_ID/LCARS_RUN_TOKEN/LCARS_CONSOLE_URL env,
// the telemetry-writer bind mount, and that ContainerStart was called.
func TestLaunchDirectRunnerOnHostCreatesAndStartsWithEnv(t *testing.T) {
	f := newFakeDockerServer(t)
	newClient := func(target string) (*dockerclient.Client, error) { return f.client(t), nil }

	l := directRunnerLaunch{
		runID:      "work:01QUEUEEXECUTORTESTFIX01/r1",
		runToken:   "super-secret-run-token",
		pipeline:   "claude",
		consoleURL: "https://lcars.test",
	}
	err := launchDirectRunnerOnHost(context.Background(), newClient, "host-a", "unused-target", "registry/claude-image:latest", "/secrets/telemetry-writer.json", []string{"/secrets/claude-code-oauth-token:" + directRunnerClaudeTokenMountPath + ":ro"}, 1, l, discardLogger())
	if err != nil {
		t.Fatalf("launchDirectRunnerOnHost: %v", err)
	}
	if f.createCount() != 1 {
		t.Fatalf("expected exactly one ContainerCreate, got %d", f.createCount())
	}
	if f.startCount() != 1 {
		t.Fatalf("expected exactly one ContainerStart, got %d", f.startCount())
	}

	created := f.getLastCreate()
	if created.Image != "registry/claude-image:latest" {
		t.Errorf("expected image %q, got %q", "registry/claude-image:latest", created.Image)
	}
	if created.User != "runner" {
		t.Errorf("expected user %q, got %q", "runner", created.User)
	}
	wantEnv := map[string]bool{
		"RUNNER_MODE=direct":                            true,
		"LCARS_RUN_ID=work:01QUEUEEXECUTORTESTFIX01/r1": true,
		"LCARS_RUN_TOKEN=super-secret-run-token":        true,
		"LCARS_CONSOLE_URL=https://lcars.test":          true,
	}
	if len(created.Env) != len(wantEnv) {
		t.Fatalf("expected %d env entries, got %v", len(wantEnv), created.Env)
	}
	for _, e := range created.Env {
		if !wantEnv[e] {
			t.Errorf("unexpected env entry %q", e)
		}
	}
	if created.Labels[directRunnerRunIDLabelKey] != l.runID {
		t.Errorf("expected run-id label %q, got %q", l.runID, created.Labels[directRunnerRunIDLabelKey])
	}
	// Exactly two binds: the telemetry-writer key and the claude OAuth
	// token file -- CLAUDE_CODE_OAUTH_TOKEN must never appear in Env above
	// (asserted by the exact wantEnv count), only as this second file bind
	// direct-runner.sh reads and exports at runtime.
	wantBinds := map[string]bool{
		"/secrets/telemetry-writer.json:" + directRunnerTelemetryWriterMountPath + ":ro": true,
		"/secrets/claude-code-oauth-token:" + directRunnerClaudeTokenMountPath + ":ro":   true,
	}
	if len(created.HostConfig.Binds) != len(wantBinds) {
		t.Fatalf("expected %d binds, got %v", len(wantBinds), created.HostConfig.Binds)
	}
	for _, b := range created.HostConfig.Binds {
		if !wantBinds[b] {
			t.Errorf("unexpected bind %q", b)
		}
	}
}

func TestLaunchCodexDirectRunnerMountsNoProviderCredential(t *testing.T) {
	f := newFakeDockerServer(t)
	newClient := func(target string) (*dockerclient.Client, error) { return f.client(t), nil }

	l := directRunnerLaunch{
		runID:      "work:01QUEUEEXECUTORTESTCODEX1/r1",
		runToken:   "super-secret-run-token",
		pipeline:   "codex",
		consoleURL: "https://lcars.test",
	}
	if err := launchDirectRunnerOnHost(context.Background(), newClient, "host-a", "unused-target", "registry/codex-image:latest", "/secrets/telemetry-writer.json", nil, 1, l, discardLogger()); err != nil {
		t.Fatalf("launchDirectRunnerOnHost: %v", err)
	}
	created := f.getLastCreate()
	want := "/secrets/telemetry-writer.json:" + directRunnerTelemetryWriterMountPath + ":ro"
	if len(created.HostConfig.Binds) != 1 || created.HostConfig.Binds[0] != want {
		t.Fatalf("codex binds = %v, want only %q", created.HostConfig.Binds, want)
	}
	if got := created.HostConfig.Tmpfs[directRunnerCodexVolatileMountPath]; got != "rw,noexec,nosuid,nodev,mode=1777,size=64m" {
		t.Fatalf("codex tmpfs = %q, want hardened volatile mount", got)
	}
	volatileEnv := "LCARS_CODEX_VOLATILE_DIR=" + directRunnerCodexVolatileMountPath
	volatileEnvFound := false
	for _, env := range created.Env {
		if env == volatileEnv {
			volatileEnvFound = true
			break
		}
	}
	if !volatileEnvFound {
		t.Fatalf("codex volatile dir was not passed to the container: %v", created.Env)
	}
	for _, env := range created.Env {
		if strings.Contains(strings.ToLower(env), "codex") && strings.Contains(strings.ToLower(env), "auth") {
			t.Fatalf("Codex auth must not appear in container env: %q", env)
		}
	}
}

func TestLaunchOpenCodeDirectRunnerMountsOnlyProviderCredential(t *testing.T) {
	f := newFakeDockerServer(t)
	newClient := func(target string) (*dockerclient.Client, error) { return f.client(t), nil }

	l := directRunnerLaunch{
		runID:      "work:01QUEUEEXECUTORTESTOPENCODE1/r1",
		runToken:   "super-secret-run-token",
		pipeline:   "opencode",
		consoleURL: "https://lcars.test",
	}
	opencodeBind := "/secrets/opencode-llm-api-key:" + directRunnerOpenCodeTokenMountPath + ":ro"
	if err := launchDirectRunnerOnHost(context.Background(), newClient, "host-a", "unused-target", "registry/opencode-image:latest", "/secrets/telemetry-writer.json", []string{opencodeBind}, 1, l, discardLogger()); err != nil {
		t.Fatalf("launchDirectRunnerOnHost: %v", err)
	}

	created := f.getLastCreate()
	wantBinds := map[string]bool{
		"/secrets/telemetry-writer.json:" + directRunnerTelemetryWriterMountPath + ":ro": true,
		opencodeBind: true,
	}
	if len(created.HostConfig.Binds) != len(wantBinds) {
		t.Fatalf("opencode binds = %v, want %v", created.HostConfig.Binds, wantBinds)
	}
	for _, bind := range created.HostConfig.Binds {
		if !wantBinds[bind] {
			t.Fatalf("unexpected OpenCode bind %q", bind)
		}
	}
	if len(created.HostConfig.Tmpfs) != 0 {
		t.Fatalf("opencode must not receive Codex's auth tmpfs, got %v", created.HostConfig.Tmpfs)
	}
	for _, env := range created.Env {
		if strings.Contains(env, "OPENCODE_LLM_API_KEY") {
			t.Fatalf("OpenCode credential must not appear in Docker env: %q", env)
		}
	}
}

// TestLaunchDirectRunnerOnHostAtCapacity proves the concurrency cap refuses
// to create a container at all once a host already has maxConcurrent
// direct-runner containers running -- the queue-executor equivalent of
// Scaler.checkHostRunnerLimit.
func TestLaunchDirectRunnerOnHostAtCapacity(t *testing.T) {
	f := newFakeDockerServer(t)
	newClient := func(target string) (*dockerclient.Client, error) { return f.client(t), nil }

	// Simulate one already-running direct-runner container by making
	// ContainerList report one match for the label filter.
	f.mu.Lock()
	f.containers = append(f.containers, container.Summary{ID: "existing", Labels: map[string]string{directRunnerLabelKey: "1"}})
	f.mu.Unlock()

	l := directRunnerLaunch{runID: "work:01QUEUEEXECUTORTESTFIX02/r1", runToken: "t", pipeline: "claude"}
	err := launchDirectRunnerOnHost(context.Background(), newClient, "host-a", "unused-target", "registry/claude-image:latest", "/secrets/telemetry-writer.json", []string{"/secrets/claude-code-oauth-token:" + directRunnerClaudeTokenMountPath + ":ro"}, 1, l, discardLogger())
	if err == nil {
		t.Fatalf("expected an error when the host is already at its direct-runner cap")
	}
	if f.createCount() != 0 {
		t.Fatalf("expected no ContainerCreate when at capacity, got %d", f.createCount())
	}
}

func TestCleanupExitedDirectRunnersRetainsRecentEvidenceAndOnlyTouchesOwnedExits(t *testing.T) {
	f := newFakeDockerServer(t)
	newClient := func(target string) (*dockerclient.Client, error) { return f.client(t), nil }
	now := time.Date(2026, time.August, 28, 12, 0, 0, 0, time.UTC)
	owned := func(id string, created time.Time, state string) container.Summary {
		return container.Summary{
			ID:      id,
			Created: created.Unix(),
			State:   state,
			Labels: map[string]string{
				directRunnerLabelKey:      "1",
				directRunnerRunIDLabelKey: "work:" + id + "/r1",
			},
		}
	}

	containers := []container.Summary{
		// Six recent owned exits: retain the five newest and remove the sixth
		// to keep an immediate per-host bound during a failure burst. Their
		// creation times intentionally disagree with their exit times: a
		// long-running newer failure must rank by FinishedAt, not Created.
		owned("new-1", now.Add(-72*time.Hour), container.StateExited),
		owned("new-2", now.Add(-48*time.Hour), container.StateExited),
		owned("new-3", now.Add(-36*time.Hour), container.StateExited),
		owned("new-4", now.Add(-24*time.Hour), container.StateExited),
		owned("new-5", now.Add(-12*time.Hour), container.StateExited),
		owned("over-limit", now.Add(-10*time.Minute), container.StateExited),
		// A separately aged exit is removed by its actual finished time.
		owned("aged", now.Add(-48*time.Hour), container.StateExited),
		// A running direct runner must never be removed.
		owned("active", now.Add(-48*time.Hour), container.StateRunning),
		// Neither an Actions runner nor a malformed/foreign direct label is
		// queue-executor ownership, regardless of age or state.
		{ID: "actions-runner", Created: now.Add(-72 * time.Hour).Unix(), State: container.StateExited, Labels: map[string]string{"agent-lcars.scale-set": "claude"}},
		{ID: "missing-run-id", Created: now.Add(-72 * time.Hour).Unix(), State: container.StateExited, Labels: map[string]string{directRunnerLabelKey: "1"}},
		{ID: "wrong-owner", Created: now.Add(-72 * time.Hour).Unix(), State: container.StateExited, Labels: map[string]string{directRunnerLabelKey: "other", directRunnerRunIDLabelKey: "work:foreign/r1"}},
	}
	f.setContainers(containers)
	for id, finishedAt := range map[string]time.Time{
		"new-1":      now.Add(-1 * time.Hour),
		"new-2":      now.Add(-2 * time.Hour),
		"new-3":      now.Add(-3 * time.Hour),
		"new-4":      now.Add(-4 * time.Hour),
		"new-5":      now.Add(-5 * time.Hour),
		"over-limit": now.Add(-6 * time.Hour),
		"aged":       now.Add(-25 * time.Hour),
	} {
		f.setInspect(id, http.StatusOK, &container.State{Status: container.StateExited, FinishedAt: finishedAt.Format(time.RFC3339Nano)})
	}
	resolved := resolvedOrchestratorConfig{DockerHosts: []string{"host-a=fake-target"}}
	if err := cleanupExitedDirectRunners(context.Background(), resolved, newClient, now); err != nil {
		t.Fatalf("cleanupExitedDirectRunners: %v", err)
	}
	removed := f.removedIDs()
	if strings.Join(removed, ",") != "over-limit,aged" {
		t.Fatalf("removed = %v, want only over-limit and aged owned exits", removed)
	}
	for i, forced := range f.removalsForced() {
		if forced {
			t.Fatalf("removal %d was forced; retention must let Docker refuse an active-state race", i)
		}
	}
}

func TestCleanupExitedDirectRunnersRetainsMalformedOrChangedExitState(t *testing.T) {
	now := time.Date(2026, time.August, 28, 12, 0, 0, 0, time.UTC)
	ownedExit := func(id string) container.Summary {
		return container.Summary{
			ID:      id,
			Created: now.Add(-48 * time.Hour).Unix(),
			State:   container.StateExited,
			Labels:  map[string]string{directRunnerLabelKey: "1", directRunnerRunIDLabelKey: "work:" + id + "/r1"},
		}
	}
	cases := []struct {
		name       string
		inspect    *container.State
		wantErr    bool
		wantRemove bool
	}{
		{
			name:    "malformed FinishedAt is retained",
			inspect: &container.State{Status: container.StateExited, FinishedAt: "not-a-timestamp"},
			wantErr: true,
		},
		{
			name:    "state changed after list is retained",
			inspect: &container.State{Status: container.StateRunning},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newFakeDockerServer(t)
			f.setContainers([]container.Summary{ownedExit("candidate")})
			f.setInspect("candidate", http.StatusOK, tc.inspect)
			newClient := func(target string) (*dockerclient.Client, error) { return f.client(t), nil }
			err := cleanupExitedDirectRunners(context.Background(), resolvedOrchestratorConfig{DockerHosts: []string{"host-a=fake-target"}}, newClient, now)
			if (err != nil) != tc.wantErr {
				t.Fatalf("cleanup error = %v, want error=%v", err, tc.wantErr)
			}
			if got := len(f.removedIDs()) > 0; got != tc.wantRemove {
				t.Fatalf("removed=%v, want removed=%v", f.removedIDs(), tc.wantRemove)
			}
		})
	}
}

func TestCleanupExitedDirectRunnersDeadlineBoundsStalledInspect(t *testing.T) {
	f := newFakeDockerServer(t)
	now := time.Date(2026, time.August, 28, 12, 0, 0, 0, time.UTC)
	f.setContainers([]container.Summary{{
		ID:      "stalled",
		Created: now.Add(-48 * time.Hour).Unix(),
		State:   container.StateExited,
		Labels:  map[string]string{directRunnerLabelKey: "1", directRunnerRunIDLabelKey: "work:stalled/r1"},
	}})
	f.setInspect("stalled", http.StatusOK, &container.State{Status: container.StateExited, FinishedAt: now.Add(-25 * time.Hour).Format(time.RFC3339Nano)})
	f.setInspectDelay(100 * time.Millisecond)
	newClient := func(target string) (*dockerclient.Client, error) { return f.client(t), nil }
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Millisecond)
	defer cancel()
	started := time.Now()
	err := cleanupExitedDirectRunners(ctx, resolvedOrchestratorConfig{DockerHosts: []string{"host-a=fake-target"}}, newClient, now)
	if err == nil {
		t.Fatal("expected stalled inspection to hit the sweep deadline")
	}
	if elapsed := time.Since(started); elapsed > 250*time.Millisecond {
		t.Fatalf("cleanup took %s after a 15ms deadline; inspection must be deadline-bounded", elapsed)
	}
	if removed := f.removedIDs(); len(removed) != 0 {
		t.Fatalf("stalled inspection removed %v; uncertain exits must be retained", removed)
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
		launch:     func(directRunnerLaunch) error { return nil },
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

// TestLaunchDirectRunnerRoundRobinsPastAFullHost exercises the whole
// launchDirectRunner round-robin: the first configured host is at capacity,
// so the container must land on the second.
func TestLaunchDirectRunnerRoundRobinsPastAFullHost(t *testing.T) {
	t.Setenv("LCARS_QUEUE_TELEMETRY_WRITER_HOST_PATH", "/secrets/telemetry-writer.json")
	t.Setenv("LCARS_QUEUE_CLAUDE_TOKEN_HOST_PATH", "/secrets/claude-code-oauth-token")

	full := newFakeDockerServer(t)
	full.mu.Lock()
	full.containers = append(full.containers, container.Summary{ID: "existing", Labels: map[string]string{directRunnerLabelKey: "1"}})
	full.mu.Unlock()

	spare := newFakeDockerServer(t)

	resolved := resolvedOrchestratorConfig{
		DockerHosts: []string{"full=fake-target-full", "spare=fake-target-spare"},
		ScaleSets:   []Config{{ScaleSetName: "claude-actions", Labels: []string{"claude"}, RunnerImage: "registry/claude-image:latest"}},
	}
	newClient := func(target string) (*dockerclient.Client, error) {
		switch target {
		case "fake-target-full":
			return full.client(t), nil
		case "fake-target-spare":
			return spare.client(t), nil
		default:
			t.Fatalf("unexpected docker target %q", target)
			return nil, nil
		}
	}
	l := directRunnerLaunch{runID: "work:01QUEUEEXECUTORTESTFIX03/r1", runToken: "t", pipeline: "claude"}

	if err := launchDirectRunnerWithClient(context.Background(), resolved, l, newClient, discardLogger()); err != nil {
		t.Fatalf("launchDirectRunnerWithClient: %v", err)
	}
	if full.createCount() != 0 {
		t.Errorf("expected the full host to receive no create, got %d", full.createCount())
	}
	if spare.createCount() != 1 {
		t.Errorf("expected the spare host to receive exactly one create, got %d", spare.createCount())
	}
}

func TestLaunchDirectRunnerCodexDoesNotRequireClaudeTokenPath(t *testing.T) {
	t.Setenv("LCARS_QUEUE_TELEMETRY_WRITER_HOST_PATH", "/secrets/telemetry-writer.json")
	t.Setenv("LCARS_QUEUE_CLAUDE_TOKEN_HOST_PATH", "")

	f := newFakeDockerServer(t)
	resolved := resolvedOrchestratorConfig{
		DockerHosts: []string{"host-a=fake-target"},
		ScaleSets:   []Config{{ScaleSetName: "codex-actions", Labels: []string{"codex"}, RunnerImage: "registry/codex-image:latest"}},
	}
	newClient := func(target string) (*dockerclient.Client, error) {
		if target != "fake-target" {
			t.Fatalf("unexpected docker target %q", target)
		}
		return f.client(t), nil
	}
	l := directRunnerLaunch{runID: "work:01QUEUEEXECUTORTESTCODEX2/r1", runToken: "t", pipeline: "codex"}

	if err := launchDirectRunnerWithClient(context.Background(), resolved, l, newClient, discardLogger()); err != nil {
		t.Fatalf("launchDirectRunnerWithClient: %v", err)
	}
	if f.createCount() != 1 {
		t.Fatalf("expected one Codex container, got %d", f.createCount())
	}
}

// TestLaunchDirectRunnerOnHostRemovesContainerOnStartFailure mirrors
// Scaler.startRunner's own cleanup-on-start-failure: a container that was
// created but never started must not be left behind as a stopped ghost.
func TestLaunchDirectRunnerOnHostRemovesContainerOnStartFailure(t *testing.T) {
	f := newFakeDockerServer(t)
	f.setStartFailures(http.StatusInternalServerError)
	newClient := func(target string) (*dockerclient.Client, error) { return f.client(t), nil }

	l := directRunnerLaunch{runID: "work:01QUEUEEXECUTORTESTFIX04/r1", runToken: "t", pipeline: "claude"}
	err := launchDirectRunnerOnHost(context.Background(), newClient, "host-a", "unused-target", "registry/claude-image:latest", "/secrets/telemetry-writer.json", []string{"/secrets/claude-code-oauth-token:" + directRunnerClaudeTokenMountPath + ":ro"}, 1, l, discardLogger())
	if err == nil {
		t.Fatalf("expected an error when ContainerStart fails")
	}
	if f.createCount() != 1 {
		t.Fatalf("expected exactly one ContainerCreate, got %d", f.createCount())
	}
	removed := f.removedIDs()
	if len(removed) != 1 || removed[0] != "created-container" {
		t.Fatalf("expected the failed-to-start container to be removed, got %v", removed)
	}
}

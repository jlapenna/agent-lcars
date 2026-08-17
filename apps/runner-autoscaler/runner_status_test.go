package main

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus/testutil"
)

func TestRunnerStatusEndpoint(t *testing.T) {
	tests := []struct {
		name         string
		registration string
		wantBase     string
		wantPath     string
	}{
		{
			name:         "github repository",
			registration: "https://github.com/acme/widgets",
			wantBase:     "https://api.github.com",
			wantPath:     "/repos/acme/widgets/actions/runners",
		},
		{
			name:         "github organization",
			registration: "https://github.com/acme",
			wantBase:     "https://api.github.com",
			wantPath:     "/orgs/acme/actions/runners",
		},
		{
			name:         "ghes repository",
			registration: "https://github.example.test/acme/widgets",
			wantBase:     "https://github.example.test/api/v3",
			wantPath:     "/repos/acme/widgets/actions/runners",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			base, path, err := runnerStatusEndpoint(tt.registration)
			if err != nil {
				t.Fatalf("runnerStatusEndpoint: %v", err)
			}
			if base != tt.wantBase || path != tt.wantPath {
				t.Fatalf("runnerStatusEndpoint = (%q, %q), want (%q, %q)", base, path, tt.wantBase, tt.wantPath)
			}
		})
	}
}

func TestGitHubRunnerStatusClientListsRegistrationOnce(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		if r.Header.Get("Authorization") != "Bearer test-token" {
			t.Errorf("Authorization = %q", r.Header.Get("Authorization"))
		}
		page, _ := strconv.Atoi(r.URL.Query().Get("page"))
		w.Header().Set("Content-Type", "application/json")
		switch page {
		case 1:
			_, _ = io.WriteString(w, `{"total_count":101,"runners":[{"name":"unrelated","status":"online"}]}`)
		case 2:
			_, _ = io.WriteString(w, `{"total_count":101,"runners":[{"name":"runner-a","status":"offline"},{"name":"runner-b","status":"online"}]}`)
		default:
			t.Fatalf("unexpected page %d", page)
		}
	}))
	defer server.Close()

	client := &githubRunnerStatusClient{
		apiBaseURL:  server.URL,
		runnersPath: "/repos/acme/widgets/actions/runners",
		httpClient:  server.Client(),
		tokenSource: staticBearerToken("test-token"),
	}
	statuses, err := client.ListRunnerStatuses(context.Background(), map[string]struct{}{
		"runner-a": {},
		"runner-b": {},
	})
	if err != nil {
		t.Fatalf("ListRunnerStatuses: %v", err)
	}
	if requests != 2 {
		t.Fatalf("requests = %d, want 2 registration pages", requests)
	}
	if statuses["runner-a"] != "offline" || statuses["runner-b"] != "online" {
		t.Fatalf("statuses = %#v", statuses)
	}
}

func TestGitHubRunnerStatusClientListRunnerStatusesHonorsRetryAfter(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "42")
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = io.WriteString(w, `{"message":"You have exceeded a secondary rate limit"}`)
	}))
	defer server.Close()

	client := &githubRunnerStatusClient{
		apiBaseURL:  server.URL,
		runnersPath: "/repos/acme/widgets/actions/runners",
		httpClient:  server.Client(),
		tokenSource: staticBearerToken("test-token"),
	}
	_, err := client.ListRunnerStatuses(context.Background(), map[string]struct{}{"runner-a": {}})
	if err == nil {
		t.Fatal("ListRunnerStatuses: want error, got nil")
	}
	var rateLimited *githubRateLimitError
	if !errors.As(err, &rateLimited) {
		t.Fatalf("error = %v, want *githubRateLimitError", err)
	}
	if rateLimited.retryAfter != 42*time.Second {
		t.Fatalf("retryAfter = %s, want 42s", rateLimited.retryAfter)
	}
	if !strings.Contains(err.Error(), "secondary rate limit") {
		t.Fatalf("error %q does not include response body snippet", err.Error())
	}
}

func TestGitHubRunnerStatusClientListRunnerStatusesHonors403RateLimitHeaders(t *testing.T) {
	reset := time.Now().Add(90 * time.Second)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-RateLimit-Remaining", "0")
		w.Header().Set("X-RateLimit-Reset", strconv.FormatInt(reset.Unix(), 10))
		w.WriteHeader(http.StatusForbidden)
		_, _ = io.WriteString(w, `{"message":"API rate limit exceeded"}`)
	}))
	defer server.Close()

	client := &githubRunnerStatusClient{
		apiBaseURL:  server.URL,
		runnersPath: "/repos/acme/widgets/actions/runners",
		httpClient:  server.Client(),
		tokenSource: staticBearerToken("test-token"),
	}
	_, err := client.ListRunnerStatuses(context.Background(), map[string]struct{}{"runner-a": {}})
	var rateLimited *githubRateLimitError
	if !errors.As(err, &rateLimited) {
		t.Fatalf("error = %v, want *githubRateLimitError", err)
	}
	// Allow slack for wall-clock jitter between the server computing `reset`
	// and githubRateLimited computing time.Now() inside ListRunnerStatuses.
	if rateLimited.retryAfter < 85*time.Second || rateLimited.retryAfter > 95*time.Second {
		t.Fatalf("retryAfter = %s, want ~90s", rateLimited.retryAfter)
	}
}

func TestGitHubRunnerStatusClientListRunnerStatusesOrdinary403IsNotRateLimit(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = io.WriteString(w, `{"message":"Resource not accessible by integration"}`)
	}))
	defer server.Close()

	client := &githubRunnerStatusClient{
		apiBaseURL:  server.URL,
		runnersPath: "/repos/acme/widgets/actions/runners",
		httpClient:  server.Client(),
		tokenSource: staticBearerToken("test-token"),
	}
	_, err := client.ListRunnerStatuses(context.Background(), map[string]struct{}{"runner-a": {}})
	if err == nil {
		t.Fatal("ListRunnerStatuses: want error, got nil")
	}
	var rateLimited *githubRateLimitError
	if errors.As(err, &rateLimited) {
		t.Fatalf("ordinary 403 misclassified as rate limit: %v", err)
	}
	if !strings.Contains(err.Error(), "Resource not accessible by integration") {
		t.Fatalf("error %q does not include response body snippet", err.Error())
	}
}

type fakeRunnerStatusSource struct {
	statuses map[string]string
	err      error
	calls    int
	wanted   map[string]struct{}
}

func (s *fakeRunnerStatusSource) ListRunnerStatuses(_ context.Context, wanted map[string]struct{}) (map[string]string, error) {
	s.calls++
	s.wanted = wanted
	return s.statuses, s.err
}

func TestRegistrationRunnerStatusMonitorCountsOfflineAndMissingAfterGrace(t *testing.T) {
	now := time.Now()
	source := &fakeRunnerStatusSource{statuses: map[string]string{
		"online":  "online",
		"offline": "offline",
		"recent":  "offline",
	}}
	scaler := &Scaler{
		scaleSetName: "status-monitor-test",
		dockerHosts:  []DockerHost{{Name: "host-a"}, {Name: "host-b"}},
		runners: runnerState{
			idle: map[string]runnerRef{
				"online":  {host: "host-a", startedAt: now.Add(-time.Hour)},
				"offline": {host: "host-a", startedAt: now.Add(-time.Hour)},
				"missing": {host: "host-b", startedAt: now.Add(-time.Hour)},
				"recent":  {host: "host-b", startedAt: now.Add(-time.Minute)},
			},
			busy: map[string]runnerRef{},
		},
	}
	monitor := &registrationRunnerStatusMonitor{
		registration: "status-monitor-registration-test",
		source:       source,
		scalers:      []*Scaler{scaler},
		logger:       slog.New(slog.NewTextHandler(io.Discard, nil)),
		now:          func() time.Time { return now },
	}

	monitor.reconcile(context.Background())

	if source.calls != 1 || len(source.wanted) != 4 {
		t.Fatalf("source calls/wanted = %d/%d, want 1/4", source.calls, len(source.wanted))
	}
	if got := testutil.ToFloat64(githubUnavailableRunnersGauge.WithLabelValues("status-monitor-test", "host-a", runnerUnavailableOffline)); got != 1 {
		t.Fatalf("host-a offline = %v, want 1", got)
	}
	if got := testutil.ToFloat64(githubUnavailableRunnersGauge.WithLabelValues("status-monitor-test", "host-b", runnerUnavailableMissing)); got != 1 {
		t.Fatalf("host-b missing = %v, want 1", got)
	}
	if got := testutil.ToFloat64(githubUnavailableRunnersGauge.WithLabelValues("status-monitor-test", "host-b", runnerUnavailableOffline)); got != 0 {
		t.Fatalf("recent runner counted before grace period: %v", got)
	}
	if got := testutil.ToFloat64(runnerStatusProbeUpGauge.WithLabelValues("status-monitor-registration-test")); got != 1 {
		t.Fatalf("probe_up = %v, want 1", got)
	}
}

func TestRegistrationRunnerStatusMonitorPreservesCountsOnProbeFailure(t *testing.T) {
	now := time.Now()
	scaleSet := "status-monitor-failure-test"
	registration := "status-monitor-failure-registration-test"
	gauge := githubUnavailableRunnersGauge.WithLabelValues(scaleSet, "host-a", runnerUnavailableOffline)
	gauge.Set(1)
	source := &fakeRunnerStatusSource{err: errors.New("unavailable")}
	scaler := &Scaler{
		scaleSetName: scaleSet,
		dockerHosts:  []DockerHost{{Name: "host-a"}},
		runners: runnerState{
			idle: map[string]runnerRef{"runner": {host: "host-a", startedAt: now.Add(-time.Hour)}},
			busy: map[string]runnerRef{},
		},
	}
	monitor := &registrationRunnerStatusMonitor{
		registration: registration,
		source:       source,
		scalers:      []*Scaler{scaler},
		logger:       slog.New(slog.NewTextHandler(io.Discard, nil)),
		now:          func() time.Time { return now },
	}

	monitor.reconcile(context.Background())

	if got := testutil.ToFloat64(gauge); got != 1 {
		t.Fatalf("unavailable gauge changed on failed probe: %v", got)
	}
	if got := testutil.ToFloat64(runnerStatusProbeUpGauge.WithLabelValues(registration)); got != 0 {
		t.Fatalf("probe_up = %v, want 0", got)
	}
}

// TestRegistrationRunnerStatusMonitorBacksOffOnRateLimit verifies reconcile
// returns the rate limit's retry-after duration instead of the fixed
// runnerStatusPollInterval (agent-lcars#321), while still preserving the
// same probe-failure metrics semantics as an ordinary error (probe_up -> 0,
// last-good unavailable-runner gauges untouched).
func TestRegistrationRunnerStatusMonitorBacksOffOnRateLimit(t *testing.T) {
	now := time.Now()
	scaleSet := "status-monitor-ratelimit-test"
	registration := "status-monitor-ratelimit-registration-test"
	gauge := githubUnavailableRunnersGauge.WithLabelValues(scaleSet, "host-a", runnerUnavailableOffline)
	gauge.Set(1)
	wantDelay := 3 * time.Minute
	source := &fakeRunnerStatusSource{err: &githubRateLimitError{
		retryAfter: wantDelay,
		err:        errors.New("listing GitHub runners: unexpected 429 Too Many Requests: rate limited"),
	}}
	scaler := &Scaler{
		scaleSetName: scaleSet,
		dockerHosts:  []DockerHost{{Name: "host-a"}},
		runners: runnerState{
			idle: map[string]runnerRef{"runner": {host: "host-a", startedAt: now.Add(-time.Hour)}},
			busy: map[string]runnerRef{},
		},
	}
	monitor := &registrationRunnerStatusMonitor{
		registration: registration,
		source:       source,
		scalers:      []*Scaler{scaler},
		logger:       slog.New(slog.NewTextHandler(io.Discard, nil)),
		now:          func() time.Time { return now },
	}

	delay := monitor.reconcile(context.Background())

	if delay != wantDelay {
		t.Fatalf("reconcile delay = %s, want %s", delay, wantDelay)
	}
	if got := testutil.ToFloat64(gauge); got != 1 {
		t.Fatalf("unavailable gauge changed on rate-limited probe: %v", got)
	}
	if got := testutil.ToFloat64(runnerStatusProbeUpGauge.WithLabelValues(registration)); got != 0 {
		t.Fatalf("probe_up = %v, want 0", got)
	}
}

// TestRegistrationRunnerStatusMonitorUsesPollIntervalOnSuccess pins down
// reconcile's return value on the ordinary (no error) path, since run relies
// on it to reset its timer back to the normal cadence after a prior
// rate-limit backoff.
func TestRegistrationRunnerStatusMonitorUsesPollIntervalOnSuccess(t *testing.T) {
	now := time.Now()
	source := &fakeRunnerStatusSource{statuses: map[string]string{}}
	scaler := &Scaler{scaleSetName: "status-monitor-success-test"}
	monitor := &registrationRunnerStatusMonitor{
		registration: "status-monitor-success-registration-test",
		source:       source,
		scalers:      []*Scaler{scaler},
		logger:       slog.New(slog.NewTextHandler(io.Discard, nil)),
		now:          func() time.Time { return now },
	}

	if delay := monitor.reconcile(context.Background()); delay != runnerStatusPollInterval {
		t.Fatalf("reconcile delay = %s, want %s", delay, runnerStatusPollInterval)
	}
}

func TestGitHubRunnerStatusClientUsesConfiguredPath(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/repos/acme/widgets/actions/runners" {
			t.Errorf("path = %q", r.URL.Path)
		}
		if _, err := url.ParseRequestURI(r.RequestURI); err != nil {
			t.Errorf("invalid request URI: %v", err)
		}
		_, _ = io.WriteString(w, `{"total_count":1,"runners":[{"name":"runner","status":"online"}]}`)
	}))
	defer server.Close()

	client := &githubRunnerStatusClient{
		apiBaseURL:  server.URL,
		runnersPath: "/repos/acme/widgets/actions/runners",
		httpClient:  server.Client(),
		tokenSource: staticBearerToken("test-token"),
	}
	if _, err := client.ListRunnerStatuses(context.Background(), map[string]struct{}{"runner": {}}); err != nil {
		t.Fatal(err)
	}
}

// newReapTestScaler builds a Scaler whose only reachable dependency is the
// 404 scaleset stub. reapUnavailableRunner's ContainerRemove is expected to
// fail (no docker host client), which is deliberate: the runner must still be
// untracked and deregistered so its capacity is released either way.
func newReapTestScaler(t *testing.T, scaleSet string, idle, busy map[string]runnerRef) *Scaler {
	t.Helper()
	return &Scaler{
		scaleSetName:   scaleSet,
		dockerHosts:    []DockerHost{{Name: "host-a"}},
		scalesetClient: newStubScalesetClient(t),
		logger:         slog.New(slog.NewTextHandler(io.Discard, nil)),
		runners:        runnerState{idle: idle, busy: busy},
	}
}

// The 2026-08-16 split-brain: the container is healthy and listening, GitHub
// reports it offline, and nothing on either side times that out. One poll must
// not be enough to destroy a runner, but a sustained verdict must be.
func TestRunnerStatusMonitorReapsIdleRunnerAfterSustainedUnavailability(t *testing.T) {
	start := time.Now()
	scaleSet := "reap-sustained-test"
	scaler := newReapTestScaler(t, scaleSet,
		map[string]runnerRef{"stuck": {host: "host-a", startedAt: start.Add(-time.Hour)}},
		map[string]runnerRef{})
	now := start
	monitor := &registrationRunnerStatusMonitor{
		registration: "reap-sustained-registration",
		source:       &fakeRunnerStatusSource{statuses: map[string]string{"stuck": "offline"}},
		scalers:      []*Scaler{scaler},
		logger:       slog.New(slog.NewTextHandler(io.Discard, nil)),
		now:          func() time.Time { return now },
	}

	monitor.reconcile(context.Background())
	if _, ok := scaler.runners.idle["stuck"]; !ok {
		t.Fatal("runner reaped on its first unavailable observation; a blip must not destroy capacity")
	}

	now = start.Add(runnerUnavailableReapAfter - time.Minute)
	monitor.reconcile(context.Background())
	if _, ok := scaler.runners.idle["stuck"]; !ok {
		t.Fatal("runner reaped before the threshold elapsed")
	}

	now = start.Add(runnerUnavailableReapAfter + time.Minute)
	monitor.reconcile(context.Background())
	if _, ok := scaler.runners.idle["stuck"]; ok {
		t.Fatal("runner still tracked after sustained unavailability; its capacity stays pinned and no replacement is placed")
	}
	if got := testutil.ToFloat64(githubUnavailableRunnersReapedTotal.WithLabelValues(scaleSet, "host-a", runnerUnavailableOffline)); got != 1 {
		t.Fatalf("reaped total = %v, want 1", got)
	}
}

// A busy runner may be mid-job behind a transient API blip. Killing it to
// settle a reporting disagreement would destroy real work, and an ephemeral
// runner that has genuinely died exits for reconcileRunners to collect.
func TestRunnerStatusMonitorNeverReapsBusyRunner(t *testing.T) {
	start := time.Now()
	scaler := newReapTestScaler(t, "reap-busy-test",
		map[string]runnerRef{},
		map[string]runnerRef{"working": {host: "host-a", startedAt: start.Add(-time.Hour)}})
	now := start
	monitor := &registrationRunnerStatusMonitor{
		registration: "reap-busy-registration",
		source:       &fakeRunnerStatusSource{statuses: map[string]string{"working": "offline"}},
		scalers:      []*Scaler{scaler},
		logger:       slog.New(slog.NewTextHandler(io.Discard, nil)),
		now:          func() time.Time { return now },
	}

	monitor.reconcile(context.Background())
	now = start.Add(4 * runnerUnavailableReapAfter)
	monitor.reconcile(context.Background())

	if _, ok := scaler.runners.busy["working"]; !ok {
		t.Fatal("busy runner was reaped; a job in flight must survive a GitHub reporting disagreement")
	}
}

// Availability returning at any point clears the elapsed time, so a runner
// that flaps never accumulates its way to a reap.
func TestRunnerStatusMonitorResetsUnavailabilityOnRecovery(t *testing.T) {
	start := time.Now()
	scaler := newReapTestScaler(t, "reap-recovery-test",
		map[string]runnerRef{"flappy": {host: "host-a", startedAt: start.Add(-time.Hour)}},
		map[string]runnerRef{})
	now := start
	source := &fakeRunnerStatusSource{statuses: map[string]string{"flappy": "offline"}}
	monitor := &registrationRunnerStatusMonitor{
		registration: "reap-recovery-registration",
		source:       source,
		scalers:      []*Scaler{scaler},
		logger:       slog.New(slog.NewTextHandler(io.Discard, nil)),
		now:          func() time.Time { return now },
	}

	monitor.reconcile(context.Background())
	now = start.Add(runnerUnavailableReapAfter - time.Minute)
	source.statuses["flappy"] = "online"
	monitor.reconcile(context.Background())
	now = start.Add(runnerUnavailableReapAfter + time.Minute)
	source.statuses["flappy"] = "offline"
	monitor.reconcile(context.Background())

	if _, ok := scaler.runners.idle["flappy"]; !ok {
		t.Fatal("runner reaped using unavailability it had already recovered from")
	}
}

package main

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v4"
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

func TestInstallationTokenSourceSignsAndCachesAppToken(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	privateKey := pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)})
	now := time.Now().UTC()
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		if r.Method != http.MethodPost || r.URL.Path != "/app/installations/42/access_tokens" {
			t.Fatalf("request = %s %s", r.Method, r.URL.Path)
		}
		rawJWT := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		parsed, err := jwt.ParseWithClaims(rawJWT, &jwt.RegisteredClaims{}, func(token *jwt.Token) (any, error) {
			return &key.PublicKey, nil
		})
		if err != nil || !parsed.Valid {
			t.Fatalf("invalid app JWT: %v", err)
		}
		claims := parsed.Claims.(*jwt.RegisteredClaims)
		if claims.Issuer != "client-id" {
			t.Fatalf("issuer = %q", claims.Issuer)
		}
		w.WriteHeader(http.StatusCreated)
		_, _ = fmt.Fprintf(w, `{"token":"installation-token","expires_at":%q}`, now.Add(time.Hour).Format(time.RFC3339))
	}))
	defer server.Close()

	source, err := newInstallationTokenSource("client-id", 42, string(privateKey), server.URL, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	source.now = func() time.Time { return now }

	first, err := source.Token(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	second, err := source.Token(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if first != "installation-token" || second != first || requests != 1 {
		t.Fatalf("tokens/requests = %q/%q/%d", first, second, requests)
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

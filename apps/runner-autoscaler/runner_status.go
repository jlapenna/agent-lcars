package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	runnerStatusPollInterval = time.Minute
	runnerStartupGracePeriod = 5 * time.Minute
	runnerStatusHTTPTimeout  = 15 * time.Second
)

// runnerUnavailableReapAfter is how long a tracked runner must stay
// continuously unavailable to GitHub before this control plane destroys it.
//
// An idle runner GitHub reports offline (or stops listing) is unusable: GitHub
// will never dispatch to it, while this side keeps counting it toward
// runners_total and therefore satisfies desired_runners with it. Neither side
// times that out on its own, so the queued job it was meant to serve waits
// indefinitely -- three and a half hours in the 2026-08-16 incident, ended only
// by removing the container by hand. Both views were internally consistent,
// which is why nothing self-corrected.
//
// Ten minutes is deliberately well past a transient blip: it sits on top of the
// five-minute startup grace above, and the poll runs every minute, so a reap
// needs ten consecutive confirmations of the same verdict.
const runnerUnavailableReapAfter = 10 * time.Minute

const (
	runnerUnavailableOffline = "offline"
	runnerUnavailableMissing = "missing"
)

type runnerStatusSource interface {
	ListRunnerStatuses(context.Context, map[string]struct{}) (map[string]string, error)
}

type githubRunnerStatusClient struct {
	apiBaseURL  string
	runnersPath string
	httpClient  *http.Client
	tokenSource bearerTokenSource
}

type githubRunnerStatusList struct {
	TotalCount int `json:"total_count"`
	Runners    []struct {
		Name   string `json:"name"`
		Status string `json:"status"`
	} `json:"runners"`
}

func newGitHubRunnerStatusClient(c Config) (*githubRunnerStatusClient, error) {
	apiBaseURL, runnersPath, err := runnerStatusEndpoint(c.RegistrationURL)
	if err != nil {
		return nil, err
	}
	httpClient := &http.Client{Timeout: runnerStatusHTTPTimeout}

	var tokens bearerTokenSource
	if c.GitHubApp.Validate() == nil {
		tokens, err = newInstallationTokenSource(c.GitHubApp.ClientID, c.GitHubApp.InstallationID, c.GitHubApp.PrivateKey, apiBaseURL, httpClient)
		if err != nil {
			return nil, fmt.Errorf("creating GitHub App token source: %w", err)
		}
	} else if c.Token != "" {
		tokens = staticBearerToken(c.Token)
	} else {
		return nil, fmt.Errorf("runner status client requires GitHub App credentials or a token")
	}

	return &githubRunnerStatusClient{
		apiBaseURL:  apiBaseURL,
		runnersPath: runnersPath,
		httpClient:  httpClient,
		tokenSource: tokens,
	}, nil
}

// runnerStatusEndpoint maps the same organization/repository registration URL
// used by actions/scaleset to GitHub's public runner-status endpoint. The
// scale-set service's GetRunnerByName response carries registration identity
// but not the online/offline state, so it cannot detect #230 by itself.
func runnerStatusEndpoint(registrationURL string) (string, string, error) {
	u, err := url.Parse(registrationURL)
	if err != nil {
		return "", "", fmt.Errorf("parsing registration URL: %w", err)
	}
	if u.Scheme == "" || u.Host == "" {
		return "", "", fmt.Errorf("registration URL must include a scheme and host")
	}
	parts := strings.Split(strings.Trim(u.Path, "/"), "/")
	var runnersPath string
	switch len(parts) {
	case 1:
		if parts[0] == "" {
			return "", "", fmt.Errorf("registration URL must identify an organization or repository")
		}
		runnersPath = "/orgs/" + url.PathEscape(parts[0]) + "/actions/runners"
	case 2:
		runnersPath = "/repos/" + url.PathEscape(parts[0]) + "/" + url.PathEscape(parts[1]) + "/actions/runners"
	default:
		return "", "", fmt.Errorf("registration URL path must be /owner or /owner/repository")
	}

	apiBaseURL := u.Scheme + "://" + u.Host
	if strings.EqualFold(u.Hostname(), "github.com") {
		apiBaseURL = "https://api.github.com"
	} else {
		apiBaseURL += "/api/v3"
	}
	return apiBaseURL, runnersPath, nil
}

// ListRunnerStatuses fetches one registration-scoped page stream and stops
// once every locally tracked runner has been found. It never issues one
// request per runner and is called by one monitor per registration, not by
// Prometheus scrapes or by each scale set.
func (c *githubRunnerStatusClient) ListRunnerStatuses(ctx context.Context, wanted map[string]struct{}) (map[string]string, error) {
	found := make(map[string]string, len(wanted))
	if len(wanted) == 0 {
		return found, nil
	}

	token, err := c.tokenSource.Token(ctx)
	if err != nil {
		return nil, fmt.Errorf("getting GitHub token: %w", err)
	}
	for page := 1; ; page++ {
		u, err := url.Parse(c.apiBaseURL + c.runnersPath)
		if err != nil {
			return nil, err
		}
		query := u.Query()
		query.Set("per_page", "100")
		query.Set("page", strconv.Itoa(page))
		u.RawQuery = query.Encode()

		req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
		if err != nil {
			return nil, err
		}
		req.Header.Set("Accept", "application/vnd.github+json")
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("X-GitHub-Api-Version", "2022-11-28")

		resp, err := c.httpClient.Do(req)
		if err != nil {
			return nil, fmt.Errorf("listing GitHub runners: %w", err)
		}
		if resp.StatusCode != http.StatusOK {
			statusErr := newGitHubHTTPError("listing GitHub runners", resp, time.Now())
			_ = resp.Body.Close()
			return nil, statusErr
		}
		var pageResult githubRunnerStatusList
		decodeErr := json.NewDecoder(resp.Body).Decode(&pageResult)
		_ = resp.Body.Close()
		if decodeErr != nil {
			return nil, fmt.Errorf("decoding GitHub runner list: %w", decodeErr)
		}

		for _, runner := range pageResult.Runners {
			if _, ok := wanted[runner.Name]; ok {
				found[runner.Name] = strings.ToLower(runner.Status)
			}
		}
		if len(found) == len(wanted) || len(pageResult.Runners) == 0 || page*100 >= pageResult.TotalCount {
			return found, nil
		}
	}
}

// The GitHub App installation-token source (bearerTokenSource,
// staticBearerToken, installationTokenSource) lives in github_app_token.go;
// see that file for why it stays a single hand-rolled implementation.

type trackedRunnerStatus struct {
	name      string
	host      string
	startedAt time.Time
}

func (r *runnerState) statusSnapshot() []trackedRunnerStatus {
	r.mu.Lock()
	defer r.mu.Unlock()

	out := make([]trackedRunnerStatus, 0, len(r.idle)+len(r.busy))
	for name, ref := range r.idle {
		out = append(out, trackedRunnerStatus{name: name, host: ref.host, startedAt: ref.startedAt})
	}
	for name, ref := range r.busy {
		out = append(out, trackedRunnerStatus{name: name, host: ref.host, startedAt: ref.startedAt})
	}
	return out
}

type registrationRunnerStatusMonitor struct {
	registration string
	source       runnerStatusSource
	scalers      []*Scaler
	logger       *slog.Logger
	now          func() time.Time

	// unavailableSince records when each tracked runner was first seen
	// unavailable, so reconcile can require the verdict to persist for
	// runnerUnavailableReapAfter rather than acting on one poll. Entries are
	// dropped as soon as a runner reports available again or stops being
	// tracked, so a runner that flaps never accumulates toward a reap. Only
	// reconcile touches it, and run calls reconcile from a single goroutine.
	unavailableSince map[string]time.Time
}

// reconcile fetches the latest runner statuses and updates the
// unavailable-runner gauges, returning how long run should wait before the
// next reconciliation. It normally returns runnerStatusPollInterval; on a
// GitHub rate limit (agent-lcars#321) it returns the capped, header-derived
// backoff instead so run does not keep hammering GitHub every fixed 60s
// while the limit is still in effect.
func (m *registrationRunnerStatusMonitor) reconcile(ctx context.Context) time.Duration {
	snapshots := make(map[*Scaler][]trackedRunnerStatus, len(m.scalers))
	wanted := map[string]struct{}{}
	for _, scaler := range m.scalers {
		snapshot := scaler.runners.statusSnapshot()
		snapshots[scaler] = snapshot
		for _, runner := range snapshot {
			wanted[runner.name] = struct{}{}
		}
	}

	statuses, err := m.source.ListRunnerStatuses(ctx, wanted)
	if err != nil {
		runnerStatusProbeUpGauge.WithLabelValues(m.registration).Set(0)
		var rateLimited *githubRateLimitError
		if errors.As(err, &rateLimited) {
			m.logger.Warn("GitHub runner-status reconciliation rate-limited; backing off before the next poll",
				slog.String("registration", m.registration),
				slog.String("error", err.Error()),
				slog.Duration("retry_after", rateLimited.retryAfter),
			)
			return rateLimited.retryAfter
		}
		m.logger.Warn("GitHub runner-status reconciliation failed; preserving the previous unavailable-runner gauges", slog.String("registration", m.registration), slog.String("error", err.Error()))
		return runnerStatusPollInterval
	}
	runnerStatusProbeUpGauge.WithLabelValues(m.registration).Set(1)

	now := m.now()
	if m.unavailableSince == nil {
		m.unavailableSince = map[string]time.Time{}
	}
	stillTracked := map[string]struct{}{}
	for _, scaler := range m.scalers {
		counts := map[string]map[string]int{}
		for _, host := range scaler.dockerHosts {
			counts[host.Name] = map[string]int{
				runnerUnavailableOffline: 0,
				runnerUnavailableMissing: 0,
			}
		}
		for _, runner := range snapshots[scaler] {
			if !runner.startedAt.IsZero() && now.Sub(runner.startedAt) < runnerStartupGracePeriod {
				continue
			}
			stillTracked[runner.name] = struct{}{}
			status, ok := statuses[runner.name]
			reason := ""
			switch {
			case !ok:
				reason = runnerUnavailableMissing
			case status != "online":
				reason = runnerUnavailableOffline
			}
			if reason == "" {
				delete(m.unavailableSince, runner.name)
				continue
			}
			if counts[runner.host] == nil {
				counts[runner.host] = map[string]int{}
			}
			counts[runner.host][reason]++

			since, seen := m.unavailableSince[runner.name]
			if !seen {
				m.unavailableSince[runner.name] = now
				continue
			}
			if now.Sub(since) < runnerUnavailableReapAfter {
				continue
			}
			// Reaping only takes the runner if it is still idle at this
			// instant. A busy runner is deliberately left alone: it may be
			// mid-job behind a transient GitHub API blip, and an ephemeral
			// runner that has genuinely died exits on its own for
			// reconcileRunners to collect. Destroying it here would kill a
			// live job to fix a reporting disagreement.
			if !scaler.reapUnavailableRunner(ctx, runner.name, reason) {
				continue
			}
			delete(m.unavailableSince, runner.name)
			m.logger.Warn("Destroyed an idle runner GitHub has not seen; releasing its capacity for a replacement",
				slog.String("registration", m.registration),
				slog.String("name", runner.name),
				slog.String("host", runner.host),
				slog.String("reason", reason),
				slog.Duration("unavailable_for", now.Sub(since)),
			)
		}
		for host, byReason := range counts {
			for _, reason := range []string{runnerUnavailableOffline, runnerUnavailableMissing} {
				githubUnavailableRunnersGauge.WithLabelValues(scaler.scaleSetLabel(), host, reason).Set(float64(byReason[reason]))
			}
		}
	}
	// Forget runners that are no longer tracked at all, so a name reused by a
	// later runner cannot inherit an older runner's elapsed unavailability and
	// be reaped early.
	for name := range m.unavailableSince {
		if _, ok := stillTracked[name]; !ok {
			delete(m.unavailableSince, name)
		}
	}
	return runnerStatusPollInterval
}

// run drives periodic reconciliation using a resettable timer rather than a
// fixed-interval ticker, so a GitHub rate limit (agent-lcars#321) can push
// the next attempt out past the normal runnerStatusPollInterval instead of
// retrying every 60s regardless of what GitHub asked for.
func (m *registrationRunnerStatusMonitor) run(ctx context.Context) {
	delay := m.reconcile(ctx)
	timer := time.NewTimer(delay)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			delay = m.reconcile(ctx)
			timer.Reset(delay)
		}
	}
}

func startGitHubRunnerStatusMonitors(ctx context.Context, runtimes []*scaleSetRuntime, logger *slog.Logger, wg *sync.WaitGroup) {
	type registrationGroup struct {
		config  Config
		scalers []*Scaler
	}
	groups := map[string]*registrationGroup{}
	for _, runtime := range runtimes {
		group := groups[runtime.config.RegistrationName]
		if group == nil {
			group = &registrationGroup{config: runtime.config}
			groups[runtime.config.RegistrationName] = group
		}
		group.scalers = append(group.scalers, runtime.scaler)
	}

	for registration, group := range groups {
		source, err := newGitHubRunnerStatusClient(group.config)
		if err != nil {
			runnerStatusProbeUpGauge.WithLabelValues(registration).Set(0)
			logger.Error("Could not initialize GitHub runner-status monitor", slog.String("registration", registration), slog.String("error", err.Error()))
			continue
		}
		monitor := &registrationRunnerStatusMonitor{
			registration: registration,
			source:       source,
			scalers:      group.scalers,
			logger:       logger.With("component", "runner-status-monitor"),
			now:          time.Now,
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			monitor.run(ctx)
		}()
	}
}

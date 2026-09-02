package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Ghost runner registrations (agent-lcars#1725)
//
// A JIT runner registration can outlive its container: the host it ran on
// disappears from fleet config, an orphan-cleanup pass removes a non-exited
// container, the process is OOM-killed, or the control plane restarts
// between GenerateJitRunnerConfig registering the name and the container
// ever starting (deregisterRunner's doc comment covers the paths this
// control plane can detect directly). Whenever the in-memory tracking
// itself is the thing that is lost -- most concretely, a checkpoint restart
// silently drops any runner whose backing container isn't rediscovered by
// cleanupOrphans' boot pass, e.g. because its host was renamed or removed
// from fleet config -- there is no removal event left to hang a
// deregisterRunner call off of. GitHub still counts the registration
// "registered", still appears to hand it jobs, and every job for that lane
// strands for its retry cycle. This is exactly what happened to
// runner-homelab-autoscale-homelab-ci-268b9908 (jlapenna/homelab#7809):
// offline, no container anywhere on the fleet, and no trace in recent
// controller logs -- a registration whose container had been gone long
// enough that nothing about it survived a restart.
//
// The periodic sweep below is the independent safety net for that class: it
// asks GitHub directly, per registration, which runners exist, and deletes
// any that are offline, idle, not one of the runners this scale set is
// currently tracking, and have looked that way for at least
// ghostRunnerMinAge -- long enough that a runner still inside
// startRunner's create-container/start-container window (registered, but
// not yet in a.runners) is never mistaken for a ghost.
//
// Listing scope: GitHub's runner list is scoped to where the registration
// lives -- /repos/{owner}/{repo}/actions/runners for a repository
// registration, /orgs/{org}/actions/runners for an organization one -- the
// same split runnerStatusEndpoint already makes for the existing
// runner-status monitor (agent-lcars#321), and the only scope this
// control plane's GitHub App can act on: it holds administration:write on
// the installed repositories, not the broader org-level runners permission,
// and this sweep must never ask for that to be widened (see AGENTS.md).
// That repo-level scope is not universal, though: supersprinklesracing's
// scale set is registered against its repository URL, yet
// GET /repos/supersprinklesracing/sprinkles/actions/runners returns
// total_count=0 even while that scale set is busy (verified live,
// 2026-09-02) -- some registrations' runners are simply not enumerable at
// repo scope with this App's permissions, and there is no alternate scope
// the App can reach instead (the scale-set-scoped listing the
// github.com/actions/scaleset library exposes -- GetRunnerByName's
// underlying pool endpoint -- is reachable, but its RunnerReference type
// carries no status/busy field to detect a ghost with). Rather than guess,
// ghostRunnerSweeper detects the mismatch directly: when a registration's
// listing comes back with fewer runners than this process currently tracks
// as running for it, ghost detection for that pass is skipped and a warning
// names the registration, so the gap is visible in logs/metrics instead of
// silently deleting nothing forever. Operationally this means sprinkles'
// registration cannot be swept until it (or its App installation) is
// reconfigured for repo-scope visibility -- a follow-up outside this
// change's App-permission constraint.
const (
	// ghostSweepInterval is how often each registration's runner list is
	// checked for ghosts. Five minutes: frequent enough that a genuine ghost
	// (which otherwise strands every job for its lane) doesn't sit for long,
	// infrequent enough that it costs one paginated GitHub REST call per
	// registration per interval.
	ghostSweepInterval = 5 * time.Minute
	// ghostRunnerMinAge is how long a runner must have looked like a ghost
	// (offline, idle, untracked) across consecutive sweeps before this
	// control plane deletes its registration. It exists so a runner that is
	// mid-flight through startRunner -- GenerateJitRunnerConfig has
	// registered it with GitHub, but ContainerCreate/ContainerStart hasn't
	// finished, so it is not yet in a.runners -- is never raced: the very
	// first sweep to observe such a runner only starts its clock, and only a
	// later sweep that still finds it a ghost acts. Two minutes comfortably
	// exceeds an ordinary container start.
	ghostRunnerMinAge = 2 * time.Minute
)

// ghostRunnerRecord is one entry from a registration-scoped GitHub runner
// listing, carrying exactly the fields the sweep needs to judge a ghost.
type ghostRunnerRecord struct {
	ID     int
	Name   string
	Status string
	Busy   bool
}

// ghostRunnerSource lists and deletes runner registrations for one GitHub
// registration scope. githubRunnerStatusClient implements it by reusing the
// same REST endpoint (and GitHub App/PAT auth) the runner-status monitor
// already resolves per registration -- see runnerStatusEndpoint.
type ghostRunnerSource interface {
	ListAllRunners(ctx context.Context) ([]ghostRunnerRecord, error)
	DeleteRunner(ctx context.Context, id int) error
}

// githubRunnerListPageURL builds one page of a registration-scoped runner
// listing request, matching ListRunnerStatuses' own query construction.
func githubRunnerListPageURL(apiBaseURL, runnersPath string, page int) (string, error) {
	u, err := url.Parse(apiBaseURL + runnersPath)
	if err != nil {
		return "", err
	}
	query := u.Query()
	query.Set("per_page", "100")
	query.Set("page", strconv.Itoa(page))
	u.RawQuery = query.Encode()
	return u.String(), nil
}

// decodeAndClose decodes resp's JSON body into v and always closes it,
// however decoding turns out.
func decodeAndClose(resp *http.Response, v any) error {
	defer resp.Body.Close()
	return json.NewDecoder(resp.Body).Decode(v)
}

// ListAllRunners fetches every runner GitHub lists for this registration
// scope, unfiltered -- unlike ListRunnerStatuses, which stops as soon as a
// caller-supplied set of names has all been found, this always walks every
// page, since the sweep needs to see registrations this process has never
// heard of.
func (c *githubRunnerStatusClient) ListAllRunners(ctx context.Context) ([]ghostRunnerRecord, error) {
	token, err := c.tokenSource.Token(ctx)
	if err != nil {
		return nil, fmt.Errorf("getting GitHub token: %w", err)
	}

	var all []ghostRunnerRecord
	for page := 1; ; page++ {
		u, err := githubRunnerListPageURL(c.apiBaseURL, c.runnersPath, page)
		if err != nil {
			return nil, err
		}

		req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
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
		decodeErr := decodeAndClose(resp, &pageResult)
		if decodeErr != nil {
			return nil, fmt.Errorf("decoding GitHub runner list: %w", decodeErr)
		}

		for _, runner := range pageResult.Runners {
			all = append(all, ghostRunnerRecord{
				ID:     runner.ID,
				Name:   runner.Name,
				Status: strings.ToLower(runner.Status),
				Busy:   runner.Busy,
			})
		}
		if len(pageResult.Runners) == 0 || page*100 >= pageResult.TotalCount {
			return all, nil
		}
	}
}

// DeleteRunner deletes a runner registration by ID from this registration's
// scope -- the same operation, and the same administration:write permission,
// as the manual `DELETE /repos/{owner}/{repo}/actions/runners/{id}` recovery
// this sweep automates (jlapenna/homelab#7809).
func (c *githubRunnerStatusClient) DeleteRunner(ctx context.Context, id int) error {
	token, err := c.tokenSource.Token(ctx)
	if err != nil {
		return fmt.Errorf("getting GitHub token: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, c.apiBaseURL+c.runnersPath+"/"+strconv.Itoa(id), nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("deleting GitHub runner: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		return newGitHubHTTPError("deleting GitHub runner", resp, time.Now())
	}
	return nil
}

// runnerNamePrefix is the fixed, unique-per-scale-set prefix startRunner
// mints every JIT runner's GitHub name (== Docker container name) under --
// see startRunner's `fmt.Sprintf("runner-%s-%s", ...)`. Matching a GitHub
// runner name against this prefix is how the sweep attributes a foreign
// registration listing back to one of this process's own scale sets without
// ever touching a runner it did not create.
func runnerNamePrefix(scaleSetName string) string {
	return "runner-" + dockerSafeNamePart(scaleSetName) + "-"
}

// scalerForGhostName finds which scaler (if any) owns name, by the longest
// matching runnerNamePrefix. Longest match, not first match, because one
// scale set's sanitized name can be a prefix of another's (e.g. "ci" and
// "ci-build" both yield prefixes that match a "ci-build-<uuid>" runner name)
// -- the more specific prefix is always the correct owner. Returns nil for a
// name this process did not mint, e.g. a manually registered runner or one
// belonging to a scale set this process no longer configures.
func scalerForGhostName(scalers []*Scaler, name string) *Scaler {
	var best *Scaler
	bestLen := -1
	for _, scaler := range scalers {
		prefix := runnerNamePrefix(scaler.scaleSetName)
		if strings.HasPrefix(name, prefix) && len(prefix) > bestLen {
			best = scaler
			bestLen = len(prefix)
		}
	}
	return best
}

// ghostRunnerSweeper periodically reconciles one GitHub registration's
// runner list against this process's own tracked runners, deleting
// registrations that meet every ghost criterion. One sweeper covers every
// scale set sharing a registration, mirroring
// registrationRunnerStatusMonitor's grouping.
type ghostRunnerSweeper struct {
	registration string
	source       ghostRunnerSource
	scalers      []*Scaler
	logger       *slog.Logger
	now          func() time.Time

	// candidateSince records when each runner name was first observed as a
	// ghost candidate (offline, idle, untracked), so a sweep only acts once
	// that has held for ghostRunnerMinAge across sweeps -- see
	// ghostRunnerMinAge's doc comment. Only sweep touches it, and run calls
	// sweep from a single goroutine.
	candidateSince map[string]time.Time
}

// sweep lists this registration's runners and deletes every ghost, updating
// the ghost gauges/counter and logging one line per deletion plus one
// summary line per pass (so "no ghosts found" is as visible in logs as an
// actual deletion).
func (s *ghostRunnerSweeper) sweep(ctx context.Context) {
	runners, err := s.source.ListAllRunners(ctx)
	if err != nil {
		s.logger.Warn("Ghost runner sweep failed to list registered runners; leaving previous ghost gauges in place",
			slog.String("registration", s.registration), slog.String("error", err.Error()))
		return
	}

	trackedCount := 0
	for _, scaler := range s.scalers {
		trackedCount += scaler.runners.count()
	}
	if len(runners) == 0 && trackedCount > 0 {
		s.logger.Warn("Ghost runner sweep found GitHub listing empty for a registration with locally tracked runners; its listing scope likely does not cover this registration (see README's ghost-sweep section) -- skipping ghost detection this pass",
			slog.String("registration", s.registration), slog.Int("tracked_runners", trackedCount))
		return
	}

	if s.candidateSince == nil {
		s.candidateSince = map[string]time.Time{}
	}
	now := s.now()
	seen := map[string]bool{}
	found := map[string]int{}
	deleted := map[string]int{}
	for _, scaler := range s.scalers {
		found[scaler.scaleSetLabel()] = 0
	}

	for _, runner := range runners {
		scaler := scalerForGhostName(s.scalers, runner.Name)
		if scaler == nil {
			// Not a runner this process minted (manually registered, or
			// belongs to a scale set no longer configured here) -- never
			// touch it.
			continue
		}
		if runner.Status != "offline" || runner.Busy || scaler.runners.isTracked(runner.Name) {
			delete(s.candidateSince, runner.Name)
			continue
		}

		seen[runner.Name] = true
		since, ok := s.candidateSince[runner.Name]
		if !ok {
			s.candidateSince[runner.Name] = now
			continue
		}
		age := now.Sub(since)
		if age < ghostRunnerMinAge {
			continue
		}

		label := scaler.scaleSetLabel()
		found[label]++
		if err := s.source.DeleteRunner(ctx, runner.ID); err != nil {
			s.logger.Warn("Failed to delete ghost runner registration; will retry on the next sweep",
				slog.String("registration", s.registration), slog.String("scale_set", label),
				slog.String("name", runner.Name), slog.Int("id", runner.ID), slog.String("error", err.Error()))
			continue
		}
		delete(s.candidateSince, runner.Name)
		deleted[label]++
		ghostRunnersDeletedTotal.WithLabelValues(label).Inc()
		s.logger.Info("Deleted ghost runner registration",
			slog.String("registration", s.registration), slog.String("scale_set", label),
			slog.String("name", runner.Name), slog.Int("id", runner.ID), slog.Duration("age", age))
	}

	// A candidate that vanished from this listing entirely (deleted by
	// someone else, or GitHub already expired it) must not keep counting
	// toward a future age check under a reused name.
	for name := range s.candidateSince {
		if !seen[name] {
			delete(s.candidateSince, name)
		}
	}

	totalFound, totalDeleted := 0, 0
	for _, scaler := range s.scalers {
		label := scaler.scaleSetLabel()
		ghostRunnersGauge.WithLabelValues(label).Set(float64(found[label]))
		totalFound += found[label]
		totalDeleted += deleted[label]
	}
	s.logger.Info("Ghost runner sweep complete",
		slog.String("registration", s.registration), slog.Int("runners_checked", len(runners)),
		slog.Int("ghosts_found", totalFound), slog.Int("ghosts_deleted", totalDeleted))
}

// run drives periodic sweeps on a fixed ghostSweepInterval ticker until ctx
// is done, sweeping once immediately so a fresh process doesn't wait a full
// interval for its first pass.
func (s *ghostRunnerSweeper) run(ctx context.Context) {
	s.sweep(ctx)
	ticker := time.NewTicker(ghostSweepInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.sweep(ctx)
		}
	}
}

// startGhostRunnerSweepers groups runtimes by GitHub registration (the same
// grouping startGitHubRunnerStatusMonitors uses) and starts one sweeper
// goroutine per registration.
func startGhostRunnerSweepers(ctx context.Context, runtimes []*scaleSetRuntime, logger *slog.Logger, wg *sync.WaitGroup) {
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
			logger.Error("Could not initialize ghost runner sweeper", slog.String("registration", registration), slog.String("error", err.Error()))
			continue
		}
		sweeper := &ghostRunnerSweeper{
			registration: registration,
			source:       source,
			scalers:      group.scalers,
			logger:       logger.With("component", "ghost-runner-sweeper"),
			now:          time.Now,
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			sweeper.run(ctx)
		}()
	}
}

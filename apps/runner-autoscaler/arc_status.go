package main

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Deployment configuration derives these endpoints from its authoritative ARC
// lane model. The console never reaches into the private cluster or Prometheus.
type arcLaneConfig struct {
	Name            string `yaml:"name"`
	RegistrationURL string `yaml:"registration_url"`
	MetricsURL      string `yaml:"metrics_url"`
}

type consoleARCLaneStatus struct {
	SchemaVersion int    `firestore:"schemaVersion"`
	Kind          string `firestore:"kind"`
	Lane          string `firestore:"lane"`
	// Sorted, comma-separated DNS-label names from authoritative deployment
	// configuration. A surviving producer still identifies a missing lane
	// after its document has expired or before its first successful scrape.
	ExpectedLanes     string    `firestore:"expectedLanes"`
	RegistrationURL   string    `firestore:"registrationUrl"`
	AssignedJobs      int       `firestore:"assignedJobs"`
	RunningJobs       int       `firestore:"runningJobs"`
	PendingJobs       int       `firestore:"pendingJobs"`
	IdleRunners       int       `firestore:"idleRunners"`
	RegisteredRunners int       `firestore:"registeredRunners"`
	DesiredRunners    int       `firestore:"desiredRunners"`
	MinRunners        int       `firestore:"minRunners"`
	MaxRunners        int       `firestore:"maxRunners"`
	UpdatedAt         string    `firestore:"updatedAt"`
	ExpireAt          time.Time `firestore:"expireAt"`
}

func validateARCLanes(lanes []arcLaneConfig) error {
	if len(lanes) > 64 {
		return fmt.Errorf("arc_lanes supports at most 64 lanes")
	}
	seen := map[string]bool{}
	validName := regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`)
	for i, lane := range lanes {
		if !validName.MatchString(lane.Name) || seen[lane.Name] {
			return fmt.Errorf("arc_lanes[%d] requires a unique DNS-label name", i)
		}
		seen[lane.Name] = true
		for name, value := range map[string]string{"registration_url": lane.RegistrationURL, "metrics_url": lane.MetricsURL} {
			u, err := url.ParseRequestURI(value)
			if err != nil || u.Host == "" || u.User != nil || (u.Scheme != "http" && u.Scheme != "https") {
				return fmt.Errorf("arc_lanes[%d].%s requires an absolute HTTP(S) URL without credentials", i, name)
			}
		}
	}
	return nil
}

// A failed, incomplete, or ambiguous scrape never refreshes a lane's timestamp.
// Its last good document therefore expires instead of showing a plausible zero.
func fetchARCLaneStatus(ctx context.Context, client *http.Client, lane arcLaneConfig, now time.Time) (consoleARCLaneStatus, error) {
	var status consoleARCLaneStatus
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, lane.MetricsURL, nil)
	if err != nil {
		return status, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return status, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return status, fmt.Errorf("ARC metrics returned HTTP %d", resp.StatusCode)
	}
	const maxBody = 1024 * 1024
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxBody+1))
	if err != nil {
		return status, err
	}
	if len(body) > maxBody {
		return status, fmt.Errorf("ARC metrics response exceeds 1 MiB")
	}
	values := map[string]int{}
	wanted := map[string]bool{}
	for _, name := range []string{"assigned_jobs", "running_jobs", "idle_runners", "registered_runners", "desired_runners", "min_runners", "max_runners"} {
		wanted["gha_"+name] = true
	}
	scanner := bufio.NewScanner(strings.NewReader(string(body)))
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if strings.HasPrefix(line, "#") {
			continue
		}
		name, rest, ok := splitPrometheusSample(line)
		if !ok || !wanted[name] {
			continue
		}
		if _, duplicate := values[name]; duplicate {
			return status, fmt.Errorf("ARC metric %s has multiple samples", name)
		}
		fields := strings.Fields(rest)
		if len(fields) == 0 {
			return status, fmt.Errorf("ARC metric %s has no value", name)
		}
		value, err := strconv.ParseFloat(fields[0], 64)
		if err != nil || math.IsNaN(value) || math.IsInf(value, 0) || value < 0 || value > math.MaxInt32 || value != math.Trunc(value) {
			return status, fmt.Errorf("ARC metric %s is not a nonnegative count", name)
		}
		values[name] = int(value)
	}
	if err := scanner.Err(); err != nil {
		return status, err
	}
	if len(values) != len(wanted) {
		return status, fmt.Errorf("ARC listener has incomplete capacity metrics")
	}
	pending := max(0, values["gha_assigned_jobs"]-values["gha_running_jobs"])
	return consoleARCLaneStatus{
		SchemaVersion: 3, Kind: "arc-lane", Lane: lane.Name, RegistrationURL: lane.RegistrationURL,
		AssignedJobs: values["gha_assigned_jobs"], RunningJobs: values["gha_running_jobs"], PendingJobs: pending,
		IdleRunners: values["gha_idle_runners"], RegisteredRunners: values["gha_registered_runners"], DesiredRunners: values["gha_desired_runners"],
		MinRunners: values["gha_min_runners"], MaxRunners: values["gha_max_runners"],
		UpdatedAt: now.UTC().Format(time.RFC3339Nano), ExpireAt: now.Add(consoleStatusTTL),
	}, nil
}

func runARCLaneStatusPublisher(ctx context.Context, publisher consoleStatusPublisher, lanes []arcLaneConfig, logger *slog.Logger) {
	if !publisher.Enabled() || len(lanes) == 0 {
		return
	}
	client := &http.Client{Timeout: consoleStatusTimeout, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	expectedLanes := configuredARCLaneNames(lanes)
	publish := func() {
		var wg sync.WaitGroup
		// Configuration caps this fan-out, with one bounded fetch per lane.
		for _, lane := range lanes {
			wg.Go(func() {
				fetchCtx, cancel := context.WithTimeout(ctx, consoleStatusTimeout)
				defer cancel()
				status, err := fetchARCLaneStatus(fetchCtx, client, lane, time.Now())
				if err != nil {
					logger.Warn("ARC lane status unavailable", slog.String("lane", lane.Name), slog.Any("error", err))
					return
				}
				status.ExpectedLanes = expectedLanes
				publisher.PublishARCLane(ctx, status)
			})
		}
		wg.Wait()
	}
	publish()
	ticker := time.NewTicker(consoleStatusInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			publish()
		}
	}
}

func configuredARCLaneNames(lanes []arcLaneConfig) string {
	names := make([]string, len(lanes))
	for i, lane := range lanes {
		names[i] = lane.Name
	}
	sort.Strings(names)
	return strings.Join(names, ",")
}

// splitPrometheusSample splits one exposition line into its metric name and
// everything after it (the value, and an optional trailing timestamp).
// Splitting the whole line on whitespace would misparse a labeled sample whose
// label value itself contains a space followed by a number: in
// `metric{reason="on 1 battery"} 0` the second whitespace field is "1", not
// the real value "0". Treating everything after the last '}' as the value
// avoids that, and a line with no labels falls back to the first whitespace.
func splitPrometheusSample(line string) (name, rest string, ok bool) {
	braceIdx := strings.IndexByte(line, '{')
	spaceIdx := strings.IndexAny(line, " \t")
	if braceIdx < 0 || (spaceIdx >= 0 && spaceIdx < braceIdx) {
		if spaceIdx < 0 {
			return "", "", false
		}
		return line[:spaceIdx], line[spaceIdx+1:], true
	}
	closeIdx := strings.LastIndexByte(line, '}')
	if closeIdx < braceIdx {
		return "", "", false
	}
	return line[:braceIdx], line[closeIdx+1:], true
}

package main

import (
	"regexp"
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus"
)

// repositoryAgentObservation is the repository-owned agent catalog health on
// the authenticated maintenance reply (docs/repository-agents.md). It carries
// repository names and timestamps only; no agent names, errors or messages.
type repositoryAgentObservation struct {
	Version    int                       `json:"version"`
	ObservedAt string                    `json:"observedAt"`
	Agents     *repositoryAgentCounts    `json:"agents"`
	Sources    []repositoryAgentSourceIn `json:"sources"`
}

type repositoryAgentCounts struct {
	Enabled     *uint64 `json:"enabled"`
	Vetoed      *uint64 `json:"vetoed"`
	Invalid     *uint64 `json:"invalid"`
	Unavailable *uint64 `json:"unavailable"`
	Removed     *uint64 `json:"removed"`
}

type repositoryAgentSourceIn struct {
	Repository  string  `json:"repository"`
	AttemptedAt string  `json:"attemptedAt"`
	SucceededAt string  `json:"succeededAt"`
	FailedAt    string  `json:"failedAt"`
	Unavailable *uint64 `json:"unavailable"`
}

// The control-plane repository list is operator configuration, so a
// repository label is a bounded category; this caps it defensively.
const repositoryAgentSourceLimit = 200

var repositoryNamePattern = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$`)

type repositoryAgentMetrics struct {
	mu            sync.RWMutex
	snapshot      *repositoryAgentObservation
	readAvailable bool
	desc          map[string]*prometheus.Desc
}

func newRepositoryAgentMetrics() *repositoryAgentMetrics {
	m := &repositoryAgentMetrics{desc: map[string]*prometheus.Desc{}}
	m.desc["read_available"] = prometheus.NewDesc("lcars_repository_agents_read_available", "One when the latest maintenance reply carried a valid repository agent catalog observation; cached data may be stale.", nil, nil)
	m.desc["observed_timestamp_seconds"] = prometheus.NewDesc("lcars_repository_agents_observed_timestamp_seconds", "Server time of the cached catalog observation; never replaced by scrape time.", nil, nil)
	m.desc["agents"] = prometheus.NewDesc("lcars_repository_agents", "Cataloged repository-owned agents by admission state: enabled, vetoed, invalid, unavailable (source refresh failed) or removed.", []string{"state"}, nil)
	m.desc["attempt"] = prometheus.NewDesc("lcars_repository_agent_source_last_attempt_timestamp_seconds", "Last catalog refresh attempt of a repository's .lcars/agents; zero means never.", []string{"repository"}, nil)
	m.desc["success"] = prometheus.NewDesc("lcars_repository_agent_source_last_success_timestamp_seconds", "Last published catalog refresh that read the repository successfully; zero means never.", []string{"repository"}, nil)
	m.desc["unavailable"] = prometheus.NewDesc("lcars_repository_agent_source_unavailable_agents", "A repository's stored agents currently disabled by a failed refresh; absent from an older Console.", []string{"repository"}, nil)
	m.desc["failure"] = prometheus.NewDesc("lcars_repository_agent_source_last_failure_timestamp_seconds", "Last published catalog refresh that failed to read the repository; zero means never.", []string{"repository"}, nil)
	return m
}

var repositoryAgentsMetrics = newRepositoryAgentMetrics()

// record caches a valid observation. An invalid or missing one clears
// read_available but keeps the last good snapshot visible with its own
// observed timestamp, so staleness shows instead of a healthy zero.
func (m *repositoryAgentMetrics) record(o *repositoryAgentObservation, now time.Time) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.readAvailable = validRepositoryAgentObservation(o, now)
	if m.readAvailable {
		m.snapshot = o
	}
	return m.readAvailable
}

func validRepositoryAgentObservation(o *repositoryAgentObservation, now time.Time) bool {
	if o == nil || o.Version != 1 || o.Agents == nil || len(o.Sources) > repositoryAgentSourceLimit {
		return false
	}
	if _, ok := observationTime(o.ObservedAt, false, now); !ok {
		return false
	}
	a := o.Agents
	for _, v := range []*uint64{a.Enabled, a.Vetoed, a.Invalid, a.Unavailable, a.Removed} {
		if v == nil || *v > 9007199254740991 {
			return false
		}
	}
	seen := map[string]bool{}
	for _, s := range o.Sources {
		if !repositoryNamePattern.MatchString(s.Repository) || seen[s.Repository] {
			return false
		}
		seen[s.Repository] = true
		if s.Unavailable != nil && *s.Unavailable > 9007199254740991 {
			return false
		}
		for _, value := range []string{s.AttemptedAt, s.SucceededAt, s.FailedAt} {
			if _, ok := observationTime(value, true, now); !ok {
				return false
			}
		}
	}
	return true
}

// observationTime parses an RFC 3339 server time no later than now plus
// clock skew. With optional, an empty value is zero ("never").
func observationTime(value string, optional bool, now time.Time) (float64, bool) {
	if value == "" {
		return 0, optional
	}
	t, err := time.Parse(time.RFC3339Nano, value)
	if err != nil || t.Unix() <= 0 || t.After(now.Add(30*time.Second)) {
		return 0, false
	}
	return float64(t.Unix()), true
}

func (m *repositoryAgentMetrics) Describe(ch chan<- *prometheus.Desc) {
	for _, desc := range m.desc {
		ch <- desc
	}
}

func (m *repositoryAgentMetrics) Collect(ch chan<- prometheus.Metric) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	emit := func(name string, value float64, labels ...string) {
		ch <- prometheus.MustNewConstMetric(m.desc[name], prometheus.GaugeValue, value, labels...)
	}
	available := 0.0
	if m.readAvailable {
		available = 1
	}
	emit("read_available", available)
	o := m.snapshot
	if o == nil {
		return
	}
	// Validated at record time; Collect only converts.
	unix := func(value string) float64 {
		if value == "" {
			return 0
		}
		t, _ := time.Parse(time.RFC3339Nano, value)
		return float64(t.Unix())
	}
	observed := unix(o.ObservedAt)
	emit("observed_timestamp_seconds", observed)
	a := o.Agents
	for state, value := range map[string]*uint64{"enabled": a.Enabled, "vetoed": a.Vetoed, "invalid": a.Invalid, "unavailable": a.Unavailable, "removed": a.Removed} {
		emit("agents", float64(*value), state)
	}
	for _, s := range o.Sources {
		emit("attempt", unix(s.AttemptedAt), s.Repository)
		emit("success", unix(s.SucceededAt), s.Repository)
		emit("failure", unix(s.FailedAt), s.Repository)
		if s.Unavailable != nil {
			emit("unavailable", float64(*s.Unavailable), s.Repository)
		}
	}
}

package main

import (
	"math"
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus"
)

// This is the aggregate metadata contract on the existing authenticated
// maintenance reply. It carries no names, payloads, resource paths or tokens.
type jobCredentialObservation struct {
	Version                 int                  `json:"version"`
	ObservedAt              string               `json:"observedAt"`
	Configured              *bool                `json:"configured"`
	MetadataAvailable       *bool                `json:"metadataAvailable"`
	Dependency              string               `json:"dependency"`
	Counts                  *jobCredentialCounts `json:"counts"`
	Deliveries              *uint64              `json:"deliveries"`
	DeliveryTimed           *uint64              `json:"deliveryTimed"`
	DeliveryDurationSeconds *float64             `json:"deliveryDurationSeconds"`
	AdmissionRefusals       *uint64              `json:"admissionRefusals"`
	DeliveryRefusals        *uint64              `json:"deliveryRefusals"`
	LastDeliveryAt          string               `json:"lastDeliveryAt"`
	LastRefusalAt           string               `json:"lastRefusalAt"`
}

type jobCredentialCounts struct {
	Total      *uint64 `json:"total"`
	Ready      *uint64 `json:"ready"`
	Disabled   *uint64 `json:"disabled"`
	Unpromoted *uint64 `json:"unpromoted"`
	Expired    *uint64 `json:"expired"`
	Expiring   *uint64 `json:"expiring"`
	Unknown    *uint64 `json:"unknown"`
}

type jobCredentialMetrics struct {
	mu            sync.RWMutex
	snapshot      *jobCredentialObservation
	readAvailable bool
	desc          map[string]*prometheus.Desc
}

func newJobCredentialMetrics() *jobCredentialMetrics {
	m := &jobCredentialMetrics{desc: map[string]*prometheus.Desc{}}
	for name, help := range map[string]string{
		"supported":                            "One when this runner supports the job credential observation contract.",
		"read_available":                       "One when the latest maintenance reply had a valid credential observation; cached data may be stale.",
		"configured":                           "One when the Console job secret store is configured; absent before observation.",
		"metadata_available":                   "One when bounded registry and durable counter reads succeeded, not proof of secret-value access.",
		"observed_timestamp_seconds":           "Server completion time of the cached credential observation; never replaced by scrape time.",
		"last_delivery_timestamp_seconds":      "Most recent server delivery materialization time; zero means never delivered, not failed or stalled.",
		"deliveries_total":                     "Durable successful credential delivery endpoint materializations, not completed jobs or Git operations.",
		"delivery_duration_seconds_total":      "Durable sum of timed successful delivery operation durations in seconds.",
		"delivery_duration_observations_total": "Durable timed successful delivery operation count; absence of timing is not a zero latency.",
		"last_refusal_timestamp_seconds":       "Most recent durable refusal time, including refusals before the first metrics sample; zero means none.",
	} {
		m.desc[name] = prometheus.NewDesc("lcars_job_credentials_"+name, help, nil, nil)
	}
	m.desc["dependency_state"] = prometheus.NewDesc("lcars_job_credentials_dependency_state", "One-hot metadata dependency state; ready checks one rotating registered container, never its value or GitHub identity.", []string{"state"}, nil)
	m.desc["records"] = prometheus.NewDesc("lcars_job_credentials_records", "Registered metadata counts; expiring is the ready subset expiring within 24h, expired includes the minimum delivery validity window.", []string{"state"}, nil)
	m.desc["refusals_total"] = prometheus.NewDesc("lcars_job_credentials_refusals_total", "Durable refused credential operations by bounded stage, including failures before Work admission.", []string{"stage"}, nil)
	return m
}

var credentialMetrics = newJobCredentialMetrics()

func (m *jobCredentialMetrics) record(observation *jobCredentialObservation, now time.Time) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.readAvailable = validCredentialObservation(observation, now)
	if m.readAvailable {
		m.snapshot = observation
	}
	return m.readAvailable
}

func validCredentialObservation(o *jobCredentialObservation, now time.Time) bool {
	if o == nil || o.Version != 1 || o.Configured == nil || o.MetadataAvailable == nil {
		return false
	}
	observed, err := time.Parse(time.RFC3339Nano, o.ObservedAt)
	if err != nil || observed.Unix() <= 0 || observed.After(now.Add(30*time.Second)) {
		return false
	}
	noCounters := o.Counts == nil && o.Deliveries == nil && o.DeliveryTimed == nil && o.DeliveryDurationSeconds == nil && o.AdmissionRefusals == nil && o.DeliveryRefusals == nil && o.LastDeliveryAt == "" && o.LastRefusalAt == ""
	if !*o.Configured {
		return !*o.MetadataAvailable && o.Dependency == "disabled" && noCounters
	}
	if !*o.MetadataAvailable {
		return o.Dependency == "unknown" && noCounters
	}
	if o.Counts == nil || (o.Dependency != "idle" && o.Dependency != "ready" && o.Dependency != "unavailable") {
		return false
	}
	c := o.Counts
	for _, v := range []*uint64{c.Total, c.Ready, c.Disabled, c.Unpromoted, c.Expired, c.Expiring, c.Unknown} {
		if v == nil || *v > 500 {
			return false
		}
	}
	if *c.Ready+*c.Disabled+*c.Unpromoted+*c.Expired+*c.Unknown != *c.Total || *c.Expiring > *c.Ready || (o.Dependency == "idle") != (*c.Disabled == *c.Total) {
		return false
	}
	for _, v := range []*uint64{o.Deliveries, o.DeliveryTimed, o.AdmissionRefusals, o.DeliveryRefusals} {
		if v == nil || *v > 9007199254740991 {
			return false
		}
	}
	if o.DeliveryDurationSeconds == nil || math.IsNaN(*o.DeliveryDurationSeconds) || math.IsInf(*o.DeliveryDurationSeconds, 0) || *o.DeliveryDurationSeconds < 0 || *o.DeliveryDurationSeconds > 9007199254740991 || *o.DeliveryTimed > *o.Deliveries {
		return false
	}
	validClock := func(value string, present bool) bool {
		if value == "" {
			return !present
		}
		last, err := time.Parse(time.RFC3339Nano, value)
		return present && err == nil && last.Unix() > 0 && !last.After(now.Add(30*time.Second))
	}
	return validClock(o.LastDeliveryAt, *o.Deliveries > 0) && validClock(o.LastRefusalAt, *o.AdmissionRefusals > 0 || *o.DeliveryRefusals > 0)
}

func (m *jobCredentialMetrics) Describe(ch chan<- *prometheus.Desc) {
	for _, desc := range m.desc {
		ch <- desc
	}
}

func (m *jobCredentialMetrics) Collect(ch chan<- prometheus.Metric) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	emit := func(name string, kind prometheus.ValueType, value float64, labels ...string) {
		ch <- prometheus.MustNewConstMetric(m.desc[name], kind, value, labels...)
	}
	boolean := func(value bool) float64 {
		if value {
			return 1
		}
		return 0
	}
	emit("supported", prometheus.GaugeValue, 1)
	emit("read_available", prometheus.GaugeValue, boolean(m.readAvailable))
	o := m.snapshot
	if o == nil {
		return
	}
	emit("configured", prometheus.GaugeValue, boolean(*o.Configured))
	emit("metadata_available", prometheus.GaugeValue, boolean(*o.MetadataAvailable))
	observed, _ := time.Parse(time.RFC3339Nano, o.ObservedAt)
	emit("observed_timestamp_seconds", prometheus.GaugeValue, float64(observed.Unix()))
	for _, state := range []string{"disabled", "idle", "ready", "unavailable", "unknown"} {
		emit("dependency_state", prometheus.GaugeValue, boolean(o.Dependency == state), state)
	}
	if !*o.MetadataAvailable {
		return
	}
	c := o.Counts
	for state, value := range map[string]*uint64{"total": c.Total, "ready": c.Ready, "disabled": c.Disabled, "unpromoted": c.Unpromoted, "expired": c.Expired, "expiring": c.Expiring, "unknown": c.Unknown} {
		emit("records", prometheus.GaugeValue, float64(*value), state)
	}
	emit("deliveries_total", prometheus.CounterValue, float64(*o.Deliveries))
	emit("delivery_duration_seconds_total", prometheus.CounterValue, *o.DeliveryDurationSeconds)
	emit("delivery_duration_observations_total", prometheus.CounterValue, float64(*o.DeliveryTimed))
	emit("refusals_total", prometheus.CounterValue, float64(*o.AdmissionRefusals), "admission")
	emit("refusals_total", prometheus.CounterValue, float64(*o.DeliveryRefusals), "delivery")
	last := float64(0)
	if o.LastDeliveryAt != "" {
		t, _ := time.Parse(time.RFC3339Nano, o.LastDeliveryAt)
		last = float64(t.Unix())
	}
	emit("last_delivery_timestamp_seconds", prometheus.GaugeValue, last)
	last = 0
	if o.LastRefusalAt != "" {
		t, _ := time.Parse(time.RFC3339Nano, o.LastRefusalAt)
		last = float64(t.Unix())
	}
	emit("last_refusal_timestamp_seconds", prometheus.GaugeValue, last)
}

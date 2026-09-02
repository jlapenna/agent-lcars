package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// The complete set of `reason` label values placementBlocked is ever
// incremented with. Keeping them here — rather than as literals at each
// scaler.go call site — is what keeps the label bounded: a reason invented
// inline would silently add a new Prometheus time series per scale set.
const (
	placementReasonFleetLimit = "fleet_limit"
	placementReasonHostLimits = "host_limits"
	// A lower-priority scale set yielded the next safe capacity slot while a
	// higher-priority scale set had pending demand and no runner of its own.
	// This is a scheduler decision, not a host admission failure.
	placementReasonPriorityReservation = "priority_reservation"
	// Every otherwise-eligible host lacked enough physical-memory budget for
	// the candidate's declared reservation after running and in-flight runner
	// reservations plus the configured safety margin were accounted for.
	placementReasonMemoryReservation = "memory_reservation"
	// Every eligible host was withheld by its operator-defined readiness
	// gate. Distinct from unreachability: these hosts answered fine, the
	// operator's own signal said not to use them.
	placementReasonReadiness = "readiness"
	// Every reachable, within-limit host was excluded because scoreHostLoad
	// found it hard-overloaded (load/CPU/PSI/memory/swap pressure past the
	// *Hard threshold) or still inside its post-overload cooldown window --
	// see hostLoad.overloaded and applyOverloadCooldown. Deliberately
	// distinct from a host with no telemetry at all: missing telemetry only
	// adds hostLoadPolicy.telemetryPenalty (a small deprioritization) and
	// never excludes the host, because telemetry trouble must fail open, not
	// closed (see probeHostLoad).
	placementReasonOverload = "overload"
	// The host is declared with role: maintenance (agent-lcars#1696,
	// docs/fleet-scheduler-redesign.md#F) and so is never a placement
	// candidate, independent of its reachability or readiness. Recorded on
	// every probe, not just when it was the deciding factor -- unlike the
	// other per-host reasons above, a maintenance host is structurally
	// excluded rather than conditionally excluded, so the counter's rate is
	// the standing signal that host_role_info's join names it as "out".
	placementReasonMaintenance = "maintenance"
	// A host currently holds a rung-3 free-memory-floor placement (the
	// degradation ladder's floor invariant, docs/fleet-scheduler-redesign.md#D,
	// agent-lcars#1697) and so is cordoned from every rung, for every lane,
	// until that runner finishes. See FleetCoordinator.floorRunners.
	placementReasonFloorOccupied = "floor_occupied"
)

// The complete set of `rung` label values github_runner_autoscaler_placement_degraded_total
// is ever incremented with (docs/fleet-scheduler-redesign.md#D,
// agent-lcars#1697). Rung 1, the declared reservation, is the normal path
// and is never counted here -- only when it fails does the ladder walk
// rungs 2 through 4.
const (
	// Admitted on a host whose free reserved-memory budget covers the
	// lane's observed p95 usage over the configured window, instead of its
	// (larger) declared reservation.
	degradationRungObservedP95 = "observed_p95"
	// Admitted one runner on the least-loaded reachable, non-hard-pressured
	// host whose real MemAvailable exceeds the lane's ceiling, regardless of
	// declared reservations -- the floor invariant.
	degradationRungFreeMemoryFloor = "free_memory_floor"
	// No rung admitted the candidate; the placement was refused and
	// lane_admissible_slots already reads 0.
	degradationRungRefused = "refused"
)

// The complete set of `reason` label values runnerDiedIdleTotal and
// trackedRunnerMismatchTotal are ever incremented with, for the same bounded
// cardinality reason as the placementReason* constants above:
// reconcileTrackedRunners' own log message embeds a free-form container status
// string that must never reach a metric label directly.
const (
	runnerDeadReasonNotRunning = "not_running"
	runnerDeadReasonNotFound   = "not_found"
)

// The state label on trackedRunnerMismatchTotal reflects the authoritative
// in-memory state just before it was reconciled away. Keeping it bounded makes
// it possible to distinguish an exited busy runner (the #387 incident) from
// the existing idle-runner crash-loop signal.
const (
	runnerTrackedStateIdle = "idle"
	runnerTrackedStateBusy = "busy"
)

const (
	checkpointRestoreRestored   = "restored"
	checkpointRestoreAbsent     = "absent"
	checkpointRestoreUnreadable = "unreadable"
)

var (
	metricsOnce                   sync.Once
	orchestratorSchedulerReady    atomic.Bool
	orchestratorExpectedListeners atomic.Int64
	orchestratorListenerStates    sync.Map // map[string]bool

	runnersIdleGauge = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "github_runner_autoscaler_runners_idle",
			Help: "Number of idle runner containers tracked by host and scale set.",
		},
		[]string{"scale_set", "host"},
	)
	runnersBusyGauge = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "github_runner_autoscaler_runners_busy",
			Help: "Number of busy runner containers tracked by host and scale set.",
		},
		[]string{"scale_set", "host"},
	)
	runnersTotalGauge = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "github_runner_autoscaler_runners_total",
			Help: "Total number of runner containers tracked for a scale set.",
		},
		[]string{"scale_set"},
	)
	desiredRunnersGauge = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "github_runner_autoscaler_desired_runners",
			Help: "Desired number of runners requested by GitHub Actions listener.",
		},
		[]string{"scale_set"},
	)
	minRunnersGauge = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "github_runner_autoscaler_min_runners",
			Help: "Minimum runner count configured for a scale set.",
		},
		[]string{"scale_set"},
	)
	maxRunnersGauge = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "github_runner_autoscaler_max_runners",
			Help: "Maximum runner count configured for a scale set.",
		},
		[]string{"scale_set"},
	)
	jobsStartedCounter = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "github_runner_autoscaler_jobs_started_total",
			Help: "Total count of jobs started for a scale set.",
		},
		[]string{"scale_set"},
	)
	jobsCompletedCounter = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "github_runner_autoscaler_jobs_completed_total",
			Help: "Total count of jobs completed for a scale set.",
		},
		[]string{"scale_set"},
	)
	jobsCompletedUnassignedTotal = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "github_runner_autoscaler_jobs_completed_unassigned_total",
			Help: "Jobs that completed or started without ever being assigned a runner -- cancelled or superseded while still queued -- by scale set. Routine during cancel/re-dispatch loops and distinct from the WARN-level untracked-runner case (a runner GitHub knows about that this control plane has no record of); see agent-lcars#1687.",
		},
		[]string{"scale_set"},
	)
	runnerStartDuration = prometheus.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:    "github_runner_autoscaler_runner_start_duration_seconds",
			Help:    "Histogram of duration in seconds to create and start a runner container.",
			Buckets: prometheus.DefBuckets,
		},
		[]string{"scale_set", "host"},
	)
	runnerStartFailures = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "github_runner_autoscaler_runner_start_failures_total",
			Help: "Total number of failed runner start attempts.",
		},
		[]string{"scale_set", "host"},
	)
	runnerDiedIdleTotal = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "github_runner_autoscaler_runner_died_idle_total",
			Help: "Idle runner containers found dead before ever completing a job (crashed, exited, or vanished before GitHub sent a completion), by host and reason: " +
				runnerDeadReasonNotRunning + ", " + runnerDeadReasonNotFound + ".",
		},
		[]string{"scale_set", "host", "reason"},
	)
	trackedRunnerMismatchTotal = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "github_runner_autoscaler_tracked_runner_mismatch_total",
			Help: "Tracked runner entries reconciled because authoritative Docker state found their container stopped or missing, by scale set, host, tracked state, and reason.",
		},
		[]string{"scale_set", "host", "state", "reason"},
	)
	githubUnavailableRunnersReapedTotal = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "github_runner_autoscaler_github_unavailable_runners_reaped_total",
			Help: "Idle runner containers destroyed because GitHub reported them offline or stopped listing them for longer than the reap threshold, by scale set, host, and reason.",
		},
		[]string{"scale_set", "host", "reason"},
	)
	hostReachableGauge = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "github_runner_autoscaler_host_reachable",
			Help: "1 if placement docker host ping succeeded, 0 otherwise.",
		},
		[]string{"host"},
	)
	hostReadyGauge = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "github_runner_autoscaler_host_ready",
			Help: "For hosts with require_readiness: 1 if the operator's readiness signal currently permits placement, 0 otherwise. Absent for hosts without the gate.",
		},
		[]string{"host"},
	)
	hostRoleInfoGauge = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "github_runner_autoscaler_host_role_info",
			Help: "Static description of a declared fleet host's role: permanent, opportunistic, or maintenance. Always 1; join against placementBlocked{reason=\"maintenance\"} or lane_permanent_admissible_slots to name the hosts backing either (agent-lcars#1696).",
		},
		[]string{"host", "role"},
	)
	hostNormalizedLoadGauge = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "github_runner_autoscaler_host_normalized_load",
			Help: "Latest node_load1 divided by logical CPU count used for placement.",
		},
		[]string{"host"},
	)
	hostCPUUtilizationGauge = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "github_runner_autoscaler_host_cpu_utilization_ratio",
		Help: "Recent host CPU utilization ratio derived from node-exporter counters.",
	}, []string{"host"})
	hostPressureGauge = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "github_runner_autoscaler_host_pressure_ratio",
		Help: "Recent host PSI stall ratio by resource.",
	}, []string{"host", "resource"})
	hostMemoryAvailableGauge = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "github_runner_autoscaler_host_memory_available_ratio",
		Help: "Host available-memory ratio used by placement.",
	}, []string{"host"})
	hostSwapRateGauge = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "github_runner_autoscaler_host_swap_pages_per_second",
		Help: "Host swap-in plus swap-out pages per second used by placement.",
	}, []string{"host"})
	hostTelemetryGauge = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "github_runner_autoscaler_host_telemetry_available",
		Help: "1 when the latest placement host telemetry probe succeeded.",
	}, []string{"host"})
	hostCooldownGauge = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "github_runner_autoscaler_host_cooldown",
		Help: "1 while a host remains in overload cooldown.",
	}, []string{"host"})
	hostLoadPenaltyGauge = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "github_runner_autoscaler_host_load_penalty",
			Help: "Virtual runner-count penalty applied from host load, including overload cooldown.",
		},
		[]string{"host"},
	)
	hostFleetRunnersGauge = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "github_runner_autoscaler_host_fleet_runners",
			Help: "Running autoscaled runner containers across every scale set on a host.",
		},
		[]string{"host"},
	)
	hostMemoryReservedGauge = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "github_runner_autoscaler_host_memory_reserved_bytes",
			Help: "Aggregate declared memory reservation of running and in-flight autoscaled runners on a host, observed during placement.",
		},
		[]string{"host"},
	)
	hostMemoryBudgetGauge = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "github_runner_autoscaler_host_memory_budget_bytes",
			Help: "Docker-reported physical host memory available to declared runner reservations after the configured safety margin and effective overcommit factor (agent-lcars#1694).",
		},
		[]string{"host"},
	)
	hostMemoryObservedGauge = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "github_runner_autoscaler_host_memory_observed_bytes",
			Help: "Sum of sampled current memory usage (Docker one-shot stats, excluding reclaimable page cache) across running autoscaled runner containers on a host, observed during placement; a runner whose sample failed contributes its declared reservation instead (agent-lcars#1694).",
		},
		[]string{"host"},
	)
	hostMemoryOvercommitEffectiveGauge = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "github_runner_autoscaler_host_memory_overcommit_effective",
			Help: "The memory_overcommit factor actually applied to a host's reserved-memory admission budget just now: the configured fleet.hosts[].memory_overcommit value while the host is unpressured (memory-available ratio above memory_soft and memory PSI below psi_soft), otherwise 1.0 (agent-lcars#1694).",
		},
		[]string{"host"},
	)
	// runnerSliceExpectedMemoryMaxGauge and runnerSliceExpectedMemoryHighGauge
	// are the autoscaler's DECLARATION of a host's collective runner-slice
	// memory bound, not a report that anything was applied: the controller
	// has no privilege to set systemd slice properties on a fleet host (see
	// runnerSliceBudget's doc comment, agent-lcars#1712). Enforcement is
	// Ansible's job in the homelab repo (jlapenna/homelab#1102); verify the
	// declared numbers against cAdvisor's
	// container_spec_memory_limit_bytes{id="/homelab.slice/<slice>"} series.
	runnerSliceExpectedMemoryMaxGauge = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "github_runner_autoscaler_runner_slice_expected_memory_max_bytes",
			Help: "The memory.max the autoscaler declares for this host's collective runner cgroup slice: physical memory times (1 - memory_safety_margin). Declared only -- Ansible enforces it (jlapenna/homelab#1102) and Prometheus verifies it against cAdvisor's container_spec_memory_limit_bytes{id=\"/homelab.slice/<slice>\"} (agent-lcars#1700, #1712).",
		},
		[]string{"host", "slice"},
	)
	runnerSliceExpectedMemoryHighGauge = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "github_runner_autoscaler_runner_slice_expected_memory_high_bytes",
			Help: "The memory.high the autoscaler declares for this host's collective runner cgroup slice: 95% of the declared expected memory.max. Declared only -- see github_runner_autoscaler_runner_slice_expected_memory_max_bytes's help for the enforcement/verification split (agent-lcars#1700, #1712).",
		},
		[]string{"host", "slice"},
	)
	laneAdmissibleSlotsGauge = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "github_runner_autoscaler_lane_admissible_slots",
			Help: "How many more runners this lane could place right now, summed across reachable, ready, within-limit, unpressured hosts -- computed by the same admission pass pickHostLocked uses, so it cannot drift from the real decision (agent-lcars#1695). Refreshed on every placement attempt and at least once a minute regardless of pending demand.",
		},
		[]string{"scale_set"},
	)
	lanePermanentAdmissibleSlotsGauge = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "github_runner_autoscaler_lane_permanent_admissible_slots",
			Help: "Like github_runner_autoscaler_lane_admissible_slots, but summed over role: permanent hosts only -- opportunistic hosts (e.g. laptop) still place runners but never count here, and maintenance hosts never contribute to either gauge. This is the fleet invariant an alert should read: it stays truthful when an opportunistic host disappears (agent-lcars#1696, docs/fleet-scheduler-redesign.md#F).",
		},
		[]string{"scale_set"},
	)
	scaleSetMemoryReservationGauge = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "github_runner_autoscaler_scale_set_memory_reservation_bytes",
			Help: "Per-runner memory reservation the scheduler charges against a host's budget when placing this scale set's runners; zero when the scale set is unbounded (agent-lcars#1683).",
		},
		[]string{"scale_set"},
	)
	scaleSetMemoryLimitGauge = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "github_runner_autoscaler_scale_set_memory_limit_bytes",
			Help: "Docker cgroup memory ceiling applied to each of this scale set's runner containers; zero when unbounded.",
		},
		[]string{"scale_set"},
	)
	scaleSetLabelInfoGauge = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "github_runner_autoscaler_scale_set_label_info",
			Help: "One series per runs-on label a declared scale set serves. Always 1; join label to the GitHub Actions exporter's runs_on so queue depth is attributed to the lane that should drain it (agent-lcars#1699).",
		},
		[]string{"scale_set", "label"},
	)
	runnerJobInfoGauge = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "github_runner_autoscaler_runner_job_info",
			Help: "Which GitHub Actions job a busy runner container is executing. One series per busy runner, removed on completion; join on runner (= container name) to cAdvisor memory to measure per-job footprints (agent-lcars#1693).",
		},
		[]string{"scale_set", "runner", "job_id", "job_name", "workflow", "repository"},
	)
	scaleSetInfoGauge = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "github_runner_autoscaler_scale_set_info",
			Help: "Static description of a declared scale set: the registration, GitHub owner, and repository (owner/name, empty for an organization-scoped registration) it serves. Always 1; join on repository against GitHub Actions queue metrics, or on owner for organization scopes.",
		},
		[]string{"scale_set", "registration", "owner", "repository"},
	)
	drainingGauge = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "github_runner_autoscaler_draining",
			Help: "1 while this scale-set listener is draining and refusing new runner placements.",
		},
		[]string{"scale_set"},
	)
	drainAutoClearedTotal = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "github_runner_autoscaler_drain_auto_cleared_total",
			Help: "Stuck drains the watchdog self-healed after the scale set sat draining at zero runners past drainStuckTimeout (homelab#321), by scale set. Sustained nonzero indicates deploy.sh keeps getting interrupted before its recreate step.",
		},
		[]string{"scale_set"},
	)
	placementsRefusedDrainingTotal = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "github_runner_autoscaler_placements_refused_draining_total",
			Help: "Runner placements refused because the scale set is draining, by scale set -- incremented on every HandleDesiredRunnerCount callback GitHub sends while draining, so a drain that outlives its deploy (agent-lcars#1722) is visible in the same place as demand instead of only in logs.",
		},
		[]string{"scale_set"},
	)
	placementDecisions = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "github_runner_autoscaler_placement_decisions_total",
			Help: "Runner placement decisions by destination host.",
		},
		[]string{"scale_set", "host"},
	)
	reservationGauge = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "github_runner_autoscaler_scheduler_reservations",
		Help: "In-flight runner start reservations by scale set and host.",
	}, []string{"scale_set", "host"})
	placementBlocked = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "github_runner_autoscaler_placement_blocked_total",
		Help: "Placement attempts blocked by a fleet scheduling invariant, by host and reason: " +
			placementReasonFleetLimit + ", " + placementReasonHostLimits + ", " +
			placementReasonMemoryReservation + ", " + placementReasonReadiness + ", " + placementReasonOverload + ", " +
			placementReasonMaintenance + ", " + placementReasonPriorityReservation + ", " + placementReasonFloorOccupied + ". host names the specific host that refused the candidate for a " +
			"per-host reason (" + placementReasonMemoryReservation + ", " + placementReasonReadiness + ", " + placementReasonOverload + ", " + placementReasonMaintenance + ", " + placementReasonFloorOccupied +
			"); a fleet-level reason (" + placementReasonFleetLimit + ", " + placementReasonHostLimits + ", " + placementReasonPriorityReservation +
			") has no single host at fault and uses host=\"\".",
	}, []string{"scale_set", "host", "reason"})
	// priorityReservationRefusalsTotal is placementBlocked{reason="priority_reservation"}'s
	// own counter, with the protected lane broken out as a label so alerting
	// can name the starving pair directly instead of joining scale_set against
	// a log line (agent-lcars#1718). Incremented alongside, never instead of,
	// placementBlocked -- only when refusing this placement would leave
	// protected without a single admissible slot anywhere in the fleet (see
	// FleetCoordinator.protectedLaneWouldStarveLocked), not merely because
	// protected has pending demand.
	priorityReservationRefusalsTotal = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "github_runner_autoscaler_priority_reservation_refusals_total",
		Help: "Placements refused to preserve a higher-priority scale set's minimum service share, by the refused scale_set and the protected lane it yielded to. A companion to placement_blocked_total{reason=\"priority_reservation\"} that names the protected lane (agent-lcars#1718).",
	}, []string{"scale_set", "protected"})
	// placementDegradedTotal counts every degradation-ladder decision made
	// AFTER rung 1 (the declared reservation) failed to admit a
	// ladder-enabled lane's candidate: rung, one of degradationRungObservedP95,
	// degradationRungFreeMemoryFloor, or degradationRungRefused (only counted
	// for ladder-enabled lanes; a non-ladder lane's rung-1 failure is left to
	// placementBlocked/placementReasonMemoryReservation alone, exactly as
	// before the ladder existed) (docs/fleet-scheduler-redesign.md#D,
	// agent-lcars#1697).
	placementDegradedTotal = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "github_runner_autoscaler_placement_degraded_total",
		Help: "Placement decisions made by the degradation ladder after the declared reservation (rung 1) could not be admitted, by scale set and rung: " +
			degradationRungObservedP95 + ", " + degradationRungFreeMemoryFloor + ", or " + degradationRungRefused + ". Only counted for lanes with the ladder enabled.",
	}, []string{"scale_set", "rung"})
	// placementDegradedActiveGauge tracks rung-3 free-memory-floor runners
	// currently in flight (from the moment their host is claimed through
	// completion/removal) -- at most one per host at a time, enforced by
	// FleetCoordinator.floorRunners.
	placementDegradedActiveGauge = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "github_runner_autoscaler_placement_degraded_active",
		Help: "Rung-3 free-memory-floor runners currently in flight on a host, by scale set and host. At most 1 per host at a time (docs/fleet-scheduler-redesign.md#D, agent-lcars#1697).",
	}, []string{"scale_set", "host"})
	// laneObservedMemoryP95Gauge and laneObservedMemoryAgeGauge publish the
	// degradation ladder's Prometheus-sourced input (rung 2): a lane's
	// scale-set-labelled container_memory_rss p95 over the configured
	// window, refreshed every refresh_interval for ladder-enabled lanes
	// only. Neither is published until the first successful sample; a
	// missing series means no sample has ever succeeded.
	laneObservedMemoryP95Gauge = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "github_runner_autoscaler_lane_observed_memory_p95_bytes",
		Help: "This lane's observed memory p95 over fleet.placement.degradation_ladder.observed_window, as last queried from Prometheus. Rung 2's input (docs/fleet-scheduler-redesign.md#D, agent-lcars#1697).",
	}, []string{"scale_set"})
	laneObservedMemoryAgeGauge = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "github_runner_autoscaler_lane_observed_memory_age_seconds",
		Help: "Age of the sample behind github_runner_autoscaler_lane_observed_memory_p95_bytes. Rung 2 is skipped once this exceeds 3x fleet.placement.degradation_ladder.refresh_interval.",
	}, []string{"scale_set"})
	listenerUpGauge = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "github_runner_autoscaler_listener_up",
		Help: "1 while the GitHub message listener for a scale set is connected and running.",
	}, []string{"scale_set"})
	scaleSetStatsGauge = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "github_runner_autoscaler_scale_set_stats",
		Help: "Latest RunnerScaleSetStatistic reported by the GitHub listener session, by field: available_jobs, acquired_jobs, assigned_jobs, running_jobs, registered_runners, busy_runners, idle_runners. Updated from every listener.MetricsRecorder.RecordStatistics call (the initial session and every subsequent message). See README's stranded-queue signature and agent-lcars#1716.",
	}, []string{"scale_set", "field"})
	scaleSetLastMessageTimestampGauge = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "github_runner_autoscaler_scale_set_last_message_timestamp_seconds",
		Help: "Unix time the listener last processed an actual message from GitHub for this scale set (excludes the initial session statistics recorded at session start -- see github_runner_autoscaler_scale_set_session_started_timestamp_seconds).",
	}, []string{"scale_set"})
	scaleSetSessionStartedTimestampGauge = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "github_runner_autoscaler_scale_set_session_started_timestamp_seconds",
		Help: "Unix time the current GitHub listener session for this scale set was (re)created.",
	}, []string{"scale_set"})
	listenerRestarts = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "github_runner_autoscaler_listener_restarts_total",
		Help: "Listener reconnection attempts after an unexpected failure.",
	}, []string{"scale_set"})
	quiesceGenerationTimeouts = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "github_runner_autoscaler_quiesce_generation_timeouts_total",
		Help: "Control-plane quiesces that checkpointed and exited while the runtime generation was still running.",
	})
	pendingRunnersGauge = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "github_runner_autoscaler_scheduler_pending_runners",
		Help: "Runner deficit still waiting for a safe fleet placement.",
	}, []string{"scale_set"})
	pendingSinceTimestampGauge = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "github_runner_autoscaler_scheduler_pending_since_timestamp_seconds",
		Help: "Unix timestamp when the current uninterrupted runner deficit began, or 0 when no runner is pending.",
	}, []string{"scale_set"})
	githubUnavailableRunnersGauge = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "github_runner_autoscaler_github_unavailable_runners",
		Help: "Number of locally tracked runner containers older than the startup grace period that GitHub reports offline or no longer lists.",
	}, []string{"scale_set", "host", "reason"})
	runnerStatusProbeUpGauge = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "github_runner_autoscaler_runner_status_probe_up",
		Help: "1 when the latest registration-scoped GitHub runner-status reconciliation succeeded, 0 when it failed.",
	}, []string{"registration"})
	ghostRunnersDeletedTotal = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "github_runner_autoscaler_ghost_runners_deleted_total",
		Help: "GitHub runner registrations deleted by the periodic ghost sweep (agent-lcars#1725): offline, not busy, older than the sweep's minimum candidate age, and backed by no tracked container, by scale set.",
	}, []string{"scale_set"})
	ghostRunnersGauge = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "github_runner_autoscaler_ghost_runners",
		Help: "Ghost GitHub runner registrations found (and deleted) in the most recent periodic sweep, by scale set.",
	}, []string{"scale_set"})
	fleetMaxRunnersGauge = prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "github_runner_autoscaler_fleet_max_runners",
		Help: "Configured hard maximum runner count across the fleet.",
	})
	checkpointWriteFailures = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "github_runner_autoscaler_checkpoint_write_failures_total",
		Help: "Total number of failed control-plane checkpoint write attempts.",
	})
	checkpointLastWriteTimestamp = prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "github_runner_autoscaler_checkpoint_last_write_timestamp_seconds",
		Help: "Unix timestamp of the last successful control-plane checkpoint write.",
	})
	checkpointRestoreStatus = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "github_runner_autoscaler_checkpoint_restore_status",
		Help: "One-hot checkpoint restore outcome at boot, by status: restored, absent, or unreadable.",
	}, []string{"status"})
	queueExecutorReadyGauge = prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "github_runner_autoscaler_queue_executor_ready",
		Help: "1 when the direct-runner queue executor has a complete configuration and a usable claim token source; 0 when disabled or misconfigured.",
	})
	queueExecutorStateGauge = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "github_runner_autoscaler_queue_executor_state",
		Help: "One-hot queue executor startup state: disabled, misconfigured, or ready.",
	}, []string{"state"})
	queueExecutorPollsTotal = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "github_runner_autoscaler_queue_executor_polls_total",
		Help: "Queue executor claim polls by non-claim outcome: draining, idle_204, idle_empty, or poll_error.",
	}, []string{"outcome"})
	queueExecutorClaimsTotal = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "github_runner_autoscaler_queue_executor_claims_total",
		Help: "Successful queue claims returned by the control plane before direct-runner launch.",
	})
	queueExecutorLaunchesTotal = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "github_runner_autoscaler_queue_executor_launches_total",
		Help: "Direct-runner launch attempts after a successful claim, by outcome: success or error.",
	}, []string{"outcome"})
	scheduleTicksTotal = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "github_runner_autoscaler_schedule_ticks_total",
		Help: "Server-owned Work API schedule tick attempts by outcome.",
	}, []string{"outcome"})
)

func setQueueExecutorStartupState(state queueExecutorStartupState) {
	for _, candidate := range []queueExecutorStartupState{
		queueExecutorStateDisabled,
		queueExecutorStateMisconfigured,
		queueExecutorStateReady,
	} {
		value := 0.0
		if candidate == state {
			value = 1
		}
		queueExecutorStateGauge.WithLabelValues(string(candidate)).Set(value)
	}
	if state == queueExecutorStateReady {
		queueExecutorReadyGauge.Set(1)
		return
	}
	queueExecutorReadyGauge.Set(0)
}

func recordQueueExecutorPollOutcome(outcome queuePollOutcome) {
	switch outcome {
	case queuePollOutcomeClaimed:
		queueExecutorLaunchesTotal.WithLabelValues("success").Inc()
	case queuePollOutcomeLaunchErr:
		queueExecutorLaunchesTotal.WithLabelValues("error").Inc()
	case queuePollOutcomeDraining, queuePollOutcomeIdle204, queuePollOutcomeIdleEmpty, queuePollOutcomePollError:
		queueExecutorPollsTotal.WithLabelValues(string(outcome)).Inc()
	}
}

func recordScheduleTick(success bool) {
	outcome := "error"
	if success {
		outcome = "success"
	}
	scheduleTicksTotal.WithLabelValues(outcome).Inc()
}

func setCheckpointRestoreStatus(status string) {
	for _, candidate := range []string{checkpointRestoreRestored, checkpointRestoreAbsent, checkpointRestoreUnreadable} {
		value := 0.0
		if candidate == status {
			value = 1
		}
		checkpointRestoreStatus.WithLabelValues(candidate).Set(value)
	}
}

func registerMetrics() {
	metricsOnce.Do(func() {
		prometheus.MustRegister(
			runnersIdleGauge,
			runnersBusyGauge,
			runnersTotalGauge,
			desiredRunnersGauge,
			minRunnersGauge,
			maxRunnersGauge,
			jobsStartedCounter,
			jobsCompletedCounter,
			jobsCompletedUnassignedTotal,
			runnerStartDuration,
			runnerStartFailures,
			runnerDiedIdleTotal,
			trackedRunnerMismatchTotal,
			githubUnavailableRunnersReapedTotal,
			hostReachableGauge,
			hostReadyGauge,
			hostRoleInfoGauge,
			hostNormalizedLoadGauge,
			hostCPUUtilizationGauge,
			hostPressureGauge,
			hostMemoryAvailableGauge,
			hostSwapRateGauge,
			hostTelemetryGauge,
			hostCooldownGauge,
			hostLoadPenaltyGauge,
			hostFleetRunnersGauge,
			hostMemoryReservedGauge,
			hostMemoryBudgetGauge,
			hostMemoryObservedGauge,
			hostMemoryOvercommitEffectiveGauge,
			runnerSliceExpectedMemoryMaxGauge,
			runnerSliceExpectedMemoryHighGauge,
			laneAdmissibleSlotsGauge,
			lanePermanentAdmissibleSlotsGauge,
			scaleSetMemoryReservationGauge,
			scaleSetMemoryLimitGauge,
			scaleSetInfoGauge,
			runnerJobInfoGauge,
			scaleSetLabelInfoGauge,
			drainingGauge,
			drainAutoClearedTotal,
			placementsRefusedDrainingTotal,
			placementDecisions,
			reservationGauge,
			placementBlocked,
			priorityReservationRefusalsTotal,
			placementDegradedTotal,
			placementDegradedActiveGauge,
			laneObservedMemoryP95Gauge,
			laneObservedMemoryAgeGauge,
			listenerUpGauge,
			listenerRestarts,
			scaleSetStatsGauge,
			scaleSetLastMessageTimestampGauge,
			scaleSetSessionStartedTimestampGauge,
			quiesceGenerationTimeouts,
			pendingRunnersGauge,
			pendingSinceTimestampGauge,
			githubUnavailableRunnersGauge,
			runnerStatusProbeUpGauge,
			ghostRunnersDeletedTotal,
			ghostRunnersGauge,
			fleetMaxRunnersGauge,
			checkpointWriteFailures,
			checkpointLastWriteTimestamp,
			checkpointRestoreStatus,
			queueExecutorReadyGauge,
			queueExecutorStateGauge,
			queueExecutorPollsTotal,
			queueExecutorClaimsTotal,
			queueExecutorLaunchesTotal,
			scheduleTicksTotal,
		)
	})
}

// startMetricsServer binds addr and serves /metrics, /healthz, and /readyz
// until ctx is done. It returns the actual bound address (which can differ
// from addr when addr's port is "0", e.g. in tests that need a free port
// rather than a fixed one) so callers -- and TestMetricsAndHealthzServer in
// particular -- never have to guess or hard-code a port. An empty addr
// disables the server (returns "", nil).
func startMetricsServer(ctx context.Context, addr string, logger *slog.Logger) (string, error) {
	if addr == "" {
		return "", nil
	}

	registerMetrics()

	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.Handler())
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("OK\n"))
	})
	mux.HandleFunc("/readyz", func(w http.ResponseWriter, r *http.Request) {
		ready := orchestratorSchedulerReady.Load()
		connected := int64(0)
		orchestratorListenerStates.Range(func(_, value any) bool {
			if up, _ := value.(bool); up {
				connected++
			}
			return true
		})
		if !ready || connected != orchestratorExpectedListeners.Load() {
			http.Error(w, "DEGRADED", http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("READY\n"))
	})

	// Listen synchronously (rather than inside srv.ListenAndServe(), which
	// would hide both the bound address and any bind failure inside the
	// goroutine below) so a caller can learn the real address -- including
	// the OS-assigned port when addr ends in ":0" -- before this function
	// returns, and so a bind failure surfaces here instead of only in a log
	// line after the fact.
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return "", fmt.Errorf("listening on %q: %w", addr, err)
	}
	boundAddr := ln.Addr().String()

	srv := &http.Server{
		Handler: mux,
	}

	go func() {
		logger.Info("Starting metrics and healthz HTTP server", slog.String("addr", boundAddr))
		if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("Metrics HTTP server error", slog.String("error", err.Error()))
		}
	}()

	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := srv.Shutdown(shutdownCtx); err != nil {
			logger.Error("Metrics HTTP server shutdown error", slog.String("error", err.Error()))
		}
	}()

	return boundAddr, nil
}

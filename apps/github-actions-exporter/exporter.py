"""Turn GitHub Actions webhook events into metrics without unbounded labels.

The Agent LCARS console verifies each `workflow_run` and `workflow_job`
delivery from the GitHub App and publishes its raw body to a Pub/Sub topic.
This process holds a streaming pull on that topic's subscription, stores every
run attempt and job in SQLite, and serves aggregated Prometheus metrics.
"""

from __future__ import annotations

import json
import logging
import os
import re
import sqlite3
import threading
import time
from collections.abc import Callable, Iterable, Mapping, Sequence
from contextlib import ExitStack
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from google.cloud.pubsub_v1 import SubscriberClient
from google.cloud.pubsub_v1.types import FlowControl
from prometheus_client import CollectorRegistry, Counter, Gauge, start_http_server
from prometheus_client.core import (
    CounterMetricFamily,
    GaugeMetricFamily,
    HistogramMetricFamily,
)

LOGGER = logging.getLogger(__name__)

HEALTH_PATH = "/healthz"

QUEUE_BUCKETS = (1, 5, 10, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600)
DURATION_BUCKETS = (
    5,
    15,
    30,
    60,
    120,
    300,
    600,
    1200,
    1800,
    3600,
    7200,
    10800,
)
ACTIVE_STATUSES = ("queued", "in_progress", "waiting", "pending", "requested")
QUEUED_STATUSES = ("queued", "waiting", "pending", "requested")
# How far each GitHub status has progressed. Pub/Sub delivers at least once and
# in no particular order, so an event only replaces stored state when it is at
# least as far along: a late `in_progress` cannot undo `completed`.
STATUS_RANK = {
    "requested": 1,
    "pending": 1,
    "waiting": 1,
    "queued": 1,
    "in_progress": 2,
    "completed": 3,
}
# Statuses the exporter assigns itself to an active row that can no longer be
# active. Only a completion replaces them. `missing` and `refresh_pending` are
# left by earlier, polling versions of this exporter.
RETIRED_STATUSES = ("superseded", "orphaned", "missing", "refresh_pending")
# A run attempt in one of these states has no running jobs.
FINISHED_RUN_STATUSES = ("completed", "superseded")
MAX_JOB_LABELS_PER_WORKFLOW = 100
# Runs older than this do not count toward a workflow's consecutive-failure
# streak, so a workflow that no longer runs stops reporting one (see collect()).
CONSECUTIVE_FAILURE_WINDOW_SECONDS = 3 * 24 * 3600
# Conclusions that count a pull_request run as failed. Unlike the main-line
# streak this leaves out action_required: on a pull request it means the run
# is waiting for a maintainer to approve it, and nothing has failed.
PULL_REQUEST_FAILURE_CONCLUSIONS = ("failure", "timed_out", "startup_failure")
OVERFLOW_JOB_LABEL = "__other__"
FULL_SUITE_STEP_MARKER = "[full-suite]"

# The webhook events this exporter stores; the console forwards no others.
EVENTS = ("workflow_run", "workflow_job")
MESSAGE_OUTCOMES = ("stored", "ignored_repository", "malformed", "error")
SUBSCRIPTION_PATTERN = re.compile(r"projects/[^/\s]+/subscriptions/[^/\s]+")
RUN_TIMESTAMPS = ("created_at", "updated_at", "run_started_at")
JOB_TIMESTAMPS = ("created_at", "started_at", "completed_at")
# Messages leased to this process at once. Writes serialize on one SQLite
# connection, so a larger window only holds more messages unacknowledged.
MAX_OUTSTANDING_MESSAGES = 100
# How often stored history is re-aggregated for /metrics while events arrive.
SNAPSHOT_REFRESH_SECONDS = 30.0
# Delay before re-opening a streaming pull that stopped. The client library
# already retries transient stream errors itself; this covers the errors it
# gives up on (for example a revoked credential or a deleted subscription).
RECONNECT_MIN_SECONDS = 1.0
RECONNECT_MAX_SECONDS = 60.0
# How long stream_once waits for a cancelled stream to finish its callbacks.
SHUTDOWN_WAIT_SECONDS = 30.0
# A stream that ran this long before failing restarts the delay from the minimum.
RECONNECT_RESET_SECONDS = 300.0


def status_rank(status: str) -> int:
    """How far a stored or incoming status has progressed (see STATUS_RANK)."""
    if status in STATUS_RANK:
        return STATUS_RANK[status]
    return STATUS_RANK["in_progress"] if status in RETIRED_STATUSES else 0


def environment_text(name: str, default: str = "") -> str:
    """Return a stripped, non-empty environment setting."""
    value = os.environ.get(name, default).strip()
    if not value:
        raise ValueError(f"{name} cannot be empty")
    return value


def environment_int(
    name: str,
    default: int,
    *,
    minimum: int = 1,
    maximum: int | None = None,
) -> int:
    """Return a bounded integer environment setting."""
    value = int(os.environ.get(name, str(default)))
    if maximum is not None and not minimum <= value <= maximum:
        raise ValueError(f"{name} must be between {minimum} and {maximum}")
    if value < minimum:
        raise ValueError(f"{name} must be at least {minimum}")
    return value


def parse_timestamp(value: str | None) -> float | None:
    """Convert a GitHub ISO-8601 timestamp to Unix seconds."""
    if not value:
        return None
    return datetime.fromisoformat(value).timestamp()


def metric_label(value: Any, fallback: str = "unknown") -> str:
    """Return a stable non-empty Prometheus label value."""
    text = str(value or "").strip()
    return text if text else fallback


def workflow_label(run: dict[str, Any]) -> str:
    """Use a stable workflow filename instead of GitHub's dynamic run name."""
    path = metric_label(run.get("path"), "")
    if path:
        filename = Path(path.split("@", 1)[0]).name
        for suffix in (".yaml", ".yml"):
            if filename.endswith(suffix):
                filename = filename[: -len(suffix)]
                break
        if filename:
            return filename
    workflow_id = run.get("workflow_id")
    if workflow_id:
        return f"workflow-{workflow_id}"
    return metric_label(run.get("name"))


# Labels GitHub itself understands for hosted runners; a job carrying only
# these is not routed to the fleet at all.
HOSTED_RUNNER_LABEL_PREFIXES = ("ubuntu-", "windows-", "macos-")
HOSTED_RUNNER_LABELS = {
    "self-hosted",
    "linux",
    "windows",
    "macos",
    "x64",
    "arm64",
    "arm",
}


def job_runs_on(job: dict[str, Any]) -> str:
    """The fleet label a job's runs-on selects, or '' for a GitHub-hosted job.

    The fleet declares every scale set under a short label and a long one
    (`default`, `homelab-autoscale-default`); a workflow names either. The
    first non-hosted label in the job's own order is exported so queue depth
    can be attributed to the lane that should drain it (agent-lcars#1699).
    Cardinality is bounded by the labels workflows actually use.
    """
    labels = job.get("labels")
    if not isinstance(labels, list):
        return ""
    for label in labels:
        if not isinstance(label, str):
            continue
        value = metric_label(label, "")
        if not value or value in HOSTED_RUNNER_LABELS:
            continue
        if value.startswith(HOSTED_RUNNER_LABEL_PREFIXES):
            continue
        return value
    return ""


def job_execution(job: dict[str, Any]) -> str:
    """Classify an opt-in full-suite job using one bounded dimension."""
    if metric_label(job.get("status")) != "completed":
        return "unknown"
    steps = job.get("steps")
    if not isinstance(steps, list):
        return "unknown"
    for step in steps:
        if not isinstance(step, dict):
            continue
        if FULL_SUITE_STEP_MARKER not in metric_label(step.get("name"), ""):
            continue
        step_conclusion = metric_label(step.get("conclusion"))
        if step_conclusion == "skipped":
            return (
                "short_circuit"
                if metric_label(job.get("conclusion")) == "success"
                else "unknown"
            )
        if step_conclusion in {"success", "failure", "cancelled"}:
            return "full_suite"
        return "unknown"
    return "unknown"


@dataclass(frozen=True)
class Config:
    repositories: tuple[str, ...]
    subscription: str
    database_path: str = "/var/lib/github-actions-exporter/actions.db"
    port: int = 9102

    @classmethod
    def from_environment(cls) -> Config:
        repositories_by_key: dict[str, str] = {}
        for item in os.environ.get("GITHUB_REPOSITORIES", "").split(","):
            repository = item.strip()
            if repository:
                repositories_by_key.setdefault(repository.casefold(), repository)
        repositories = tuple(repositories_by_key.values())
        if not repositories:
            raise ValueError("GITHUB_REPOSITORIES is required")
        invalid = [
            repo
            for repo in repositories
            if repo.count("/") != 1 or not all(repo.split("/", 1))
        ]
        if invalid:
            raise ValueError(
                "GITHUB_REPOSITORIES entries must be owner/repository: "
                + ", ".join(invalid)
            )

        subscription = environment_text("GITHUB_ACTIONS_EVENTS_SUBSCRIPTION")
        if not SUBSCRIPTION_PATTERN.fullmatch(subscription):
            raise ValueError(
                "GITHUB_ACTIONS_EVENTS_SUBSCRIPTION must be "
                "projects/<project>/subscriptions/<subscription>"
            )

        return cls(
            repositories=repositories,
            subscription=subscription,
            database_path=environment_text(
                "DATABASE_PATH", "/var/lib/github-actions-exporter/actions.db"
            ),
            port=environment_int("PORT", 9102, maximum=65535),
        )


class ExporterState:
    """Prometheus metrics for the event consumer itself."""

    def __init__(self, registry: CollectorRegistry) -> None:
        self.subscription_running = Gauge(
            "github_actions_exporter_subscription_running",
            "1 while the Pub/Sub streaming pull is running; 0 while it is "
            "stopped and waiting to reconnect.",
            registry=registry,
        )
        self.subscription_failures = Counter(
            "github_actions_exporter_subscription_failures",
            "Times the Pub/Sub streaming pull stopped and had to be reopened.",
            registry=registry,
        )
        self.last_event = Gauge(
            "github_actions_exporter_last_event_timestamp_seconds",
            "Unix time the exporter last stored an event for the repository; "
            "0 if it never has. An idle repository simply ages.",
            ("repository",),
            registry=registry,
        )
        self.messages = Counter(
            "github_actions_exporter_messages",
            "Pub/Sub messages handled, by webhook event and outcome.",
            ("event", "outcome"),
            registry=registry,
        )
        for event in EVENTS:
            for outcome in MESSAGE_OUTCOMES:
                self.messages.labels(event, outcome)
        self.messages.labels("unknown", "malformed")


class Database:
    """Thread-safe durable store written by event handlers and read by metrics."""

    def __init__(self, path: str) -> None:
        database_path = Path(path)
        database_path.parent.mkdir(parents=True, exist_ok=True)
        self.connection = sqlite3.connect(path, check_same_thread=False)
        self.connection.row_factory = sqlite3.Row
        self.lock = threading.RLock()
        try:
            job_rows = self._initialize_schema()
        except BaseException:
            self.connection.close()
            raise
        self.job_labels: dict[tuple[str, str], set[str]] = {}
        for row in job_rows:
            self.job_labels.setdefault((row["repository"], row["workflow"]), set()).add(
                row["name"]
            )

    def _initialize_schema(self) -> list[sqlite3.Row]:
        with self.lock, self.connection:
            self.connection.executescript(
                """
                PRAGMA journal_mode=WAL;
                PRAGMA synchronous=NORMAL;

                CREATE TABLE IF NOT EXISTS workflow_runs (
                    repository TEXT NOT NULL,
                    id INTEGER NOT NULL,
                    run_attempt INTEGER NOT NULL DEFAULT 1,
                    workflow TEXT NOT NULL,
                    event TEXT NOT NULL,
                    status TEXT NOT NULL,
                    conclusion TEXT,
                    created_at REAL,
                    started_at REAL,
                    completed_at REAL,
                    updated_at REAL,
                    head_branch TEXT NOT NULL DEFAULT '',
                    PRIMARY KEY (repository, id, run_attempt)
                );

                CREATE TABLE IF NOT EXISTS jobs (
                    repository TEXT NOT NULL,
                    id INTEGER NOT NULL,
                    run_id INTEGER NOT NULL,
                    run_attempt INTEGER,
                    workflow TEXT NOT NULL,
                    name TEXT NOT NULL,
                    status TEXT NOT NULL,
                    conclusion TEXT,
                    created_at REAL,
                    started_at REAL,
                    completed_at REAL,
                    runner_group TEXT NOT NULL,
                    execution TEXT NOT NULL DEFAULT 'unknown',
                    runs_on TEXT NOT NULL DEFAULT '',
                    runner_name TEXT NOT NULL DEFAULT '',
                    PRIMARY KEY (repository, id)
                );

                -- Job events whose run has not arrived yet. A workflow_job
                -- payload has no workflow path, so the job cannot be labelled
                -- until its run's workflow_run event is stored.
                CREATE TABLE IF NOT EXISTS pending_jobs (
                    repository TEXT NOT NULL,
                    id INTEGER NOT NULL,
                    run_id INTEGER NOT NULL,
                    status TEXT NOT NULL,
                    payload TEXT NOT NULL,
                    received_at REAL NOT NULL,
                    PRIMARY KEY (repository, id)
                );

                CREATE TABLE IF NOT EXISTS repository_state (
                    repository TEXT PRIMARY KEY,
                    last_event_at REAL
                );

                CREATE INDEX IF NOT EXISTS workflow_runs_status_idx
                    ON workflow_runs (repository, status);
                CREATE INDEX IF NOT EXISTS jobs_status_idx
                    ON jobs (repository, status);
                CREATE INDEX IF NOT EXISTS jobs_run_idx
                    ON jobs (repository, run_id);
                CREATE INDEX IF NOT EXISTS pending_jobs_run_idx
                    ON pending_jobs (repository, run_id);
                """
            )
            self._migrate_columns()
            # Earlier versions parked an active job whose run had completed as
            # `refresh_pending` until a later poll re-read it. Events resolve
            # it instead, so the row joins the event-driven equivalent.
            self.connection.execute(
                "UPDATE jobs SET status = 'orphaned' WHERE status = 'refresh_pending'"
            )
            # A finished run attempt cannot still have a queued or running job.
            # Older versions could persist that contradiction and then export a
            # phantom queue forever, so repair any such rows on startup.
            self._orphan_active_jobs()
            return self.connection.execute(
                """
                SELECT DISTINCT repository, workflow, name FROM jobs
                WHERE name != ?
                """,
                (OVERFLOW_JOB_LABEL,),
            ).fetchall()

    def _columns(self, table: str) -> set[str]:
        return {
            row["name"]
            for row in self.connection.execute(f"PRAGMA table_info({table})")
        }

    def _migrate_columns(self) -> None:
        """Bring a database written by any earlier version to this schema."""
        run_columns = self._columns("workflow_runs")
        # Rows stored before this column existed keep '', which the
        # pull-request streak reads as "branch unknown" (homelab#3509).
        if "head_branch" not in run_columns:
            self.connection.execute(
                "ALTER TABLE workflow_runs ADD COLUMN head_branch TEXT NOT NULL DEFAULT ''"
            )
        # Polling bookkeeping with no meaning for events.
        if "jobs_updated_at" in run_columns:
            self.connection.execute(
                "ALTER TABLE workflow_runs DROP COLUMN jobs_updated_at"
            )

        job_columns = self._columns("jobs")
        for column, definition in (
            ("execution", "TEXT NOT NULL DEFAULT 'unknown'"),
            ("runs_on", "TEXT NOT NULL DEFAULT ''"),
            ("runner_name", "TEXT NOT NULL DEFAULT ''"),
            # NULL on rows stored before events; read as the run's newest attempt.
            ("run_attempt", "INTEGER"),
        ):
            if column not in job_columns:
                self.connection.execute(
                    f"ALTER TABLE jobs ADD COLUMN {column} {definition}"
                )
        # GitHub's webhooks do not carry concurrency-group membership.
        if "concurrency_group" in job_columns:
            self.connection.execute("ALTER TABLE jobs DROP COLUMN concurrency_group")

        state_columns = self._columns("repository_state")
        for column in ("initial_backfill_complete", "last_success_at"):
            if column in state_columns:
                self.connection.execute(
                    f"ALTER TABLE repository_state DROP COLUMN {column}"
                )
        if "last_event_at" not in state_columns:
            self.connection.execute(
                "ALTER TABLE repository_state ADD COLUMN last_event_at REAL"
            )

    def _orphan_active_jobs(
        self, repository: str | None = None, run_id: int | None = None
    ) -> None:
        """Retire active jobs whose run attempt has finished.

        The job's own completion event normally arrives too and replaces the
        `orphaned` status, so its outcome is still counted. Until then the job
        is neither current nor queued. A job stored before jobs recorded their
        attempt is matched against the run's newest attempt.
        """
        scope = ""
        parameters: list[Any] = [*ACTIVE_STATUSES, *FINISHED_RUN_STATUSES]
        if repository is not None:
            scope = "AND jobs.repository = ? AND jobs.run_id = ?"
            parameters += [repository, run_id]
        active = ",".join("?" for _ in ACTIVE_STATUSES)
        finished = ",".join("?" for _ in FINISHED_RUN_STATUSES)
        self.connection.execute(
            f"""
            UPDATE jobs SET status = 'orphaned'
            WHERE status IN ({active})
              AND EXISTS (
                SELECT 1 FROM workflow_runs
                WHERE workflow_runs.repository = jobs.repository
                  AND workflow_runs.id = jobs.run_id
                  AND (
                    (
                      workflow_runs.status IN ({finished})
                      AND workflow_runs.run_attempt = COALESCE(
                        jobs.run_attempt,
                        (
                          SELECT MAX(latest.run_attempt)
                          FROM workflow_runs AS latest
                          WHERE latest.repository = jobs.repository
                            AND latest.id = jobs.run_id
                        )
                      )
                    )
                    -- A later attempt supersedes this job's attempt even when
                    -- the job's own run event never arrived, matching
                    -- _attempt_finished.
                    OR (
                      jobs.run_attempt IS NOT NULL
                      AND workflow_runs.run_attempt > jobs.run_attempt
                    )
                  )
              )
              {scope}
            """,
            parameters,
        )

    def close(self) -> None:
        with self.lock:
            self.connection.close()

    def last_event_at(self, repository: str) -> float | None:
        with self.lock:
            row = self.connection.execute(
                "SELECT last_event_at FROM repository_state WHERE repository = ?",
                (repository,),
            ).fetchone()
        if row is None or row["last_event_at"] is None:
            return None
        return float(row["last_event_at"])

    def record_event(self, repository: str, timestamp: float) -> None:
        with self.lock, self.connection:
            self.connection.execute(
                """
                INSERT INTO repository_state (repository, last_event_at)
                VALUES (?, ?)
                ON CONFLICT(repository) DO UPDATE SET
                    last_event_at = excluded.last_event_at
                """,
                (repository, timestamp),
            )

    def upsert_run(self, repository: str, run: dict[str, Any]) -> None:
        """Store one run attempt from a `workflow_run` event, idempotently.

        An event replaces the stored attempt only when its status has
        progressed at least as far, and at an equal status only when it is
        not older (`updated_at`). Job events that arrived before this run are
        labelled and stored now.
        """
        status = metric_label(run.get("status"))
        updated_at = parse_timestamp(run.get("updated_at"))
        completed_at = updated_at if status == "completed" else None
        run_id = int(run["id"])
        run_attempt = int(run.get("run_attempt") or 1)
        with self.lock, self.connection:
            stored = self.connection.execute(
                """
                SELECT status, updated_at FROM workflow_runs
                WHERE repository = ? AND id = ? AND run_attempt = ?
                """,
                (repository, run_id, run_attempt),
            ).fetchone()
            if stored is None or _progresses(
                stored["status"], stored["updated_at"], status, updated_at
            ):
                self.connection.execute(
                    """
                    INSERT INTO workflow_runs (
                        repository, id, workflow, event, status, conclusion,
                        created_at, started_at, completed_at, updated_at,
                        run_attempt, head_branch
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(repository, id, run_attempt) DO UPDATE SET
                        workflow = excluded.workflow,
                        event = excluded.event,
                        status = excluded.status,
                        conclusion = excluded.conclusion,
                        created_at = excluded.created_at,
                        started_at = excluded.started_at,
                        completed_at = excluded.completed_at,
                        updated_at = excluded.updated_at,
                        head_branch = excluded.head_branch
                    """,
                    (
                        repository,
                        run_id,
                        workflow_label(run),
                        metric_label(run.get("event")),
                        status,
                        run.get("conclusion"),
                        parse_timestamp(run.get("created_at")),
                        parse_timestamp(run.get("run_started_at")),
                        completed_at,
                        updated_at,
                        run_attempt,
                        # Stored to tell pull requests apart, never exported: a
                        # branch name is unbounded label cardinality.
                        str(run.get("head_branch") or ""),
                    ),
                )
            # A rerun starts a new attempt; an older attempt still marked
            # active (its completion event lost or not yet delivered) is not.
            placeholders = ",".join("?" for _ in ACTIVE_STATUSES)
            self.connection.execute(
                f"""
                UPDATE workflow_runs SET status = 'superseded'
                WHERE repository = ? AND id = ?
                  AND status IN ({placeholders})
                  AND run_attempt < (
                      SELECT MAX(run_attempt) FROM workflow_runs
                      WHERE repository = ? AND id = ?
                  )
                """,
                (repository, run_id, *ACTIVE_STATUSES, repository, run_id),
            )
            self._orphan_active_jobs(repository, run_id)
            workflow = self._run_workflow(repository, run_id)
            for row in self.connection.execute(
                """
                SELECT payload FROM pending_jobs
                WHERE repository = ? AND run_id = ?
                ORDER BY id
                """,
                (repository, run_id),
            ).fetchall():
                self._write_job(repository, workflow, json.loads(row["payload"]))
            self.connection.execute(
                "DELETE FROM pending_jobs WHERE repository = ? AND run_id = ?",
                (repository, run_id),
            )

    def upsert_job(
        self, repository: str, job: dict[str, Any], *, received_at: float | None = None
    ) -> None:
        """Store one job from a `workflow_job` event, idempotently.

        The job's workflow label comes from its run's workflow file, which
        only a `workflow_run` event carries. Until any attempt of that run is
        stored, the job is held in pending_jobs and exported nowhere.
        """
        run_id = int(job["run_id"])
        status = metric_label(job.get("status"))
        with self.lock, self.connection:
            workflow = self._run_workflow(repository, run_id)
            if workflow is not None:
                self._write_job(repository, workflow, job)
                return
            stored = self.connection.execute(
                "SELECT status FROM pending_jobs WHERE repository = ? AND id = ?",
                (repository, int(job["id"])),
            ).fetchone()
            if stored is not None and status_rank(status) < status_rank(
                stored["status"]
            ):
                return
            self.connection.execute(
                """
                INSERT INTO pending_jobs (
                    repository, id, run_id, status, payload, received_at
                ) VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(repository, id) DO UPDATE SET
                    run_id = excluded.run_id,
                    status = excluded.status,
                    payload = excluded.payload,
                    received_at = excluded.received_at
                """,
                (
                    repository,
                    int(job["id"]),
                    run_id,
                    status,
                    json.dumps(job),
                    time.time() if received_at is None else received_at,
                ),
            )

    def _run_workflow(self, repository: str, run_id: int) -> str | None:
        row = self.connection.execute(
            """
            SELECT workflow FROM workflow_runs
            WHERE repository = ? AND id = ?
            ORDER BY run_attempt DESC LIMIT 1
            """,
            (repository, run_id),
        ).fetchone()
        return None if row is None else row["workflow"]

    def _attempt_finished(self, repository: str, run_id: int, run_attempt: int) -> bool:
        finished = ",".join("?" for _ in FINISHED_RUN_STATUSES)
        row = self.connection.execute(
            f"""
            SELECT 1 FROM workflow_runs
            WHERE repository = ? AND id = ?
              AND (
                (run_attempt = ? AND status IN ({finished}))
                OR run_attempt > ?
              )
            LIMIT 1
            """,
            (repository, run_id, run_attempt, *FINISHED_RUN_STATUSES, run_attempt),
        ).fetchone()
        return row is not None

    def _write_job(self, repository: str, workflow: str, job: dict[str, Any]) -> None:
        """Store a job whose run is known; the caller holds the transaction."""
        job_id = int(job["id"])
        run_id = int(job["run_id"])
        run_attempt = int(job.get("run_attempt") or 1)
        status = metric_label(job.get("status"))
        stored = self.connection.execute(
            "SELECT status FROM jobs WHERE repository = ? AND id = ?",
            (repository, job_id),
        ).fetchone()
        if stored is not None and status_rank(status) < status_rank(stored["status"]):
            return
        if status in ACTIVE_STATUSES and self._attempt_finished(
            repository, run_id, run_attempt
        ):
            status = "orphaned"
        self.connection.execute(
            """
            INSERT INTO jobs (
                repository, id, run_id, run_attempt, workflow, name, status,
                conclusion, created_at, started_at, completed_at,
                runner_group, execution, runs_on, runner_name
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(repository, id) DO UPDATE SET
                run_id = excluded.run_id,
                run_attempt = excluded.run_attempt,
                workflow = excluded.workflow,
                name = excluded.name,
                status = excluded.status,
                conclusion = excluded.conclusion,
                created_at = excluded.created_at,
                started_at = excluded.started_at,
                completed_at = excluded.completed_at,
                runner_group = excluded.runner_group,
                execution = excluded.execution,
                runs_on = excluded.runs_on,
                runner_name = CASE
                    WHEN excluded.runner_name != '' THEN excluded.runner_name
                    ELSE jobs.runner_name
                END
            """,
            (
                repository,
                job_id,
                run_id,
                run_attempt,
                workflow,
                self.bounded_job_name(
                    repository, workflow, metric_label(job.get("name"))
                ),
                status,
                job.get("conclusion"),
                parse_timestamp(job.get("created_at")),
                parse_timestamp(job.get("started_at")),
                parse_timestamp(job.get("completed_at")),
                metric_label(job.get("runner_group_name"), "unassigned"),
                job_execution(job),
                job_runs_on(job),
                metric_label(job.get("runner_name"), ""),
            ),
        )

    def bounded_job_name(self, repository: str, workflow: str, name: str) -> str:
        """Cap dynamic job label values while preserving familiar names."""
        with self.lock:
            labels = self.job_labels.setdefault((repository, workflow), set())
            if name in labels:
                return name
            if len(labels) >= MAX_JOB_LABELS_PER_WORKFLOW:
                return OVERFLOW_JOB_LABEL
            labels.add(name)
            return name

    def rows(self, query: str, parameters: Iterable[Any] = ()) -> list[sqlite3.Row]:
        with self.lock:
            return self.connection.execute(query, tuple(parameters)).fetchall()

    def histogram_rows(
        self,
        *,
        table: str,
        labels: Sequence[str],
        value_expression: str,
        required: str,
        buckets: Sequence[int],
    ) -> list[tuple[list[str], list[tuple[str, float]], float]]:
        bucket_columns = ", ".join(
            f"SUM(CASE WHEN {value_expression} <= {bucket} THEN 1 ELSE 0 END) AS b{index}"
            for index, bucket in enumerate(buckets)
        )
        label_columns = ", ".join(labels)
        query = f"""
            SELECT {label_columns}, COUNT(*) AS total,
                   SUM({value_expression}) AS value_sum,
                   {bucket_columns}
            FROM {table}
            WHERE {required}
            GROUP BY {label_columns}
        """
        result = []
        for row in self.rows(query):
            counts = [
                (str(bucket), float(row[f"b{index}"]))
                for index, bucket in enumerate(buckets)
            ]
            counts.append(("+Inf", float(row["total"])))
            result.append(
                (
                    [metric_label(row[label]) for label in labels],
                    counts,
                    float(row["value_sum"]),
                )
            )
        return result


def _progresses(
    stored_status: str,
    stored_updated_at: float | None,
    status: str,
    updated_at: float | None,
) -> bool:
    """Whether an incoming run event may replace the stored attempt."""
    stored_rank, rank = status_rank(stored_status), status_rank(status)
    if rank != stored_rank:
        return rank > stored_rank
    if stored_updated_at is None or updated_at is None:
        return True
    return updated_at >= stored_updated_at


class DatabaseMetrics:
    """Serve stored history from a snapshot rebuilt off the scrape path (homelab#2653).

    The aggregations below scan the whole retained history: 130k runs and 340k
    jobs took about 5s of SQL per scrape on 2026-10-17, serialized on the
    database lock with writes and with any concurrent scrape, so scrapes
    straddled Prometheus's 10s timeout and kept growing with history. Stored
    history only changes when an event is stored, so the event consumer calls
    refresh() at most every SNAPSHOT_REFRESH_SECONDS after a change and a scrape
    only renders the last snapshot. Queue ages are still computed at scrape
    time so they keep advancing.
    """

    def __init__(self, database: Database) -> None:
        self.database = database
        self._snapshot: (
            tuple[
                list[Any],
                list[tuple[list[str], float]],
                dict[tuple[str, str], list[tuple[float, bool]]],
                dict[tuple[str, str], list[tuple[float, bool, str]]],
            ]
            | None
        ) = None

    def refresh(self) -> None:
        """Run the history aggregations and replace the snapshot scrapes serve."""
        families = list(self._history_families())
        placeholders = ",".join("?" for _ in QUEUED_STATUSES)
        oldest_queued = [
            (
                [row["repository"], row["workflow"], row["name"], row["runs_on"]],
                float(row["oldest"]),
            )
            for row in self.database.rows(
                f"""
                SELECT repository, workflow, name, runs_on, MIN(created_at) AS oldest
                FROM jobs
                WHERE status IN ({placeholders}) AND created_at IS NOT NULL
                GROUP BY repository, workflow, name, runs_on
                """,
                QUEUED_STATUSES,
            )
        ]
        self._snapshot = (
            families,
            oldest_queued,
            self._decisive_runs(),
            self._pull_request_runs(),
        )

    def collect(self):
        if self._snapshot is None:
            self.refresh()
        families, oldest_queued_rows, decisive_runs, pull_request_runs = self._snapshot
        yield from families
        yield from self._consecutive_failures(decisive_runs, time.time())
        yield self._pull_request_failing_branches(pull_request_runs, time.time())

        oldest_queued = GaugeMetricFamily(
            "github_actions_job_oldest_queued_seconds",
            "Age in seconds of the oldest currently queued job. runs_on is the fleet label the job targets, empty for GitHub-hosted jobs (agent-lcars#1699).",
            labels=("repository", "workflow", "job", "runs_on"),
        )
        now = time.time()
        for labels, oldest in oldest_queued_rows:
            oldest_queued.add_metric(labels, max(0, now - oldest))
        yield oldest_queued

    def _decisive_runs(self) -> dict[tuple[str, str], list[tuple[float, bool]]]:
        """Each workflow's decisive runs inside the window, newest first.

        The window expires the oldest runs first, so runs older than a
        workflow's newest success can never affect its streak and are not
        kept. collect() applies the expiry against the scrape-time clock, so
        a cached streak still ages out between refreshes (homelab#2653).
        """
        runs: dict[tuple[str, str], list[tuple[float, bool]]] = {}
        settled: set[tuple[str, str]] = set()
        for row in self.database.rows(
            """
            SELECT repository, workflow, conclusion, created_at
            FROM workflow_runs
            WHERE status = 'completed'
              AND event != 'pull_request'
              AND conclusion IN ('success', 'failure', 'timed_out',
                                 'action_required', 'startup_failure')
              AND created_at >= ?
            ORDER BY repository, workflow,
                     COALESCE(created_at, 0) DESC, id DESC, run_attempt DESC
            """,
            (time.time() - CONSECUTIVE_FAILURE_WINDOW_SECONDS,),
        ):
            key = (row["repository"], row["workflow"])
            if key in settled:
                continue
            success = row["conclusion"] == "success"
            runs.setdefault(key, []).append((float(row["created_at"]), success))
            if success:
                settled.add(key)
        return runs

    @staticmethod
    def _consecutive_failures(
        decisive_runs: dict[tuple[str, str], list[tuple[float, bool]]], now: float
    ):
        # The most recent decisive (success/failure-class, non-pull_request)
        # runs of each workflow that did not succeed, counted back from the
        # latest until the first success, over runs created in the last
        # CONSECUTIVE_FAILURE_WINDOW_SECONDS only: a workflow that stopped
        # running (retired, or its trigger removed) must drop out rather than
        # report its final streak forever, which is how a five-day-old streak
        # from a since-retired dispatch workflow stayed "failing" on
        # 2026-09-02. Counters alone cannot express run
        # order: a success followed by two failures inside a rate window looks
        # identical to two failures followed by a success, and a low-volume
        # main-line workflow (deploy, post-merge reconcile) can fail on every
        # run for a day without tripping a rate rule. Cancelled and skipped
        # runs neither extend nor break the streak (homelab#1077).
        consecutive_failures = GaugeMetricFamily(
            "github_actions_workflow_consecutive_failures",
            "Consecutive most-recent completed non-pull_request runs of a workflow that did not succeed; 0 once the latest decisive run succeeded. A lower bound until the stored history reaches a success (see _complete).",
            labels=("repository", "workflow"),
        )
        # The stored history starts with the first event a freshly created
        # database received, so a streak that reaches the oldest stored run
        # without meeting a success may be longer than reported. The database
        # lives on a persistent volume, so this only applies to a brand-new deployment;
        # the alert still fires at two observed failures rather than waiting,
        # and this gauge lets a dashboard say when the count is exact.
        consecutive_failures_complete = GaugeMetricFamily(
            "github_actions_workflow_consecutive_failures_complete",
            "1 when the consecutive-failure count is bounded by a stored success (or is 0); 0 when it is a lower bound because stored history ends before the last success.",
            labels=("repository", "workflow"),
        )
        cutoff = now - CONSECUTIVE_FAILURE_WINDOW_SECONDS
        for (repository, workflow), runs in decisive_runs.items():
            live = [success for created_at, success in runs if created_at >= cutoff]
            if not live:
                continue
            bounded = any(live)
            streak = live.index(True) if bounded else len(live)
            consecutive_failures.add_metric([repository, workflow], float(streak))
            consecutive_failures_complete.add_metric(
                [repository, workflow], 1.0 if bounded or streak == 0 else 0.0
            )
        yield consecutive_failures
        yield consecutive_failures_complete

    def _pull_request_runs(
        self,
    ) -> dict[tuple[str, str], list[tuple[float, bool, str]]]:
        """Each workflow's decisive pull_request runs in the window, newest first.

        Ordered by when the attempt started rather than when the run was
        created: a rerun keeps its run's created_at, and a rerun that passes
        after a newer run failed is the newest evidence that the workflow
        works. As in _decisive_runs, nothing older than the newest success
        can affect the count, so it is not kept.
        """
        placeholders = ",".join("?" for _ in PULL_REQUEST_FAILURE_CONCLUSIONS)
        runs: dict[tuple[str, str], list[tuple[float, bool, str]]] = {}
        settled: set[tuple[str, str]] = set()
        for row in self.database.rows(
            f"""
            SELECT repository, workflow, conclusion, head_branch,
                   COALESCE(started_at, created_at) AS ran_at
            FROM workflow_runs
            WHERE status = 'completed'
              AND event = 'pull_request'
              AND conclusion IN ('success', {placeholders})
              AND COALESCE(started_at, created_at) >= ?
            ORDER BY repository, workflow, ran_at DESC, id DESC, run_attempt DESC
            """,
            (
                *PULL_REQUEST_FAILURE_CONCLUSIONS,
                time.time() - CONSECUTIVE_FAILURE_WINDOW_SECONDS,
            ),
        ):
            key = (row["repository"], row["workflow"])
            if key in settled:
                continue
            success = row["conclusion"] == "success"
            runs.setdefault(key, []).append(
                (float(row["ran_at"]), success, row["head_branch"])
            )
            if success:
                settled.add(key)
        return runs

    @staticmethod
    def _pull_request_failing_branches(
        pull_request_runs: dict[tuple[str, str], list[tuple[float, bool, str]]],
        now: float,
    ) -> GaugeMetricFamily:
        # The consecutive-failure streak above skips pull_request runs on
        # purpose: one pull request with a broken change fails on every push
        # and would read as an outage. That left a workflow failing on every
        # pull request of a low-volume repository invisible (homelab#3509:
        # homegit's required check failed on two pull requests over two hours
        # on 2026-11-11 and no rule could see it). Counting pull requests
        # instead of runs separates the two: failures on different head
        # branches with no successful pull_request run in between point at
        # the workflow or its runner, not at one change. Reruns and new
        # pushes on one branch count once. Cancelled, skipped and
        # approval-pending (action_required) runs neither add a branch nor
        # reset the count, and a run stored before
        # head_branch was recorded stops the count if it succeeded but adds
        # no branch if it failed. Fork branches sharing a name count once.
        failing_branches = GaugeMetricFamily(
            "github_actions_workflow_pull_request_failing_branches",
            "Distinct pull-request head branches among a workflow's most recent decisive pull_request runs that did not succeed, counted back to the first success; 0 once the latest decisive pull_request run succeeded.",
            labels=("repository", "workflow"),
        )
        cutoff = now - CONSECUTIVE_FAILURE_WINDOW_SECONDS
        for (repository, workflow), runs in pull_request_runs.items():
            live = [
                (success, branch)
                for ran_at, success, branch in runs
                if ran_at >= cutoff
            ]
            if not live:
                continue
            branches: set[str] = set()
            for success, branch in live:
                if success:
                    break
                if branch:
                    branches.add(branch)
            failing_branches.add_metric([repository, workflow], float(len(branches)))
        return failing_branches

    def _history_families(self):
        workflow_runs = CounterMetricFamily(
            "github_actions_workflow_runs",
            "Completed GitHub Actions workflow runs.",
            labels=("repository", "workflow", "event", "conclusion"),
        )
        for row in self.database.rows(
            """
            SELECT repository, workflow, event,
                   COALESCE(conclusion, 'unknown') AS conclusion,
                   COUNT(*) AS total
            FROM workflow_runs
            WHERE status = 'completed'
            GROUP BY repository, workflow, event, COALESCE(conclusion, 'unknown')
            """
        ):
            workflow_runs.add_metric(
                [row["repository"], row["workflow"], row["event"], row["conclusion"]],
                float(row["total"]),
            )
        yield workflow_runs

        jobs = CounterMetricFamily(
            "github_actions_jobs",
            "Completed GitHub Actions jobs.",
            labels=(
                "repository",
                "workflow",
                "job",
                "conclusion",
                "runner_group",
                "execution",
            ),
        )
        for row in self.database.rows(
            """
            SELECT repository, workflow, name,
                   COALESCE(conclusion, 'unknown') AS conclusion,
                   runner_group, execution, COUNT(*) AS total
            FROM jobs
            WHERE status = 'completed'
            GROUP BY repository, workflow, name,
                     COALESCE(conclusion, 'unknown'), runner_group, execution
            """
        ):
            jobs.add_metric(
                [
                    row["repository"],
                    row["workflow"],
                    row["name"],
                    row["conclusion"],
                    row["runner_group"],
                    row["execution"],
                ],
                float(row["total"]),
            )
        yield jobs

        current_runs = GaugeMetricFamily(
            "github_actions_workflow_runs_current",
            "Current active GitHub Actions workflow runs.",
            labels=("repository", "workflow", "status"),
        )
        placeholders = ",".join("?" for _ in ACTIVE_STATUSES)
        for row in self.database.rows(
            f"""
            SELECT repository, workflow, status, COUNT(*) AS total
            FROM workflow_runs
            WHERE status IN ({placeholders})
            GROUP BY repository, workflow, status
            """,
            ACTIVE_STATUSES,
        ):
            current_runs.add_metric(
                [row["repository"], row["workflow"], row["status"]],
                float(row["total"]),
            )
        yield current_runs

        current_jobs = GaugeMetricFamily(
            "github_actions_jobs_current",
            "Current active GitHub Actions jobs.",
            labels=(
                "repository",
                "workflow",
                "job",
                "status",
                "runner_group",
                "runs_on",
            ),
        )
        for row in self.database.rows(
            f"""
            SELECT repository, workflow, name, status, runner_group, runs_on,
                   COUNT(*) AS total
            FROM jobs
            WHERE status IN ({placeholders})
            GROUP BY repository, workflow, name, status, runner_group, runs_on
            """,
            ACTIVE_STATUSES,
        ):
            current_jobs.add_metric(
                [
                    row["repository"],
                    row["workflow"],
                    row["name"],
                    row["status"],
                    row["runner_group"],
                    row["runs_on"],
                ],
                float(row["total"]),
            )
        yield current_jobs

        yield from self._histogram(
            "github_actions_workflow_duration_seconds",
            "GitHub Actions workflow duration from creation to completion.",
            "workflow_runs",
            ("repository", "workflow", "event"),
            "completed_at - created_at",
            "status = 'completed' AND created_at IS NOT NULL "
            "AND completed_at >= created_at",
            DURATION_BUCKETS,
        )
        yield from self._histogram(
            "github_actions_workflow_queue_duration_seconds",
            "GitHub Actions workflow queue duration from creation to start.",
            "workflow_runs",
            ("repository", "workflow", "event"),
            "started_at - created_at",
            "created_at IS NOT NULL AND started_at >= created_at",
            QUEUE_BUCKETS,
        )
        yield from self._histogram(
            "github_actions_job_duration_seconds",
            "GitHub Actions job execution duration.",
            "jobs",
            ("repository", "workflow", "name", "runner_group", "execution"),
            "completed_at - started_at",
            "status = 'completed' AND started_at IS NOT NULL "
            "AND completed_at >= started_at",
            DURATION_BUCKETS,
            metric_labels=(
                "repository",
                "workflow",
                "job",
                "runner_group",
                "execution",
            ),
        )
        yield from self._histogram(
            "github_actions_job_queue_duration_seconds",
            "GitHub Actions job queue duration from creation to start.",
            "jobs",
            ("repository", "workflow", "name", "runner_group", "execution"),
            "started_at - created_at",
            "status = 'completed' AND created_at IS NOT NULL "
            "AND started_at >= created_at",
            QUEUE_BUCKETS,
            metric_labels=(
                "repository",
                "workflow",
                "job",
                "runner_group",
                "execution",
            ),
        )

    def _histogram(
        self,
        name: str,
        documentation: str,
        table: str,
        database_labels: Sequence[str],
        value_expression: str,
        required: str,
        buckets: Sequence[int],
        *,
        metric_labels: Sequence[str] | None = None,
    ):
        family = HistogramMetricFamily(
            name, documentation, labels=metric_labels or database_labels
        )
        rows = self.database.histogram_rows(
            table=table,
            labels=database_labels,
            value_expression=value_expression,
            required=required,
            buckets=buckets,
        )
        for labels, bucket_counts, value_sum in rows:
            family.add_metric(labels, bucket_counts, value_sum)
        yield family


class MalformedEvent(ValueError):
    """A message that can never be stored, however often it is redelivered."""


def _require_timestamps(payload: dict[str, Any], keys: Sequence[str]) -> None:
    for key in keys:
        value = payload.get(key)
        if value is None:
            continue
        if not isinstance(value, str):
            raise MalformedEvent(f"{key} is not a timestamp")
        try:
            parse_timestamp(value)
        except ValueError:
            raise MalformedEvent(f"{key} is not a timestamp") from None


def _require_id(payload: dict[str, Any], key: str) -> None:
    value = payload.get(key)
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise MalformedEvent(f"{key} is not an id")


def parse_event(
    event: str, data: bytes, repositories: Mapping[str, str]
) -> tuple[str | None, dict[str, Any]]:
    """Validate a forwarded webhook body.

    Returns the configured repository name (None for a repository this
    exporter does not watch) and the run or job object. Raises MalformedEvent
    for anything that can never be stored.
    """
    if event not in EVENTS:
        raise MalformedEvent(f"unsupported event {event!r}")
    try:
        payload = json.loads(data)
    except ValueError:
        raise MalformedEvent("body is not JSON") from None
    if not isinstance(payload, dict):
        raise MalformedEvent("body is not an object")
    repository = payload.get("repository")
    full_name = repository.get("full_name") if isinstance(repository, dict) else None
    if not isinstance(full_name, str) or full_name.count("/") != 1:
        raise MalformedEvent("repository.full_name is missing")
    obj = payload.get(event)
    configured = repositories.get(full_name.casefold())
    if configured is None:
        return None, {}
    if not isinstance(obj, dict):
        raise MalformedEvent(f"{event} is not an object")
    _require_id(obj, "id")
    if not isinstance(obj.get("status"), str):
        raise MalformedEvent(f"{event}.status is missing")
    attempt = obj.get("run_attempt")
    if attempt is not None and (
        not isinstance(attempt, int) or isinstance(attempt, bool) or attempt < 1
    ):
        raise MalformedEvent(f"{event}.run_attempt is invalid")
    if event == "workflow_job":
        _require_id(obj, "run_id")
        _require_timestamps(obj, JOB_TIMESTAMPS)
    else:
        _require_timestamps(obj, RUN_TIMESTAMPS)
    return configured, obj


class EventConsumer:
    """Store webhook events from a Pub/Sub streaming pull.

    Pub/Sub delivers at least once and in no particular order. Each message is
    acknowledged only after its SQLite write commits, so a crash redelivers it,
    and the Database upserts make a redelivery harmless. A message that can
    never be stored is acknowledged and counted rather than redelivered
    forever; an unexpected failure is negatively acknowledged for a retry.
    """

    def __init__(
        self,
        config: Config,
        database: Database,
        state: ExporterState,
        metrics: DatabaseMetrics,
        *,
        clock: Callable[[], float] = time.time,
        monotonic: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self.config = config
        self.database = database
        self.state = state
        self.metrics = metrics
        self._clock = clock
        self._monotonic = monotonic
        self._sleep = sleep
        self._repositories = {
            repository.casefold(): repository for repository in config.repositories
        }
        self._changed = threading.Event()
        for repository in config.repositories:
            self.state.last_event.labels(repository).set(
                database.last_event_at(repository) or 0
            )
        self.state.subscription_running.set(0)

    def handle_message(self, message: Any) -> None:
        """Pub/Sub callback; runs on the subscriber's worker threads."""
        attributes = message.attributes or {}
        event = str(attributes.get("event", ""))
        event_label = event if event in EVENTS else "unknown"
        try:
            repository, obj = parse_event(event, message.data, self._repositories)
        except MalformedEvent as exc:
            LOGGER.warning(
                "dropping malformed %s message %s: %s",
                event_label,
                attributes.get("delivery_id", "?"),
                exc,
            )
            self.state.messages.labels(event_label, "malformed").inc()
            message.ack()
            return
        if repository is None:
            self.state.messages.labels(event, "ignored_repository").inc()
            message.ack()
            return
        try:
            if event == "workflow_run":
                self.database.upsert_run(repository, obj)
            else:
                self.database.upsert_job(repository, obj)
            now = self._clock()
            self.database.record_event(repository, now)
        except Exception:
            LOGGER.exception(
                "failed to store %s message %s for %s; it will be redelivered",
                event,
                attributes.get("delivery_id", "?"),
                repository,
            )
            self.state.messages.labels(event, "error").inc()
            message.nack()
            return
        self.state.last_event.labels(repository).set(now)
        self.state.messages.labels(event, "stored").inc()
        self._changed.set()
        message.ack()

    def refresh_snapshot_if_changed(self) -> None:
        """Re-aggregate stored history for /metrics after new events.

        A failure propagates and exits the process (Docker restarts it)
        rather than serving stale history silently.
        """
        if not self._changed.is_set():
            return
        self._changed.clear()
        self.metrics.refresh()

    def stream_once(self, subscriber: Any) -> None:
        """Hold one streaming pull open until it stops, logging why it stopped.

        A snapshot refresh failure is not a stream failure; it propagates.
        """
        subscription = self.config.subscription
        try:
            future = subscriber.subscribe(
                subscription,
                callback=self.handle_message,
                flow_control=FlowControl(max_messages=MAX_OUTSTANDING_MESSAGES),
                # Let in-flight callbacks finish their SQLite write before
                # stream_once returns, so main() never closes the database
                # under a running callback.
                await_callbacks_on_shutdown=True,
            )
        except Exception:
            LOGGER.exception("could not open the streaming pull on %s", subscription)
            return
        self.state.subscription_running.set(1)
        LOGGER.info("streaming pull open on %s", subscription)
        try:
            while True:
                try:
                    future.result(timeout=SNAPSHOT_REFRESH_SECONDS)
                except TimeoutError:
                    if future.done():
                        LOGGER.exception("streaming pull on %s failed", subscription)
                        return
                except Exception:
                    LOGGER.exception("streaming pull on %s failed", subscription)
                    return
                else:
                    LOGGER.warning("streaming pull on %s closed", subscription)
                    return
                self.refresh_snapshot_if_changed()
        finally:
            self.state.subscription_running.set(0)
            future.cancel()
            try:
                future.result(timeout=SHUTDOWN_WAIT_SECONDS)
            except Exception as exc:  # noqa: BLE001 -- any outcome of a cancelled stream
                # Cancellation itself ends the future with an error; the
                # reason the stream stopped was already logged above.
                LOGGER.debug("streaming pull on %s shut down: %r", subscription, exc)

    def run_forever(self, subscriber: Any) -> None:
        """Hold the streaming pull open, reopening it with a bounded delay."""
        delay = RECONNECT_MIN_SECONDS
        while True:
            started = self._monotonic()
            self.stream_once(subscriber)
            self.state.subscription_failures.inc()
            if self._monotonic() - started >= RECONNECT_RESET_SECONDS:
                delay = RECONNECT_MIN_SECONDS
            LOGGER.info("reopening the streaming pull in %.0fs", delay)
            self.refresh_snapshot_if_changed()
            self._sleep(delay)
            delay = min(delay * 2, RECONNECT_MAX_SECONDS)


def with_health_endpoint(metrics_app: Callable) -> Callable:
    """Wrap the metrics WSGI app with a constant-cost liveness endpoint.

    prometheus_client serves the metrics payload on *every* GET path on
    purpose -- exposition.make_wsgi_app carries an explicit "for backwards
    compatibility, the URI path for GET is not constrained to the documented
    /metrics" branch. So a container healthcheck aimed anywhere at this
    server renders and discards the whole registry: 3.4 MB and 2.6-3.6s per
    probe as of homelab#1204, growing with the number of tracked runs. That
    is what made a probe on a 2s client timeout fail forever while Prometheus
    itself was scraping the exporter fine (`up=1`).

    Serving HEALTH_PATH ahead of the metrics app keeps the probe O(1) as the
    registry grows, so the fix does not quietly expire the way raising the
    timeout would. It deliberately proves only that the HTTP server thread is
    accepting and answering requests -- the event stream's own health is
    exported as metrics (subscription_running, last_event_timestamp_seconds)
    and alerted on there, and folding that in would make a probe failure
    ambiguous between "process wedged" and "Pub/Sub is unreachable".
    """

    def app(environ: dict[str, Any], start_response: Callable) -> list[bytes]:
        if (
            environ.get("PATH_INFO") == HEALTH_PATH
            and environ.get("REQUEST_METHOD") == "GET"
        ):
            body = b"ok\n"
            start_response(
                "200 OK",
                [
                    ("Content-Type", "text/plain; charset=utf-8"),
                    ("Content-Length", str(len(body))),
                ],
            )
            return [body]
        return metrics_app(environ, start_response)

    return app


def main() -> None:
    logging.basicConfig(
        level=os.environ.get("LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)s %(message)s",
    )
    config = Config.from_environment()
    registry = CollectorRegistry()
    state = ExporterState(registry)
    database = Database(config.database_path)
    with ExitStack() as resources:
        resources.callback(database.close)
        metrics = DatabaseMetrics(database)
        metrics.refresh()
        registry.register(metrics)
        consumer = EventConsumer(config, database, state, metrics)
        # Credentials come from GOOGLE_APPLICATION_CREDENTIALS.
        subscriber = SubscriberClient()
        resources.callback(subscriber.close)

        http_server, http_thread = start_http_server(config.port, registry=registry)
        # set_app/get_app are wsgiref.simple_server.WSGIServer's own API, so
        # the health endpoint composes onto whatever start_http_server built
        # rather than reimplementing its address-family, threading, and
        # request-handler choices against prometheus_client's private helpers.
        http_server.set_app(with_health_endpoint(http_server.get_app()))
        resources.callback(http_server.server_close)
        resources.callback(http_thread.join)
        resources.callback(http_server.shutdown)
        LOGGER.info(
            "serving metrics on :%d for %s",
            config.port,
            ", ".join(config.repositories),
        )
        consumer.run_forever(subscriber)


if __name__ == "__main__":
    main()

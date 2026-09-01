"""Collect GitHub Actions workflow/job metrics without unbounded labels."""

from __future__ import annotations

import logging
import os
import sqlite3
import threading
import time
from collections.abc import Iterable, Sequence
from contextlib import ExitStack
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import requests
from prometheus_client import CollectorRegistry, Counter, Gauge, start_http_server
from prometheus_client.core import (
    CounterMetricFamily,
    GaugeMetricFamily,
    HistogramMetricFamily,
)

LOGGER = logging.getLogger(__name__)

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
MAX_JOB_LABELS_PER_WORKFLOW = 100
OVERFLOW_JOB_LABEL = "__other__"
MAX_CONCURRENCY_GROUP_LABELS_PER_WORKFLOW = 100
OVERFLOW_CONCURRENCY_GROUP_LABEL = "__other__"
FULL_SUITE_STEP_MARKER = "[full-suite]"
PAGE_SIZE = 100
RUN_SEARCH_LIMIT = 1000
ONE_SECOND = timedelta(seconds=1)


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
    token: str
    repositories: tuple[str, ...]
    api_url: str = "https://api.github.com"
    api_version: str = "2022-11-28"
    poll_interval_seconds: int = 60
    backfill_hours: int = 1
    overlap_minutes: int = 15
    database_path: str = "/var/lib/github-actions-exporter/actions.db"
    port: int = 9102

    @classmethod
    def from_environment(cls) -> Config:
        token = environment_text("GITHUB_TOKEN")

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

        api_url = environment_text("GITHUB_API_URL", "https://api.github.com").rstrip(
            "/"
        )
        parsed_api_url = urlsplit(api_url)
        if (
            parsed_api_url.scheme not in {"http", "https"}
            or not parsed_api_url.netloc
            or parsed_api_url.query
            or parsed_api_url.fragment
        ):
            raise ValueError("GITHUB_API_URL must be an absolute HTTP(S) URL")

        api_version = environment_text("GITHUB_API_VERSION", "2022-11-28")
        try:
            date.fromisoformat(api_version)
        except ValueError:
            raise ValueError("GITHUB_API_VERSION must use YYYY-MM-DD") from None

        return cls(
            token=token,
            repositories=repositories,
            api_url=api_url,
            api_version=api_version,
            poll_interval_seconds=environment_int(
                "POLL_INTERVAL_SECONDS", 60, minimum=15
            ),
            backfill_hours=environment_int("BACKFILL_HOURS", 1),
            overlap_minutes=environment_int("OVERLAP_MINUTES", 15),
            database_path=environment_text(
                "DATABASE_PATH", "/var/lib/github-actions-exporter/actions.db"
            ),
            port=environment_int("PORT", 9102, maximum=65535),
        )


class ExporterState:
    """Prometheus metrics for the collector itself."""

    def __init__(self, registry: CollectorRegistry) -> None:
        self.last_success = Gauge(
            "github_actions_exporter_last_success_timestamp_seconds",
            "Unix timestamp of the last successful repository refresh.",
            ("repository",),
            registry=registry,
        )
        self.poll_errors = Counter(
            "github_actions_exporter_poll_errors_total",
            "GitHub Actions collection errors.",
            ("repository", "stage"),
            registry=registry,
        )
        self.api_requests = Counter(
            "github_actions_exporter_api_requests_total",
            "GitHub API requests made by the exporter.",
            ("endpoint", "status"),
            registry=registry,
        )
        self.api_rate_remaining = Gauge(
            "github_actions_exporter_api_rate_limit_remaining",
            "Requests remaining in GitHub's current core API rate window.",
            registry=registry,
        )
        self.api_rate_limit = Gauge(
            "github_actions_exporter_api_rate_limit_limit",
            "Maximum requests in GitHub's current core API rate window.",
            registry=registry,
        )
        self.api_rate_used = Gauge(
            "github_actions_exporter_api_rate_limit_used",
            "Requests used in GitHub's current core API rate window.",
            registry=registry,
        )
        self.api_rate_reset_timestamp = Gauge(
            "github_actions_exporter_api_rate_limit_reset_timestamp_seconds",
            "Unix timestamp when GitHub's current core API rate window resets.",
            registry=registry,
        )
        self.backfill_in_progress = Gauge(
            "github_actions_exporter_backfill_in_progress",
            "Whether a repository's initial history import is running.",
            ("repository",),
            registry=registry,
        )

    def record_response(self, endpoint: str, response: requests.Response) -> None:
        self.api_requests.labels(endpoint, str(response.status_code)).inc()
        for header, metric in (
            ("x-ratelimit-remaining", self.api_rate_remaining),
            ("x-ratelimit-limit", self.api_rate_limit),
            ("x-ratelimit-used", self.api_rate_used),
            ("x-ratelimit-reset", self.api_rate_reset_timestamp),
        ):
            value = response.headers.get(header)
            if value is None:
                continue
            try:
                count = int(value)
            except ValueError:
                LOGGER.warning(
                    "GitHub returned an invalid rate-limit header: %s", header
                )
            else:
                if count < 0:
                    LOGGER.warning(
                        "GitHub returned an invalid rate-limit header: %s", header
                    )
                else:
                    metric.set(count)


class GitHubRequestError(RuntimeError):
    """An HTTP failure from GitHub that callers may handle by status."""

    def __init__(self, endpoint: str, response: requests.Response) -> None:
        self.status_code = response.status_code
        request_id = response.headers.get("x-github-request-id", "unknown")
        super().__init__(
            f"GitHub {endpoint} request failed with HTTP {response.status_code} "
            f"(request {request_id})"
        )


class GitHubAPI:
    def __init__(self, config: Config, state: ExporterState) -> None:
        self.api_url = config.api_url
        self.state = state
        self.session = requests.Session()
        self.session.headers.update(
            {
                "Accept": "application/vnd.github+json",
                "Authorization": f"Bearer {config.token}",
                "User-Agent": "homelab-github-actions-exporter/1.0",
                "X-GitHub-Api-Version": config.api_version,
            }
        )

    def close(self) -> None:
        self.session.close()

    def get(
        self, path: str, *, endpoint: str, params: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        response = self.session.get(
            f"{self.api_url}{path}", params=params, timeout=(5, 30)
        )
        try:
            self.state.record_response(endpoint, response)
            try:
                response.raise_for_status()
            except requests.HTTPError as exc:
                raise GitHubRequestError(endpoint, response) from exc
            payload = response.json()
            if not isinstance(payload, dict):
                raise TypeError(f"GitHub {endpoint} response was not an object")
            return payload
        finally:
            response.close()

    def list_runs(
        self, repository: str, cutoff: datetime, until: datetime
    ) -> list[dict[str, Any]]:
        start = cutoff.astimezone(UTC).replace(microsecond=0)
        end = until.astimezone(UTC).replace(microsecond=0)
        if end < start:
            return []
        return self._list_runs_window(repository, start, end)

    def _list_runs_window(
        self,
        repository: str,
        start: datetime,
        end: datetime,
    ) -> list[dict[str, Any]]:
        path = f"/repos/{repository}/actions/runs"
        params = {
            "created": (
                f"{start.isoformat(timespec='seconds')}.."
                f"{end.isoformat(timespec='seconds')}"
            ),
            "exclude_pull_requests": "true",
        }
        first_payload = self.get(
            path,
            endpoint="runs",
            params={**params, "per_page": PAGE_SIZE, "page": 1},
        )
        _, total_count = self._page(first_payload, "workflow_runs")
        if total_count >= RUN_SEARCH_LIMIT:
            if start == end:
                raise RuntimeError(
                    "GitHub workflow run search exceeded the 1,000-result cap "
                    "within a one-second window"
                )
            midpoint = (start + (end - start) / 2).replace(microsecond=0)
            newer = self._list_runs_window(repository, midpoint + ONE_SECOND, end)
            older = self._list_runs_window(repository, start, midpoint)
            return newer + older
        return self._list_paginated(
            path,
            endpoint="runs",
            key="workflow_runs",
            params=params,
            first_payload=first_payload,
        )

    def get_run(self, repository: str, run_id: int) -> dict[str, Any]:
        return self.get(f"/repos/{repository}/actions/runs/{run_id}", endpoint="run")

    def get_run_attempt(
        self, repository: str, run_id: int, attempt: int
    ) -> dict[str, Any]:
        return self.get(
            f"/repos/{repository}/actions/runs/{run_id}/attempts/{attempt}",
            endpoint="run_attempt",
        )

    def list_jobs(self, repository: str, run_id: int) -> list[dict[str, Any]]:
        return self._list_paginated(
            f"/repos/{repository}/actions/runs/{run_id}/jobs",
            endpoint="jobs",
            key="jobs",
            params={"filter": "all"},
        )

    def list_concurrency_groups(
        self, repository: str, run_id: int
    ) -> list[dict[str, Any]]:
        """Return the concurrency groups GitHub associates with a run.

        GitHub returns at most 100 groups for a run. That is safely above a
        workflow's practical group count and avoids a second, cursor-based
        pagination implementation on the normal polling path.
        """
        payload = self.get(
            f"/repos/{repository}/actions/runs/{run_id}/concurrency_groups",
            endpoint="concurrency_groups",
            params={"per_page": 100},
        )
        groups = payload.get("concurrency_groups", [])
        if not isinstance(groups, list) or not all(
            isinstance(group, dict) for group in groups
        ):
            raise TypeError("GitHub concurrency-groups response was invalid")
        return groups

    def _list_paginated(
        self,
        path: str,
        *,
        endpoint: str,
        key: str,
        params: dict[str, Any],
        first_payload: dict[str, Any] | None = None,
    ) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        item_ids: set[int] = set()
        page = 1
        while True:
            payload = (
                first_payload
                if page == 1 and first_payload is not None
                else self.get(
                    path,
                    endpoint=endpoint,
                    params={**params, "per_page": PAGE_SIZE, "page": page},
                )
            )
            batch, total_count = self._page(payload, key)
            for item in batch:
                item_id = item.get("id")
                if (
                    not isinstance(item_id, int)
                    or isinstance(item_id, bool)
                    or item_id <= 0
                ):
                    raise TypeError(f"GitHub {key} response contained an invalid id")
                if item_id in item_ids:
                    raise RuntimeError(
                        f"GitHub {key} response contained a duplicate id"
                    )
                item_ids.add(item_id)
            items.extend(batch)
            if len(items) > total_count:
                raise RuntimeError(f"GitHub {key} returned more items than total_count")
            if len(items) == total_count:
                break
            if len(batch) < PAGE_SIZE:
                raise RuntimeError(
                    f"GitHub {key} returned {len(items)} of {total_count} items"
                )
            page += 1
        return items

    @staticmethod
    def _page(payload: dict[str, Any], key: str) -> tuple[list[dict[str, Any]], int]:
        total_count = payload.get("total_count")
        if (
            not isinstance(total_count, int)
            or isinstance(total_count, bool)
            or total_count < 0
        ):
            raise TypeError(f"GitHub {key} response lacked a valid total_count")
        batch = payload.get(key)
        if not isinstance(batch, list):
            raise TypeError(f"GitHub {key} response was not a list")
        if not all(isinstance(item, dict) for item in batch):
            raise TypeError(f"GitHub {key} response contained a non-object item")
        return batch, total_count


class Database:
    """Thread-safe durable store used both by polling and Prometheus scrapes."""

    def __init__(self, path: str) -> None:
        database_path = Path(path)
        database_path.parent.mkdir(parents=True, exist_ok=True)
        self.connection = sqlite3.connect(path, check_same_thread=False)
        self.connection.row_factory = sqlite3.Row
        self.lock = threading.RLock()
        try:
            job_rows, concurrency_group_rows = self._initialize_schema()
        except BaseException:
            self.connection.close()
            raise
        self.job_labels: dict[tuple[str, str], set[str]] = {}
        for row in job_rows:
            self.job_labels.setdefault((row["repository"], row["workflow"]), set()).add(
                row["name"]
            )
        self.concurrency_group_labels: dict[tuple[str, str], set[str]] = {}
        for row in concurrency_group_rows:
            self.concurrency_group_labels.setdefault(
                (row["repository"], row["workflow"]), set()
            ).add(row["concurrency_group"])

    def _initialize_schema(self) -> tuple[list[sqlite3.Row], list[sqlite3.Row]]:
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
                    jobs_updated_at REAL,
                    PRIMARY KEY (repository, id, run_attempt)
                );

                CREATE TABLE IF NOT EXISTS jobs (
                    repository TEXT NOT NULL,
                    id INTEGER NOT NULL,
                    run_id INTEGER NOT NULL,
                    workflow TEXT NOT NULL,
                    name TEXT NOT NULL,
                    status TEXT NOT NULL,
                    conclusion TEXT,
                    created_at REAL,
                    started_at REAL,
                    completed_at REAL,
                    runner_group TEXT NOT NULL,
                    execution TEXT NOT NULL DEFAULT 'unknown',
                    concurrency_group TEXT NOT NULL DEFAULT 'none',
                    PRIMARY KEY (repository, id)
                );

                CREATE TABLE IF NOT EXISTS repository_state (
                    repository TEXT PRIMARY KEY,
                    initial_backfill_complete INTEGER NOT NULL DEFAULT 0,
                    last_success_at REAL
                );

                CREATE INDEX IF NOT EXISTS workflow_runs_status_idx
                    ON workflow_runs (repository, status);
                CREATE INDEX IF NOT EXISTS jobs_status_idx
                    ON jobs (repository, status);
                CREATE INDEX IF NOT EXISTS jobs_run_idx
                    ON jobs (repository, run_id);
                """
            )
            columns = {
                row["name"]
                for row in self.connection.execute("PRAGMA table_info(jobs)")
            }
            if "concurrency_group" not in columns:
                self.connection.execute(
                    "ALTER TABLE jobs ADD COLUMN concurrency_group TEXT NOT NULL DEFAULT 'none'"
                )
            if "execution" not in columns:
                self.connection.execute(
                    "ALTER TABLE jobs ADD COLUMN execution TEXT NOT NULL DEFAULT 'unknown'"
                )
            if "runs_on" not in columns:
                self.connection.execute(
                    "ALTER TABLE jobs ADD COLUMN runs_on TEXT NOT NULL DEFAULT ''"
                )
            active_placeholders = ",".join("?" for _ in ACTIVE_STATUSES)
            # A completed workflow cannot still have a queued/running job. GitHub's
            # run endpoint can become terminal a poll before its jobs endpoint does;
            # older versions stamped that contradictory snapshot as final and then
            # exported a phantom queue forever. Suppress any persisted impossible
            # rows on startup and leave their run eligible for a later refresh.
            self.connection.execute(
                f"""
                UPDATE jobs SET status = 'refresh_pending'
                WHERE status IN ({active_placeholders})
                  AND EXISTS (
                    SELECT 1 FROM workflow_runs
                    WHERE workflow_runs.repository = jobs.repository
                      AND workflow_runs.id = jobs.run_id
                      AND workflow_runs.status = 'completed'
                      AND workflow_runs.run_attempt = (
                        SELECT MAX(latest.run_attempt) FROM workflow_runs AS latest
                        WHERE latest.repository = jobs.repository
                          AND latest.id = jobs.run_id
                      )
                  )
                """,
                ACTIVE_STATUSES,
            )
            self.connection.execute(
                """
                UPDATE workflow_runs SET jobs_updated_at = NULL
                WHERE status = 'completed'
                  AND EXISTS (
                    SELECT 1 FROM jobs
                    WHERE jobs.repository = workflow_runs.repository
                      AND jobs.run_id = workflow_runs.id
                      AND jobs.status = 'refresh_pending'
                  )
                """
            )
            job_rows = self.connection.execute(
                """
                SELECT DISTINCT repository, workflow, name FROM jobs
                WHERE name != ?
                """,
                (OVERFLOW_JOB_LABEL,),
            ).fetchall()
            concurrency_group_rows = self.connection.execute(
                """
                SELECT DISTINCT repository, workflow, concurrency_group FROM jobs
                WHERE concurrency_group != ?
                """,
                (OVERFLOW_CONCURRENCY_GROUP_LABEL,),
            ).fetchall()
        return job_rows, concurrency_group_rows

    def close(self) -> None:
        with self.lock:
            self.connection.close()

    def backfill_complete(self, repository: str) -> bool:
        with self.lock:
            row = self.connection.execute(
                """
                SELECT initial_backfill_complete FROM repository_state
                WHERE repository = ?
                """,
                (repository,),
            ).fetchone()
        return row is not None and bool(row["initial_backfill_complete"])

    def last_success_at(self, repository: str) -> float | None:
        with self.lock:
            row = self.connection.execute(
                """
                SELECT last_success_at FROM repository_state
                WHERE repository = ?
                """,
                (repository,),
            ).fetchone()
        if row is None or row["last_success_at"] is None:
            return None
        return float(row["last_success_at"])

    def record_refresh_success(
        self,
        repository: str,
        *,
        initial: bool,
        timestamp: float | None = None,
    ) -> float:
        success_at = time.time() if timestamp is None else timestamp
        with self.lock, self.connection:
            self.connection.execute(
                """
                INSERT INTO repository_state (
                    repository, initial_backfill_complete, last_success_at
                ) VALUES (?, ?, ?)
                ON CONFLICT(repository) DO UPDATE SET
                    initial_backfill_complete = MAX(
                        repository_state.initial_backfill_complete,
                        excluded.initial_backfill_complete
                    ),
                    last_success_at = excluded.last_success_at
                """,
                (repository, int(initial), success_at),
            )
        return success_at

    def active_run_ids(self, repository: str) -> set[int]:
        placeholders = ",".join("?" for _ in ACTIVE_STATUSES)
        with self.lock:
            rows = self.connection.execute(
                f"""
                SELECT id FROM workflow_runs
                WHERE repository = ? AND status IN ({placeholders})
                """,
                (repository, *ACTIVE_STATUSES),
            ).fetchall()
        return {int(row["id"]) for row in rows}

    def pending_job_refresh_run_ids(self, repository: str) -> set[int]:
        """Return terminal runs whose jobs API snapshot was contradictory."""
        with self.lock:
            rows = self.connection.execute(
                """
                SELECT id FROM workflow_runs
                WHERE repository = ? AND status = 'completed'
                  AND jobs_updated_at IS NULL
                  AND run_attempt = (
                    SELECT MAX(latest.run_attempt) FROM workflow_runs AS latest
                    WHERE latest.repository = workflow_runs.repository
                      AND latest.id = workflow_runs.id
                  )
                """,
                (repository,),
            ).fetchall()
        return {int(row["id"]) for row in rows}

    def mark_run_missing(self, repository: str, run_id: int) -> None:
        """Retire active metrics for a workflow GitHub no longer exposes."""
        placeholders = ",".join("?" for _ in ACTIVE_STATUSES)
        with self.lock, self.connection:
            parameters = (repository, run_id, *ACTIVE_STATUSES)
            self.connection.execute(
                f"""
                UPDATE workflow_runs SET status = 'missing'
                WHERE repository = ? AND id = ?
                  AND status IN ({placeholders})
                """,
                parameters,
            )
            self.connection.execute(
                """
                UPDATE workflow_runs SET status = 'missing'
                WHERE repository = ? AND id = ?
                  AND status = 'completed' AND jobs_updated_at IS NULL
                  AND run_attempt = (
                    SELECT MAX(latest.run_attempt) FROM workflow_runs AS latest
                    WHERE latest.repository = workflow_runs.repository
                      AND latest.id = workflow_runs.id
                  )
                """,
                (repository, run_id),
            )
            self.connection.execute(
                f"""
                UPDATE jobs SET status = 'missing'
                WHERE repository = ? AND run_id = ?
                  AND status IN ({placeholders})
                """,
                parameters,
            )
            self.connection.execute(
                """
                UPDATE jobs SET status = 'missing'
                WHERE repository = ? AND run_id = ?
                  AND status = 'refresh_pending'
                """,
                (repository, run_id),
            )

    def run_attempt_gaps(self, repository: str) -> list[tuple[int, tuple[int, ...]]]:
        """Return known reruns whose earlier attempts have not been stored."""
        with self.lock:
            rows = self.connection.execute(
                """
                SELECT id, MAX(run_attempt) AS latest_attempt,
                       GROUP_CONCAT(DISTINCT run_attempt) AS stored_attempts
                FROM workflow_runs
                WHERE repository = ?
                GROUP BY id
                HAVING MAX(run_attempt) > COUNT(DISTINCT run_attempt)
                """,
                (repository,),
            ).fetchall()
        gaps = []
        for row in rows:
            stored = {int(value) for value in row["stored_attempts"].split(",")}
            missing = tuple(
                attempt
                for attempt in range(1, int(row["latest_attempt"]))
                if attempt not in stored
            )
            gaps.append((int(row["id"]), missing))
        return gaps

    def jobs_need_refresh(self, repository: str, run: dict[str, Any]) -> bool:
        run_id = int(run["id"])
        updated_at = parse_timestamp(run.get("updated_at")) or 0
        with self.lock:
            row = self.connection.execute(
                """
                SELECT status, jobs_updated_at FROM workflow_runs
                WHERE repository = ? AND id = ? AND run_attempt = ?
                """,
                (repository, run_id, int(run.get("run_attempt") or 1)),
            ).fetchone()
        if row is None or run.get("status") != "completed":
            return True
        return (
            row["jobs_updated_at"] is None or float(row["jobs_updated_at"]) < updated_at
        )

    def upsert_run(self, repository: str, run: dict[str, Any]) -> None:
        status = metric_label(run.get("status"))
        updated_at = parse_timestamp(run.get("updated_at"))
        completed_at = updated_at if status == "completed" else None
        run_id = int(run["id"])
        run_attempt = int(run.get("run_attempt") or 1)
        with self.lock, self.connection:
            self.connection.execute(
                """
                INSERT INTO workflow_runs (
                    repository, id, workflow, event, status, conclusion,
                    created_at, started_at, completed_at, updated_at, run_attempt
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(repository, id, run_attempt) DO UPDATE SET
                    workflow = excluded.workflow,
                    event = excluded.event,
                    status = excluded.status,
                    conclusion = excluded.conclusion,
                    created_at = excluded.created_at,
                    started_at = excluded.started_at,
                    completed_at = excluded.completed_at,
                    updated_at = excluded.updated_at
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
                ),
            )
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

    def upsert_jobs(
        self,
        repository: str,
        run: dict[str, Any],
        jobs: Sequence[dict[str, Any]],
        concurrency_groups: Sequence[dict[str, Any]] | None = None,
    ) -> None:
        run_id = int(run["id"])
        workflow = workflow_label(run)
        groups_by_job: dict[int, str] = {}
        run_groups: list[str] = []
        for group in concurrency_groups or ():
            name = metric_label(group.get("group_name"), "none")
            members = group.get("group_members", [])
            if not isinstance(members, list):
                continue
            has_job_member = False
            for member in members:
                if not isinstance(member, dict) or member.get("job_id") is None:
                    continue
                groups_by_job[int(member["job_id"])] = name
                has_job_member = True
            if not has_job_member:
                run_groups.append(name)
        run_group = ",".join(sorted(set(run_groups)))
        if not run_group:
            # GitHub's own `.../actions/runs/{id}/concurrency_groups` listing
            # is documented to intermittently -- and for some trigger types
            # unconditionally -- report zero group membership for a run even
            # when a job genuinely holds a concurrency group; see
            # apps/dispatch-broker/src/github-api.ts:398-449 for sampled
            # failure rates from 17% to 100% depending on trigger, never
            # fully explained by ordinary listing lag. `concurrency_groups is
            # None` means the caller never attempted the listing at all (a
            # non-active run, whose jobs never surface in the "current"
            # gauge anyway); an attempted-but-empty listing is
            # indistinguishable from a failed one, so label it "unknown"
            # rather than asserting an unconfirmed "none".
            run_group = "none" if concurrency_groups is None else "unknown"
        with self.lock, self.connection:
            for job in jobs:
                name = self.bounded_job_name(
                    repository, workflow, metric_label(job.get("name"))
                )
                concurrency_group = self.bounded_concurrency_group(
                    repository,
                    workflow,
                    groups_by_job.get(int(job["id"]), run_group),
                )
                self.connection.execute(
                    """
                    INSERT INTO jobs (
                        repository, id, run_id, workflow, name, status,
                        conclusion, created_at, started_at, completed_at,
                        runner_group, execution, concurrency_group, runs_on
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(repository, id) DO UPDATE SET
                        run_id = excluded.run_id,
                        workflow = excluded.workflow,
                        name = excluded.name,
                        status = excluded.status,
                        conclusion = excluded.conclusion,
                        created_at = excluded.created_at,
                        started_at = excluded.started_at,
                        completed_at = excluded.completed_at,
                        runner_group = excluded.runner_group,
                        execution = excluded.execution,
                        concurrency_group = excluded.concurrency_group,
                        runs_on = excluded.runs_on
                    """,
                    (
                        repository,
                        int(job["id"]),
                        run_id,
                        workflow,
                        name,
                        metric_label(job.get("status")),
                        job.get("conclusion"),
                        parse_timestamp(job.get("created_at")),
                        parse_timestamp(job.get("started_at")),
                        parse_timestamp(job.get("completed_at")),
                        metric_label(job.get("runner_group_name"), "unassigned"),
                        job_execution(job),
                        concurrency_group,
                        job_runs_on(job),
                    ),
                )
            jobs_snapshot_consistent = True
            run_attempt = int(run.get("run_attempt") or 1)
            latest_attempt = self.connection.execute(
                """
                SELECT MAX(run_attempt) AS latest_attempt FROM workflow_runs
                WHERE repository = ? AND id = ?
                """,
                (repository, run_id),
            ).fetchone()
            if (
                metric_label(run.get("status")) == "completed"
                and latest_attempt is not None
                and run_attempt == int(latest_attempt["latest_attempt"])
            ):
                active_placeholders = ",".join("?" for _ in ACTIVE_STATUSES)
                active_jobs = self.connection.execute(
                    f"""
                    SELECT 1 FROM jobs
                    WHERE repository = ? AND run_id = ?
                      AND (
                        status IN ({active_placeholders})
                        OR status = 'refresh_pending'
                      )
                    LIMIT 1
                    """,
                    (repository, run_id, *ACTIVE_STATUSES),
                ).fetchone()
                if active_jobs is not None:
                    jobs_snapshot_consistent = False
                    self.connection.execute(
                        f"""
                        UPDATE jobs SET status = 'refresh_pending'
                        WHERE repository = ? AND run_id = ?
                          AND status IN ({active_placeholders})
                        """,
                        (repository, run_id, *ACTIVE_STATUSES),
                    )
            jobs_updated_at = None
            if jobs_snapshot_consistent:
                jobs_updated_at = parse_timestamp(run.get("updated_at")) or time.time()
            self.connection.execute(
                """
                UPDATE workflow_runs SET jobs_updated_at = ?
                WHERE repository = ? AND id = ? AND run_attempt = ?
                """,
                (
                    jobs_updated_at,
                    repository,
                    run_id,
                    run_attempt,
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

    def bounded_concurrency_group(
        self, repository: str, workflow: str, name: str
    ) -> str:
        """Cap dynamic concurrency-group label values while preserving familiar names.

        Concurrency group names embed per-run data -- branch ref, PR number,
        commit SHA (see .github/workflows/ci.yml:14-16 and
        .github/workflows/agent-automerge.yml:82-83,139-140) -- so exporting
        the raw name would create one retained time series per branch/PR/SHA.
        Apply the same per-(repository, workflow) cardinality cap already
        used above for dynamic job names.
        """
        with self.lock:
            labels = self.concurrency_group_labels.setdefault(
                (repository, workflow), set()
            )
            if name in labels:
                return name
            if len(labels) >= MAX_CONCURRENCY_GROUP_LABELS_PER_WORKFLOW:
                return OVERFLOW_CONCURRENCY_GROUP_LABEL
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


class DatabaseMetrics:
    def __init__(self, database: Database) -> None:
        self.database = database

    def collect(self):
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

        # The most recent decisive (success/failure-class, non-pull_request)
        # runs of each workflow that did not succeed, counted back from the
        # latest until the first success. Counters alone cannot express run
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
        # The stored history starts at BACKFILL_HOURS on a freshly created
        # database, so a streak that reaches the oldest stored run without
        # meeting a success may be longer than reported. The database lives on
        # a persistent volume, so this only applies to a brand-new deployment;
        # the alert still fires at two observed failures rather than waiting,
        # and this gauge lets a dashboard say when the count is exact.
        consecutive_failures_complete = GaugeMetricFamily(
            "github_actions_workflow_consecutive_failures_complete",
            "1 when the consecutive-failure count is bounded by a stored success (or is 0); 0 when it is a lower bound because stored history ends before the last success.",
            labels=("repository", "workflow"),
        )
        for row in self.database.rows(
            """
            WITH ordered AS (
                SELECT repository, workflow, conclusion,
                       ROW_NUMBER() OVER (
                           PARTITION BY repository, workflow
                           ORDER BY COALESCE(created_at, 0) DESC, id DESC, run_attempt DESC
                       ) AS rn
                FROM workflow_runs
                WHERE status = 'completed'
                  AND event != 'pull_request'
                  AND conclusion IN ('success', 'failure', 'timed_out',
                                     'action_required', 'startup_failure')
            ),
            first_success AS (
                SELECT repository, workflow, MIN(rn) AS rn
                FROM ordered
                WHERE conclusion = 'success'
                GROUP BY repository, workflow
            )
            SELECT o.repository, o.workflow,
                   SUM(CASE WHEN o.conclusion != 'success'
                                 AND (s.rn IS NULL OR o.rn < s.rn)
                            THEN 1 ELSE 0 END) AS streak,
                   MAX(CASE WHEN s.rn IS NULL THEN 0 ELSE 1 END) AS bounded
            FROM ordered o
            LEFT JOIN first_success s
                   ON s.repository = o.repository AND s.workflow = o.workflow
            GROUP BY o.repository, o.workflow
            """
        ):
            consecutive_failures.add_metric(
                [row["repository"], row["workflow"]], float(row["streak"])
            )
            consecutive_failures_complete.add_metric(
                [row["repository"], row["workflow"]],
                1.0 if row["bounded"] or row["streak"] == 0 else 0.0,
            )
        yield consecutive_failures
        yield consecutive_failures_complete

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
                "concurrency_group",
                "runs_on",
            ),
        )
        for row in self.database.rows(
            f"""
            SELECT repository, workflow, name, status, runner_group, concurrency_group,
                   runs_on, COUNT(*) AS total
            FROM jobs
            WHERE status IN ({placeholders})
            GROUP BY repository, workflow, name, status, runner_group, concurrency_group,
                     runs_on
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
                    row["concurrency_group"],
                    row["runs_on"],
                ],
                float(row["total"]),
            )
        yield current_jobs

        oldest_queued = GaugeMetricFamily(
            "github_actions_job_oldest_queued_seconds",
            "Age in seconds of the oldest currently queued job. runs_on is the fleet label the job targets, empty for GitHub-hosted jobs (agent-lcars#1699).",
            labels=("repository", "workflow", "job", "runs_on"),
        )
        placeholders = ",".join("?" for _ in QUEUED_STATUSES)
        now = time.time()
        for row in self.database.rows(
            f"""
            SELECT repository, workflow, name, runs_on, MIN(created_at) AS oldest
            FROM jobs
            WHERE status IN ({placeholders}) AND created_at IS NOT NULL
            GROUP BY repository, workflow, name, runs_on
            """,
            QUEUED_STATUSES,
        ):
            oldest_queued.add_metric(
                [row["repository"], row["workflow"], row["name"], row["runs_on"]],
                max(0, now - float(row["oldest"])),
            )
        yield oldest_queued

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


class Poller:
    def __init__(
        self,
        config: Config,
        database: Database,
        api: GitHubAPI,
        state: ExporterState,
    ) -> None:
        self.config = config
        self.database = database
        self.api = api
        self.state = state
        for repository in config.repositories:
            last_success = self.database.last_success_at(repository)
            self.state.last_success.labels(repository).set(
                0 if last_success is None else last_success
            )
            self.state.backfill_in_progress.labels(repository).set(0)

    def refresh_repository(self, repository: str) -> None:
        initial = not self.database.backfill_complete(repository)
        if initial:
            self.state.backfill_in_progress.labels(repository).set(1)
        try:
            now = datetime.now(UTC)
            overlap = timedelta(minutes=self.config.overlap_minutes)
            if initial:
                cutoff = now - timedelta(hours=self.config.backfill_hours)
            else:
                last_success = self.database.last_success_at(repository)
                recovery_cutoff = (
                    datetime.fromtimestamp(last_success, UTC) - overlap
                    if last_success is not None
                    else now - timedelta(hours=self.config.backfill_hours)
                )
                cutoff = min(now - overlap, recovery_cutoff)
            runs = self.api.list_runs(repository, cutoff, now)
            discovered_ids: set[int] = set()
            for run in runs:
                discovered_ids.add(int(run["id"]))
                self._store_run(repository, run)

            # A long-running workflow can be older than the overlap and pushed
            # off the newest-runs pages. Persisted active IDs keep it observed.
            persisted_ids = self.database.active_run_ids(repository)
            persisted_ids |= self.database.pending_job_refresh_run_ids(repository)
            for run_id in persisted_ids - discovered_ids:
                try:
                    run = self.api.get_run(repository, run_id)
                except GitHubRequestError as exc:
                    if exc.status_code != 404:
                        raise
                    LOGGER.warning(
                        "retiring missing workflow run %s from %s",
                        run_id,
                        repository,
                    )
                    self.database.mark_run_missing(repository, run_id)
                    continue
                self._store_run(repository, run)

            for run_id, attempts in self.database.run_attempt_gaps(repository):
                for attempt in attempts:
                    self.database.upsert_run(
                        repository,
                        self.api.get_run_attempt(repository, run_id, attempt),
                    )

            success_at = self.database.record_refresh_success(
                repository, initial=initial
            )
        finally:
            if initial:
                self.state.backfill_in_progress.labels(repository).set(0)
        self.state.last_success.labels(repository).set(success_at)
        LOGGER.info(
            "refreshed %s: %d recent run(s)%s",
            repository,
            len(runs),
            " (initial backfill)" if initial else "",
        )

    def _store_run(self, repository: str, run: dict[str, Any]) -> None:
        needs_jobs = self.database.jobs_need_refresh(repository, run)
        self.database.upsert_run(repository, run)
        if needs_jobs:
            jobs = self.api.list_jobs(repository, int(run["id"]))
            # None (vs. an attempted-but-possibly-empty list) tells
            # upsert_jobs whether the concurrency-group listing was ever
            # queried for this run -- see the "unknown" vs. "none" fallback
            # comment there.
            groups = (
                self.api.list_concurrency_groups(repository, int(run["id"]))
                if run.get("status") in ACTIVE_STATUSES
                else None
            )
            self.database.upsert_jobs(repository, run, jobs, groups)

    def refresh_all(self) -> None:
        for repository in self.config.repositories:
            try:
                self.refresh_repository(repository)
            except Exception:
                self.state.poll_errors.labels(repository, "refresh").inc()
                LOGGER.exception("failed to refresh %s", repository)

    def run_forever(self) -> None:
        while True:
            started = time.monotonic()
            self.refresh_all()
            elapsed = time.monotonic() - started
            time.sleep(max(1, self.config.poll_interval_seconds - elapsed))


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
        registry.register(DatabaseMetrics(database))
        api = GitHubAPI(config, state)
        resources.callback(api.close)
        poller = Poller(config, database, api, state)

        http_server, http_thread = start_http_server(config.port, registry=registry)
        resources.callback(http_server.server_close)
        resources.callback(http_thread.join)
        resources.callback(http_server.shutdown)
        LOGGER.info(
            "serving metrics on :%d for %s",
            config.port,
            ", ".join(config.repositories),
        )
        poller.run_forever()


if __name__ == "__main__":
    main()

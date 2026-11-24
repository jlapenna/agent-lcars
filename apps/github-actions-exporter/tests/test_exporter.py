import importlib.util
import json
import logging
import os
import socket
import sys
import tempfile
import unittest
import urllib.request
from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest.mock import MagicMock, Mock, patch

from prometheus_client import CollectorRegistry, generate_latest

MODULE_PATH = Path(__file__).parents[1] / "exporter.py"
DOCKERFILE_PATH = Path(__file__).parents[1] / "Dockerfile"
SPEC = importlib.util.spec_from_file_location(
    "github_actions_exporter_under_test", MODULE_PATH
)
assert SPEC and SPEC.loader
exporter = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = exporter
SPEC.loader.exec_module(exporter)

SUBSCRIPTION = "projects/agent-lcars/subscriptions/github-actions-exporter"


def workflow_run(**overrides):
    run = {
        "id": 123,
        "name": "validate",
        "path": ".github/workflows/validate.yml",
        "event": "push",
        "status": "completed",
        "conclusion": "success",
        "created_at": "2026-08-05T04:19:23Z",
        "run_started_at": "2026-08-05T04:19:25Z",
        "updated_at": "2026-08-05T04:20:23Z",
        "run_attempt": 1,
        "head_sha": "do-not-export",
        "head_branch": "do-not-export",
    }
    run.update(overrides)
    return run


def workflow_job(**overrides):
    job = {
        "id": 456,
        "run_id": 123,
        "run_attempt": 1,
        "name": "repository validation",
        "workflow_name": "dynamic run name that must not be exported",
        "head_branch": "do-not-export",
        "status": "completed",
        "conclusion": "success",
        "created_at": "2026-08-05T04:19:24Z",
        "started_at": "2026-08-05T04:19:39Z",
        "completed_at": "2026-08-05T04:20:09Z",
        "runner_group_name": "Default",
        "runner_name": "runner-ephemeral-do-not-export",
    }
    job.update(overrides)
    return job


def recent(hours_ago: float) -> str:
    """An ISO timestamp inside the consecutive-failure window."""
    return (datetime.now(UTC) - timedelta(hours=hours_ago)).strftime(
        "%Y-%m-%dT%H:%M:%SZ"
    )


def exported_metric_value(metrics: str, name: str, labels: str = "") -> float:
    """The value of one exported sample, with or without labels.

    `labels` is the rendered label set, e.g. '{repository="jlapenna/homelab"}'.
    Matching the bare name alone would silently pick the wrong series once a
    metric grows a label, so the two forms are distinguished here rather than
    by prefix luck.
    """
    wanted = f"{name}{labels} "
    for line in metrics.splitlines():
        if line.startswith(wanted):
            return float(line.split()[-1])
    raise AssertionError(f"missing metric: {name}{labels}")


class FakeMessage:
    """The parts of a Pub/Sub message the consumer uses."""

    def __init__(self, event, payload=None, *, data=None, delivery_id="delivery-1"):
        self.attributes = {"event": event, "delivery_id": delivery_id}
        self.data = data if data is not None else json.dumps(payload).encode()
        self.acks = 0
        self.nacks = 0

    def ack(self):
        self.acks += 1

    def nack(self):
        self.nacks += 1


def run_message(run, repository="jlapenna/homelab", **kwargs):
    payload = {
        "action": "completed" if run.get("status") == "completed" else "in_progress",
        "workflow_run": run,
        "repository": {"full_name": repository},
    }
    return FakeMessage("workflow_run", payload, **kwargs)


def job_message(job, repository="jlapenna/homelab", **kwargs):
    payload = {
        "action": job.get("status"),
        "workflow_job": job,
        "repository": {"full_name": repository},
    }
    return FakeMessage("workflow_job", payload, **kwargs)


class GitHubActionsExporterTests(unittest.TestCase):
    def store_jobs(self, repository, run, jobs):
        """Store job events belonging to `run`'s attempt."""
        for job in jobs:
            self.database.upsert_job(
                repository,
                dict(job, run_id=run["id"], run_attempt=run.get("run_attempt") or 1),
            )

    def test_image_packages_exporter_readable_by_its_non_root_user(self):
        dockerfile = DOCKERFILE_PATH.read_text()

        self.assertIn("COPY --chmod=0644 exporter.py ./", dockerfile)
        self.assertIn("USER 65534:65534", dockerfile)

    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary_directory.cleanup)
        self.database = exporter.Database(
            str(Path(self.temporary_directory.name) / "actions.db")
        )
        self.addCleanup(self.database.close)

    def metrics(self):
        registry = CollectorRegistry()
        registry.register(exporter.DatabaseMetrics(self.database))
        return generate_latest(registry).decode()

    def test_schema_failure_closes_partially_initialized_database(self):
        connection = MagicMock()
        connection.executescript.side_effect = exporter.sqlite3.OperationalError(
            "invalid schema"
        )

        with (
            patch.object(exporter.sqlite3, "connect", return_value=connection),
            self.assertRaisesRegex(exporter.sqlite3.OperationalError, "invalid schema"),
        ):
            exporter.Database(str(Path(self.temporary_directory.name) / "broken.db"))

        connection.close.assert_called_once_with()

    def test_legacy_database_adds_empty_runner_name(self):
        database_path = Path(self.temporary_directory.name) / "legacy.db"
        connection = exporter.sqlite3.connect(database_path)
        connection.executescript(
            """
            CREATE TABLE jobs (
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
                runs_on TEXT NOT NULL DEFAULT '',
                PRIMARY KEY (repository, id)
            );
            INSERT INTO jobs (
                repository, id, run_id, workflow, name, status, runner_group
            ) VALUES ('jlapenna/agent-lcars', 456, 123, 'ci',
                      'Full verification', 'completed', 'Default');
            """
        )
        connection.close()

        migrated = exporter.Database(str(database_path))
        self.addCleanup(migrated.close)

        row = migrated.rows("SELECT runner_name FROM jobs WHERE id = 456")[0]
        self.assertEqual(row["runner_name"], "")

    def test_runner_name_survives_partial_job_updates_and_restart(self):
        repository = "jlapenna/agent-lcars"
        run = workflow_run(status="in_progress", conclusion=None)
        self.database.upsert_run(repository, run)

        self.store_jobs(
            repository,
            run,
            [workflow_job(status="queued", conclusion=None, runner_name="")],
        )
        self.assertEqual(
            self.database.rows("SELECT runner_name FROM jobs WHERE id = 456")[0][
                "runner_name"
            ],
            "",
        )

        self.store_jobs(
            repository,
            run,
            [
                workflow_job(
                    status="in_progress",
                    conclusion=None,
                    runner_name="runner-homelab-autoscale-lcars-ci-abc123",
                )
            ],
        )
        self.store_jobs(
            repository, run, [workflow_job(status="in_progress", runner_name="  ")]
        )
        self.assertEqual(
            self.database.rows("SELECT runner_name FROM jobs WHERE id = 456")[0][
                "runner_name"
            ],
            "runner-homelab-autoscale-lcars-ci-abc123",
        )
        self.store_jobs(
            repository,
            run,
            [
                workflow_job(
                    status="in_progress",
                    runner_name="runner-homelab-autoscale-lcars-ci-reassigned",
                )
            ],
        )
        completed_run = workflow_run()
        self.database.upsert_run(repository, completed_run)
        self.store_jobs(repository, completed_run, [workflow_job(runner_name=None)])

        database_path = self.database.connection.execute(
            "PRAGMA database_list"
        ).fetchone()["file"]
        self.database.close()
        restarted = exporter.Database(database_path)
        self.addCleanup(restarted.close)
        row = restarted.rows("SELECT runner_name FROM jobs WHERE id = 456")[0]
        self.assertEqual(
            row["runner_name"], "runner-homelab-autoscale-lcars-ci-reassigned"
        )

    def test_completed_run_and_job_emit_aggregated_metrics(self):
        run = workflow_run()
        self.database.upsert_run("jlapenna/homelab", run)
        self.store_jobs("jlapenna/homelab", run, [workflow_job()])

        metrics = self.metrics()

        self.assertIn(
            'github_actions_workflow_runs_total{conclusion="success",event="push",repository="jlapenna/homelab",workflow="validate"} 1.0',
            metrics,
        )
        self.assertIn(
            'github_actions_jobs_total{conclusion="success",execution="unknown",job="repository validation",repository="jlapenna/homelab",runner_group="Default",workflow="validate"} 1.0',
            metrics,
        )
        self.assertIn(
            'github_actions_job_queue_duration_seconds_sum{execution="unknown",job="repository validation",repository="jlapenna/homelab",runner_group="Default",workflow="validate"} 15.0',
            metrics,
        )
        self.assertIn(
            'github_actions_job_duration_seconds_sum{execution="unknown",job="repository validation",repository="jlapenna/homelab",runner_group="Default",workflow="validate"} 30.0',
            metrics,
        )

    def test_full_suite_marker_separates_execution_and_short_circuit(self):
        run = workflow_run(path=".github/workflows/ci.yml")
        self.database.upsert_run("jlapenna/agent-lcars", run)
        self.store_jobs(
            "jlapenna/agent-lcars",
            run,
            [
                workflow_job(
                    id=1,
                    name="E2E",
                    steps=[
                        {
                            "name": "Run console e2e suite [full-suite]",
                            "conclusion": "success",
                        }
                    ],
                ),
                workflow_job(
                    id=2,
                    name="E2E",
                    steps=[
                        {
                            "name": "Run console e2e suite [full-suite]",
                            "conclusion": "skipped",
                        }
                    ],
                ),
            ],
        )

        metrics = self.metrics()

        self.assertIn('execution="full_suite",job="E2E"', metrics)
        self.assertIn('execution="short_circuit",job="E2E"', metrics)
        self.assertNotIn('execution="unknown",job="E2E"', metrics)

    def test_unfinished_marked_job_stays_unknown(self):
        job = workflow_job(
            status="in_progress",
            conclusion=None,
            completed_at=None,
            steps=[
                {
                    "name": "Run console e2e suite [full-suite]",
                    "conclusion": None,
                }
            ],
        )

        self.assertEqual(exporter.job_execution(job), "unknown")

    def test_setup_failure_before_marked_step_is_not_a_short_circuit(self):
        job = workflow_job(
            conclusion="failure",
            steps=[
                {
                    "name": "Run console e2e suite [full-suite]",
                    "conclusion": "skipped",
                }
            ],
        )

        self.assertEqual(exporter.job_execution(job), "unknown")

    def test_negative_upstream_timestamps_are_excluded_from_histograms(self):
        run = workflow_run(
            path=".github/workflows/invalid-timestamps.yml",
            created_at="2026-08-05T04:20:00Z",
            run_started_at="2026-08-05T04:19:00Z",
            updated_at="2026-08-05T04:18:00Z",
        )
        job = workflow_job(
            name="invalid timestamp job",
            created_at="2026-08-05T04:20:00Z",
            started_at="2026-08-05T04:19:00Z",
            completed_at="2026-08-05T04:18:00Z",
        )
        self.database.upsert_run("jlapenna/homelab", run)
        self.store_jobs("jlapenna/homelab", run, [job])

        metrics = self.metrics()

        self.assertIn('workflow="invalid-timestamps"', metrics)
        self.assertNotIn(
            'github_actions_workflow_duration_seconds_count{event="push",repository="jlapenna/homelab",workflow="invalid-timestamps"}',
            metrics,
        )
        self.assertNotIn(
            'github_actions_workflow_queue_duration_seconds_count{event="push",repository="jlapenna/homelab",workflow="invalid-timestamps"}',
            metrics,
        )
        self.assertNotIn(
            'github_actions_job_duration_seconds_count{job="invalid timestamp job"',
            metrics,
        )
        self.assertNotIn(
            'github_actions_job_queue_duration_seconds_count{job="invalid timestamp job"',
            metrics,
        )

    def test_high_cardinality_identifiers_are_not_exported(self):
        run = workflow_run(name="dynamic issue title")
        self.database.upsert_run("jlapenna/homelab", run)
        self.store_jobs("jlapenna/homelab", run, [workflow_job()])

        metrics = self.metrics()

        self.assertNotIn("do-not-export", metrics)
        self.assertNotIn("runner-ephemeral", metrics)
        self.assertNotIn("dynamic issue title", metrics)
        self.assertNotIn("dynamic run name", metrics)
        self.assertNotIn("run_id=", metrics)

    def test_dynamic_job_names_are_capped_per_workflow(self):
        run = workflow_run()
        with patch.object(exporter, "MAX_JOB_LABELS_PER_WORKFLOW", 2):
            self.database.upsert_run("jlapenna/homelab", run)
            self.store_jobs(
                "jlapenna/homelab",
                run,
                [
                    workflow_job(id=1, name="job one"),
                    workflow_job(id=2, name="job two"),
                    workflow_job(id=3, name="job three"),
                ],
            )

        metrics = self.metrics()
        self.assertIn('job="job one"', metrics)
        self.assertIn('job="job two"', metrics)
        self.assertIn('job="__other__"', metrics)
        self.assertNotIn('job="job three"', metrics)

    def test_consecutive_failures_count_back_from_the_latest_decisive_run(self):
        repository = "jlapenna/homelab"
        # success, then two failures: streak 2. A cancelled run and a
        # pull_request failure in between must neither extend nor reset it.
        for run in (
            workflow_run(id=1, conclusion="success", created_at=recent(6)),
            workflow_run(id=2, conclusion="failure", created_at=recent(5)),
            workflow_run(id=3, conclusion="cancelled", created_at=recent(4.5)),
            workflow_run(
                id=4,
                conclusion="failure",
                event="pull_request",
                created_at=recent(4.25),
            ),
            workflow_run(id=5, conclusion="failure", created_at=recent(4)),
            # a different workflow that recovered: failure then success -> 0
            workflow_run(
                id=6,
                name="deploy",
                path=".github/workflows/deploy.yml",
                conclusion="failure",
                created_at=recent(6),
            ),
            workflow_run(
                id=7,
                name="deploy",
                path=".github/workflows/deploy.yml",
                conclusion="success",
                created_at=recent(5),
            ),
        ):
            self.database.upsert_run(repository, run)

        metrics = self.metrics()
        self.assertIn(
            'github_actions_workflow_consecutive_failures{repository="jlapenna/homelab",workflow="validate"} 2.0',
            metrics,
        )
        self.assertIn(
            'github_actions_workflow_consecutive_failures{repository="jlapenna/homelab",workflow="deploy"} 0.0',
            metrics,
        )
        # Both streaks are bounded by a stored success, so they are exact.
        self.assertIn(
            'github_actions_workflow_consecutive_failures_complete{repository="jlapenna/homelab",workflow="validate"} 1.0',
            metrics,
        )
        self.assertIn(
            'github_actions_workflow_consecutive_failures_complete{repository="jlapenna/homelab",workflow="deploy"} 1.0',
            metrics,
        )

    def test_consecutive_failures_ignore_runs_outside_the_window(self):
        # A workflow whose last decisive runs are older than the window has
        # stopped running; it must not report its final streak forever.
        repository = "jlapenna/homelab"
        old = datetime.now(UTC) - timedelta(days=10)
        for i in (1, 2):
            self.database.upsert_run(
                repository,
                workflow_run(
                    id=i,
                    conclusion="failure",
                    created_at=(old + timedelta(hours=i)).strftime(
                        "%Y-%m-%dT%H:%M:%SZ"
                    ),
                ),
            )
        self.assertNotIn(
            "github_actions_workflow_consecutive_failures{", self.metrics()
        )
        # A fresh failure inside the window starts a new streak of one: the
        # stale history does not extend it.
        self.database.upsert_run(
            repository,
            workflow_run(
                id=3,
                conclusion="failure",
                created_at=datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
            ),
        )
        self.assertIn(
            'github_actions_workflow_consecutive_failures{repository="jlapenna/homelab",workflow="validate"} 1.0',
            self.metrics(),
        )

    def test_cached_streak_window_expires_at_scrape_time(self):
        # homelab#2653 review: a cached streak must still age out of the
        # window as the clock moves, with no database change or refresh.
        repository = "jlapenna/homelab"
        start = datetime(2026, 8, 1, tzinfo=UTC)
        for i, (offset, conclusion) in enumerate(
            ((0, "success"), (100, "failure"), (200, "cancelled"), (300, "failure")),
            start=1,
        ):
            self.database.upsert_run(
                repository,
                workflow_run(
                    id=i,
                    conclusion=conclusion,
                    created_at=(start + timedelta(seconds=offset)).strftime(
                        "%Y-%m-%dT%H:%M:%SZ"
                    ),
                ),
            )
        created = start.timestamp()
        window = exporter.CONSECUTIVE_FAILURE_WINDOW_SECONDS
        collector = exporter.DatabaseMetrics(self.database)
        with patch.object(exporter.time, "time", return_value=created + window):
            collector.refresh()
        registry = CollectorRegistry()
        registry.register(collector)
        labels = '{repository="jlapenna/homelab",workflow="validate"}'

        def scrape(elapsed):
            with (
                patch.object(
                    self.database, "rows", side_effect=AssertionError("scrape ran SQL")
                ),
                patch.object(exporter.time, "time", return_value=created + elapsed),
            ):
                return generate_latest(registry).decode()

        # The cutoff is inclusive: the success created exactly a window ago
        # still bounds the streak. The cancelled run between the two failures
        # neither counts nor breaks it, so the streak is 2.
        at_cutoff = scrape(window)
        self.assertIn(
            f"github_actions_workflow_consecutive_failures{labels} 2.0", at_cutoff
        )
        self.assertIn(
            f"github_actions_workflow_consecutive_failures_complete{labels} 1.0",
            at_cutoff,
        )
        success_expired = scrape(window + 50)
        self.assertIn(
            f"github_actions_workflow_consecutive_failures{labels} 2.0", success_expired
        )
        self.assertIn(
            f"github_actions_workflow_consecutive_failures_complete{labels} 0.0",
            success_expired,
        )
        # The older failure has expired too.
        self.assertIn(
            f"github_actions_workflow_consecutive_failures{labels} 1.0",
            scrape(window + 250),
        )
        self.assertNotIn(
            "github_actions_workflow_consecutive_failures{", scrape(window + 350)
        )

    def test_consecutive_failures_without_a_stored_success_are_marked_incomplete(self):
        # A fresh database may hold only the tail of a longer
        # streak. The count is still reported (two observed failures are two
        # failures) but flagged as a lower bound.
        repository = "jlapenna/homelab"
        for run in (
            workflow_run(id=1, conclusion="failure", created_at=recent(2)),
            workflow_run(id=2, conclusion="failure", created_at=recent(1)),
        ):
            self.database.upsert_run(repository, run)

        metrics = self.metrics()
        self.assertIn(
            'github_actions_workflow_consecutive_failures{repository="jlapenna/homelab",workflow="validate"} 2.0',
            metrics,
        )
        self.assertIn(
            'github_actions_workflow_consecutive_failures_complete{repository="jlapenna/homelab",workflow="validate"} 0.0',
            metrics,
        )

    def pull_request_run(self, hours_ago, branch, conclusion="failure", **overrides):
        """A pull_request run whose attempt started `hours_ago` hours ago."""
        started = recent(hours_ago)
        run = workflow_run(
            event="pull_request",
            conclusion=conclusion,
            head_branch=branch,
            created_at=started,
            run_started_at=started,
        )
        run.update(overrides)
        return run

    def test_pull_request_failing_branches_count_pull_requests_not_runs(self):
        # homelab#3509: a required check failed on two pull requests over two
        # hours and no rule saw it, because the streak skips pull_request runs.
        repository = "jlapenna/homelab"
        labels = '{repository="jlapenna/homelab",workflow="validate"}'
        name = "github_actions_workflow_pull_request_failing_branches"
        for run in (
            self.pull_request_run(9, "feature-a", "success", id=1),
            # One pull request failing on every push and rerun is one branch.
            self.pull_request_run(8, "feature-a", id=2),
            self.pull_request_run(7, "feature-a", id=2, run_attempt=2),
            self.pull_request_run(6, "feature-a", id=3),
        ):
            self.database.upsert_run(repository, run)
        self.assertEqual(exported_metric_value(self.metrics(), name, labels), 1.0)

        for run in (
            self.pull_request_run(5, "renovate/all", id=4),
            # Neither a cancelled pull_request run nor a main-line failure
            # adds a branch or resets the count.
            self.pull_request_run(4, "feature-c", "cancelled", id=5),
            workflow_run(
                id=6,
                conclusion="success",
                created_at=recent(3),
                run_started_at=recent(3),
            ),
        ):
            self.database.upsert_run(repository, run)
        metrics = self.metrics()
        self.assertEqual(exported_metric_value(metrics, name, labels), 2.0)
        # Branch names are stored to tell pull requests apart, never exported.
        self.assertNotIn("renovate/all", metrics)
        self.assertNotIn("feature-a", metrics)

        # Any passing pull_request run proves the workflow works again.
        self.database.upsert_run(
            repository, self.pull_request_run(2, "feature-d", "success", id=7)
        )
        self.assertEqual(exported_metric_value(self.metrics(), name, labels), 0.0)

    def test_passing_rerun_of_an_older_pull_request_run_resets_the_count(self):
        # A rerun keeps its run's created_at. Ordering by creation would put
        # the passing rerun behind the newer failure and keep the count at 2.
        repository = "jlapenna/homelab"
        labels = '{repository="jlapenna/homelab",workflow="validate"}'
        name = "github_actions_workflow_pull_request_failing_branches"
        for run in (
            self.pull_request_run(5, "feature-a", id=1),
            self.pull_request_run(4, "feature-b", id=2),
        ):
            self.database.upsert_run(repository, run)
        self.assertEqual(exported_metric_value(self.metrics(), name, labels), 2.0)

        self.database.upsert_run(
            repository,
            self.pull_request_run(
                1,
                "feature-a",
                "success",
                id=1,
                run_attempt=2,
                created_at=recent(5),
            ),
        )
        self.assertEqual(exported_metric_value(self.metrics(), name, labels), 0.0)

    def test_approval_pending_pull_request_runs_are_not_failures(self):
        # action_required on a pull request is a run waiting for a maintainer
        # to approve it. Two of them are not a broken workflow.
        repository = "jlapenna/homelab"
        for i, branch in enumerate(("fork-a", "fork-b"), start=1):
            self.database.upsert_run(
                repository, self.pull_request_run(i, branch, "action_required", id=i)
            )
        self.assertNotIn(
            "github_actions_workflow_pull_request_failing_branches{", self.metrics()
        )

    def test_pull_request_failing_branches_expire_with_the_window(self):
        repository = "jlapenna/homelab"
        old = (datetime.now(UTC) - timedelta(days=10)).strftime("%Y-%m-%dT%H:%M:%SZ")
        for i, branch in enumerate(("feature-a", "feature-b"), start=1):
            self.database.upsert_run(
                repository,
                self.pull_request_run(
                    0, branch, id=i, created_at=old, run_started_at=old
                ),
            )
        self.assertNotIn(
            "github_actions_workflow_pull_request_failing_branches{", self.metrics()
        )

    def test_runs_stored_before_head_branch_existed_add_no_branch(self):
        # An existing deployment's database gains the column on startup. Its
        # stored failures have no branch, so they cannot be told apart and
        # must not combine with a later failure into a false count of two.
        repository = "jlapenna/homelab"
        labels = '{repository="jlapenna/homelab",workflow="validate"}'
        name = "github_actions_workflow_pull_request_failing_branches"
        self.database.upsert_run(repository, self.pull_request_run(3, "", id=1))
        self.database.close()
        path = str(Path(self.temporary_directory.name) / "actions.db")
        connection = exporter.sqlite3.connect(path)
        connection.execute("ALTER TABLE workflow_runs DROP COLUMN head_branch")
        connection.commit()
        connection.close()

        self.database = exporter.Database(path)
        self.addCleanup(self.database.close)
        self.assertEqual(exported_metric_value(self.metrics(), name, labels), 0.0)
        self.database.upsert_run(
            repository, self.pull_request_run(2, "feature-b", id=2)
        )
        self.assertEqual(exported_metric_value(self.metrics(), name, labels), 1.0)

    def test_queued_jobs_carry_the_fleet_label_they_target(self):
        # agent-lcars#1699: the first non-hosted runs-on label is the routing
        # dimension; a GitHub-hosted job exports an empty one.
        repository = "jlapenna/homelab"
        run = workflow_run(status="in_progress", conclusion=None)
        self.database.upsert_run(repository, run)
        self.store_jobs(
            repository,
            run,
            [
                workflow_job(
                    id=1,
                    name="heavy",
                    status="queued",
                    conclusion=None,
                    labels=["self-hosted", "homelab-autoscale-default"],
                ),
                workflow_job(
                    id=2,
                    name="hosted",
                    status="queued",
                    conclusion=None,
                    labels=["ubuntu-latest"],
                ),
            ],
        )
        metrics = self.metrics()
        self.assertIn(
            'github_actions_job_oldest_queued_seconds{job="heavy",repository="jlapenna/homelab",runs_on="homelab-autoscale-default",workflow="validate"}',
            metrics,
        )
        self.assertIn(
            'github_actions_job_oldest_queued_seconds{job="hosted",repository="jlapenna/homelab",runs_on="",workflow="validate"}',
            metrics,
        )
        self.assertEqual(
            exporter.job_runs_on({"labels": ["linux", "x64", "e2e"]}), "e2e"
        )
        self.assertEqual(exporter.job_runs_on({"labels": ["windows-2025"]}), "")
        self.assertEqual(exporter.job_runs_on({}), "")

    def test_rerun_attempt_preserves_the_previous_workflow_outcome(self):
        failed = workflow_run(conclusion="failure", run_attempt=1)
        succeeded = workflow_run(conclusion="success", run_attempt=2)

        self.database.upsert_run("jlapenna/homelab", failed)
        self.database.upsert_run("jlapenna/homelab", succeeded)

        metrics = self.metrics()
        self.assertIn(
            'github_actions_workflow_runs_total{conclusion="failure",event="push",repository="jlapenna/homelab",workflow="validate"} 1.0',
            metrics,
        )
        self.assertIn(
            'github_actions_workflow_runs_total{conclusion="success",event="push",repository="jlapenna/homelab",workflow="validate"} 1.0',
            metrics,
        )

    def test_new_attempt_supersedes_an_unfinished_older_attempt(self):
        older = workflow_run(status="in_progress", conclusion=None, run_attempt=1)
        newer = workflow_run(conclusion="success", run_attempt=2)

        self.database.upsert_run("jlapenna/homelab", older)
        self.database.upsert_run("jlapenna/homelab", newer)

        rows = self.database.rows(
            """
            SELECT run_attempt, status FROM workflow_runs
            WHERE repository = ? AND id = ? ORDER BY run_attempt
            """,
            ("jlapenna/homelab", older["id"]),
        )
        self.assertEqual(
            [(row["run_attempt"], row["status"]) for row in rows],
            [(1, "superseded"), (2, "completed")],
        )
        self.assertNotIn("github_actions_workflow_runs_current{", self.metrics())

    def test_late_older_attempt_cannot_become_active_again(self):
        older = workflow_run(status="queued", conclusion=None, run_attempt=1)
        newer = workflow_run(conclusion="success", run_attempt=2)

        self.database.upsert_run("jlapenna/homelab", newer)
        self.database.upsert_run("jlapenna/homelab", older)

        rows = self.database.rows(
            "SELECT run_attempt, status FROM workflow_runs ORDER BY run_attempt"
        )
        self.assertEqual(
            [(row["run_attempt"], row["status"]) for row in rows],
            [(1, "superseded"), (2, "completed")],
        )
        self.assertNotIn("github_actions_workflow_runs_current{", self.metrics())

    def test_active_job_exports_current_and_oldest_queue_gauges(self):
        run = workflow_run(
            status="in_progress", conclusion=None, updated_at="2026-08-05T04:19:30Z"
        )
        job = workflow_job(
            status="queued", conclusion=None, started_at=None, completed_at=None
        )
        self.database.upsert_run("jlapenna/homelab", run)
        self.store_jobs("jlapenna/homelab", run, [job])

        metrics = self.metrics()

        self.assertIn(
            'github_actions_workflow_runs_current{repository="jlapenna/homelab",status="in_progress",workflow="validate"} 1.0',
            metrics,
        )
        self.assertIn(
            'github_actions_jobs_current{job="repository validation",repository="jlapenna/homelab",runner_group="Default",runs_on="",status="queued",workflow="validate"} 1.0',
            metrics,
        )
        self.assertIn("github_actions_job_oldest_queued_seconds", metrics)

    def test_scrape_renders_the_last_refresh_without_querying_history(self):
        # homelab#2653: whole-history SQL on every scrape outgrew the 10s
        # scrape timeout. A scrape must only render what refresh() stored.
        run = workflow_run(
            status="in_progress", conclusion=None, updated_at="2026-08-05T04:19:30Z"
        )
        job = workflow_job(
            status="queued", conclusion=None, started_at=None, completed_at=None
        )
        self.database.upsert_run("jlapenna/homelab", run)
        self.store_jobs("jlapenna/homelab", run, [job])
        collector = exporter.DatabaseMetrics(self.database)
        collector.refresh()
        registry = CollectorRegistry()
        registry.register(collector)
        created_at = exporter.parse_timestamp(job["created_at"])
        oldest = 'github_actions_job_oldest_queued_seconds{job="repository validation",repository="jlapenna/homelab",runs_on="",workflow="validate"}'

        with (
            patch.object(
                self.database, "rows", side_effect=AssertionError("scrape ran SQL")
            ),
            patch.object(
                self.database,
                "histogram_rows",
                side_effect=AssertionError("scrape ran SQL"),
            ),
            patch.object(exporter.time, "time", return_value=created_at + 100),
        ):
            first = generate_latest(registry).decode()
        with (
            patch.object(
                self.database, "rows", side_effect=AssertionError("scrape ran SQL")
            ),
            patch.object(
                self.database,
                "histogram_rows",
                side_effect=AssertionError("scrape ran SQL"),
            ),
            patch.object(exporter.time, "time", return_value=created_at + 160),
        ):
            later = generate_latest(registry).decode()

        self.assertIn(
            'github_actions_workflow_runs_current{repository="jlapenna/homelab",status="in_progress",workflow="validate"} 1.0',
            first,
        )
        # Queue age keeps advancing between refreshes.
        self.assertIn(f"{oldest} 100.0", first)
        self.assertIn(f"{oldest} 160.0", later)

        completed = workflow_run(updated_at="2026-08-05T04:25:00Z")
        self.database.upsert_run("jlapenna/homelab", completed)
        self.store_jobs("jlapenna/homelab", completed, [workflow_job()])
        self.assertIn(
            "github_actions_workflow_runs_current{", generate_latest(registry).decode()
        )
        collector.refresh()
        refreshed = generate_latest(registry).decode()
        self.assertNotIn("github_actions_workflow_runs_current{", refreshed)
        self.assertNotIn("github_actions_job_oldest_queued_seconds{", refreshed)

    def test_startup_does_not_hide_jobs_from_a_newer_active_attempt(self):
        repository = "jlapenna/homelab"
        completed = workflow_run(run_attempt=1)
        active = workflow_run(
            run_attempt=2,
            status="in_progress",
            conclusion=None,
            updated_at="2026-08-05T04:21:23Z",
        )
        active_job = workflow_job(
            id=789,
            status="queued",
            conclusion=None,
            started_at=None,
            completed_at=None,
        )
        self.database.upsert_run(repository, completed)
        self.store_jobs(repository, completed, [workflow_job()])
        self.database.upsert_run(repository, active)
        self.store_jobs(repository, active, [active_job])
        database_path = str(Path(self.temporary_directory.name) / "actions.db")
        self.database.close()
        self.database = exporter.Database(database_path)
        self.addCleanup(self.database.close)

        rows = self.database.rows(
            "SELECT status FROM jobs WHERE repository = ? AND id = ?",
            (repository, active_job["id"]),
        )
        self.assertEqual([row["status"] for row in rows], ["queued"])
        self.assertIn(
            'github_actions_jobs_current{job="repository validation",repository="jlapenna/homelab",runner_group="Default",runs_on="",status="queued",workflow="validate"} 1.0',
            self.metrics(),
        )

    def test_polling_era_database_migrates_without_losing_history(self):
        database_path = Path(self.temporary_directory.name) / "polling.db"
        connection = exporter.sqlite3.connect(database_path)
        connection.executescript(
            """
            CREATE TABLE workflow_runs (
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
                head_branch TEXT NOT NULL DEFAULT '',
                PRIMARY KEY (repository, id, run_attempt)
            );
            CREATE TABLE jobs (
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
                runner_name TEXT NOT NULL DEFAULT '',
                runs_on TEXT NOT NULL DEFAULT '',
                PRIMARY KEY (repository, id)
            );
            CREATE TABLE repository_state (
                repository TEXT PRIMARY KEY,
                initial_backfill_complete INTEGER NOT NULL DEFAULT 0,
                last_success_at REAL
            );
            CREATE INDEX workflow_runs_status_idx ON workflow_runs (repository, status);
            CREATE INDEX jobs_status_idx ON jobs (repository, status);
            CREATE INDEX jobs_run_idx ON jobs (repository, run_id);
            INSERT INTO workflow_runs VALUES
                ('jlapenna/homelab', 1, 1, 'validate', 'push', 'completed',
                 'success', 100, 110, 200, 200, NULL, 'main'),
                ('jlapenna/homelab', 2, 1, 'validate', 'push', 'in_progress',
                 NULL, 300, 310, NULL, 310, NULL, 'main');
            INSERT INTO jobs VALUES
                ('jlapenna/homelab', 10, 1, 'validate', 'build', 'completed',
                 'success', 100, 120, 180, 'Default', 'unknown', 'ci-main',
                 'runner-a', 'default'),
                ('jlapenna/homelab', 11, 1, 'validate', 'lint', 'refresh_pending',
                 NULL, 100, NULL, NULL, 'Default', 'unknown', 'none', '', ''),
                ('jlapenna/homelab', 20, 2, 'validate', 'build', 'queued',
                 NULL, 300, NULL, NULL, 'Default', 'unknown', 'unknown', '', '');
            INSERT INTO repository_state VALUES ('jlapenna/homelab', 1, 400);
            """
        )
        connection.commit()
        connection.close()

        migrated = exporter.Database(str(database_path))
        self.addCleanup(migrated.close)

        self.assertNotIn("concurrency_group", migrated._columns("jobs"))
        self.assertNotIn("jobs_updated_at", migrated._columns("workflow_runs"))
        self.assertEqual(
            migrated._columns("repository_state"), {"repository", "last_event_at"}
        )
        # The old poll timestamp does not claim an event was ever received.
        self.assertIsNone(migrated.last_event_at("jlapenna/homelab"))
        statuses = {
            row["id"]: row["status"]
            for row in migrated.rows("SELECT id, status FROM jobs")
        }
        self.assertEqual(statuses, {10: "completed", 11: "orphaned", 20: "queued"})

        # A legacy job (no stored attempt) still completes from its event.
        migrated.upsert_job(
            "jlapenna/homelab", workflow_job(id=20, run_id=2, name="build")
        )
        self.assertEqual(
            migrated.rows("SELECT status, run_attempt FROM jobs WHERE id = 20")[0][
                "status"
            ],
            "completed",
        )
        # Reopening an already-migrated database is a no-op.
        migrated.close()
        reopened = exporter.Database(str(database_path))
        self.addCleanup(reopened.close)
        self.assertEqual(len(reopened.rows("SELECT * FROM jobs")), 3)

    def test_completed_run_does_not_export_an_active_job(self):
        # The run's completion event can arrive before the job's own, or the
        # job's can be lost. A finished run has no queued or running jobs.
        run = workflow_run()
        job = workflow_job(
            status="queued", conclusion=None, started_at=None, completed_at=None
        )
        self.database.upsert_run("jlapenna/homelab", run)
        self.store_jobs("jlapenna/homelab", run, [job])

        rows = self.database.rows("SELECT status FROM jobs WHERE id = ?", (job["id"],))
        self.assertEqual([row["status"] for row in rows], ["orphaned"])
        self.assertNotIn("github_actions_jobs_current{", self.metrics())
        self.assertNotIn("github_actions_job_oldest_queued_seconds{", self.metrics())

        self.store_jobs("jlapenna/homelab", run, [workflow_job()])

        self.assertIn(
            'github_actions_jobs_total{conclusion="success",execution="unknown",job="repository validation",repository="jlapenna/homelab",runner_group="Default",workflow="validate"} 1.0',
            self.metrics(),
        )

    def test_run_completion_retires_jobs_it_finished_without(self):
        run = workflow_run(status="in_progress", conclusion=None)
        job = workflow_job(
            status="in_progress", conclusion=None, completed_at=None, runner_name=""
        )
        self.database.upsert_run("jlapenna/homelab", run)
        self.store_jobs("jlapenna/homelab", run, [job])
        self.assertIn("github_actions_jobs_current{", self.metrics())

        self.database.upsert_run("jlapenna/homelab", workflow_run())

        self.assertNotIn("github_actions_jobs_current{", self.metrics())

    def test_startup_repairs_legacy_completed_run_with_active_job(self):
        run = workflow_run()
        job = workflow_job()
        self.database.upsert_run("jlapenna/homelab", run)
        self.store_jobs("jlapenna/homelab", run, [job])
        with self.database.lock, self.database.connection:
            self.database.connection.execute(
                "UPDATE jobs SET status = 'queued', run_attempt = NULL WHERE id = ?",
                (job["id"],),
            )
        database_path = str(Path(self.temporary_directory.name) / "actions.db")
        self.database.close()
        self.database = exporter.Database(database_path)
        self.addCleanup(self.database.close)

        rows = self.database.rows("SELECT status FROM jobs WHERE id = ?", (job["id"],))
        self.assertEqual([row["status"] for row in rows], ["orphaned"])
        self.assertNotIn("github_actions_jobs_current{", self.metrics())


class EventConsumerTests(unittest.TestCase):
    """Webhook bodies fed through the Pub/Sub message handler."""

    NOW = 1_800_000_000.0

    def setUp(self):
        # Failures below are logged on purpose; keep the test output readable.
        logging.disable(logging.CRITICAL)
        self.addCleanup(logging.disable, logging.NOTSET)
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary_directory.cleanup)
        self.database = exporter.Database(
            str(Path(self.temporary_directory.name) / "actions.db")
        )
        self.addCleanup(self.database.close)
        self.registry = CollectorRegistry()
        self.state = exporter.ExporterState(self.registry)
        self.collector = exporter.DatabaseMetrics(self.database)
        self.registry.register(self.collector)
        self.consumer = exporter.EventConsumer(
            exporter.Config(
                repositories=("jlapenna/homelab",), subscription=SUBSCRIPTION
            ),
            self.database,
            self.state,
            self.collector,
            clock=lambda: self.NOW,
        )

    def deliver(self, *messages):
        for message in messages:
            self.consumer.handle_message(message)
            self.assertEqual(
                (message.acks, message.nacks), (1, 0), "message was not acknowledged"
            )

    def scrape(self):
        self.consumer.refresh_snapshot_if_changed()
        return generate_latest(self.registry).decode()

    def messages_total(self, event, outcome):
        return self.registry.get_sample_value(
            "github_actions_exporter_messages_total",
            {"event": event, "outcome": outcome},
        )

    def test_run_and_job_events_export_what_stored_snapshots_did(self):
        in_progress = workflow_run(
            status="in_progress", conclusion=None, updated_at="2026-08-05T04:19:25Z"
        )
        queued = workflow_job(
            status="queued",
            conclusion=None,
            started_at=None,
            completed_at=None,
            runner_group_name=None,
            runner_name=None,
        )
        running = workflow_job(status="in_progress", conclusion=None, completed_at=None)
        self.deliver(
            run_message(in_progress),
            job_message(queued),
            job_message(running),
        )
        metrics = self.scrape()
        self.assertIn(
            'github_actions_jobs_current{job="repository validation",repository="jlapenna/homelab",runner_group="Default",runs_on="",status="in_progress",workflow="validate"} 1.0',
            metrics,
        )
        self.deliver(job_message(workflow_job()), run_message(workflow_run()))

        # The same run and job stored directly in another database.
        reference = exporter.Database(
            str(Path(self.temporary_directory.name) / "reference.db")
        )
        self.addCleanup(reference.close)
        reference.upsert_run("jlapenna/homelab", workflow_run())
        reference.upsert_job("jlapenna/homelab", workflow_job())
        reference_registry = CollectorRegistry()
        reference_registry.register(exporter.DatabaseMetrics(reference))
        expected = generate_latest(reference_registry).decode()

        metrics = self.scrape()
        for line in expected.splitlines():
            if line.startswith("github_actions_"):
                self.assertIn(line, metrics)
        self.assertIn(
            'github_actions_workflow_runs_total{conclusion="success",event="push",repository="jlapenna/homelab",workflow="validate"} 1.0',
            metrics,
        )
        self.assertIn(
            'github_actions_job_queue_duration_seconds_sum{execution="unknown",job="repository validation",repository="jlapenna/homelab",runner_group="Default",workflow="validate"} 15.0',
            metrics,
        )
        self.assertNotIn("github_actions_jobs_current{", metrics)
        self.assertEqual(self.messages_total("workflow_run", "stored"), 2.0)
        self.assertEqual(self.messages_total("workflow_job", "stored"), 3.0)
        self.assertEqual(
            self.registry.get_sample_value(
                "github_actions_exporter_last_event_timestamp_seconds",
                {"repository": "jlapenna/homelab"},
            ),
            self.NOW,
        )
        self.assertNotIn("runner-ephemeral", metrics)
        self.assertNotIn("dynamic run name", metrics)

    def test_job_before_its_run_is_labelled_once_the_run_arrives(self):
        # A workflow_job payload names no workflow file, so the job waits for
        # its run instead of being exported under a guessed label.
        self.deliver(job_message(workflow_job()))
        metrics = self.scrape()
        self.assertNotIn("github_actions_jobs_total{", metrics)
        self.assertEqual(len(self.database.rows("SELECT * FROM pending_jobs")), 1)

        # An older duplicate of the pending job does not replace it.
        self.deliver(
            job_message(workflow_job(status="queued", conclusion=None)),
            run_message(workflow_run()),
        )

        self.assertIn(
            'github_actions_jobs_total{conclusion="success",execution="unknown",job="repository validation",repository="jlapenna/homelab",runner_group="Default",workflow="validate"} 1.0',
            self.scrape(),
        )
        self.assertEqual(self.database.rows("SELECT * FROM pending_jobs"), [])

    def test_job_of_a_new_attempt_uses_the_known_workflow(self):
        self.deliver(run_message(workflow_run(conclusion="failure")))
        self.deliver(
            job_message(
                workflow_job(id=789, run_attempt=2, status="queued", conclusion=None)
            )
        )
        metrics = self.scrape()
        self.assertIn(
            'github_actions_jobs_current{job="repository validation",repository="jlapenna/homelab",runner_group="Default",runs_on="",status="queued",workflow="validate"} 1.0',
            metrics,
        )

    def test_duplicate_deliveries_count_once(self):
        for _ in range(3):
            self.deliver(run_message(workflow_run()), job_message(workflow_job()))

        metrics = self.scrape()
        self.assertIn(
            'github_actions_workflow_runs_total{conclusion="success",event="push",repository="jlapenna/homelab",workflow="validate"} 1.0',
            metrics,
        )
        self.assertIn(
            'github_actions_jobs_total{conclusion="success",execution="unknown",job="repository validation",repository="jlapenna/homelab",runner_group="Default",workflow="validate"} 1.0',
            metrics,
        )

    def test_late_events_cannot_regress_stored_state(self):
        self.deliver(run_message(workflow_run()), job_message(workflow_job()))
        self.deliver(
            run_message(
                workflow_run(
                    status="in_progress",
                    conclusion=None,
                    updated_at="2026-08-05T04:19:30Z",
                )
            ),
            job_message(
                workflow_job(status="in_progress", conclusion=None, completed_at=None)
            ),
            job_message(
                workflow_job(
                    status="queued", conclusion=None, started_at=None, completed_at=None
                )
            ),
        )

        rows = self.database.rows("SELECT status, conclusion FROM workflow_runs")
        self.assertEqual([tuple(row) for row in rows], [("completed", "success")])
        rows = self.database.rows("SELECT status, conclusion FROM jobs")
        self.assertEqual([tuple(row) for row in rows], [("completed", "success")])
        metrics = self.scrape()
        self.assertNotIn("github_actions_workflow_runs_current{", metrics)
        self.assertNotIn("github_actions_jobs_current{", metrics)

        # At the same status, an older event does not replace a newer one.
        self.deliver(
            run_message(
                workflow_run(
                    id=200,
                    status="in_progress",
                    conclusion=None,
                    updated_at="2026-08-05T05:00:00Z",
                    run_started_at="2026-08-05T04:59:00Z",
                )
            ),
            run_message(
                workflow_run(
                    id=200,
                    status="in_progress",
                    conclusion=None,
                    updated_at="2026-08-05T04:50:00Z",
                    run_started_at="2026-08-05T04:49:00Z",
                )
            ),
        )
        started = self.database.rows(
            "SELECT started_at FROM workflow_runs WHERE id = 200"
        )[0]["started_at"]
        self.assertEqual(started, exporter.parse_timestamp("2026-08-05T04:59:00Z"))

    def test_job_running_after_its_run_completed_waits_for_its_own_completion(self):
        self.deliver(
            run_message(workflow_run()),
            job_message(
                workflow_job(status="in_progress", conclusion=None, completed_at=None)
            ),
        )
        self.assertNotIn("github_actions_jobs_current{", self.scrape())

        self.deliver(job_message(workflow_job()))
        self.assertIn(
            'github_actions_jobs_total{conclusion="success",execution="unknown",job="repository validation",repository="jlapenna/homelab",runner_group="Default",workflow="validate"} 1.0',
            self.scrape(),
        )

    def test_rerun_arrives_as_a_new_attempt(self):
        labels = '{repository="jlapenna/homelab",workflow="validate"}'
        name = "github_actions_workflow_pull_request_failing_branches"
        for run_id, branch in ((1, "feature-a"), (2, "feature-b")):
            started = recent(5 - run_id)
            self.deliver(
                run_message(
                    workflow_run(
                        id=run_id,
                        event="pull_request",
                        conclusion="failure",
                        head_branch=branch,
                        created_at=started,
                        run_started_at=started,
                        updated_at=started,
                    )
                ),
                job_message(
                    workflow_job(id=run_id * 10, run_id=run_id, conclusion="failure")
                ),
            )
        self.assertEqual(exported_metric_value(self.scrape(), name, labels), 2.0)

        # The rerun keeps its run's created_at but starts now.
        rerun = workflow_run(
            id=1,
            run_attempt=2,
            event="pull_request",
            head_branch="feature-a",
            created_at=recent(4),
            run_started_at=recent(0.5),
            updated_at=recent(0.5),
        )
        self.deliver(
            run_message(dict(rerun, status="in_progress", conclusion=None)),
            job_message(workflow_job(id=11, run_id=1, run_attempt=2)),
            run_message(rerun),
        )

        metrics = self.scrape()
        self.assertEqual(exported_metric_value(metrics, name, labels), 0.0)
        # Both attempts' outcomes are kept.
        self.assertIn(
            'github_actions_workflow_runs_total{conclusion="failure",event="pull_request",repository="jlapenna/homelab",workflow="validate"} 2.0',
            metrics,
        )
        self.assertIn(
            'github_actions_workflow_runs_total{conclusion="success",event="pull_request",repository="jlapenna/homelab",workflow="validate"} 1.0',
            metrics,
        )
        self.assertIn(
            'github_actions_jobs_total{conclusion="failure",execution="unknown",job="repository validation",repository="jlapenna/homelab",runner_group="Default",workflow="validate"} 2.0',
            metrics,
        )

    def test_main_line_failures_are_counted_from_events(self):
        for run_id, (hours_ago, conclusion) in enumerate(
            ((3, "success"), (2, "failure"), (1, "failure")), start=1
        ):
            self.deliver(
                run_message(
                    workflow_run(
                        id=run_id,
                        conclusion=conclusion,
                        created_at=recent(hours_ago),
                        updated_at=recent(hours_ago),
                    )
                )
            )

        metrics = self.scrape()
        self.assertEqual(
            exported_metric_value(
                metrics,
                "github_actions_workflow_consecutive_failures",
                '{repository="jlapenna/homelab",workflow="validate"}',
            ),
            2.0,
        )

    def test_full_suite_step_is_read_from_the_job_event(self):
        self.deliver(run_message(workflow_run(path=".github/workflows/ci.yml")))
        self.deliver(
            job_message(
                workflow_job(
                    name="E2E",
                    steps=[
                        {"name": "Set up job", "conclusion": "success"},
                        {
                            "name": "Run console e2e suite [full-suite]",
                            "conclusion": "success",
                        },
                    ],
                )
            )
        )

        self.assertIn(
            'github_actions_job_duration_seconds_count{execution="full_suite",job="E2E",repository="jlapenna/homelab",runner_group="Default",workflow="ci"} 1.0',
            self.scrape(),
        )

    def test_unconfigured_repository_is_acknowledged_and_ignored(self):
        self.deliver(
            run_message(workflow_run(), repository="someone/else"),
            job_message(workflow_job(), repository="someone/else"),
        )

        self.assertEqual(self.database.rows("SELECT * FROM workflow_runs"), [])
        self.assertEqual(self.database.rows("SELECT * FROM pending_jobs"), [])
        self.assertEqual(self.messages_total("workflow_run", "ignored_repository"), 1.0)
        self.assertEqual(self.messages_total("workflow_job", "ignored_repository"), 1.0)
        self.assertIsNone(
            self.registry.get_sample_value(
                "github_actions_exporter_last_event_timestamp_seconds",
                {"repository": "someone/else"},
            )
        )

    def test_repository_names_match_case_insensitively(self):
        self.deliver(run_message(workflow_run(), repository="JLaPenna/Homelab"))

        self.assertEqual(
            [
                row["repository"]
                for row in self.database.rows("SELECT * FROM workflow_runs")
            ],
            ["jlapenna/homelab"],
        )

    def test_malformed_messages_are_acknowledged_and_counted(self):
        repository = {"full_name": "jlapenna/homelab"}
        cases = {
            "not json": FakeMessage("workflow_run", data=b"{not json"),
            "not utf-8": FakeMessage("workflow_run", data=b"\xff\xfe"),
            "not an object": FakeMessage("workflow_run", []),
            "no repository": FakeMessage(
                "workflow_run", {"workflow_run": workflow_run()}
            ),
            "no run": FakeMessage("workflow_run", {"repository": repository}),
            "string id": FakeMessage(
                "workflow_run",
                {"repository": repository, "workflow_run": workflow_run(id="123")},
            ),
            "bad timestamp": FakeMessage(
                "workflow_run",
                {
                    "repository": repository,
                    "workflow_run": workflow_run(updated_at="yesterday"),
                },
            ),
            "bad attempt": FakeMessage(
                "workflow_run",
                {"repository": repository, "workflow_run": workflow_run(run_attempt=0)},
            ),
            "job without run": FakeMessage(
                "workflow_job",
                {"repository": repository, "workflow_job": workflow_job(run_id=None)},
            ),
        }
        for case, message in cases.items():
            with self.subTest(case=case):
                self.deliver(message)
        unknown = FakeMessage("push", {"repository": repository})
        self.deliver(unknown)

        self.assertEqual(self.messages_total("workflow_run", "malformed"), 8.0)
        self.assertEqual(self.messages_total("workflow_job", "malformed"), 1.0)
        self.assertEqual(self.messages_total("unknown", "malformed"), 1.0)
        self.assertEqual(self.database.rows("SELECT * FROM workflow_runs"), [])
        self.assertEqual(
            self.registry.get_sample_value(
                "github_actions_exporter_last_event_timestamp_seconds",
                {"repository": "jlapenna/homelab"},
            ),
            0.0,
        )

    def test_storage_failure_is_negatively_acknowledged_for_redelivery(self):
        message = run_message(workflow_run())
        with patch.object(
            self.database,
            "upsert_run",
            side_effect=exporter.sqlite3.OperationalError("database is locked"),
        ):
            self.consumer.handle_message(message)

        self.assertEqual((message.acks, message.nacks), (0, 1))
        self.assertEqual(self.messages_total("workflow_run", "error"), 1.0)
        self.assertEqual(
            self.registry.get_sample_value(
                "github_actions_exporter_last_event_timestamp_seconds",
                {"repository": "jlapenna/homelab"},
            ),
            0.0,
        )

        # The redelivery succeeds.
        self.deliver(run_message(workflow_run()))
        self.assertEqual(self.messages_total("workflow_run", "stored"), 1.0)

    def test_last_event_time_survives_a_restart(self):
        self.deliver(run_message(workflow_run()))
        registry = CollectorRegistry()
        state = exporter.ExporterState(registry)

        exporter.EventConsumer(
            exporter.Config(
                repositories=("jlapenna/homelab", "jlapenna/idle"),
                subscription=SUBSCRIPTION,
            ),
            self.database,
            state,
            self.collector,
        )

        self.assertEqual(
            registry.get_sample_value(
                "github_actions_exporter_last_event_timestamp_seconds",
                {"repository": "jlapenna/homelab"},
            ),
            self.NOW,
        )
        self.assertEqual(
            registry.get_sample_value(
                "github_actions_exporter_last_event_timestamp_seconds",
                {"repository": "jlapenna/idle"},
            ),
            0.0,
        )

    def test_snapshot_is_rebuilt_only_after_a_change(self):
        with patch.object(self.collector, "refresh") as refresh:
            self.consumer.refresh_snapshot_if_changed()
            refresh.assert_not_called()
            self.deliver(run_message(workflow_run()))
            self.consumer.refresh_snapshot_if_changed()
            self.consumer.refresh_snapshot_if_changed()
        refresh.assert_called_once_with()


class FakeFuture:
    """A streaming-pull future that plays back scripted result() outcomes."""

    def __init__(self, *outcomes):
        self.outcomes = list(outcomes)
        self.cancelled = False

    def result(self, timeout=None):
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, BaseException):
            raise outcome
        return outcome

    def done(self):
        return not self.outcomes

    def cancel(self):
        self.cancelled = True


class StopConsumer(Exception):
    pass


class StreamingPullTests(unittest.TestCase):
    def setUp(self):
        # Failures below are logged on purpose; keep the test output readable.
        logging.disable(logging.CRITICAL)
        self.addCleanup(logging.disable, logging.NOTSET)
        self.registry = CollectorRegistry()
        self.state = exporter.ExporterState(self.registry)
        self.database = Mock()
        self.database.last_event_at.return_value = None
        self.metrics = Mock()
        self.delays = []
        self.clock = [0.0]

    def consumer(self, sleeps_before_stop):
        def sleep(delay):
            self.delays.append(delay)
            if len(self.delays) >= sleeps_before_stop:
                raise StopConsumer

        return exporter.EventConsumer(
            exporter.Config(
                repositories=("jlapenna/homelab",), subscription=SUBSCRIPTION
            ),
            self.database,
            self.state,
            self.metrics,
            monotonic=lambda: self.clock[0],
            sleep=sleep,
        )

    def running(self):
        return self.registry.get_sample_value(
            "github_actions_exporter_subscription_running"
        )

    def test_a_failed_stream_is_reopened_with_a_growing_bounded_delay(self):
        seen_running = []
        futures = [
            FakeFuture(RuntimeError("403 permission denied")),
            FakeFuture(TimeoutError(), TimeoutError(), RuntimeError("503")),
            FakeFuture(RuntimeError("503")),
        ]
        subscriber = Mock()

        def subscribe(subscription, callback, flow_control):
            self.assertEqual(subscription, SUBSCRIPTION)
            self.assertEqual(callback, consumer.handle_message)
            self.assertEqual(
                flow_control.max_messages, exporter.MAX_OUTSTANDING_MESSAGES
            )
            seen_running.append(self.running())
            return futures.pop(0)

        subscriber.subscribe.side_effect = subscribe
        consumer = self.consumer(sleeps_before_stop=3)
        consumer._changed.set()

        with (
            patch.object(exporter, "SNAPSHOT_REFRESH_SECONDS", 0),
            self.assertRaises(StopConsumer),
        ):
            consumer.run_forever(subscriber)

        self.assertEqual(self.delays, [1.0, 2.0, 4.0])
        self.assertEqual(self.running(), 0.0)
        self.assertEqual(
            self.registry.get_sample_value(
                "github_actions_exporter_subscription_failures_total"
            ),
            3.0,
        )
        # While a stream was open the snapshot kept refreshing.
        self.metrics.refresh.assert_called_once_with()

    def test_stream_runs_while_open_and_is_cancelled_when_it_stops(self):
        future = FakeFuture(TimeoutError(), RuntimeError("stream failed"))
        observed = []
        original = future.result

        def result(timeout=None):
            observed.append(self.running())
            return original(timeout)

        future.result = result
        subscriber = Mock()
        subscriber.subscribe.return_value = future
        consumer = self.consumer(sleeps_before_stop=1)

        with self.assertRaises(StopConsumer):
            consumer.run_forever(subscriber)

        self.assertEqual(observed, [1.0, 1.0])
        self.assertTrue(future.cancelled)
        self.assertEqual(self.running(), 0.0)

    def test_subscribe_errors_are_retried_and_long_streams_reset_the_delay(self):
        subscriber = Mock()
        long_lived = FakeFuture(RuntimeError("stream reset"))

        def advance(timeout=None):
            self.clock[0] += exporter.RECONNECT_RESET_SECONDS
            raise RuntimeError("stream reset")

        long_lived.result = advance
        subscriber.subscribe.side_effect = [
            RuntimeError("could not open"),
            RuntimeError("could not open"),
            long_lived,
        ]
        consumer = self.consumer(sleeps_before_stop=3)

        with self.assertRaises(StopConsumer):
            consumer.run_forever(subscriber)

        self.assertEqual(self.delays, [1.0, 2.0, 1.0])

    def test_snapshot_failure_is_not_mistaken_for_a_stream_failure(self):
        subscriber = Mock()
        subscriber.subscribe.return_value = FakeFuture(
            TimeoutError(), RuntimeError("unreached")
        )
        self.metrics.refresh.side_effect = exporter.sqlite3.OperationalError("disk")
        consumer = self.consumer(sleeps_before_stop=1)
        consumer._changed.set()

        with self.assertRaisesRegex(exporter.sqlite3.OperationalError, "disk"):
            consumer.run_forever(subscriber)
        self.assertEqual(self.running(), 0.0)


class ConfigTests(unittest.TestCase):
    def config(self, **environment):
        values = {
            "GITHUB_REPOSITORIES": "jlapenna/homelab",
            "GITHUB_ACTIONS_EVENTS_SUBSCRIPTION": SUBSCRIPTION,
        }
        values.update(environment)
        with patch.dict(os.environ, values, clear=True):
            return exporter.Config.from_environment()

    def test_defaults(self):
        config = self.config()

        self.assertEqual(config.subscription, SUBSCRIPTION)
        self.assertEqual(config.port, 9102)
        self.assertEqual(
            config.database_path, "/var/lib/github-actions-exporter/actions.db"
        )

    def test_duplicate_repositories_are_stored_once(self):
        config = self.config(
            GITHUB_REPOSITORIES=(
                "JLaPenna/Homelab, supersprinklesracing/sprinkles,jlapenna/homelab"
            )
        )

        self.assertEqual(
            config.repositories,
            ("JLaPenna/Homelab", "supersprinklesracing/sprinkles"),
        )

    def test_repository_owner_and_name_must_both_be_present(self):
        for repository in ("/homelab", "jlapenna/"):
            with (
                self.subTest(repository=repository),
                self.assertRaisesRegex(ValueError, "owner/repository"),
            ):
                self.config(GITHUB_REPOSITORIES=repository)

    def test_subscription_is_a_full_resource_path(self):
        for subscription in (
            "github-actions-exporter",
            "projects/agent-lcars/topics/github-actions-events",
            "projects/agent-lcars/subscriptions/",
        ):
            with (
                self.subTest(subscription=subscription),
                self.assertRaisesRegex(ValueError, "projects/<project>"),
            ):
                self.config(GITHUB_ACTIONS_EVENTS_SUBSCRIPTION=subscription)

    def test_subscription_is_required(self):
        with self.assertRaisesRegex(
            ValueError, "GITHUB_ACTIONS_EVENTS_SUBSCRIPTION cannot be empty"
        ):
            self.config(GITHUB_ACTIONS_EVENTS_SUBSCRIPTION="")

    def test_port_must_be_in_the_tcp_port_range(self):
        for port in ("0", "65536"):
            with (
                self.subTest(port=port),
                self.assertRaisesRegex(ValueError, "between 1 and 65535"),
            ):
                self.config(PORT=port)

    def test_database_path_cannot_be_blank(self):
        with self.assertRaisesRegex(ValueError, "DATABASE_PATH cannot be empty"):
            self.config(DATABASE_PATH="  ")


def main_config(**overrides):
    return exporter.Config(
        repositories=("jlapenna/homelab",), subscription=SUBSCRIPTION, **overrides
    )


class MainTests(unittest.TestCase):
    def test_startup_failure_closes_database_and_subscriber(self):
        database = Mock()
        database.last_event_at.return_value = None
        database.rows.return_value = []
        database.histogram_rows.return_value = []
        subscriber = Mock()

        with (
            patch.object(
                exporter.Config, "from_environment", return_value=main_config()
            ),
            patch.object(exporter, "Database", return_value=database),
            patch.object(exporter, "SubscriberClient", return_value=subscriber),
            patch.object(exporter, "start_http_server", side_effect=OSError("in use")),
            self.assertRaisesRegex(OSError, "in use"),
        ):
            exporter.main()

        database.close.assert_called_once_with()
        subscriber.close.assert_called_once_with()

    def test_runtime_failure_stops_metrics_server_and_closes_resources(self):
        database = Mock()
        database.last_event_at.return_value = None
        database.rows.return_value = []
        database.histogram_rows.return_value = []
        subscriber = Mock()
        consumer = Mock()
        consumer.run_forever.side_effect = RuntimeError("consumer stopped")
        http_server = Mock()
        http_thread = Mock()

        with (
            patch.object(
                exporter.Config, "from_environment", return_value=main_config()
            ),
            patch.object(exporter, "Database", return_value=database),
            patch.object(exporter, "SubscriberClient", return_value=subscriber),
            patch.object(exporter, "EventConsumer", return_value=consumer),
            patch.object(
                exporter,
                "start_http_server",
                return_value=(http_server, http_thread),
            ),
            self.assertRaisesRegex(RuntimeError, "consumer stopped"),
        ):
            exporter.main()

        consumer.run_forever.assert_called_once_with(subscriber)
        http_server.shutdown.assert_called_once_with()
        http_thread.join.assert_called_once_with()
        http_server.server_close.assert_called_once_with()
        subscriber.close.assert_called_once_with()
        database.close.assert_called_once_with()


class HealthEndpointTests(unittest.TestCase):
    """`/healthz` must answer without rendering the metrics registry."""

    def wsgi_call(self, app, path, method="GET"):
        captured = {}

        def start_response(status, headers):
            captured["status"] = status
            captured["headers"] = dict(headers)

        body = b"".join(
            app({"PATH_INFO": path, "REQUEST_METHOD": method}, start_response)
        )
        return captured, body

    def test_health_path_answers_without_calling_the_metrics_app(self):
        metrics_app = Mock(return_value=[b"# metrics"])
        app = exporter.with_health_endpoint(metrics_app)

        captured, body = self.wsgi_call(app, exporter.HEALTH_PATH)

        self.assertEqual(captured["status"], "200 OK")
        self.assertEqual(body, b"ok\n")
        self.assertEqual(captured["headers"]["Content-Length"], str(len(body)))
        metrics_app.assert_not_called()

    def test_other_paths_still_reach_the_metrics_app(self):
        metrics_app = Mock(return_value=[b"# metrics"])
        app = exporter.with_health_endpoint(metrics_app)

        _, body = self.wsgi_call(app, "/metrics")

        self.assertEqual(body, b"# metrics")
        metrics_app.assert_called_once()

    def test_non_get_health_requests_are_left_to_the_metrics_app(self):
        """prometheus_client owns the 405; the probe only ever issues GET."""
        metrics_app = Mock(return_value=[b"405"])
        app = exporter.with_health_endpoint(metrics_app)

        _, body = self.wsgi_call(app, exporter.HEALTH_PATH, method="POST")

        self.assertEqual(body, b"405")
        metrics_app.assert_called_once()


class HealthEndpointServingTests(unittest.TestCase):
    """End-to-end: main() must actually install the wrapper on the live server.

    The unit tests above pass even if main() never calls set_app, which is the
    exact hand-off homelab#1204's healthcheck depends on -- so this drives a
    real HTTP request through the server main() builds.
    """

    def free_port(self):
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            return probe.getsockname()[1]

    def test_main_serves_health_and_metrics_on_the_real_server(self):
        port = self.free_port()
        config = main_config(port=port)
        # main() registers DatabaseMetrics, which the /metrics request below
        # actually collects -- so this needs a real (empty) database, not a
        # Mock standing in for one.
        temporary_directory = tempfile.TemporaryDirectory()
        self.addCleanup(temporary_directory.cleanup)
        database = exporter.Database(str(Path(temporary_directory.name) / "actions.db"))
        self.addCleanup(database.close)
        collected = []

        class CountingCollector:
            def collect(self):
                collected.append(1)
                return iter(())

        registry = CollectorRegistry()
        registry.register(CountingCollector())

        seen = {}

        def probe_then_stop(_subscriber):
            with urllib.request.urlopen(
                f"http://127.0.0.1:{port}{exporter.HEALTH_PATH}", timeout=5
            ) as response:
                seen["health"] = (response.status, response.read())
            seen["collected_after_health"] = len(collected)
            with urllib.request.urlopen(
                f"http://127.0.0.1:{port}/metrics", timeout=5
            ) as response:
                seen["metrics_status"] = response.status
            seen["collected_after_metrics"] = len(collected)
            raise RuntimeError("consumer stopped")

        consumer = Mock()
        consumer.run_forever.side_effect = probe_then_stop

        with (
            patch.object(exporter.Config, "from_environment", return_value=config),
            patch.object(exporter, "CollectorRegistry", return_value=registry),
            patch.object(exporter, "Database", return_value=database),
            patch.object(exporter, "SubscriberClient", return_value=Mock()),
            patch.object(exporter, "EventConsumer", return_value=consumer),
            self.assertRaisesRegex(RuntimeError, "consumer stopped"),
        ):
            exporter.main()

        self.assertEqual(seen["health"], (200, b"ok\n"))
        self.assertEqual(seen["metrics_status"], 200)
        # The whole point: the probe must not render the registry.
        self.assertEqual(seen["collected_after_health"], 0)
        self.assertGreater(seen["collected_after_metrics"], 0)


if __name__ == "__main__":
    unittest.main()

import importlib.util
import os
import socket
import sys
import tempfile
import time
import unittest
import urllib.request
from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest.mock import MagicMock, Mock, call, patch

import requests
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
        "name": "repository validation",
        "workflow_name": "dynamic run name that must not be exported",
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

    `labels` is the rendered label set, e.g. '{owner="jlapenna"}'. Matching the
    bare name alone would silently pick the wrong series once a metric grows a
    label, so the two forms are distinguished here rather than by prefix luck.
    """
    wanted = f"{name}{labels} "
    for line in metrics.splitlines():
        if line.startswith(wanted):
            return float(line.split()[-1])
    raise AssertionError(f"missing metric: {name}{labels}")


class FakeState:
    class Metric:
        def __init__(self):
            self.values = []

        def labels(self, *_args):
            return self

        def set(self, value):
            self.values.append(value)

        def inc(self):
            return None

    def __init__(self):
        self.last_success = self.Metric()
        self.poll_errors = self.Metric()
        self.api_requests = self.Metric()
        self.api_rate_remaining = self.Metric()
        self.api_rate_limit = self.Metric()
        self.api_rate_used = self.Metric()
        self.api_rate_reset_timestamp = self.Metric()
        self.backfill_in_progress = self.Metric()

    def record_response(self, endpoint, response, owner=""):
        self.api_requests.labels(
            owner.casefold(), endpoint, str(response.status_code)
        ).inc()


class FakeAPI:
    def __init__(self, run, jobs):
        self.run = run
        self.jobs = jobs
        self.job_requests = 0
        self.cutoffs = []

    def list_runs(self, _repository, cutoff, _until):
        self.cutoffs.append(cutoff)
        return [self.run]

    def get_run(self, _repository, _run_id):
        return self.run

    def list_jobs(self, _repository, _run_id):
        self.job_requests += 1
        return self.jobs


class GitHubActionsExporterTests(unittest.TestCase):
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

        self.database.upsert_jobs(
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

        self.database.upsert_jobs(
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
        self.database.upsert_jobs(
            repository, run, [workflow_job(status="in_progress", runner_name="  ")]
        )
        self.assertEqual(
            self.database.rows("SELECT runner_name FROM jobs WHERE id = 456")[0][
                "runner_name"
            ],
            "runner-homelab-autoscale-lcars-ci-abc123",
        )
        self.database.upsert_jobs(
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
        self.database.upsert_jobs(
            repository, completed_run, [workflow_job(runner_name=None)]
        )

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
        self.database.upsert_jobs("jlapenna/homelab", run, [workflow_job()])

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
        self.database.upsert_jobs(
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
        self.database.upsert_jobs("jlapenna/homelab", run, [job])

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
        self.database.upsert_jobs("jlapenna/homelab", run, [workflow_job()])

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
            self.database.upsert_jobs(
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

    def test_repeated_completed_run_does_not_refetch_or_double_count(self):
        run = workflow_run()
        api = FakeAPI(run, [workflow_job()])
        config = exporter.Config(
            credentials=exporter.StaticCredentials("test"),
            repositories=("jlapenna/homelab",),
            database_path=str(Path(self.temporary_directory.name) / "actions.db"),
        )
        poller = exporter.Poller(config, self.database, api, FakeState())

        poller.refresh_repository("jlapenna/homelab")
        poller.refresh_repository("jlapenna/homelab")

        self.assertEqual(api.job_requests, 1)
        self.assertTrue(self.database.backfill_complete("jlapenna/homelab"))
        self.assertIn(
            'github_actions_workflow_runs_total{conclusion="success",event="push",repository="jlapenna/homelab",workflow="validate"} 1.0',
            self.metrics(),
        )

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
        # A freshly backfilled database may hold only the tail of a longer
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

    def test_poller_finds_a_late_rerun_of_a_failed_pull_request_run(self):
        # GitHub lists runs by created_at, and a rerun keeps its run's. One
        # started after the overlap would never be seen, so the count would
        # outlive the repair until a new push passed.
        repository = "jlapenna/homelab"
        labels = '{repository="jlapenna/homelab",workflow="validate"}'
        name = "github_actions_workflow_pull_request_failing_branches"
        first = self.pull_request_run(5, "feature-a", id=1)
        second = self.pull_request_run(4, "feature-b", id=2)
        for run in (first, second):
            self.database.upsert_run(repository, run)
            self.database.upsert_jobs(repository, run, [])
        rerun = self.pull_request_run(
            1, "feature-a", "success", id=1, run_attempt=2, created_at=recent(5)
        )
        api = Mock()
        api.list_runs.return_value = []
        api.get_run.side_effect = lambda _repository, run_id: (
            rerun if run_id == 1 else second
        )
        api.list_jobs.return_value = []
        poller = exporter.Poller(
            exporter.Config(
                credentials=exporter.StaticCredentials("test"),
                repositories=(repository,),
            ),
            self.database,
            api,
            FakeState(),
        )
        self.assertEqual(exported_metric_value(self.metrics(), name, labels), 2.0)

        poller.refresh_repository(repository)

        self.assertCountEqual(
            api.get_run.call_args_list, [call(repository, 1), call(repository, 2)]
        )
        self.assertEqual(exported_metric_value(self.metrics(), name, labels), 0.0)

        # The recheck is rate-limited: the next cycle asks GitHub nothing.
        api.get_run.reset_mock()
        third = self.pull_request_run(0.5, "feature-c", id=3)
        self.database.upsert_run(repository, third)
        self.database.upsert_jobs(repository, third, [])
        poller.refresh_repository(repository)
        api.get_run.assert_not_called()

    def test_rerun_checks_rotate_past_the_per_cycle_cap(self):
        # Always checking the newest runs would never reach the rerun of an
        # older failure once more runs than the cap were failing.
        repository = "jlapenna/homelab"
        labels = '{repository="jlapenna/homelab",workflow="validate"}'
        name = "github_actions_workflow_pull_request_failing_branches"
        limit = exporter.PULL_REQUEST_RECHECK_LIMIT
        runs = {}
        # id 1 is the newest failure; the last id is the oldest.
        for run_id in range(1, limit + 2):
            run = self.pull_request_run(run_id, f"feature-{run_id}", id=run_id)
            runs[run_id] = run
            self.database.upsert_run(repository, run)
            self.database.upsert_jobs(repository, run, [])
        oldest = limit + 1
        runs[oldest] = self.pull_request_run(
            0.5,
            f"feature-{oldest}",
            "success",
            id=oldest,
            run_attempt=2,
            created_at=recent(oldest),
        )
        api = Mock()
        api.list_runs.return_value = []
        api.get_run.side_effect = lambda _repository, run_id: runs[run_id]
        api.list_jobs.return_value = []
        poller = exporter.Poller(
            exporter.Config(
                credentials=exporter.StaticCredentials("test"),
                repositories=(repository,),
            ),
            self.database,
            api,
            FakeState(),
        )

        poller.refresh_repository(repository)
        self.assertEqual(api.get_run.call_count, limit)
        self.assertNotIn(call(repository, oldest), api.get_run.call_args_list)
        self.assertEqual(
            exported_metric_value(self.metrics(), name, labels), float(limit + 1)
        )

        # The next eligible cycle starts with the run it has not checked yet.
        api.get_run.reset_mock()
        poller.pull_request_recheck_after.clear()
        poller.refresh_repository(repository)
        self.assertEqual(api.get_run.call_args_list[0], call(repository, oldest))
        self.assertEqual(api.get_run.call_count, limit)
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
        self.assertEqual(self.database.failing_pull_request_run_ids(repository), [])

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
        self.database.upsert_jobs(
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

    def test_refresh_recovers_an_unlisted_earlier_rerun_attempt(self):
        repository = "jlapenna/homelab"
        latest = workflow_run(conclusion="success", run_attempt=2)
        earlier = workflow_run(conclusion="failure", run_attempt=1)
        self.database.upsert_run(repository, latest)
        self.database.upsert_jobs(repository, latest, [workflow_job()])
        api = Mock()
        api.list_runs.return_value = []
        api.get_run_attempt.return_value = earlier
        poller = exporter.Poller(
            exporter.Config(
                credentials=exporter.StaticCredentials("test"),
                repositories=(repository,),
            ),
            self.database,
            api,
            FakeState(),
        )

        poller.refresh_repository(repository)

        api.get_run_attempt.assert_called_once_with(repository, latest["id"], 1)
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
        self.assertEqual(self.database.active_run_ids("jlapenna/homelab"), set())
        self.assertNotIn("github_actions_workflow_runs_current{", self.metrics())

    def test_late_older_attempt_cannot_become_active_again(self):
        older = workflow_run(status="queued", conclusion=None, run_attempt=1)
        newer = workflow_run(conclusion="success", run_attempt=2)

        self.database.upsert_run("jlapenna/homelab", newer)
        self.database.upsert_run("jlapenna/homelab", older)

        self.assertEqual(self.database.active_run_ids("jlapenna/homelab"), set())

    def test_active_job_exports_current_and_oldest_queue_gauges(self):
        run = workflow_run(
            status="in_progress", conclusion=None, updated_at="2026-08-05T04:19:30Z"
        )
        job = workflow_job(
            status="queued", conclusion=None, started_at=None, completed_at=None
        )
        self.database.upsert_run("jlapenna/homelab", run)
        self.database.upsert_jobs("jlapenna/homelab", run, [job])

        metrics = self.metrics()

        self.assertIn(
            'github_actions_workflow_runs_current{repository="jlapenna/homelab",status="in_progress",workflow="validate"} 1.0',
            metrics,
        )
        self.assertIn(
            'github_actions_jobs_current{concurrency_group="none",job="repository validation",repository="jlapenna/homelab",runner_group="Default",runs_on="",status="queued",workflow="validate"} 1.0',
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
        self.database.upsert_jobs("jlapenna/homelab", run, [job])
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
        self.database.upsert_jobs("jlapenna/homelab", completed, [workflow_job()])
        self.assertIn(
            "github_actions_workflow_runs_current{", generate_latest(registry).decode()
        )
        collector.refresh()
        refreshed = generate_latest(registry).decode()
        self.assertNotIn("github_actions_workflow_runs_current{", refreshed)
        self.assertNotIn("github_actions_job_oldest_queued_seconds{", refreshed)

    def test_completed_run_does_not_finalize_or_export_active_job_snapshot(self):
        run = workflow_run()
        job = workflow_job(
            status="queued", conclusion=None, started_at=None, completed_at=None
        )
        self.database.upsert_run("jlapenna/homelab", run)
        self.database.upsert_jobs("jlapenna/homelab", run, [job])

        rows = self.database.rows(
            """
            SELECT jobs.status, workflow_runs.jobs_updated_at
            FROM jobs JOIN workflow_runs
              ON workflow_runs.repository = jobs.repository
             AND workflow_runs.id = jobs.run_id
            WHERE jobs.repository = ? AND jobs.id = ?
            """,
            ("jlapenna/homelab", job["id"]),
        )
        self.assertEqual(
            [(row["status"], row["jobs_updated_at"]) for row in rows],
            [("refresh_pending", None)],
        )
        self.assertTrue(self.database.jobs_need_refresh("jlapenna/homelab", run))
        self.assertNotIn("github_actions_jobs_current{", self.metrics())
        self.assertNotIn("github_actions_job_oldest_queued_seconds{", self.metrics())

        completed_job = workflow_job()
        self.database.upsert_jobs("jlapenna/homelab", run, [completed_job])

        self.assertFalse(self.database.jobs_need_refresh("jlapenna/homelab", run))
        self.assertIn(
            'github_actions_jobs_total{conclusion="success",execution="unknown",job="repository validation",repository="jlapenna/homelab",runner_group="Default",workflow="validate"} 1.0',
            self.metrics(),
        )

    def test_startup_repairs_legacy_completed_run_with_active_job(self):
        run = workflow_run()
        job = workflow_job()
        self.database.upsert_run("jlapenna/homelab", run)
        self.database.upsert_jobs("jlapenna/homelab", run, [job])
        with self.database.lock, self.database.connection:
            self.database.connection.execute(
                "UPDATE jobs SET status = 'queued' WHERE repository = ? AND id = ?",
                ("jlapenna/homelab", job["id"]),
            )
        database_path = str(Path(self.temporary_directory.name) / "actions.db")
        self.database.close()
        self.database = exporter.Database(database_path)
        self.addCleanup(self.database.close)

        rows = self.database.rows(
            """
            SELECT jobs.status, workflow_runs.jobs_updated_at
            FROM jobs JOIN workflow_runs
              ON workflow_runs.repository = jobs.repository
             AND workflow_runs.id = jobs.run_id
            WHERE jobs.repository = ? AND jobs.id = ?
            """,
            ("jlapenna/homelab", job["id"]),
        )
        self.assertEqual(
            [(row["status"], row["jobs_updated_at"]) for row in rows],
            [("refresh_pending", None)],
        )
        self.assertNotIn("github_actions_jobs_current{", self.metrics())

    def test_completed_run_with_pending_jobs_is_polled_until_it_converges(self):
        repository = "jlapenna/homelab"
        run = workflow_run()
        queued_job = workflow_job(
            status="queued", conclusion=None, started_at=None, completed_at=None
        )
        self.database.upsert_run(repository, run)
        self.database.upsert_jobs(repository, run, [queued_job])
        self.assertEqual(
            self.database.pending_job_refresh_run_ids(repository), {run["id"]}
        )
        api = FakeAPI(run, [workflow_job()])
        api.list_runs = Mock(return_value=[])
        poller = exporter.Poller(
            exporter.Config(
                credentials=exporter.StaticCredentials("test"),
                repositories=(repository,),
            ),
            self.database,
            api,
            FakeState(),
        )

        poller.refresh_repository(repository)

        self.assertEqual(api.job_requests, 1)
        self.assertEqual(self.database.pending_job_refresh_run_ids(repository), set())
        self.assertIn(
            'github_actions_jobs_total{conclusion="success",execution="unknown",job="repository validation",repository="jlapenna/homelab",runner_group="Default",workflow="validate"} 1.0',
            self.metrics(),
        )

    def test_jobs_server_error_keeps_repository_fresh_and_retries_the_run(self):
        repository = "jlapenna/homelab"
        run = workflow_run()
        queued_job = workflow_job(
            status="queued", conclusion=None, started_at=None, completed_at=None
        )
        self.database.upsert_run(
            repository,
            workflow_run(
                status="in_progress",
                conclusion=None,
                updated_at="2026-08-05T04:00:00Z",
            ),
        )
        self.database.upsert_jobs(
            repository,
            workflow_run(
                status="in_progress",
                conclusion=None,
                updated_at="2026-08-05T04:00:00Z",
            ),
            [queued_job],
        )
        api = FakeAPI(run, [workflow_job()])
        api.list_runs = Mock(return_value=[run])
        api.list_jobs = Mock(
            side_effect=exporter.GitHubRequestError(
                "jobs", Mock(status_code=502, headers={})
            )
        )
        state = FakeState()
        poller = exporter.Poller(
            exporter.Config(
                credentials=exporter.StaticCredentials("test"),
                repositories=(repository,),
            ),
            self.database,
            api,
            state,
        )

        poller.refresh_repository(repository)

        self.assertIsNotNone(self.database.last_success_at(repository))
        self.assertEqual(
            self.database.pending_job_refresh_run_ids(repository), {run["id"]}
        )

        api.list_runs = Mock(return_value=[])
        api.list_jobs = Mock(return_value=[workflow_job()])
        poller.refresh_repository(repository)

        self.assertEqual(self.database.pending_job_refresh_run_ids(repository), set())
        self.assertIn(
            'github_actions_jobs_total{conclusion="success",execution="unknown",job="repository validation",repository="jlapenna/homelab",runner_group="Default",workflow="validate"} 1.0',
            self.metrics(),
        )

    def test_deleted_run_with_stale_jobs_snapshot_is_retired(self):
        repository = "jlapenna/homelab"
        active = workflow_run(
            status="in_progress", conclusion=None, updated_at="2026-08-05T04:00:00Z"
        )
        self.database.upsert_run(repository, active)
        self.database.upsert_jobs(
            repository,
            active,
            [
                workflow_job(
                    status="queued", conclusion=None, started_at=None, completed_at=None
                )
            ],
        )
        self.database.upsert_run(repository, workflow_run())
        self.assertEqual(
            self.database.pending_job_refresh_run_ids(repository), {active["id"]}
        )

        self.database.mark_run_missing(repository, active["id"])

        self.assertEqual(self.database.pending_job_refresh_run_ids(repository), set())
        self.assertNotIn("github_actions_jobs_current{", self.metrics())

    def test_empty_retry_keeps_omitted_refresh_pending_job_retryable(self):
        repository = "jlapenna/homelab"
        run = workflow_run()
        queued_job = workflow_job(
            status="queued", conclusion=None, started_at=None, completed_at=None
        )
        self.database.upsert_run(repository, run)
        self.database.upsert_jobs(repository, run, [queued_job])

        self.database.upsert_jobs(repository, run, [])

        self.assertEqual(
            self.database.pending_job_refresh_run_ids(repository), {run["id"]}
        )
        rows = self.database.rows(
            "SELECT status FROM jobs WHERE repository = ? AND id = ?",
            (repository, queued_job["id"]),
        )
        self.assertEqual([row["status"] for row in rows], ["refresh_pending"])
        self.assertNotIn("github_actions_job_oldest_queued_seconds{", self.metrics())

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
        self.database.upsert_jobs(repository, completed, [workflow_job()])
        self.database.upsert_run(repository, active)
        self.database.upsert_jobs(repository, active, [active_job])
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
            'github_actions_jobs_current{concurrency_group="none",job="repository validation",repository="jlapenna/homelab",runner_group="Default",runs_on="",status="queued",workflow="validate"} 1.0',
            self.metrics(),
        )

    def test_confirmed_concurrency_group_membership_is_exported(self):
        run = workflow_run(status="in_progress", conclusion=None)
        job = workflow_job(
            id=789, status="queued", conclusion=None, started_at=None, completed_at=None
        )
        self.database.upsert_run("jlapenna/homelab", run)
        self.database.upsert_jobs(
            "jlapenna/homelab",
            run,
            [job],
            [{"group_name": "ci-refs/heads/main", "group_members": [{"job_id": 789}]}],
        )

        metrics = self.metrics()

        self.assertIn(
            'github_actions_jobs_current{concurrency_group="ci-refs/heads/main",'
            'job="repository validation",repository="jlapenna/homelab",'
            'runner_group="Default",runs_on="",status="queued",workflow="validate"} 1.0',
            metrics,
        )

    def test_attempted_but_empty_concurrency_listing_is_unknown_not_none(self):
        # GitHub's own concurrency-groups listing is known (sampled by the
        # since-deleted dispatch broker) to report zero
        # group membership for a run even when a job genuinely holds a
        # concurrency group. An empty-but-attempted listing (an empty list,
        # as opposed to the "never attempted" None default) must not be
        # false-labeled "none" -- that would systematically misreport every
        # job caught by the endpoint's failure mode.
        run = workflow_run(status="in_progress", conclusion=None)
        job = workflow_job(
            status="queued", conclusion=None, started_at=None, completed_at=None
        )
        self.database.upsert_run("jlapenna/homelab", run)
        self.database.upsert_jobs("jlapenna/homelab", run, [job], [])

        metrics = self.metrics()

        self.assertIn(
            'github_actions_jobs_current{concurrency_group="unknown",'
            'job="repository validation",repository="jlapenna/homelab",'
            'runner_group="Default",runs_on="",status="queued",workflow="validate"} 1.0',
            metrics,
        )
        self.assertNotIn('concurrency_group="none"', metrics)

    def test_dynamic_concurrency_group_names_are_capped_per_workflow(self):
        run = workflow_run(status="in_progress", conclusion=None)
        with patch.object(exporter, "MAX_CONCURRENCY_GROUP_LABELS_PER_WORKFLOW", 2):
            self.database.upsert_run("jlapenna/homelab", run)
            self.database.upsert_jobs(
                "jlapenna/homelab",
                run,
                [
                    workflow_job(
                        id=1,
                        name="job one",
                        status="queued",
                        conclusion=None,
                        started_at=None,
                        completed_at=None,
                    ),
                    workflow_job(
                        id=2,
                        name="job two",
                        status="queued",
                        conclusion=None,
                        started_at=None,
                        completed_at=None,
                    ),
                    workflow_job(
                        id=3,
                        name="job three",
                        status="queued",
                        conclusion=None,
                        started_at=None,
                        completed_at=None,
                    ),
                ],
                [
                    {
                        "group_name": "pr-1000000001",
                        "group_members": [{"job_id": 1}],
                    },
                    {
                        "group_name": "pr-1000000002",
                        "group_members": [{"job_id": 2}],
                    },
                    {
                        "group_name": "pr-1000000003",
                        "group_members": [{"job_id": 3}],
                    },
                ],
            )

        metrics = self.metrics()
        self.assertIn('concurrency_group="pr-1000000001"', metrics)
        self.assertIn('concurrency_group="pr-1000000002"', metrics)
        self.assertIn('concurrency_group="__other__"', metrics)
        self.assertNotIn('concurrency_group="pr-1000000003"', metrics)

    def test_poller_fetches_concurrency_groups_only_for_active_runs(self):
        repository = "jlapenna/homelab"
        active_run = workflow_run(id=1, status="in_progress", conclusion=None)
        completed_run = workflow_run(id=2)
        api = Mock()
        api.list_runs.return_value = [active_run, completed_run]
        api.list_jobs.return_value = []
        api.list_concurrency_groups.return_value = []
        poller = exporter.Poller(
            exporter.Config(
                credentials=exporter.StaticCredentials("test"),
                repositories=(repository,),
            ),
            self.database,
            api,
            FakeState(),
        )

        poller.refresh_repository(repository)

        api.list_concurrency_groups.assert_called_once_with(repository, 1)

    def test_optional_concurrency_group_failure_keeps_core_job_refresh(self):
        repository = "jlapenna/agent-lcars"
        first_run = workflow_run(id=1, status="in_progress", conclusion=None)
        second_run = workflow_run(id=2, status="in_progress", conclusion=None)
        running_job = workflow_job(
            id=101,
            status="in_progress",
            conclusion=None,
            started_at="2026-08-05T04:19:39Z",
            completed_at=None,
        )
        queued_job = workflow_job(
            id=102,
            status="queued",
            conclusion=None,
            started_at=None,
            completed_at=None,
        )
        self.database.upsert_run(repository, first_run)
        self.database.upsert_jobs(
            repository,
            first_run,
            [
                workflow_job(
                    id=101,
                    status="queued",
                    conclusion=None,
                    started_at=None,
                    completed_at=None,
                )
            ],
            [
                {
                    "group_name": "ci-main",
                    "group_members": [{"job_id": 101}],
                }
            ],
        )
        api = Mock()
        api.list_runs.return_value = [first_run, second_run]
        api.list_jobs.side_effect = [[running_job], [queued_job]]
        response = Mock(status_code=403, headers={})
        error = exporter.GitHubRequestError("concurrency_groups", response)
        recovered_groups = [
            {
                "group_name": "ci-main",
                "group_members": [{"job_id": 101}, {"job_id": 102}],
            }
        ]
        api.list_concurrency_groups.side_effect = [
            error,
            recovered_groups,
            recovered_groups,
        ]
        state = FakeState()
        state.poll_errors = Mock()
        poller = exporter.Poller(
            exporter.Config(
                credentials=exporter.StaticCredentials("test"),
                repositories=(repository,),
            ),
            self.database,
            api,
            state,
        )

        with (
            # One read to grant concurrency-group slots, one per run for the
            # concurrency-group retry, then one for the pull-request rerun check.
            patch.object(exporter.time, "monotonic", side_effect=[100, 100, 100, 100]),
            self.assertLogs(exporter.LOGGER, level="WARNING") as logs,
        ):
            poller.refresh_repository(repository)

        self.assertTrue(self.database.backfill_complete(repository))
        self.assertEqual(len(state.last_success.values), 2)
        self.assertEqual(
            [
                (row["id"], row["status"], row["concurrency_group"])
                for row in self.database.rows(
                    "SELECT id, status, concurrency_group FROM jobs ORDER BY id"
                )
            ],
            [(101, "in_progress", "ci-main"), (102, "queued", "unknown")],
        )
        api.list_jobs.assert_has_calls([call(repository, 1), call(repository, 2)])
        api.list_concurrency_groups.assert_called_once_with(repository, 1)
        state.poll_errors.labels.assert_called_once_with(
            repository, "concurrency_groups"
        )
        state.poll_errors.labels.return_value.inc.assert_called_once_with()
        self.assertIn(
            "core job state retained with unknown concurrency metadata",
            "\n".join(logs.output),
        )

        api.list_jobs.side_effect = [[running_job], [queued_job]]
        with patch.object(exporter.time, "monotonic", side_effect=[401, 401, 401, 401]):
            poller.refresh_repository(repository)

        self.assertEqual(api.list_concurrency_groups.call_count, 3)
        self.assertEqual(
            [
                (row["id"], row["concurrency_group"])
                for row in self.database.rows(
                    "SELECT id, concurrency_group FROM jobs WHERE repository = ? ORDER BY id",
                    (repository,),
                )
            ],
            [(101, "ci-main"), (102, "ci-main")],
        )

    def test_optional_metadata_rate_limit_still_aborts_core_refresh(self):
        repository = "jlapenna/agent-lcars"
        first_run = workflow_run(id=1, status="in_progress", conclusion=None)
        second_run = workflow_run(id=2, status="in_progress", conclusion=None)
        api = Mock()
        api.list_runs.return_value = [first_run, second_run]
        api.list_jobs.return_value = [workflow_job()]
        response = Mock(
            status_code=429,
            headers={"x-ratelimit-remaining": "0", "x-github-request-id": "rate"},
        )
        error = exporter.GitHubRequestError("concurrency_groups", response)
        api.list_concurrency_groups.side_effect = error
        state = FakeState()
        state.poll_errors = Mock()
        poller = exporter.Poller(
            exporter.Config(
                credentials=exporter.StaticCredentials("test"),
                repositories=(repository,),
            ),
            self.database,
            api,
            state,
        )

        with self.assertRaises(exporter.GitHubRequestError) as raised:
            poller.refresh_repository(repository)

        self.assertIs(raised.exception, error)
        self.assertFalse(self.database.backfill_complete(repository))
        api.list_jobs.assert_called_once_with(repository, 1)
        state.poll_errors.labels.assert_not_called()

    def test_unexpected_optional_metadata_bug_still_fails_refresh(self):
        repository = "jlapenna/agent-lcars"
        run = workflow_run(id=1, status="in_progress", conclusion=None)
        api = Mock()
        api.list_runs.return_value = [run]
        api.list_jobs.return_value = [workflow_job()]
        api.list_concurrency_groups.side_effect = RuntimeError("programming bug")
        poller = exporter.Poller(
            exporter.Config(
                credentials=exporter.StaticCredentials("test"),
                repositories=(repository,),
            ),
            self.database,
            api,
            FakeState(),
        )

        with self.assertRaisesRegex(RuntimeError, "programming bug"):
            poller.refresh_repository(repository)

        self.assertFalse(self.database.backfill_complete(repository))

    def test_failed_initial_backfill_is_retried(self):
        class FailingAPI(FakeAPI):
            def list_jobs(self, _repository, _run_id):
                raise RuntimeError("temporary GitHub failure")

        run = workflow_run()
        config = exporter.Config(
            credentials=exporter.StaticCredentials("test"),
            repositories=("jlapenna/homelab",),
        )
        state = FakeState()
        poller = exporter.Poller(config, self.database, FailingAPI(run, []), state)

        with self.assertRaises(RuntimeError):
            poller.refresh_repository("jlapenna/homelab")

        self.assertFalse(self.database.backfill_complete("jlapenna/homelab"))
        self.assertEqual(state.backfill_in_progress.values, [0, 1, 0])

    def test_deleted_active_run_is_retired_without_blocking_repository_refresh(self):
        repository = "jlapenna/homelab"
        run = workflow_run(status="in_progress", conclusion=None)
        job = workflow_job(
            status="queued", conclusion=None, started_at=None, completed_at=None
        )
        self.database.upsert_run(repository, run)
        self.database.upsert_jobs(repository, run, [job])
        response = Mock(status_code=404, headers={})
        api = Mock()
        api.list_runs.return_value = []
        api.get_run.side_effect = exporter.GitHubRequestError("run", response)
        poller = exporter.Poller(
            exporter.Config(
                credentials=exporter.StaticCredentials("test"),
                repositories=(repository,),
            ),
            self.database,
            api,
            FakeState(),
        )

        poller.refresh_repository(repository)

        self.assertTrue(self.database.backfill_complete(repository))
        self.assertEqual(self.database.active_run_ids(repository), set())
        self.assertEqual(
            self.database.rows(
                "SELECT status FROM workflow_runs WHERE repository = ? AND id = ?",
                (repository, run["id"]),
            )[0]["status"],
            "missing",
        )
        self.assertEqual(
            self.database.rows(
                "SELECT status FROM jobs WHERE repository = ? AND run_id = ?",
                (repository, run["id"]),
            )[0]["status"],
            "missing",
        )

    def test_missing_latest_attempt_does_not_retire_earlier_completion(self):
        repository = "jlapenna/homelab"
        earlier = workflow_run(run_attempt=1)
        latest = workflow_run(
            run_attempt=2,
            status="in_progress",
            conclusion=None,
            updated_at="2026-08-05T04:21:23Z",
        )
        self.database.upsert_run(repository, earlier)
        self.database.upsert_run(repository, latest)
        self.database.upsert_jobs(
            repository,
            latest,
            [
                workflow_job(
                    status="queued",
                    conclusion=None,
                    started_at=None,
                    completed_at=None,
                )
            ],
        )

        self.database.mark_run_missing(repository, latest["id"])

        rows = self.database.rows(
            """
            SELECT run_attempt, status FROM workflow_runs
            WHERE repository = ? AND id = ? ORDER BY run_attempt
            """,
            (repository, latest["id"]),
        )
        self.assertEqual(
            [(row["run_attempt"], row["status"]) for row in rows],
            [(1, "completed"), (2, "missing")],
        )

    def test_active_run_server_error_still_fails_repository_refresh(self):
        repository = "jlapenna/homelab"
        run = workflow_run(status="in_progress", conclusion=None)
        self.database.upsert_run(repository, run)
        response = Mock(status_code=500, headers={})
        api = Mock()
        api.list_runs.return_value = []
        api.get_run.side_effect = exporter.GitHubRequestError("run", response)
        poller = exporter.Poller(
            exporter.Config(
                credentials=exporter.StaticCredentials("test"),
                repositories=(repository,),
            ),
            self.database,
            api,
            FakeState(),
        )

        with self.assertRaises(exporter.GitHubRequestError):
            poller.refresh_repository(repository)

        self.assertFalse(self.database.backfill_complete(repository))
        self.assertEqual(self.database.active_run_ids(repository), {run["id"]})

    def test_refresh_after_outage_uses_persisted_last_success(self):
        repository = "jlapenna/homelab"
        previous_success = datetime.now(UTC) - timedelta(hours=2)
        self.database.record_refresh_success(
            repository,
            initial=True,
            timestamp=previous_success.timestamp(),
        )
        api = FakeAPI(workflow_run(), [workflow_job()])
        config = exporter.Config(
            credentials=exporter.StaticCredentials("test"),
            repositories=(repository,),
            overlap_minutes=15,
        )
        poller = exporter.Poller(config, self.database, api, FakeState())

        poller.refresh_repository(repository)

        expected_cutoff = previous_success - timedelta(minutes=15)
        self.assertAlmostEqual(
            api.cutoffs[0].timestamp(), expected_cutoff.timestamp(), delta=1
        )

    def test_new_repository_is_stale_until_its_first_success(self):
        state = FakeState()

        exporter.Poller(
            exporter.Config(
                credentials=exporter.StaticCredentials("test"),
                repositories=("jlapenna/homelab",),
            ),
            self.database,
            FakeAPI(workflow_run(), []),
            state,
        )

        self.assertEqual(state.last_success.values, [0])


class ConfigTests(unittest.TestCase):
    def config(self, **environment):
        values = {
            "GITHUB_TOKEN": "test",
            "GITHUB_REPOSITORIES": "jlapenna/homelab",
        }
        values.update(environment)
        with patch.dict(os.environ, values, clear=True):
            return exporter.Config.from_environment()

    def test_duplicate_repositories_are_polled_once(self):
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

    def test_polling_windows_must_be_positive(self):
        for variable in ("BACKFILL_HOURS", "OVERLAP_MINUTES"):
            with (
                self.subTest(variable=variable),
                self.assertRaisesRegex(ValueError, "at least 1"),
            ):
                self.config(**{variable: "0"})

    def test_port_must_be_in_the_tcp_port_range(self):
        for port in ("0", "65536"):
            with (
                self.subTest(port=port),
                self.assertRaisesRegex(ValueError, "between 1 and 65535"),
            ):
                self.config(PORT=port)

    def test_required_connection_settings_cannot_be_blank(self):
        for variable in ("GITHUB_API_URL", "GITHUB_API_VERSION", "DATABASE_PATH"):
            with (
                self.subTest(variable=variable),
                self.assertRaisesRegex(ValueError, f"{variable} cannot be empty"),
            ):
                self.config(**{variable: "  "})

    def test_api_url_must_be_an_absolute_http_url(self):
        for api_url in ("/", "api.github.com", "ftp://api.github.com"):
            with (
                self.subTest(api_url=api_url),
                self.assertRaisesRegex(ValueError, "absolute HTTP"),
            ):
                self.config(GITHUB_API_URL=api_url)

    def test_api_version_must_be_an_iso_date(self):
        for api_version in ("latest", "2026-99-99"):
            with (
                self.subTest(api_version=api_version),
                self.assertRaisesRegex(ValueError, "YYYY-MM-DD"),
            ):
                self.config(GITHUB_API_VERSION=api_version)


class GitHubAPITests(unittest.TestCase):
    def setUp(self):
        self.api = exporter.GitHubAPI(
            exporter.Config(
                credentials=exporter.StaticCredentials("test"),
                repositories=("jlapenna/homelab",),
            ),
            FakeState(),
        )
        self.addCleanup(self.api.close)

    def test_rate_limit_headers_export_complete_quota_contract(self):
        registry = CollectorRegistry()
        state = exporter.ExporterState(registry)
        state.record_response(
            "test",
            Mock(
                status_code=200,
                headers={
                    "x-ratelimit-remaining": "42",
                    "x-ratelimit-limit": "5000",
                    "x-ratelimit-used": "4958",
                    "x-ratelimit-reset": "1786500000",
                },
            ),
            "jlapenna",
        )
        metrics = generate_latest(registry).decode()
        owner = '{owner="jlapenna"}'
        self.assertEqual(
            exported_metric_value(
                metrics, "github_actions_exporter_api_rate_limit_remaining", owner
            ),
            42,
        )
        self.assertEqual(
            exported_metric_value(
                metrics, "github_actions_exporter_api_rate_limit_limit", owner
            ),
            5000,
        )
        self.assertEqual(
            exported_metric_value(
                metrics, "github_actions_exporter_api_rate_limit_used", owner
            ),
            4958,
        )
        self.assertEqual(
            exported_metric_value(
                metrics,
                "github_actions_exporter_api_rate_limit_reset_timestamp_seconds",
                owner,
            ),
            1786500000,
        )

    def test_invalid_rate_limit_headers_do_not_replace_last_valid_values(self):
        registry = CollectorRegistry()
        state = exporter.ExporterState(registry)
        headers = {
            "x-ratelimit-remaining": ("42", "api_rate_limit_remaining", 42),
            "x-ratelimit-limit": ("5000", "api_rate_limit_limit", 5000),
            "x-ratelimit-used": ("4958", "api_rate_limit_used", 4958),
            "x-ratelimit-reset": (
                "1786500000",
                "api_rate_limit_reset_timestamp_seconds",
                1786500000,
            ),
        }
        state.record_response(
            "test",
            Mock(
                status_code=200,
                headers={header: value[0] for header, value in headers.items()},
            ),
            "jlapenna",
        )

        for header, (_valid, suffix, expected) in headers.items():
            for value in ("nan", "inf", "1.5", "-1"):
                with self.subTest(header=header, value=value):
                    state.record_response(
                        "test",
                        Mock(status_code=200, headers={header: value}),
                        "jlapenna",
                    )
                    self.assertEqual(
                        exported_metric_value(
                            generate_latest(registry).decode(),
                            f"github_actions_exporter_{suffix}",
                            '{owner="jlapenna"}',
                        ),
                        expected,
                    )

    def test_run_searches_are_partitioned_before_githubs_thousand_result_cap(self):
        start = datetime(2026, 8, 8, 0, 0, tzinfo=UTC)
        end = datetime(2026, 8, 8, 1, 0, tzinfo=UTC)
        page_requests = []

        def get(_path, *, endpoint, params):
            self.assertEqual(endpoint, "runs")
            page_requests.append(params.copy())
            created = params["created"]
            page = params["page"]
            if created == "2026-08-08T00:00:00+00:00..2026-08-08T01:00:00+00:00":
                return {"total_count": 1100, "workflow_runs": []}

            newer = created.startswith("2026-08-08T00:30:01")
            first_id = 601 if newer else 1
            total = 500 if newer else 600
            offset = (page - 1) * 100
            batch_size = min(100, max(0, total - offset))
            return {
                "total_count": total,
                "workflow_runs": [
                    workflow_run(id=first_id + offset + index)
                    for index in range(batch_size)
                ],
            }

        with patch.object(self.api, "get", side_effect=get):
            runs = self.api.list_runs("jlapenna/homelab", start, end)

        self.assertEqual({run["id"] for run in runs}, set(range(1, 1101)))
        self.assertFalse(any(request["page"] > 6 for request in page_requests))

    def test_http_response_is_closed_after_success(self):
        response = Mock(status_code=200, headers={})
        response.json.return_value = {"ok": True}
        self.api.state = Mock()
        self.api.session.get = Mock(return_value=response)

        self.assertEqual(
            self.api.get("/repos/jlapenna/homelab/test", endpoint="test"), {"ok": True}
        )

        response.close.assert_called_once_with()

    def test_http_response_is_closed_after_failure(self):
        response = Mock(status_code=500, headers={})
        response.raise_for_status.side_effect = exporter.requests.HTTPError("failed")
        self.api.state = Mock()
        self.api.session.get = Mock(return_value=response)

        with self.assertRaises(exporter.GitHubRequestError) as raised:
            self.api.get("/repos/jlapenna/homelab/test", endpoint="test")

        self.assertEqual(raised.exception.status_code, 500)
        response.close.assert_called_once_with()

    def test_run_search_fails_closed_if_one_second_exceeds_githubs_cap(self):
        instant = datetime(2026, 8, 8, tzinfo=UTC)
        payload = {"total_count": 1000, "workflow_runs": []}

        with (
            patch.object(self.api, "get", return_value=payload),
            self.assertRaisesRegex(RuntimeError, "one-second window"),
        ):
            self.api.list_runs("jlapenna/homelab", instant, instant)

    def test_job_pagination_does_not_silently_stop_at_one_thousand(self):
        pages = [
            {
                "total_count": 1100,
                "jobs": [
                    workflow_job(id=page * 100 + index + 1) for index in range(100)
                ],
            }
            for page in range(11)
        ]

        with patch.object(self.api, "get", side_effect=pages) as get:
            jobs = self.api.list_jobs("jlapenna/homelab", 123)

        self.assertEqual(len(jobs), 1100)
        self.assertEqual(get.call_count, 11)

    def test_paginated_responses_require_a_valid_total_and_object_items(self):
        invalid_payloads = (
            ({"jobs": []}, "total_count"),
            ({"total_count": -1, "jobs": []}, "total_count"),
            ({"total_count": True, "jobs": []}, "total_count"),
            ({"total_count": 1, "jobs": {}}, "not a list"),
            ({"total_count": 1, "jobs": [None]}, "non-object"),
            ({"total_count": 1, "jobs": [{}]}, "invalid id"),
            ({"total_count": 1, "jobs": [{"id": True}]}, "invalid id"),
            ({"total_count": 1, "jobs": [{"id": 0}]}, "invalid id"),
        )
        for payload, message in invalid_payloads:
            with (
                self.subTest(payload=payload),
                patch.object(self.api, "get", return_value=payload),
                self.assertRaisesRegex((TypeError, ValueError), message),
            ):
                self.api.list_jobs("jlapenna/homelab", 123)

    def test_duplicate_ids_cannot_hide_an_omitted_paginated_item(self):
        payload = {
            "total_count": 2,
            "jobs": [workflow_job(id=456), workflow_job(id=456)],
        }

        with (
            patch.object(self.api, "get", return_value=payload),
            self.assertRaisesRegex(RuntimeError, "duplicate id"),
        ):
            self.api.list_jobs("jlapenna/homelab", 123)

    def test_short_page_cannot_silently_omit_reported_results(self):
        payload = {"total_count": 2, "jobs": [workflow_job()]}

        with (
            patch.object(self.api, "get", return_value=payload),
            self.assertRaisesRegex(RuntimeError, "returned 1 of 2"),
        ):
            self.api.list_jobs("jlapenna/homelab", 123)


class MainTests(unittest.TestCase):
    def test_startup_failure_closes_database_and_api_session(self):
        database = Mock()
        database.last_success_at.return_value = None
        database.rows.return_value = []
        database.histogram_rows.return_value = []
        api = Mock()
        config = exporter.Config(
            credentials=exporter.StaticCredentials("test"),
            repositories=("jlapenna/homelab",),
        )

        with (
            patch.object(exporter.Config, "from_environment", return_value=config),
            patch.object(exporter, "Database", return_value=database),
            patch.object(exporter, "GitHubAPI", return_value=api),
            patch.object(exporter, "start_http_server", side_effect=OSError("in use")),
            self.assertRaisesRegex(OSError, "in use"),
        ):
            exporter.main()

        database.close.assert_called_once_with()
        api.close.assert_called_once_with()

    def test_runtime_failure_stops_metrics_server_and_closes_resources(self):
        database = Mock()
        database.last_success_at.return_value = None
        database.rows.return_value = []
        database.histogram_rows.return_value = []
        api = Mock()
        poller = Mock()
        poller.run_forever.side_effect = RuntimeError("polling stopped")
        http_server = Mock()
        http_thread = Mock()
        config = exporter.Config(
            credentials=exporter.StaticCredentials("test"),
            repositories=("jlapenna/homelab",),
        )

        with (
            patch.object(exporter.Config, "from_environment", return_value=config),
            patch.object(exporter, "Database", return_value=database),
            patch.object(exporter, "GitHubAPI", return_value=api),
            patch.object(exporter, "Poller", return_value=poller),
            patch.object(
                exporter,
                "start_http_server",
                return_value=(http_server, http_thread),
            ),
            self.assertRaisesRegex(RuntimeError, "polling stopped"),
        ):
            exporter.main()

        http_server.shutdown.assert_called_once_with()
        http_thread.join.assert_called_once_with()
        http_server.server_close.assert_called_once_with()
        api.close.assert_called_once_with()
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
        config = exporter.Config(
            credentials=exporter.StaticCredentials("test"),
            repositories=("jlapenna/homelab",),
            port=port,
        )
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

        def probe_then_stop(after_refresh):
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
            raise RuntimeError("polling stopped")

        poller = Mock()
        poller.run_forever.side_effect = probe_then_stop

        with (
            patch.object(exporter.Config, "from_environment", return_value=config),
            patch.object(exporter, "CollectorRegistry", return_value=registry),
            patch.object(exporter, "Database", return_value=database),
            patch.object(exporter, "GitHubAPI", return_value=Mock()),
            patch.object(exporter, "Poller", return_value=poller),
            self.assertRaisesRegex(RuntimeError, "polling stopped"),
        ):
            exporter.main()

        self.assertEqual(seen["health"], (200, b"ok\n"))
        self.assertEqual(seen["metrics_status"], 200)
        # The whole point: the probe must not render the registry.
        self.assertEqual(seen["collected_after_health"], 0)
        self.assertGreater(seen["collected_after_metrics"], 0)


if __name__ == "__main__":
    unittest.main()


def requests_error(status_code):
    """An HTTPError shaped like the ones the App endpoints actually raise."""
    import requests as _requests

    response = Mock(status_code=status_code)
    return _requests.HTTPError(f"{status_code}", response=response)


def _test_private_key_pem() -> bytes:
    from cryptography.hazmat.primitives import serialization as _serialization
    from cryptography.hazmat.primitives.asymmetric import rsa as _rsa

    key = _rsa.generate_private_key(public_exponent=65537, key_size=2048)
    return key.private_bytes(
        encoding=_serialization.Encoding.PEM,
        format=_serialization.PrivateFormat.PKCS8,
        encryption_algorithm=_serialization.NoEncryption(),
    )


class OwnerOfTests(unittest.TestCase):
    def test_owner_is_the_account_segment(self):
        self.assertEqual(
            exporter.owner_of("/repos/supersprinklesracing/www/actions/runs"),
            "supersprinklesracing",
        )

    def test_non_repository_path_is_rejected(self):
        # Guessing here would authenticate as whichever installation happened
        # to be cached, so the wrong-account failure must be loud.
        for path in (
            "/test",
            "/rate_limit",
            "/orgs/jlapenna/installation",
            "/repos//homelab/actions/runs",
        ):
            with self.subTest(path=path), self.assertRaises(ValueError):
                exporter.owner_of(path)


class AppCredentialsTests(unittest.TestCase):
    def setUp(self):
        self.pem = _test_private_key_pem()

    def credentials(self):
        return exporter.AppCredentials("Iv23test", self.pem, "https://api.github.com")

    @staticmethod
    def expiry(seconds_ahead):
        moment = datetime.now(UTC) + timedelta(seconds=seconds_ahead)
        return moment.isoformat().replace("+00:00", "Z")

    def test_each_owner_gets_its_own_installation_token(self):
        credentials = self.credentials()
        responses = {
            ("GET", "/orgs/jlapenna/installation"): requests_error(404),
            ("GET", "/users/jlapenna/installation"): {"id": 1},
            ("GET", "/orgs/supersprinklesracing/installation"): {"id": 2},
            ("POST", "/app/installations/1/access_tokens"): {
                "token": "personal",
                "expires_at": self.expiry(3600),
            },
            ("POST", "/app/installations/2/access_tokens"): {
                "token": "organization",
                "expires_at": self.expiry(3600),
            },
        }

        def request(method, path, bearer):
            result = responses[(method, path)]
            if isinstance(result, Exception):
                raise result
            return result

        with patch.object(credentials, "_request", side_effect=request):
            personal = credentials.authorization("jlapenna")
            organization = credentials.authorization("supersprinklesracing")

        # The whole point of the App over a PAT: one process, two accounts.
        self.assertEqual(personal, "Bearer personal")
        self.assertEqual(organization, "Bearer organization")

    def test_live_token_is_reused_and_a_near_expiry_one_is_replaced(self):
        credentials = self.credentials()
        minted = []

        def request(method, path, bearer):
            if method == "GET":
                return {"id": 1}
            minted.append(path)
            return {"token": f"token-{len(minted)}", "expires_at": self.expiry(3600)}

        with patch.object(credentials, "_request", side_effect=request):
            first = credentials.authorization("jlapenna")
            second = credentials.authorization("jlapenna")
            self.assertEqual(first, second)
            self.assertEqual(len(minted), 1)

            # Age the cached token to inside the refresh margin: it must be
            # replaced before it can expire mid-sweep, not after it 401s.
            token, _ = credentials._tokens["jlapenna"]
            credentials._tokens["jlapenna"] = (
                token,
                time.time() + exporter.APP_TOKEN_REFRESH_MARGIN_SECONDS - 1,
            )
            third = credentials.authorization("jlapenna")

        self.assertEqual(third, "Bearer token-2")
        self.assertEqual(len(minted), 2)

    def test_owner_with_no_installation_is_reported(self):
        credentials = self.credentials()
        with (
            patch.object(credentials, "_request", side_effect=requests_error(404)),
            self.assertRaises(RuntimeError),
        ):
            credentials.authorization("someone-else")


class CredentialSelectionTests(unittest.TestCase):
    def environment(self, **values):
        base = {"GITHUB_REPOSITORIES": "jlapenna/homelab"}
        base.update(values)
        return patch.dict(os.environ, base, clear=True)

    def test_personal_access_token_is_the_fallback(self):
        with self.environment(GITHUB_TOKEN="test"):
            config = exporter.Config.from_environment()
        self.assertIsInstance(config.credentials, exporter.StaticCredentials)
        self.assertEqual(config.credentials.authorization("jlapenna"), "Bearer test")

    def test_app_is_preferred_over_a_token_when_both_are_present(self):
        with tempfile.NamedTemporaryFile(suffix=".pem") as key_file:
            key_file.write(_test_private_key_pem())
            key_file.flush()
            with self.environment(
                GITHUB_TOKEN="test",
                GITHUB_APP_CLIENT_ID="Iv23test",
                GITHUB_APP_PRIVATE_KEY_FILE=key_file.name,
            ):
                config = exporter.Config.from_environment()
        self.assertIsInstance(config.credentials, exporter.AppCredentials)

    def test_half_configured_app_is_rejected_rather_than_ignored(self):
        # Silently falling back to the PAT here would reproduce the exact
        # outage this replaces: a partial rollout that looks configured.
        with (
            self.environment(GITHUB_TOKEN="test", GITHUB_APP_CLIENT_ID="Iv23test"),
            self.assertRaises(ValueError),
        ):
            exporter.Config.from_environment()


class PerRequestAuthorizationTests(unittest.TestCase):
    def test_request_carries_the_owning_account_token(self):
        credentials = Mock()
        credentials.authorization.return_value = "Bearer scoped"
        config = exporter.Config(
            credentials=credentials, repositories=("supersprinklesracing/www",)
        )
        api = exporter.GitHubAPI(config, Mock())
        response = Mock(status_code=200, headers={})
        response.json.return_value = {"ok": True}
        api.session.get = Mock(return_value=response)

        api.get("/repos/supersprinklesracing/www/actions/runs", endpoint="runs")

        credentials.authorization.assert_called_once_with("supersprinklesracing")
        self.assertEqual(
            api.session.get.call_args.kwargs["headers"],
            {"Authorization": "Bearer scoped"},
        )
        # A stale session-level header would silently win over the per-request
        # one for some owners, so it must not exist at all.
        self.assertNotIn("Authorization", api.session.headers)


class PerOwnerQuotaTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary_directory.cleanup)
        self.database = exporter.Database(
            str(Path(self.temporary_directory.name) / "actions.db")
        )
        self.addCleanup(self.database.close)
        self.now_epoch = 1_794_700_000.0
        self.now_monotonic = 1_000.0

    def advance(self, seconds: float) -> None:
        self.now_epoch += seconds
        self.now_monotonic += seconds

    @staticmethod
    def json_response(payload, *, status_code=200, headers=None):
        response = Mock(status_code=status_code, headers=dict(headers or {}))
        if status_code >= 400:
            response.raise_for_status.side_effect = requests.HTTPError(
                f"{status_code}", response=response
            )
        else:
            response.json.return_value = payload
        return response

    def test_one_owners_quota_does_not_overwrite_anothers(self):
        # GitHub meters each installation against its own core quota. A single
        # unlabelled gauge meant whichever repository was polled last decided
        # what the quota panels and the exhaustion alert saw.
        registry = CollectorRegistry()
        state = exporter.ExporterState(registry)
        for owner, remaining in (("jlapenna", "4200"), ("supersprinklesracing", "17")):
            state.record_response(
                "runs",
                Mock(status_code=200, headers={"x-ratelimit-remaining": remaining}),
                owner,
            )

        metrics = generate_latest(registry).decode()
        name = "github_actions_exporter_api_rate_limit_remaining"
        self.assertEqual(
            exported_metric_value(metrics, name, '{owner="jlapenna"}'), 4200
        )
        self.assertEqual(
            exported_metric_value(metrics, name, '{owner="supersprinklesracing"}'), 17
        )

    def test_api_requests_counter_records_owner_endpoint_and_status_independently(self):
        registry = CollectorRegistry()
        state = exporter.ExporterState(registry)
        state.record_response("runs", Mock(status_code=200, headers={}), "jlapenna")
        state.record_response("runs", Mock(status_code=403, headers={}), "jlapenna")
        state.record_response("jobs", Mock(status_code=200, headers={}), "jlapenna")
        state.record_response(
            "runs", Mock(status_code=200, headers={}), "supersprinklesracing"
        )

        metrics = generate_latest(registry).decode()
        counter = "github_actions_exporter_api_requests_total"
        self.assertEqual(
            exported_metric_value(
                metrics, counter, '{endpoint="runs",owner="jlapenna",status="200"}'
            ),
            1.0,
        )
        self.assertEqual(
            exported_metric_value(
                metrics, counter, '{endpoint="runs",owner="jlapenna",status="403"}'
            ),
            1.0,
        )
        self.assertEqual(
            exported_metric_value(
                metrics, counter, '{endpoint="jobs",owner="jlapenna",status="200"}'
            ),
            1.0,
        )
        self.assertEqual(
            exported_metric_value(
                metrics,
                counter,
                '{endpoint="runs",owner="supersprinklesracing",status="200"}',
            ),
            1.0,
        )

    def test_exhausted_owner_backs_off_across_repos_and_cycles_until_reset_then_backfills(
        self,
    ):
        repositories = (
            "jlapenna/agent-lcars",
            "jlapenna/homelab",
            "supersprinklesracing/sprinkles",
        )
        registry = CollectorRegistry()
        state = exporter.ExporterState(registry)
        db_metrics = exporter.DatabaseMetrics(self.database)
        registry.register(db_metrics)
        config = exporter.Config(
            credentials=exporter.StaticCredentials("test"),
            repositories=repositories,
            overlap_minutes=15,
        )
        api = exporter.GitHubAPI(
            config,
            state,
            clock=lambda: self.now_epoch,
            monotonic=lambda: self.now_monotonic,
        )
        self.addCleanup(api.close)
        poller = exporter.Poller(
            config,
            self.database,
            api,
            state,
            clock=lambda: self.now_epoch,
            monotonic=lambda: self.now_monotonic,
        )

        calls: list[tuple[str, dict]] = []
        reset_epoch = int(self.now_epoch + 240)
        mode = "healthy"
        missed_run = workflow_run(
            id=901,
            created_at=datetime.fromtimestamp(self.now_epoch + 90, UTC).strftime(
                "%Y-%m-%dT%H:%M:%SZ"
            ),
            run_started_at=datetime.fromtimestamp(self.now_epoch + 92, UTC).strftime(
                "%Y-%m-%dT%H:%M:%SZ"
            ),
            updated_at=datetime.fromtimestamp(self.now_epoch + 120, UTC).strftime(
                "%Y-%m-%dT%H:%M:%SZ"
            ),
        )

        def fake_get(url, *, params=None, timeout=None, headers=None):
            path = url.removeprefix(config.api_url)
            calls.append((path, dict(params or {})))
            owner = exporter.owner_of(path)
            if owner == "supersprinklesracing":
                return self.json_response(
                    {"total_count": 0, "workflow_runs": []},
                    headers={
                        "x-ratelimit-remaining": "2422",
                        "x-ratelimit-limit": "5000",
                        "x-ratelimit-reset": str(reset_epoch + 1800),
                    },
                )
            if mode == "healthy":
                return self.json_response(
                    {"total_count": 0, "workflow_runs": []},
                    headers={
                        "x-ratelimit-remaining": "1000",
                        "x-ratelimit-limit": "5850",
                        "x-ratelimit-reset": str(reset_epoch),
                    },
                )
            if mode == "exhausted":
                return self.json_response(
                    {},
                    status_code=403,
                    headers={
                        "x-ratelimit-remaining": "0",
                        "x-ratelimit-limit": "5850",
                        "x-ratelimit-used": "5850",
                        "x-ratelimit-reset": str(reset_epoch),
                        "x-github-request-id": "exhausted-jlapenna",
                    },
                )
            if path == "/repos/jlapenna/agent-lcars/actions/runs":
                return self.json_response(
                    {"total_count": 1, "workflow_runs": [missed_run]},
                    headers={
                        "x-ratelimit-remaining": "5849",
                        "x-ratelimit-limit": "5850",
                        "x-ratelimit-reset": str(reset_epoch + 3600),
                    },
                )
            if path == "/repos/jlapenna/agent-lcars/actions/runs/901/jobs":
                return self.json_response(
                    {"total_count": 1, "jobs": [workflow_job(id=902)]},
                    headers={
                        "x-ratelimit-remaining": "5848",
                        "x-ratelimit-limit": "5850",
                        "x-ratelimit-reset": str(reset_epoch + 3600),
                    },
                )
            return self.json_response(
                {"total_count": 0, "workflow_runs": []},
                headers={
                    "x-ratelimit-remaining": "5847",
                    "x-ratelimit-limit": "5850",
                    "x-ratelimit-reset": str(reset_epoch + 3600),
                },
            )

        api.session.get = Mock(side_effect=fake_get)

        initial_epoch = self.now_epoch
        poller.refresh_all()
        self.assertEqual(len(calls), 3)

        # Cycle 2 (T+60): jlapenna/agent-lcars hits HTTP 403 Remaining=0;
        # jlapenna/homelab skips with zero HTTP calls; supersprinklesracing refreshes.
        calls.clear()
        self.advance(60)
        mode = "exhausted"
        with self.assertLogs(exporter.LOGGER, level="WARNING") as logs:
            poller.refresh_all()

        self.assertEqual(
            [path for path, _ in calls],
            [
                "/repos/jlapenna/agent-lcars/actions/runs",
                "/repos/supersprinklesracing/sprinkles/actions/runs",
            ],
        )
        self.assertTrue(
            any("skipping jlapenna/homelab" in line for line in logs.output)
        )
        metrics = generate_latest(registry).decode()
        self.assertEqual(
            exported_metric_value(
                metrics,
                "github_actions_exporter_last_success_timestamp_seconds",
                '{repository="jlapenna/agent-lcars"}',
            ),
            initial_epoch,
        )
        self.assertEqual(
            exported_metric_value(
                metrics,
                "github_actions_exporter_last_success_timestamp_seconds",
                '{repository="jlapenna/homelab"}',
            ),
            initial_epoch,
        )
        self.assertEqual(
            exported_metric_value(
                metrics,
                "github_actions_exporter_last_success_timestamp_seconds",
                '{repository="supersprinklesracing/sprinkles"}',
            ),
            initial_epoch + 60,
        )
        self.assertEqual(
            exported_metric_value(
                metrics,
                "github_actions_exporter_poll_errors_total",
                '{repository="jlapenna/agent-lcars",stage="rate_limit"}',
            ),
            1.0,
        )
        self.assertEqual(
            exported_metric_value(
                metrics,
                "github_actions_exporter_poll_errors_total",
                '{repository="jlapenna/homelab",stage="rate_limit"}',
            ),
            1.0,
        )

        # Cycle 3 (T+120, still before reset T+240): zero HTTP calls for jlapenna/*.
        calls.clear()
        self.advance(60)
        with self.assertLogs(exporter.LOGGER, level="WARNING"):
            poller.refresh_all()

        self.assertEqual(
            [path for path, _ in calls],
            ["/repos/supersprinklesracing/sprinkles/actions/runs"],
        )
        metrics = generate_latest(registry).decode()
        self.assertEqual(
            exported_metric_value(
                metrics,
                "github_actions_exporter_api_requests_total",
                '{endpoint="runs",owner="jlapenna",status="403"}',
            ),
            1.0,
        )
        self.assertEqual(
            exported_metric_value(
                metrics,
                "github_actions_exporter_last_success_timestamp_seconds",
                '{repository="jlapenna/agent-lcars"}',
            ),
            initial_epoch,
        )
        self.assertEqual(
            exported_metric_value(
                metrics,
                "github_actions_exporter_last_success_timestamp_seconds",
                '{repository="supersprinklesracing/sprinkles"}',
            ),
            initial_epoch + 120,
        )

        # Cycle 4 (T+241, past reset): jlapenna resumes, backfills from
        # initial_epoch - 15m, and advances last_success_timestamp_seconds.
        calls.clear()
        self.advance(121)
        mode = "recovered"
        poller.refresh_all()
        db_metrics.refresh()

        expected_cutoff = datetime.fromtimestamp(initial_epoch - 15 * 60, UTC).replace(
            microsecond=0
        )
        lcars_runs_params = next(
            params
            for path, params in calls
            if path == "/repos/jlapenna/agent-lcars/actions/runs"
        )
        self.assertTrue(
            lcars_runs_params["created"].startswith(
                expected_cutoff.isoformat(timespec="seconds") + ".."
            )
        )
        metrics = generate_latest(registry).decode()
        self.assertEqual(
            exported_metric_value(
                metrics,
                "github_actions_exporter_last_success_timestamp_seconds",
                '{repository="jlapenna/agent-lcars"}',
            ),
            self.now_epoch,
        )
        self.assertEqual(
            exported_metric_value(
                metrics,
                "github_actions_exporter_last_success_timestamp_seconds",
                '{repository="jlapenna/homelab"}',
            ),
            self.now_epoch,
        )
        self.assertEqual(
            exported_metric_value(
                metrics,
                "github_actions_workflow_runs_total",
                '{conclusion="success",event="push",repository="jlapenna/agent-lcars",workflow="validate"}',
            ),
            1.0,
        )

    def test_zero_remaining_on_200_response_arms_backoff_before_403_and_casefolds_owner(
        self,
    ):
        repositories = ("JLaPenna/Homelab", "jlapenna/agent-lcars")
        registry = CollectorRegistry()
        state = exporter.ExporterState(registry)
        config = exporter.Config(
            credentials=exporter.StaticCredentials("test"),
            repositories=repositories,
        )
        api = exporter.GitHubAPI(
            config,
            state,
            clock=lambda: self.now_epoch,
            monotonic=lambda: self.now_monotonic,
        )
        self.addCleanup(api.close)
        poller = exporter.Poller(
            config,
            self.database,
            api,
            state,
            clock=lambda: self.now_epoch,
            monotonic=lambda: self.now_monotonic,
        )
        api.session.get = Mock(
            return_value=self.json_response(
                {"total_count": 0, "workflow_runs": []},
                headers={
                    "X-RateLimit-Remaining": "0",
                    "X-RateLimit-Reset": str(int(self.now_epoch + 180)),
                },
            )
        )

        with self.assertLogs(exporter.LOGGER, level="WARNING"):
            poller.refresh_all()

        # First repo spent the final allowed token on HTTP 200 and succeeded;
        # second repo under the same account (different casing) backed off locally
        # without issuing a doomed HTTP 403.
        self.assertEqual(api.session.get.call_count, 1)
        metrics = generate_latest(registry).decode()
        self.assertEqual(
            exported_metric_value(
                metrics,
                "github_actions_exporter_last_success_timestamp_seconds",
                '{repository="JLaPenna/Homelab"}',
            ),
            self.now_epoch,
        )
        self.assertEqual(
            exported_metric_value(
                metrics,
                "github_actions_exporter_last_success_timestamp_seconds",
                '{repository="jlapenna/agent-lcars"}',
            ),
            0.0,
        )
        self.assertEqual(
            exported_metric_value(
                metrics,
                "github_actions_exporter_api_requests_total",
                '{endpoint="runs",owner="jlapenna",status="200"}',
            ),
            1.0,
        )
        self.assertEqual(
            exported_metric_value(
                metrics,
                "github_actions_exporter_api_rate_limit_remaining",
                '{owner="jlapenna"}',
            ),
            0.0,
        )
        self.assertNotIn('owner="JLaPenna"', metrics)

    def test_retry_after_delta_http_date_clock_skew_fallback_and_ceiling(self):
        config = exporter.Config(
            credentials=exporter.StaticCredentials("test"),
            repositories=("jlapenna/homelab",),
        )
        api = exporter.GitHubAPI(
            config,
            exporter.ExporterState(CollectorRegistry()),
            clock=lambda: self.now_epoch,
            monotonic=lambda: self.now_monotonic,
        )
        self.addCleanup(api.close)

        # 1. Secondary rate limit: Remaining > 0 with Retry-After=90 must wait
        # 90s rather than locking out until the 40-minute primary reset window.
        api.session.get = Mock(
            side_effect=[
                self.json_response(
                    {},
                    status_code=403,
                    headers={
                        "X-RateLimit-Remaining": "3500",
                        "X-RateLimit-Reset": str(int(self.now_epoch + 2400)),
                        "Retry-After": "90",
                    },
                ),
                self.json_response({"ok": True}),
            ]
        )
        with self.assertRaises(exporter.GitHubRequestError):
            api.get("/repos/jlapenna/homelab/actions/runs", endpoint="runs")
        self.advance(89)
        with self.assertRaises(exporter.GitHubRateLimitBackoffError):
            api.get("/repos/jlapenna/homelab/actions/runs", endpoint="runs")
        self.advance(2)
        self.assertEqual(
            api.get("/repos/jlapenna/homelab/actions/runs", endpoint="runs"),
            {"ok": True},
        )
        self.assertEqual(api.session.get.call_count, 2)

        # 2. RFC 7231 HTTP-date Retry-After on HTTP 429.
        target = datetime.fromtimestamp(int(self.now_epoch) + 150, UTC)
        http_date = target.strftime("%a, %d %b %Y %H:%M:%S GMT")
        self.now_epoch = float(int(self.now_epoch))
        api.session.get = Mock(
            side_effect=[
                self.json_response(
                    {},
                    status_code=429,
                    headers={"Retry-After": http_date},
                ),
                self.json_response({"ok": True}),
            ]
        )
        with self.assertRaises(exporter.GitHubRequestError):
            api.get("/repos/jlapenna/homelab/actions/runs", endpoint="runs")
        self.advance(149)
        with self.assertRaises(exporter.GitHubRateLimitBackoffError):
            api.get("/repos/jlapenna/homelab/actions/runs", endpoint="runs")
        self.advance(2)
        self.assertEqual(
            api.get("/repos/jlapenna/homelab/actions/runs", endpoint="runs"),
            {"ok": True},
        )

        # 3. Clock skew (reset <= now on rate-limited 403) uses bounded minimum
        # backoff, and runaway Retry-After is capped at MAX_RATE_LIMIT_BACKOFF_SECONDS.
        api.session.get = Mock(
            side_effect=[
                self.json_response(
                    {},
                    status_code=403,
                    headers={
                        "x-ratelimit-remaining": "0",
                        "x-ratelimit-reset": str(int(self.now_epoch - 5)),
                    },
                ),
                self.json_response(
                    {},
                    status_code=429,
                    headers={"Retry-After": "999999"},
                ),
                self.json_response({"ok": True}),
            ]
        )
        with self.assertRaises(exporter.GitHubRequestError):
            api.get("/repos/jlapenna/homelab/actions/runs", endpoint="runs")
        # Documented contract: 60-second fallback, one-hour ceiling. Literal
        # values so a changed constant fails here instead of moving the test.
        self.advance(59)
        with self.assertRaises(exporter.GitHubRateLimitBackoffError):
            api.get("/repos/jlapenna/homelab/actions/runs", endpoint="runs")
        self.advance(2)
        with self.assertRaises(exporter.GitHubRequestError):
            api.get("/repos/jlapenna/homelab/actions/runs", endpoint="runs")
        self.advance(3599)
        with self.assertRaises(exporter.GitHubRateLimitBackoffError):
            api.get("/repos/jlapenna/homelab/actions/runs", endpoint="runs")
        self.advance(2)
        self.assertEqual(
            api.get("/repos/jlapenna/homelab/actions/runs", endpoint="runs"),
            {"ok": True},
        )

    def test_optional_metadata_throttles_caps_and_skips_below_quota_reserve(self):
        repositories = ("jlapenna/agent-lcars", "supersprinklesracing/sprinkles")
        registry = CollectorRegistry()
        state = exporter.ExporterState(registry)
        db_metrics = exporter.DatabaseMetrics(self.database)
        registry.register(db_metrics)
        config = exporter.Config(
            credentials=exporter.StaticCredentials("test"),
            repositories=repositories,
        )
        api = exporter.GitHubAPI(
            config,
            state,
            clock=lambda: self.now_epoch,
            monotonic=lambda: self.now_monotonic,
        )
        self.addCleanup(api.close)
        poller = exporter.Poller(
            config,
            self.database,
            api,
            state,
            clock=lambda: self.now_epoch,
            monotonic=lambda: self.now_monotonic,
        )

        # Seed a failed pull_request run older than overlap on both owners so PR
        # rerun rechecks would normally query get_run on each eligible cycle.
        old_pr_time = datetime.fromtimestamp(self.now_epoch - 3600, UTC).strftime(
            "%Y-%m-%dT%H:%M:%SZ"
        )
        for repo, run_id in (
            ("jlapenna/agent-lcars", 500),
            ("supersprinklesracing/sprinkles", 600),
        ):
            failed_pr = workflow_run(
                id=run_id,
                event="pull_request",
                conclusion="failure",
                head_branch="feature-x",
                created_at=old_pr_time,
                run_started_at=old_pr_time,
                updated_at=old_pr_time,
            )
            self.database.upsert_run(repo, failed_pr)
            self.database.upsert_jobs(repo, failed_pr, [])

        jlapenna_remaining = "2000"
        active_lcars = workflow_run(id=1, status="in_progress", conclusion=None)
        active_sprinkles = workflow_run(id=2, status="in_progress", conclusion=None)
        concurrency_calls: list[str] = []
        pr_recheck_calls: list[str] = []

        def fake_get(url, *, params=None, timeout=None, headers=None):
            path = url.removeprefix(config.api_url)
            owner = exporter.owner_of(path)
            rem = jlapenna_remaining if owner == "jlapenna" else "2422"
            rate_headers = {
                "x-ratelimit-remaining": rem,
                "x-ratelimit-reset": str(int(self.now_epoch + 1800)),
            }
            if path.endswith("/actions/runs"):
                run = active_lcars if owner == "jlapenna" else active_sprinkles
                return self.json_response(
                    {"total_count": 1, "workflow_runs": [run]}, headers=rate_headers
                )
            if path.endswith("/jobs"):
                job_id = 101 if owner == "jlapenna" else 202
                return self.json_response(
                    {
                        "total_count": 1,
                        "jobs": [
                            workflow_job(
                                id=job_id,
                                status="queued",
                                conclusion=None,
                                started_at=None,
                                completed_at=None,
                            )
                        ],
                    },
                    headers=rate_headers,
                )
            if path.endswith("/concurrency_groups"):
                concurrency_calls.append(path)
                job_id = 101 if owner == "jlapenna" else 202
                return self.json_response(
                    {
                        "concurrency_groups": [
                            {
                                "group_name": "ci-main",
                                "group_members": [{"job_id": job_id}],
                            }
                        ]
                    },
                    headers=rate_headers,
                )
            pr_recheck_calls.append(path)
            return self.json_response({}, status_code=404, headers=rate_headers)

        api.session.get = Mock(side_effect=fake_get)

        # Cycle 1 (healthy quota): both owners resolve concurrency_groups & recheck PRs.
        poller.refresh_all()
        self.assertEqual(
            concurrency_calls,
            [
                "/repos/jlapenna/agent-lcars/actions/runs/1/concurrency_groups",
                "/repos/supersprinklesracing/sprinkles/actions/runs/2/concurrency_groups",
            ],
        )
        self.assertEqual(
            pr_recheck_calls,
            [
                "/repos/jlapenna/agent-lcars/actions/runs/500",
                "/repos/supersprinklesracing/sprinkles/actions/runs/600",
            ],
        )

        # Cycle 2 (T+60, inside 300s per-run throttle): active runs do NOT re-query
        # concurrency_groups, and SQLite preserves confirmed "ci-main".
        concurrency_calls.clear()
        pr_recheck_calls.clear()
        self.advance(60)
        poller.refresh_all()
        self.assertEqual(concurrency_calls, [])
        self.assertEqual(
            self.database.rows(
                "SELECT concurrency_group FROM jobs WHERE repository = 'jlapenna/agent-lcars' AND id = 101"
            )[0]["concurrency_group"],
            "ci-main",
        )

        # Cycle 3 (T+361, past 300s throttle, but jlapenna drops below 500 reserve):
        # jlapenna skips BOTH concurrency_groups and PR rerun recheck while keeping
        # "ci-main" intact; supersprinklesracing runs both normally!
        jlapenna_remaining = "499"
        self.advance(301)
        poller.refresh_all()
        self.assertEqual(
            concurrency_calls,
            ["/repos/supersprinklesracing/sprinkles/actions/runs/2/concurrency_groups"],
        )
        self.assertEqual(
            pr_recheck_calls,
            ["/repos/supersprinklesracing/sprinkles/actions/runs/600"],
        )
        self.assertEqual(
            self.database.rows(
                "SELECT concurrency_group FROM jobs WHERE repository = 'jlapenna/agent-lcars' AND id = 101"
            )[0]["concurrency_group"],
            "ci-main",
        )

        # Per-cycle cap: with 3 active runs and cap=2, at most 2 concurrency_groups
        # calls fire in one cycle, and the unqueried active job stays "unknown" (not "none").
        jlapenna_remaining = "2000"
        burst_runs = [
            workflow_run(id=10 + idx, status="queued", conclusion=None)
            for idx in range(3)
        ]

        def burst_get(url, *, params=None, timeout=None, headers=None):
            path = url.removeprefix(config.api_url)
            rate_headers = {
                "x-ratelimit-remaining": "2000",
                "x-ratelimit-reset": str(int(self.now_epoch + 1800)),
            }
            if path == "/repos/jlapenna/agent-lcars/actions/runs":
                return self.json_response(
                    {"total_count": 3, "workflow_runs": burst_runs},
                    headers=rate_headers,
                )
            if path.endswith("/jobs"):
                run_id = int(path.split("/")[-2])
                return self.json_response(
                    {
                        "total_count": 1,
                        "jobs": [
                            workflow_job(
                                id=1000 + run_id,
                                status="queued",
                                conclusion=None,
                                started_at=None,
                                completed_at=None,
                            )
                        ],
                    },
                    headers=rate_headers,
                )
            if path.endswith("/concurrency_groups"):
                concurrency_calls.append(path)
                run_id = int(path.split("/")[-2])
                return self.json_response(
                    {
                        "concurrency_groups": [
                            {
                                "group_name": f"group-{run_id}",
                                "group_members": [{"job_id": 1000 + run_id}],
                            }
                        ]
                    },
                    headers=rate_headers,
                )
            return self.json_response({}, status_code=404, headers=rate_headers)

        api.session.get = Mock(side_effect=burst_get)
        concurrency_calls.clear()
        self.advance(301)
        with patch.object(exporter, "CONCURRENCY_GROUPS_PER_CYCLE_LIMIT", 2):
            poller.refresh_repository("jlapenna/agent-lcars")

        self.assertEqual(len(concurrency_calls), 2)
        stored = {
            row["id"]: row["concurrency_group"]
            for row in self.database.rows(
                "SELECT id, concurrency_group FROM jobs WHERE id >= 1010"
            )
        }
        self.assertEqual(
            stored,
            {1010: "group-10", 1011: "group-11", 1012: "unknown"},
        )

    def test_saturated_concurrency_group_cap_preserves_confirmed_and_sentinels(self):
        repository = "jlapenna/agent-lcars"
        active_run = workflow_run(id=77, status="in_progress", conclusion=None)
        self.database.upsert_run(repository, active_run)

        # Seed sentinel rows first, reload from SQLite to prove _initialize_schema
        # does not count "none"/"unknown" against MAX_CONCURRENCY_GROUP_LABELS_PER_WORKFLOW,
        # then saturate all 100 dynamic slots (ci-pr-1 .. ci-pr-100).
        self.database.upsert_jobs(
            repository,
            active_run,
            [
                workflow_job(
                    id=900,
                    status="queued",
                    conclusion=None,
                    started_at=None,
                    completed_at=None,
                )
            ],
            [],
        )
        completed_seed = workflow_run(id=76)
        self.database.upsert_run(repository, completed_seed)
        self.database.upsert_jobs(
            repository, completed_seed, [workflow_job(id=901)], None
        )

        database_path = str(Path(self.temporary_directory.name) / "actions.db")
        self.database.close()
        self.database = exporter.Database(database_path)
        self.addCleanup(self.database.close)

        saturated_jobs = [
            workflow_job(
                id=idx,
                status="queued",
                conclusion=None,
                started_at=None,
                completed_at=None,
            )
            for idx in range(1, 101)
        ]
        saturated_groups = [
            {"group_name": f"ci-pr-{idx}", "group_members": [{"job_id": idx}]}
            for idx in range(1, 101)
        ]
        self.database.upsert_jobs(
            repository, active_run, saturated_jobs, saturated_groups
        )
        self.assertEqual(
            self.database.rows(
                "SELECT concurrency_group FROM jobs WHERE repository = ? AND id = 100",
                (repository,),
            )[0]["concurrency_group"],
            "ci-pr-100",
        )

        # Throttled/skipped optional poll (`groups=[]`) after cap saturation:
        # confirmed "ci-pr-1" stays "ci-pr-1" (not overwritten with "__other__")
        # and newly seen active job 200 gets "unknown" (not "__other__").
        self.database.upsert_jobs(
            repository,
            active_run,
            [
                workflow_job(
                    id=1,
                    status="in_progress",
                    conclusion=None,
                    started_at="2026-08-05T04:19:39Z",
                    completed_at=None,
                ),
                workflow_job(
                    id=200,
                    status="queued",
                    conclusion=None,
                    started_at=None,
                    completed_at=None,
                ),
            ],
            [],
        )
        # Explicit 101st dynamic group still maps to "__other__".
        self.database.upsert_jobs(
            repository,
            active_run,
            [
                workflow_job(
                    id=201,
                    status="queued",
                    conclusion=None,
                    started_at=None,
                    completed_at=None,
                )
            ],
            [{"group_name": "ci-pr-101", "group_members": [{"job_id": 201}]}],
        )
        active_groups = {
            row["id"]: row["concurrency_group"]
            for row in self.database.rows(
                "SELECT id, concurrency_group FROM jobs WHERE repository = ? AND id IN (1, 200, 201)",
                (repository,),
            )
        }
        self.assertEqual(
            active_groups,
            {1: "ci-pr-1", 200: "unknown", 201: "__other__"},
        )

        # Completion poll (`groups=None`) after cap saturation: confirmed "ci-pr-1"
        # stays "ci-pr-1", while unresolved/new completed jobs record "none" (not "__other__").
        completed_run = workflow_run(id=77)
        self.database.upsert_run(repository, completed_run)
        self.database.upsert_jobs(
            repository,
            completed_run,
            [
                workflow_job(id=1),
                workflow_job(id=200),
                workflow_job(id=202),
            ],
            None,
        )
        final_groups = {
            row["id"]: row["concurrency_group"]
            for row in self.database.rows(
                "SELECT id, concurrency_group FROM jobs WHERE repository = ? AND id IN (1, 200, 202)",
                (repository,),
            )
        }
        self.assertEqual(
            final_groups,
            {1: "ci-pr-1", 200: "none", 202: "none"},
        )

    def test_zero_remaining_200_with_skewed_or_missing_reset_applies_minimum_backoff(
        self,
    ):
        config = exporter.Config(
            credentials=exporter.StaticCredentials("test"),
            repositories=("jlapenna/homelab",),
        )
        api = exporter.GitHubAPI(
            config,
            exporter.ExporterState(CollectorRegistry()),
            clock=lambda: self.now_epoch,
            monotonic=lambda: self.now_monotonic,
        )
        self.addCleanup(api.close)
        api.session.get = Mock(
            side_effect=[
                self.json_response(
                    {"ok": True},
                    status_code=200,
                    headers={
                        "X-RateLimit-Remaining": "0",
                        "X-RateLimit-Reset": str(int(self.now_epoch - 10)),
                    },
                ),
                self.json_response({"ok": True}),
            ]
        )

        self.assertEqual(
            api.get("/repos/jlapenna/homelab/actions/runs", endpoint="runs"),
            {"ok": True},
        )
        self.advance(59)
        with self.assertRaises(exporter.GitHubRateLimitBackoffError):
            api.get("/repos/jlapenna/homelab/actions/runs", endpoint="runs")
        self.assertEqual(api.session.get.call_count, 1)

        self.advance(2)
        self.assertEqual(
            api.get("/repos/jlapenna/homelab/actions/runs", endpoint="runs"),
            {"ok": True},
        )
        self.assertEqual(api.session.get.call_count, 2)

    def test_503_retry_after_does_not_arm_owner_quota_backoff_unless_zero_remaining(
        self,
    ):
        repositories = ("jlapenna/agent-lcars", "jlapenna/homelab")
        registry = CollectorRegistry()
        state = exporter.ExporterState(registry)
        config = exporter.Config(
            credentials=exporter.StaticCredentials("test"),
            repositories=repositories,
        )
        api = exporter.GitHubAPI(
            config,
            state,
            clock=lambda: self.now_epoch,
            monotonic=lambda: self.now_monotonic,
        )
        self.addCleanup(api.close)
        poller = exporter.Poller(
            config,
            self.database,
            api,
            state,
            clock=lambda: self.now_epoch,
            monotonic=lambda: self.now_monotonic,
        )

        active_run = workflow_run(id=1, status="in_progress", conclusion=None)
        calls: list[str] = []

        def fake_get(url, *, params=None, timeout=None, headers=None):
            path = url.removeprefix(config.api_url)
            calls.append(path)
            rate_headers = {
                "X-RateLimit-Remaining": "4000",
                "X-RateLimit-Reset": str(int(self.now_epoch + 1800)),
            }
            if path == "/repos/jlapenna/agent-lcars/actions/runs":
                return self.json_response(
                    {"total_count": 1, "workflow_runs": [active_run]},
                    headers=rate_headers,
                )
            if path == "/repos/jlapenna/agent-lcars/actions/runs/1/jobs":
                return self.json_response(
                    {
                        "total_count": 1,
                        "jobs": [
                            workflow_job(
                                id=101,
                                status="queued",
                                conclusion=None,
                                started_at=None,
                                completed_at=None,
                            )
                        ],
                    },
                    headers=rate_headers,
                )
            if path == "/repos/jlapenna/agent-lcars/actions/runs/1/concurrency_groups":
                return self.json_response(
                    {"message": "Service Unavailable"},
                    status_code=503,
                    headers={**rate_headers, "Retry-After": "300"},
                )
            return self.json_response(
                {"total_count": 0, "workflow_runs": []},
                headers=rate_headers,
            )

        api.session.get = Mock(side_effect=fake_get)
        with self.assertLogs(exporter.LOGGER, level="WARNING"):
            poller.refresh_all()

        # Both jlapenna repositories completed their core refresh; the 503 on
        # optional concurrency_groups did not block homelab or record rate_limit.
        self.assertIn("/repos/jlapenna/homelab/actions/runs", calls)
        metrics = generate_latest(registry).decode()
        self.assertEqual(
            exported_metric_value(
                metrics,
                "github_actions_exporter_last_success_timestamp_seconds",
                '{repository="jlapenna/agent-lcars"}',
            ),
            self.now_epoch,
        )
        self.assertEqual(
            exported_metric_value(
                metrics,
                "github_actions_exporter_last_success_timestamp_seconds",
                '{repository="jlapenna/homelab"}',
            ),
            self.now_epoch,
        )
        self.assertEqual(
            exported_metric_value(
                metrics,
                "github_actions_exporter_poll_errors_total",
                '{repository="jlapenna/agent-lcars",stage="concurrency_groups"}',
            ),
            1.0,
        )
        self.assertNotIn('stage="rate_limit"', metrics)

        # Independent zero-quota handling still arms backoff even on a 503.
        api.session.get = Mock(
            return_value=self.json_response(
                {},
                status_code=503,
                headers={
                    "X-RateLimit-Remaining": "0",
                    "X-RateLimit-Reset": str(int(self.now_epoch + 120)),
                },
            )
        )
        with self.assertRaises(exporter.GitHubRequestError) as raised:
            api.get("/repos/jlapenna/homelab/actions/runs", endpoint="runs")
        self.assertTrue(raised.exception.rate_limited)
        with self.assertRaises(exporter.GitHubRateLimitBackoffError):
            api.get("/repos/jlapenna/homelab/actions/runs", endpoint="runs")

    def test_secondary_rate_limit_403_without_retry_after_backs_off_while_permission_403_does_not(
        self,
    ):
        config = exporter.Config(
            credentials=exporter.StaticCredentials("test"),
            repositories=("jlapenna/homelab",),
        )
        api = exporter.GitHubAPI(
            config,
            exporter.ExporterState(CollectorRegistry()),
            clock=lambda: self.now_epoch,
            monotonic=lambda: self.now_monotonic,
        )
        self.addCleanup(api.close)

        permission_403 = Mock(
            status_code=403,
            headers={
                "X-RateLimit-Remaining": "4000",
                "X-RateLimit-Reset": str(int(self.now_epoch + 2400)),
            },
        )
        permission_403.raise_for_status.side_effect = requests.HTTPError(
            "403", response=permission_403
        )
        permission_403.json.return_value = {
            "message": "Resource not accessible by integration",
            "documentation_url": "https://docs.github.com/rest/actions/workflow-runs",
        }

        secondary_403 = Mock(
            status_code=403,
            headers={
                "X-RateLimit-Remaining": "4000",
                "X-RateLimit-Reset": str(int(self.now_epoch + 2400)),
            },
        )
        secondary_403.raise_for_status.side_effect = requests.HTTPError(
            "403", response=secondary_403
        )
        secondary_403.json.return_value = {
            "message": (
                "You have exceeded a secondary rate limit. Please wait a few "
                "minutes before you try again."
            ),
            "documentation_url": (
                "https://docs.github.com/rest/overview/resources-in-the-rest-api"
                "#secondary-rate-limits"
            ),
        }

        api.session.get = Mock(
            side_effect=[
                permission_403,
                secondary_403,
                self.json_response({"ok": True}),
            ]
        )

        # Ordinary permission 403 is not rate-limited and leaves the owner unblocked.
        with self.assertRaises(exporter.GitHubRequestError) as perm_err:
            api.get("/repos/jlapenna/homelab/actions/runs", endpoint="runs")
        self.assertFalse(perm_err.exception.rate_limited)

        # Secondary-limit 403 without Retry-After is recognized and arms the 60s fallback.
        with self.assertRaises(exporter.GitHubRequestError) as sec_err:
            api.get("/repos/jlapenna/homelab/actions/runs", endpoint="runs")
        self.assertTrue(sec_err.exception.rate_limited)

        self.advance(59)
        with self.assertRaises(exporter.GitHubRateLimitBackoffError):
            api.get("/repos/jlapenna/homelab/actions/runs", endpoint="runs")
        self.assertEqual(api.session.get.call_count, 2)

        self.advance(2)
        self.assertEqual(
            api.get("/repos/jlapenna/homelab/actions/runs", endpoint="runs"),
            {"ok": True},
        )

    def test_rerun_probes_recheck_quota_reserve_per_probe_and_keep_deferred_order(
        self,
    ):
        repository = "jlapenna/agent-lcars"
        config = exporter.Config(
            credentials=exporter.StaticCredentials("test"),
            repositories=(repository,),
        )
        api = exporter.GitHubAPI(
            config,
            exporter.ExporterState(CollectorRegistry()),
            clock=lambda: self.now_epoch,
            monotonic=lambda: self.now_monotonic,
        )
        self.addCleanup(api.close)
        poller = exporter.Poller(
            config,
            self.database,
            api,
            exporter.ExporterState(CollectorRegistry()),
            clock=lambda: self.now_epoch,
            monotonic=lambda: self.now_monotonic,
        )

        # Seed 3 failed PR runs older than overlap (newest first: 503, 502, 501)
        # plus a core run-attempt gap (700 attempt 2 missing attempt 1).
        for offset_hours, run_id, branch in (
            (3, 501, "pr-1"),
            (2, 502, "pr-2"),
            (1, 503, "pr-3"),
        ):
            ts = datetime.fromtimestamp(
                self.now_epoch - offset_hours * 3600, UTC
            ).strftime("%Y-%m-%dT%H:%M:%SZ")
            pr_run = workflow_run(
                id=run_id,
                event="pull_request",
                conclusion="failure",
                head_branch=branch,
                created_at=ts,
                run_started_at=ts,
                updated_at=ts,
            )
            self.database.upsert_run(repository, pr_run)
            self.database.upsert_jobs(repository, pr_run, [])

        gap_ts = datetime.fromtimestamp(self.now_epoch - 3600, UTC).strftime(
            "%Y-%m-%dT%H:%M:%SZ"
        )
        gap_run = workflow_run(
            id=700,
            run_attempt=2,
            created_at=gap_ts,
            run_started_at=gap_ts,
            updated_at=gap_ts,
        )
        self.database.upsert_run(repository, gap_run)
        self.database.upsert_jobs(repository, gap_run, [])

        probed_reruns: list[int] = []
        attempt_calls: list[tuple[int, int]] = []
        remaining_values = iter(["500", "499", "498"])

        def first_cycle_get(url, *, params=None, timeout=None, headers=None):
            path = url.removeprefix(config.api_url)
            rate_headers = {
                "X-RateLimit-Remaining": next(remaining_values),
                "X-RateLimit-Reset": str(int(self.now_epoch + 1800)),
            }
            if path.endswith("/actions/runs"):
                return self.json_response(
                    {"total_count": 0, "workflow_runs": []}, headers=rate_headers
                )
            if "/attempts/" in path:
                parts = path.split("/")
                attempt_calls.append((int(parts[-3]), int(parts[-1])))
                return self.json_response(
                    workflow_run(
                        id=700,
                        run_attempt=1,
                        conclusion="failure",
                        created_at=gap_ts,
                        run_started_at=gap_ts,
                        updated_at=gap_ts,
                    ),
                    headers=rate_headers,
                )
            run_id = int(path.split("/")[-1])
            probed_reruns.append(run_id)
            return self.json_response({}, status_code=404, headers=rate_headers)

        api.session.get = Mock(side_effect=first_cycle_get)
        poller.refresh_repository(repository)

        # Probe 1 (503) dropped remaining to 499, halting 502 and 501 immediately
        # while still completing core attempt-gap collection.
        self.assertEqual(probed_reruns, [503])
        self.assertEqual(attempt_calls, [(700, 1)])

        # Once quota recovers, deferred 502 and 501 are probed ahead of 503.
        probed_reruns.clear()
        self.advance(60)

        def recovered_get(url, *, params=None, timeout=None, headers=None):
            path = url.removeprefix(config.api_url)
            rate_headers = {
                "X-RateLimit-Remaining": "5000",
                "X-RateLimit-Reset": str(int(self.now_epoch + 3600)),
            }
            if path.endswith("/actions/runs"):
                return self.json_response(
                    {"total_count": 0, "workflow_runs": []}, headers=rate_headers
                )
            run_id = int(path.split("/")[-1])
            probed_reruns.append(run_id)
            return self.json_response({}, status_code=404, headers=rate_headers)

        api.session.get = Mock(side_effect=recovered_get)
        poller.refresh_repository(repository)
        self.assertEqual(probed_reruns, [502, 501, 503])

    def test_failed_pr_rerun_probe_503_preserves_core_collection_and_five_minute_cooldown(
        self,
    ):
        repository = "jlapenna/agent-lcars"
        registry = CollectorRegistry()
        state = exporter.ExporterState(registry)
        config = exporter.Config(
            credentials=exporter.StaticCredentials("test"),
            repositories=(repository,),
        )
        api = exporter.GitHubAPI(
            config,
            state,
            clock=lambda: self.now_epoch,
            monotonic=lambda: self.now_monotonic,
        )
        self.addCleanup(api.close)
        poller = exporter.Poller(
            config,
            self.database,
            api,
            state,
            clock=lambda: self.now_epoch,
            monotonic=lambda: self.now_monotonic,
        )

        old_ts = datetime.fromtimestamp(self.now_epoch - 3600, UTC).strftime(
            "%Y-%m-%dT%H:%M:%SZ"
        )
        failed_pr = workflow_run(
            id=501,
            event="pull_request",
            conclusion="failure",
            head_branch="pr-1",
            created_at=old_ts,
            run_started_at=old_ts,
            updated_at=old_ts,
        )
        self.database.upsert_run(repository, failed_pr)
        self.database.upsert_jobs(repository, failed_pr, [])

        gap_run = workflow_run(
            id=700,
            run_attempt=2,
            created_at=old_ts,
            run_started_at=old_ts,
            updated_at=old_ts,
        )
        self.database.upsert_run(repository, gap_run)
        self.database.upsert_jobs(repository, gap_run, [])

        rerun_probes: list[int] = []
        attempt_repairs: list[tuple[int, int]] = []

        def fake_get(url, *, params=None, timeout=None, headers=None):
            path = url.removeprefix(config.api_url)
            rate_headers = {
                "X-RateLimit-Remaining": "4000",
                "X-RateLimit-Reset": str(int(self.now_epoch + 1800)),
            }
            if path.endswith("/actions/runs"):
                return self.json_response(
                    {"total_count": 0, "workflow_runs": []}, headers=rate_headers
                )
            if "/attempts/" in path:
                parts = path.split("/")
                attempt_repairs.append((int(parts[-3]), int(parts[-1])))
                return self.json_response(
                    workflow_run(
                        id=700,
                        run_attempt=1,
                        conclusion="failure",
                        created_at=old_ts,
                        run_started_at=old_ts,
                        updated_at=old_ts,
                    ),
                    headers=rate_headers,
                )
            run_id = int(path.split("/")[-1])
            rerun_probes.append(run_id)
            return self.json_response(
                {"message": "Service Unavailable"},
                status_code=503,
                headers=rate_headers,
            )

        api.session.get = Mock(side_effect=fake_get)

        # Across five 60-second polls, the optional rerun 503 never aborts core
        # attempt-gap repair or freshness, and respects the 5-minute cooldown.
        for poll_index in range(5):
            if poll_index > 0:
                self.advance(60)
            if poll_index == 0:
                with self.assertLogs(exporter.LOGGER, level="WARNING"):
                    poller.refresh_all()
            else:
                poller.refresh_all()
            metrics = generate_latest(registry).decode()
            self.assertEqual(
                exported_metric_value(
                    metrics,
                    "github_actions_exporter_last_success_timestamp_seconds",
                    f'{{repository="{repository}"}}',
                ),
                self.now_epoch,
            )

        self.assertEqual(attempt_repairs, [(700, 1)])
        self.assertEqual(rerun_probes, [501])
        metrics = generate_latest(registry).decode()
        self.assertEqual(
            exported_metric_value(
                metrics,
                "github_actions_exporter_poll_errors_total",
                f'{{repository="{repository}",stage="pull_request_recheck"}}',
            ),
            1.0,
        )

        # Once the 5-minute cooldown elapses, the candidate is probed again.
        self.advance(61)
        with self.assertLogs(exporter.LOGGER, level="WARNING"):
            poller.refresh_all()
        self.assertEqual(rerun_probes, [501, 501])

    def test_later_same_owner_repository_gets_fair_and_rotating_concurrency_group_share(
        self,
    ):
        repositories = ("jlapenna/busy-repo", "jlapenna/later-repo")
        config = exporter.Config(
            credentials=exporter.StaticCredentials("test"),
            repositories=repositories,
        )
        api = exporter.GitHubAPI(
            config,
            exporter.ExporterState(CollectorRegistry()),
            clock=lambda: self.now_epoch,
            monotonic=lambda: self.now_monotonic,
        )
        self.addCleanup(api.close)
        poller = exporter.Poller(
            config,
            self.database,
            api,
            exporter.ExporterState(CollectorRegistry()),
            clock=lambda: self.now_epoch,
            monotonic=lambda: self.now_monotonic,
        )

        busy_runs = [
            workflow_run(id=100 + idx, status="in_progress", conclusion=None)
            for idx in range(20)
        ]
        later_runs = [
            workflow_run(id=300 + idx, status="in_progress", conclusion=None)
            for idx in range(2)
        ]
        group_calls_by_repo: dict[str, list[int]] = {
            "jlapenna/busy-repo": [],
            "jlapenna/later-repo": [],
        }

        def fair_get(url, *, params=None, timeout=None, headers=None):
            path = url.removeprefix(config.api_url)
            rate_headers = {
                "X-RateLimit-Remaining": "4000",
                "X-RateLimit-Reset": str(int(self.now_epoch + 1800)),
            }
            repo = "/".join(path.split("/")[2:4])
            if path.endswith("/actions/runs"):
                runs = busy_runs if repo == "jlapenna/busy-repo" else later_runs
                return self.json_response(
                    {"total_count": len(runs), "workflow_runs": runs},
                    headers=rate_headers,
                )
            if path.endswith("/jobs"):
                run_id = int(path.split("/")[-2])
                return self.json_response(
                    {
                        "total_count": 1,
                        "jobs": [
                            workflow_job(
                                id=run_id * 10,
                                status="queued",
                                conclusion=None,
                                started_at=None,
                                completed_at=None,
                            )
                        ],
                    },
                    headers=rate_headers,
                )
            if path.endswith("/concurrency_groups"):
                run_id = int(path.split("/")[-2])
                group_calls_by_repo[repo].append(run_id)
                return self.json_response(
                    {
                        "concurrency_groups": [
                            {
                                "group_name": f"cg-{run_id}",
                                "group_members": [{"job_id": run_id * 10}],
                            }
                        ]
                    },
                    headers=rate_headers,
                )
            return self.json_response({}, status_code=404, headers=rate_headers)

        api.session.get = Mock(side_effect=fair_get)
        poller.refresh_all()

        # busy-repo gets its 10-slot share rather than all 20, so later-repo
        # resolves both of its active runs on the very first cycle.
        self.assertEqual(len(group_calls_by_repo["jlapenna/busy-repo"]), 10)
        self.assertEqual(group_calls_by_repo["jlapenna/later-repo"], [300, 301])

        # With limit=1 across 2 repositories, remainder priority rotates each
        # cycle so later-repo gets the slot on the second cycle even while busy-repo
        # still has unresolved active runs.
        group_calls_by_repo["jlapenna/busy-repo"].clear()
        group_calls_by_repo["jlapenna/later-repo"].clear()
        later_runs.append(workflow_run(id=302, status="in_progress", conclusion=None))
        self.advance(60)
        with patch.object(exporter, "CONCURRENCY_GROUPS_PER_CYCLE_LIMIT", 1):
            poller.refresh_all()
            self.assertEqual(len(group_calls_by_repo["jlapenna/busy-repo"]), 0)
            self.assertEqual(group_calls_by_repo["jlapenna/later-repo"], [302])

    def test_concurrency_group_slots_reach_oldest_active_run_before_repeats(self):
        repository = "jlapenna/busy-repo"
        config = exporter.Config(
            credentials=exporter.StaticCredentials("test"),
            repositories=(repository,),
        )
        api = exporter.GitHubAPI(
            config,
            exporter.ExporterState(CollectorRegistry()),
            clock=lambda: self.now_epoch,
            monotonic=lambda: self.now_monotonic,
        )
        self.addCleanup(api.close)
        poller = exporter.Poller(
            config,
            self.database,
            api,
            exporter.ExporterState(CollectorRegistry()),
            clock=lambda: self.now_epoch,
            monotonic=lambda: self.now_monotonic,
        )
        # 101 active runs listed newest-first, more than five polls of slots.
        runs = [
            workflow_run(id=1000 - idx, status="in_progress", conclusion=None)
            for idx in range(101)
        ]
        oldest = runs[-1]["id"]
        probed: list[int] = []

        def busy_get(url, *, params=None, timeout=None, headers=None):
            path = url.removeprefix(config.api_url)
            rate_headers = {
                "X-RateLimit-Remaining": "4000",
                "X-RateLimit-Reset": str(int(self.now_epoch + 1800)),
            }
            if path.endswith("/actions/runs"):
                return self.json_response(
                    {"total_count": len(runs), "workflow_runs": runs},
                    headers=rate_headers,
                )
            run_id = int(path.split("/")[-2])
            if path.endswith("/jobs"):
                return self.json_response(
                    {
                        "total_count": 1,
                        "jobs": [
                            workflow_job(
                                id=run_id * 10,
                                status="queued",
                                conclusion=None,
                                started_at=None,
                                completed_at=None,
                            )
                        ],
                    },
                    headers=rate_headers,
                )
            if path.endswith("/concurrency_groups"):
                probed.append(run_id)
                return self.json_response(
                    {
                        "concurrency_groups": [
                            {
                                "group_name": "ci-main",
                                "group_members": [{"job_id": run_id * 10}],
                            }
                        ]
                    },
                    headers=rate_headers,
                )
            return self.json_response({}, status_code=404, headers=rate_headers)

        api.session.get = Mock(side_effect=busy_get)
        per_poll: list[list[int]] = []
        for _ in range(12):
            probed.clear()
            poller.refresh_all()
            per_poll.append(list(probed))
            self.advance(60)

        self.assertTrue(all(len(calls) == 20 for calls in per_poll))
        # Every active run gets a lookup before any run repeats one: the
        # oldest is reached by the sixth one-minute poll, not starved by the
        # newest runs whose five-minute timers keep expiring first.
        first_five = [run_id for calls in per_poll[:5] for run_id in calls]
        self.assertEqual(len(set(first_five)), 100)
        self.assertNotIn(oldest, first_five)
        self.assertIn(oldest, per_poll[5])
        rows = self.database.connection.execute(
            "SELECT concurrency_group FROM jobs WHERE id = ?", (oldest * 10,)
        ).fetchall()
        self.assertEqual([row["concurrency_group"] for row in rows], ["ci-main"])

    def test_fresh_low_remaining_without_reset_header_respects_optional_reserve(
        self,
    ):
        config = exporter.Config(
            credentials=exporter.StaticCredentials("test"),
            repositories=("jlapenna/homelab",),
        )
        api = exporter.GitHubAPI(
            config,
            exporter.ExporterState(CollectorRegistry()),
            clock=lambda: self.now_epoch,
            monotonic=lambda: self.now_monotonic,
        )
        self.addCleanup(api.close)
        path = "/repos/jlapenna/homelab/actions/runs"
        api.session.get = Mock(
            side_effect=[
                self.json_response(
                    {"ok": True},
                    headers={
                        "x-ratelimit-remaining": "4000",
                        "x-ratelimit-reset": str(int(self.now_epoch + 60)),
                    },
                ),
                # The old window has reset; the next count is fresh and low
                # but its reset header is missing or malformed.
                self.json_response(
                    {"ok": True}, headers={"x-ratelimit-remaining": "499"}
                ),
                self.json_response(
                    {"ok": True},
                    headers={
                        "x-ratelimit-remaining": "499",
                        "x-ratelimit-reset": "not-a-number",
                    },
                ),
            ]
        )
        api.get(path, endpoint="runs")
        self.assertTrue(api.has_optional_quota("jlapenna"))
        self.advance(120)
        api.get(path, endpoint="runs")
        self.assertFalse(api.has_optional_quota("jlapenna"))
        api.get(path, endpoint="runs")
        self.assertFalse(api.has_optional_quota("jlapenna"))


class InstallationReinstallTests(unittest.TestCase):
    """A reinstall issues a new installation id; the process can outlive it."""

    def setUp(self):
        self.pem = _test_private_key_pem()

    def credentials(self):
        return exporter.AppCredentials("Iv23test", self.pem, "https://api.github.com")

    @staticmethod
    def expiry(seconds_ahead):
        moment = datetime.now(UTC) + timedelta(seconds=seconds_ahead)
        return moment.isoformat().replace("+00:00", "Z")

    def test_a_stale_installation_id_is_looked_up_again(self):
        credentials = self.credentials()
        installation_ids = [1, 2]
        posts = []

        def request(method, path, bearer):
            if method == "GET":
                return {"id": installation_ids[0]}
            posts.append(path)
            if path == "/app/installations/1/access_tokens":
                raise requests_error(404)
            return {"token": "fresh", "expires_at": self.expiry(3600)}

        with patch.object(credentials, "_request", side_effect=request):
            credentials._installations["jlapenna"] = 1
            installation_ids[0] = 2
            header = credentials.authorization("jlapenna")

        self.assertEqual(header, "Bearer fresh")
        self.assertEqual(
            posts,
            [
                "/app/installations/1/access_tokens",
                "/app/installations/2/access_tokens",
            ],
        )

    def test_a_genuinely_broken_app_is_not_retried_forever(self):
        # One re-lookup, then the error propagates: a tight retry loop against
        # a dead App would burn quota and hide the real failure.
        credentials = self.credentials()
        attempts = []

        def request(method, path, bearer):
            if method == "GET":
                return {"id": 1}
            attempts.append(path)
            raise requests_error(404)

        with (
            patch.object(credentials, "_request", side_effect=request),
            self.assertRaises(requests.HTTPError),
        ):
            credentials.authorization("jlapenna")

        self.assertEqual(len(attempts), 2)

import importlib.util
import os
import sys
import tempfile
import unittest
from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest.mock import MagicMock, Mock, patch

from prometheus_client import CollectorRegistry, generate_latest

MODULE_PATH = Path(__file__).parents[1] / "exporter.py"
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
        self.backfill_in_progress = self.Metric()


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
            'github_actions_jobs_total{conclusion="success",job="repository validation",repository="jlapenna/homelab",runner_group="Default",workflow="validate"} 1.0',
            metrics,
        )
        self.assertIn(
            'github_actions_job_queue_duration_seconds_sum{job="repository validation",repository="jlapenna/homelab",runner_group="Default",workflow="validate"} 15.0',
            metrics,
        )
        self.assertIn(
            'github_actions_job_duration_seconds_sum{job="repository validation",repository="jlapenna/homelab",runner_group="Default",workflow="validate"} 30.0',
            metrics,
        )

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
            token="test",
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
        api = Mock()
        api.list_runs.return_value = []
        api.get_run_attempt.return_value = earlier
        poller = exporter.Poller(
            exporter.Config(token="test", repositories=(repository,)),
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
            'github_actions_jobs_current{job="repository validation",repository="jlapenna/homelab",runner_group="Default",status="queued",workflow="validate"} 1.0',
            metrics,
        )
        self.assertIn("github_actions_job_oldest_queued_seconds", metrics)

    def test_failed_initial_backfill_is_retried(self):
        class FailingAPI(FakeAPI):
            def list_jobs(self, _repository, _run_id):
                raise RuntimeError("temporary GitHub failure")

        run = workflow_run()
        config = exporter.Config(token="test", repositories=("jlapenna/homelab",))
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
            exporter.Config(token="test", repositories=(repository,)),
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

    def test_active_run_server_error_still_fails_repository_refresh(self):
        repository = "jlapenna/homelab"
        run = workflow_run(status="in_progress", conclusion=None)
        self.database.upsert_run(repository, run)
        response = Mock(status_code=500, headers={})
        api = Mock()
        api.list_runs.return_value = []
        api.get_run.side_effect = exporter.GitHubRequestError("run", response)
        poller = exporter.Poller(
            exporter.Config(token="test", repositories=(repository,)),
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
            token="test",
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
            exporter.Config(token="test", repositories=("jlapenna/homelab",)),
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
            exporter.Config(token="test", repositories=("jlapenna/homelab",)),
            FakeState(),
        )
        self.addCleanup(self.api.close)

    def test_invalid_rate_limit_headers_do_not_replace_last_valid_value(self):
        registry = CollectorRegistry()
        state = exporter.ExporterState(registry)
        state.record_response(
            "test", Mock(status_code=200, headers={"x-ratelimit-remaining": "42"})
        )

        for value in ("nan", "inf", "1.5", "-1"):
            with self.subTest(value=value):
                state.record_response(
                    "test",
                    Mock(status_code=200, headers={"x-ratelimit-remaining": value}),
                )
                self.assertIn(
                    "github_actions_exporter_api_rate_limit_remaining 42.0",
                    generate_latest(registry).decode(),
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

        self.assertEqual(self.api.get("/test", endpoint="test"), {"ok": True})

        response.close.assert_called_once_with()

    def test_http_response_is_closed_after_failure(self):
        response = Mock(status_code=500, headers={})
        response.raise_for_status.side_effect = exporter.requests.HTTPError("failed")
        self.api.state = Mock()
        self.api.session.get = Mock(return_value=response)

        with self.assertRaises(exporter.GitHubRequestError) as raised:
            self.api.get("/test", endpoint="test")

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
        api = Mock()
        config = exporter.Config(token="test", repositories=("jlapenna/homelab",))

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
        api = Mock()
        poller = Mock()
        poller.run_forever.side_effect = RuntimeError("polling stopped")
        http_server = Mock()
        http_thread = Mock()
        config = exporter.Config(token="test", repositories=("jlapenna/homelab",))

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


if __name__ == "__main__":
    unittest.main()

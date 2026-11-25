# GitHub Actions metrics exporter

Consumes the GitHub App's `workflow_run` and `workflow_job` webhook events from
a Pub/Sub subscription, stores run attempts and jobs in SQLite, and exposes
low-cardinality Prometheus metrics for CI outcomes, queue time, and execution
time. It makes no GitHub API calls.

The exporter intentionally does **not** use run IDs, commit SHAs, branches,
dynamic run names, or ephemeral runner names as Prometheus labels. Those
values grow without bound and would turn a useful CI dashboard into a
high-cardinality time-series store. Workflows use their stable YAML filename;
job labels are capped at 100 distinct values per repository/workflow and any
additional dynamic names are grouped under `__other__`.

SQLite retains each job's raw `runner_name` for future offline correlation with
the matching cAdvisor container series. It remains local durable data and is
never exposed as a Prometheus label. Collection begins when a runner name is
first observed. Legacy rows stay empty unless a later event for the job
carries one; no historical backfill is added.

Jobs may opt into full-suite performance tracking by adding the literal
`[full-suite]` marker to the step that runs the suite. Completed jobs export
one of three bounded `execution` values: `full_suite` when that step ran,
`short_circuit` when it was skipped, and `unknown` for jobs without the marker
or legacy rows collected before this dimension existed. The dimension is
available on completed-job counts and duration/queue histograms. Queue
histograms intentionally include completed jobs only, so a job cannot move
between `unknown` and its final execution series while it is running.

## How events arrive

1. The `agent-lcars` GitHub App is subscribed to `workflow_run` and
   `workflow_job`. GitHub delivers both to the Agent LCARS console's webhook
   route, which verifies the signature.
2. The console publishes each verified delivery's raw body to the Pub/Sub topic
   `github-actions-events`, with attributes `event`, `delivery_id` and
   `repository` (`owner/name`). It forwards every repository the App is
   installed on.
3. This exporter holds a streaming pull on the subscription named by
   `GITHUB_ACTIONS_EVENTS_SUBSCRIPTION`. The homelab has no public inbound
   path; the exporter only makes outbound connections to Pub/Sub.

The subscription retains unacknowledged messages for seven days, which covers
an exporter outage. A delivery the console never received is recovered with
GitHub's webhook redelivery, not by polling.

Each message is handled like this:

- A repository not listed in `GITHUB_REPOSITORIES` is acknowledged and ignored.
- A `workflow_run` body stores `workflow_run` as one run attempt. A
  `workflow_job` body stores `workflow_job` as one job. A rerun is a new
  attempt with its own events and job ids, so every attempt's outcome is kept.
- The message is acknowledged only after the SQLite write commits. An
  unexpected failure is negatively acknowledged so Pub/Sub redelivers it.
- A body that can never be stored (not JSON, an unknown event, missing ids,
  unparseable timestamps) is acknowledged and counted as `malformed`, so it
  cannot be redelivered forever.

Pub/Sub delivers at least once and in no particular order, so every write is
an idempotent upsert that never moves backwards:

- Statuses progress `requested`/`pending`/`waiting`/`queued`, then
  `in_progress`, then `completed`. An event replaces the stored row only if its
  status has progressed at least as far. At an equal run status the event's
  `updated_at` must not be older. A late `in_progress` event cannot undo a
  completion.
- A newer attempt marks an older attempt that is still active as `superseded`.
- An active job whose run attempt has finished is stored as `orphaned` and is
  neither current nor queued. Its own completion event replaces that status
  when it arrives, so its outcome is still counted.
- A `workflow_job` payload names no workflow file, and the workflow label is
  the run's workflow filename. A job that arrives before any attempt of its
  run waits in the `pending_jobs` table. It is labelled and stored when its
  run's first `workflow_run` event arrives, and is not exported until then.

Concurrency-group membership is not in any webhook, so the exporter no longer
reports it.

## Why Agent LCARS owns a dedicated exporter

ARC's built-in `gha_*` listener metrics already cover self-hosted runner and
job timing. This exporter covers what they do not: workflow- and branch-level
outcomes and the alerts built on them (consecutive main-line failures,
pull-request failures across branches), and GitHub-hosted runs, which no ARC
listener sees.

Existing exporters do not fit that contract. The
[Labbs exporter](https://github.com/Labbs/github-actions-exporter) polls,
models individual runs as gauges, and defaults to labels such as commit SHA,
branch, node ID, and run number. Other webhook exporters need public inbound
delivery, which the homelab does not have. The larger
[github-metrics](https://github.com/github-insights/github-metrics) service
exports rolling daily aggregates rather than durable counters and queue-time
histograms. This one combines webhook events delivered over outbound Pub/Sub,
explicit repositories, restart-safe history, bounded labels, current queue
gauges, and cumulative Prometheus counters and histograms in one small
process.

The source and published image live in Agent LCARS because this repository
already owns the GitHub Actions runner platform, the GitHub App, the webhook
route, and the image release path. It remains a separate process from the
telemetry watcher and autoscaler: a metrics outage must not interrupt
transcript ingestion or runner scheduling, and exporter-only changes must not
rebuild either service. The homelab repo owns only the deployment, the
subscriber credential, the durable SQLite volume, Prometheus scrape, alerts,
and dashboard.

## Configuration

| Environment variable                 | Default                                       | Purpose                                                                    |
| ------------------------------------ | --------------------------------------------- | -------------------------------------------------------------------------- |
| `GITHUB_ACTIONS_EVENTS_SUBSCRIPTION` | required                                      | Full Pub/Sub subscription path, `projects/<project>/subscriptions/<name>`. |
| `GOOGLE_APPLICATION_CREDENTIALS`     | required                                      | Path to the subscriber service account's key file, mounted read-only.      |
| `GITHUB_REPOSITORIES`                | required                                      | Comma-separated `owner/repository` list; events for others are ignored.    |
| `DATABASE_PATH`                      | `/var/lib/github-actions-exporter/actions.db` | Durable SQLite database.                                                   |
| `PORT`                               | `9102`                                        | Prometheus HTTP port.                                                      |
| `LOG_LEVEL`                          | `INFO`                                        | Python logging level.                                                      |

The subscriber service account needs only `roles/pubsub.subscriber` on the
subscription. Terraform owns the topic, subscription and account.

If the streaming pull stops (the client library retries transient errors
itself, so this means an error it gave up on, such as a revoked key or a
deleted subscription), the exporter logs it, sets
`github_actions_exporter_subscription_running` to 0, and reopens the stream
after 1s, doubling to at most 60s. The delay starts again at 1s once a stream
has stayed open for five minutes.

## HTTP endpoints

| Path       | Cost                      | Purpose                                     |
| ---------- | ------------------------- | ------------------------------------------- |
| `/metrics` | Renders the last snapshot | Prometheus scrape target.                   |
| `/healthz` | Constant                  | Container liveness probe; returns `200 ok`. |

`/metrics` runs no SQL. The history aggregations scan every stored run and job,
which reached about 5s per scrape at 130k runs and pushed scrapes past
Prometheus's 10s timeout (homelab#2653). The consumer therefore rebuilds a
snapshot at most every 30 seconds after a new event is stored, and scrapes
render it. Queue ages are still computed at scrape time. A snapshot query
failure exits the process (Docker restarts it; a persistent failure shows as
`up=0`) rather than serving stale history silently.

Point container healthchecks at `/healthz`, never at `/metrics`. prometheus_client
serves the metrics payload on _every_ GET path for backwards compatibility, so a
probe aimed anywhere else renders and discards the whole registry -- 3.4 MB and
2.6-3.6s per probe when homelab#1204 was filed, and growing with the number of
tracked runs. That is what made a 2s probe fail permanently while Prometheus was
scraping the same exporter successfully. `/healthz` proves only that the HTTP
server is answering. The event stream's health is exported as metrics and
alerted on there:

- `github_actions_exporter_subscription_running` is 1 while the streaming pull
  is open.
- `github_actions_exporter_last_event_timestamp_seconds{repository}` is when an
  event for that repository was last stored. It is persisted, so it survives a
  restart. A repository with no CI activity simply ages; that is idle, not a
  failure. Judge failure by the subscription gauge and the message counters.
- `github_actions_exporter_messages_total{event,outcome}` counts handled
  messages.

## Metrics

History families are rebuilt from SQLite after new events; counters carry the
`_total` suffix and histograms the usual `_bucket`/`_sum`/`_count` series.

| Metric                                                  | Type      | Labels                                                                     | Meaning                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------- | --------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `github_actions_workflow_runs_total`                    | counter   | `repository`, `workflow`, `event`, `conclusion`                            | Completed workflow runs.                                                                                                                                                                                                                                                                   |
| `github_actions_workflow_runs_current`                  | gauge     | `repository`, `workflow`, `status`                                         | Active workflow runs.                                                                                                                                                                                                                                                                      |
| `github_actions_jobs_total`                             | counter   | `repository`, `workflow`, `job`, `conclusion`, `runner_group`, `execution` | Completed jobs.                                                                                                                                                                                                                                                                            |
| `github_actions_jobs_current`                           | gauge     | `repository`, `workflow`, `job`, `status`, `runner_group`, `runs_on`       | Active jobs.                                                                                                                                                                                                                                                                               |
| `github_actions_job_oldest_queued_seconds`              | gauge     | `repository`, `workflow`, `job`, `runs_on`                                 | Age of the oldest queued job, computed at scrape time; `runs_on` is empty for hosted jobs.                                                                                                                                                                                                 |
| `github_actions_workflow_duration_seconds`              | histogram | `repository`, `workflow`, `event`                                          | Run creation to completion.                                                                                                                                                                                                                                                                |
| `github_actions_workflow_queue_duration_seconds`        | histogram | `repository`, `workflow`, `event`                                          | Run creation to start.                                                                                                                                                                                                                                                                     |
| `github_actions_job_duration_seconds`                   | histogram | `repository`, `workflow`, `job`, `runner_group`, `execution`               | Completed-job start to completion.                                                                                                                                                                                                                                                         |
| `github_actions_job_queue_duration_seconds`             | histogram | `repository`, `workflow`, `job`, `runner_group`, `execution`               | Completed-job creation to start.                                                                                                                                                                                                                                                           |
| `github_actions_workflow_consecutive_failures`          | gauge     | `repository`, `workflow`                                                   | Newest decisive non-`pull_request` runs in the rolling window that did not succeed; 0 after a success. Cancelled and skipped runs neither extend nor break the streak.                                                                                                                     |
| `github_actions_workflow_consecutive_failures_complete` | gauge     | `repository`, `workflow`                                                   | 1 when a success inside the window bounds the count (or it is 0); 0 when decisive failures remain in the window and no success bounds the streak, even if an older success is stored. When a workflow's last decisive run ages out of the window, neither streak series is emitted for it. |
| `github_actions_workflow_pull_request_failing_branches` | gauge     | `repository`, `workflow`                                                   | See [Pull-request failures](#pull-request-failures).                                                                                                                                                                                                                                       |
| `github_actions_exporter_subscription_running`          | gauge     |                                                                            | 1 while the Pub/Sub streaming pull is open; 0 while it waits to reopen.                                                                                                                                                                                                                    |
| `github_actions_exporter_subscription_failures_total`   | counter   |                                                                            | Times the streaming pull stopped and was reopened.                                                                                                                                                                                                                                         |
| `github_actions_exporter_last_event_timestamp_seconds`  | gauge     | `repository`                                                               | When an event for the repository was last stored; 0 if never. Idle repositories age without failing.                                                                                                                                                                                       |
| `github_actions_exporter_messages_total`                | counter   | `event`, `outcome`                                                         | Messages handled. `event` is `workflow_run`, `workflow_job` or `unknown`; `outcome` is `stored`, `ignored_repository`, `malformed` or `error` (negatively acknowledged for redelivery).                                                                                                    |

## Pull-request failures

`github_actions_workflow_consecutive_failures` skips `pull_request` runs,
because one pull request with a broken change fails on every push.
`github_actions_workflow_pull_request_failing_branches` covers them by counting
pull requests instead of runs: the distinct head branches among a workflow's
newest `pull_request` runs that failed, back to the first success, inside the
same three-day window. Two or more means the workflow or its runner is failing
across pull requests (homelab#3509). The branch name is stored to tell pull
requests apart and is never exported.

Runs are ordered by when the attempt started, not when the run was created: a
rerun keeps its run's `created_at`. A rerun arrives as `workflow_run` events for
a new attempt, so one that passes after the runner is repaired clears the
count as soon as it completes.

## Full-suite performance queries

Agent LCARS marks the real console browser step in `Console E2E browser suite`,
while retaining `E2E` as its
required GitHub status context. The following selectors exclude unaffected-PR
short circuits and unassigned runner-label migration. Use `[14d]` in place of
`[7d]` for the longer dashboard window.

Full-suite execution p50 and p95 use the same histogram with quantiles `0.50`
and `0.95`:

```promql
histogram_quantile(
  0.95,
  sum by (le) (
    increase(github_actions_job_duration_seconds_bucket{
      repository="jlapenna/agent-lcars",
      workflow="ci",
      job=~"E2E|Console E2E browser suite",
      runner_group="Default",
      execution="full_suite"
    }[7d])
  )
)
```

Full-suite queue p95 is deliberately separate from execution time:

```promql
histogram_quantile(
  0.95,
  sum by (le) (
    increase(github_actions_job_queue_duration_seconds_bucket{
      repository="jlapenna/agent-lcars",
      workflow="ci",
      job=~"E2E|Console E2E browser suite",
      runner_group="Default",
      execution="full_suite"
    }[7d])
  )
)
```

Full-suite execution mean uses the histogram sum and count:

```promql
sum(increase(github_actions_job_duration_seconds_sum{
  repository="jlapenna/agent-lcars",
  workflow="ci",
  job=~"E2E|Console E2E browser suite",
  runner_group="Default",
  execution="full_suite"
}[7d]))
/
sum(increase(github_actions_job_duration_seconds_count{
  repository="jlapenna/agent-lcars",
  workflow="ci",
  job=~"E2E|Console E2E browser suite",
  runner_group="Default",
  execution="full_suite"
}[7d]))
```

Always pair percentiles with the sample count:

```promql
sum(increase(github_actions_job_duration_seconds_count{
  repository="jlapenna/agent-lcars",
  workflow="ci",
  job=~"E2E|Console E2E browser suite",
  runner_group="Default",
  execution="full_suite"
}[7d]))
```

Completed full-suite success rate:

```promql
sum(increase(github_actions_jobs_total{
  repository="jlapenna/agent-lcars",
  workflow="ci",
  job=~"E2E|Console E2E browser suite",
  runner_group="Default",
  execution="full_suite",
  conclusion="success"
}[7d]))
/
sum(increase(github_actions_jobs_total{
  repository="jlapenna/agent-lcars",
  workflow="ci",
  job=~"E2E|Console E2E browser suite",
  runner_group="Default",
  execution="full_suite"
}[7d]))
```

Compare p50, mean, and p95 after at least 20 full-suite samples or 14 days,
whichever is later. Treat execution and queue regressions independently;
investigate sustained execution p95 above 11 minutes or queue p95 above two
minutes. The five-run pre-change baseline is recorded in Agent LCARS issue
`#1474`.

## Verification

```sh
uv run --no-project --no-env-file --with-requirements requirements.lock --with ruff==0.16.1 ruff check exporter.py tests
uv run --no-project --no-env-file --with-requirements requirements.lock --with ruff==0.16.1 ruff format --check exporter.py tests
uv run --no-project --no-env-file --with-requirements requirements.lock python -W error::ResourceWarning -m unittest discover -s tests -v
docker build -t agent-lcars-github-actions-exporter:local .
```

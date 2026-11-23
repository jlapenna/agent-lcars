# GitHub Actions metrics exporter

Polls GitHub's workflow-runs and workflow-jobs REST endpoints, deduplicates
run attempts and jobs in SQLite, and exposes low-cardinality Prometheus metrics
for CI outcomes, queue time, and execution time.

The exporter intentionally does **not** use run IDs, commit SHAs, branches,
dynamic run names, or ephemeral runner names as Prometheus labels. Those
values grow without bound and would turn a useful CI dashboard into a
high-cardinality time-series store. Workflows use their stable YAML filename;
job labels are capped at 100 distinct values per repository/workflow and any
additional dynamic names are grouped under `__other__`.

SQLite retains each job's raw `runner_name` for future offline correlation with
the matching cAdvisor container series. It remains local durable data and is
never exposed as a Prometheus label. Collection begins when a runner name is
first observed. Legacy rows stay empty unless normal polling observes them
again; no dedicated historical backfill is added.

Jobs may opt into full-suite performance tracking by adding the literal
`[full-suite]` marker to the step that runs the suite. Completed jobs export
one of three bounded `execution` values: `full_suite` when that step ran,
`short_circuit` when it was skipped, and `unknown` for jobs without the marker
or legacy rows collected before this dimension existed. The dimension is
available on completed-job counts and duration/queue histograms. Queue
histograms intentionally include completed jobs only, so a job cannot move
between `unknown` and its final execution series while it is running.

## Why Agent LCARS owns a dedicated exporter

Existing projects cover adjacent use cases but not this deployment's contract.
The polling-based [Labbs exporter](https://github.com/Labbs/github-actions-exporter)
models individual runs as gauges and defaults to labels such as commit SHA,
branch, node ID, and run number. Webhook-based exporters require public inbound
delivery and do not backfill missed events. The larger
[github-metrics](https://github.com/github-insights/github-metrics) service
exports rolling daily aggregates rather than durable counters and queue-time
histograms.

This implementation stays dedicated because it combines read-only outbound
polling, explicit repositories, restart-safe history, bounded labels, current
queue gauges, and cumulative Prometheus counters/histograms in one small
process. Re-evaluate this choice if a maintained exporter provides that same
contract without inbound webhook infrastructure.

The source and published image live in Agent LCARS because this repository
already owns the GitHub Actions runner platform and its image release path.
It remains a separate process from the telemetry watcher and autoscaler: a
metrics outage must not interrupt transcript ingestion or runner scheduling,
and exporter-only changes must not rebuild either service. The homelab repo
owns only the deployment, durable SQLite volume, Prometheus scrape, alerts,
and dashboard.

## Configuration

| Environment variable          | Default                                       | Purpose                                                        |
| ----------------------------- | --------------------------------------------- | -------------------------------------------------------------- |
| `GITHUB_APP_CLIENT_ID`        | preferred                                     | GitHub App client id. Set together with the private key below. |
| `GITHUB_APP_PRIVATE_KEY_FILE` | preferred                                     | Path to the App's PEM private key, mounted read-only.          |
| `GITHUB_TOKEN`                | fallback                                      | Personal access token. Used only when no App is configured.    |
| `GITHUB_REPOSITORIES`         | required                                      | Comma-separated `owner/repository` list.                       |
| `GITHUB_API_URL`              | `https://api.github.com`                      | GitHub API root.                                               |
| `GITHUB_API_VERSION`          | `2022-11-28`                                  | Version sent in `X-GitHub-Api-Version`.                        |
| `POLL_INTERVAL_SECONDS`       | `60`                                          | Minimum delay between collection cycles.                       |
| `BACKFILL_HOURS`              | `1`                                           | History imported when a repository is first seen.              |
| `OVERLAP_MINUTES`             | `15`                                          | Recent-run overlap used after initial backfill.                |
| `DATABASE_PATH`               | `/var/lib/github-actions-exporter/actions.db` | Durable SQLite database.                                       |
| `PORT`                        | `9102`                                        | Prometheus HTTP port.                                          |
| `LOG_LEVEL`                   | `INFO`                                        | Python logging level.                                          |

### Authentication

Configure a GitHub App wherever the watched repositories span more than one
account. A fine-grained personal access token is scoped to a single resource
owner, so one token cannot reach both `jlapenna/*` and `supersprinklesracing/*`
— the repositories outside its owner return `404`, which reads as "repository
missing" rather than "not authorized" and is easy to misdiagnose.

An App is installed per account, so this exporter mints one installation token
per owner and refreshes each in place. Installation tokens last an hour and are
held in memory only. The App needs `Actions: Read-only` and an installation on
every account in `GITHUB_REPOSITORIES`; owners are discovered at runtime, so
adding a repository under an already-installed account needs no change here.

Setting only one of the two App variables is an error rather than a silent
fallback to `GITHUB_TOKEN`: a half-finished rollout that looks configured is
the failure this is meant to end.

Two consequences of per-owner tokens are worth knowing. GitHub meters each
installation against its own core quota, so the
`github_actions_exporter_api_rate_limit_*` gauges carry an `owner` label —
they are several independent windows, not one. And reinstalling the App on an
account issues a new installation id, so a cached id that stops working is
looked up once more before the error propagates; a long-running exporter
therefore survives a reinstall without a restart.

## HTTP endpoints

| Path       | Cost                           | Purpose                                     |
| ---------- | ------------------------------ | ------------------------------------------- |
| `/metrics` | Renders the last poll snapshot | Prometheus scrape target.                   |
| `/healthz` | Constant                       | Container liveness probe; returns `200 ok`. |

`/metrics` runs no SQL. The history aggregations scan every stored run and job,
which reached about 5s per scrape at 130k runs and pushed scrapes past
Prometheus's 10s timeout (homelab#2653), so the poll loop rebuilds a snapshot
once per cycle and scrapes render it. Stored data only changes when the poller
writes, so the snapshot is as fresh as the database; queue ages are still
computed at scrape time. A snapshot query failure exits the process (Docker
restarts it; a persistent failure shows as `up=0`, as a failed scrape did)
rather than serving stale history silently.

Point container healthchecks at `/healthz`, never at `/metrics`. prometheus_client
serves the metrics payload on _every_ GET path for backwards compatibility, so a
probe aimed anywhere else renders and discards the whole registry -- 3.4 MB and
2.6-3.6s per probe when homelab#1204 was filed, and growing with the number of
tracked runs. That is what made a 2s probe fail permanently while Prometheus was
scraping the same exporter successfully. `/healthz` proves only that the HTTP
server is answering; poller and API health are exported as metrics and alerted
on there.

The initial import is resumable: it is marked complete only after every run
and job in the window has been stored. Each successful refresh timestamp is
also persisted, so collection after an outage resumes from the last successful
poll with the overlap margin instead of losing runs created during the gap.
The homelab deployment authenticates with the fleet GitHub App credentials
mounted by Homelab (`GITHUB_APP_CLIENT_ID` and `GITHUB_APP_PRIVATE_KEY_FILE`).
The exporter serves the last successfully collected data
if GitHub is temporarily unavailable; `github_actions_exporter_*` metrics make
API errors and stale repository refreshes observable.

## Metrics

History families are rebuilt from SQLite once per poll; counters carry the
`_total` suffix and histograms the usual `_bucket`/`_sum`/`_count` series.

| Metric                                                           | Type      | Labels                                                                                    | Meaning                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------- | --------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `github_actions_workflow_runs_total`                             | counter   | `repository`, `workflow`, `event`, `conclusion`                                           | Completed workflow runs.                                                                                                                                                                                                                                                                   |
| `github_actions_workflow_runs_current`                           | gauge     | `repository`, `workflow`, `status`                                                        | Active workflow runs.                                                                                                                                                                                                                                                                      |
| `github_actions_jobs_total`                                      | counter   | `repository`, `workflow`, `job`, `conclusion`, `runner_group`, `execution`                | Completed jobs.                                                                                                                                                                                                                                                                            |
| `github_actions_jobs_current`                                    | gauge     | `repository`, `workflow`, `job`, `status`, `runner_group`, `concurrency_group`, `runs_on` | Active jobs.                                                                                                                                                                                                                                                                               |
| `github_actions_job_oldest_queued_seconds`                       | gauge     | `repository`, `workflow`, `job`, `runs_on`                                                | Age of the oldest queued job, computed at scrape time; `runs_on` is empty for hosted jobs.                                                                                                                                                                                                 |
| `github_actions_workflow_duration_seconds`                       | histogram | `repository`, `workflow`, `event`                                                         | Run creation to completion.                                                                                                                                                                                                                                                                |
| `github_actions_workflow_queue_duration_seconds`                 | histogram | `repository`, `workflow`, `event`                                                         | Run creation to start.                                                                                                                                                                                                                                                                     |
| `github_actions_job_duration_seconds`                            | histogram | `repository`, `workflow`, `job`, `runner_group`, `execution`                              | Completed-job start to completion.                                                                                                                                                                                                                                                         |
| `github_actions_job_queue_duration_seconds`                      | histogram | `repository`, `workflow`, `job`, `runner_group`, `execution`                              | Completed-job creation to start.                                                                                                                                                                                                                                                           |
| `github_actions_workflow_consecutive_failures`                   | gauge     | `repository`, `workflow`                                                                  | Newest decisive non-`pull_request` runs in the rolling window that did not succeed; 0 after a success. Cancelled and skipped runs neither extend nor break the streak.                                                                                                                     |
| `github_actions_workflow_consecutive_failures_complete`          | gauge     | `repository`, `workflow`                                                                  | 1 when a success inside the window bounds the count (or it is 0); 0 when decisive failures remain in the window and no success bounds the streak, even if an older success is stored. When a workflow's last decisive run ages out of the window, neither streak series is emitted for it. |
| `github_actions_workflow_pull_request_failing_branches`          | gauge     | `repository`, `workflow`                                                                  | See [Pull-request failures](#pull-request-failures).                                                                                                                                                                                                                                       |
| `github_actions_exporter_last_success_timestamp_seconds`         | gauge     | `repository`                                                                              | Last successful repository refresh.                                                                                                                                                                                                                                                        |
| `github_actions_exporter_poll_errors_total`                      | counter   | `repository`, `stage`                                                                     | Collection errors.                                                                                                                                                                                                                                                                         |
| `github_actions_exporter_backfill_in_progress`                   | gauge     | `repository`                                                                              | 1 while the initial history import runs.                                                                                                                                                                                                                                                   |
| `github_actions_exporter_api_requests_total`                     | counter   | `owner`, `endpoint`, `status`                                                             | GitHub REST requests per repository owner / App installation.                                                                                                                                                                                                                              |
| `github_actions_exporter_api_rate_limit_{remaining,limit,used}`  | gauge     | `owner`                                                                                   | Core-quota window per App installation ([quota metrics](#github-api-quota-metrics)).                                                                                                                                                                                                       |
| `github_actions_exporter_api_rate_limit_reset_timestamp_seconds` | gauge     | `owner`                                                                                   | When that window resets.                                                                                                                                                                                                                                                                   |

## Pull-request failures

`github_actions_workflow_consecutive_failures` skips `pull_request` runs,
because one pull request with a broken change fails on every push.
`github_actions_workflow_pull_request_failing_branches` covers them by counting
pull requests instead of runs: the distinct head branches among a workflow's
newest `pull_request` runs that failed, back to the first success, inside the
same three-day window. Two or more means the workflow or its runner is failing
across pull requests (homelab#3509). The branch name is stored to tell pull
requests apart and is never exported.

GitHub lists runs by creation time, and a rerun keeps its run's. Every five
minutes the poller therefore asks GitHub for the newest attempt of the runs
behind that count, so a rerun that passes after the runner is repaired clears
it. Each check covers at most 20 runs per repository, taking those checked
longest ago first, so every run is reached within a few checks.

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

## GitHub API quota metrics

Every GitHub REST response increments the bounded
`github_actions_exporter_api_requests_total{owner,endpoint,status}` counter and,
when the corresponding header is valid, updates these per-owner gauges
(`{owner}`):

- `github_actions_exporter_api_rate_limit_remaining{owner}`
- `github_actions_exporter_api_rate_limit_limit{owner}`
- `github_actions_exporter_api_rate_limit_used{owner}`
- `github_actions_exporter_api_rate_limit_reset_timestamp_seconds{owner}`

Missing or malformed rate-limit headers leave the previous valid observation
intact. This makes the metrics safe for projected-exhaustion alerts while an
individual GitHub response is incomplete or otherwise malformed.

When an owner's installation hits `X-RateLimit-Remaining: 0` (including on a
`200` response carrying the final allowed request) or returns a rate-limited
`403`/`429` (including secondary-limit `403` responses without `Retry-After`,
while excluding ordinary `5xx` `Retry-After` errors), `GitHubAPI` arms a
per-owner backoff until `X-RateLimit-Reset` or `Retry-After` (delta-seconds or
RFC 7231 HTTP-date, with a 60-second minimum fallback when neither yields a
future delay and a one-hour ceiling). Repositories under that owner skip
outbound requests while backed off, increment
`github_actions_exporter_poll_errors_total{repository,stage="rate_limit"}`, and
leave `github_actions_exporter_last_success_timestamp_seconds{repository}`
unchanged so staleness alerts observe the gap, while repositories under other
owners continue refreshing normally and the affected owner backfills from its
last successful poll once the window resets.

Optional metadata calls have separate bounds and share a per-probe `500`-request
core-quota reserve:

- Active-run `concurrency_groups` lookups are throttled to once every five
  minutes per run and capped at `20` requests per owner per poll cycle, shared
  across that owner's configured repositories with rotating remainder priority
  and unused-slot rollover so an earlier busy repository cannot starve later
  ones. Within a repository, slots go to never-probed active runs first, then
  to the least recently probed, so a long run list cannot keep its oldest
  active runs `unknown`. Skipping or failing an optional lookup preserves any previously
  confirmed `concurrency_group` label in SQLite and marks newly seen active jobs
  `unknown` rather than `none`.
- Failed-`pull_request` rerun probes normally run once every five minutes per
  repository and check up to `20` candidate runs per repository (least recently
  probed first); non-rate-limit probe errors are counted under
  `github_actions_exporter_poll_errors_total{repository,stage="pull_request_recheck"}`
  without aborting core collection or skipping that five-minute cooldown. A
  `404` (GitHub no longer has the run) is not counted there: it counts as an
  attempted probe and keeps the stored result. Each
  probe rechecks the owner's `500`-request reserve before calling GitHub and
  advances the per-run recheck timestamp only for attempted runs. If quota drops
  below `500` partway through a batch, the repository cooldown stays due so
  deferred candidates are probed first on the next poll once quota recovers to
  at least `500` (which can run inside five minutes after a window reset and
  include already-probed candidates when fewer than `20` runs remain).

## Verification

```sh
uv run --no-project --no-env-file --with-requirements requirements.lock --with ruff==0.16.1 ruff check exporter.py tests
uv run --no-project --no-env-file --with-requirements requirements.lock --with ruff==0.16.1 ruff format --check exporter.py tests
uv run --no-project --no-env-file --with-requirements requirements.lock python -W error::ResourceWarning -m unittest discover -s tests -v
docker build -t agent-lcars-github-actions-exporter:local .
```

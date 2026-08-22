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

| Environment variable    | Default                                       | Purpose                                                             |
| ----------------------- | --------------------------------------------- | ------------------------------------------------------------------- |
| `GITHUB_TOKEN`          | required                                      | Token used for GitHub REST requests. `Actions: read` is sufficient. |
| `GITHUB_REPOSITORIES`   | required                                      | Comma-separated `owner/repository` list.                            |
| `GITHUB_API_URL`        | `https://api.github.com`                      | GitHub API root.                                                    |
| `GITHUB_API_VERSION`    | `2022-11-28`                                  | Version sent in `X-GitHub-Api-Version`.                             |
| `POLL_INTERVAL_SECONDS` | `60`                                          | Minimum delay between collection cycles.                            |
| `BACKFILL_HOURS`        | `1`                                           | History imported when a repository is first seen.                   |
| `OVERLAP_MINUTES`       | `15`                                          | Recent-run overlap used after initial backfill.                     |
| `DATABASE_PATH`         | `/var/lib/github-actions-exporter/actions.db` | Durable SQLite database.                                            |
| `PORT`                  | `9102`                                        | Prometheus HTTP port.                                               |

The initial import is resumable: it is marked complete only after every run
and job in the window has been stored. Each successful refresh timestamp is
also persisted, so collection after an outage resumes from the last successful
poll with the overlap margin instead of losing runs created during the gap.
The homelab deployment reuses the existing vault-managed read token already
rendered for Glance. The exporter serves the last successfully collected data
if GitHub is temporarily unavailable; `github_actions_exporter_*` metrics make
API errors and stale repository refreshes observable.

## Full-suite performance queries

Agent LCARS marks the real console browser step, while retaining `E2E` as its
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
      job="E2E",
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
      job="E2E",
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
  job="E2E",
  runner_group="Default",
  execution="full_suite"
}[7d]))
/
sum(increase(github_actions_job_duration_seconds_count{
  repository="jlapenna/agent-lcars",
  workflow="ci",
  job="E2E",
  runner_group="Default",
  execution="full_suite"
}[7d]))
```

Always pair percentiles with the sample count:

```promql
sum(increase(github_actions_job_duration_seconds_count{
  repository="jlapenna/agent-lcars",
  workflow="ci",
  job="E2E",
  runner_group="Default",
  execution="full_suite"
}[7d]))
```

Completed full-suite success rate:

```promql
sum(increase(github_actions_jobs_total{
  repository="jlapenna/agent-lcars",
  workflow="ci",
  job="E2E",
  runner_group="Default",
  execution="full_suite",
  conclusion="success"
}[7d]))
/
sum(increase(github_actions_jobs_total{
  repository="jlapenna/agent-lcars",
  workflow="ci",
  job="E2E",
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
`github_actions_exporter_api_requests_total{endpoint,status}` counter and, when
the corresponding header is valid, updates these unlabelled gauges:

- `github_actions_exporter_api_rate_limit_remaining`
- `github_actions_exporter_api_rate_limit_limit`
- `github_actions_exporter_api_rate_limit_used`
- `github_actions_exporter_api_rate_limit_reset_timestamp_seconds`

Missing or malformed rate-limit headers leave the previous valid observation
intact. This makes the metrics safe for projected-exhaustion alerts while an
individual GitHub response is incomplete or otherwise malformed.

## Verification

```sh
uv run --no-project --no-env-file --with-requirements requirements.lock --with ruff==0.16.1 ruff check exporter.py tests
uv run --no-project --no-env-file --with-requirements requirements.lock --with ruff==0.16.1 ruff format --check exporter.py tests
uv run --no-project --no-env-file --with-requirements requirements.lock python -W error::ResourceWarning -m unittest discover -s tests -v
docker build -t agent-lcars-github-actions-exporter:local .
```

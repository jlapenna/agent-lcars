# Repository jobs prototype

This isolated prototype exercises repository-owned job definitions through
discovery, admission, execution, artifact validation and baseline advancement.
It does not register production schedules, add a Goose pipeline to Work, or
change live jobs. SQLite is a development adapter, not a new production queue.

## Try it

Use Node 24 and the repository's normal dependency setup. Run development work
inside an allocation with enforced resource ceilings as described in the owning
development skill. These commands do not provision an allocation.

```sh
node tools/jobs/cli.mjs validate --checkout /path/to/jclaw --repository jlapenna/jclaw --ref COMMIT
node tools/jobs/cli.mjs due --checkout /path/to/jclaw --repository jlapenna/jclaw --ref COMMIT --at 2026-11-01T14:00:00Z
./tools/nx run repository-jobs:test
```

Discovery uses Git blobs at an exact resolved commit; working-tree changes are
ignored. It returns job errors alongside valid definitions. Invalid or deleted
definitions are never silently replaced with cached schedules. The prototype's
`due` command evaluates one explicit minute and does not execute or backfill it.
Cron uses LCARS's existing AND semantics for day-of-month/day-of-week. Timezones
are IANA identifiers: missing DST minutes do not run, and repeated local minutes
are separate UTC occurrences. Production enablement will need an explicit
activation floor and missed-occurrence policy.

For a persisted simulation, supply a profile JSON with `name`, `repositories`,
`subnets`, `findingsRepositories` and `capacity` (`cpu`, `memory`, `storage`), and a result JSON matching the
security audit contract:

```sh
node tools/jobs/cli.mjs simulate --checkout /path/to/jclaw --repository jlapenna/jclaw --ref COMMIT \
  --job weekly-security-audit --profile /private/profile.json --result /private/result.json \
  --request trial-1 --state /private/jobs.sqlite --export /private/artifacts.json
node tools/jobs/cli.mjs history --state /private/jobs.sqlite
```

Simulation is always labeled: it imports supplied output, runs no LLM and proves
no network assessment. Treat the database and artifact exports as private. The
export bundles the named `report.md`, `findings.json` and `coverage.json` artifacts.

## Contracts

- Directory identity is `owner/repo:job-name`. Definitions and recipes are regular
  committed files, bounded to 64 KiB each. v1 accepts scalar security-audit inputs,
  one recipe, one attempt and one active run. No recipe-controlled extensions,
  model settings, nested jobs, file parameters or retries are supported.
- `result.contract: security-audit-v1` explicitly selects the pilot contract;
  generic jobs and additional result kinds are not implicitly accepted. Required
  inputs are `subnet`, `findingsRepository` and `mode: report`.
- A manual request ID replays its original run; changed input under that ID is a
  conflict. A UTC schedule occurrence is pinned at first admission. Overlap is a
  durable skipped occurrence, not deferred work that surprises the operator later.
- Execution claims are atomic and use the stored snapshot. Completion is fenced
  to the execution owner. Expired queued runs can be retired without a worker;
  running recovery requires explicit proof that the entire allocation stopped.
  The prototype does not pretend elapsed time alone establishes that proof.
- Reports need nonempty text and exactly one discovery, ports, services, baseline
  and existing-issues coverage entry. Each entry requires evidence. Failed coverage
  yields `incomplete`; wrong scope, malformed results and duplicate keys fail.
  Findings are limited to 48 KiB so the next baseline fits the CLI parameter bound.
  Overall output is bounded to 1 MiB. These validate the evidence structure, not
  whether an agent's claims are true.
- Only validated complete results advance the baseline. Failed, incomplete,
  cancelled, timed-out, skipped and stale executions cannot replace it.

## Goose adapter and production integration boundary

`gooseExecutor` invokes `goose run --recipe PATH --quiet --params key=value`
without a shell, requires an isolated profile environment and an allocation
verifier, bounds output, and terminates the owned process group on cancellation.
The trusted host adapter must supervise the entire allocation, including any
descendants that create their own process group. Process-group cleanup alone is
not a replacement for that supervision.

`cgroupAllocation` checks this process's actual unified cgroup, exact CPU/memory
limits, no swap, and requires a host-owned hard-storage verifier. It does not
claim a Kubernetes ephemeral-storage declaration is a hard quota. The complete
job includes setup, interpreter, model client, tools, sidecars, caches, image
layers, scratch and results. No allocation may exceed 2 CPU / 6 GiB / 40 GiB,
and smaller lane limits apply. Resource failures stay failures.

The profile must independently enforce network scope, read-only issue access,
tool selection and isolated Goose credentials/configuration. The library's profile
name/capacity check is admission metadata, not a security sandbox. Therefore no
unguarded `run` command is exposed. No real audit has been qualified by simulation.

Before production enablement, bind catalog reconciliation to managed repository
events, job invocation to Work admission/leases, execution to a qualified Goose
QueueExecutor profile, artifacts/baselines to durable storage, and job/run views
to the existing console. Reuse those owners rather than deploying this SQLite
prototype as another scheduler. Qualify real manual execution, cancellation,
crash recovery and a scheduled occurrence. Disable the old named OpenClaw audit
before enabling its replacement; merging source is not that cutover.

Official interfaces:
[Goose CLI](https://github.com/aaif-goose/goose/blob/main/documentation/docs/guides/goose-cli-commands.md),
[recipe reference](https://github.com/aaif-goose/goose/blob/main/documentation/docs/guides/recipes/recipe-reference.md).

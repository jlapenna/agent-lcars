# Agent Telemetry Watcher

Per-host daemon (issue #2540) that watches interactive Claude Code and Codex
CLI sessions on a workstation and reports summary-only telemetry to the
`agent-telemetry` Firestore store the [Agent LCARS](../agent-console)
reads from.

## CI issue-agent telemetry paths

Interactive (`source: 'cli'`) telemetry is this daemon's normal host-watcher
mode, described below. CI issue-agent (`source: 'issue-agent'`) telemetry
for `.github/workflows/claude.yml` runs ships via two complementary paths:

1. **Mid-run, live (`runner ride-along` — issue #3107 follow-up 5):**
   claude.yml's "Start telemetry ride-along" step downloads a **prebuilt**
   single-file bundle (this app's `bundle` Nx target, esbuild-bundled with
   every dependency inlined including `@google-cloud/firestore`) and
   backgrounds it — `node ride-along.cjs runner ride-along --run-id <id>
--issue-number <n> --projects-dir "$HOME/.claude/projects"` — for the
   duration of "Run Claude Code". It reuses `WatcherDaemon` wholesale (see
   `src/lib/runner.ts`'s `startRideAlong`) on a ~10s tick with **no
   allowlist restriction** (`RUNNER_ALLOWLIST = ['*']`) — a runner container
   is single-purpose and destroyed after one job, unlike a workstation with
   many unrelated Claude Code projects under the same
   `~/.claude/projects` root, so there's no privacy boundary to enforce the
   way `DEFAULT_PROJECT_DIR_ALLOWLIST` enforces one for interactive hosts.
   This is what lights up the Agent LCARS's In-Flight UI (#3092) with
   live turns/tokens mid-run instead of leaving it blind until the job
   ends — with **zero console changes**, since that UI already renders
   gauges whenever a live session doc exists.

   The bundle is published by `.github/workflows/deploy.yml`'s
   `publish-ride-along` job on every main push that touches this app or
   `libs/telemetry`, as a **sha-named** object
   (`gs://supersprinklesracing-agent-session-transcripts/tools/ride-along/<sha>.cjs`)
   — the writer SA can only create objects, never overwrite a mutable
   `latest` pointer, so claude.yml's consumer step lists the
   `tools/ride-along/` prefix and picks the newest by `timeCreated`. No
   bundle published yet is expected (and fails soft) on the first rollout
   after this feature merges. This costs **no per-run install**: the
   original design explored here (harvest branch
   `feat/agent-telemetry-runner-shipper`, closed PR #3094, commit
   `c107dc83`) paid a full `pnpm install --frozen-lockfile` + build on
   every single run before the agent's first turn — the prebuilt bundle is
   what made ride-along viable to actually ship.

2. **Job-end, authoritative (via `apps/cli`, unrelated to this app's own
   `runner` mode):** claude.yml's `Authenticate telemetry writer` +
   `Ship session telemetry`
   steps (near the end of the job, `if: always()`) upload the runner's full
   transcript to GCS and upsert a final `source: 'issue-agent'` session doc
   — marked `ended`, with `transcriptGcsUri` attached — via `apps/cli`'s
   `agent-telemetry upsert --run-id --issue-number --transcript-gcs-uri`.
   This step kills the ride-along process (by PID file) before its own
   upsert, so its write is always the one that lands last — see
   [orchestration.md §8](../../.agents/skills/sprinkles-dev/references/orchestration.md)
   for the full description.

3. **OpenCode pipeline (`source: 'issue-agent'`, `agent: 'opencode'`,
   archive-first stub — #3123 phase 2):**
   `.github/workflows/opencode.yml`'s `Authenticate telemetry
writer` + `Ship session archive` steps (after "Run OpenCode",
   `if: always()`, `continue-on-error: true`) follow the same archive-first
   pattern as claude.yml's authoritative path, but with **no transcript
   reducer** — OpenCode's session storage is a SQLite database (`opencode.db`
   plus a `log/` dir), not a `.jsonl` transcript file, and
   `libs/telemetry/src/lib/transcript-adapter.ts` has no adapter for
   that format yet. Instead the workflow uploads the raw session storage
   untouched to
   `gs://supersprinklesracing-agent-session-transcripts/runs/<run-id>/opencode/`
   and upserts a **stub** session doc (`agent-telemetry upsert-stub
--session-id opencode-run-<run-id> --agent opencode`) with zero turns and
   zero tokens — just a `transcriptGcsUri` pointer, a `startedAt` timestamp,
   `source: 'issue-agent'`, and `agent: 'opencode'`. The Agent LCARS's
   transcript UI gated on `sessionAgent(doc) === 'claude-code'` so these
   stubs are never rendered as transcripts.

   **Deliberate ordering (unlike claude.yml):** WIF auth is placed **after**
   "Run OpenCode", not before it. OpenCode's own agent has unrestricted tool
   access (including arbitrary `gh` calls and shell commands), and the
   telemetry writer SA credential is powerful enough to upsert session docs
   and upload to GCS. By keeping the auth step after the agent finishes,
   there is no window where the agent's own bash could accidentally or
   instrumentally inherit write access to the telemetry store — the
   claude.yml approach (pre-authenticate, then rely on a later readonly
   credential step to overwrite the ambient SA token) works there because
   claude.yml's credential setup has a dedicated readonly re-auth step
   before the agent's bash ever runs; this pipeline has no such step, so
   the simpler "auth after agent" model is the correct one.

4. **Codex pipeline (`source: 'issue-agent'`, `agent: 'codex'`):**
   `codex.yml` archives the action-created date-partitioned JSONL rollouts
   under `runs/<run-id>/codex/` and writes an ended stub doc after the agent
   exits. Writer authentication deliberately happens after Codex, so the
   agent never inherits telemetry write credentials. Interactive Codex
   sessions use the full reducer described below; the runner path remains
   archive-first so telemetry cannot delay or fail the worker.

## What it does

On an interval (`AGENT_TELEMETRY_HEARTBEAT_INTERVAL_MS`, default 10s, with
an immediate first tick on start and an `fs.watch`-driven nudge on file
changes in between), the daemon:

1. Discovers Claude transcripts under `~/.claude/projects/**/*.jsonl` whose
   project-dir basename matches the configured allowlist
   (`AGENT_TELEMETRY_PROJECT_DIR_ALLOWLIST`, `*`-wildcard glob patterns;
   default `-home-jlapenna-p-members*`). Interactive transcripts can contain
   other projects' data, so this scoping is a privacy boundary, not just a
   filter (PRD #2112 amendment 2026-07-10, decision 3). It also recursively
   discovers Codex rollouts under `~/.codex/sessions/**/*.jsonl`, filtering
   reduced summaries by cwd (default `/home/jlapenna/p/members*`) before
   anything is shipped.
2. Skips re-reading any file whose mtime/size hasn't changed since the last
   tick, and reduces the rest via `@agent-lcars/telemetry`'s
   `reduceTranscripts` into counters/deliverables/timeline summaries —
   **never** message bodies.
3. Resolves liveness (`live` / `idle` / `stale` / `ended`) from transcript
   recency, whether a process is still running against the session's `cwd`,
   and whether the watcher itself has kept rediscovering the file within
   `AGENT_TELEMETRY_STALENESS_WINDOW_MS` (default 5× the heartbeat
   interval).
4. Upserts one `source: 'cli'` session doc per tracked session via
   `buildSessionDoc` + the configured `SessionStore`.

Every step fails soft and logs rather than crashing — a single broken
transcript, reducer error, or store write failure never takes down
telemetry for the daemon's other tracked sessions.

## Configuration

All via environment variables (see `src/lib/config.ts`):

| Variable                                | Default                     | Purpose                                                                                       |
| --------------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------- |
| `AGENT_TELEMETRY_CLAUDE_PROJECTS_DIR`   | `~/.claude/projects`        | Root to watch (overridable for Docker bind mounts / test fixtures).                           |
| `AGENT_TELEMETRY_PROJECT_DIR_ALLOWLIST` | `-home-jlapenna-p-members*` | Comma-separated `*`-wildcard globs matched against project-dir names.                         |
| `AGENT_TELEMETRY_CODEX_SESSIONS_DIR`    | `~/.codex/sessions`         | Recursive root for Codex rollout JSONL.                                                       |
| `AGENT_TELEMETRY_CODEX_CWD_ALLOWLIST`   | `/home/jlapenna/p/members*` | Cwd glob privacy boundary for Codex summaries.                                                |
| `AGENT_TELEMETRY_HOST`                  | `os.hostname()`             | Host label recorded on each session doc.                                                      |
| `AGENT_TELEMETRY_HEARTBEAT_INTERVAL_MS` | `10000`                     | Tick interval.                                                                                |
| `AGENT_TELEMETRY_STALENESS_WINDOW_MS`   | `heartbeatIntervalMs * 5`   | How long a session can go unrediscovered before it's marked `stale`.                          |
| `AGENT_TELEMETRY_SHARE_DIR`             | `~/share`                   | Root for the share-media skill convention; artifact discovery is skipped entirely when unset. |
| `AGENT_TELEMETRY_PROJECT_ID`            | —                           | Firestore project id for the real store.                                                      |
| `AGENT_TELEMETRY_WRITER_KEY_JSON`       | —                           | Service-account key JSON for the real store's writer credentials.                             |
| `FIRESTORE_EMULATOR_HOST`               | —                           | If set, writes to the emulator instead (takes precedence over the two above).                 |

If neither the emulator host nor both of `AGENT_TELEMETRY_PROJECT_ID` /
`AGENT_TELEMETRY_WRITER_KEY_JSON` are set, the daemon falls back to a
log-only store — this is what lets `docker run` demonstrate the daemon
end-to-end without live GCP access (issue #2540's CI-only verification
scope). `runner ride-along` mode (above) adds a third path,
**tried after the writer-key-JSON path**: if `AGENT_TELEMETRY_PROJECT_ID`
is set but `AGENT_TELEMETRY_WRITER_KEY_JSON` is not, the store falls back to
ambient Application Default Credentials (`GOOGLE_APPLICATION_CREDENTIALS`,
set by claude.yml's "Start telemetry ride-along" step to the
agent-telemetry-writer SA's short-lived WIF credentials file) instead of a
key JSON blob — see `src/lib/create-store.ts`.

## Running

```bash
./tools/nx run @agent-lcars/telemetry-watcher:serve
```

## Bundle (runner ride-along)

The `bundle` Nx target produces the single self-contained file claude.yml's
"Start telemetry ride-along" step downloads and runs — esbuild with
`thirdParty: true` and no `external` list, so every dependency (including
`@google-cloud/firestore`, which is pure JS — no native bindings in its
transitive tree) is inlined into one `.cjs` file with zero runtime
`node_modules` dependency:

```bash
./tools/nx run @agent-lcars/telemetry-watcher:bundle
# -> dist/apps/telemetry-watcher/ride-along.cjs

# Verify it actually runs standalone (copy it out of the checkout first —
# running it in place can accidentally succeed via an ambient node_modules
# resolution that won't exist wherever claude.yml downloads it to):
cp dist/apps/telemetry-watcher/ride-along.cjs /tmp/some-empty-dir/
cd /tmp/some-empty-dir
node ride-along.cjs runner ride-along --run-id test --projects-dir /tmp/some/fixture/dir
```

Deliberately **not** in the default `build` target's dependency chain (a
separate `bundle` target, not depended on by anything) — it's only ever
invoked by `deploy.yml`'s `publish-ride-along` job, on a main push that
touches this app or `libs/telemetry`, which uploads the result as a
sha-named object to
`gs://supersprinklesracing-agent-session-transcripts/tools/ride-along/`
(see the "Two shipping paths" section above for why sha-named, not
`latest`).

## Deployment

Packaged as a Docker image (`apps/telemetry-watcher/Dockerfile`,
built directly from the live `members` checkout — see the image comments
for why `COPY . .` is cache-invalidated on every build and how the cache
mounts compensate):

```bash
./tools/nx run @agent-lcars/telemetry-watcher:docker-build
```

Deployed to the `pike` homelab host via that host's existing Docker Compose
and homelab-ansible convention (outside this repo) — chosen over the PRD's
original "bundled systemd unit" plan to match how the rest of the homelab
fleet is managed.

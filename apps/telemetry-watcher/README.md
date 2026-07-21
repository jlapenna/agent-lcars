# Agent LCARS Telemetry Watcher

Per-host daemon (issue #2540) that watches interactive Claude Code and Codex
CLI sessions on a workstation and reports summary-only telemetry to the
`agent-telemetry` Firestore store the [Agent LCARS](../console)
reads from.

## CI issue-agent telemetry paths

Interactive (`source: 'cli'`) telemetry is this daemon's normal host-watcher
mode, described below. CI issue-agent (`source: 'issue-agent'`) telemetry is
provided by the standalone runner bundle:

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
   This lights up Agent LCARS's In-Flight UI (#3092) with live turns and
   tokens while the job is running.

   The bundle is published by `.github/workflows/deploy.yml`'s
   `publish-ride-along` job on every main push that touches this app or
   `libs/telemetry`, as a **sha-named** object
   (`gs://supersprinklesracing-agent-session-transcripts/tools/ride-along/<sha>.cjs`)
   — the writer SA can only create objects, never overwrite a mutable
   `latest` pointer. Consumers use the versioned public bundle URL, so no
   source checkout or per-run install is required.

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

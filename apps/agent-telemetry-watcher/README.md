# Agent Telemetry Watcher

Per-host daemon (issue #2540) that watches interactive Claude Code CLI
sessions on a workstation and reports summary-only telemetry to the
`agent-telemetry` Firestore store the [agent console](../agent-console)
reads from.

## What this is NOT

This daemon does **not** ship telemetry for CI issue-agent (`claude.yml`)
runs. Those "runner" sessions are shipped by `.github/workflows/claude.yml`
itself — its `Authenticate telemetry writer` + `Ship session telemetry`
finalize steps upload the runner's transcript to GCS and upsert a
`source: 'issue-agent'` session doc via `apps/cli`'s `agent-telemetry
upsert --run-id --issue-number --transcript-gcs-uri` — see
[orchestration.md §8](../../.agents/skills/sprinkles-dev/references/orchestration.md)
for the full description. This watcher only ever produces `source: 'cli'`
docs for interactive sessions on the host it runs on.

A design where this daemon also rode along on runner containers to give
live mid-run visibility (rather than the current shipper's finalize-only
upload) was explored and parked, not rejected — a mid-run ride-along would
need its own `pnpm install --frozen-lockfile` + build before the agent's
first turn on every single run (this app has no own `package.json` for a
filtered install, and `claude-agent`-labeled runners have no `docker.sock`,
members#1976). If that design is revisited, harvest branch
`feat/agent-telemetry-runner-shipper` (closed PR #3094, commit `c107dc83`,
kept on the remote) rather than rebuilding it from scratch.

## What it does

On an interval (`AGENT_TELEMETRY_HEARTBEAT_INTERVAL_MS`, default 10s, with
an immediate first tick on start and an `fs.watch`-driven nudge on file
changes in between), the daemon:

1. Discovers transcript files under `~/.claude/projects/**/*.jsonl` whose
   project-dir basename matches the configured allowlist
   (`AGENT_TELEMETRY_PROJECT_DIR_ALLOWLIST`, `*`-wildcard glob patterns;
   default `-home-jlapenna-p-members*`). Interactive transcripts can contain
   other projects' data, so this scoping is a privacy boundary, not just a
   filter (PRD #2112 amendment 2026-07-10, decision 3).
2. Skips re-reading any file whose mtime/size hasn't changed since the last
   tick, and reduces the rest via `@repo/agent-telemetry`'s
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
scope).

## Running

```bash
./tools/nx run @repo/agent-telemetry-watcher:serve
```

## Deployment

Packaged as a Docker image (`apps/agent-telemetry-watcher/Dockerfile`,
built directly from the live `members` checkout — see the image comments
for why `COPY . .` is cache-invalidated on every build and how the cache
mounts compensate):

```bash
./tools/nx run @repo/agent-telemetry-watcher:docker-build
```

Deployed to the `pike` homelab host via that host's existing Docker Compose
and homelab-ansible convention (outside this repo) — chosen over the PRD's
original "bundled systemd unit" plan to match how the rest of the homelab
fleet is managed.

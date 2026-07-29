# Agent LCARS Telemetry Watcher

Per-host daemon (issue #2540) that watches interactive Claude Code and Codex
CLI sessions on a workstation and reports summary-only telemetry to the
`agent-telemetry` Firestore store the [Agent LCARS](../console)
reads from.

## CI issue-agent telemetry paths

Interactive (`source: 'cli'`) telemetry is this daemon's normal host-watcher
mode, described below. CI issue-agent (`source: 'issue-agent'`) telemetry is
provided by the standalone runner bundle (this app's `bundle` Nx target,
esbuild-bundled with every dependency inlined including
`@google-cloud/firestore`), baked into the self-hosted `claude-agent-lcars`
runner image at `/usr/local/lib/agent-lcars/sidecar.cjs`
(this repo's own `apps/runner-autoscaler/runner-image/Dockerfile` builds
it from this repo's own `main` at image-build time — see issue #30; that
Dockerfile is the single source, and the former hand-synced duplicate in
`jlapenna/homelab` was removed along with the local-build fallback it
served). No download, no version pin to keep in
sync: the image build is the only "release" step, replacing a
publish-then-pin scheme whose pin silently went stale for months (#29).

1. **Mid-run, live (`runner sidecar` — issue #3107 follow-up 5):**
   claude.yml's "Start telemetry sidecar" step backgrounds it —
   `node sidecar.cjs runner sidecar --run-id <id>
--issue-number <n> --projects-dir "$HOME/.claude/projects"` — for the
   duration of "Run Claude Code". It reuses `WatcherDaemon` wholesale (see
   `src/lib/runner.ts`'s `startSidecar`) on a ~10s tick with **no
   allowlist restriction** (`RUNNER_ALLOWLIST = ['*']`) — a runner container
   is single-purpose and destroyed after one job, unlike a workstation with
   many unrelated Claude Code projects under the same
   `~/.claude/projects` root, so there's no privacy boundary to enforce the
   way `DEFAULT_PROJECT_DIR_ALLOWLIST` enforces one for interactive hosts.
   This lights up Agent LCARS's In-Flight UI (#3092) with live turns and
   tokens while the job is running.

2. **Finalize, authoritative (`runner finalize` — issue #24):**
   claude.yml's "Finalize telemetry sidecar" step runs once "Run Claude
   Code" exits: kills the sidecar process above (waiting, bounded, for it
   to actually stop first — see that step's comments), then does one last
   reduce pass with liveness hardcoded to `'ended'`, uploads the raw
   transcript to `AGENT_TELEMETRY_TRANSCRIPTS_BUCKET`, and upserts the
   authoritative final doc with `transcriptGcsUri` attached — see
   `src/lib/finalize.ts`. Without this, a session doc just freezes at
   whichever `live`/`idle` snapshot the sidecar above last wrote, and
   never gets a browsable archived transcript.

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
scope). `runner sidecar` mode (above) adds a third path,
**tried after the writer-key-JSON path**: if `AGENT_TELEMETRY_PROJECT_ID`
is set but `AGENT_TELEMETRY_WRITER_KEY_JSON` is not, the store falls back to
ambient Application Default Credentials (`GOOGLE_APPLICATION_CREDENTIALS`,
set by claude.yml's "Start telemetry sidecar" step to the
agent-telemetry-writer SA's short-lived WIF credentials file) instead of a
key JSON blob — see `src/lib/create-store.ts`.

## Running

```bash
./tools/nx run @agent-lcars/telemetry-watcher:serve
```

## Bundle (runner sidecar)

The `bundle` Nx target produces the single self-contained file the
`claude-agent-lcars` runner image bakes in and claude.yml's telemetry steps
run — esbuild with `thirdParty: true` and no `external` list, so every
dependency (including `@google-cloud/firestore`, which is pure JS — no
native bindings in its transitive tree) is inlined into one `.cjs` file with
zero runtime `node_modules` dependency:

```bash
./tools/nx run @agent-lcars/telemetry-watcher:bundle
# -> dist/apps/telemetry-watcher/sidecar.cjs

# Verify it actually runs standalone (copy it out of the checkout first —
# running it in place can accidentally succeed via an ambient node_modules
# resolution that won't exist wherever claude.yml downloads it to):
cp dist/apps/telemetry-watcher/sidecar.cjs /tmp/some-empty-dir/
cd /tmp/some-empty-dir
node sidecar.cjs runner sidecar --run-id test --projects-dir /tmp/some/fixture/dir
```

Deliberately **not** in the default `build` target's dependency chain (a
separate `bundle` target, not depended on by anything on its own) — it's
invoked by `.github/workflows/publish-images.yml`, whenever a push to
`main` touches `apps/telemetry-watcher/**` or `libs/telemetry/**`, not by
anything in this repo's own `ci.yml`.

Because `ci.yml`'s `nx run-many -t test typecheck build --all` therefore
never exercises it, that workflow also runs the standalone check above as a
real step ("Verify the telemetry-watcher bundle runs standalone") before it
publishes anything. That step is the only automated gate on this artifact:
esbuild inlines every dependency, so a transitive dep that can't be inlined
breaks at runtime and is invisible to unit tests. The old
`publish-telemetry-tool.yml`
workflow (publishing immutable semver-tagged releases to
`gs://agent-lcars-tools/telemetry/`, curl-downloaded per job) is gone —
both `agent-lcars`'s and `supersprinklesracing/sprinkles`'s `claude.yml` now
use the runner-image bake-in exclusively (members migrated in
[members#3414](https://github.com/supersprinklesracing/sprinkles/pull/3414)).

## Deployment

Packaged as a Docker image (`apps/telemetry-watcher/Dockerfile` — see the
image comments for why `COPY . .` is cache-invalidated on every build and
how the cache mounts compensate; note the build context is the **repo
root**, not this directory).

**CI publishes it.** `publish-images.yml` builds and pushes
`agent-lcars/telemetry-watcher` — `:latest` plus an immutable commit-sha
tag, linux/amd64 — on every push to `main` touching
`apps/telemetry-watcher/**` or `libs/telemetry/**` (agent-lcars#231).

That was not always true, and its absence caused a real outage: nothing in
CI built this image, so it only reached the registry when someone ran
`docker build` by hand. The `members` → `sprinkles` allowlist fix landed in
#137 and then sat unpublished for weeks while pike kept running a pre-fix
image, reporting 0 active CLI sessions while ~10 were live (homelab#202;
postmortem in homelab's `docs/incidents.md`). The trap was that
`apps/telemetry-watcher/**` _did_ already trigger a publish — of the runner
image's baked-in sidecar, a different artifact.

For a local image without pushing:

```bash
./tools/nx run @agent-lcars/telemetry-watcher:docker-build
```

Deployed to the `pike` homelab host via that host's existing Docker Compose
and homelab-ansible convention (outside this repo) — chosen over the PRD's
original "bundled systemd unit" plan to match how the rest of the homelab
fleet is managed. **Publishing does not deploy:** homelab pins this image
as `tag@digest` and Renovate is disabled for that LAN registry (its runner
can't reach it), so moving the pin is still a human step.

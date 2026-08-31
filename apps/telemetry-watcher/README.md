# Agent LCARS Telemetry Watcher

Per-host daemon (issue #2540) that watches interactive Claude Code and Codex
CLI sessions on a workstation and reports summary-only telemetry to the
`agent-telemetry` Firestore store the [Agent LCARS](../console)
reads from.

## QueueExecutor issue-agent telemetry paths

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
   `direct-runner.sh` backgrounds it —
   `node sidecar.cjs runner sidecar --run-id <id>
--issue-number <n> --projects-dir "$HOME/.claude/projects"` — for the
   duration of the provider invocation. It reuses `WatcherDaemon` wholesale (see
   `src/lib/runner.ts`'s `startSidecar`) on a ~10s tick with **no
   allowlist restriction** (`@agent-lcars/telemetry`'s `runnerWatchRoots`
   allowlists both roots with `['*']`) — a runner container
   is single-purpose and destroyed after one job, unlike a workstation with
   many unrelated Claude Code projects under the same
   `~/.claude/projects` root, so there's no privacy boundary to enforce the
   way `DEFAULT_PROJECT_DIR_ALLOWLIST` enforces one for interactive hosts.
   This lights up Agent LCARS's In-Flight UI (#3092) with live turns and
   tokens while the job is running.

2. **Finalize, authoritative (`runner finalize` — issue #24):**
   `direct-runner.sh` finalizes once the provider exits: it stops the
   sidecar process above (waiting, bounded, for it
   to actually stop first — see that step's comments), then does one last
   reduce pass with liveness hardcoded to `'ended'`, uploads the raw
   transcript to `AGENT_TELEMETRY_TRANSCRIPTS_BUCKET`, and upserts the
   authoritative final doc with `transcriptGcsUri` attached — see
   `src/lib/finalize.ts`. Without this, a session doc just freezes at
   whichever `live`/`idle` snapshot the sidecar above last wrote, and
   never gets a browsable archived transcript.

3. **Resume, pre-run (`runner resume` — native work items sub-project 6):**
   `direct-runner.sh` runs it before the provider when the dispatched work
   carries a resume request —
   `node sidecar.cjs runner resume --session-id <id> --transcript-uri
<gcsUri> --cwd <dir>` — to download a prior session's archived
   transcript into the provider's local session store. See `src/main.ts`'s
   `_runRunnerResumeForTesting`. Fail-soft like the two modes above:
   prints nothing and never exits nonzero on a missing flag, an unsafe
   session id, or a failed download — a broken resume degrades to a fresh
   run rather than failing the dispatch.

## What it does

On an interval (`AGENT_TELEMETRY_HEARTBEAT_INTERVAL_MS`, default 10s, with
an immediate first tick on start and an `fs.watch`-driven nudge on file
changes in between), the daemon:

1. Discovers Claude transcripts under `~/.claude/projects/**/*.jsonl` whose
   project-dir basename matches the configured allowlist
   (`AGENT_TELEMETRY_WATCH_ROOTS`, `*`-wildcard glob patterns; the deployed
   host derives them from `AGENT_TELEMETRY_CHECKOUT_ROOTS`).
   Interactive transcripts can contain
   other projects' data, so this scoping is a privacy boundary, not just a
   filter (PRD #2112 amendment 2026-07-10, decision 3). It also recursively
   discovers Codex rollouts under `~/.codex/sessions/**/*.jsonl`, filtering
   reduced summaries by cwd (defaulting to that same checkout root) before
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
5. Exposes low-cardinality Prometheus state on `/metrics`: process/tick
   timestamps, tracked-session count, and the last successful live/idle
   session upsert. The latter is deliberately narrower than "any write" so
   stale allowlists that only rediscover archived sessions cannot look healthy.

Every step fails soft and logs rather than crashing — a single broken
transcript, reducer error, or store write failure never takes down
telemetry for the daemon's other tracked sessions.

## Session titles (issue #1212)

Every tracked session gets a title, chosen by rank: `declared` >
`generated` > `inferred`. `inferred` (a fragment of the first user message)
is the reducer's own fallback and needs nothing from an agent. The other two
tiers are overlay data, layered on top of the reducer's pristine summary —
see `libs/telemetry/src/lib/session-title-annotation.ts` for the envelope
and `src/lib/session-title-selection.ts` for the rank.

- **`declared`** — a deliberate statement of intent. Set one from inside a
  Claude Code or Codex session with:

  ```bash
  lcars session title "fix the flaky retry test"
  ```

  (`lcars session title --clear` removes it.) The CLI resolves the session
  id itself, in order: `LCARS_SESSION_ID` → `CLAUDE_CODE_SESSION_ID` →
  `CODEX_THREAD_ID`. The first one present _and_ passing `isSafeIdentifier`
  wins — a present-but-unsafe value is a hard failure, not a fall-through to
  the next candidate, so a malformed id can never silently retarget another
  runtime's session. The CLI writes
  `~/.local/state/agent-lcars/session-metadata/<sessionId>.json` directly
  (crash-safe rename-into-place, mode 0700); it never goes through this
  daemon. Nothing installs the `lcars` binary automatically — see
  [`deploy/README.md`](deploy/README.md#installing-the-cli).

For Codex, the watcher derives its inferred title from the first real user
input in watched rollout JSONL. Claude's `aiTitle` remains a transcript-derived
generated title.

## Configuration

All via environment variables (see `src/lib/config.ts`):

| Variable                                 | Default                                   | Purpose                                                                                                                                                                              |
| ---------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `AGENT_TELEMETRY_CHECKOUT_ROOTS`         | required without explicit roots           | Comma-separated checkout roots used by the host fallback and deploy script to construct privacy allowlists.                                                                          |
| `AGENT_TELEMETRY_WATCH_ROOTS`            | deployed host contract                    | JSON array of explicit per-agent roots and privacy allowlists.                                                                                                                       |
| `AGENT_TELEMETRY_CLAUDE_PROJECTS_DIR`    | `~/.claude/projects`                      | Runner-mode fallback only.                                                                                                                                                           |
| `AGENT_TELEMETRY_CODEX_SESSIONS_DIR`     | `~/.codex/sessions`                       | Runner-mode fallback only.                                                                                                                                                           |
| `AGENT_TELEMETRY_ANTIGRAVITY_SUMMARY_DB` | `~/.gemini/antigravity-cli/…`             | Antigravity summary-tier SQLite DB. Set to the empty string to disable the poller; its workspace prefixes follow the configured checkout roots.                                      |
| `AGENT_TELEMETRY_SESSION_STATE_DIR`      | `~/.local/state/agent-lcars`              | Declared-title overlay root — `session-metadata/`. Empty string disables the overlay, same convention as `AGENT_TELEMETRY_ANTIGRAVITY_SUMMARY_DB` above. See "Session titles" above. |
| `AGENT_TELEMETRY_HOST`                   | `os.hostname()`                           | Host label recorded on each session doc.                                                                                                                                             |
| `AGENT_TELEMETRY_HEARTBEAT_INTERVAL_MS`  | `10000`                                   | Tick interval.                                                                                                                                                                       |
| `AGENT_TELEMETRY_STALENESS_WINDOW_MS`    | `heartbeatIntervalMs * 5`                 | How long a session can go unrediscovered before it's marked `stale`.                                                                                                                 |
| `AGENT_TELEMETRY_SHARE_DIR`              | `~/share`                                 | Root for the share-media skill convention; artifact discovery is skipped entirely when unset.                                                                                        |
| `AGENT_TELEMETRY_METRICS_HOST`           | `0.0.0.0`                                 | Address for the host watcher's Prometheus endpoint. Runner sidecar/finalize modes never start it.                                                                                    |
| `AGENT_TELEMETRY_METRICS_PORT`           | `9464`                                    | Port for the host watcher's `/metrics` endpoint.                                                                                                                                     |
| `AGENT_TELEMETRY_PROJECT_ID`             | —                                         | Firestore project id for the real store.                                                                                                                                             |
| `AGENT_TELEMETRY_DATABASE_ID`            | `(default)`                               | Firestore database id within that project (`src/lib/store.ts`).                                                                                                                      |
| `AGENT_TELEMETRY_WRITER_KEY_JSON`        | —                                         | Service-account key JSON for the real store's writer credentials.                                                                                                                    |
| `FIRESTORE_EMULATOR_HOST`                | —                                         | If set, writes to the emulator instead (takes precedence over the two above).                                                                                                        |
| `SESSION_PIN_TICK_BEARER`                | required (`bin/session-pin-tick.ts` only) | GitHub-Actions-OIDC bearer (`work.reaper` scope) the session-pin reaper reads the work API with — see `work-session-pin-tick.yml`. Unused by the daemon itself.                      |

The allowlist rows deliberately describe how their defaults are derived
rather than restating literals. The old deployment duplicated independently
encoded Claude and Codex paths, and one copy stayed stale after a repository
rename. A single required checkout-root list now derives Claude project slugs,
Codex cwd globs, and Antigravity prefixes together; missing scope fails startup
closed instead of silently watching a developer-specific fallback.

If neither the emulator host nor both of `AGENT_TELEMETRY_PROJECT_ID` /
`AGENT_TELEMETRY_WRITER_KEY_JSON` are set, the daemon falls back to a
log-only store — this is what lets `docker run` demonstrate the daemon
end-to-end without live GCP access (issue #2540's CI-only verification
scope). `runner sidecar` mode (above) adds a third path,
**tried after the writer-key-JSON path**: if `AGENT_TELEMETRY_PROJECT_ID`
is set but `AGENT_TELEMETRY_WRITER_KEY_JSON` is not, the store falls back to
ambient Application Default Credentials (`GOOGLE_APPLICATION_CREDENTIALS`,
set by the QueueExecutor direct runner to the agent-telemetry-writer SA's
short-lived credentials file) instead of a key JSON blob — see
`src/lib/create-store.ts`.

## Running

```bash
./tools/nx run @agent-lcars/telemetry-watcher:serve
```

## Session schema backfill

`session-schema-backfill-cli` is the only supported repair path for telemetry
documents written before explicit provider, repository, and archive
renderability metadata became mandatory. First inventory at most 200 current
documents with the telemetry writer identity, then prepare a reviewed JSON
manifest with an explicit `sessionId`, `agent`, `repo`, and (for issue-agent
sessions) `renderable` value for each record. It never guesses from a primary
repo, an archive URI, or a provider default. The command is dry-run by default;
`--apply` is the separately approved write step.

```bash
./tools/nx run @agent-lcars/telemetry-watcher:session-schema-backfill-cli
node dist/apps/telemetry-watcher-session-schema-backfill-cli/session-schema-backfill.cjs --inventory --limit 200
node dist/apps/telemetry-watcher-session-schema-backfill-cli/session-schema-backfill.cjs --manifest reviewed-sessions.json
node dist/apps/telemetry-watcher-session-schema-backfill-cli/session-schema-backfill.cjs --manifest reviewed-sessions.json --apply
```

The manifest is an operator-reviewed record, not generated data: for example,
`{"sessions":[{"sessionId":"...","agent":"codex","repo":{"owner":"jlapenna","name":"agent-lcars"}}]}`.
This is a one-time #1632 migration boundary. Keep the CLI and its fixed store
only until inventory, dry-run, apply, and a clean follow-up inventory are
recorded; phase 2 removes this target and the legacy readers together. It is
not a general Firestore administration surface.

## Bundle (runner sidecar)

The `bundle` Nx target produces the single self-contained file the
runner image bakes in and `direct-runner.sh` runs — esbuild with
`thirdParty: true` and no `external` list, so every
dependency (including `@google-cloud/firestore`, which is pure JS — no
native bindings in its transitive tree) is inlined into one `.cjs` file with
zero runtime `node_modules` dependency:

```bash
./tools/nx run @agent-lcars/telemetry-watcher:bundle
# -> dist/apps/telemetry-watcher/sidecar.cjs

# Verify it actually runs standalone (the script copies it out of the
# checkout so ambient node_modules resolution cannot hide a runtime failure):
./tools/telemetry-watcher-standalone-smoke.sh
```

Deliberately **not** in the default `build` target's dependency chain (a
separate `bundle` target, not depended on by anything on its own). CI runs the
same standalone check before any canonical image publish can be promoted:
esbuild inlines every dependency, so a transitive dep that cannot be inlined
can break only at runtime. QueueExecutor direct runners consume the bundle
only from the runner image; there is no separately published or downloaded
telemetry-tool runtime path.

## Deployment

Packaged as a Docker image (`apps/telemetry-watcher/Dockerfile` — see the
image comments for why `COPY . .` is cache-invalidated on every build and
how the cache mounts compensate; note the build context is the **repo
root**, not this directory).

**Canonical homelab publishes it.** After the reviewed source revision has
passed repository validation, run
`bin/publish-agent-lcars-images.sh telemetry-watcher` from the canonical
`jlapenna/homelab` checkout. It builds
`agent-lcars/telemetry-watcher` for linux/amd64, stages a commit-SHA tag,
scans it, and promotes `:latest` only after the scan passes.

That was not always true, and its absence caused a real outage: nothing in
the image was never built, so it only reached the registry when someone ran
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

Deployed to the `pike`, `laforge`, and `janeway` homelab hosts via Docker
Compose — chosen over the PRD's original "bundled systemd unit" plan to match
how the rest of the homelab fleet is managed. The compose file and deploy
script live in this repo, at [`deploy/`](deploy/README.md) — moved from `jlapenna/homelab` in
homelab#218 Phase 6, on the reasoning that the deployment config should
live with the image that builds it and the semantics (allowlists,
entrypoint, uid) it depends on. `jlapenna/homelab` owns the Prometheus scrape
and alerts for the deployment, including both the cAdvisor crash-loop signal
and this app's `/metrics` dead-man signal — see
`deploy/README.md`'s "Monitoring" section.

**Publishing does not deploy:** the compose file pins this image as
`tag@digest`, and Renovate is disabled for that LAN registry in this repo's
own `renovate.json` (its runner can't reach
`docker-registry.lan.jlapenna.net`), so moving the pin is still a human
step. Run [`deploy/sync-deploy.sh`](deploy/sync-deploy.sh) from a checkout on
each watcher host, then
[`deploy.sh`](deploy/README.md#deploying) from the synced homelab-readable
directory — the deploy is never run from the checkout itself (issue #1304).

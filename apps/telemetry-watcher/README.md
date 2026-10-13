# Agent LCARS Telemetry Watcher

Session telemetry tooling for the `agent-telemetry` Firestore store the
[Agent LCARS](../console) reads from. Live session telemetry comes from each
coding agent's own hooks through the `lcars hook` client
([Hook client](#hook-client-lcars-hook) below,
[docs/hooks-telemetry-design.md](../../docs/hooks-telemetry-design.md)).
This app ships:

- the `lcars` CLI bundle (`session-title-cli` target): session titles and the
  hook client, installed on workstations and baked into the runner image;
- the hook spool flusher (`hook-flush-cli` target);
- the runner bundle (`bundle` target, `sidecar.cjs`): QueueExecutor's
  `runner finalize` and `runner resume` passes.

The polling host watcher daemon (issue #2540) and the runner's live polling
sidecar are retired (hooks telemetry phase 3). The daemon's source and its
`serve` target remain in `src/main.ts` and `src/lib/daemon.ts`, but nothing
in this repository builds, publishes, or deploys it any more; see
[Legacy host watcher](#legacy-host-watcher-not-deployed).

## QueueExecutor issue-agent telemetry paths

CI issue-agent (`source: 'issue-agent'`) telemetry is provided by provider
hooks plus the standalone runner bundle (this app's `bundle` Nx target,
esbuild-bundled with every dependency inlined including
`@google-cloud/firestore`), baked into the self-hosted runner image at
`/usr/local/lib/agent-lcars/sidecar.cjs`
(this repo's own `apps/runner-autoscaler/runner-image/Dockerfile` builds
it from this repo's own `main` at image-build time — see issue #30; that
Dockerfile is the single source, and the former hand-synced duplicate in
`jlapenna/homelab` was removed along with the local-build fallback it
served). No download, no version pin to keep in
sync: the image build is the only "release" step, replacing a
publish-then-pin scheme whose pin silently went stale for months (#29).

1. **Mid-run, live (provider hooks — hooks telemetry phase 3):**
   `direct-runner.sh` installs the provider's hook entries for every
   pipeline (Claude Code and Codex through `lcars integration install`;
   OpenCode through the `lcars-telemetry.js` plugin already in the image's
   OpenCode config) and exports the run context the hook client stamps on
   each event. There is no selector and no polling fallback: if the hook
   install fails (for example, unreadable writer credentials) the run prints
   a `::warning::` and continues without live telemetry. This lights up
   Agent LCARS's In-Flight UI (#3092) with live turns and tokens while the
   job is running.

2. **Finalize, authoritative (`runner finalize` — issue #24):**
   `direct-runner.sh` finalizes once the provider exits: it first fences and
   drains the hook spool (so no late hook event can reopen an ended
   session), then runs `sidecar-lifecycle.sh finalize`, which does one last
   reduce pass with liveness hardcoded to `'ended'`, uploads the raw
   transcript to `AGENT_TELEMETRY_TRANSCRIPTS_BUCKET`, and upserts the
   authoritative final doc with `transcriptGcsUri` attached — see
   `src/lib/finalize.ts`. It runs whether or not live hooks were active, so
   every run still gets an ended doc and a browsable archived transcript.

3. **Resume, pre-run (`runner resume` — native work items sub-project 6):**
   `direct-runner.sh` runs it before the provider when the dispatched work
   carries a resume request —
   `node sidecar.cjs runner resume --session-id <id> --transcript-uri
<gcsUri> --cwd <dir>` — to download a prior session's archived
   transcript into the provider's local session store. See `src/main.ts`'s
   `_runRunnerResumeForTesting`. Fail-soft like finalize:
   prints nothing and never exits nonzero on a missing flag, an unsafe
   session id, or a failed download — a broken resume degrades to a fresh
   run rather than failing the dispatch.

## Legacy host watcher (not deployed)

> [!NOTE]
> This section and [Opt-in CLI transcript archives](#opt-in-cli-transcript-archives)
> describe the retired polling daemon (`node sidecar.cjs` with no
> subcommand). Its Docker image, Compose deploy bundle and Homelab
> deployment are removed; workstations report through
> [`lcars hook`](#hook-client-lcars-hook) instead. The code remains until a
> follow-up deletes it.

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
   Message bodies stay local unless the explicit CLI archive policy below consents to that individual session.
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

## Opt-in CLI transcript archives

Host-watcher only (see the note above); no deployment enables it.

CLI archival is **off by default**. Summary discovery and its existing project-dir
and cwd allowlists remain the privacy owner. No production upload policy is set
by this repository change. Consent to one session does not authorize uploading
other sessions in the same file or widening a watch root.

The host-only `AGENT_TELEMETRY_CLI_ARCHIVE_POLICY` accepts an explicit JSON object:

```json
{
  "bucket": "operator-owned-cli-archives",
  "sessionIds": ["specific-cli-session-id"],
  "enabledAfter": "2026-10-09T00:00:00.000Z"
}
```

The operator selects at most 100 exact safe session IDs; globs are rejected.
`enabledAfter` is a deliberate consent cutoff: sessions started before it are
never archived. The normal discovery gate must still accept the session, and
at least one of that root's project-dir/cwd allowlists must be restrictive.
Only file-backed Claude Code and Codex sessions support console transcripts.
Antigravity summary-DB rows never upload local history. A live/idle session is
pending; an ended session uploads its own bounded file through the existing
provider adapter. Changed bytes are revalidated before upload; mixed-session
files, malformed records, escaped/symlink paths, and excluded cwd are rejected.

Limits and failure behavior:

- Maximum archive and console download: **5 MiB**. Oversized sessions retain
  their summary and show a size-limit state; no partial transcript is uploaded.
- Console access expires at last activity + **30 days**, matching CLI ledger
  retention. The destination must have a Delete lifecycle age of **30 days or
  less** applying to all objects or the `cli/` prefix, no versioning, no
  retention lock, and explicit zero soft-delete retention. It must enforce
  uniform bucket-level access and public-access prevention. The writer checks
  these properties before each upload and refuses the runner bucket's
  archived-version-only lifecycle. GCS lifecycle deletion is asynchronous:
  objects become eligible by 30 days after upload; console access is blocked
  at the earlier ledger expiry. Re-uploading changed transcripts resets object
  age, not the console's last-activity retention rule.
- Upload/bucket-policy failures preserve summary reporting and show unavailable;
  retries are limited to once per minute per unchanged session. Storage retries
  have a 30-second budget. A missing/denied/expired archive never hides the
  session header or becomes a page error.
- The admin-only detail route uses the existing server storage reader, provider
  timeline parser, elision and safe Markdown renderer. Raw HTML and dangerous
  URL schemes are not executed. Raw transcript bodies never enter ledger docs.
- Removing consent and restarting the watcher clears the CLI archive reference
  on the next discovered-session write. Previously stored objects remain subject
  to the bucket lifecycle; this is not an immediate object-erasure operation.

### Operator handoff (separate approved operation)

Homelab owns host configuration, bucket provisioning and credentials. Before
activation, review the selected sessions/cutoff and the destination's private
retention policy. The existing host writer identity needs object creation and
bucket-metadata read access there; the console's runtime identity needs object
read access. The host upload path uses `AGENT_TELEMETRY_WRITER_KEY_JSON` (or
ambient ADC when absent), never a new committed credential. Any Terraform/IAM
change, secret delivery, image publication, host restart or production activation
requires its separately scoped approved operation.

Supply the policy through an operator-owned Compose environment override for
`agent-lcars-telemetry-watcher`; the checked-in deployment intentionally does not
enable it. Keep the existing read-only mounts and allowlists. Verify the bucket
policy, archive a specifically consented session, inspect its `/sessions/<id>`
detail and an excluded session, and record the deployed image digest. To disable,
remove that policy override and restart through the approved host workflow.

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
  `CODEX_THREAD_ID`. Claude and Codex export their native variables directly;
  the runner's OpenCode `shell.env` plugin maps OpenCode's native session id
  to `LCARS_SESSION_ID` for each tool call. The first one present _and_ passing `isSafeIdentifier`
  wins — a present-but-unsafe value is a hard failure, not a fall-through to
  the next candidate, so a malformed id can never silently retarget another
  runtime's session. The CLI writes
  `~/.local/state/agent-lcars/session-metadata/<sessionId>.json` directly
  (crash-safe rename-into-place, mode 0700); it never goes through this
  daemon. Nothing installs the `lcars` binary automatically on a
  workstation — see [Installing the `lcars` CLI](#installing-the-lcars-cli).

For Codex, the watcher derives its inferred title from the first real user
input in watched rollout JSONL. Claude's `aiTitle` remains a transcript-derived
generated title.

## Hook client (`lcars hook`)

The hook client is the live telemetry path for workstations and dispatched
workers, described in
[docs/hooks-telemetry-design.md](../../docs/hooks-telemetry-design.md):
each coding agent's own hooks run `lcars hook <runtime>` (Claude Code and
Codex; OpenCode reports through its `lcars-telemetry.js` plugin), which reads one hook payload on stdin, reduces the session's
transcript with the same summary-only reducer, and appends a
`SessionEventV1` to a local spool. A detached `lcars hook flush` then writes
each event to the `sessions` collection as the `telemetry-writer` service
account, in one Firestore transaction
that refuses an event older than what is stored.

The hook process never touches the network, never prints to stdout, and
always exits 0. Every decision is one line in
`~/.local/state/agent-lcars/hook.log`.

### Host setup

1. `~/.config/agent-lcars/config.json` names the repositories whose
   sessions may be reported; anything else is skipped before the transcript
   is read (the privacy boundary):

   ```json
   { "repos": ["jlapenna/*", "supersprinklesracing/*"] }
   ```

   Matching ignores case, and the session is not stored under the `origin`
   remote's spelling: a matching literal `owner/name` entry supplies its own
   spelling, and a match through a `*` pattern stores the full lowercase
   `owner/name`, so Console's repo lookups find a checkout cloned as
   `JLapenna/Agent-LCARS`. List a repository whose canonical name has
   capitals as a literal `Owner/Name` entry.
   `AGENT_TELEMETRY_REPO_ALIASES` rename entries apply first and are stored
   verbatim.

2. `~/.config/agent-lcars/writer-key.json` (mode 0600) holds the
   `telemetry-writer` key, the value of `AGENT_TELEMETRY_WRITER_KEY_JSON`.
   The environment variable of that name overrides the file; on a runner,
   `GOOGLE_APPLICATION_CREDENTIALS` is used. Without credentials events stay
   in the spool (capped at 5 MB) until one appears.

3. Install the hook entries and their launcher stubs:

   ```bash
   lcars integration install all      # or: claude | codex
   lcars integration status all
   ```

   This writes `~/.claude/hooks/lcars-hook.sh` and `~/.codex/lcars-hook.sh`
   (versioned, `# LCARS_INTEGRATION_VERSION=N`) and appends one constant
   entry per lifecycle event to `~/.claude/settings.json` and
   `~/.codex/hooks.json`, leaving every other key and hook untouched.
   Codex hashes the entry, not the script, so it is trusted once per host
   (`/hooks` in the Codex TUI) and never again. `uninstall` removes exactly
   what `install` added.

`lcars hook flush` drains the spool by hand (`~/.local/state/agent-lcars/spool/`),
and `lcars hook <runtime> --inline` posts synchronously for debugging. The
legacy daemon code still skips any session whose
`~/.local/state/agent-lcars/hook-sessions/<sessionId>.json` marker is
younger than ten minutes, so a host still running an old daemon never races
the hook client on one doc.

## Configuration

All via environment variables (see `src/lib/config.ts`):

| Variable                                 | Default                                 | Purpose                                                                                                                                                                                                                                         |
| ---------------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AGENT_TELEMETRY_CHECKOUT_ROOTS`         | required without explicit roots         | Comma-separated checkout roots used by the host fallback and deploy script to construct privacy allowlists.                                                                                                                                     |
| `AGENT_TELEMETRY_WATCH_ROOTS`            | deployed host contract                  | JSON array of explicit per-agent roots and privacy allowlists.                                                                                                                                                                                  |
| `AGENT_TELEMETRY_CLAUDE_PROJECTS_DIR`    | `~/.claude/projects`                    | Runner-mode fallback only.                                                                                                                                                                                                                      |
| `AGENT_TELEMETRY_CODEX_SESSIONS_DIR`     | `~/.codex/sessions`                     | Runner-mode fallback only.                                                                                                                                                                                                                      |
| `AGENT_TELEMETRY_ANTIGRAVITY_SUMMARY_DB` | `~/.gemini/antigravity-cli/…`           | Antigravity summary-tier SQLite DB. Set to the empty string to disable the poller; its workspace prefixes follow the configured checkout roots.                                                                                                 |
| `AGENT_TELEMETRY_SESSION_STATE_DIR`      | `~/.local/state/agent-lcars`            | Declared-title overlay root — `session-metadata/`. Empty string disables the overlay, same convention as `AGENT_TELEMETRY_ANTIGRAVITY_SUMMARY_DB` above. See "Session titles" above.                                                            |
| `AGENT_TELEMETRY_HOST`                   | `os.hostname()`                         | Host label recorded on each session doc.                                                                                                                                                                                                        |
| `AGENT_TELEMETRY_HEARTBEAT_INTERVAL_MS`  | `10000`                                 | Tick interval.                                                                                                                                                                                                                                  |
| `AGENT_TELEMETRY_STALENESS_WINDOW_MS`    | `heartbeatIntervalMs * 5`               | How long a session can go unrediscovered before it's marked `stale`.                                                                                                                                                                            |
| `AGENT_TELEMETRY_SHARE_DIR`              | `~/share`                               | Root for the share-media skill convention; artifact discovery is skipped entirely when unset.                                                                                                                                                   |
| `AGENT_TELEMETRY_METRICS_HOST`           | `0.0.0.0`                               | Address for the host watcher's Prometheus endpoint. Runner sidecar/finalize modes never start it.                                                                                                                                               |
| `AGENT_TELEMETRY_METRICS_PORT`           | `9464`                                  | Port for the host watcher's `/metrics` endpoint.                                                                                                                                                                                                |
| `AGENT_TELEMETRY_PROJECT_ID`             | —                                       | Firestore project id for the real store.                                                                                                                                                                                                        |
| `AGENT_TELEMETRY_DATABASE_ID`            | `(default)`                             | Firestore database id within that project (`src/lib/store.ts`).                                                                                                                                                                                 |
| `AGENT_TELEMETRY_WRITER_KEY_JSON`        | —                                       | Service-account key JSON for the real store's writer credentials.                                                                                                                                                                               |
| `FIRESTORE_EMULATOR_HOST`                | —                                       | If set, writes to the emulator instead (takes precedence over the two above).                                                                                                                                                                   |
| `SESSION_EXPIRY_BEARER`                  | required (`bin/session-expiry.ts` only) | GitHub-Actions-OIDC bearer (`work.reaper` scope) the session-expiry script reads the work API with — see `work-session-expiry.yml`. `SESSION_EXPIRY_ITEM` names the closed item; empty clears expiry for every open item. Unused by the daemon. |

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
scope). Runner mode (`runner finalize`, above) adds a third path,
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

## Bundle (runner finalize/resume)

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

## Installing the `lcars` CLI

The `lcars session title "..."` and `lcars hook` commands depend on a
`lcars` launcher existing on the workstation — nothing installs it
automatically. From the primary `~/p/agent-lcars` checkout (the one that
persists on the host long-term; this builds an Nx target, so it needs a real
checkout, and the checkout's own `dist/` is never referenced directly — see
the script's header for why):

```bash
apps/telemetry-watcher/bin/install-session-title-cli.sh
```

This builds the `session-title-cli` Nx target and copies its bundle to
`~/.local/lib/agent-lcars/lcars-session-title.cjs` (override with
`AGENT_LCARS_SESSION_TITLE_CLI_LIB_DIR`), then generates a `lcars` launcher
at `~/.local/bin/lcars` (override with
`AGENT_LCARS_SESSION_TITLE_CLI_BIN_DIR`) that resolves `node` itself —
covering this fleet's fnm-managed installs, where the CLI shim isn't
reliably on PATH for every caller. Add `~/.local/bin` to the account's PATH
for interactive use. Re-run this script after any change to the CLI lands on
that checkout's `main`. Then follow [Host setup](#host-setup) to install the
hook entries.

The runner image bakes its own copy (`apps/runner-autoscaler/runner-image/lcars.sh`).

## Deployment

There is no host deployment. The former per-host daemon image
(`apps/telemetry-watcher/Dockerfile`), its `docker-build` target and the
`deploy/` Compose bundle were removed with hooks telemetry phase 3; Homelab
retires its deploy play, image publish, scrape and alerts separately
(jlapenna/homelab#2405). The runner image builds this app's bundles from
source in its own `telemetry-watcher-build` stage.

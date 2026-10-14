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
sidecar are retired (hooks telemetry phase 3) and their code is deleted:
`node sidecar.cjs` with no `runner <finalize|resume>` subcommand is a usage
error, and `runner sidecar` is a logged no-op kept only so a stale caller
cannot fail a job.

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

## Archived CLI transcripts (reader only)

The retired host daemon could archive individually consented CLI
transcripts (`AGENT_TELEMETRY_CLI_ARCHIVE_POLICY`) and record a
`cliTranscriptArchive` pointer on the session doc. That writer is deleted;
nothing creates new CLI archives. The console still renders a doc that
carries an unexpired pointer (bounded by `CLI_TRANSCRIPT_MAX_BYTES` in
`@agent-lcars/telemetry`), and a hook write carries an existing pointer
forward rather than clearing it. Stored objects remain subject to their
bucket's lifecycle.

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
  (crash-safe rename-into-place, mode 0700). Nothing installs the `lcars` binary automatically on a
  workstation — see [Installing the `lcars` CLI](#installing-the-lcars-cli).

For Codex, the reducer derives its inferred title from the first real user
input in the rollout JSONL. Claude's `aiTitle` remains a transcript-derived
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
and `lcars hook <runtime> --inline` posts synchronously for debugging.

## Configuration

All via environment variables (see `src/lib/config.ts` and, for the hook
client, `src/lib/hook/hook-config.ts`):

| Variable                              | Default                                 | Purpose                                                                                                                                                                                                                   |
| ------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AGENT_TELEMETRY_CLAUDE_PROJECTS_DIR` | `~/.claude/projects`                    | Runner finalize/resume default.                                                                                                                                                                                           |
| `AGENT_TELEMETRY_CODEX_SESSIONS_DIR`  | `~/.codex/sessions`                     | Runner finalize/resume default.                                                                                                                                                                                           |
| `AGENT_TELEMETRY_HOST`                | `os.hostname()`                         | Host label the hook client records on each session doc.                                                                                                                                                                   |
| `AGENT_TELEMETRY_PROJECT_ID`          | —                                       | Firestore project id for the real store.                                                                                                                                                                                  |
| `AGENT_TELEMETRY_DATABASE_ID`         | `(default)`                             | Firestore database id within that project (`src/lib/store.ts`).                                                                                                                                                           |
| `AGENT_TELEMETRY_WRITER_KEY_JSON`     | —                                       | Service-account key JSON for the real store's writer credentials.                                                                                                                                                         |
| `FIRESTORE_EMULATOR_HOST`             | —                                       | If set, writes to the emulator instead (takes precedence over the two above).                                                                                                                                             |
| `SESSION_EXPIRY_BEARER`               | required (`bin/session-expiry.ts` only) | GitHub-Actions-OIDC bearer (`work.reaper` scope) the session-expiry script reads the work API with — see `work-session-expiry.yml`. `SESSION_EXPIRY_ITEM` names the closed item; empty clears expiry for every open item. |

`runner finalize` picks its store in this order: the emulator when
`FIRESTORE_EMULATOR_HOST` is set; the writer key JSON when both
`AGENT_TELEMETRY_PROJECT_ID` and `AGENT_TELEMETRY_WRITER_KEY_JSON` are set;
when only `AGENT_TELEMETRY_PROJECT_ID` is set, ambient Application Default Credentials (`GOOGLE_APPLICATION_CREDENTIALS`,
set by the QueueExecutor direct runner to the agent-telemetry-writer SA's
short-lived credentials file). With none of those it falls back to a
log-only store, which is what lets the standalone bundle smoke test run
`runner finalize` end to end without GCP access — see
`src/lib/create-store.ts`.

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
# checkout so ambient node_modules resolution cannot hide a runtime failure,
# then runs a credential-free `runner finalize` over a one-session fixture):
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

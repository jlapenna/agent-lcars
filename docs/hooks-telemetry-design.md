# Hooks-based session telemetry (design)

Status: shipped. Owner: telemetry. Hooks are the only live telemetry path for
Claude Code, Codex, and OpenCode on workstations and QueueExecutor runners. The
polling host watcher daemon (`apps/telemetry-watcher` host mode, #2540) and the
runner's live polling sidecar are retired and their code is deleted; the
workstation CLI installer is
`apps/telemetry-watcher/bin/install-session-title-cli.sh`.

## GitHub actor observation for spend attribution

The Claude CLI hook observes `githubActor` through GitHub's authenticated `/user`
endpoint using its existing `gh` credential, after event throttling. The read
has a two-second deadline and a 4 KiB output bound. It is not derived from the
transcript or git author configuration. Failed identity/branch reads leave
record-based PR attribution unavailable, without blocking telemetry shipping;
runner, Codex and OpenCode hooks do not perform this read. The spool whitelist preserves the
actor and successful correlated `publicationCandidates` through the session
writer. Candidates remain unqualified until the Console checks GitHub's stored
creation/head/author facts. See [cost-ledger.md](cost-ledger.md) for the matching,
offline and rollout contract.

## Runners and OpenCode

**Runners:** every QueueExecutor pipeline (Claude, Codex, OpenCode) reports
through hooks unconditionally (`runtime/hook-telemetry-bootstrap.sh`); the
flusher uses the runner's telemetry-writer credentials file through
`LCARS_TELEMETRY_CREDENTIALS_FILE`. The executor ignores the retired
`LCARS_HOOK_TELEMETRY_PROVIDERS` selector if a deployment still sets it. A
failed hook install
(for example, unreadable credentials) prints a `::warning::` and the run
continues without live telemetry; there is no polling fallback.
`sidecar-lifecycle.sh finalize` still writes the authoritative ended doc
after the hook spool is fenced and drained, and `runner resume` is
unchanged.

**OpenCode client:** OpenCode has no command hooks, so
`agents/opencode/lcars-telemetry.js` is a plugin. On `session.created`, a new
user message, a completed tool part (throttled to one report per 15 s), and
`session.idle` it reads the session through the SDK client, writes an
export-shaped `{info, messages}` snapshot to a private temp file, and hands it
to a detached `lcars hook opencode` as `transcript_path`, so the same reducer
that reads `opencode export` output produces the summary. `session.deleted`
fires after OpenCode has removed the session, so its `SessionEnd` is
lifecycle-only: no snapshot and no summary, with `cwd` taken from the event.
The client deletes the snapshot after reading it, which lets the final report
survive `opencode run` exiting on its last idle. OpenCode never awaits plugin
event handlers, so `opencode run` can exit while the idle report is still
snapshotting; the plugin's `dispose` hook, which OpenCode does await at
shutdown, waits up to 5 s for reports in flight. Without it a loaded host lost
the stop in 3 of 7 runs. Reports for one session never
overlap; events arriving mid-report coalesce to the most important one.
Subagent sessions (`parentID` set) are never snapshotted. `lcars integration
install opencode` copies the plugin into
`${XDG_CONFIG_HOME:-~/.config}/opencode/plugins/`; the runner image ships it
in its OpenCode config instead, where it stays inert unless the bootstrap
exported `LCARS_TELEMETRY_CREDENTIALS_FILE`.

## 1. Problem

Every session LCARS shows today is observed from the outside by a
long-running daemon that polls disk:

| Pain                                 | Where it comes from today                                                                                     |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| Session discovery is a guess         | `~/.claude/projects/**/*.jsonl` + `~/.codex/sessions/**` glob, filtered by a checkout-root allowlist          |
| Liveness is a heuristic              | transcript mtime + a `/proc/*/cwd` scan + "did we rediscover the file this tick"                              |
| Allowlist drift is silent            | pike reported 0 live sessions for weeks while ~10 ran (homelab#202, README "Deployment")                      |
| Deploy drift is a human step         | publish image, move the `tag@digest` pin, `sync-deploy.sh`, `deploy.sh` on each of 3 hosts                    |
| A daemon per host                    | compose service, root-owned writer key, Prometheus dead-man alert, 10 s tick, `fs.watch` nudges               |
| Runner sidecar lifecycle             | `sidecar-lifecycle.sh start` → `job-daemon.sh` → bounded stop-wait before `finalize`                          |
| Agent → LCARS side channel is a file | `lcars session title/status` writes `~/.local/state/agent-lcars/session-metadata/*.json`, picked up next tick |
| OpenCode CLI sessions are invisible  | no host-mode adapter; only the runner's SQLite export path exists                                             |

Every one of these exists because the daemon does not know _which_ session
is running, _where_, or _whether it is still alive_. The agent runtimes do,
and all three now expose that knowledge through hooks.

## 2. Goal and non-goals

Goal: the agent runtime tells LCARS about its own session through native
hooks, so that the host watcher daemon is no longer needed for Claude Code,
Codex, or OpenCode sessions on workstations or runners. Session docs keep the
exact `SessionDoc` contract (`libs/telemetry/src/lib/types.ts`), so the
console, the Decision Inbox, `/agents`, `/sessions`, and `displayLiveness`
need no schema change.

Non-goals:

- Shipping message bodies. The reducer's summary-only boundary stays
  (counters, deliverables, timeline digests, never text). Hook payloads
  contain `prompt` and `tool_input`; they are read and discarded locally.
- Replacing `runner finalize` (GCS transcript upload + authoritative final
  doc, `src/lib/finalize.ts`). That is a one-shot command, not a daemon, and
  it needs the whole transcript file after provider exit.
- Antigravity. It has no hook surface; see section 7.

## 3. Runtime hook surfaces

| Runtime             | Config location                                                                  | Events used                                                                                                         | Notes                                                                                                                                                                                                                                                                                                                              |
| ------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code 2.1.296 | `~/.claude/settings.json` (user), `--settings <file>` (runner), project settings | `SessionStart`, `UserPromptSubmit`, `PostToolUse`, `Stop`, `Notification`, `StopFailure`, `SessionEnd`              | stdin JSON: `session_id`, `transcript_path`, `cwd`, `permission_mode`, `hook_event_name`; `SessionStart` adds `source`, `model`, `session_title`. `async: true` supported. `SessionEnd` budget 1.5 s, raised by per-hook `timeout` up to 60 s.                                                                                     |
| Codex 0.162.1       | `~/.codex/hooks.json`, `<repo>/.codex/hooks.json`, `requirements.toml` (managed) | `SessionStart`, `UserPromptSubmit`, `PostToolUse`, `Stop`, `SessionEnd`, `Interrupt`                                | Same field names plus `model`, `turn_id`; under `codex exec` `transcript_path` was a real rollout file (verified). Command hooks accept `"async": true` (docs; up to eight background hooks per session). Non-managed hooks need trust against their hash; `--dangerously-bypass-hook-trust` for automation. `SessionEnd` max 3 s. |
| OpenCode 1.18.35    | plugin in `~/.config/opencode/plugins/` or `opencode.json` `plugin: [...]`       | `event`: `session.created/updated/status/idle/error`, `message.updated`, `message.part.updated`, `permission.asked` | In-process JS. `AssistantMessage` carries `tokens.{input,output,reasoning,cache.read,cache.write}`, `cost`, `modelID`; no transcript parse needed. Already ships `agents/opencode/lcars-session.js`.                                                                                                                               |

Rejected: Claude Code `type: "http"` hooks posting straight to LCARS. They
would send `prompt`/`tool_input` bodies off-host, cannot compute tokens
without the transcript, and are unsupported on `SessionStart`.

## 4. Architecture

```
Claude Code ──command hook──▶ lcars hook claude   ─┐
Codex       ──command hook──▶ lcars hook codex    ─┼─▶ privacy gate ─▶ reduce transcript ─▶ SessionEventV1 ─▶ ~/.local/state/agent-lcars/spool/
OpenCode    ──plugin event──▶ lcars-telemetry.js  ─┘   (repo allowlist)  (@agent-lcars/telemetry)                   │
                                                                                                                     ▼
                                                    detached `lcars hook flush` (telemetry-writer) ─▶ buildSessionDoc ─▶ Firestore sessions/{id}
```

Three pieces:

1. **Client** `lcars hook <runtime>` (new subcommand in the existing
   `session-title-cli` bundle, `apps/telemetry-watcher/src/session-title-cli.ts`).
   Reads one hook payload on stdin, never prints to stdout, always exits 0.
2. **Flusher** `lcars hook flush` (the `hook-flush-cli` bundle). Writes each
   spooled event as the `telemetry-writer` service account in a Firestore
   transaction, building the doc with the shared `buildSessionDoc` and the
   existing merge + `clearFields` semantics (4.4).
3. **Distribution**: homegit manages the hook JSON for workstations; the
   runner image bakes a `--settings` file, a `CODEX_HOME` hooks file, and the
   OpenCode plugin.

### 4.1 Client: `lcars hook`

Pipeline per invocation, target under 300 ms for the hot path:

1. Parse stdin. Unknown `hook_event_name` → exit 0.
2. **Privacy gate.** Resolve `git -C <cwd> config --get remote.origin.url`
   and match `owner/name` against `~/.config/agent-lcars/config.json`
   `repos: ["jlapenna/*", ...]`. No match → exit 0 and write nothing. A cwd
   outside every checkout ships without a repo only when it is at or below a
   configured `workspaces` root; otherwise it is dropped the same way. This replaces the checkout-root path allowlist with the same
   identity the daemon already resolves per tick (`SessionSummary.repo`).
   Runner mode (`LCARS_RUN_ID` set) bypasses the gate, exactly as
   `runnerWatchRoots` allowlists `['*']` today.
3. **Throttle.** Per-session state file
   `~/.local/state/agent-lcars/hook-sessions/<sessionId>.json` records
   `lastShippedAt`, `lastEventSeq`, `transcriptBytes`. `PostToolUse` ships
   only if ≥ 15 s since the last ship; otherwise touch the file and exit.
   `SessionStart`, `UserPromptSubmit`, `Stop`, `SessionEnd`, `Notification`
   always ship. This bounds Firestore writes to roughly what the daemon does
   now (one write per ≤ 10 s tick when changed).
4. **Reduce.** `reduceTranscriptLines` through `claudeCodeAdapter` /
   `codexAdapter` on `transcript_path` (Codex: fall back to
   `$CODEX_HOME/sessions/**/<session_id>*.jsonl` when null). Join the
   declared title/status overlays from `session-metadata/` so
   `lcars session title/status` keep working unchanged. Follow-up: an
   incremental reducer keyed on byte offset once transcripts over a few MB
   show up in the hook log.
5. **Lifecycle.** Map the event to a liveness assertion (see 4.3) and an
   optional `attention` value.
6. **Ship.** Append the event to `spool/<host>.ndjson` (cap 5 MB, oldest
   dropped), then `spawn` a detached `lcars hook flush` that writes it to
   Firestore and exits 0 whatever happens. The hook process itself never
   touches the network, so its wall time is parse + gate + reduce only. This
   matters for Codex, whose hooks are synchronous, and for Claude Code's
   `SessionStart`, which cannot be `async`.
7. **SessionEnd** (Claude 1.5 s, Codex 3 s budgets): same path as step 6;
   the detached flusher survives the parent CLI exiting.

Logging goes to `~/.local/state/agent-lcars/hook.log` (size-rotated, no
titles, no paths beyond the repo slug, matching the CLI's current
"never disclose" rule).

### 4.2 Event contract

```ts
interface SessionEventV1 {
  version: 1;
  eventId: string; // uuid, dedupe key
  seq: number; // per-session monotonic, from the state file
  occurredAt: string; // ISO
  host: string;
  agent: SessionAgent; // 'claude-code' | 'codex' | 'opencode'
  sessionId: string;
  kind:
    | 'start'
    | 'prompt'
    | 'tool'
    | 'stop'
    | 'end'
    | 'attention'
    | 'annotation'
    | 'heartbeat';
  liveness?: 'live' | 'idle' | 'ended'; // assertion, see 4.3
  attention?: 'permission' | 'idle_prompt' | 'rate_limit' | 'error' | null;
  summary?: SessionSummary; // reducer output, summary-only (existing type)
  runner?: {
    runId: string;
    intentId?: string;
    issueNumber?: number;
    repo: SessionRepository;
  };
}
```

`summary` is the existing `SessionSummary`, so `buildSessionDoc` is reused
verbatim. OpenCode's plugin fills `summary` from `AssistantMessage` fields
instead of a transcript (tokens, cost, `modelID`, tool counts from
`ToolPart.state.status === 'completed'`).

### 4.3 Liveness becomes event-driven

| Event                     | Stored `liveness` | `observedAt` |
| ------------------------- | ----------------- | ------------ |
| `start`, `prompt`, `tool` | `live`            | now          |
| `stop`                    | `idle`            | now          |
| `end`                     | `ended`           | now          |
| no event for > 10 min     | (unchanged)       | (old)        |

The console already recomputes display state with `displayLiveness(stored,
lastActivityAt, now, observedAt)`: a stored `live`/`idle` whose
`observedAt` is older than 10 min falls through to the age-based
`idle`/`ended`. A crashed CLI that never sends `end` therefore ages out
exactly as a lost daemon heartbeat does today, with no code change. The
`/proc` cwd scan and `heartbeatReceived` → `stale` path were deleted with the
daemon.

`attention` is new, and small: `Notification(permission_prompt|idle_prompt)`
sets it, the next `prompt`/`tool` clears it (via `clearFields`, extending
`ClearableSessionField`). The Decision Inbox gets "waiting on you" for
interactive sessions, which no transcript-derived signal can produce.

### 4.4 Store writes

The flusher writes each spooled event itself as the `telemetry-writer`
service account (the identity `runner finalize` uses). There is no console
ingest route: one was built behind host tokens and removed before it was
enabled, because it would have given the console's App Hosting identity write
access to the telemetry database, which it holds read-only by design. Each
enrolled workstation therefore holds the writer key at
`~/.config/agent-lcars/writer-key.json`, delivered by homegit; runners use
`LCARS_TELEMETRY_CREDENTIALS_FILE` (4.5).

- **Dedupe/order.** Firestore transaction on `sessions/{id}`: it re-reads the
  stored doc and drops an event whose `seq` is not newer than the stored
  hook observer from the same `host`. Out of order `end` after `tool` is
  therefore impossible to regress.
- **Write.** `buildSessionDoc(summary, { observedAt: now, forceSource:
runner ? 'issue-agent' : 'cli', ...runner })`, then override `liveness`
  from the event, then the existing `SessionWrite` upsert (merge +
  `FieldValue.delete()` for cleared fields). `observer: { kind: 'hook',
runtime, clientVersion }` records provenance.
- **Token minutes.** The same transaction knows the stored cost-weighted
  token total, so each write also records how much it grew, credited to the
  event's minute, in `tokenMinutes` (the last 30 minutes;
  `nextTokenMinutes` in `libs/telemetry`). The console's Tokens / min readout
  sums it over sessions active in the window. Only growth above
  `tokenMinutesBase`, the highest total already credited, counts, so a total
  that dips and recovers is not credited twice. A first write credits nothing;
  a writer that does not re-read the doc leaves the field absent, and the
  readout marks that session unmeasured.

### 4.5 Runner mode changes

`direct-runner.sh` today: `sidecar-lifecycle.sh start` (daemon) → provider →
`sidecar-lifecycle.sh finalize`. After this design:

- Claude: add `--settings /usr/local/lib/agent-lcars/claude-telemetry-hooks.json`
  to the `claude --print` invocation. Hooks merge additively with any
  repo-level settings, so onboarded repos keep their own hooks.
- Codex: copy `/usr/local/lib/agent-lcars/codex-telemetry-hooks.json` into
  `$CODEX_HOME/hooks.json` after the `cp -a "$HOME/.codex/."` step and pass
  `--dangerously-bypass-hook-trust` to `codex exec` (the image is the vetted
  hook source; the flag is scoped to that invocation).
- OpenCode: add `./lcars-telemetry.js` to `agents/opencode/opencode.json`
  `plugin` next to `lcars-session.js`.
- Env for the client: `LCARS_RUN_ID`, `INTENT_ID`, `NUM`, `LCARS_REPO`, and
  `LCARS_TELEMETRY_CREDENTIALS=/run/secrets/telemetry-writer.json`.
- Delete the `start` mode of `sidecar-lifecycle.sh` and the `telemetry`
  job-daemon; `finalize` and `resume` stay exactly as they are. The
  bounded stop-wait before finalize disappears with the daemon. (The shipped
  runner installs hooks with `lcars integration install` rather than baked
  `--settings` files.)

In-Flight UI latency improves from a 10 s tick to the hook (seconds).

### 4.6 Workstation distribution (homegit)

- `dot_claude/modify_settings.json` MANAGED gains the hook entries in
  section 5.1. Existing tmux/herdr hooks are untouched; entries merge.
- `dot_codex/modify_hooks.json` gains section 5.2; it appends per-event
  groups and preserves user groups (verified in its `main()`). Trust: Codex
  persists `[hooks.state."<hooks.json path>:<event_snake_case>:<group>:<hook>"]
trusted_hash = "..."` in `~/.codex/config.toml`, and homegit's
  `homegit-codex-config` helper already overlays `config.desired.toml`
  leaves onto the live file while keeping unknown content. The value is
  `sha256:<64 hex>`, but it is not a plain SHA-256 of the hook command, the
  hook object, or the group in any common JSON serialization (17 candidates
  tested against this host's four trusted entries). Two things make this a
  non-problem: the hook entry is a constant launcher stub (section 4.7), so
  it is trusted once per host and never changes; and fleet hosts can carry
  it as a managed hook, since Codex trusts hooks from `requirements.toml`
  `[hooks]` by policy and `allow_managed_hooks_only = true` can refuse
  everything else.
- `~/.config/opencode/plugins/lcars-telemetry.js` installed by homegit.
- `lcars` binary: stop relying on the manual
  `bin/install-session-title-cli.sh` (formerly `deploy/`). `packages/fleet-tools`
  (`@agent-lcars/agent-tools`) is dependency-free committed scripts packed
  straight from a sparse clone by homegit's
  `homegit-repo-tools-bootstrap.sh`, so a built esbuild bundle does not fit
  there. Instead a workflow on `main` builds the `session-title-cli` target
  and uploads `lcars-session-title.cjs` as a GitHub Release asset tagged
  `lcars-cli/<sha>`; the same bootstrap script downloads the latest asset
  (checksum pinned in the chezmoi source) to `~/.local/lib/agent-lcars/` and
  writes the `~/.local/bin/lcars` launcher. `install-session-title-cli.sh`
  stays for development.
- Credentials: `~/.config/agent-lcars/writer-key.json` (mode 0600), the
  `telemetry-writer` key delivered by homegit (4.4).
- Config: `~/.config/agent-lcars/config.json` `{ "repos": ["jlapenna/*"] }`
  derived from the same source the retired daemon deploy's
  `AGENT_TELEMETRY_CHECKOUT_ROOTS` came from.

### 4.7 Patterns borrowed from herdr

Herdr already integrates with the same three runtimes through hooks on
this fleet (`~/.claude/hooks/herdr-agent-state.sh`,
`~/.codex/herdr-agent-state.sh`, `herdr integration install <runtime>`).
Its choices were made under the same constraints and this design adopts
them:

- **Self-installing integration.** `lcars integration install claude|codex|opencode|all`
  writes the launcher script, idempotently, with `# LCARS_INTEGRATION_ID` /
  `# LCARS_INTEGRATION_VERSION` headers so `lcars integration status` can
  report an outdated or hand-edited install, and appends the hook entries on
  hosts nobody else manages. On homegit-managed hosts the entries live in
  homegit's managed hook JSON instead, because `modify_settings.json`
  replaces the whole `hooks` key on every apply and would erase anything the
  installer added; the entries are constant strings, so both owners agree
  byte for byte. homegit's `run_onchange_after_35-homegit-lcars-telemetry`
  runs the installer for the stub, writes `writer-key.json` from the
  `AGENT_TELEMETRY_WRITER_KEY_JSON_B64` secret, and seeds `config.json`.
  `uninstall` removes exactly what `install` added and nothing else.
- **Constant hook entry, versioned script.** The settings entry is
  `[ -x "$HOME/.claude/hooks/lcars-hook.sh" ] && sh "$HOME/.claude/hooks/lcars-hook.sh" || true`
  (same for `~/.codex/lcars-hook.sh`). The script execs the `lcars` bundle.
  Behavior lives in the bundle, so Codex trust is granted once and the
  Claude and Codex entries never drift between hosts.
- **Stdin to a temp file first.** The launcher copies stdin to `mktemp`
  before doing anything else and deletes it on exit, so a slow or failing
  client never leaves the runtime blocked on a pipe.
- **Skip what is not a session.** Claude and OpenCode payloads with
  `agent_id` remain parent-owned. A Codex child is collected only when its
  first rollout metadata matches `agent_id` and the hook's parent
  `session_id`/fork relationship,
  `agent_transcript_path` or an exact-ID rollout lookup supplies the child
  transcript, and an explicit child-thread boundary excludes inherited history, and matching
  thread usage is present. Its own suffix uses the normal publication guards;
  copied parent counters never become child usage. Unverified children remain
  uncollected, rather than emitting invented usage. The Codex integration also
  registers `SubagentStop` so its documented child transcript can be collected
  when the child stops. The common parent `transcript_path` is never a child
  fallback. See the [Codex hook fields](https://learn.chatgpt.com/docs/hooks). Payloads
  from wrapped runtimes (herdr checks `CURSOR_VERSION`) are ignored the same
  way when a wrapper is detected.
- **Identity from the hook, state derived elsewhere.** Herdr's hook reports
  only `session_id`, `transcript_path`, and `source` on `SessionStart` over a
  local socket with a 0.5 s timeout, and the server derives `idle`,
  `working`, `blocked`, `done` itself. LCARS keeps the hook small for the
  same reason, but derives state on the console from the event stream
  rather than from a per-host server, because a per-host server is the
  daemon this design removes.
- **Pane identity when present.** If `HERDR_ENV=1`, the client adds
  `herdr: { paneId: HERDR_PANE_ID }` to the event. The console can then
  deep-link a live session to its pane via `herdr pane get`, and a later
  phase can join herdr's `blocked` recognition, which sees approval UIs no
  hook reports.

## 5. Hook configuration

### 5.1 Claude Code (user settings, and the runner `--settings` file)

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "^(startup|resume|clear|compact|fork)$",
        "hooks": [
          { "type": "command", "command": "lcars hook claude", "timeout": 10 }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          { "type": "command", "command": "lcars hook claude", "async": true }
        ]
      }
    ],
    "PostToolUse": [
      {
        "hooks": [
          { "type": "command", "command": "lcars hook claude", "async": true }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "lcars hook claude", "timeout": 5 }
        ]
      }
    ],
    "Notification": [
      {
        "matcher": "^(permission_prompt|idle_prompt)$",
        "hooks": [
          { "type": "command", "command": "lcars hook claude", "async": true }
        ]
      }
    ],
    "StopFailure": [
      {
        "hooks": [
          { "type": "command", "command": "lcars hook claude", "async": true }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          { "type": "command", "command": "lcars hook claude", "timeout": 5 }
        ]
      }
    ]
  }
}
```

`SessionStart` is synchronous because its stdout is injected as context;
the client prints nothing. `Stop` is synchronous too: when `claude -p` exits
while an async `Stop` hook is still running, it cancels that hook and skips
`SessionEnd` hooks entirely, which on a 2-CPU runner lost every end event
(found by `apps/runner-autoscaler/runner-image/hook-telemetry.test.sh`). It
costs one hook run (about 0.1-0.3 s) at the end of each turn. `async: true`
everywhere else means the agent never waits on telemetry mid-turn.

### 5.2 Codex (`~/.codex/hooks.json`, and `$CODEX_HOME/hooks.json` on runners)

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "sh $HOME/.codex/lcars-hook.sh",
            "timeout": 10
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "sh $HOME/.codex/lcars-hook.sh",
            "async": true
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "sh $HOME/.codex/lcars-hook.sh",
            "async": true
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "sh $HOME/.codex/lcars-hook.sh",
            "timeout": 5
          }
        ]
      }
    ],
    "Interrupt": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "sh $HOME/.codex/lcars-hook.sh",
            "timeout": 1
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "sh $HOME/.codex/lcars-hook.sh",
            "timeout": 3
          }
        ]
      }
    ]
  }
}
```

Codex's `async: true` runs a command hook in the background (up to eight
per session). The client still hands the network to the detached flusher
(section 4.1 step 6), so `SessionStart`, `Stop`, `SessionEnd`, and
`Interrupt`, which stay synchronous, cost only the local reduce. `Stop` is
synchronous for the same reason as Claude's: `codex exec` exits on its last
turn, so an async `Stop` never recorded a stop, and while it still held the
session lock the following `SessionEnd` could wait past the 3 s Codex
enforces on `SessionEnd` hooks whatever their `timeout` (measured: a 2.5 s
hook completes, a 3.5 s hook is killed).

Even an uncontended `SessionEnd` cannot rely on finishing inside that cap:
starting node and reducing the rollout took about 3 s per hook in the arm64
image build under QEMU, and the end was lost (#2827). The Codex stub
therefore returns from `SessionEnd` at once. It copies the payload into
`~/.local/state/agent-lcars/hook-inflight/` and starts a detached
`lcars hook codex` in its own session, which deletes the payload once it is
done. A host without `setsid` (stock macOS) keeps the in-place hook rather
than leave the client in the hook's process group. The runner drain
(`hook-telemetry-bootstrap.sh`) waits for that directory to empty, bounded at
30 s, before it fences late events.

The `command` is a constant launcher stub, the shape herdr uses for
`herdr-agent-state.sh`: `~/.codex/lcars-hook.sh` execs the `lcars` bundle
with the runtime name. Codex hashes the hook entry, not the script it
launches, so behavior changes never re-trigger trust (section 4.7). The
Claude entries in 5.1 use the same stub at `~/.claude/hooks/lcars-hook.sh`.

### 5.3 OpenCode (`agents/opencode/lcars-telemetry.js`)

OpenCode has no command hooks, so the plugin maps its bus events onto the
same hook names and hands each to a detached `lcars hook opencode`:

| OpenCode event                                   | Reported as        |
| ------------------------------------------------ | ------------------ |
| `session.created` (no `parentID`)                | `SessionStart`     |
| `message.updated`, first sight of a user message | `UserPromptSubmit` |
| `message.part.updated`, tool part `completed`    | `PostToolUse`      |
| `session.idle`                                   | `Stop`             |
| `session.deleted` (lifecycle-only, see the top)  | `SessionEnd`       |

The plugin also returns a `dispose` hook. OpenCode (checked at v1.18.25,
`src/plugin/index.ts`) calls event handlers as `void hook["event"](...)`
and never awaits them, but it does await `dispose` at instance shutdown,
so `dispose` is the only point where a final report can hold `opencode run`
open. It waits up to 5 s (`DISPOSE_WAIT_MS`) for running reports. Without it
a CPU-starved runner (`--cpus=1` plus busy loops) lost the `Stop` report in
3 of 7 runs; with it, 16 of 16 recorded it.

## 6. Operations

- **Health.** There is no per-host health document or alert. A host that
  stops reporting leaves its sessions to age out through `displayLiveness`
  (4.3).
- **Debugging a missing session.** `hook.log` shows every gate decision.
  `lcars hook flush` drains the spool by hand, `lcars hook <runtime> --inline`
  writes synchronously, and `lcars integration status all` reports an
  outdated or hand-edited install (see the
  [telemetry-watcher README](../apps/telemetry-watcher/README.md#hook-client-lcars-hook)).
- **Credential loss.** Without a readable writer key the flusher leaves events
  in the spool (5 MB cap, oldest first) until one appears. Nothing on the
  agent side fails, and a dropped event only delays a doc update because the
  next event re-sends the full summary.
- **Privacy gate.** Hooks fire for every project on the workstation. The gate
  runs before any read of `transcript_path`, and the test suite includes a
  non-allowlisted cwd fixture asserting zero network and zero spool writes.
- **Missed `SessionEnd`.** Tolerated by `displayLiveness` ageing (4.3); the
  only visible effect is `idle` instead of `ended` for up to 10 min. A
  QueueExecutor worker that dies (node reboot, OOM, eviction) never runs
  `runner finalize` either. When the executor's exit report gets `lost` back
  from the Work API, it sets `liveness: ended` on that run's `live`/`idle`
  session docs, each in a transaction that re-reads the doc and skips one
  that is already terminal or now carries another `runId` (a resumed retry).
  A late flush from the dying worker keeps the lost run's `runId`, so it is
  still ended (`apps/runner-autoscaler/lost_run_sessions.go`). Best effort,
  and only when executor status publication is enabled.
- **Version skew.** The runner image build gate
  (`apps/runner-autoscaler/runner-image/hook-telemetry.test.sh`) runs the
  image's real CLIs against a local fake provider and requires the lifecycle
  events described in section 8.

## 7. Decisions

1. Antigravity is not supported: it has no hook surface, and its poller was
   deleted with the daemon.
2. Per-repo opt-in via committed `.claude/settings.json` / `.codex/hooks.json`:
   **rejected.** `--settings` and project settings do merge additively, but
   worktrees outside the repo and Codex trust prompts make it noisier than
   one homegit-managed allowlist.
3. Codex hook trust from homegit: **constant launcher stub plus managed
   hooks** (section 4.7), not pre-computed `trusted_hash` entries. The hash
   input is undocumented and did not match any simple serialization.
4. Hook distribution: **`lcars integration install`** owns the hook entries
   and launcher scripts (section 4.7); homegit calls it rather than
   templating hook JSON.

## 8. Live verification on runners

Two checks cover different things:

1. **Which lifecycle events arrive.** The runner image's build gate
   (`apps/runner-autoscaler/runner-image/hook-telemetry.test.sh`) runs the
   real `claude -p`, `codex exec`, and `opencode run` against a local fake
   provider. It requires `start`, `stop`, and `end` from Claude Code and
   Codex and `start` and `stop` from OpenCode, and checks that every spooled
   event describes the dispatched session. Other kinds (prompt, tool, the
   OpenCode `end`) are printed when present but not required, so a
   regression in them passes the gate.
2. **That hooks write real runner sessions.** A run on real work, read back
   from the `sessions` collection.

Firestore cannot show which lifecycle events landed. It keeps one doc per
session with no per-event history, and the stored event kind survives only
as `liveness`. Both a hook `end` and `runner finalize` write
`liveness: ended`, and finalize leaves `observer` in place. So
`observer.kind == "hook"` plus `liveness == "ended"` on a finished run
proves that hooks reported during the run; it does not show whether the
hook `SessionEnd` landed, nor that finalize ran. The runner keeps no hook
log after the job, so there is no other live record.

To check a runner on real work:

1. Pick a real issue per
   [the real-work proof policy](testing-policy.md#development-proof-uses-real-work)
   and start a run on it: apply an `agent:*` label (removing and re-adding
   it on a finished task starts a fresh run), or post a tagged reply
   (`@claude`, `/codex`, or `/oc`; triggers are in
   `libs/dispatch-contracts/src/pipelines.ts`), which resumes the previous
   session when one parked or finished.
2. After the run ends, query `sessions` for its `runId`
   (`<owner>/<repo>#<n>/r<k>`) with Firestore `runQuery`, and check
   `observer.kind`, `observer.clientVersion`, and `observer.seq`.

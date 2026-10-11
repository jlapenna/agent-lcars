# Hooks-based session telemetry (design)

Status: proposal, 2026-10-10, hook surfaces verified empirically the same day
(section 11). Owner: telemetry. Supersedes nothing yet; the host watcher
daemon (`apps/telemetry-watcher`, issue #2540) keeps running until phase 3
below.

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
- Antigravity. It has no hook surface; see open question 1.

## 3. Runtime hook surfaces (verified 2026-10-10, see section 11)

| Runtime             | Config location                                                                  | Events used                                                                                                         | Notes                                                                                                                                                                                                                                                                                                       |
| ------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code 2.1.296 | `~/.claude/settings.json` (user), `--settings <file>` (runner), project settings | `SessionStart`, `UserPromptSubmit`, `PostToolUse`, `Stop`, `Notification`, `StopFailure`, `SessionEnd`              | stdin JSON: `session_id`, `transcript_path`, `cwd`, `permission_mode`, `hook_event_name`; `SessionStart` adds `source`, `model`, `session_title`. `async: true` supported. `SessionEnd` budget 1.5 s, raised by per-hook `timeout` up to 60 s.                                                              |
| Codex 0.162.1       | `~/.codex/hooks.json`, `<repo>/.codex/hooks.json`, `requirements.toml` (managed) | `SessionStart`, `UserPromptSubmit`, `PostToolUse`, `Stop`, `SessionEnd`, `Interrupt`                                | Same field names plus `model`, `turn_id`; under `codex exec` `transcript_path` was a real rollout file (verified). Hooks are synchronous; no background flag confirmed on 0.162.1. Non-managed hooks need trust against their hash; `--dangerously-bypass-hook-trust` for automation. `SessionEnd` max 3 s. |
| OpenCode 1.18.35    | plugin in `~/.config/opencode/plugins/` or `opencode.json` `plugin: [...]`       | `event`: `session.created/updated/status/idle/error`, `message.updated`, `message.part.updated`, `permission.asked` | In-process JS. `AssistantMessage` carries `tokens.{input,output,reasoning,cache.read,cache.write}`, `cost`, `modelID`; no transcript parse needed. Already ships `agents/opencode/lcars-session.js`.                                                                                                        |

Rejected: Claude Code `type: "http"` hooks posting straight to LCARS. They
would send `prompt`/`tool_input` bodies off-host, cannot compute tokens
without the transcript, and are unsupported on `SessionStart`.

## 4. Architecture

```
Claude Code ──command hook──▶ lcars hook claude   ─┐
Codex       ──command hook──▶ lcars hook codex    ─┼─▶ privacy gate ─▶ reduce transcript ─▶ SessionEventV1 ─▶ POST /api/telemetry/v1/sessions/{id}/events
OpenCode    ──plugin event──▶ lcars-telemetry.js  ─┘   (repo allowlist)  (@agent-lcars/telemetry)        │ bearer: host token | SA ID token
                                                                                                          ▼
                                                                                   console route ─▶ buildSessionDoc ─▶ Firestore sessions/{id}
                                                                                                          │
                                                                                 fallback: ~/.local/state/agent-lcars/spool/ (flushed by next hook)
```

Three pieces:

1. **Client** `lcars hook <runtime>` (new subcommand in the existing
   `session-title-cli` bundle, `apps/telemetry-watcher/src/session-title-cli.ts`).
   Reads one hook payload on stdin, never prints to stdout, always exits 0.
2. **Ingest route** `apps/console/src/app/api/telemetry/v1/sessions/[sessionId]/events/route.ts`.
   Authenticates, validates, dedupes, builds the doc with the shared
   `buildSessionDoc`, upserts with the existing merge + `clearFields` semantics.
3. **Distribution**: homegit manages the hook JSON for workstations; the
   runner image bakes a `--settings` file, a `CODEX_HOME` hooks file, and the
   OpenCode plugin.

### 4.1 Client: `lcars hook`

Pipeline per invocation, target under 300 ms for the hot path:

1. Parse stdin. Unknown `hook_event_name` → exit 0.
2. **Privacy gate.** Resolve `git -C <cwd> config --get remote.origin.url`
   and match `owner/name` against `~/.config/agent-lcars/config.json`
   `repos: ["jlapenna/*", ...]`. Non-git cwd or no match → exit 0 and write
   nothing. This replaces the checkout-root path allowlist with the same
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
   dropped), then `spawn` a detached `lcars hook --flush` that POSTs with a
   3 s timeout and exits 0 whatever happens. The hook process itself never
   touches the network, so its wall time is parse + gate + reduce only
   (section 11: 146 ms for the largest transcript on this host). This
   matters for Codex, whose hooks are synchronous, and for Claude Code's
   `SessionStart`, which cannot be `async`.
7. **SessionEnd** (Claude 1.5 s, Codex 3 s budgets): same path as step 6;
   the detached flusher survives the parent CLI exiting.
8. **Daemon coexistence marker.** Touch `hook-sessions/<sessionId>.json`.
   During the transition the daemon skips any session whose marker is
   younger than 10 min (phase 1), so there is no dual writer per session.

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
`/proc` cwd scan and `heartbeatReceived` → `stale` path are deleted with the
daemon in phase 3.

`attention` is new, and small: `Notification(permission_prompt|idle_prompt)`
sets it, the next `prompt`/`tool` clears it (via `clearFields`, extending
`ClearableSessionField`). The Decision Inbox gets "waiting on you" for
interactive sessions, which no transcript-derived signal can produce.

### 4.4 Ingest route

- **Auth.** Bearer token, two kinds, both resolved to a principal with scope
  `telemetry.writer`:
  - Google-signed ID token for audience `agent-lcars-telemetry` (runner:
    minted by the client from `/run/secrets/telemetry-writer.json` with
    `google-auth-library`'s `IdTokenClient`, cached 55 min in the state
    dir). Verified with the existing `verifyGoogleIdToken` path in
    `work-auth.ts`.
  - Host token for workstations: random 256-bit secret, hashed in
    `AGENT_LCARS_TELEMETRY_GRANTS` (same shape as `AGENT_LCARS_WORK_GRANTS`,
    `work-grants.ts`), bound to one `host`. Rotation is a grant edit plus a
    homegit secret bump. Workstations stop needing any Firestore credential.
  - `workScopeSchema` gains `telemetry.writer`; `work.*` scopes do not imply
    it and vice versa.
- **Validation.** zod schema for `SessionEventV1`; `summary.sessionId` must
  equal the path id; `host` must equal the principal's bound host (host
  token) or be absent (SA token); `runner` allowed only for SA principals.
- **Dedupe/order.** Firestore transaction on `sessions/{id}`: drop if
  `lastEvent.seq >= event.seq` from the same `host`; otherwise apply. Out of
  order `end` after `tool` is therefore impossible to regress.
- **Write.** `buildSessionDoc(summary, { observedAt: now, forceSource:
runner ? 'issue-agent' : 'cli', ...runner })`, then override `liveness`
  from the event, then the existing `SessionWrite` upsert (merge +
  `FieldValue.delete()` for cleared fields). Add `observer: { kind: 'hook',
runtime, clientVersion }` so provenance is visible next to daemon-written
  docs.
- **Health.** `telemetry-hosts/{host}` doc with `lastEventAt`, event counts
  by kind. Replaces the Prometheus dead-man metric (section 7).

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
  bounded stop-wait before finalize disappears with the daemon.

In-Flight UI latency improves from a 10 s tick to the hook (seconds).

### 4.6 Workstation distribution (homegit)

- `dot_claude/modify_settings.json` MANAGED gains the hook entries in
  section 5.1. Existing tmux/herdr hooks are untouched; entries merge.
- `dot_codex/modify_hooks.json` gains section 5.2; it appends per-event
  groups and preserves user groups (verified in its `main()`). Trust: Codex
  persists `[hooks.state."<hooks.json path>:<event_snake_case>:<group>:<hook>"]
trusted_hash = "..."` in `~/.codex/config.toml`, and homegit's
  `homegit-codex-config` helper already overlays `config.desired.toml`
  leaves onto the live file while keeping unknown content. Pre-trusting
  therefore needs only the hash algorithm (open question 4); until it is
  known, `/hooks` trust once per host per change, surfaced by the homegit
  reconcile report.
- `~/.config/opencode/plugins/lcars-telemetry.js` installed by homegit.
- `lcars` binary: stop relying on the manual
  `deploy/install-session-title-cli.sh`. `packages/fleet-tools`
  (`@agent-lcars/agent-tools`) is dependency-free committed scripts packed
  straight from a sparse clone by homegit's
  `homegit-repo-tools-bootstrap.sh`, so a built esbuild bundle does not fit
  there. Instead a workflow on `main` builds the `session-title-cli` target
  and uploads `lcars-session-title.cjs` as a GitHub Release asset tagged
  `lcars-cli/<sha>`; the same bootstrap script downloads the latest asset
  (checksum pinned in the chezmoi source) to `~/.local/lib/agent-lcars/` and
  writes the `~/.local/bin/lcars` launcher. `install-session-title-cli.sh`
  stays for development.
- Secrets: `~/.config/agent-lcars/telemetry.env` (`LCARS_TELEMETRY_TOKEN`,
  mode 0600), written by a `run_onchange_` script that calls
  `secrets-get AGENT_LCARS_TELEMETRY_TOKEN_<host>`, copying
  `run_onchange_after_30-homegit-opencode-env.sh.tmpl` exactly. One token
  per host.
- Config: `~/.config/agent-lcars/config.json` `{ "repos": ["jlapenna/*"] }`
  derived from the same source the deploy's `AGENT_TELEMETRY_CHECKOUT_ROOTS`
  comes from today.

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
          { "type": "command", "command": "lcars hook claude", "async": true }
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
the client prints nothing. `async: true` everywhere else means the agent
never waits on telemetry.

### 5.2 Codex (`~/.codex/hooks.json`, and `$CODEX_HOME/hooks.json` on runners)

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          { "type": "command", "command": "lcars hook codex", "timeout": 10 }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          { "type": "command", "command": "lcars hook codex", "timeout": 10 }
        ]
      }
    ],
    "PostToolUse": [
      {
        "hooks": [
          { "type": "command", "command": "lcars hook codex", "timeout": 10 }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "lcars hook codex", "timeout": 10 }
        ]
      }
    ],
    "Interrupt": [
      {
        "hooks": [
          { "type": "command", "command": "lcars hook codex", "timeout": 1 }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          { "type": "command", "command": "lcars hook codex", "timeout": 3 }
        ]
      }
    ]
  }
}
```

Codex documents background hooks (up to eight per session) but 0.162.1
exposes no confirmed config field for them, so the design does not depend
on one: every Codex hook returns after the local reduce and hands the
network to the detached flusher (section 4.1 step 6).

### 5.3 OpenCode (`agents/opencode/lcars-telemetry.js`)

```js
export default async function lcarsTelemetry({ client }) {
  return {
    event: async ({ event }) => {
      switch (event.type) {
        case 'session.created':
        case 'session.updated':
          return ship('start', event.properties.info);
        case 'message.updated':
          return event.properties.info.role === 'assistant'
            ? ship('tool', summaryFrom(event.properties.info))
            : undefined;
        case 'session.status':
          return ship(
            event.properties.status.type === 'busy' ? 'tool' : 'stop',
            { sessionID: event.properties.sessionID },
          );
        case 'session.idle':
          return ship('stop', { sessionID: event.properties.sessionID });
        case 'permission.asked':
          return ship('attention', {
            sessionID: event.properties.sessionID,
            attention: 'permission',
          });
        case 'session.error':
          return ship('attention', {
            sessionID: event.properties.sessionID,
            attention: 'error',
          });
      }
    },
  };
}
```

`ship` applies the same privacy gate (session `directory` → repo), throttle,
spool, and bearer logic as the CLI client, implemented once in a small
shared module bundled into both artifacts.

## 6. Rollout

| Phase | Scope                                                                                                                                          | Exit criterion                                                                                                           |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 0     | Ingest route behind `AGENT_LCARS_TELEMETRY_INGEST=1`; `lcars hook claude`; one host (laforge) via a local settings edit                        | Docs written by hook and daemon for the same session match on `turns`, `tokens`, `title`, `deliverables` for 20 sessions |
| 1     | homegit rollout: Claude + Codex hooks on all three watcher hosts; daemon skips marker-fresh sessions                                           | One week with no `telemetry-hosts` gap > 10 min while sessions ran; no privacy-gate escapes in `hook.log`                |
| 2     | Runner: `--settings`, `CODEX_HOME` hooks, OpenCode plugin; remove `sidecar start`                                                              | Native work smoke runbook passes on all three pipelines; In-Flight UI updates within 5 s of a tool call                  |
| 3     | `docker compose down` the watcher on each host; delete `WatcherDaemon` host mode, `process-check.ts`, `/metrics`, `deploy/`; reducer lib stays | README/OPERATIONS/onboarding docs updated; homelab Prometheus alert for the watcher removed in the same change           |

Each phase is reversible by removing the hook entries; the daemon keeps
writing untouched docs until phase 3.

## 7. Operations after phase 3

- **Health.** `/agents` gets a hosts strip from `telemetry-hosts/*`: host,
  last event age, runtime versions. A scheduled workflow (same pattern as
  `work-session-pin-tick.yml`) fails when a host that produced events in the
  last 24 h has been silent > 2 h during working hours. This replaces the
  cAdvisor crash-loop and `/metrics` dead-man alerts in homelab.
- **Debugging a missing session.** `lcars hook --doctor` prints: config
  repos, token present, spool depth, last 5 log lines, and replays a
  synthetic `heartbeat` event. `hook.log` shows every gate decision.
- **Credential loss.** A revoked host token makes the client spool and log
  `401`; the hosts strip shows the gap. Nothing on the agent side fails.
- **Version skew.** Hook event names and field names are pinned in
  `libs/telemetry/src/lib/hook-payloads/*.fixture.json`, one fixture per
  runtime per event, captured from the pinned CLI versions. A contract test
  asserts the homegit JSON and the runner files reference only those events.

## 8. Risks and verification before phase 0

1. **PostToolUse volume.** Resolved. The reducer handles the largest
   transcript on this host (9.1 MB, 3,899 lines) in 146 ms and a 2.2 MB one
   in 13 ms (section 11), so the 15 s throttle is comfort, not necessity. The
   incremental reducer stays a follow-up.
2. **Codex hooks under `codex exec`.** Resolved: all five events fire, with
   `model`, `turn_id`, and an existing rollout `transcript_path`. No
   background flag was found, handled by the detached flusher.
3. **Codex trust churn.** Partly resolved. The trust state format is known
   (section 4.6); the hash algorithm is not, and `requirements.toml` hook
   management could not be confirmed in the 0.162.1 binary. Runner mode is
   unaffected (`--dangerously-bypass-hook-trust`). Workstations accept one
   `/hooks` trust per change until open question 4 closes.
4. **Privacy gate correctness.** Hook invocations happen for every project
   on the workstation. The gate runs before any read of `transcript_path`,
   and the test suite includes a non-allowlisted cwd fixture asserting zero
   network and zero spool writes.
5. **Spool growth on a disconnected laptop.** 5 MB cap, oldest first; a
   dropped event only delays a doc update, the next event re-sends the full
   summary.
6. **Missed `SessionEnd`.** Tolerated by `displayLiveness` ageing (4.3);
   the only visible effect is `idle` instead of `ended` for up to 10 min.

## 9. Decisions and remaining open question

1. Antigravity: **drop at phase 3.** The poller is enabled on every watcher
   host by `deploy/docker-compose.yml`, but the summary DB on this
   workstation was last written 2026-07-20, nearly three months ago. Confirm
   on pike and janeway with `stat` of the same DB before the phase 3 PR.
2. `lcars session title/status`: **post `annotation` events directly from
   phase 1**, and keep writing the overlay file until phase 3 so the daemon
   still sees it.
3. Per-repo opt-in via committed `.claude/settings.json` / `.codex/hooks.json`:
   **rejected.** `--settings` and project settings do merge additively
   (verified), but worktrees outside the repo and Codex trust prompts make
   it noisier than one homegit-managed allowlist.
4. Open: what hashes into Codex `trusted_hash`? Needed only to pre-trust
   hooks from homegit. Determine by diffing `config.toml` before and after
   trusting a known hook body in a temp `CODEX_HOME`.

## 10. Code map (what changes where)

| Area                                                                         | Change                                                                              |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `apps/telemetry-watcher/src/session-title-cli.ts`                            | add `hook <runtime>` and `hook --flush/--doctor` dispatch                           |
| `apps/telemetry-watcher/src/lib/hook/*`                                      | payload parsing, privacy gate, throttle/state, spool, transport, token minting      |
| `libs/telemetry/src/lib/session-event.ts`                                    | `SessionEventV1` type + zod schema, shared by client and route                      |
| `libs/telemetry/src/lib/types.ts`                                            | `attention`, `observer` on `BaseSessionDoc`; `ClearableSessionField` += `attention` |
| `apps/console/src/app/api/telemetry/v1/sessions/[sessionId]/events/route.ts` | ingest route                                                                        |
| `apps/console/src/lib/work-grants.ts`, `work-auth.ts`                        | `telemetry.writer` scope, host-token principal                                      |
| `agents/opencode/lcars-telemetry.js`, `opencode.json`                        | plugin                                                                              |
| `apps/runner-autoscaler/runner-image/{Dockerfile,direct-runner.sh}`          | bake hook files, `--settings`, `CODEX_HOME/hooks.json`, drop `sidecar start`        |
| `apps/telemetry-watcher/bin/sidecar-lifecycle.sh`                            | `finalize` only                                                                     |
| homegit `dot_claude/modify_settings.json`, `dot_codex/modify_hooks.json`     | hook entries; new `dot_config/agent-lcars/`                                         |
| `docs/onboarding-console-and-telemetry.md`, `OPERATIONS.md`, README          | replace watcher deployment steps with token issuance and hosts-strip health         |

## 11. Verification log (2026-10-10, this workstation)

All runs used temp homes and config dirs that were deleted afterwards; no
user configuration was modified and no transcript content was read.

| Check                                                                              | Result                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Claude Code 2.1.296, `claude -p --settings <hooks>` with one Bash call             | Fired in order: `SessionStart`(source `startup`), `UserPromptSubmit`, `PostToolUse`(Bash), `Stop`, `SessionEnd`(reason `other`). `transcript_path` existed at `Stop` (196 KB). `model` and `session_title` absent on `SessionStart` in print mode.                                                                                                           |
| Claude Code `--settings` plus project `.claude/settings.json`                      | Both `PostToolUse` hooks fired: merge is additive.                                                                                                                                                                                                                                                                                                           |
| Codex 0.162.1, `codex exec --dangerously-bypass-hook-trust`                        | Fired: `SessionStart`, `UserPromptSubmit`, `PostToolUse`, `Stop`, `SessionEnd`(reason `other`). Every payload except `SessionEnd` carried `model`; turn-scoped ones carried `turn_id`. `transcript_path` was `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<session_id>.jsonl` and existed (86 KB). stdin must be `</dev/null` or `exec` blocks reading it.  |
| OpenCode 1.18.35, `opencode run` with `$XDG_CONFIG_HOME/opencode/plugins/probe.js` | Plugin loaded in run mode; init received `client, project, worktree, directory, serverUrl, $`. Events: `session.created`, `session.updated` (info has `directory`, `title`, `cost`, `tokens`, `model`), `session.status` (`busy`), `message.updated` (assistant info has `cost`, `tokens`, `modelID`, `providerID`), `message.part.updated`, `session.diff`. |
| Reducer cost (`claudeCodeAdapter.reduce`, node 24.21, median of 5)                 | 9.1 MB / 3,899 lines: 146 ms. 4.6 MB: 46 ms. 2.2 MB: 13 ms. 1.9 MB: 7 ms. 0.2 MB: 1 ms. Read + split baseline for 9.1 MB: 104 ms.                                                                                                                                                                                                                            |
| homegit merge scripts                                                              | `dot_claude/modify_settings.json` replaces managed top-level keys (so the whole `hooks` object is managed; user-only hooks there would be dropped, same as today). `dot_codex/modify_hooks.json` appends per-event groups and keeps user groups.                                                                                                             |
| Secret delivery pattern                                                            | `run_onchange_after_30-homegit-opencode-env.sh.tmpl`: `secrets-get NAME` into a 0600 `.env` file.                                                                                                                                                                                                                                                            |
| `packages/fleet-tools`                                                             | `@agent-lcars/agent-tools`, three committed bins, no dependencies, packed with `--ignore-scripts` from a sparse clone. Not a home for a built bundle.                                                                                                                                                                                                        |
| Antigravity                                                                        | `~/.gemini/antigravity-cli/conversation_summaries.db` last modified 2026-07-20.                                                                                                                                                                                                                                                                              |

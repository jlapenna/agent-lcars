# Claw runner image

One agent turn per LCARS run attempt, for the `claw-*` pipelines, run by the
harness the agent's manifest names: OpenClaw (the default), Claude Code or
Codex. The launcher, `claw-job.mjs`, is an
[Agent Client Protocol](https://agentclientprotocol.com/) (ACP) client and
every harness is an ACP agent. The design is the `claw` execute adapter in the
[unified work dataflow spec](../../../docs/superpowers/specs/2026-10-15-unified-work-dataflow-design.md#claw)
and [repository-owned agents](../../../docs/repository-agents.md#harnesses).

The image holds the verified OpenClaw distribution and the ACP adapters for
Claude Code and Codex (`package.json` and `package-lock.json`, installed with
`npm ci` so every package is checked against its integrity hash), generic
clients (`openssh-client`, `python3`) and the launcher with its two modules
(`claw-process.mjs`, `openclaw-harness.mjs`). It holds no agent definition,
agent tool or credential: the definition arrives in the run brief and a zone
executor's runtime table mounts the credentials.

## Where the agent definition comes from

A repository-owned agent (`.lcars/agents/<name>/`,
[docs/repository-agents.md](../../../docs/repository-agents.md)) arrives in the
run brief: every file with its git mode, blob SHA and content, and the
definition digest LCARS pinned at admission. The launcher writes the files to
`/work/agent` only after each file's bytes hash to its blob SHA and the file
list hashes to the pinned digest; paths cannot leave that directory, and
executable files keep their mode. The harness's files are read from there:
`workspace/` and `home/` for every harness, and `config.json` and
`approvals.json` for OpenClaw. Its `config.json` is a source config; the
launcher normalizes it for this image
([below](#agent-config-normalization)).
||||||| 1dddd263
executable files keep their mode. The definition's `config.json`,
`approvals.json` and `workspace/` (such as `AGENTS.md`) are read from there;
`config.json` must be Doctor-normalized (below).

## What a zone mounts

| Path                           | Source      | Contents                                                                                                                                                                       |
| ------------------------------ | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/run/claw-secrets/env/<NAME>` | zone Secret | Exported to the harness as environment variable `NAME` (for example `LITELLM_API_KEY`). `LCARS_*`, `OPENCLAW_*`, `RUNNER_MODE`, `PATH`, `HOME` and `NODE_OPTIONS` are refused. |
| `/run/claw-secrets/<other>`    | zone Secret | Files the agent's own tools read by path (SSH keys, `known_hosts`).                                                                                                            |
| `/work`, `/tmp`                | `emptyDir`  | Writable state, workspace copy and `HOME`; the root filesystem stays read-only.                                                                                                |

The executor supplies `LCARS_CONSOLE_URL`, `LCARS_RUN_ID`, `LCARS_RUN_TOKEN` and
`CLAW_TURN_DEADLINE_SECONDS` (below the pod deadline, which is below the
lease).

## Trust boundary inside the pod

The harness and the agent's tools run as the same UID as the launcher, so a tool
the agent is allowed to run could read the launcher's environment, including
`LCARS_RUN_TOKEN`. That token authorizes only heartbeat, brief and completion
for this one run, and the agent's own output already becomes that run's
report, so reading it grants no new authority. The zone Secret items are
mounted for the agent's tools by design; scope each runtime's items to what
that agent may use. OpenClaw's Gateway and its token are in the same
position: a tool the agent may run could reach the Gateway as an operator.
A launcher SIGTERM (cancellation or pod deadline) stops the harness's process
group and OpenClaw's Gateway, and still settles the run.

## Launch sequence

Each step fails the attempt closed with a `runner-failed` completion:

1. Startup heartbeat must be acknowledged before anything else, then the
   brief must be a `claw` brief for this run: an agent round with its message
   and verified definition.
2. The launcher writes the verified definition to `/work/agent`, copies its
   `workspace/` to a writable `/work/workspace` and copies its `home/` into
   `HOME`, making each pinned `home/` file read-only.
3. It prepares what the harness needs (for OpenClaw, [below](#openclaw)) and
   starts the harness the manifest names (`HARNESSES` in `claw-job.mjs`) in
   its own process group, in the workspace, with a clean environment: the
   zone's `env/` Secret items and nothing of the launcher's. The command
   always comes from the image.
4. It speaks ACP over the harness's stdio: `initialize` (protocol 1, no file
   system or terminal capability), `session/new` in the workspace and one
   `session/prompt` carrying the message. It answers every
   `session/request_permission` with the reject option, so the agent can do
   only what its harness does without asking.
5. It settles from the session's updates: `report` only when the turn ended
   with `end_turn`, the agent's last message after its last tool call is not
   empty and no tool call is unresolved. A call that failed or never finished
   is unresolved unless a call that started after it ended completed. A
   harness error (a missing login, for example), an early exit, any other
   stop reason and an empty answer are `runner-failed`. When the agent's
   manifest sets `requireToolEvidence`, at least one tool call is also
   required.
6. Every pinned `home/` file must still be its blob. The harness runs as the
   launcher's UID, so the launcher cannot stop an agent from rewriting its
   own settings; it refuses the result when it sees that. It does not see a
   file the agent added, or changed and put back.

Harness stderr is never forwarded, because it can echo resolved
configuration. The outer deadline and cancellation stop the harness's process
group and still settle the run.

## Harnesses

### OpenClaw

The agent is OpenClaw's own ACP server, `openclaw acp`, which forwards each
prompt to a Gateway. `openclaw-harness.mjs` prepares that Gateway for this one
turn and speaks no ACP itself. Each step fails the attempt closed:

1. Fresh state directory with a writable copy of the pinned `config.json`.
2. `openclaw config validate --json` must report `valid: true`: OpenClaw
   silently ignores unknown keys.
3. `openclaw doctor --fix --non-interactive` initializes state and
   normalizes the config copy for this image. The turn runs on that copy
   without Doctor's skill toggles; any change beyond the accepted ones fails
   the attempt and names the settings
   ([below](#agent-config-normalization)). The workspace is staged again
   afterwards, so Doctor's file repairs never reach the turn.
4. `openclaw approvals set --file /work/agent/approvals.json`.
5. The launch config: the turn's config plus what only this Job knows. The
   agent's workspace is `/work/workspace`, replacing any the source names;
   workspace bootstrap is skipped unless the definition sets it; and the
   Gateway listens on loopback behind a random token with config reload off.
   A definition cannot open the Gateway or drop its token.
6. `openclaw gateway run`, waited on until it logs `[gateway] ready`.
7. `openclaw acp --url ws://127.0.0.1:<port> --token-file … --no-prefix-cwd`
   is the harness. After the turn the Gateway's process group is stopped.

After the turn the launcher refuses the result if the Gateway's config or
token file is no longer what it launched. Exec approvals live in OpenClaw's
state database and are not covered by that check.

Exec approvals stay the enforcement layer: a denied command is a failed tool
call in the session and fails the attempt. A turn that fails inside the
Gateway (a model endpoint that is down, for example) ends with no text, which
is a failed attempt. The Gateway and its token belong to the same UID as the
agent's tools, like everything else in the pod (below).

### Claude Code and Codex

Both speak ACP through their own pinned adapters and read their settings from
`home/` ([docs/repository-agents.md](../../../docs/repository-agents.md#harnesses)).
They sign in with the runtime's `env/` Secret items; a runtime without a
login fails the attempt with `Authentication required`.

### What has been checked

On 2026-11-18, on a workstation, the launcher ran each harness from this
lockfile against stand-in model endpoints:

- OpenClaw 2026.10.10-beta.3 settled a report in 56 to 69 s, of which Doctor
  and the Gateway's start are most. The agent read its `AGENTS.md`, an
  allowlisted `date` ran and counted as evidence, `cat /etc/hostname` outside
  the allowlist failed the attempt, and a model endpoint returning HTTP 500
  failed it with `empty result` after 136 s of OpenClaw's own retries.
- Claude Code settled a report in 3 to 5 s; a command allowed in
  `home/.claude/settings.json` ran, and a write or network command without a
  rule was refused and failed the attempt.
- Codex settled a report in 3 to 4 s, ran a command in its sandbox, and its
  sandbox blocked the network.

No real model turn and no run on k3s has been made through this path yet. The
previous launcher, which ran `openclaw agent exec` without a Gateway, settled
an OpenClaw report in 58 s on the real image (2026-11-14, Spark lane, 2 CPU /
3 GiB); the Gateway's memory under that limit is unmeasured.
||||||| 1dddd263 2. Fresh state directory with a writable copy of the pinned config. 3. `openclaw config validate --json` must report `valid: true`.
`agent exec` itself silently ignores unknown keys. 4. `openclaw doctor --fix --non-interactive` initializes state (without it
every config-pinned turn fails with "Auth profile read requested an
uncaptured shared owner"). If it changes anything but `meta`/`wizard`,
the pinned config was not normalized and the attempt fails. 5. `openclaw approvals set --file /work/agent/approvals.json`. 6. `openclaw agent exec --config … --state-dir … --message-file … --cwd … --json`
under the outer deadline. OpenClaw's stderr is never forwarded, because it
can echo resolved configuration. 7. Settle: `report` only when the envelope is `ok`, has a final message and
no `toolSummary.unresolvedError`. When the agent's manifest sets
`requireToolEvidence`, at least one tool call is also required. A tool call
that failed and was resolved (a probe of a host that is down) is evidence,
not a runner failure. `agent exec` exits 0 with `ok: true` even when every
tool call was denied, so the exit code alone proves nothing.

## Agent config normalization

An agent's `config.json` is a source config: it does not have to match any
particular image. Doctor's normalization depends on the image, so the launcher
validates the source as written, runs Doctor on a copy inside the image that
executes the turn, and builds the turn's config from the result
(`doctorChanges` and `turnConfig` in `openclaw-harness.mjs`). The verified
definition under `/work/agent` is never modified, and the turn's workspace is
staged from it again after Doctor runs, so Doctor's file repairs never reach
the turn (even for a source that names that directory as its workspace).

The turn keeps only these Doctor changes:

- enabling a plugin that owns a model provider the config declares
  (`plugins.entries.<plugin>.enabled: true`, not one the config set).
  Ownership comes from the image's bundled
  `dist/extensions/*/openclaw.plugin.json` (`providers`,
  `autoEnableWhenConfiguredProviders`), matched case-insensitively as OpenClaw
  does, so `google-vertex` authorizes the `google` plugin and `LITELLM` the
  `litellm` plugin;
- adding an empty agent entry (`agents.entries.<name>: {}`).

Skill toggles Doctor writes (`skills.entries.<name>.enabled`, for bundled
skills whose binaries the image lacks) are discarded, not carried: Doctor
judges readiness outside the turn's working directory, workspace and exec
defaults, while OpenClaw already filters ineligible skills at load time in the
turn itself. The turn runs with the source's own `skills` settings.

Any other change, apart from OpenClaw's `meta`/`wizard` stamps, fails the
attempt with `runner-failed` naming the changed settings, for example
`tools.profile`. Write the config's authority (tools, exec, approvals,
providers) explicitly so Doctor has nothing else to fill in; a multi-agent
roster (`agents.ownership: "explicit"`), for example, sets
`agents.defaults.heartbeat.agentId` and `agents.defaults.systemAgent.agentId`
itself. A config already normalized for some image remains valid.

## Test

```sh
node --test apps/runner-autoscaler/claw-image/claw-job.test.mjs
```

The tests drive the launcher against a fake Work API, a fake `openclaw`
(including its Gateway and ACP server) and a fake ACP harness.

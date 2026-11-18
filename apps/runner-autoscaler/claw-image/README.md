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
So is the model key: the launcher keeps it out of the environment a host
command inherits, which stops it from showing up in a command's output by
accident, but the launch config that holds it is readable by the same UID.
None of this is isolation; a harness in its own container is (#3412).
A launcher SIGTERM (cancellation or pod deadline) stops the harness's process
group and OpenClaw's Gateway, and still settles the run.

## Launch sequence

Each step fails the attempt closed with a `runner-failed` completion:

1. Startup heartbeat must be acknowledged before anything else, then the
   brief must be a `claw` brief for this run: an agent round with its message
   and verified definition. A round that names a harness or a mode carries
   its files as `definition` instead of `files`, which a launcher from before
   harnesses refuses.
2. The launcher writes the verified definition to `/work/agent`, copies its
   `workspace/` directory to a writable `/work/workspace` and copies its
   `home/` directory into
   `HOME`, making each pinned `home/` file read-only (an executable stays
   executable).
3. It prepares what the harness needs (for OpenClaw, [below](#openclaw)) and
   starts the harness the manifest names (`HARNESSES` in `claw-job.mjs`) in
   its own process group, in the workspace, with a clean environment: the
   zone's `env/` Secret items and nothing of the launcher's. The command
   always comes from the image.
4. It speaks ACP over the harness's stdio: `initialize` (protocol 1, no file
   system or terminal capability, notices accepted so a harness's own
   remarks do not arrive as answer text), `session/new` in the workspace (after
   `authenticate`, when the harness asks to be signed in and the image names
   an unattended method for it: Codex's `api-key`),
   `session/set_mode` when the manifest names a mode or the image sets one
   for the harness (`workspace-write` for Codex; a harness that does not
   offer the mode runs nothing), and one `session/prompt` carrying the
   message. A harness takes some prompts as commands of its own (one that
   begins with `/`, or a bare `halt`, which OpenClaw's Gateway reads as an
   abort), so every message is sent after one line saying it is the request
   itself, and otherwise unchanged. It answers every
   `session/request_permission` with the reject option, so the agent can do
   only what its harness does without asking.
5. It settles from the session's updates: `report` only when the turn ended
   with `end_turn`, the agent's last message after its last tool call is not
   empty and no tool call is unresolved. A call that failed or never finished
   is unresolved unless a call that started after it ended completed. A
   harness error (a missing login, for example), an early exit, any other
   stop reason and an empty answer are `runner-failed`. So is a turn the
   harness itself reports as failed: Codex ends a turn its provider failed
   with `end_turn` and the error as message text, and tells only a client
   that declares the session-failure extension, which the launcher does. When the agent's
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
5. The launch config (`launchConfig`), composed as `agent exec` composed
   its run config: the headless defaults under the turn's config (file tools
   confined to the workspace, the `coding` tool profile, no shell
   environment import, unless the source says otherwise), and over it what
   only this Job knows. Every agent works in `/work/workspace`, replacing any
   path the source names, and is not bootstrapped. The Gateway block is the
   Job's alone: loopback, a random token, no Tailscale, config reload off. A
   definition cannot open the Gateway or drop its token. Nobody is authorized
   to give the Gateway commands (`commands.allowFrom` is empty), so a `/word`
   inside a message stays text for the agent. Provider
   credentials are resolved into the launch config and left out of the
   Gateway's environment (`resolveCredentials`): `agent exec` kept them out
   of what a host command inherits, and a Gateway has no such scope. A
   credential is a variable the pinned OpenClaw lists as one a provider reads
   (`providerAuthEnv` asks it through its public plugin SDK, in a process of
   its own, for the list `agent exec` used), one the config names as an `env`
   SecretRef, or one a provider's `apiKey` or `headers` names in a `${NAME}`
   or `${NAME:-default}` template (OpenClaw's own grammar; an empty variable
   counts as unset). Every SecretRef and template for it is resolved, and a declared
   provider with no `apiKey` gets the first of its own variables the
   environment holds. A provider that is not declared in the config and
   relied on the environment no longer finds its key, and a custom key named
   only outside those places stays in the environment. A SecretRef is
   resolved only as OpenClaw would resolve it: through an `env` provider the
   config declares, within that provider's `allowlist`; any other reference
   is left for OpenClaw to refuse. The config's own `env` counts as
   environment too, because the Gateway adds its variables to its process
   environment after the launcher has filtered it: a variable defined there
   is a credential by the same rules, and so is one whose value is built
   from a credential. Each still resolves into the provider settings that
   name it, and is then removed from the launch config's `env`; the other
   variables stay there as written. Both layouts the runtime reads are
   covered (`env.vars` and a string directly under `env`), though the pinned
   OpenClaw's validation accepts only `env.vars`. A definition whose model key came from an
   auth-profile store in its configured `agentDir` no longer authenticates,
   because the launch config, like `agent exec`, drops `agentDir` to keep
   agent state under the Job's state directory, and the Gateway does not
   read auth profiles from the original directory as `agent exec` did. Give
   the provider its key as an `env` SecretRef.
6. `openclaw gateway run`, waited on until it logs `[gateway] ready`. It
   serves this one turn: channels, cron, the Gmail watcher, the canvas host,
   the browser control server and the startup model prewarm are all switched
   off, so nothing outside the Job can reach the agent.
7. `openclaw acp --url ws://127.0.0.1:<port> --token-file … --no-prefix-cwd`
   is the harness. After the turn the Gateway's process group is stopped.

OpenClaw's ACP server ends a turn the Gateway failed like any other
(`end_turn`), even after part of an answer has streamed. The Gateway does log
the message's outcome (`[diagnostic] message processed: … outcome=error`), so
the launcher stops the Gateway after the turn, reads its log to the end and
fails the attempt when it finds one. The launch config keeps diagnostics on
whatever the definition says, because that line is a diagnostic. A model attempt that failed before a
fallback answered is logged as a `lane task error` and is not a failed turn.
This reads log text, so a new OpenClaw version needs that wording checked.

After the turn the launcher also refuses the result if the Gateway's config
or token file is no longer what it launched. Exec approvals live in OpenClaw's
state database and are not covered by that check.

Exec approvals stay the enforcement layer. A denied command is a failed tool
call in the session, and it fails the attempt unless a later call, started
after it, completed (step 5 of the launch sequence). A turn the Gateway
recorded as failed is a failed attempt whether or not text had streamed, and
so is a turn that ends with no text. The Gateway and its token belong to the
same UID as the agent's tools, like everything else in the pod (above).

### Claude Code and Codex

Both speak ACP through their own pinned adapters and read their settings from
`home/` ([docs/repository-agents.md](../../../docs/repository-agents.md#harnesses)).
They sign in with the runtime's `env/` Secret items; a runtime without a
login fails the attempt with `Authentication required`.

### What has been checked

On 2026-11-18, on a workstation, the launcher ran each harness from this
lockfile against stand-in model endpoints:

- OpenClaw 2026.10.10-beta.3 settled a report in about 40 s, most of it
  Doctor and the Gateway's start. The agent read its `AGENTS.md`, an
  allowlisted `date` ran and counted as evidence, and `cat /etc/hostname`
  outside the allowlist failed the attempt. Before the Gateway's background
  services were switched off, a model endpoint returning HTTP 500 failed the
  attempt with `empty result` after 136 s of OpenClaw's own retries.
- Claude Code settled a report in 3 to 5 s; a command allowed in
  `home/.claude/settings.json` ran, and a write or network command without a
  rule was refused and failed the attempt.
- Codex settled a report in 3 to 4 s, ran a command in its sandbox, and its
  sandbox blocked the network.

No real model turn and no run on k3s has been made through this path yet. The
previous launcher, which ran `openclaw agent exec` without a Gateway, settled
an OpenClaw report in 58 s on the real image (2026-11-14, Spark lane, 2 CPU /
3 GiB); the Gateway's memory under that limit is unmeasured.

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

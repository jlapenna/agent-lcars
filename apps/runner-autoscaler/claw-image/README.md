# Claw runner image

One embedded OpenClaw agent turn per LCARS run attempt, for the `claw-*`
pipelines. The design is the `claw` execute adapter in the
[unified work dataflow spec](../../../docs/superpowers/specs/2026-10-15-unified-work-dataflow-design.md#claw);
phase 3a is tracked in agent-lcars#3349.

The image holds the verified OpenClaw distribution (`package.json` and
`package-lock.json`, installed with `npm ci` so every package is checked
against its integrity hash), generic clients (`openssh-client`, `python3`)
and the launcher, `claw-job.mjs`. It holds no agent definition, agent tool or
credential: the definition arrives in the run brief and a zone executor's
runtime table mounts the credentials.

## Where the agent definition comes from

A repository-owned agent (`.lcars/agents/<name>/`,
[docs/repository-agents.md](../../../docs/repository-agents.md)) arrives in the
run brief: every file with its git mode, blob SHA and content, and the
definition digest LCARS pinned at admission. The launcher writes the files to
`/work/agent` only after each file's bytes hash to its blob SHA and the file
list hashes to the pinned digest; paths cannot leave that directory, and
executable files keep their mode. The definition's `config.json`,
`approvals.json` and `workspace/` (such as `AGENTS.md`) are read from there;
`config.json` is a source config; the launcher normalizes it for this image
(below).

## What a zone mounts

| Path                           | Source      | Contents                                                                                                                                                                    |
| ------------------------------ | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/run/claw-secrets/env/<NAME>` | zone Secret | Exported to OpenClaw as environment variable `NAME` (for example `LITELLM_API_KEY`). `LCARS_*`, `OPENCLAW_*`, `RUNNER_MODE`, `PATH`, `HOME` and `NODE_OPTIONS` are refused. |
| `/run/claw-secrets/<other>`    | zone Secret | Files the agent's own tools read by path (SSH keys, `known_hosts`).                                                                                                         |
| `/work`, `/tmp`                | `emptyDir`  | Writable state, workspace copy and `HOME`; the root filesystem stays read-only.                                                                                             |

The executor supplies `LCARS_CONSOLE_URL`, `LCARS_RUN_ID`, `LCARS_RUN_TOKEN` and
`CLAW_TURN_DEADLINE_SECONDS` (below the pod deadline, which is below the
lease).

## Trust boundary inside the pod

OpenClaw and the agent's tools run as the same UID as the launcher, so a tool
the agent is allowed to run could read the launcher's environment, including
`LCARS_RUN_TOKEN`. That token authorizes only heartbeat, brief and completion
for this one run, and the agent's own output already becomes that run's
report, so reading it grants no new authority. The zone Secret items are
mounted for the agent's tools by design; scope each runtime's items to what
that agent may use. A launcher SIGTERM (cancellation or pod deadline) stops
the whole OpenClaw process group and still settles the run.

## Launch sequence

Each step fails the attempt closed with a `runner-failed` completion:

1. Startup heartbeat must be acknowledged before anything else, then the
   brief must be a `claw` brief for this run: an agent round with its message
   and verified definition.
2. Fresh state directory with a writable copy of the pinned config.
3. `openclaw config validate --json` must report `valid: true`.
   `agent exec` itself silently ignores unknown keys.
4. `openclaw doctor --fix --non-interactive` initializes state (without it
   every config-pinned turn fails with "Auth profile read requested an
   uncaptured shared owner") and normalizes the config copy for this image.
   The turn runs on that copy. Doctor may only narrow the agent; any other
   change fails the attempt and names the changed settings (below).
5. `openclaw approvals set --file /work/agent/approvals.json`.
6. `openclaw agent exec --config … --state-dir … --message-file … --cwd … --json`
   under the outer deadline. OpenClaw's stderr is never forwarded, because it
   can echo resolved configuration.
7. Settle: `report` only when the envelope is `ok`, has a final message and
   no `toolSummary.unresolvedError`. When the agent's manifest sets
   `requireToolEvidence`, at least one tool call is also required. A tool call
   that failed and was resolved (a probe of a host that is down) is evidence,
   not a runner failure. `agent exec` exits 0 with `ok: true` even when every
   tool call was denied, so the exit code alone proves nothing.

## Agent config normalization

An agent's `config.json` is a source config: it does not have to match any
particular image. Doctor's normalization depends on the image (for example it
disables bundled skills whose binaries are absent), so the launcher runs it on
a copy inside the image that executes the turn, and the turn uses that copy.
The verified definition under `/work/agent` is never modified.

The source config is validated as written. Doctor then runs from a
disposable copy of the turn's workspace, as the turn runs from its own (so
relative paths such as `skills.load.extraDirs` resolve to equivalent places),
and the config copy's `agents.defaults.workspace` and every roster entry's
`workspace` point at it (overriding source values, as `agent exec --cwd`
does). Doctor
therefore judges skill readiness against the skills the turn loads (a
repository skill replacing a bundled one keeps it enabled), while its file
repairs (such as its `TOOLS.md` migration) never reach the turn. The turn's
config then points those workspaces back at the turn's own workspace.

Doctor may only narrow the agent (`doctorChanges` in `claw-job.mjs`):

- disable a skill (`skills.entries.<name>.enabled: false`): a bundled skill
  whose binaries the image lacks, or a repository skill whose declared
  requirements this image does not meet;
- enable a plugin that owns a model provider the config declares
  (`plugins.entries.<plugin>.enabled: true`, not one the config set). Ownership
  comes from the image's bundled `dist/extensions/*/openclaw.plugin.json`
  (`providers`, `autoEnableWhenConfiguredProviders`), matched
  case-insensitively as OpenClaw does, so `google-vertex` authorizes the
  `google` plugin and `LITELLM` the `litellm` plugin;
- add an empty agent entry (`agents.entries.<name>: {}`).

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

The tests drive the launcher against a fake Work API and a fake `openclaw`.
A real-image check (2026-11-14, OpenClaw 2026.10.10-beta.3, read-only root,
2 CPU / 3 GiB, Spark lane) settled a report in 58 s: the allowlisted `date`
ran and `cat /etc/hostname` returned `exec denied: allowlist miss`.

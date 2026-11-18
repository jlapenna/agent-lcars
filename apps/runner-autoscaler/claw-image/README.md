# Claw runner image

One agent turn per LCARS run attempt, for the `claw-*` pipelines, run by the
harness the agent's manifest names: embedded OpenClaw (the default) or an
[ACP harness](#acp-harnesses) the image carries. The design is the `claw` execute adapter in the
[unified work dataflow spec](../../../docs/superpowers/specs/2026-10-15-unified-work-dataflow-design.md#claw);
phase 3a is tracked in agent-lcars#3349.

The image holds the verified OpenClaw distribution and the ACP adapters for
Claude Code and Codex (`package.json` and `package-lock.json`, installed with
`npm ci` so every package is checked against its integrity hash), generic
clients (`openssh-client`, `python3`)
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
`config.json` must be Doctor-normalized (below).

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
   uncaptured shared owner"). If it changes anything but `meta`/`wizard`,
   the pinned config was not normalized and the attempt fails.
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

## ACP harnesses

An agent whose manifest names `harness: claude` or `harness: codex`
([docs/repository-agents.md](../../../docs/repository-agents.md#harnesses))
skips steps 2 to 6. The launcher is the ACP client instead:

1. It copies the definition's `home/` into `HOME`, so the harness reads its
   user-level settings (tool policy, model route) from reviewed source.
2. It starts the image's adapter (`ACP_HARNESSES` in `claw-job.mjs`) in its
   own process group, in the workspace copy, with the same clean environment
   OpenClaw gets: the zone's `env/` Secret items and nothing of the
   launcher's. The command always comes from the image.
3. It speaks ACP over the adapter's stdio: `initialize` (protocol 1, no file
   system or terminal capability), `session/new` in the workspace and one
   `session/prompt` carrying the message.
4. It answers every `session/request_permission` with the reject option. The
   agent can do only what its harness does without asking, which `home/`
   widens.
5. It settles from the session's updates: `report` only when the turn ended
   with `end_turn`, the agent's last message after its last tool call is not
   empty and no tool call is unresolved. A call that failed or never finished
   is unresolved unless a call that started after it ended completed. A harness error (a missing
   login, for example), an early exit, any other stop reason and an empty
   answer are `runner-failed`. `requireToolEvidence` needs at least one tool
   call.

After the turn, every `home/` file must still be the pinned blob. The harness
runs as the launcher's UID, so the launcher cannot stop an agent from
rewriting its own settings; it refuses the result instead.

Adapter stderr is never forwarded. The outer deadline and cancellation stop
the adapter's process group exactly as they stop OpenClaw's.

A check with the real adapters from this lockfile (2026-11-18, on a
workstation, against stand-in model endpoints) settled reports from Claude
Code and Codex in 3 to 4 s each. With Claude Code, a command allowed in
`home/.claude/settings.json` ran, and a write or network command without a
rule was refused and failed the attempt. Neither harness has made a real
model turn or run on k3s yet.

## Normalize an agent config

Doctor's normalization depends on the image (for example it disables bundled
skills whose binaries are absent), so produce the pinned config with the
exact image digest the zone will run:

```sh
docker run --rm --read-only --tmpfs /work:uid=1001 --tmpfs /tmp:uid=1001 \
  -v "$PWD/config.json:/in.json:ro" --entrypoint sh <claw-runner@digest> -c '
    mkdir -p /work/home /work/s && cp /in.json /work/s/c.json &&
    OPENCLAW_STATE_DIR=/work/s OPENCLAW_CONFIG_PATH=/work/s/c.json \
      "$OPENCLAW_BIN" doctor --fix --non-interactive >/dev/null 2>&1 &&
    node -e "const c=require(\"/work/s/c.json\");delete c.meta;delete c.wizard;console.log(JSON.stringify(c,null,2))"' \
  > config.normalized.json
```

Re-run this whenever the zone adopts a new image digest.

## Test

```sh
node --test apps/runner-autoscaler/claw-image/claw-job.test.mjs
```

The tests drive the launcher against a fake Work API, a fake `openclaw` and a
fake ACP harness.
A real-image check (2026-11-14, OpenClaw 2026.10.10-beta.3, read-only root,
2 CPU / 3 GiB, Spark lane) settled a report in 58 s: the allowlisted `date`
ran and `cat /etc/hostname` returned `exec denied: allowlist miss`.

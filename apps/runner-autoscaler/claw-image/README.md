# Claw runner image

One embedded OpenClaw agent turn per LCARS run attempt, for the `claw-*`
pipelines. The design is the `claw` execute adapter in the
[unified work dataflow spec](../../../docs/superpowers/specs/2026-10-15-unified-work-dataflow-design.md#claw);
phase 3a is tracked in agent-lcars#3349.

The image holds the verified OpenClaw distribution (`package.json` and
`package-lock.json`, installed with `npm ci` so every package is checked
against its integrity hash), generic clients (`openssh-client`, `python3`)
and the launcher, `claw-job.mjs`. It holds no agent definition, agent tool or
credential: a zone executor's runtime table mounts those.

## What a zone mounts

| Path                           | Source         | Contents                                                                                                                                                                    |
| ------------------------------ | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/claw/agent/config.json`      | zone ConfigMap | The agent's pinned OpenClaw config: model route (provider API key as an `env` SecretRef), deny-by-default tool policy. Must be Doctor-normalized (below).                   |
| `/claw/agent/approvals.json`   | zone ConfigMap | Host exec approvals: `defaults` `security: allowlist`, `ask: off`, `askFallback: deny`; the allowlist on agent `main`. These approvals enforce the exec allowlist.          |
| `/claw/agent/workspace/`       | zone ConfigMap | Workspace files such as `AGENTS.md`.                                                                                                                                        |
| `/run/claw-secrets/env/<NAME>` | zone Secret    | Exported to OpenClaw as environment variable `NAME` (for example `LITELLM_API_KEY`). `LCARS_*`, `OPENCLAW_*`, `RUNNER_MODE`, `PATH`, `HOME` and `NODE_OPTIONS` are refused. |
| `/run/claw-secrets/<other>`    | zone Secret    | Files the agent's own tools read by path (SSH keys, `known_hosts`).                                                                                                         |
| `/work`, `/tmp`                | `emptyDir`     | Writable state, workspace copy and `HOME`; the root filesystem stays read-only.                                                                                             |

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
   brief must be a `claw` brief for this run with a question.
2. Fresh state directory with a writable copy of the pinned config.
3. `openclaw config validate --json` must report `valid: true`.
   `agent exec` itself silently ignores unknown keys.
4. `openclaw doctor --fix --non-interactive` initializes state (without it
   every config-pinned turn fails with "Auth profile read requested an
   uncaptured shared owner"). If it changes anything but `meta`/`wizard`,
   the pinned config was not normalized and the attempt fails.
5. `openclaw approvals set --file /claw/agent/approvals.json`.
6. `openclaw agent exec --config … --state-dir … --message-file … --cwd … --json`
   under the outer deadline. OpenClaw's stderr is never forwarded, because it
   can echo resolved configuration.
7. Settle: `report` only when the envelope is `ok`, has a final message and
   no `toolSummary.unresolvedError`. `agent exec` exits 0 with `ok: true`
   even when every tool call was denied, so the exit code alone proves
   nothing.

## Normalize an agent config

Doctor's normalization depends on the image (for example it disables bundled
skills whose binaries are absent), so produce the pinned config with the
exact image digest the zone will run:

```sh
docker run --rm --read-only --tmpfs /work:uid=1000 --tmpfs /tmp:uid=1000 \
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

The tests drive the launcher against a fake Work API and a fake `openclaw`.
A real-image check (2026-11-14, OpenClaw 2026.10.10-beta.3, read-only root,
2 CPU / 3 GiB, Spark lane) settled a report in 58 s: the allowlisted `date`
ran and `cat /etc/hostname` returned `exec denied: allowlist miss`.

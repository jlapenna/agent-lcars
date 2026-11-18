# Repository-owned claw agents

Status: design (2026-11-15). This replaces the per-agent claw code shipped for
`claw/investigator` (phase 3a of the
[unified work dataflow design](superpowers/specs/2026-10-15-unified-work-dataflow-design.md#claw)).
It follows [repository jobs](repository-jobs.md): a repository defines what
runs, an operator-owned profile grants authority, and LCARS admits, runs and
records it.

Every rule below protects something specific: reviewed source, credentials, or
a fail-closed tool policy. Anything else is left to the agent's definition.

## What a repository owns

A repository defines an agent in `.lcars/agents/<name>/`:

```text
.lcars/agents/investigator/
  agent.yaml        # manifest
  config.json       # OpenClaw source config; the launcher normalizes it per image
  approvals.json    # exec approvals: the enforcement layer
  workspace/        # AGENTS.md, skills, tools (git file modes apply)
```

`agent.yaml` needs only a description. Every other field is optional:

```yaml
description: Read-only Homelab fleet investigator.
profile: homelab-ops # credentials; omitted = the default profile
retry: finite # finite (default) | terminal, for agents with effect authority
requireToolEvidence: true # a report with no tool call is a failed attempt
```

Concurrency and resources are not agent fields: the executor runtime the
profile names sizes and bounds its Jobs.

The agent ID is `<owner>/<repo>/<name>`, for example
`jlapenna/homelab/investigator`.

## Catalog

Agents are cataloged by the repository-job catalog, with the same rules:

- It reads an exact default-branch commit of every control-plane repository on
  the maintenance tick.
- The manifest YAML is strict: unknown fields, aliases and duplicate keys fail.
  A misspelled field must fail rather than be ignored.
- An invalid definition stays visible with its error and cannot run.
- Deleting a definition stops new admission. A failed refresh disables
  admission.
- An agent activates on merge, and the operator veto is sticky.

The catalog reads the agent's directory instead of two named files. Its digest
covers every path, mode and content.

## A run

A run takes one `message`, free text that becomes the agent's brief, and
returns the agent's final report. LCARS imposes no shape on either. An agent
that wants structure says so in its own `AGENTS.md`.

Typed inputs and results can be added later, as optional manifest declarations,
when a consumer needs them.

## Profiles

A profile is operator configuration, never repository content, so a repository
cannot grant itself credentials by writing a manifest. Profiles are a JSON
array in `AGENT_LCARS_AGENT_PROFILES`, next to the job profiles, each with a
`name` and:

- **`runtime`** names the executor runtime (`claw-<name>`) that runs the
  agent's Jobs. The executor's own config sets that runtime's image, Secret
  items, defaults and claiming principal. Homelab owns that config and those
  credentials; LCARS never sees them.
- **`repositories`** lists the repositories whose agents may use the profile,
  and the optional **`principals`** limits who may invoke them. The caller's
  grant must also list the runtime.

The **default profile** runs on the shared executor's `claw-default` runtime,
which holds only a model key. An agent that needs no other credential therefore
runs from a repository PR alone.

Agents that share a profile share its credentials. An agent that must not see
another's credentials gets its own profile.

## Admission and delivery

- **Admission:** `POST /api/work/v1/claw/agents/{owner}/{repo}/{name}/runs`
  with `{message, requestId?, sourceKey?}`. The caller needs `work.claw.admit`
  and a grant covering the agent's runtime, and the agent must be enabled.
  `lcars investigate` becomes this call against
  `jlapenna/homelab/investigator`.
- **Pinning:** the round's revision input pins the definition (revision,
  digest, each file's path, mode and blob SHA), `requireToolEvidence` and the
  message. A later merge cannot change a round already admitted. A repeated
  `requestId` with the same message is the same round, and `sourceKey`
  coalesces rounds on one subject. Admission needs no reservation transaction:
  claims already bound concurrency.

- **Execution:**
  - Work runs on the profile's runtime pipeline. Grants and stored specs accept
    any `claw-*` pipeline instead of a closed enum.
  - The manifest's `retry: terminal` makes lost and failed attempts terminal.
- **Delivery:**
  - The Job's existing run brief (`GET /runs/{id}/brief`) carries the pinned
    definition and the message. LCARS reads each file from GitHub by its blob
    SHA, so nothing large is stored inline. A report too large for the run
    record is stored out of line, not truncated.
  - The launcher materializes the files into `/work/agent` and checks the
    digest. It then runs `config validate`, `doctor --fix` on a copy (which
    may only narrow the reviewed config for the image it runs on; any other
    change fails the run and names the changed settings), `approvals set` and
    `agent exec`. A runtime's image can therefore change without every
    repository re-normalizing its agents.

  Zone ConfigMaps carrying agent definitions are retired.

- **Run callers:** a dispatched run may invoke an agent with its run token
  (`lcars investigate`) through `POST /runs/{runId}/agents/{owner}/{repo}/{name}`
  and read its rounds back through `GET /runs/{runId}/agent-runs/{workId}`, as
  principal `run:<runId>`, only when the agent's profile sets
  `runCallers: true`. A run reads back only the rounds it admitted, and an
  agent's own run cannot invoke agents, so agent Jobs never chain.

Trust follows from this:

- The definition is reviewed default-branch source, pinned by commit.
- Credentials stay in the executor's runtime.
- A profile decides which repositories' agents may use that runtime.
- LCARS chooses neither the credentials nor the tool policy. It delivers the
  reviewed definition.

## What this retired

The per-agent investigator path is gone. Every claw run is a repository-owned
agent round admitted through the generic route.

- `CLAW_PIPELINES` and the claw discriminated spec union: the claw spec is the
  agent spec, and its pipeline is any `claw-*` runtime.
- `claw-investigate-work.ts`, `POST /claw/investigations` and the
  `investigate:v1` operation with its input schema and the run brief's
  operation member.
- `EVIDENCE_OPERATIONS`, replaced by the manifest's `requireToolEvidence`.
- The hard-coded claw entry in `QUEUE_PIPELINE_MAX_LIVE_CLAIMS` (the executor
  runtime bounds claw concurrency) and the claw names in the grant pipeline
  enum (grants admit any `claw-*` runtime by pattern).
- The executor runtime's `agent` ConfigMap block, its subPath mounts and
  preflight check, and the launcher's `CLAW_AGENT_DIR` mount. The strict
  executor config decoder now refuses an `agent` block.
- Homelab's `claw/agents/` directory and its agent ConfigMap (retired in
  Homelab).
- Firestore Work records of the old investigator shape, purged before the
  code was removed.

## Migration and acceptance

1. Homelab moves `claw/agents/investigator/` to
   `.lcars/agents/investigator/`. It keeps runtime `claw-homelab-ops` (today's
   investigator Secret), and an operator adds profile `homelab-ops` for
   `jlapenna/homelab`.
2. The shared executor gains runtime `claw-default` with a model key only.
   `.lcars/agents/smoke/` in this repository is its canary (done).
3. LCARS ships the catalog extension, the generic route, `/runs/{id}/agent`
   and the launcher change. It then points `lcars investigate` at the generic
   route and removes the investigator-specific code (done).

Acceptance:

- A real investigation runs from `jlapenna/homelab/investigator` through the
  generic route, and `lcars investigate` works again.
- An agent with no profile, added by a repository PR alone, runs end to end on
  k3s.
- A manifest naming a profile that does not list its repository is visible and
  refused.

On-call is not a claw agent and does not depend on LCARS (2026-11-15
decision).

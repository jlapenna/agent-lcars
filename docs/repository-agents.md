# Repository-owned claw agents

Status: design (2026-11-15). This replaces the per-agent claw code shipped for
`claw/investigator` (phase 3a of the
[unified work dataflow design](superpowers/specs/2026-10-15-unified-work-dataflow-design.md#claw)).
It follows [repository jobs](repository-jobs.md): a repository defines what
runs, an operator-owned profile grants authority, and LCARS admits, schedules,
runs and records it.

## What a repository owns

A repository defines an agent in `.lcars/agents/<name>/`:

```text
.lcars/agents/investigator/
  agent.yaml        # manifest
  config.json       # OpenClaw config, Doctor-normalized for the pinned image
  approvals.json    # exec approvals: the enforcement layer
  workspace/        # AGENTS.md, skills, tools
```

`agent.yaml`:

```yaml
description: Read-only Homelab fleet investigator.
profile: homelab-ops # operator-owned; see Profiles
operations: [investigate:v1] # shared, versioned operation contracts
requireToolEvidence: true # a report with no tool call is a failed attempt
retry: finite # finite | terminal (agents with effect authority)
maxLiveClaims: 2
allocation: { cpu: '2', memory: 3Gi, storage: 8Gi } # requests equal limits
turnDeadlineSeconds: 1500
executables: [workspace/tools/homelab-investigate] # files materialized 0555
```

The agent ID is `<owner>/<repo>/<name>`, for example
`jlapenna/homelab/investigator`.

## Catalog

The repository-job catalog reads agents the same way and with the same rules:

- It reads an exact default-branch commit of every control-plane repository on
  the maintenance tick.
- YAML is strict: no aliases, no duplicate keys, no unknown fields.
- An invalid definition stays visible with its error and cannot run.
- Deleting a definition stops new admission.
- A failed refresh disables admission.
- An agent activates on merge, and the operator veto is sticky.

The only extension is reading a directory instead of two named files.

- **Digest:** the definition digest covers the sorted `(path, content)` pairs.
- **File modes:** git modes are ignored. The manifest's `executables` list is
  the only source of execute permission.

## Operations

An operation is a shared, versioned input and result contract that any agent
may declare. It is not tied to an agent. The first is `investigate:v1`: input
`{question}` (at most 4000 characters), result a report (at most 16 KB).
Adding an operation is an LCARS change. Adding an agent that uses existing
operations is not.

## Profiles

A profile is operator configuration, never repository content, so a repository
cannot grant itself credentials by writing a manifest. It reuses
`AGENT_LCARS_JOB_PROFILES` with one added field, `runtime`.

- **`runtime`** names the executor runtime (`claw-<name>`) that runs the
  agent's Jobs. The executor's own trusted config gives that runtime its image,
  its Secret items and which principal may claim it. Homelab owns that config
  and those credentials. LCARS never sees them.
- **`repositories`** lists the repositories whose agents may use this profile.
- **`principals`** lists the principals that may invoke those agents.

Claw agents have no built-in profile. An agent that needs only a model key
uses a profile whose runtime mounts nothing but that key.

Agents that share a profile share its credentials. Give an agent that must not
see another agent's credentials its own profile and runtime.

## Admission and delivery

- **Admission:** `POST /api/work/v1/claw/agents/{owner}/{repo}/{name}/runs`
  with `{operation, input, requestId, sourceKey?}`. The caller needs the
  `work.claw.admit` scope and a grant listing the profile's runtime. The agent
  must be enabled, and the operation must be one the manifest declares. The
  input must validate against that operation's schema.
- **Reservation:** this reuses the repository-job reservation transaction. The
  occurrence pins:
  - the definition (revision and digest, not file contents);
  - the profile;
  - the input.

  Work identity is deterministic per `requestId`, and `sourceKey` coalesces
  rounds as investigations do today.

- **Execution:**
  - Work runs on pipeline `runtime`. Grants and stored specs accept any
    `claw-*` pipeline in place of a closed enum.
  - The claim ceiling is the manifest's `maxLiveClaims`.
  - Retry follows the manifest's `retry` setting.
- **Delivery:** the Job fetches its definition with the run token from
  `GET /runs/{id}/agent`, the counterpart of `GET /runs/{id}/recipe`. LCARS
  reads the agent directory from GitHub at the pinned revision and streams it
  with the operation and input. Nothing is stored inline, so a definition's
  size is not limited by the occurrence record. The launcher:
  - materializes the files into `/work/agent`, applying the executable modes;
  - checks the digest;
  - then runs today's sequence: `config validate`, `doctor` (which must change
    nothing), `approvals set`, `agent exec`.

  Zone ConfigMaps carrying agent definitions are retired.

Trust follows from this. The definition is reviewed source on the default
branch and pinned by commit. Credentials stay in the executor's runtime. A
profile decides which repositories' agents may use a runtime. LCARS chooses
neither the credentials nor the tool policy; it delivers the reviewed snapshot.

## What this retires

- `CLAW_PIPELINES` and the claw discriminated spec union.
- `claw-investigate-work.ts` and `POST /claw/investigations`.
- `EVIDENCE_OPERATIONS`, replaced by the manifest's `requireToolEvidence`.
- The hard-coded claw entries in `QUEUE_PIPELINE_MAX_LIVE_CLAIMS` and the grant
  pipeline enum.
- Homelab's `claw/agents/` directory and its agent ConfigMap.

## Migration and acceptance

1. Homelab moves `claw/agents/investigator/` to
   `.lcars/agents/investigator/`. Homelab keeps executor runtime
   `claw-homelab-ops` (today's investigator Secret).
2. An operator adds profile `homelab-ops` (runtime `claw-homelab-ops`,
   repository `jlapenna/homelab`).
3. LCARS ships the catalog extension, the generic route, `/runs/{id}/agent`
   and the launcher change, then removes the investigator-specific code once
   the investigator runs through the generic path.

Acceptance:

- A real investigation runs from `jlapenna/homelab/investigator` through the
  generic route with no investigator-specific LCARS code.
- A second read-only agent added by a repository PR alone (on an existing
  profile) runs end to end on k3s.
- A manifest naming a profile that does not list its repository is visible and
  refused.

On-call is not a claw agent and does not depend on LCARS (2026-11-15
decision).

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
  config.json       # OpenClaw config, Doctor-normalized for the pinned image
  approvals.json    # exec approvals: the enforcement layer
  workspace/        # AGENTS.md, skills, tools (git file modes apply)
```

`agent.yaml` needs only a description. Every other field is optional:

```yaml
description: Read-only Homelab fleet investigator.
profile: homelab-ops # credentials; omitted = the default profile
retry: finite # finite (default) | terminal, for agents with effect authority
requireToolEvidence: true # a report with no tool call is a failed attempt
harness: claude # openclaw (default) | claude | codex; see Harnesses
```

Concurrency and resources are not agent fields: the executor runtime the
profile names sizes and bounds its Jobs.

The agent ID is `<owner>/<repo>/<name>`, for example
`jlapenna/homelab/investigator`.

## Harnesses

`harness` names the program that runs the agent's turn. The claw runner image
carries every harness, pinned by its lockfile. A definition chooses among
them by name and cannot supply a command of its own.

| `harness`            | Runs the turn with | The definition supplies                                |
| -------------------- | ------------------ | ------------------------------------------------------ |
| `openclaw` (default) | OpenClaw           | `config.json`, `approvals.json`, `workspace/`, `home/` |
| `claude`             | Claude Code        | `workspace/` (`CLAUDE.md`), `home/.claude/`            |
| `codex`              | Codex              | `workspace/` (`AGENTS.md`), `home/.codex/`             |

Every harness is an [Agent Client Protocol](https://agentclientprotocol.com/)
(ACP) agent, and the launcher is only an ACP client. It starts the harness in
a copy of `workspace/`, copies `home/` into the harness's `HOME`, sends the
message as one prompt and takes the agent's last message after its last tool
call as the report. Claude Code and Codex speak ACP through their own
adapters. OpenClaw speaks it through its own server, `openclaw acp`, which
forwards to a Gateway: the launcher validates the config, runs Doctor, seeds
the exec approvals and starts a Gateway on loopback inside the Job for that
one turn. No shared or long-lived Gateway is involved, so a lost node still
costs one attempt.

```text
.lcars/agents/reviewer/
  agent.yaml        # harness: claude
  workspace/        # the agent's working directory: CLAUDE.md or AGENTS.md
  home/             # the harness's user-level settings, copied into HOME
    .claude/settings.json   # Claude Code: permissions
    .codex/config.toml      # Codex: model route, approval and sandbox policy
```

- **Tool policy.** The launcher refuses every permission request and gives the
  harness no file system or terminal of its own, because an unattended run has
  nobody to ask. What an agent may do is therefore what its harness does
  without asking, and the definition is where reviewed source sets that:
  - OpenClaw runs only the commands `approvals.json` allows; its config
    selects tools and cannot widen them.
  - Claude Code reads files and runs read-only commands (`date`) unasked. It
    asks before writing or reaching the network, so those need an allow rule
    in `home/.claude/settings.json`. It ignores allow rules in
    `workspace/.claude/settings.json`, because the workspace is not a trusted
    directory, but applies deny rules from either file.
  - Codex runs commands in its own sandbox: it writes inside the workspace
    unasked and blocks writes elsewhere and the network.
    `home/.codex/config.toml` sets its approval and sandbox policy.

  The harness runs as the launcher's user, so an agent allowed a tool that
  writes files could rewrite the settings that bound it. The launcher cannot
  prevent that. It makes each pinned `home/` file read-only and fails the
  attempt when one is not its pinned blob after the turn; it does not see a
  file the agent added, or changed and put back. A harness that must not be
  able to do this needs its own container (#3412).

- **Credentials.** A harness signs in with the environment its runtime exports
  from `env/` Secret items: the model key its `config.json` names for
  `openclaw`, `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` for `claude`,
  `CODEX_API_KEY` or `OPENAI_API_KEY` for `codex`. A runtime without one fails
  the attempt with the harness's `Authentication required`. The default
  runtime holds only a model key, so a `claude` or `codex` agent names a
  profile whose runtime carries its harness's login.
- **Evidence.** One set of rules for every harness, read from the ACP
  session. An answer with no text is a failed attempt. So is a tool call that
  failed or never finished, unless a call that started after it ended
  completed; that later call is resolved evidence, as a retried probe is.
  `requireToolEvidence` needs at least one tool call. Codex's adapter
  sometimes leaves a command its sandbox blocked at once out of the session
  (3 of 8 runs on 2.1.1), so that failure can go unseen; a Codex agent whose
  answer must rest on a tool sets
  `requireToolEvidence`.

Verified on 2026-11-18 on a workstation, with the pinned OpenClaw and both
adapters against stand-in model endpoints. No real model turn and no run on
k3s has been made through this path yet, and Codex's sandbox is untested
inside a pod.

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
  digest, each file's path, mode and blob SHA), `requireToolEvidence`, a
  non-default `harness` and the message. A later merge cannot change a round already admitted. A repeated
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
    digest. It then runs the agent's [harness](#harnesses) as an ACP agent.
    For OpenClaw that starts with `config validate`, `doctor` (which must
    change nothing, proving the reviewed config is what runs) and
    `approvals set`.

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

## Health

Catalog and run health reach Homelab's Prometheus through the executors'
existing metrics endpoints; nothing here adds a scrape target.

- **Catalog:** each maintenance reply carries `repositoryAgents`: agents by
  admission state (enabled, vetoed, invalid, unavailable, removed) and, for
  up to 100 still-refreshed repositories, the last refresh attempt, the last
  successful refresh (read and published), the last failed one (reading
  GitHub or publishing; the Console log names which) and how many stored
  agents a failed refresh left unavailable. A failed manifest read fails the
  refresh rather than marking the agent invalid, and a non-file `agent.yaml`
  is that definition's own error, never fetched. Outcomes live in their own
  `orchestrator-agent-source-health` collection, so the strict source
  document is unchanged. The shared executor exports them as
  `lcars_repository_agents*` and `lcars_repository_agent_source_*`. An
  observation that fails, is late for the maintenance deadline, is invalid
  on the wire or would overflow the reply is omitted without failing
  maintenance, and the executor then reports `read_available 0`, never a
  healthy zero. Agent names, errors and messages never leave the console.
- **Runs:** every executor counts delivered worker exits by pipeline and
  settled outcome (`github_runner_autoscaler_queue_executor_run_exits_total`),
  with Job wall time and an ordered failure streak
  (`..._run_consecutive_failures`). The zone executor's series are the claw
  runtimes' (`claw-investigator`, `claw-default`), zero from start. The exit
  route answers a finished run's `ok` for this.
- Homelab owns the dashboard and alerts (its `docs/claw-zone.md`).

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

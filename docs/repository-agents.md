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
harness: claude # openclaw (default) | claude | codex; see Harnesses
mode: plan # the harness's ACP session mode; see below when omitted
```

Without `mode`, OpenClaw and Claude Code run in their own default mode and
Codex runs in `workspace-write`, which the launcher selects in place of
Codex's own default ([tool policy](#harnesses)).

Concurrency and resources are not agent fields: the executor runtime the
profile names sizes and bounds its Jobs.

The agent ID is `<owner>/<repo>/<name>`, for example
`jlapenna/homelab/investigator`.

## Harnesses

`harness` names the program that runs the agent's turn. The claw runner image
carries every harness, pinned by its lockfile. A definition chooses among
them by name and cannot supply a command of its own.

| `harness`            | Runs the turn with | The definition supplies                       |
| -------------------- | ------------------ | --------------------------------------------- |
| `openclaw` (default) | OpenClaw           | `config.json`, `approvals.json`, `workspace/` |
| `claude`             | Claude Code        | `workspace/` (`CLAUDE.md`), `home/.claude/`   |
| `codex`              | Codex              | `workspace/` (`AGENTS.md`), `home/.codex/`    |

`home/` is applied only to a definition whose `agent.yaml` names a `harness`
or a `mode`. An OpenClaw agent that wants user-level settings names
`harness: openclaw`. A definition that names neither runs as it did before
harnesses existed, so files it happens to keep under `home/` stay unused,
and a round already admitted for it is not changed by a newer image or
Console.

Every harness is an [Agent Client Protocol](https://agentclientprotocol.com/)
(ACP) agent, and the launcher is only an ACP client. It starts the harness in
a copy of `workspace/`, copies `home/` into the harness's `HOME` for a
definition that asked for it, sends the message as one prompt and takes the
agent's last message after its last tool call as the report. Claude Code and Codex speak ACP through their own
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
    .codex/config.toml      # Codex: model and provider settings only
```

Codex's approval and sandbox policy is not set in that file: it comes from
`mode` in `agent.yaml`, described under tool policy below.

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
  - Codex runs commands in its own sandbox, and its adapter sets that sandbox
    and approval policy from the session's mode on every turn, overriding
    `sandbox_mode` and `approval_policy` in `home/.codex/config.toml`. The
    adapter's own default, `agent`, lets Codex approve some escalations
    itself, outside the sandbox and without asking. The launcher therefore
    runs Codex in `workspace-write` unless the manifest names a mode: Codex
    writes inside the workspace and its temporary directories unasked, and
    asks before anything else, which the launcher refuses.

  `mode` in the manifest selects the harness's ACP session mode before the
  prompt, so it is where a definition states a policy the harness enforces
  itself: `read-only` or `workspace-write` for Codex, `plan` or `acceptEdits`
  for Claude Code. A harness that does not offer the mode, or refuses to
  switch to it, runs nothing and the attempt fails.

  The harness runs as the launcher's user, so an agent allowed a tool that
  writes files could rewrite the settings that bound it. The launcher cannot
  prevent that. It makes each pinned `home/` file read-only and fails the
  attempt when one is not its pinned blob after the turn; it does not see a
  file the agent added, or changed and put back. A harness that must not be
  able to do this needs its own container (#3412).

- **Credentials.** A harness signs in with the environment its runtime exports
  from `env/` Secret items: the model key its `config.json` names for
  `openclaw`, `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` for `claude`,
  `CODEX_API_KEY` or `OPENAI_API_KEY` for `codex`. Codex opens a session with
  a key only once its client chooses that sign-in, so the launcher signs in
  with Codex's `api-key` method when Codex asks. A runtime without a login
  fails the attempt, naming the missing key or `Authentication required`.
  For OpenClaw, provider credentials are resolved into the launch config and
  left out of the Gateway's environment, so a command the agent is allowed to
  run does not inherit them. A variable is a credential when the pinned
  OpenClaw lists it as one a provider reads (the same list `agent exec`
  filtered), when the config names it as an `env` SecretRef, or when a
  provider's `apiKey` or `headers` names it in a `${NAME}` or
  `${NAME:-default}` template. An empty variable counts as unset, as it
  does for OpenClaw. A custom
  key that is only named some other way stays in the environment, so name it
  as a SecretRef. A declared provider with no `apiKey` is given the key it
  would have found in the environment. A provider that is not declared under
  `models.providers` and relied on finding its key there no longer
  authenticates; declare it. A SecretRef is resolved only as OpenClaw would
  resolve it: through an `env` provider the config declares, within that
  provider's `allowlist`. A variable the config defines under `env.vars` is
  treated the same way: one that is a credential, or is built from one,
  still reaches the provider settings that name it and is then left out of
  what the Gateway, and so a command, inherits. Other `env.vars` entries are
  kept. An OpenClaw definition whose model key came from an
  auth-profile store in its configured `agentDir` no longer authenticates
  either, because the Gateway keeps agent state under the Job's own state
  directory; give the provider its key as an `env` SecretRef instead. The launch config is readable by the agent's
  user, so this keeps a key out of a command's output, not out of an agent's
  reach. The default runtime holds
  only a model key, so a `claude` or `codex` agent names a profile whose
  runtime carries its harness's login and lists the harness
  ([profiles](#profiles)).
- **Evidence.** One set of rules for every harness, read from the ACP
  session. An answer with no text is a failed attempt. So is a tool call that
  failed or never finished, unless a call that started after it ended
  completed; that later call is resolved evidence, as a retried probe is.
  `requireToolEvidence` needs at least one tool call. OpenClaw's ACP server
  ends a turn its Gateway failed like any other, even after part of an answer
  has streamed, so the launcher also asks the Gateway how it recorded the
  session and fails the attempt unless its last run finished. A model
  attempt that failed before a fallback answered still finished. Neither
  that nor the Gateway's readiness is read from its log, so a definition's
  logging and redaction settings do not affect them. An OpenClaw turn gets
  ten minutes whatever timeout its config sets. Codex's adapter
  does the same when its provider fails, and reports the failure only to a
  client that asks for it, so the launcher asks and fails the attempt on a
  failure Codex reports as an error. Codex's adapter
  sometimes leaves a command its sandbox blocked at once out of the session
  (3 of 8 runs on 2.1.1), so that failure can go unseen; a Codex agent whose
  answer must rest on a tool sets
  `requireToolEvidence`.

A change to the launcher, a harness or a pinned harness version is checked
by running the launcher with the harnesses installed from the image's
lockfile, as well as by its unit suite, because the launcher depends on
behavior only the real binaries have
([claw image](../apps/runner-autoscaler/claw-image/README.md#checking-a-change)).
What was run for a change, and what was not, is recorded in its pull
request; for the introduction of harnesses that is
[#3411](https://github.com/jlapenna/agent-lcars/pull/3411).

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

The message is always the agent's to read. A harness would take some
messages as commands of its own (one that begins with `/`, or a bare `halt`),
so the launcher sends every message after one line saying it is the request
itself, and otherwise unchanged.

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
- **`harnesses`** lists the harnesses the runtime can run; omitted means
  `openclaw` only. An operator adds `claude` or `codex` once the runtime's
  image carries that harness and its Secret holds the harness's login. An
  agent whose harness its profile does not list is refused at admission.

The **default profile** runs on the shared executor's `claw-default` runtime,
which holds only a model key and runs only `openclaw` agents. An OpenClaw
agent that needs no other credential therefore runs from a repository PR
alone.

Agents that share a profile share its credentials. An agent that must not see
another's credentials gets its own profile.

## Admission and delivery

- **Admission:** `POST /api/work/v1/claw/agents/{owner}/{repo}/{name}/runs`
  with `{message, requestId?, sourceKey?}`. The caller needs `work.claw.admit`
  and a grant covering the agent's runtime, and the agent must be enabled.
  `lcars investigate` becomes this call against
  `jlapenna/homelab/investigator`.
- **Pinning:** the round's revision input pins the definition (revision,
  digest, each file's path, mode and blob SHA), `requireToolEvidence`, the
  `harness` whenever the manifest names one (`openclaw` included), the `mode`
  when it names one, and the message. A round that pinned either is
  delivered in the versioned brief and has to finish before a Console
  downgrade ([rollback](#migration-and-acceptance)). A later merge cannot change a round already admitted. A repeated
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
  - A round that names a harness or a mode carries its files in the brief
    as `definition`, not `files`, and only such a round has its `home/`
    settings applied. A launcher from before harnesses reads only
    `files`, so on an image that predates them (or after a rollback to one)
    the attempt fails instead of running the agent on OpenClaw under a policy
    its definition never asked for.
  - The launcher materializes the files into `/work/agent` and checks the
    digest. It then runs the agent's [harness](#harnesses) as an ACP agent.
    For OpenClaw that starts with `config validate`, `doctor --fix` on a copy
    (the turn keeps only accepted changes such as the declared provider's
    plugin, and never Doctor's skill toggles; any other change fails the run
    and names the changed settings) and `approvals set`. A runtime's image can
    therefore change without every repository re-normalizing its agents.

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

Rolling the Console back to a version from before harnesses. Do these
while the newer Console is still running, in this order:

1. Cancel any affected round (step 3 says which) that you will not wait
   for and that a grant admitted. Only the principal that admitted a round
   can cancel it, and only while it holds `work.claw.admit` for the round's
   pipeline, so this is not possible once the fence in step 2 is up. A
   round a dispatched run started through `runCallers` belongs to that run,
   which holds no grant: it cannot be cancelled this way and has to drain
   in step 3.
2. Stop new rounds. Remove `work.claw.admit` from every grant in
   `AGENT_LCARS_WORK_GRANTS` and turn `runCallers` off in every profile, so
   nothing can admit an agent round. A grant must keep at least one scope:
   where `work.claw.admit` is a grant's only scope, as it is for
   `svc:claw-operator`, remove the whole grant and keep a copy to restore.
   An agent has no switch of its own to disable it; the grant is the fence.
   These are settings of the Console's deployed revision, so the fence is a
   deploy. Leave it in place until step 8.
3. Wait until every affected round has reached a terminal state: finished,
   failed for good, or cancelled. That includes attempts that are claimed or
   running now and any retry they may still get, because a retry does not go
   through admission. Roll back neither the Console nor the image before
   then. Affected are:
   the rounds that pinned a `harness` or a `mode`. The earlier Console
   cannot read such a round, so it can neither deliver its brief nor retry
   it. A round keeps the revision it was admitted with, so nothing done to
   the default branch changes it. Rounds of agents that name neither are
   unaffected: they never had `home/` settings applied.

4. Take `harness` and `mode` out of every manifest that names one, on each
   repository's default branch. For a `claude` or `codex` definition that
   also has `config.json` and `approvals.json`, remove those two files as
   well: without its `harness` it would otherwise be a valid OpenClaw agent
   and run as one. Leave them in place for a definition that only spelled
   out `harness: openclaw`; it is an OpenClaw agent either way and needs
   them. Wait for the catalog to refresh.
5. Check that no agent in the catalog, enabled or not, still shows either
   field. The earlier Console reads stored rows with a strict schema, and
   one row with a field it does not know stops it listing and refreshing the
   catalog for every repository. Deleting an agent does not clear its row:
   the row is only disabled and keeps the stored manifest. For the row of an
   agent that is no longer in its repository, or whose repository is gone or
   can no longer be read, remove the `definition` field from its document in
   the `orchestrator-agents` collection and leave the rest. The row has to
   stay, disabled, because it holds the operator's veto (`vetoedBy`): if the
   definition or the repository comes back, a refresh that found no row
   would enable the agent.
6. Remove `harnesses` from every profile in `AGENT_LCARS_AGENT_PROFILES`.
   The earlier Console validates profiles at startup with a strict schema and
   does not start with a field it does not know.
7. Roll the Console back with a build of the earlier version whose settings
   carry the fence from step 2 and the profiles from step 6. Pinning the
   earlier revision is not enough: a revision brings its own settings
   (`apps/console/apphosting.yaml`), so its grants and `runCallers` would
   come back at cutover and admission would reopen.
8. Lift the fence with a further deploy of that version: restore the grants,
   and restore `runCallers` on each profile that had it, since the earlier
   Console lets a dispatched run invoke an agent only through that flag. If
   Before that, whether or not the claw image went back, deal with every
   OpenClaw agent that relied on `home/` settings: one whose manifest named
   `harness: openclaw`, or named only a `mode`, before step 4. With those
   lines gone the earlier Console delivers its rounds as `files`, and no
   launcher applies `home/` to such a round, so the agent would run without
   its reviewed settings. If it can run without them, nothing more is
   needed. Otherwise keep the agent fenced: no grant that holds
   `work.claw.admit` lists its runtime, and `runCallers` stays off on its
   profile. Leave the runtime in the executor's own grant (`work.executor`):
   rounds of other agents already queued on it are claimed through that
   grant and would stall without it.

   That fence is per runtime and per profile, not per agent. While it
   stays, no other agent on the same runtime or profile can be admitted
   either, and every agent without a profile shares `claw-default`. To keep
   those agents running, disable only the incompatible one: delete its
   definition from the default branch, which stops its admission, check that
   its catalog row shows it disabled, and then restore the shared grant and
   `runCallers`.

Rolling back only the claw image, with the newer Console still running,
needs no step: a round that needs the newer launcher is delivered in a shape
the earlier one refuses, so the attempt fails instead of running on OpenClaw.

Acceptance:

- A real investigation runs from `jlapenna/homelab/investigator` through the
  generic route, and `lcars investigate` works again.
- An agent with no profile, added by a repository PR alone, runs end to end on
  k3s.
- A manifest naming a profile that does not list its repository is visible and
  refused.

On-call is not a claw agent and does not depend on LCARS (2026-11-15
decision).

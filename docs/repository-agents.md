# Repository-owned claw agents

Status: the catalog, admission and the OpenClaw launcher path are in
production (#3382 through #3410). The ACP launcher that runs agents on
OpenClaw, Claude Code or Codex (#3411) is implemented, but production still
runs an earlier `claw-runner` image; it reaches production with a new image
publish and Homelab pin. [Acceptance](#acceptance) records what production
has shown. This replaces the per-agent claw code shipped for
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

Merge or enable a definition that names a `harness` or a `mode` only once
the runtime it runs on has a claw image that knows harnesses pinned,
`claw-default` included. The Console admits such a definition as soon as it
is deployed, and delivers its rounds in the brief shape an earlier launcher
refuses. On an earlier image every such round fails, and a `retry:
terminal` round fails for good.

Every harness is an [Agent Client Protocol](https://agentclientprotocol.com/)
(ACP) agent, and the launcher is only an ACP client. It writes the pinned
definition and, for a definition that asked for it, the `home/` files into
the harness's `HOME`. A harness host then starts the harness in a copy of
`workspace/` ([the harness container](#the-harness-container)). The launcher
sends the message as one prompt and takes the agent's last message after its
last tool call as the report. Claude Code and Codex speak ACP through their own
adapters. OpenClaw speaks it through its own server, `openclaw acp`, which
forwards to a Gateway: the harness host validates the config, runs Doctor,
seeds the exec approvals and starts a Gateway on loopback inside the Job for
that one turn. No shared or long-lived Gateway is involved, so a lost node still
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
  prompt. What a mode controls is the harness's own business. For Codex and
  Claude Code it is the permission policy the harness enforces itself:
  `read-only` or `workspace-write` for Codex, `plan` or `acceptEdits` for
  Claude Code. For OpenClaw a mode such as `low` is a thinking level and
  changes no permission: its tools stay bound by its config and
  `approvals.json`. A harness that does not offer the mode, or refuses to
  switch to it, runs nothing and the attempt fails.

  Whether an agent with a tool that writes files can rewrite the settings
  that bound it depends on where its harness runs
  ([the harness container](#the-harness-container)). In a container of its
  own, it cannot: the kernel keeps the pinned definition and each pinned
  `home/` file as the launcher wrote them. In the launcher's container it
  can, and the launcher can only fail the attempt when a pinned `home/` file
  is not its blob after the turn; it does not see a file the agent added, or
  changed and put back.

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
  authenticates; declare it. The same holds for a credential one of
  OpenClaw's own tools or plugins reads only from the environment, such as
  `GEMINI_API_KEY` for Google web search with no `models.providers.google`
  entry: the Gateway no longer has it. Name it as an `env` SecretRef at the
  tool's own key setting, which the launcher resolves like any other, and
  migrate such definitions before the image that carries this launcher is
  pinned. A SecretRef is resolved only as OpenClaw would
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
  `requireToolEvidence` needs at least one tool call. The report is the
  agent's final answer. OpenClaw's ACP server streams what the agent says on
  the way and the answer as one message when no tool ran between them, so
  for OpenClaw the launcher finds the answer in that stream with the
  Gateway's own record of the final reply. There is one exception an author
  who relies on a strict output format should know: when the Gateway gives
  no record of the reply, or the record cannot be found in the stream, the
  report is everything OpenClaw streamed after the last tool call, which
  can begin with what the agent said on the way (`Checking files nowDone.`
  for `Done.`). When the record fits more than one place in the stream, the
  attempt fails. OpenClaw's ACP server
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

### The harness container

A claw run has two sides. The launcher holds the run token, talks to LCARS,
verifies and writes the pinned definition, and decides the outcome. The
harness side holds what the agent may use: the runtime's Secret items, the
workspace and the harness itself. A runtime chooses how far apart they are
(`harness_container` in the executor's runtime table,
[runner-autoscaler](../apps/runner-autoscaler/README.md#declared-runtimes-and-zone-executors)):

- **One container** (the default). The harness runs under the launcher's
  UID. Nothing separates them but file modes their shared owner can change,
  and a tool the agent may run can read the run token.
- **A harness container.** The harness runs in a second container of the
  same Pod, under another UID, and the two talk over a Unix socket. The
  harness's container has the Secret items and a scratch volume. It sees the
  pinned definition through a read-only mount, and the pinned `home/` files
  as another user's files in sticky directories, so it can keep its own
  state beside them and cannot change, remove, rename or replace them. It
  has no run token and shares no PID namespace with the launcher.

  The pinned `home/` files then belong to a user other than the one that
  reads them. A program that insists on owning its own configuration refuses
  such a file: OpenSSH does for `~/.ssh/config`. Give an agent that kind of
  file through its runtime's Secret items, or leave the runtime on one
  container.

What the pod then enforces is what the runtime gives it: its Secret items,
its mounts and its network policy. The harness's settings shape how the
agent behaves inside that. Two things stay outside the kernel's reach. A
harness that reads a settings file the definition does not pin, from a
directory it can write to, can be given one by its own agent. And
OpenClaw's launch config, Gateway token and exec approvals are made and
kept on the harness's side, where OpenClaw runs
([claw image](../apps/runner-autoscaler/claw-image/README.md#trust-boundary-inside-the-pod)).

A harness container needs a claw image that carries the harness host, so it
is switched on per runtime after that runtime's image is pinned
([migration](#migration-and-acceptance)).

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

### What a run records of its agent

Every harness is an ACP agent, so the launcher sees the same three things of
every turn in the session itself: the agent's tool calls, the tokens the
harness says it used and why the turn stopped. It reports them to the Work
API beside the run (`POST /runs/{runId}/evidence`, with the run's own
token), and the Work item's own read returns them on that run as `evidence`:

```json
{
  "source": "acp",
  "harness": "openclaw",
  "stopReason": "end_turn",
  "toolCallCount": 3,
  "toolCalls": [
    { "kind": "execute", "status": "completed" },
    { "kind": "read", "status": "failed" },
    { "kind": "read", "status": "completed" }
  ],
  "usage": { "inputTokens": 51000, "outputTokens": 2000, "totalTokens": 53000 },
  "durationMs": 41250,
  "recordedAt": "2026-11-18T17:40:00.000Z"
}
```

- **No word of the agent's.** Every word in a record comes from a closed
  list: the harness, ACP's tool kinds (`read`, `edit`, `delete`, `move`,
  `search`, `execute`, `think`, `fetch`, `switch_mode`), its tool call
  statuses and its stop reasons. Anything else is recorded as `other`. A
  cost is kept only in one of a few listed currencies (`USD`, `EUR`, `GBP`,
  `JPY`, `CNY`, `CAD`, `AUD`, `CHF`) and left out otherwise. A
  tool call's name, title and arguments are never recorded: they can hold a
  command, a path, a credential or text the model chose. A record lists the
  first 200 calls and counts them all.
- **What the harness said, not a bill.** `usage` is the harness's own
  account: the token counts on the prompt's result, the context size from
  its last `usage_update`, and a cost when it names one. A harness that
  reports none has none. It is not added to the session cost totals, which
  still come from provider transcripts. `durationMs` runs from the prompt to
  the harness's answer.
- **Beside the run, never the outcome.** The run's result is `complete`'s
  alone. Evidence is stored in a document of its own under the run, so a
  Console from before it reads every run as it always did, and a launcher
  from after it completes its run on a Console that answers 404. A listing
  never carries it. The Console shows it under the agent's turn on the Work
  item.
- **A record belongs to its claim.** It is stored under the fingerprint of
  the claim that reported it and read back only through the claim the run
  holds or settled under. A claim the run was taken from can still write,
  and what it writes is never shown. The first record under a claim stands.
  The write is one create that reads and locks nothing, so a report the
  launcher gave up on can never make the run's completion wait.
- **Read leniently.** An unknown key is dropped and an unknown word becomes
  `other`, at the route and on every read, so a launcher newer than its
  Console still records what that Console knows. A record that is refused
  (a malformed number, more than 200 calls listed) costs the run nothing:
  the launcher says so once in the Job's log and completes.
- **One source.** No provider transcript is parsed for it. The same route
  takes a record from any worker that holds a run token; claw runs are the
  first to send one.

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

The **default profile** runs on the `claw-default` runtime, which holds only
a model key and runs only `openclaw` agents. Homelab's runtimes-only zone
executor declares it; the shared executor's grant lists no claw pipeline. An OpenClaw
agent that needs no other credential therefore runs from a repository PR
alone.
The name `default` is reserved: it resolves directly to `claw-default`, and a
`default` entry in `AGENT_LCARS_AGENT_PROFILES` makes profile parsing fail,
including for admissions that would use the built-in default.

Credentials belong to the runtime, not the profile: every Job on a runtime
mounts that runtime's Secret, and several profiles can name one runtime. So
agents that share a runtime share its credentials, whatever their profiles
say. Adding a `claude` or `codex` login to a runtime gives it to every agent
that runs there, OpenClaw agents included. An agent that must not see
another's credentials, or a harness login that only some agents may use,
gets its own runtime with its own Secret items, and a profile that names
that runtime.

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
2. Homelab's zone executor gains runtime `claw-default` with a model key only.
   `.lcars/agents/smoke/` in this repository is its canary (done).
   Its `config.json` is deliberately a source config (no Doctor-added plugin
   or agent entries), so it also proves the launcher normalizes configs for
   whichever image runs them.
3. LCARS ships the catalog extension, the generic route, `/runs/{id}/agent`
   and the launcher change. It then points `lcars investigate` at the generic
   route and removes the investigator-specific code (done).

Switching a runtime to a harness container
([above](#the-harness-container)) is Homelab's change to its zone executor's
runtime table, in this order:

1. Deploy an executor that knows `harness_container`. An earlier one refuses
   the key when it starts.
2. Pin a claw image that carries the harness host on that runtime. An
   earlier image has no program for the harness's container to run.
3. Set `harness_container: true` on that runtime and restart the executor.
   Jobs already created keep the shape they were created with.

To go back, clear the flag first and pin the earlier image after. The Console
is not involved either way: the brief, the round and the definition are the
same with or without a harness container.

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
5. Hold merges that touch `.lcars/agents/` in every control-plane
   repository from here until the cutover in step 7 is checked. The newer
   Console keeps refreshing the catalog on every maintenance tick until
   then, so a manifest that gains `harness` or `mode`, or a repository that
   becomes readable again with one, would publish an incompatible row after
   this check. Then check that no agent in the catalog, enabled or not,
   still shows either field. Check the stored rows themselves, read-only:
   in every document of the `orchestrator-agents` collection,
   `definition.manifest.harness` and `definition.manifest.mode` must be
   absent. The `repositoryAgents` observation in a maintenance reply cannot
   show this: it is an aggregate, so it says nothing about a disabled row's
   stored fields. The earlier Console reads stored rows with a strict schema, and
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
   come back at cutover and admission would reopen. Repeat the check of
   step 5 immediately before the cutover. After it, wait for a fresh
   `repositoryAgents` observation in a maintenance reply served by the
   downgraded revision, and release the hold on merges only once there is
   one. That reply can be HTTP 200 and still carry no `repositoryAgents`
   when the earlier Console could not read the catalog, so a missing
   observation is the signal, not the status. Find out why before changing
   anything. If a row gained a field in between, the earlier Console cannot
   repair that by refreshing, because it reads the catalog first: clear that
   row's `definition` as in step 5.
8. Lift the fence with a further deploy of that version: restore the grants,
   and restore `runCallers` on each profile that had it, since the earlier
   Console lets a dispatched run invoke an agent only through that flag.
   Before that, whether or not the claw image went back, deal with every
   OpenClaw agent whose manifest named `harness: openclaw` or a `mode`
   before step 4. With those lines gone the earlier Console delivers its
   rounds as `files`, without a mode, and two things it relied on are gone:
   - its `home/` settings, which no launcher applies to such a round;
   - its `mode`, which for OpenClaw is a thinking level. No launcher selects
     a mode for a round that names none, so the agent runs at OpenClaw's
     default level, whether or not it has `home/` files.

   If the agent behaves the same without both, which has to be checked and
   not assumed, nothing more is needed. Otherwise keep the agent fenced: no grant that holds
   `work.claw.admit` lists its runtime, and `runCallers` stays off on its
   profile. Leave the runtime in the executor's own grant (`work.executor`):
   rounds of other agents already queued on it are claimed through that
   grant and would stall without it.

   That fence is not per agent, and its two parts reach differently. With
   no `work.claw.admit` grant listing the runtime, nobody can admit a round
   by grant for any agent on that runtime, whatever its profile, and every
   agent without a profile shares `claw-default`. `runCallers` is per
   profile: turning it off stops dispatched runs from invoking the agents of
   that profile only, and a sibling profile on the same runtime whose flag
   is on still admits them. To keep the other agents running, disable only
   the incompatible one: delete its
   definition from the default branch, which stops its admission, check that
   its catalog row shows it disabled, and then restore the shared grant and
   `runCallers`.

Rolling back only the claw image, with the newer Console still running, is
safe for agents that name neither a `harness` nor a `mode`: their rounds are
delivered as before. It is not for the others. The newer Console keeps
admitting them and delivers their rounds in the shape the earlier launcher
refuses, so every such attempt fails instead of running on OpenClaw, queued
rounds included, and a `retry: terminal` round fails for good on its first
attempt. Before reverting a runtime's image digest:

1. Stop admission of the agents on that runtime that name a `harness` or a
   `mode`. Delete those definitions from the default branch, or take the
   runtime out of every `work.claw.admit` grant and turn `runCallers` off
   on its profiles, which also stops the other agents there (step 8 above
   describes what each part reaches). Check in the catalog that those
   agents show as disabled, or that admission is refused.
2. Wait until every round that pinned a `harness` or a `mode` on that
   runtime has reached a terminal state, as in step 3 above: running
   attempts and the retries they may still get included.
3. Revert the image digest. Keep those definitions out, or the fence up,
   for as long as the earlier image is pinned.

## Acceptance

- **Met:** a real investigation ran from `jlapenna/homelab/investigator`
  through the generic operator route on the OpenClaw launcher (#3402). Still
  open: a production `lcars investigate` invocation that settles
  successfully, since the CLI uses the run-token routes and waits for the
  result.
- **Open:** an agent with no profile, added by a repository PR alone, runs
  end to end on k3s. The zone executor records `claw-default` runs exiting
  `succeeded`, but that counter does not identify the agent; the check needs
  a successful Work item or report for the `.lcars/agents/smoke/` canary.
- **Partly met:** a manifest naming a profile that does not list its
  repository is refused. Admission refuses it with "Profile NAME does not
  admit REPOSITORY" (`apps/console/src/lib/repository-agent-runs.ts`), and
  the operator-route test in `apps/console/src/lib/work-router.test.ts`
  asserts HTTP 403 for it. Its catalog visibility and a production refusal
  remain open.
- **Open:** the ACP launcher (#3411) running a round in production, after its
  `claw-runner` image is published and pinned.

On-call is not a claw agent and does not depend on LCARS (2026-11-15
decision).

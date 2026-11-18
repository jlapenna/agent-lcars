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
clients (`openssh-client`, `python3`), the launcher (`claw-job.mjs`) and the
harness host (`claw-harness.mjs`, with `openclaw-harness.mjs` and
`claw-process.mjs`). It holds no agent definition,
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
`workspace/` for every harness, `home/` for a definition that names a
harness or a mode, and `config.json` and `approvals.json` for OpenClaw. Its `config.json` is a source config; the
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
lease). With a harness container it also supplies `CLAW_HARNESS_SOCKET`, and
the table above describes the harness's container: the launcher's container
mounts no Secret item and no scratch.

## Launcher and harness host

Two programs share a run. The launcher (`claw-job.mjs`) holds the run token:
it talks to LCARS, verifies and writes the definition, speaks ACP as the
client and decides the outcome. The harness host (`claw-harness.mjs`) holds
what the agent may use: it reads the zone's Secret items, stages the
workspace, prepares and starts the harness, and relays the harness's stdio.
The host never sees the run token and never talks to LCARS.

They speak newline-delimited JSON over one stream. The launcher asks the
host to `launch` a harness and is told where the agent works and what the
harness needs of an ACP client. Every line of the agent's stdio then travels
inside an `acp` frame, so nothing an agent prints can pass for one of the
host's own frames. Lines end at a newline and nowhere else (`readLines`),
because JSON leaves the Unicode line separators unescaped, and no line
longer than a bound is ever held: the host drops a line of the agent's
output over 20 MiB and the launcher a frame over 48 MiB, and either fails
the turn. At the end the launcher asks the host to `finish`: to
stop what it started and to say whether the harness has a reason to refuse
the turn. The header of `claw-harness.mjs` lists the frames.

Where the host runs is the executor's choice, per runtime
([`harness_container`](../README.md#declared-runtimes-and-zone-executors)):

- **In the launcher's process**, the default. One container, one UID. The
  host is the same code on the other end of an in-memory stream.
- **In a container of its own**, when the runtime sets `harness_container`.
  The host listens on the Unix socket `CLAW_HARNESS_SOCKET` names and the
  launcher connects to it.

## Trust boundary inside the pod

**With a harness container** the kernel keeps the two sides apart:

| What                                   | Launcher's container (UID 1001) | Harness's container (UID 1002)                 |
| -------------------------------------- | ------------------------------- | ---------------------------------------------- |
| `LCARS_RUN_TOKEN`, `LCARS_CONSOLE_URL` | in its environment              | absent, and no shared PID namespace to read it |
| Zone Secret items                      | not mounted                     | `/run/claw-secrets`, read-only                 |
| Pinned definition, `/work/agent`       | writes it                       | mounted read-only                              |
| Pinned `home/` files in `HOME`         | owns them, read-only modes      | cannot change, remove, rename or replace them  |
| The rest of `HOME`                     | does not use it                 | keeps its own state there                      |
| Workspace, OpenClaw state, `/work`     | not mounted                     | its own scratch                                |

The pinned `home/` files need more than a read-only mount, because a harness
has to write its own state next to them (`~/.claude`, `~/.codex`). `HOME` and
every directory on the way to a pinned file belong to the launcher's user
and are sticky and group-writable. A harness under another UID of the same
group can add files there, and the kernel refuses it any change to an entry
it does not own. `HOME` is also a mount point in the harness's container, so
it cannot be moved aside as a whole. The price is that a pinned file is
another user's file to the harness, and a program that insists on owning
its configuration (OpenSSH, for `~/.ssh/config`) refuses it. What is not
protected is a file the definition does not pin: a harness that reads a second settings file from a
directory it can write to can still be given one by its own agent.

OpenClaw's own layer is as it was. Its launch config, its Gateway's token
and its exec approvals are made in the harness's container, by the user the
agent's tools run as, because that is where OpenClaw and the zone's
credentials are. The launcher still refuses a result when the host reports
that the config or the token changed. The model key is still kept out of
the environment a host command inherits and still readable in the launch
config. The boundary that holds is the pod's: which Secret items, mounts
and network the runtime has.

**Without a harness container** nothing here is isolation. The harness and
the agent's tools run as the launcher's UID in the launcher's container, so a
tool the agent is allowed to run could read the launcher's environment,
including `LCARS_RUN_TOKEN`. That token authorizes only heartbeat, brief and
completion for this one run, and the agent's own output already becomes that
run's report, so reading it grants no new authority. The definition is
locked by file modes its owner can change back. The launcher checks each
pinned `home/` file after the turn and refuses the result when one is no
longer its blob; it does not see a file the agent added, or changed and put
back.

In both, the zone Secret items are there for the agent's tools by design;
scope each runtime's items to what that agent may use. A launcher SIGTERM
(cancellation or pod deadline) has the host stop the harness's process group
and OpenClaw's Gateway, and still settles the run: it reaches a host that is
still finishing a turn, and a harness that cannot be seen to stop is given
15 seconds before the run is settled without it.

## Launch sequence

Each step fails the attempt closed with a `runner-failed` completion:

1. Startup heartbeat must be acknowledged before anything else, then the
   brief must be a `claw` brief for this run: an agent round with its message
   and verified definition. A round that names a harness or a mode carries
   its files as `definition` instead of `files`, which a launcher from before
   harnesses refuses.
2. The launcher writes the verified definition to `/work/agent`. The
   directory is emptied in place, never replaced: with a harness container
   it is a volume the other container mounts. For a brief that carries its
   files as `definition` (a round that named a harness or a mode), it also
   writes the definition's `home/` files into `HOME` (`stageHome`): each file
   read-only (an executable stays executable), each directory on the way
   sticky and group-writable. A `files` brief never has `home/` applied: no
   launcher did before harnesses, and a round admitted then must run as it
   would have.
3. The launcher asks the harness host to launch the harness the manifest
   names. The host copies the definition's `workspace/` to a writable
   `/work/workspace`, prepares what the harness needs (for OpenClaw,
   [below](#openclaw)) and starts the harness (`HARNESSES` in
   `claw-harness.mjs`) in its own process group, in the workspace, with a
   clean environment: the zone's `env/` Secret items and nothing of the
   launcher's. The command always comes from the image. With a harness
   container the launcher first waits up to a minute for the host's socket.
4. It speaks ACP to the harness through the host: `initialize` (protocol 1, no file
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
5. Once the harness's process has exited, the host stops whatever is left
   of its process group and waits for it (`endGroup`) before it tells the
   launcher, so nothing of the harness runs while the launcher checks
   settings and settles. That starts at the
   process's exit, after a moment for what it had already written to be
   read, not when its output closes: a child of its own that holds the
   output open would otherwise keep the attempt waiting. It settles from the
   session's updates: `report` only when the turn ended
   with `end_turn`, the agent's last message after its last tool call is not
   empty and no tool call is unresolved. A call that failed or never finished
   is unresolved unless a call that started after it ended completed. A
   harness error (a missing login, for example), an early exit, any other
   stop reason and an empty answer are `runner-failed`. So is a turn the
   harness itself reports as failed: Codex ends a turn its provider failed
   with `end_turn` and the error as message text, and tells only a client
   that declares the session-failure extension, which the launcher does.
   For such a client Codex also tags each message with its phase, and text
   tagged `commentary` is never part of the answer, so a turn that ends
   with commentary and no final answer is an empty one. When the agent's
   manifest sets `requireToolEvidence`, at least one tool call is also
   required.
6. The launcher asks the host to finish, which stops what the harness
   started and names any reason to refuse the turn, and then checks that
   every pinned `home/` file is still its blob. With a harness container the
   kernel has kept them so. Without one the harness runs as the launcher's
   UID and could have rewritten its own settings; the launcher refuses the
   result when it sees that. It does not see a file the agent added, or
   changed and put back. A host whose own finishing fails is a failed attempt, as a failed launch
   is. A host that does not answer within seven minutes,
   or has gone, fails the attempt. The check itself cannot
   hold up settlement: each settings file (these, and OpenClaw's launch
   config and Gateway token) is read only as a regular file of a bounded
   size within a bounded time (`readSettingsFile`), and a link, a pipe, a
   device or a larger file counts as changed.

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
   path the source names, and is not bootstrapped. Its commands start there
   too: the native `cwd` setting is pinned to the workspace in the defaults
   and in every entry that names one, as `agent exec --cwd` overrode it.
   OpenClaw's ACP server does not pass the session's directory on to the
   Gateway, so the config is what decides. The Gateway block is the
   Job's alone: loopback, a random token, no Tailscale, config reload off. A
   definition cannot open the Gateway or drop its token. Nobody is authorized
   to give the Gateway commands (`commands.allowFrom` is empty), so a `/word`
   inside a message stays text for the agent. That map replaces the
   definition's own: a rule it has for one origin would take precedence in
   OpenClaw over the rule for every origin. Provider
   credentials are resolved into the launch config and left out of the
   Gateway's environment (`resolveCredentials`): `agent exec` kept them out
   of what a host command inherits, and a Gateway has no such scope. A
   credential is a variable the pinned OpenClaw lists as one a provider reads
   (`providerAuthEnv` asks it through its public plugin SDK, in a process of
   its own, for the list `agent exec` used), one the config names as an `env`
   SecretRef, or one a provider's `apiKey` or `headers` names in a `${NAME}`
   or `${NAME:-default}` template (OpenClaw's own grammar; an empty variable
   counts as unset). Every SecretRef and template for it is resolved, and a declared
   provider with no `apiKey`, or a blank one, gets the first of its own
   variables the environment holds. An `apiKey` that is only the name of a
   credential variable is OpenClaw's marker for that variable and gets its
   value. OpenClaw substitutes templates in every config string it loads,
   the resolved ones included, so each value is written with OpenClaw's
   escape (`$${…}`) wherever it contains a template of its own: a key
   arrives as the key it is. A provider that is not declared in the config and
   relied on the environment no longer finds its key, and a custom key named
   only outside those places stays in the environment. That includes a
   credential one of OpenClaw's own tools or plugins reads only from the
   environment (`GEMINI_API_KEY` for Google web search, with no
   `models.providers.google` entry): it is on the pinned OpenClaw's list, so
   it is withheld, and nothing in the config asks for it. Such a definition
   names it as an `env` SecretRef at the tool's own key setting. A string
   that names a credential is taken apart as OpenClaw would in its one pass
   (`withCredentials`): the credentials are written in and become literal
   text with what surrounds them, so a value cannot join that text into a
   template. Every other template in the string stays OpenClaw's to resolve
   when it loads the launch config, default included, because a variable
   may come from the workspace's `.env`, which the launcher does not read.
   The one exception is a template directly after text ending in `$`, which
   nothing can express: that one is resolved by the launcher. A SecretRef is
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
6. `openclaw gateway run --port <port>` in the agent's workspace, waited on
   until its readiness probe answers (`GET /readyz` on its loopback port).
   The workspace is where `agent exec` ran, so OpenClaw still reads a `.env`
   there, under its own filter, which refuses every `OPENCLAW_*` key,
   provider credential names and base URLs: a workspace `.env` cannot
   reconfigure the Gateway. The port is the launcher's: OpenClaw reads
   `OPENCLAW_GATEWAY_PORT` before its config, so the Gateway, its ACP server
   and the outcome call all get that variable from the launcher, and the
   launch config drops every `OPENCLAW_GATEWAY_*` variable a definition's
   own `env` sets. It serves this one turn: channels,
   cron, the Gmail watcher, the canvas host, the browser control server and
   the startup model prewarm are all switched off, so nothing outside the Job
   can reach the agent.
7. `openclaw acp --url ws://127.0.0.1:<port> --token-file … --no-prefix-cwd`
   is the harness. The prompt carries `_meta.timeoutMs` of 600 000, the turn
   budget `agent exec` gave; without it the turn would run under the
   definition's `agents.defaults.timeoutSeconds` or the Gateway's default.
8. `openclaw gateway call sessions.list` and `agent.wait`, then the
   Gateway's process group is stopped.

OpenClaw's ACP server ends a turn the Gateway failed like any other
(`end_turn`), even after part of an answer has streamed. So after the turn,
while the Gateway still runs, the launcher asks it for its sessions
(`turnOutcome`) and finds the one the ACP server opened, whose key ends in
`acp-bridge:<ACP session id>`. Its last run must be `done`. Any other status
(`failed`, `timeout`, `killed`, `interrupted`, or one still `running` after
a few seconds) fails the attempt, and so does a Gateway that does not answer
or has no such session. A model attempt that failed before a fallback
answered leaves the run `done`. OpenClaw's text for the failure is not
repeated.

OpenClaw's ACP server also sends what the agent says on the way and its
final answer as the same message text, with no boundary between them when no
tool ran in between, so the stream alone would report `Checking files
nowDone.` for the answer `Done.`. The Gateway records the run's final reply
by itself (`agent.wait` for the session's `lastRunId`, `terminalReply`), cut
to 4,096 characters. The launcher uses it to find the answer in what was
streamed (`answerText`). The answer begins wherever OpenClaw would have
recorded exactly that reply for the rest of the stream, by its own rule: a
trimmed reply of up to 4,096 characters whole, a longer one cut one short of
that, never inside a surrogate pair, without trailing whitespace and with
`…` appended. The report is still the streamed text, never the recorded
one. Where no place fits, or the Gateway has no record of a reply, the
stream is reported as it is. Where more than one place fits (the answer
repeats a passage the agent had already shown, or its own beginning), the
answer's start cannot be told and the attempt fails. A run the Gateway recorded as ending
`silent` or `empty` has no answer, whatever the agent said on the way, and
fails as an empty result.

Nothing the launcher decides is read from the Gateway's log: a definition's
`logging` and `diagnostics` settings, including redaction, stay as written
and can change every line of it. A new OpenClaw version needs `/readyz`,
`agent.wait`'s `terminalReply`, the
`sessions.list` row (`key`, `status`) and the session key's form checked.

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

### Checking a change

The unit suite ([Test](#test)) runs the launcher over fakes. A change to the
launcher, a harness or a pinned version is also run with the harnesses
installed from this lockfile, because the launcher depends on behavior only
the real binaries have: OpenClaw's `/readyz`, its `sessions.list` rows and
its ACP session keys, each adapter's modes and sign-in methods, and Codex's
session-failure extension. What was run for a change, and what was not, is
recorded in its pull request, not here; for the introduction of harnesses
that is [#3411](https://github.com/jlapenna/agent-lcars/pull/3411).

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
(including its Gateway and ACP server) and a fake ACP harness. Most run the
harness host inside the launcher's process; some run it on a Unix socket, as
the harness's container does. What separate users and read-only mounts
enforce cannot be shown in one process: that is run with real containers,
and recorded in the pull request that changes it.

# Published composite actions and reusable workflows

agent-lcars is the fleet's infrastructure hub: it publishes the composite
actions under [`.github/actions/`](../.github/actions/) and, since
`renovate-auto-approve.yml`, select `workflow_call` reusable workflows under
[`.github/workflows/`](../.github/workflows/) for consumption by the other
fleet repos (supersprinklesracing/{sprinkles,www,girosf},
jlapenna/{homelab,nx-cache-server,sync-padd}). This repo is
public, so private consumers can resolve them regardless of owner. The
publishing unit is the **composite action or reusable workflow referenced
cross-repo** — there is deliberately no separate actions repo and no
Marketplace listing.

`agent-fallback-finalize.yml` is also called cross-repo via `workflow_call`,
but it predates and sits outside this general-purpose catalog: it is a
Coupled trust-boundary component of this repo's own dispatch protocol
(signed `job_workflow_ref`, hosted-completion OIDC audience), documented in
[lifecycle-systems.md](lifecycle-systems.md) instead of here. Do not treat it
as a template for a Published reusable workflow's contract — it never
promised one.

## Support tiers

| Tier          | Contract                                                                                                                                                            |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Published** | Fleet-consumable. Input/output surface guarded by `published-actions.contract.test.mjs`; breaking changes require a deliberate manifest edit, called out in review. |
| **Internal**  | Dedup for this repo's own workflows only. No stability promise; consumers keep their own conventions.                                                               |
| **Coupled**   | Do not consume — bound to this repo's infrastructure.                                                                                                               |

### Published

| Action                         | Purpose                                                                                                              |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `mint-agent-token`             | Mint a scoped Agent LCARS App installation token (owner/repositories/permission-\* passthrough)                      |
| `claim-issue`                  | Assign the fleet-claim login, optionally posting a pickup comment                                                    |
| `agent-setup`                  | Agent git identity, run-start timestamp, optional shared Nx cache                                                    |
| `verify-agent-identity`        | Assert the minted token's App identity and the push credential                                                       |
| `prepare-agent-dispatch`       | Write the routed issue context as data for a headless agent                                                          |
| `setup-opencode`               | Resolve, cache, and install a versioned OpenCode CLI                                                                 |
| `verify-deliverable`           | The fleet deliverable-evidence gate (post-agent: run from snapshot, see below)                                       |
| `report-failure`               | Log failure; optionally park an anchor for standalone consumers (run from snapshot)                                  |
| `post-agent-gates`             | Single post-agent step driving verify-deliverable/report-failure/telemetry-finalize (script only, run from snapshot) |
| `snapshot-enforcement-scripts` | Pre-agent freeze of the post-agent gates into `$RUNNER_TEMP`                                                         |
| `assert-repo-vars`             | Fail fast, naming every missing repo variable at once                                                                |
| `merge-live-base`              | Merge the live base branch into the PR head so CI tests what will land                                               |
| `check-canonical-sync`         | Fail consumer CI when a vendored fleet-canonical file drifts (or, opt-in, when a stray copy reappears)               |

### Published reusable workflows

| Workflow                       | Purpose                                                                                                         |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `renovate-auto-approve.yml`    | Approve a `renovate[bot]` pull request via a minted Agent LCARS App installation token                          |
| `agent-automerge-reusable.yml` | The whole agent auto-merge surface: arm squash auto-merge, restore the post-merge chain, sweep orphaned anchors |
| `agent-lane-claude.yml`        | The canonical Claude issue-agent lane (see "Published reusable lane workflows" below)                           |
| `agent-lane-codex.yml`         | The canonical Codex issue-agent lane                                                                            |
| `agent-lane-opencode.yml`      | The canonical OpenCode issue-agent lane                                                                         |

`agent-automerge-reusable.yml` (#1312 U4) is the union of this repo's own
`agent-automerge.yml` and sprinkles' `claude-automerge.yml`, which had
drifted from a common ancestor. The caller keeps what `workflow_call`
cannot carry — triggers (the cron schedule, `pull_request`/
`pull_request_review`, the repo's own `workflow_run` workflow names,
`workflow_dispatch` and its targeted-monitor inputs), workflow-level
permissions — and passes repo parameters: `bot-logins`
(`vars.AGENT_BOT_LOGINS`), `fleet-login` (`vars.AGENT_FLEET_LOGIN`),
`runs-on`, `required-checks`, and the optional restore-chain inputs
(`ci-workflow`, `extra-main-workflows`, `deploy-workflow`,
`post-deploy-verify-workflow`, `post-submit-enabled`,
`check-wait-minutes`, `restore-timeout-minutes`, `monitor-pr`/
`monitor-head-sha`). It needs no explicit `secrets:` — everything runs on
the caller's own `github.token`. This repo's `agent-automerge.yml` is the
reference caller; beyond actionlint and review, its embedded required-check
jq evaluation is behaviorally pinned by
`tools/contract-tests/agent-automerge-required-checks.test.ts` and its
admission gates by `tools/contract-tests/worker-workflow-contract.test.ts`.

### Internal

- `setup-node-pnpm` — this repo's pnpm/Node/frozen-lockfile block.
  Consumers have their own setup actions; do not adopt.
- `stamp-attempt-marker` — installs the marker-stamping `gh` wrapper (see below).
- `agent-handoff` — claude.yml/codex.yml/opencode.yml's shared
  agent-setup + verify-agent-identity pairing (agent-lcars#823). Purely an
  orchestration convenience local to this repo's own three lane workflows;
  a consumer repo should call the wrapped `agent-setup`/
  `verify-agent-identity` actions directly instead, which remain Published.
- `archive-opencode-trajectory` — export sanitized OpenCode sessions from
  this run for durable trajectory diagnosis.
- `setup-nx-remote-cache` — points trusted Nx jobs at the self-hosted L2
  remote cache. Deliberately kept Internal, not harmonized into a shared
  implementation: sprinkles maintains its own independent rebuild of the
  same self-hosted-cache-guard logic (same interface, same env var names,
  drifted empty-URL handling — fleet survey finding #7, agent-lcars#1206).
  This repo's own contract — `url` empty ⇒ no-op, `write-token` empty ⇒
  notice-and-skip, both documented in the action's own `inputs` block — is
  the version of record here, but this repo has no access to sprinkles'
  checkout to verify or edit its copy directly, and the
  `supersprinklesracing` source-tree independence rule (see the top-level
  `AGENTS.md`) means this repo does not reach into it to force a shared
  implementation either. Promoting to Published tier remains open and
  would need a contract test
  (`published-actions.contract.test.mjs`) plus a sprinkles-side PR
  adopting it — sequencing for whoever picks that up next, not something
  this repo can complete unilaterally.

### Coupled — do not consume

- `dispatch-bootstrap` — claude.yml/codex.yml/opencode.yml's shared
  snapshot/assert-vars/attempt-identity/mint-token/claim sequence
  (agent-lcars#823). A thin executor (agent-lcars#1015): it derives this
  attempt's stable identity directly from the trusted `broker-generation`/
  `broker-intent-id` workflow inputs instead of re-verifying them against
  `dispatch-broker`'s ledger, but it is still Coupled - the
  `AGENT_FLEET_LOGIN`/`MAINTAINER_LOGIN` repo-variable vocabulary and the
  attempt-identity format it publishes are this repo's own dispatch
  contract, not a general-purpose interface.
- `telemetry-start` / `telemetry-finalize` — depend on
  `/usr/local/lib/agent-lcars/sidecar-lifecycle.sh`, baked into the shared
  runner image (consumers on that image may still call them; the coupling
  is to the image, not the repo checkout — see
  [onboarding-console-and-telemetry.md](onboarding-console-and-telemetry.md)).

## Referencing from a consumer repo

Every consumer should reference the action repository's `main` branch to
always receive the latest published action:

```yaml
- uses: jlapenna/agent-lcars/.github/actions/<name>@main # latest
```

There is no special `@latest` syntax in GitHub Actions: `@main` is the
moving branch reference. This intentionally trades immutable, reviewable
action versions for automatically receiving the newest `agent-lcars` commit.

A reusable workflow is referenced the same way, but from a job's `uses:` key
instead of a step's, with `with:`/`secrets:` in place of a composite
action's step-level `with:`:

```yaml
jobs:
  auto-approve:
    uses: jlapenna/agent-lcars/.github/workflows/renovate-auto-approve.yml@main # latest
    with:
      runs-on: ${{ vars.CI_RUNS_ON || '["homelab-autoscale-default"]' }}
    secrets:
      APP_PRIVATE_KEY: ${{ secrets.AGENT_LCARS_PRIVATE_KEY }}
```

Release tags remain available for consumers that need immutable versions. A
compatible fix is a patch release, a new optional input or action is a minor
release, and a removed or renamed input or a changed default requires a major
release. The contract-test manifest diff in review is the "this needs a major
bump" signal — `published-actions.contract.test.mjs` covers composite-action
`action.yml` surfaces only, so a reusable workflow's `on.workflow_call`
contract is guarded by review and by `actionlint`, not by that test (see
"Contract test" below).

`credential-grant` was removed in #1015 Wave 4: it was published but had been
deliberately inactive since it landed (no workflow ever called it — the
server route, durable backend, App policy, and activation epoch it was
built for never shipped), so fleet consumers lose nothing live by its
removal.

`rerun-infra-killed-runs` was removed in #1201: it stayed published after
#1015 Wave 4 retired this repo's own local use of it
(`rerun-infra-killed-runs.yml`, subsumed by the orchestrator's lease sweep)
specifically for `jlapenna/homelab` and `supersprinklesracing/sprinkles`'s
own `rerun-infra-killed-runs.yml` crons, which still called it directly.
Both consumers have since migrated onto the central orchestrator's own lease
sweep and bounded auto-retry (sprinkles#4453, homelab#660) and no repo's
`.github` references the action anymore, so it and its source project
(`apps/rerun-infra-killed-runs`) were deleted outright rather than carved
further.

`report-failure` keeps LCARS's #813 architecture and a standalone-consumer
compatibility path. LCARS workers omit `maintainer`, so the action only logs;
the hosted finalizer's completion callback and dispatch-controller projector
remain their one idempotent writer. A consumer without that coupled finalizer
may provide `token`, `issue`, and `maintainer` to post the visible failure,
add `status:needs-human`, and assign the maintainer directly. When running the
script from `snapshot-enforcement-scripts`, the equivalent opt-in is the
`GH_TOKEN`/`ISSUE_NUM`/`MAINTAINER` environment tuple. Supplying only part of
that tuple fails closed instead of silently losing the report (#4388).

`post-agent-gates` (script only — see "Security: post-agent gates run from a
pre-agent snapshot" below; there is deliberately no `action.yml`, since a
`uses:`-callable surface would invite invoking it post-agent, defeating the
snapshot invariant) carries the same dual-mode contract one level up (#1208).
It already required `GH_TOKEN` and `ISSUE` for its own verify-deliverable
lookups, so the only new input is `MAINTAINER`: absent, it forwards
`report-failure.sh`'s `GH_TOKEN`/`ISSUE_NUM`/`MAINTAINER` all blank —
byte-identical to LCARS's hosted, log-only behavior. Set, it forwards its own
ambient `GH_TOKEN` and `ISSUE` (as `ISSUE_NUM`) alongside it, so
`report-failure.sh` takes its standalone compatibility path and posts/parks
the failure directly. This is what lets sprinkles/homelab collapse their
hand-copied telemetry-finalize/verify-deliverable/failure-reason/report-failure
steps into the one snapshot-run step LCARS's own workers already use, without
losing their existing visible-failure reporting (issue #1208; the consumer-side
rewiring is tracked as a follow-up, not part of this change).

`post-agent-gates` requires `ATTEMPT_ID` whenever `JOB_STATUS` is
`success` — the verify phase is exact-marker-only, and the requirement is
unconditional. An earlier revision made it optional (#1208 Phase 2/#1237),
mirroring `verify-deliverable.sh`'s then-dual contract so a standalone
consumer without broker attempt identity could take the legacy
`STARTED_AT` + `EXPECTED_COMMENT_LOGIN` inference pair instead; that
optionality was removed together with the inference mode itself once every
fleet consumer passed `ATTEMPT_ID` (agent-lcars's own three lanes,
homelab#697, sprinkles' exact-marker flip). A missing `ATTEMPT_ID` now
fails closed with a named diagnostic before any lookup fires. Do not pass
a synthetic value to satisfy it: the marker names one specific attempt,
and a fabricated identity can never match a real stamped deliverable.

`verify-deliverable`'s exact-marker clause additionally requires the matching
artifact to be **bot-authored** (`.user.type == "Bot"`, agent-lcars#1223).
The marker was treated as unforgeable identity, but it is a plain string —
`g<gen>:<repo>#<n>/r<gen>`, derivable from public issue state and printed in
run logs, issue comments, and documentation. A human pull request that merely
_quoted_ a live marker while explaining this mechanism satisfied that run's
gate and marked it `success` with nothing produced — the same shape as #711,
which clause (a) already had to close. The author test is strictly narrowing:
the marker must still be exact, so it does not reintroduce the inference #815
removed. It is `.user.type` rather than a specific login because no single
login covers one lane's own artifacts (claude.yml's PRs are `claude[bot]`
while its `gh` comments are `agent-lcars[bot]`). Consequence for consumers: on
an `agent:*`-on-PR takeover of a **human-authored** PR, stamping that PR's
body no longer counts — post a bot-authored comment carrying the marker
instead.

`verify-deliverable` is exact-marker-only: `attempt-id` is required, and no
timestamp or shared-login inference can satisfy the gate (#815). The
guarded legacy inference compatibility mode (`started-at` plus
`expected-comment-login` with `attempt-id` empty, #4388) was removed once
every fleet consumer passed `attempt-id` — agent-lcars's own three lanes,
homelab's three lanes (homelab#697), and sprinkles' three lanes (the
exact-marker flip). Its retired inputs (`started-at`,
`expected-comment-login`, `exclude-pr-author`, `exclude-comment-id`,
`runbook`) were dropped from the action. How a straggling consumer finds
out depends on how it calls the gate: a consumer invoking the composite
action directly with a retired `with:` input gets a runner warning
("Unexpected input(s)"), never a failure — but the fleet's consumers run
the snapshotted `post-agent-gates.sh` and pass these values as environment
variables, and the runner never warns about an unrecognized env var: a
retired variable is silently ignored. Do not count on a warning to surface
the drift; check this table when updating a consumer.

`prepare-agent-dispatch` keeps its richer runtime contract backward-compatible
for moving-`main` consumers: `token` falls back to the caller's
`github.token`, and the deadline inputs default to a 60-minute budget with
25-minute durable-artifact and 45-minute finalization checkpoints. Callers
with a different agent-step timeout must pass all three deadline inputs so the
brief describes the real runtime bound.

The brief it writes is also **size-budgeted** (`schema: 3`, #1202). Every
field carrying GitHub- or maintainer-authored prose — `anchor.body`, `reply`,
`context`, `latest_agent_result.body` — is clamped to a fixed character
budget, and a clamped field gets a trailing marker naming how much was
dropped and the URL to read the rest. `truncated` lists the field paths that
were shortened, so a consumer can tell "this is the whole story" from "fetch
the rest" without parsing prose. The budgets sit above this repo's p99 issue
body, so a typical brief is unchanged; they exist so one 32KB issue body
cannot turn into kilotokens of preamble on every provider. Acceptance
criteria are extracted from the _full_ body before clamping, so an issue's
checklist always survives. The budgets are constants in `prepare.sh`, not
inputs: the brief is a contract every lane reads identically, and a
per-caller knob is how one lane quietly grows a preamble the others do not
pay.

### The whole-repo-download caveat

A cross-repo `uses:` downloads this entire repository at the resolved ref
into the runner's `_actions` directory — not just the action directory.
That is load-bearing, not incidental: `prepare-agent-dispatch` resolves
the fleet protocol document via
`$GITHUB_ACTION_PATH/../../../.agents/skills/agent-protocol/agent-protocol.md`,
and `snapshot-enforcement-scripts` copies sibling action directories from
`$GITHUB_ACTION_PATH/..`. Repo-relative paths above the action directory are
a supported pattern here, but each action that relies on one must say so in
its `action.yml`.

## Published reusable lane workflows

`agent-lane-claude.yml`, `agent-lane-codex.yml`, and `agent-lane-opencode.yml`
(issue #1312 U1) are the fleet's canonical issue-agent pipelines: each is the
union of that pipeline's three per-repo lane implementations, with every
repo-specific behavior behind a typed `workflow_call` input. This repo's own
`claude.yml`/`codex.yml`/`opencode.yml` are thin same-repo callers
(`uses: ./.github/workflows/agent-lane-<pipeline>.yml`); homelab and
sprinkles collapse onto `@main` callers in the follow-up units.

A caller keeps only what `workflow_call` cannot carry:

- the `on: workflow_dispatch` input contract and the contract-tested
  `run-name` (the console join key and dispatch marker),
- top-level `permissions` and any `concurrency` group (codex's
  `codex-subscription-auth` serialization lives on the caller's job — it is
  repo-scoped, and homelab's carries a `queue:` key the others don't),
- the repo-variable spellings: variables do not cross repos, so
  `AGENT_RUNNER_LABEL`, `AGENT_FLEET_LOGIN`, `MAINTAINER_LOGIN`, WIF
  provider/SA values, and the Nx cache URL are passed down as inputs,
- the fully rendered `prompt` and `no-deliverable-reason` text — protocol
  paths and redispatch vocabulary are repo-specific content,
- its own `fallback-finalize` completion-callback job.

Every toggle defaults to the consumer behavior; the extras
(`dispatch-bootstrap`, `protected-snapshot`, `trajectory-export`,
`long-run-budget`, `queue-drain`, …) carry a recorded divergence reason in
each lane's header comment (the #1305 convention). Cross-org callers cannot
`secrets: inherit`, so every secret is declared explicitly. Consumer wiring
shape (claude, abbreviated):

```yaml
jobs:
  claude:
    if: github.event_name == 'workflow_dispatch' && inputs.issue != ''
    uses: jlapenna/agent-lcars/.github/workflows/agent-lane-claude.yml@main # latest
    with:
      issue: ${{ inputs.issue }}
      mode: ${{ inputs.mode }}
      reply: ${{ inputs.reply }}
      runbook: ${{ inputs.runbook }}
      context: ${{ inputs.context }}
      broker-generation: ${{ inputs.broker_generation }}
      broker-intent-id: ${{ inputs.broker_intent_id }}
      runs-on-label: ${{ vars.AGENT_RUNNER_LABEL }}
      agent-fleet-login: ${{ vars.AGENT_FLEET_LOGIN }}
      maintainer-login: ${{ vars.MAINTAINER_LOGIN }}
      agent-lcars-client-id: ${{ vars.AGENT_LCARS_CLIENT_ID }}
      telemetry-workload-identity-provider: ${{ vars.GCP_WIF_PROVIDER }}
      telemetry-service-account: ${{ vars.GCP_TELEMETRY_WRITER_SA }}
      prompt: >-
        <this repo's rendered agent prompt>
      no-deliverable-reason: >-
        <this repo's silent-stall wording>
    secrets:
      CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
      AGENT_LCARS_PRIVATE_KEY: ${{ secrets.AGENT_LCARS_PRIVATE_KEY }}
```

One infra note for consumers: the worker job now runs inside the reusable
workflow, so an OIDC token minted by that job carries
`job_workflow_ref: jlapenna/agent-lcars/.github/workflows/agent-lane-*.yml@...`
while `workflow_ref` still names the caller's own lane file. A WIF provider
whose attribute condition matches only on `assertion.repository` (this
repo's pool, and the fleet-shared telemetry pool) is unaffected; a provider
conditioned on `job_workflow_ref` must allow the lane files before a
consumer adopts.

## Fleet-canonical workstation scripts (`check-canonical-sync`)

The fleet's _session-side_ enforcement tooling — scripts that run on
workstations, not CI, and therefore cannot be delivered by
`snapshot-enforcement-scripts` or a cross-repo `uses:` at runtime — is
canonical in this repo and **vendored byte-for-byte** into the consumer
repos (agent-lcars#1307):

| Canonical path                                          | Runs as                                                 | Repo-specific hook                                                     |
| ------------------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------- |
| `tools/codex-issue-guardrail.cjs`                       | Claude/Codex PostToolUse hook (`.claude/settings.json`) | none needed (project name from cwd; identity via `fleet-identity.cjs`) |
| `tools/fleet-identity.cjs`                              | required by the guardrail                               | `AGENT_FLEET_LOGIN` env override                                       |
| `tools/claude-agent-session.sh`                         | operator CLI for fleet runner sessions                  | sibling `claude-agent-session.conf` pre-seeds the `CLAUDE_*` defaults  |
| `tools/require-feature-worktree.sh`                     | pre-commit/pre-push git hook                            | `$1` action word; `REQUIRE_WORKTREE_EXTRA_HINT` env                    |
| `.agents/skills/github-ci-monitor/scripts/watch-prs.sh` | CI-monitor skill script                                 | none needed (repo discovered from cwd)                                 |

A workstation hook must exist locally and work offline on every Bash
command, so "consumers hold no copy" is not achievable here the way it is
for CI actions. What IS achievable is making the copies mechanically
un-driftable: each consumer's CI calls the `check-canonical-sync` action
(above), whose manifest lists each vendored copy against its canonical
path here, and whose `--forbid-strays` mode additionally fails if a copy
of any canonicalized script's basename appears at an undeclared path —
the "local copy quietly grows back" failure mode agent-lcars#1307 exists
to close. Repo-specific behavior never justifies editing a copy: it
enters only through the hooks in the table, which each script documents
in its header.

Consumer wiring (homelab shown — it holds the guardrail pair under
`bin/`): a `.github/canonical-sync.conf` of `<local> <canonical>` pairs —

```
bin/codex-issue-guardrail.cjs tools/codex-issue-guardrail.cjs
bin/fleet-identity.cjs tools/fleet-identity.cjs
tools/claude-agent-session.sh tools/claude-agent-session.sh
bin/require-feature-worktree.sh tools/require-feature-worktree.sh
.agents/skills/github-ci-monitor/scripts/watch-prs.sh .agents/skills/github-ci-monitor/scripts/watch-prs.sh
```

— plus `uses: jlapenna/agent-lcars/.github/actions/check-canonical-sync@main`
with `--forbid-strays` in the consumer's verify job. To update a script
fleet-wide: edit the canonical file here, land it, then re-copy it
verbatim in each consumer (their CI names the exact file and the `curl`
re-sync command until they do). This repo deliberately does **not** run
the action against itself — that comparison is file-vs-itself and can
only pass vacuously; the action's behavior is covered by its own
`check.test.sh` in CI. (For file pairs that are _allowed_ to diverge in
bounded ways — the ESLint-rule twins of agent-lcars#1311 — sprinkles'
pinned-hash `check-lint-rule-drift` is the right tool instead: it pins a
reconciled state rather than requiring byte-identity.)

## Security: post-agent gates run from a pre-agent snapshot

An agent worker job gives the agent unrestricted Bash as the runner user.
That user can rewrite the working tree **and** the `_actions` download, so
any gate script resolved from disk after the agent step could execute
agent-authored code with the job's token. The invariant (see
`snapshot-enforcement-scripts/action.yml`):

1. Call `snapshot-enforcement-scripts` via `uses:` **before** the agent
   step — it freezes `verify-deliverable`, `report-failure`,
   `telemetry-finalize`, and `post-agent-gates` into
   `$RUNNER_TEMP/trusted-actions`.
2. After the agent step, run the gates **only** as
   `run: bash "$RUNNER_TEMP/trusted-actions/<name>/<name>.sh"` — never via
   `uses:`. `post-agent-gates/post-agent-gates.sh` is the single entry
   point every worker calls; it drives `verify-deliverable`,
   `report-failure`, and `telemetry-finalize` (all from the same snapshot)
   as an internal orchestration, so each worker needs only one such step
   instead of four hand-copied ones (#645 Phase 3).

`mint-agent-token` note: always request the narrowest scope the caller
needs via `owner`/`repositories`/`permission-*` — an unscoped token
carries every installation permission. `permission-workflows` in
particular is opt-in only and verified before the action returns a token
(agent-lcars#868) — see
[docs/agent-workflow-write-permission.md](agent-workflow-write-permission.md).

## Security: the marker-stamping `gh` wrapper is opt-in per step

`stamp-attempt-marker` (installed by `agent-handoff`, so all three lanes get
it identically) puts a `gh` wrapper on PATH that appends this run's
`<!-- attempt-claim:<id> -->` marker to the pull request a `gh pr create`
just opened — and to a comment **only** when the agent already declared that
comment a result with `<!-- agent-result:v1:... -->`. It exists because `verify-deliverable`'s clause 0
passes a broker-bound run only on that exact marker, and until #1213 the only
thing producing it was the model transcribing a literal out of its prompt —
which it demonstrably forgets. Run 31906618728 opened PR #1175, which was
reviewed and **merged**, and the gate still reported "no verifiable
deliverable was found" because the body had no marker.

This is not the time-window/login inference #815 refused. The marker is
stamped by the agent's own command, on the artifact that command created,
inside the attempt that owns `ATTEMPT_ID` — nothing is inferred about
pre-existing artifacts.

**The wrapper is inert unless a step sets `AGENT_MARKER_STAMPING: '1'` in its
own `env:`, and only the untrusted model-invocation step does.** That flag is
the entire safety boundary, so treat it the way you would a permission grant:

- The post-agent gates must never set it. They post their failure reports
  with this same `gh`, so a stamped gate report would satisfy clause 0 with
  the gate's own output — the deliverable gate would pass itself, on every
  run, silently.
- A job-wide PATH entry that does nothing without a per-step flag is
  deliberate. Actions has no clean way to scope PATH to one step, and an
  inert-by-default wrapper is easier to reason about than a PATH that is
  rewritten around the agent step.
- **The wrapper must never stamp an ordinary comment.** `agent-protocol.md`
  §5: "Stamp only the artifact that IS your deliverable, never your takeover
  or progress comment — the marker is a claim of authorship over one specific
  object, not a running commentary tag." The takeover comment is a run's
  _first_ action, so a wrapper that stamps every comment satisfies clause 0
  before any work happens — on every run, forever, silently converting
  "silence is failure" into "silence passes". #1213 shipped exactly that bug
  and run 31950517581 exposed it in production, its takeover comment carrying
  the marker. A comment is now stamped only when it carries the protocol's own
  `<!-- agent-result:v1:... -->` signal, which is the agent declaring it to be
  a result. Park needs no marker (clause (c) recognizes the
  `status:needs-human` label); a reply dispatch's comment still needs the
  agent's own marker, as it did before this wrapper existed.

**Interception is verified at install time, and a failure to intercept fails
the handoff** (#1268). The installer prefers to replace `gh` at its own path —
which no PATH manipulation, login-shell profile, or absolute-path invocation
can undo — and falls back to a `$GITHUB_PATH` entry only when that directory
is not writable. Either way it then resolves `gh` and confirms the wrapper is
what answers, erroring out if not.

That check exists because the original PATH-only install silently did nothing
on runs 31962331339 and 31967111276. Both opened correct pull requests that
merged, and both were recorded as **failures** because nothing stamped them —
with no warning, since a wrapper that is never invoked cannot warn. The
wrapper's own logic was verified correct against those exact command shapes,
so the break was interception, not parsing. An install that silently no-ops
puts "did the agent forget?" straight back as an explanation, which is the
ambiguity this action exists to remove.

Stamping is best effort and never changes the exit status the agent sees: the
agent's command has already succeeded by then, and failing it afterwards
would turn a created artifact into a failed command. A stamping failure is a
`::warning::` naming the artifact URL.

## Contract test

[`published-actions.contract.test.mjs`](../.github/actions/published-actions.contract.test.mjs)
runs in `ci.yml`'s Verify job and asserts every Published action's inputs
(name, requiredness, default) and outputs against an embedded manifest.
Editing the surface means editing the manifest in the same PR — that diff
is the review signal that consumers are affected.

Its manifest and parser are scoped to composite-action `action.yml` files
under `.github/actions/`; they do not cover `.github/workflows/*.yml`
reusable workflows. `agent-fallback-finalize.yml` — the Coupled
cross-repo-called `workflow_call` workflow — was never added to this
manifest either, for the same reason. A Published reusable workflow's
`on.workflow_call.inputs`/`secrets` contract is instead guarded by
`actionlint` (run in CI on every changed workflow) and by review of the
manifest-shaped diff itself. Two carry real behavioral pins on top:
`agent-automerge-reusable.yml` (the pins named in its table entry above),
and the three `agent-lane-*.yml` lane workflows, whose full
`workflow_call` input/secret surface (name, requiredness, type, default)
is pinned by
[`worker-workflow-contract.test.ts`](../tools/contract-tests/worker-workflow-contract.test.ts)
the same way this file's manifest pins the composite actions — published
surface is guarded surface.

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
| `report-failure`               | Log failure in the run's own log; the hosted finalizer/orchestrator owns visible reporting (run from snapshot)       |
| `post-agent-gates`             | Single post-agent step driving verify-deliverable/report-failure/telemetry-finalize (script only, run from snapshot) |
| `snapshot-enforcement-scripts` | Pre-agent freeze of the post-agent gates into `$RUNNER_TEMP`                                                         |
| `assert-repo-vars`             | Fail fast, naming every missing repo variable at once                                                                |
| `merge-live-base`              | Merge the live base branch into the PR head so CI tests what will land                                               |
| `check-canonical-sync`         | Fail consumer CI when a vendored fleet-canonical file drifts (or, opt-in, when a stray copy reappears)               |
| `setup-nx-remote-cache`        | Point trusted Nx jobs at the self-hosted L2 remote cache; fork PRs receive no cache capability                       |
| `deploy-verify`                | Post-deploy smoke loop: poll a deployed URL until it answers below 500; optional Deployment status + PR annotation   |

### Published reusable workflows

| Workflow                       | Purpose                                                                                                         |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `renovate-auto-approve.yml`    | Approve a `renovate[bot]` pull request via a minted Agent LCARS App installation token                          |
| `agent-automerge-reusable.yml` | The whole agent auto-merge surface: arm squash auto-merge, restore the post-merge chain, sweep orphaned anchors |
| `agent-lane-claude.yml`        | The canonical Claude issue-agent lane (see "Published reusable lane workflows" below)                           |
| `agent-lane-codex.yml`         | The canonical Codex issue-agent lane                                                                            |
| `agent-lane-opencode.yml`      | The canonical OpenCode issue-agent lane                                                                         |
| `repo-validation.yml`          | Repository validation: actionlint (dockerized, version input) over the caller's whole workflow tree             |
| `codeql-reusable.yml`          | The CodeQL analyze job; the caller owns triggers (weekly cron included) and passes its language list            |

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

`repo-validation.yml` (#1340 A-R5) replaces the byte-identical local
`validate.yml` bodies the small fleet repos (www, girosf, sync-padd,
nx-cache-server) carried, and gives sprinkles its first actionlint
coverage (`actionlint.yml`). The caller owns triggers, permissions, and
concurrency; inputs are `actionlint-version` (default `1.7.7`, tracking
`apps/runner-autoscaler/runner-image/actionlint-version`) and `runs-on`
(JSON array string, default `'["ubuntu-latest"]'` — the runner must be
able to `docker run`). Check-run naming composes as
`<caller job> / repository validation`; a caller whose job key is
`validate` therefore produces `validate / repository validation`, and
that composed string is what a ruleset or an `agent-automerge.yml`
`required-checks` input must name. One migration note: a consumer that
SHA-pinned its own checkout step (nx-cache-server's Renovate
pin-digests policy) gives that pin up — the checkout now happens inside
this workflow, at this repo's `actions/checkout@v7` convention, where a
consumer repo's Renovate cannot see it.

`codeql-reusable.yml` (#1340 A-R6) carries the CodeQL analyze job for
this repo's own `codeql.yml` and nx-cache-server's; inputs are
`languages` (default `javascript-typescript`) and `build-mode` (default
`none`). The runner is unconditionally `ubuntu-latest` — GitHub's CodeQL
CLI has no linux/arm64 build, and the fleet's self-hosted pools include
arm64 hosts, so the knob deliberately does not exist. Callers own the
triggers, the weekly `schedule` cron (keep per-repo crons staggered),
and the `security-events: write` permission grant. CodeQL is available
to any fleet repo through a thin caller, but enabling it in a new repo
is a maintainer choice, not an onboarding default.

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

### Coupled — do not consume

- `dispatch-bootstrap` — claude.yml/codex.yml/opencode.yml's shared
  snapshot/assert-vars/attempt-identity/mint-token/claim sequence
  (agent-lcars#823). A thin executor (agent-lcars#1015): it derives this
  attempt's stable identity directly from the trusted `broker-generation`/
  `broker-intent-id` workflow inputs instead of re-verifying them against
  `dispatch-broker`'s ledger, but it is still Coupled - the
  `AGENT_FLEET_LOGIN` repo-variable vocabulary and the
  attempt-identity format it publishes are this repo's own dispatch
  contract, not a general-purpose interface.
- `telemetry-start` — depends on
  `/usr/local/lib/agent-lcars/sidecar-lifecycle.sh`, baked into the shared
  runner image (consumers on that image may still call it; the coupling
  is to the image, not the repo checkout — see
  [onboarding-console-and-telemetry.md](onboarding-console-and-telemetry.md)).
- `telemetry-finalize` — a snapshot-delivered script, not an action: the
  directory carries only `telemetry-finalize.sh` (no `action.yml`), frozen
  pre-agent by `snapshot-enforcement-scripts` and run post-agent by
  `post-agent-gates.sh` from that snapshot. It shares `telemetry-start`'s
  runner-image coupling to `sidecar-lifecycle.sh`.

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

`report-failure` is log-only (#813): it annotates the failing run's own
log, and the hosted finalizer's completion callback drives the
orchestrator — the one idempotent writer of visible failure state on the
anchor issue/PR. It used to carry a standalone direct-park path (#4388's
`token`/`issue`/`maintainer` inputs, or the equivalent
`GH_TOKEN`/`ISSUE_NUM`/`MAINTAINER` environment tuple when running the
script from `snapshot-enforcement-scripts`) that posted the visible
failure, added `status:needs-human`, and assigned the maintainer directly.
No standalone consumer ever existed — every fleet repo that calls this
action is a control-plane tenant whose lanes also run the coupled fallback
finalizer — so the direct park had become a redundant second writer and
was retired per maintainer decision 2026-08-17, inputs and park branch
deleted. A straggling caller still passing the retired inputs gets a
runner "Unexpected input(s)" warning (never an error), and the retired
environment variables are silently ignored.

`post-agent-gates` (script only — see "Security: post-agent gates run from a
pre-agent snapshot" below; there is deliberately no `action.yml`, since a
`uses:`-callable surface would invite invoking it post-agent, defeating the
snapshot invariant) is log-only at its report phase for the same reason:
the former `MAINTAINER` pass-through toggle (#1208) was retired with
report-failure's direct-park path, so the script now forwards no
GitHub-write credentials to `report-failure.sh` at all. It still requires
`GH_TOKEN` and `ISSUE` for its own verify-deliverable lookups. It
publishes no step outputs either: its former `complete`/`outcome-kind`/
`readiness-failure` `$GITHUB_OUTPUT` writes had no consumer (nothing ever
mapped `steps.post_agent_gates.outputs.*` — `agent-fallback-finalize.yml`
deliberately re-derives lifecycle evidence from GitHub's job metadata and
exact attempt markers instead of trusting worker-side step outputs), and
were deleted in the same retirement.

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

## Fleet workstation tools (`packages/fleet-tools`, installed from main)

The fleet's _session-side_ tooling — scripts that run on workstations and
inside agent sessions, not as CI steps — is a real package in this repo,
`packages/fleet-tools`, exposing seven commands:

| Command                       | Runs as                                                 | Repo-specific hook                                                     |
| ----------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------- |
| `fleet-codex-issue-guardrail` | Claude/Codex PostToolUse hook (`.claude/settings.json`) | none needed (project name from cwd; identity via `fleet-identity.cjs`) |
| `fleet-claude-agent-session`  | operator CLI for fleet runner sessions                  | `tools/claude-agent-session.conf` at the launching repo's root         |
| `fleet-require-worktree`      | pre-commit/pre-push git hook                            | `$1` action word; `REQUIRE_WORKTREE_EXTRA_HINT` env                    |
| `fleet-watch-prs`             | CI-monitor skill command (auto-merge lifecycle)         | none needed (repo discovered from cwd)                                 |
| `fleet-watch-run`             | CI-monitor skill command (single run pass/fail)         | none needed (repo discovered from cwd)                                 |
| `fleet-safe-remove-worktree`  | worktree-hygiene skill command                          | none needed                                                            |
| `fleet-scan-live-processes`   | worktree-hygiene skill command                          | none needed                                                            |

Consumer repos hold **no copies** (the agent-lcars#1307 vendor-and-byte-pin
mechanism is retired, #1328). Distribution tracks `main` — first-party
software is never version-pinned in this fleet (the #29/#30 stale-pin
lesson):

- **Workstations**: one global install per machine, refreshed whenever it
  is re-run —

  ```
  pnpm add -g "github:jlapenna/agent-lcars#main&path:packages/fleet-tools"
  ```

- **Runner image**: `apps/runner-autoscaler/runner-image/Dockerfile`
  installs the package from the same fresh-`main` checkout it already
  builds the telemetry bundle from — no extra network, cache-busted per
  publish like everything else in that stage.
- **Consumer hooks** invoke the command guarded by `command -v` (e.g.
  `command -v fleet-codex-issue-guardrail >/dev/null 2>&1 && fleet-codex-issue-guardrail; exit 0`),
  so a machine without the install degrades quietly. Repo-specific
  behavior enters only through the hooks in the table — never a diverging
  copy.

`packages/fleet-tools/tests/package-install.test.sh` (Verify) pins the
command set and the `fleet-identity.cjs` sibling-module invariant; the
guardrail and worktree-hook behavior tests live beside it in
`packages/fleet-tools/tests/`.

`check-canonical-sync` (above) remains published for consumers'
genuinely-must-be-identical _non-script_ files while those still exist,
but no fleet script is distributed by copying any more. (For file pairs
_allowed_ to diverge in bounded ways — the ESLint-rule twins of
agent-lcars#1311 — byte-identity plus repo-neutral content is the current
mechanism; see sprinkles#4496.)

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

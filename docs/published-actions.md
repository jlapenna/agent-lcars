# Published composite actions

agent-lcars is the fleet's infrastructure hub: it publishes the composite
actions under [`.github/actions/`](../.github/actions/) for consumption by
the other fleet repos (supersprinklesracing/sprinkles, jlapenna/homelab).
This repo is public, so private consumers can resolve them regardless of
owner. The publishing unit is the **composite action referenced
cross-repo** — there are deliberately no `workflow_call` reusable
workflows, no separate actions repo, and no Marketplace listing.

## Support tiers

| Tier          | Contract                                                                                                                                                            |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Published** | Fleet-consumable. Input/output surface guarded by `published-actions.contract.test.mjs`; breaking changes require a deliberate manifest edit, called out in review. |
| **Internal**  | Dedup for this repo's own workflows only. No stability promise; consumers keep their own conventions.                                                               |
| **Coupled**   | Do not consume — bound to this repo's infrastructure.                                                                                                               |

### Published

| Action                         | Purpose                                                                                         |
| ------------------------------ | ----------------------------------------------------------------------------------------------- |
| `mint-agent-token`             | Mint a scoped Agent LCARS App installation token (owner/repositories/permission-\* passthrough) |
| `claim-issue`                  | Assign the fleet-claim login, optionally posting a pickup comment                               |
| `agent-setup`                  | Agent git identity, run-start timestamp, optional shared Nx cache                               |
| `verify-agent-identity`        | Assert the minted token's App identity and the push credential                                  |
| `prepare-agent-dispatch`       | Write the routed issue context as data for a headless agent                                     |
| `setup-opencode`               | Resolve, cache, and install a versioned OpenCode CLI                                            |
| `verify-deliverable`           | The fleet deliverable-evidence gate (post-agent: run from snapshot, see below)                  |
| `report-failure`               | Comment + `status:needs-human` + maintainer assignment (post-agent: run from snapshot)          |
| `snapshot-enforcement-scripts` | Pre-agent freeze of the post-agent gates into `$RUNNER_TEMP`                                    |
| `assert-repo-vars`             | Fail fast, naming every missing repo variable at once                                           |
| `merge-live-base`              | Merge the live base branch into the PR head so CI tests what will land                          |
| `rerun-infra-killed-runs`      | Detect and rerun runner-evicted runs of a named workflow                                        |
| `scan-image`                   | Trivy scan + SARIF upload + fail on fixable CRITICALs                                           |

### Internal

- `setup-node-pnpm` — this repo's pnpm/Node/frozen-lockfile block.
  Consumers have their own setup actions; do not adopt.
- `agent-handoff` — claude.yml/codex.yml/opencode.yml's shared
  agent-setup + verify-agent-identity pairing (agent-lcars#823). Purely an
  orchestration convenience local to this repo's own three lane workflows;
  a consumer repo should call the wrapped `agent-setup`/
  `verify-agent-identity` actions directly instead, which remain Published.

### Coupled — do not consume

- `dispatch-broker` — hardcodes this repo's label→workflow maps and the
  `agent-lcars-dispatch-v1` ledger/concurrency namespace.
- `dispatch-bootstrap` — claude.yml/codex.yml/opencode.yml's shared
  snapshot/assert-vars/broker-preflight/mint-token/claim sequence
  (agent-lcars#823). Wraps a call to `dispatch-broker` (above), so it
  inherits the same repo-specific dispatch-ledger coupling.
- `telemetry-start` / `telemetry-finalize` — depend on
  `/usr/local/lib/agent-lcars/sidecar-lifecycle.sh`, baked into the shared
  runner image (consumers on that image may still call them; the coupling
  is to the image, not the repo checkout — see
  [onboarding-console-and-telemetry.md](onboarding-console-and-telemetry.md)).
- `plan-image-publish` — routes this repo's three specific images.

## Referencing from a consumer repo

Every consumer should reference the action repository's `main` branch to
always receive the latest published action:

```yaml
- uses: jlapenna/agent-lcars/.github/actions/<name>@main # latest
```

There is no special `@latest` syntax in GitHub Actions: `@main` is the
moving branch reference. This intentionally trades immutable, reviewable
action versions for automatically receiving the newest `agent-lcars` commit.

Release tags remain available for consumers that need immutable versions. A
compatible fix is a patch release, a new optional input or action is a minor
release, and a removed or renamed input or a changed default requires a major
release. The contract-test manifest diff in review is the "this needs a major
bump" signal.

`prepare-agent-dispatch` keeps its richer runtime contract backward-compatible
for moving-`main` consumers: `token` falls back to the caller's
`github.token`, and the deadline inputs default to a 60-minute budget with
25-minute durable-artifact and 45-minute finalization checkpoints. Callers
with a different agent-step timeout must pass all three deadline inputs so the
brief describes the real runtime bound.

### The whole-repo-download caveat

A cross-repo `uses:` downloads this entire repository at the resolved ref
into the runner's `_actions` directory — not just the action directory.
That is load-bearing, not incidental: `prepare-agent-dispatch` resolves
the fleet protocol document via
`$GITHUB_ACTION_PATH/../../../.agents/skills/agent-protocol/agent-protocol.md`,
`snapshot-enforcement-scripts` copies sibling action directories from
`$GITHUB_ACTION_PATH/..`, and `dispatch-broker` imports the shared
[`libs/dispatch-contracts`](../libs/dispatch-contracts/) package from the
repo root. Repo-relative paths above the action directory are a supported
pattern here, but each action that relies on one must say so in its
`action.yml`.

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

## Contract test

[`published-actions.contract.test.mjs`](../.github/actions/published-actions.contract.test.mjs)
runs in `ci.yml`'s Verify job and asserts every Published action's inputs
(name, requiredness, default) and outputs against an embedded manifest.
Editing the surface means editing the manifest in the same PR — that diff
is the review signal that consumers are affected.

# Agent workflow-file push permission (`workflows`)

Runbook for jlapenna/agent-lcars#868: the Agent LCARS GitHub App's
`workflows` permission, why it's opt-in per caller rather than ambient, and
how to operate it.

## The problem this closes

Before #868, the App's own manifest never declared the `workflows`
permission at all, so no installation token minted from it — however
broadly scoped — could ever push a change to `.github/workflows/**`. An
agent dispatch that touched a workflow file would implement and test the
whole change, pass every local and pre-push gate, and only then get
rejected by GitHub at `git push` time: "refusing to allow a GitHub App to
create or update workflow ... without `workflows` permission." That's the
worst place to fail — after the run has already spent its model/runtime
budget. agent-lcars#823 and supersprinklesracing/sprinkles#4165 both died
there.

## Permission model

- **App-level grant**: the Agent LCARS App now declares `workflows: write`
  in its own permission set (App settings → Permissions & events →
  Repository permissions → Workflows → Read and write). This is a
  precondition, not the whole story — see Installation approval below.
- **Installation-level approval**: adding a permission to an App's manifest
  does not retroactively hand it to every installation. Each installation
  (the supersprinklesracing org install, and the personal-account install
  covering `jlapenna/agent-lcars`/`jlapenna/homelab`) must separately
  accept the wider permission set. Confirmed via
  `gh api orgs/supersprinklesracing/installations` that the org
  installation shows `"workflows":"write"` as of 2026-08-10T09:34 PT. The
  personal-account installation cannot be listed by an ordinary user token
  (`gh api /repos/jlapenna/agent-lcars/installation` 401s — that endpoint
  needs App-level JWT auth, not a user token), so its state is confirmed
  empirically instead, by the fixture proof below.
- **Opt-in per caller, not ambient**: `.github/actions/mint-agent-token`
  gained a `permission-workflows` input (default unset). Requesting it is
  the only way a minted token carries `workflows`. This matters because
  `actions/create-github-app-token` grants a token **every permission an
  installation has approved** whenever none of its `permission-*` inputs
  narrow the request — so leaving `claude.yml`/`codex.yml`/`opencode.yml`'s
  existing "Mint agent token" steps blank, the way they were before #868,
  would have silently handed every dispatch `workflows: write` the moment
  each installation approved it, with no opt-in, no preflight, and no
  dispatch ever having asked for it. `workflows` is a materially more
  sensitive permission than the rest of the set (a compromised or
  misbehaving contents-writer can already touch any file; a workflow-file
  writer can rewrite CI to run arbitrary code with the repo's own secrets
  on the next push) — exactly the kind of ambient escalation #868 exists to
  prevent. The fix: `claude.yml`, `codex.yml`, and `opencode.yml`'s mint
  steps now pass an **explicit allowlist** —
  `permission-actions/contents/issues/metadata/pull-requests` — that
  reproduces exactly what those calls already had before #868, and leaves
  `permission-workflows` unset. `workflows` stays available only to a
  caller that deliberately sets it. Since agent-lcars#823, the "Mint agent
  token" step itself lives inside the shared
  `.github/actions/dispatch-bootstrap` composite (all three lanes call it
  the same way); `dispatch-bootstrap` forwards its own
  `permission-workflows` input straight through to `mint-agent-token`
  unchanged, so the opt-in stays exactly as per-caller as it was before
  that extraction — see "Using the capability" below for the updated call
  site.
- **Early, trusted capability check, unconditional**: because GitHub does
  not reject a mint call that requests more than an installation has
  approved — it silently narrows the token instead (["the installation
  access token cannot be granted permissions that the app was not
  granted"](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app))
  — a caller that sets `permission-workflows: write` cannot tell from the
  mint step's own output whether it actually got `workflows`. `mint-agent-token`
  closes that gap itself: it signs a short-lived App JWT from the same
  `client-id`/`private-key` inputs (`verify-workflows-grant.sh`) and mints
  its own short-lived **probe token**, requesting the exact same
  `permission-*` inputs the real mint step just used, then reads that
  probe's own response and revokes it immediately. This runs on **every**
  call, not only ones that set `permission-workflows` — a caller that
  leaves every `permission-*` input blank (this action's own long-standing
  "give me everything the installation approves" default) would otherwise
  silently start receiving `workflows: write` too, once an installation
  approves it, with no opt-in and no preflight; this protects that consumer
  the same way (Codex review on PR #903).
  Deliberately **not** `GET /app/installations/{id}` — an earlier version
  of this check used that endpoint and produced a false failure for the
  narrowed-allowlist case: it reports the installation's overall approved
  ceiling, not what a specifically-scoped token actually receives, so a
  lane workflow's own explicit allowlist (which correctly excludes
  `workflows`) still showed up as "granted" by that endpoint once the
  installation's ceiling included it. Minting a real probe with the same
  permissions object is the only way to see what GitHub actually scopes a
  token down to.
  A mismatch fails the step immediately, before the caller's later steps
  (claim, checkout, and — in every lane workflow — the model-invocation
  step, which always runs after "Mint agent token") ever run. This is what
  "fails or parks before model invocation" means in practice here: the
  failure happens at the very first step of the job, and the existing
  `agent-fallback-finalize.yml` machinery (agent-protocol.md §5: a failed
  worker is itself a machine-authored parking path) turns that into a
  `status:needs-human` park with the maintainer assigned, the same as any
  other early-step failure (e.g. `assert-repo-vars` already behaves this
  way).
- **What stays separate**: `AGENT_CI_RERUN_TOKEN` (a classic PAT scoped to
  `public_repo`, used only for `gh run rerun`) never touches this App at
  all and gains nothing from this change — it was never a
  `mint-agent-token` output and remains unable to write source or workflow
  files. The job's own `github.token` (the dispatch-broker/ledger
  control-plane credential) and the GCP WIF-based deploy credentials are
  likewise untouched; none of them go through `mint-agent-token`.

## Using the capability (for a future caller)

No dispatch requests `permission-workflows` yet — #868's own acceptance
criteria defer redispatching agent-lcars#823/#815/#813 and
supersprinklesracing/sprinkles#4179 (already merged) to a future task, once
this capability is live. When a lane workflow does need it for a specific
dispatch, add the input to that lane's own "Dispatch bootstrap" step
(agent-lcars#823 moved "Mint agent token" itself inside the shared
`dispatch-bootstrap` composite, which forwards this one input through
unchanged):

```yaml
- name: Dispatch bootstrap
  uses: ./.github/actions/dispatch-bootstrap
  with:
    issue: ${{ inputs.issue }}
    broker-generation: ${{ inputs.broker_generation }}
    broker-intent-id: ${{ inputs.broker_intent_id }}
    agent-fleet-login: ${{ vars.AGENT_FLEET_LOGIN }}
    maintainer-login: ${{ vars.MAINTAINER_LOGIN }}
    agent-lcars-client-id: ${{ vars.AGENT_LCARS_CLIENT_ID }}
    agent-lcars-private-key: ${{ secrets.AGENT_LCARS_PRIVATE_KEY }}
    permission-workflows: write
```

The other five `permission-*` values (`actions`/`contents`/`issues`/
`metadata`/`pull-requests`) are fixed inside `dispatch-bootstrap` itself,
not exposed as inputs — they have never varied across the three lane
callers. `permission-workflows` is the one deliberate exception.

Only a reviewed workflow-YAML change can set this — nothing in an issue
comment, PR body, or an agent's own tool calls can reach it at runtime, so
this satisfies "agent-controlled input cannot escalate authority" by
construction: the decision of which dispatches get the capability is made
in code review, not by the dispatch itself.

## Installation approval (maintainer-only path)

1. Confirm the App's own manifest has `workflows: write` declared: App
   settings → Permissions & events → Repository permissions → Workflows.
2. Approve the updated permission set per installation:
   - Personal-account installations (`jlapenna/agent-lcars`,
     `jlapenna/homelab`): https://github.com/settings/installations
   - Organization installation (`supersprinklesracing`): the
     organization's own installations page
     (`https://github.com/organizations/supersprinklesracing/settings/installations`).
3. Re-run the fixture proof (below) if you need fresh confirmation that a
   specific installation actually accepted the update — GitHub's own UI
   confirmation does not always make it obvious which installations are
   still pending.

## Fixture proof

`jlapenna/agent-lcars#868`'s PR ran a one-off, now-deleted
`fixture-868-workflow-perm-proof.yml`: mint a token directly via
`actions/create-github-app-token` with `permission-workflows: write` +
`permission-contents: write`, push a throwaway no-trigger workflow file to
a scratch branch (the exact gated operation), separately push an ordinary
source file to a second scratch branch (regression check), then delete
both branches. Recorded run:
https://github.com/jlapenna/agent-lcars/actions/runs/31411439678 —
`success`, both the workflow-file push and the ordinary source push
succeeded, and both scratch branches (`fixture/868-workflow-perm-proof`,
`fixture/868-source-proof`) were deleted by the run itself. This is direct,
empirical confirmation that the personal-account installation had already
approved `workflows: write` as of 2026-08-10. Reuse the same pattern (a `push`-triggered workflow scoped to a
scratch branch, not `workflow_dispatch` — see the file's own header comment
for why) to re-prove the capability after any future permission change,
without needing to merge a throwaway file to `main` first.

A second, separate one-off (`fixture-868-mint-smoke.yml`, also deleted)
exercised `mint-agent-token`'s own composite action end to end against the
live App/installation, rather than the raw marketplace action — the check
now runs unconditionally on every mint, so it was worth confirming live
before it became load-bearing for every future dispatch fleet-wide. Its
first run (https://github.com/jlapenna/agent-lcars/actions/runs/31413451088)
caught a real bug: the original check read `GET /app/installations/{id}`
(the installation's overall ceiling) instead of probing what the specific
requested permissions actually produce, and false-failed the narrowed
lane-workflow allowlist. The fixed version
(https://github.com/jlapenna/agent-lcars/actions/runs/31413820860) passed
both cases live: the explicit allowlist (workflows excluded) resolved
silently, and an explicit `permission-workflows: write` request logged
`Installation 150568943 has granted 'workflows: write' - matches the
requested level`.

## Rollback

- **Revert a caller's opt-in**: remove that lane's `permission-workflows:
write` line. The token immediately goes back to the explicit
  allowlist (no `workflows`); nothing else changes.
- **Revoke at the installation level**: un-approve/reinstall with a
  narrower permission set from
  https://github.com/settings/installations (personal) or the
  organization's installations page (org). Every future `mint-agent-token`
  call that requests `permission-workflows` will then fail closed at the
  verification step (`verify-workflows-grant.sh`) instead of silently
  minting a token that can't actually push workflow files — the same
  failure mode this whole capability exists to surface early.
- **Revoke at the App level**: remove `workflows` from the App's own
  declared permissions entirely (App settings → Permissions & events).
  This is the broadest rollback and affects every installation and every
  repository the App reaches; prefer the narrower options above unless the
  App-level grant itself is the problem.

## Audit

- The App's currently-approved permission set per installation:
  `gh api orgs/supersprinklesracing/installations --jq '.installations[] |
select(.app_slug=="agent-lcars") | .permissions'` (org; personal-account
  installations aren't listable this way — use the fixture-proof pattern
  above instead).
- A caller that requested `permission-workflows` and got denied leaves a
  clear trail: `verify-workflows-grant.sh`'s `::error::` names the
  installation ID, the requested vs. actual level, and links back to
  #868; the job fails at the "Mint agent token" step, before claim or
  checkout, and `agent-fallback-finalize.yml` posts the park.
- `mint-agent-token`'s `installation-id` output (new, alongside `token`/
  `app-slug`) is available to any caller that wants to log which
  installation a given run's token came from without decoding the token
  itself.

---
name: issue-triage
description: Reconcile Agent LCARS issues with live ownership, pull requests, deployments, runtime evidence, and remaining acceptance gates. Use when auditing open issues, deciding what work remains, or advancing a multi-issue workstream without confusing implemented code with verified outcomes.
---

# Agent LCARS issue triage

Triage against current evidence, then keep authorized work moving. An issue is
not complete merely because it has a commit or green pull request, and an open
issue does not necessarily imply missing code.

Use the repository's existing skills rather than copying their procedures:

- [agent-lcars-dev](../agent-lcars-dev/SKILL.md) for ownership, repository
  guardrails, verification, and deployment boundaries.
- `github-issue-workflow` for mode-aware ownership checks and collision-safe worktrees.
- `repo-tools:land-pr` and `repo-tools:github-ci-monitor` for protected
  delivery and canonical CI observation.
- `repo-tools:renovate-maintenance` for dependency dashboards and Renovate
  branches.
- [verifying-console-session](../verifying-console-session/SKILL.md) when a
  production console acceptance check needs authentication.

## Establish scope and authorization

Read the user's current request and prior authorization before acting.
Diagnosis-only requests authorize inspection and a recommendation, not a fix.
Requests to fix all issues authorize ordinary implementation and delivery
within the repository guardrails. Preserve the user's current implementation
provider preference when routing code work; do not turn that preference into a
permanent repository-wide model rule.

Before changing an issue, reconcile its current body, acceptance criteria,
assignees, labels, linked pull requests, recent comments, and active agent
session or workflow evidence. A bot assignment alone does not prove that an
agent is still active. Interactive sessions proceed on the user's request
after this collision check, without mandatory fleet claims or takeover
comments. Autonomous LCARS workers follow agent-protocol for ownership.

## Build an evidence ledger

For each requirement, record the strongest current evidence and the remaining
gate. Classify the gate as one of:

- **Implementation:** code or configuration is still missing or incorrect.
- **Verification:** implementation exists, but its exact acceptance behavior
  has not been demonstrated.
- **Access:** a required identity, role, credential, or permission is absent.
- **External support:** a provider or another person must act.
- **Elapsed observation:** acceptance explicitly requires evidence collected
  across a real time window.
- **Persistent dashboard:** the issue intentionally remains open as an
  operational queue, such as Renovate's Dependency Dashboard.

Keep delivery states separate: local code, pushed revision, merged revision,
deployed revision, runtime behavior, authenticated rendered behavior, and
longitudinal evidence are distinct claims. Cite the exact revision, run,
artifact, query window, role, or page interaction that supports each claim.
Do not use a successful build or HTTP response as rendered-browser proof.

### Reconcile the complete workstream before reporting counts

Root and delegated causes belong to one workstream inventory. Before every
blocker total, reconcile **all** retained root inventories and authoritative
issue/delegate ledgers using the read-only
[cause report workflow](references/cause-report.md) and its
[assembler](scripts/reconcile-causes.mjs). A standalone `blockers.json` count
is insufficient when a ledger retains delegated causes. Register newly
returned delegate records before the next report, even when their issues
already have source fixes or are closed.

Report a complete total only from an exit-0 report with `complete: true` and
non-null `totals`. Otherwise name the unresolved identities, missing evidence,
conflicts and scope gaps; label observed subtotals incomplete. Preserve source
snapshots, original records, historical failures, remaining gates and owning
issue references. Resolve descriptive aliases from retained evidence explicitly;
never guess a cause ID from issue order, title or filename.

Keep cause totals, unique owning issues, live closed-issue counts, source and
runtime qualification, and confirmed provider execution as separate claims.
Cancellation of an already-satisfied queued intent proves settlement, not
provider execution. Reconciliation changes reporting only; it authorizes no
LCARS runtime state, fleet-control or production-data mutation.

## Advance the remaining work

Implement concrete missing work when authorized. For a verification gate,
prefer a safe, bounded, supported way to exercise the real acceptance path;
do not wait for an unrelated event to happen naturally unless the requirement
itself demands natural or elapsed evidence. Preserve normal scheduling,
placement, resource, and branch-protection controls.

For colocated Pod/process turnover, use the canonical
[requalification rule](../agent-lcars-dev/references/verify.md#requalify-colocated-worker-turnover).
Fresh passing qualification preserves authorization for an unchanged planned
phase; distinguish that turnover from replacement of the issue's own
author/native worker and retain the rule's mandatory holds.

State precisely what a test proves. A synthetic or scaled experiment can
support a mechanism or safety claim, but it does not replace an acceptance
criterion requiring the exact production workload, hardware, role, or time
window. Before launching a controlled experiment within the user's requested
scope, define its workload,
resource and time bounds, stop and cleanup conditions, and required
observations. Use the same metric and sampling definitions for comparisons;
do not cherry-pick periods or present a short synthetic run as a representative
production canary. Never compress or fabricate multi-day or multi-week
observations.

For authenticated verification, try credentials already available through the
supported private local saved-session backend and the existing Secret
Manager-backed verifier session before asking someone to sign in. Reusing an
existing credential does not authorize minting a session or granting access.
Treat unavailable credentials as an access gate. Verify the required identity
and scopes directly: console-admin authentication does not imply Work's
`work.operator` grant, and an admin session does not prove non-admin-user
behavior.

When external support or a human-only action is required, existing approval to
contact that party persists for the same scoped request. Prepare the complete,
reviewable message or artifact first, then stop at any explicit authorization
gate. Do not repeatedly ask for permission already granted.

If an issue cannot progress, leave a precise handoff: completed evidence,
unmet acceptance criterion, blocker owner, and the event or timestamp that
should trigger another pass. Continue independent authorized issues instead
of spending turns only polling or repeating the blocker.

### Interactive delegate handoffs

When the interactive workflow permits delegation, check the existing delegate's
actual task state before assigning follow-on work. For an idle or completed
delegate, use the client's available operation that starts a new task turn.
In clients exposing the collaboration tools, `collaboration.followup_task`
triggers that turn; `collaboration.send_message` only delivers coordination
and does not start work on an idle delegate. Use `send_message` to coordinate
with an already running delegate. Follow the available client's tool contract
rather than requiring a tool it does not provide.

After the handoff, read back the delegate's actual task state (for example,
with `collaboration.list_agents`) before describing the work as active or
waiting for its result. A queued message alone is not execution evidence.
If no turn started, reconcile and restart the existing delegate through the
supported task operation before creating a duplicate agent or job. If the
client cannot confirm execution, report the handoff as unconfirmed.

This check governs interactive collaboration only. Repairing that handoff
does not authorize native LCARS fleet claims, cancellations, provider
handoffs, or infrastructure controls. Headless dispatches retain the shared
agent-protocol's synchronous-work and ownership requirements.

## Dependency dashboard checks

Treat a dashboard checkbox as an operational request, not proof that every
listed release is eligible. Before requesting a grouped Renovate branch,
re-read the live dashboard and query authoritative registry metadata for the
latest versions allowed by the repository's actual ranges. Compute release
age from publish timestamps under the effective Renovate configuration.

Package-manager `wanted` output may itself hide releases due to a minimum-age
setting. A manual dashboard request can bypass Renovate's normal scheduling or
internal age filter, so do not rely on `wanted`, an earlier dashboard refresh,
or a previously calculated threshold alone. Recheck immediately before the
request and preserve the configured age policy rather than bypassing it.

## Finish the pass

Update issues only with new, requirement-linked evidence. Avoid duplicate
status comments and do not close persistent dashboards or observation-gated
issues merely because today's actionable implementation is complete. Read
back any mutations, and route code changes through the canonical worktree,
review, CI, protected merge, deployment, and cleanup workflows.

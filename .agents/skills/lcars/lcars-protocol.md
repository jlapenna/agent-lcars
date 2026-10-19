# Agent LCARS control-plane notes

Situational facts for developers changing `jlapenna/agent-lcars` dispatch,
reconciliation, telemetry, or auto-merge machinery. This is not a dispatched
worker protocol and must not be passed as a reusable lane's `protocol-note`.
Fleet worker behavior, identity, provider handoffs, and dispatch-mode
deliverables live once in the shared `agent-protocol` skill.

## Console dependency on protocol vocabulary

`apps/console` consumes the exact `status:needs-human`, `agent-lcars-bot`,
`jlapenna`, and attempt-marker vocabulary emitted by workers. Session recovery
is native/archive-only operator recovery from session records; it does not
consume worker takeover commands. Change those values only in the shared
protocol and corresponding console contract tests, never in repository-local
doctrine copy.

## Dispatch and reconciliation

The hosted orchestrator is the admission authority. It uses a per-task mutex,
lease-based loss recovery, and at most two consecutive automatic retries before
parking. There is no ledger comment or shared state a worker should repair.
The exact webhook, mode, lease, outbox, and provider telemetry behavior is in
[lcars-protocol-reference.md](lcars-protocol-reference.md).

## Auto-merge

`.github/workflows/agent-automerge.yml` is a thin caller of the published fleet
workflow. Bot identities come from the repository's `AGENT_BOT_LOGINS` variable;
add a new pipeline's login there rather than forking the workflow logic.
Workers arm squash auto-merge directly as part of the headless handoff. The
workflow handles event-driven arming and reconciles ready open bot PRs on
push to main and PR check success, plus a daily backstop, so a missed or
unavailable Actions event cannot strand one. Fleet callers must explicitly
enable App mode and supply its credential; false or omitted mode fails before
mutation. Repository-scoped Agent LCARS App tokens preserve the normal
main-branch push chain, linked-issue closure and repository branch deletion.
The App private key crosses only a `pull_request_target` trusted-base workflow;
that workflow must never check out or execute PR-head content.
The first main-branch push after cutover and every later reconciliation
migrate an auto-merge arm from the exact legacy `app/github-actions` identity
to the App identity; arms created by humans or other Apps stay untouched.

## Repository development boundaries

Worktree, verification, deployment, Terraform, Firestore, credential, and
cross-repository source-independence rules live in
[agent-lcars-dev](../agent-lcars-dev/SKILL.md). They are development policy,
not a second headless-agent behavior contract.

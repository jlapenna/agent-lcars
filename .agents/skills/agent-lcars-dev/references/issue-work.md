# Issue ownership and interactive attribution

Read this reference when inspecting, implementing, or filing GitHub issues.
Execution-mode and operation-approval boundaries remain in
[the development skill](../SKILL.md#hard-guardrails).

## Check ownership before implementation

The assignee records whose court the ball is in. `agent-lcars-bot` is the
fleet claim identity across consuming repositories.

- A human assignee owns the issue. Do not start work without their handoff;
  an `agent:*` label or recognized reply trigger supplies that handoff.
- A bot assignment alone does not prove a live worker. Check QueueExecutor
  run/session evidence, recent PRs, and comments before taking over.
- Interactive maintainer sessions act on the user's request. A direct request
  from the owning maintainer is a handoff; no fleet assignment or takeover
  comment is required. Check live ownership to avoid collisions, and do not
  claim an issue merely because you read it. This overrides the personal
  `github-issue-workflow` claim/comment defaults.
- Explicit headless LCARS dispatches follow
  [agent-protocol](../../agent-protocol/SKILL.md). The console owns the anchor
  claim and takeover; workers do not post a second takeover. The issue hook
  recognizes nonempty `LCARS_RUN_ID` or `AGENT_DISPATCH_CONTEXT`, not generic
  `CI`, non-TTY input, or provider session IDs.
- Agents only add assignees; removing one is a human act.

Re-read an issue before opening its PR after a long implementation:

```bash
gh issue view <N> --json state,stateReason
gh pr list --state all --search "<N>"
```

If another PR closed it, compare against the merged result and deliver only
remaining work. A prior claim does not make later conflicting work safe.

When blocked on the maintainer, interactive sessions ask in the conversation;
headless workers use the protocol's parking contract.

## Attribute issues created by this session

An interactive session runs `gh` under the maintainer's login. An issue it
invents therefore needs session attribution in its body: name the session and
its resume command when the client supports one. Do not rely on the author
login to distinguish it from a human-written issue. Quick Tasks have their own
[identity contract](../../../../docs/quick-task-identity.md); headless workers
use their dispatch identity.

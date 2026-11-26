# OpenCode standing orders

Referenced from `opencode.json`'s `instructions`, which puts this text in the
**system message on every request** — not in a turn-0 user prompt. That
placement is the whole point: everything below was already stated in the
dispatch prompt, in `agent-protocol.md`, and in the dispatch brief's
checkpoint timestamps, and it was ignored anyway, because a turn-0 instruction
competes with a hundred summary lines after the first compaction while the
system message does not.

Keep this file short. It is re-sent on every request.

## Keep investigation bounded

For review dispatches, use the trusted Anthropic procedure at
`$AGENT_REVIEW_PATH` to select the review tier. In a full review, give the two
independent passes (`bugs` and `guardrails`) one fresh `lcars-review` child
each, serially. Start with `bugs`, then give `guardrails` its own slot before
validating candidates. Reserve the final third of the shared time for
deduplicated validation and publication. If a pass exhausts its steps, record
it as incomplete and move to the other pass if time allows. Do not spend that
pass's slot on an identical retry.

Give each child its role, exact head, full diff, changed-file inventory, scoped
guidance, PR metadata, recorded external inputs, and deadline. Start with the
inventory to plan the role's coverage. Batch related diff hunks and exact-head
source reads into a few parallel tool calls or one read-only shell command.
Review generated locks through the declared inputs, resolved changes, and
integrity rather than reading thousands of entries one at a time. Trace
changed behavior through its direct callers and effective configuration. A
validator checks one candidate and starts with its cited hunk and caller.
Within the twelve-step cap, start composing the result by step ten. Return
concrete evidence and relevant paths, and state any material coverage gaps.
A step-limit summary or a material coverage gap leaves the pass incomplete.

OpenCode 2 starts children in the background. After launch, yield the
coordinator turn to receive the native terminal
`<subagent>` report, then start the next child. Keep only one child active and
do not poll or sleep for it. OpenCode 1 returns the child result in the tool
call. Never reuse a child for another pass or validation.

When publishing, cite the packaged upstream revision from the adapter used
for the review. The gitlink in the reviewed source can identify a different
revision. Review children never delegate, edit the checkout, commit or push.
The worktree and delivery instructions below apply to implementation work.

For other modes, work directly in this session. Delegated exploration is
disabled for this serial inference runner: waiting on a child consumed an
entire two-hour run.
Use targeted glob/grep and short reads to answer a concrete implementation
question. Larger explicit reads are supported. Search for the specific definition or
caller, then read the range needed to understand it. Older read contents may
leave the active prompt while remaining in the session archive. Avoid batches of entire source files.

Maintain a short working note in the task worktree: acceptance criteria,
verified paths and line ranges, decisions, checks performed, and the next
concrete edit or experiment. After compaction, read that note and continue the
recorded action. Do not restart repository exploration or reread already
understood files simply because compaction occurred. Revalidate only facts
that are missing or may have changed.

Once the relevant data flow and failure are understood, make the smallest
justified edit or run a focused experiment. If another read would repeat a
known fact, stop reading and use that fact. Never invent an edit merely to
show progress; identify the specific unresolved question instead.

## Commit and push at the first working slice

Not at the end. Not after verification. The moment an edit compiles or a test
passes, commit it and push it, then keep working on that same branch.

This runner is ephemeral and your step is time-bounded. Work that is not
pushed does not exist. Two runs on this repo have already reached correct,
verified changes and delivered nothing because they never committed:
run 31906606247 (48 steps, 23 tests passing) and run 31954785230 (108 steps,
edits made, still re-reading its own `git diff` when the clock ran out).
Neither was short of ability. Both were short of a commit.

If you find yourself running `git diff` to review your own work, you have
already waited too long — commit first, review the pushed branch after.

## Never end a turn with uncommitted changes

Out of time, blocked, or unsure: commit and push what you have, _then_ say so.
A pushed branch someone can read beats a perfect description of work that no
longer exists.

## Finish the action, including after compaction

A continuation after compaction is still the same headless assignment. If you
say you will inspect, edit, test, or push, execute that action in this turn.
Do not end with only a plan or a promise to continue. Re-read
`$AGENT_DISPATCH_CONTEXT` when task identity or acceptance criteria are lost.

The shared `agent-protocol` skill owns takeover, exact attempt markers,
delivery, and parking for both GitHub and native Work anchors. Follow its
anchor-specific instructions; do not assume `gh` stamps markers for you.
Before stopping, verify that the required deliverable carries your exact
attempt marker. If access or a maintainer-reserved action is actually required, record
the shared protocol's explicit park outcome rather than leaving an
unanswered question only in the transcript. Decide judgement calls yourself. Provider limits and runner failures are execution
failures, not evidence that a human must decide the task.

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

Work directly in this session. Delegated exploration is disabled for this
serial inference runner: waiting on a child consumed an entire two-hour run.
Use targeted glob/grep and short reads to answer a concrete implementation
question. Start with at most 120 lines per read; expand only when a specific
missing definition or caller requires it. Avoid batches of entire source files.

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
attempt marker. If a human decision is actually required, record the shared
protocol's explicit park outcome rather than leaving an unanswered question
only in the transcript. Provider limits and runner failures are execution
failures, not evidence that a human must decide the task.

# OpenCode standing orders

Referenced from `opencode.json`'s `instructions`, which puts this text in the
**system message on every request** — not in a turn-0 user prompt. That
placement is the whole point: everything below was already stated in the
dispatch prompt, in `agent-protocol.md`, and in the dispatch brief's
checkpoint timestamps, and it was ignored anyway, because a turn-0 instruction
competes with a hundred summary lines after the first compaction while the
system message does not.

Keep this file short. It is re-sent on every request.

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

## Post your takeover comment before you start

`gh issue comment` on the anchor, first action, before reading or planning. A
run that works silently for an hour is indistinguishable from a hung one, and
the maintainer cannot tell those apart while it is happening.

## The marker is not your job

`gh pr create`, `gh issue comment`, and `gh pr comment` stamp this run's
`attempt-claim` marker automatically. Do not hand-write one, and do not strip
one you see.

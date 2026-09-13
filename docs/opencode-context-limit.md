# OpenCode working context and compaction

The shared runner uses OpenCode 1.18.25 against `homelab/default`, currently
Qwen3.8 Flash Next on the two-Spark SGLang lane. Model capacity and the desired
working-set size are separate:

| Setting                        | Tokens | Purpose                                         |
| ------------------------------ | -----: | ----------------------------------------------- |
| `limit.context`                | 262144 | Current serving process capacity                |
| `limit.input`                  | 110000 | Explicit input budget before compaction reserve |
| `compaction.reserved`          |  30000 | Headroom for tool batches and continuation      |
| Effective compaction threshold |  80000 | `input - reserved` in the pinned runtime        |
| `limit.output`                 |   8192 | Working-turn output allowance                   |
| Compaction output ceiling      |   4096 | Bounds summary generation, including reasoning  |

These are runner settings, not workstation or LiteLLM routing changes. The
agent execution budget remains two hours. Nothing changes the task's feature scope.

## Why this changed

The September 12 audit found 37 compactions in failed Sprinkles #5473/r4,
spending 78.3 of its 120 minutes awaiting summaries. The 152 completed assistant
messages included those summaries: 115 working turns plus 37 compaction turns,
not 189. Successful #5465/r3 still spent 43.6 minutes awaiting 22 summaries.

Initial requests used about 24,350 tokens. The old `context: 60000`,
`output: 8192`, no-input configuration actually triggered at **51,808**, not
57,000: OpenCode ignores `reserved` in that branch. The [pinned overflow
implementation](https://github.com/anomalyco/opencode/blob/v1.18.25/packages/opencode/src/session/overflow.ts)
uses `input - reserved` when an explicit input limit exists and otherwise
`context - maxOutputTokens`. It checks completed-response usage; this is not a
hard admission ceiling on the next request. Large tool batches can overshoot.

The previous 60k justification concerned a DeepSeek `ds4-serve` serial fallback
that rejected prompts above 64k in August. It does not describe today's Qwen
lane. Read-only process inspection confirmed `--context-length 262144`,
`--max-running-requests 8`, tensor parallelism 2, and two nodes. Two serial
synthetic requests to that serving process accepted 142,907 and 226,907 input
tokens and returned two output tokens in 49.46 and 34.20 seconds respectively.
These probes establish service above the former cliff, **not** eight-request
throughput, real coding quality, or an optimal threshold. The 80k working
threshold is a conservative initial operating point below those probes, with
substantial capacity left for overshoot. Re-evaluate it from delivered work
and latency after rollout; do not equate the advertised capacity with the
appropriate compaction trigger.

## Instruction identity and active read history

A nested task worktree can contain the same root `AGENTS.md` as the primary
checkout. The instance's system prompt already includes the primary document,
but OpenCode discovers the worktree copy as another instruction path. After
compaction discards its loaded-path metadata, that copy is attached again.
In #5473, these attachments accounted for 52.5% of read-output characters; in
successful #5465, 73.8%. A capped 60-line read still returned 62,868 characters.

`agents/opencode/context-lifecycle.js` uses the supported system/message hooks
to recognize instruction files actually present in the working system prompt.
It verifies their current bytes before omitting an exactly identical attached
copy from a request. Different child rules, changed documents, and prefix-only
matches remain. It keeps source paths and instruction metadata. Summary
requests do not reset working instruction identity. It does not rewrite source
files or persistently delete tool results.

The same request-local hook retains the latest two assistant messages' reads
and a 96,000-byte budget of source-code read content, walking newest first.
Instructions, Markdown policy/working notes, dispatch JSON, and unknown file
formats are exempt. Older read bodies leave the active request with a recovery notice;
original arguments and complete native session history remain available. This
runs between tool turns, whereas the pinned runtime's normal pruning runs
when its autonomous loop exits. Non-read results, errors, skills, user prompts,
and unfinished tool calls are untouched. The byte budget is an approximate
working-set policy, not a tokenizer estimate or hard overall request limit;
recent reads can exceed it.

The hard 120-line plugin has been removed. Native OpenCode read limits and
explicit larger ranges work normally. Reducing every read to small slices did
not control appended instructions and could force additional calls.

## Compaction and continued work

The compaction hook adds a short handoff instruction without replacing the
native summary prompt. It requests at most 600 words prioritizing objective,
deliverable, worktree/claim, edits/tests, unresolved questions, and next action.
The `chat.params` hook bounds compaction output at 4096 tokens while preserving
any smaller configured limit and leaving working turns unchanged. The word
count is model guidance; the token ceiling is sent on the wire. This bounds
cost but is not a guarantee of summary completeness or model obedience.

Standing instructions remain home-relative so they load in every workspace
(#1947). The agent should use its working note after compaction and continue
the pending action. Observed summaries retained detailed plans even in failed
runs; repeated inspection is not proof that all task state was forgotten.

## Verification and runtime acceptance

`tools/opencode-config.test.sh` is consumed by required CI. It exercises
instruction equivalence, changed/scoped rules, session separation, active
read-history retention, and output-budget behavior. The image build's existing
`opencode-continuation.test.sh` gate runs the actual pinned CLI against a
localhost deterministic provider, using duplicate worktree instructions and a
distinct child rule. Wire assertions cover instructions exactly once before
and after compaction, preserved child rules, explicit reads above 120 lines,
standing instructions, continuation, and the summary token ceiling. It uses no
production credentials or model inference.

After publishing, inspect natural runs on the exact image digest. Compare time
to first edit/commit, commits and PRs per wall-clock hour, summary wall time,
input usage, repeated unchanged ranges, and serving errors/load. Compare like
workloads with one variable changed at a time when tuning further. A lower
compactions-per-step ratio alone is not evidence of useful delivery. Keep
#1942's natural-run acceptance separate from the framework and capacity probes.

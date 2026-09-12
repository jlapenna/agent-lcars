# Why `homelab/default` declares a 60000-token context

`opencode.json` tells OpenCode how much context the model has. OpenCode uses
that number for one thing: deciding when to compact. Compaction fires as the
conversation approaches `limit.context - compaction.reserved`, and it evicts
the file contents the agent has read. The agent then notices it no longer
remembers a document it was told to follow, and reads it again.

So this number is not documentation. It is the knob that decides how often a
dispatched agent loses its working memory — and it was wrong in this repo, in
the expensive direction, for as long as OpenCode has run here.

## What was wrong

This repo declared `context: 24000`. That value is a leftover from when
LiteLLM's `default` route pointed at Gemma-4 31B; the route now serves
`deepseek-v4-flash` with `max_input_tokens: 262144`
(`homelab:litellm/runtime/config.yaml`). The stale model name in the same
entry — "Gemma-4 31B" — was the other half of the same leftover.

With `reserved: 3000`, OpenCode compacted at ~21,000 tokens. That is roughly
what a dispatch costs before any work happens: the system prompt and tool
schemas, the dispatch brief, and the two protocol documents. So the agent
compacted almost immediately and then repeatedly, re-reading the protocols
after each one.

## The evidence

Measured from real run logs, counting `agent: "compaction"` events:

| run                            | declared context | compactions | steps | outcome                        |
| ------------------------------ | ---------------: | ----------: | ----: | ------------------------------ |
| agent-lcars #1173 (2026-08-16) |           24,000 |           2 |    11 | never reached the task         |
| agent-lcars #1173 (2026-08-15) |           24,000 |           9 |    52 | work done, then lost unpushed  |
| sprinkles #4451 (2026-08-16)   |          262,144 |       **0** |     8 | grew to 70,354 tokens, refused |

One compaction every ~5.5 steps in this repo. The 2026-08-16 run spent its
whole 35 minutes reading the protocols three times and dumping `env` four
times, and exited without editing a file.

The sprinkles row is the same knob failing the other way. Declaring the
backend's full 262144 means OpenCode never compacts, so the prompt grew past
the point where `ds4-serve` will serve it and the run died on
`Server is temporarily at capacity for a 70354-token prompt (deep prompts are
not served on the serial fallback path)`.

## Why 60000 and not 262144

Both failures above come from the same number, set wrong in opposite
directions, so the right value is bounded on both sides:

- **Floor:** it must be comfortably above a dispatch's fixed cost (~21k), or
  the agent compacts before it can work. 60000 leaves ~57k of working context
  after `reserved`, roughly 2.7x what this repo had.
- **Ceiling:** requests over **64k** switch `ds4-serve` to plain
  (non-speculative) decode — "almost certainly the serial fallback path"
  behind homelab#48's capacity 503, per `litellm/runtime/config.yaml`'s own
  note. Staying under it keeps every dispatch on the fast path and off the
  rejection path that killed sprinkles#4451.

262144 is the backend's real limit and is _not_ the right value here: it is
above the ceiling, not below it. The backend can hold that much; the server
will not reliably serve a prompt that large under load.

## If you change this

Re-measure, do not reason. Count compactions per step in a real run:

```bash
gh run view <run-id> --log | grep -c 'agent: "compaction"'
```

Fewer than one compaction per ~15 steps means the agent keeps its working
memory across a task. Zero compactions across a long run means the limit is
too high and you are heading for the 64k cliff instead.

## `limit.output` = 8192

2048 was the same Gemma-era leftover as the context value, and it is the cap
on what the model may emit in a single turn. A 300-line TSX component is
roughly 4,000 tokens, so 2048 could not have written one — the agent would
have been truncated mid-file at the exact step that matters.

There is **no measured evidence it was ever hit**, and that is worth stating
plainly: across every run examined, the agent never reached a file write, so
nothing in the logs shows a truncated edit. This is a constraint removed
before it bites, not a diagnosed failure.

8192 is derived from the step budget rather than picked. With thinking
disabled and the prompt under the 64k cliff, `ds4-serve` decodes at roughly
48ms/token (its own tuning note; deep prompts run 146–177ms/token). A
maximal 8192-token turn therefore costs ~6.5 minutes — about 11% of the
60-minute agent step (#1226). At 16384 a single runaway turn would eat 22% of
the run, which is a worse failure than a truncated write.

If a real edit is ever truncated, the log will show it and this should go up.
Do not raise it on the theory that bigger is safer: the cost is paid in
minutes of a bounded budget.

The runner dispatches `homelab/default`. The historical `default-nothink`
workaround introduced in #1227 has been retired; use native client reasoning
controls when thinking should be disabled.

Related: agent-lcars#1210 cut the fixed pre-work reading that this budget is
mostly spent on, and agent-lcars#1217 covers the separate 60-minute push
credential expiry.

## Where OpenCode's standing orders live, and why not in `agent.*.prompt`

`opencode.json`'s `instructions` points at `agents/opencode/instructions.md`.
Measured 2026-08-16 against opencode 1.18.18, by pointing the provider
`baseURL` at a local server and reading the request off the wire:

| config                | system message | stock build prompt |
| --------------------- | -------------: | ------------------ |
| `agent.build.prompt`  |   10,929 chars | **destroyed**      |
| `instructions: [...]` |   19,602 chars | intact             |

`agent.*.prompt` **replaces** OpenCode's built-in system prompt instead of
appending to it — the override cost ~8.7KB of stock tool guidance and the
opening line `"You are opencode, an interactive CLI tool..."` went with it.
`instructions` is additive and lands in the _same system message_, which is
the property that matters: the system message is re-sent on every request and
survives compaction, while a turn-0 user prompt is competing with a hundred
summary lines by the second compaction.

That distinction is the whole reason the commit rule kept being ignored. It
was stated in the dispatch prompt, in `agent-protocol.md` §6, and in the
brief's checkpoints — all turn-0 or tool-read content. `tools/opencode-config.test.sh`
fails the build if `agent.*.prompt` is ever set again.

## September 12 recovery audit: read loops despite two hours

The exported OpenCode 1.18.25 transcripts for Sprinkles #5475/r3 and #5473/r3
showed 37 compactions each, 178 and 139 model steps, and 315 and 282 read calls.
Neither recorded an edit/write call before the two-hour timeout. The same
source files were read 25–30 times. Individual input counts reached 84,968 and
82,027 tokens despite the configured 60,000 context: large tool responses can
overshoot the compaction threshold before the next check.

#5467/r3 instead stalled in a delegated exploration task after only nine model
steps. The parent export recorded the child call as still running at timeout;
it does not prove whether the child was doing useful work.

The runner now denies the Task tool using OpenCode's supported permission
configuration and asks the main session to use focused reads and durable
working notes across compactions. These measures target observed behavior;
they do not establish that the success-rate target has been met. The 60,000
context limit remains unchanged pending new backend capacity measurements.

The subsequent #5470/r3 run still had no visible edits at 17:17 UTC: 178
steps, 28 compactions, and four source files read 14–17 times. A later
read-only native database sample found 84 reads with no explicit limit and
input reaching 93,696 tokens. OpenCode 1.18.25 defaults those reads to 2,000
lines. The `bounded-read.js` plugin now uses the supported
`tool.execute.before` hook to set an omitted limit to 120, matching the
standing instructions. Explicit limits and offsets remain available for
follow-up investigation. This reduces the default tool-response volume;
it does not prove the repeated-investigation problem or success-rate target
is solved. Neither the context declaration nor the two-hour run budget changes.

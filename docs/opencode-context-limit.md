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

`limit.output` (2048) is deliberately left alone here — it was not implicated
in either failure, and one variable at a time.

`default-nothink` carries the identical budget and rationale. It is the route
this repo actually dispatches on (#1227); `default` keeps its entry because
the two share a backend and must not drift apart on this number.

Related: agent-lcars#1210 cut the fixed pre-work reading that this budget is
mostly spent on, and agent-lcars#1217 covers the separate 60-minute push
credential expiry.

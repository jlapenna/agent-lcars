# @agent-lcars/telemetry

A pure, source-agnostic reducer that turns a Claude Code session transcript
(`~/.claude/projects/<cwd-slug>/<session-uuid>.jsonl`) into a structured
[`SessionSummary`](./src/lib/types.ts) — no message bodies, just identity,
lifecycle, progress counters, an activity digest, and observed deliverables
(branch/PR/commits).

It tolerates the transcript format drifting across Claude Code versions
(unknown line types are ignored, not thrown on), folds subagent ("sidechain")
lines under their parent session, and keys state by the transcript's
`sessionId` — not filename — so a resumed/compacted session spanning more
than one file still reduces to a single summary.

## Usage

```ts
import { reduceTranscript, reduceTranscripts } from '@agent-lcars/telemetry';

// Single file
const [summary] = reduceTranscript(fs.readFileSync(transcriptPath, 'utf8'));

// A resumed session spanning multiple files (pass them in chronological order)
const summaries = reduceTranscripts([part1Content, part2Content]);
```

## Agent identity & the transcript-adapter seam

Every `SessionSummary`/`SessionDoc` carries an optional `agent` field
(`SessionAgent`: `'claude-code' | 'codex' | 'gemini' | 'antigravity' |
'opencode'`) naming which coding agent produced it. It's optional because
every session shipped before this field existed has no such key — resolve
the effective value with `sessionAgent(docOrSummary)` rather than reading
`.agent` directly; it defaults to `'claude-code'` when absent, since that
reducer was the only one that ever existed.

`reduceTranscript`/`reduceTranscripts` remain Claude-Code-only and always
stamp `agent: 'claude-code'`. `TranscriptAdapter` (`transcript-adapter.ts`)
is a parallel seam for future agents: an adapter pairs a cheap
content-sniffing `detect()` with a `reduce()` that turns one file's lines
into summaries. `claudeCodeAdapter` wraps the existing reducer; new agents
register their own adapter in `TRANSCRIPT_ADAPTERS`. Consumers resolve an
adapter either by content (`adapterFor`) or by name
(`getTranscriptAdapter`) — see `apps/telemetry-watcher`'s multi-root
`watchRoots` config for the name-keyed case.

## CLI

```bash
./tools/nx run @repo/cli:run -- agent-telemetry reduce <transcript-file>
```

Prints the reduced summary as JSON — useful for verifying the reducer against
real transcripts without needing the telemetry store or any infra.

## Running unit tests

Run `./tools/nx run @agent-lcars/telemetry:test` to execute the unit tests via
[Jest](https://jestjs.io).

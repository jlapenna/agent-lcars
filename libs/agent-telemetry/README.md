# @repo/agent-telemetry

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
import { reduceTranscript, reduceTranscripts } from '@repo/agent-telemetry';

// Single file
const [summary] = reduceTranscript(fs.readFileSync(transcriptPath, 'utf8'));

// A resumed session spanning multiple files (pass them in chronological order)
const summaries = reduceTranscripts([part1Content, part2Content]);
```

## CLI

```bash
./tools/nx run @repo/cli:run -- agent-telemetry reduce <transcript-file>
```

Prints the reduced summary as JSON — useful for verifying the reducer against
real transcripts without needing the telemetry store or any infra.

## Running unit tests

Run `./tools/nx run @repo/agent-telemetry:test` to execute the unit tests via
[Jest](https://jestjs.io).

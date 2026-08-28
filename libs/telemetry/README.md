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
is the parallel multi-agent seam: an adapter pairs a cheap
content-sniffing `detect()` with a `reduce()` that turns one file's lines
into summaries. `claudeCodeAdapter` wraps the existing reducer; new agents
register their own adapter in `TRANSCRIPT_ADAPTERS`. Consumers resolve an
adapter either by content (`adapterFor`) or by name
(`getTranscriptAdapter`) — see `apps/telemetry-watcher`'s multi-root
`watchRoots` config for the name-keyed case.

Having a `TranscriptAdapter` (i.e. being summarizable into stats) is a
_different_ capability from being _renderable_ as a raw timeline on the
console's session detail page — `parseTranscriptTimeline`
(`transcript-timeline.ts`) has explicit Claude Code and Codex parsing paths;
other agents may still have a summary adapter without a timeline parser.
Whether a given session's archived transcript can be rendered is captured once by
`buildSessionDoc` as `SessionDoc.renderable` (see `isRenderableTranscriptAgent`)
and read — never re-derived — by the console via `isSessionRenderable`
(`agent.ts`).

OpenCode's native store is one SQLite database, so the watcher first uses the
supported `opencode session list`/sanitized `opencode export` CLI surface to
materialize at most 20 exact-workspace sessions as compact metadata-only JSONL.
The CLI runs in pure mode with a credential-free environment, and a strict
allowlist drops message bodies, tool input/output, nested path-like fields,
permissions, sharing, and arbitrary metadata before archive upload. Command
time and output sizes are hard-bounded; failures are fail-soft. The adapter
then reduces those exports through the same path as the agents that already
write JSONL.

The privileged sidecar accepts only a root-owned, non-writable
`/usr/local/bin/opencode`. The current GitHub action installs OpenCode under
the runner user's home directory, so live/GCS capture deliberately fails
closed until the shared runner image supplies that trusted binary. The
workflow's separate post-agent trajectory artifact remains non-privileged and
does not share the telemetry writer credential.

The watch roots a runner-mode telemetry pass actually discovers transcripts
under (as opposed to the host daemon's own `watchRoots` config) are defined
once in `runner-capture.ts` (`runnerWatchRoots`, `RUNNER_CAPTURE_AGENTS`,
`transcriptObjectPath`) and imported by both of `apps/telemetry-watcher`'s
runner-mode entry points (`runner.ts`'s `startSidecar` and `finalize.ts`'s
`finalizeSidecar`) rather than hand-copied.

## CLI

```bash
./tools/nx run @repo/cli:run -- agent-telemetry reduce <transcript-file>
```

Prints the reduced summary as JSON — useful for verifying the reducer against
real transcripts without needing the telemetry store or any infra.

## Running unit tests

Run `./tools/nx run @agent-lcars/telemetry:test` to execute the unit tests via
[Jest](https://jestjs.io).

# Resumable Conversations — Plan 4: OpenCode session continuity

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A reply on an OpenCode work item resumes the same OpenCode session, completing "one work item is one conversation" for all three pipelines.

**Architecture:** Unlike Claude and Codex, OpenCode's archived artifact is not resumable: the runner captures `opencode export --sanitize` and then strips it further, so every word of the conversation is a redaction marker. The maintainer decided on 2026-09-04 that the **raw** export may be archived, the same treatment Claude's and Codex's raw archives already get. So this plan captures a _second_, raw artifact alongside the existing sanitized one, points a new `resumeGcsUri` at it, and restores it with `opencode import` into the container's own store before `opencode run --session` continues the conversation. The sanitized artifact and everything that reads it are untouched.

**Tech Stack:** TypeScript (`apps/telemetry-watcher`, `libs/telemetry`, `apps/console`), Vitest, bash (`direct-runner.sh`), OpenCode 1.18.21, Nx.

**Spec:** `docs/superpowers/specs/2026-09-03-resumable-agent-conversations-design.md` — "Session continuity per CLI" (the OpenCode column), "Measured: OpenCode export and import", and decision 3.

**Depends on:** Plan 1 (#1769) for `requestReply`/`selectResumeSession`/`RESUMABLE_PIPELINES`, and plan 3 (#1774) for `runner resume --agent`. Both merged. Independent of plan 2 and plan 5.

## Why a second artifact, and not just un-sanitizing the existing one

Measured on 2026-09-04 against OpenCode 1.18.21 (recorded in the spec):

| Fact                                                      | Consequence for this plan                                                                                    |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `export` → `import` preserves the session **id**          | A restored session is addressable by `opencode run --session <id>`; no id mapping is needed.                 |
| An isolated data directory is honored                     | The restore is containable and testable without touching a real store.                                       |
| `--sanitize` redacts **content**, keeps **structure**     | A sanitized export imports fine and resumes into a conversation the model cannot read. It is not a fallback. |
| The archived artifact is narrower still than `--sanitize` | The watcher's `materializeSafeExport` keeps only ids, roles, timings, token counts. Also not a fallback.     |

The existing sanitized artifact stays exactly as it is because the console's
timeline reads it. Making _that_ file raw would push unredacted tool output
into a rendering path that was deliberately built narrow. Two artifacts,
two purposes.

## Global Constraints

- **Never execute OpenCode from `PATH`.** Both capture and restore must go
  through `resolveTrustedOpenCodeExecutable`/`isTrustedOpenCodePath`
  (`opencode-export-capture.ts`), which requires the root-owned binary. This
  is an existing security boundary; reuse it, do not re-implement it.
- **The sanitized artifact and `transcriptGcsUri` do not change.** Nothing
  that reads them (the console timeline, `renderable`) may be affected.
- **`resumeGcsUri` is additive and optional.** For Claude and Codex it stays
  unset and resume continues to use `transcriptGcsUri`; only OpenCode
  populates it. Persisted documents are never migrated.
- **A requested resume that cannot be restored is fatal** in the runner, as
  for Claude and Codex. A run with no resume request is unaffected.
- **The import must complete before `opencode run` starts.** Both open the
  same SQLite store.
- Session ids continue to pass `isSafeIdentifier` before being used in a
  path or a command argument.
- Work in the feature worktree. Push once the fast layer passes; CI's
  `Verify` is the gate.
- Commit trailers on every commit:
  ```
  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01BHX94T4vWdYy5jCCFyy7TZ
  ```

## File Structure

| File                                                                 | Responsibility                                                                |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `apps/telemetry-watcher/src/lib/opencode-export-capture.ts` (modify) | Capture a raw export beside the sanitized one; prune both                     |
| `apps/telemetry-watcher/src/lib/finalize.ts` (modify)                | Upload the raw export; set `resumeGcsUri` on the session doc                  |
| `libs/telemetry/src/lib/types.ts`, `session-doc.ts` (modify)         | `resumeGcsUri` on the archived issue-agent session doc                        |
| `libs/telemetry/src/lib/runner-capture.ts` (modify)                  | `resumeObjectPath` beside `transcriptObjectPath`                              |
| `apps/telemetry-watcher/src/lib/resume-transcript.ts` (modify)       | `agent: 'opencode'` downloads, then imports through the trusted binary        |
| `apps/telemetry-watcher/src/main.ts` (modify)                        | `runner resume --agent opencode`                                              |
| `apps/runner-autoscaler/runner-image/direct-runner.sh` (modify)      | OpenCode restore before the run; `run --session`; best-effort message capture |
| `apps/runner-autoscaler/runner-image/direct-runner.test.sh` (modify) | Fixtures for the OpenCode resume path and its negative cases                  |
| `apps/console/src/lib/work-reply.ts` (modify)                        | Prefer `resumeGcsUri`; `RESUMABLE_PIPELINES` gains `opencode`                 |
| `apps/console/src/app/sessions/[id]/session-header.tsx` (modify)     | The OpenCode note stops implying no continuity exists                         |
| `docs/superpowers/specs/…-design.md` (modify)                        | Record that decision 3 is decided and sub-project 4 shipped                   |

---

### Task 1: `resumeGcsUri` — a resumable artifact distinct from the rendered one

**Files:**

- Modify: `libs/telemetry/src/lib/types.ts`, `libs/telemetry/src/lib/session-doc.ts`, `libs/telemetry/src/lib/runner-capture.ts`
- Test: the matching `.spec.ts` files, and `apps/console/src/lib/work-reply.test.ts`
- Modify: `apps/console/src/lib/work-reply.ts`

**Interfaces:**

- Produces: `ArchivedIssueAgentSessionDoc.resumeGcsUri?: string`;
  `resumeObjectPath({runId, adapter, sessionId})`;
  `resumeUriFor(doc): string | undefined`. Tasks 2 and 3 write and read these.

- [ ] **Step 1: Write the failing tests**

In `apps/console/src/lib/work-reply.test.ts`:

```ts
it('prefers resumeGcsUri over transcriptGcsUri when both exist', () => {
  const doc = session({
    agent: 'opencode',
    transcriptGcsUri: 'gs://b/runs/r1/opencode/s1.jsonl',
    resumeGcsUri: 'gs://b/runs/r1/opencode/s1.export.json',
  });
  expect(resumeUriFor(doc)).toBe('gs://b/runs/r1/opencode/s1.export.json');
});

it('falls back to transcriptGcsUri for claude and codex', () => {
  expect(resumeUriFor(session({ agent: 'claude-code' }))).toBe(
    'gs://b/runs/r1/claude-code/s1.jsonl',
  );
});

it('does not select an opencode session that has only a sanitized transcript', () => {
  // The whole point of resumeGcsUri: a sanitized-only archive is NOT
  // resumable, and selecting it would resume into redaction markers.
  const doc = session({ agent: 'opencode', resumeGcsUri: undefined });
  expect(selectResumeSession([doc], runIds, 'opencode')).toBeUndefined();
});

it('selects an opencode session that has a raw export', () => {
  const doc = session({
    agent: 'opencode',
    resumeGcsUri: 'gs://b/runs/r1/opencode/s1.export.json',
  });
  expect(selectResumeSession([doc], runIds, 'opencode')?.sessionId).toBe(
    doc.sessionId,
  );
});
```

And in `libs/telemetry/src/lib/runner-capture.spec.ts`:

```ts
it('names the resumable artifact beside the rendered one', () => {
  expect(
    resumeObjectPath({
      runId: 'work:01ABC/r1',
      adapter: 'opencode',
      sessionId: 's1',
    }),
  ).toBe('runs/work:01ABC/r1/opencode/s1.export.json');
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run apps/console/src/lib/work-reply.test.ts libs/telemetry/src/lib/runner-capture.spec.ts`
Expected: FAIL — `resumeUriFor` and `resumeObjectPath` do not exist.

- [ ] **Step 3: Add the field and the path helper**

`libs/telemetry/src/lib/types.ts`, on `ArchivedIssueAgentSessionDoc` beside `transcriptGcsUri`:

```ts
  /**
   * The artifact a later run can actually resume from, when that is not the
   * same file the console renders. Claude and Codex archive their raw CLI
   * session, so `transcriptGcsUri` is both; OpenCode's rendered archive is
   * sanitized to redaction markers, so its resumable artifact is a separate
   * raw export and only this field points at it. Absent means "resume from
   * `transcriptGcsUri`".
   */
  resumeGcsUri?: string;
```

`runner-capture.ts`, beside `transcriptObjectPath`:

```ts
/** The resumable sibling of {@link transcriptObjectPath}. A distinct
 *  extension, so the `*.jsonl` transcript discovery never picks it up as a
 *  session of its own. */
export function resumeObjectPath(options: {
  runId: string | undefined;
  adapter: SessionAgent;
  sessionId: string;
}): string {
  return `runs/${options.runId ?? 'unknown'}/${options.adapter}/${options.sessionId}.export.json`;
}
```

Thread `resumeGcsUri` through `buildSessionWrite` exactly as `transcriptGcsUri` already is.

- [ ] **Step 4: Use it in resume selection**

`apps/console/src/lib/work-reply.ts`:

```ts
const RESUMABLE_PIPELINES: Record<string, string> = {
  claude: 'claude-code',
  codex: 'codex',
  opencode: 'opencode',
};

/** The artifact a resume actually restores from. Claude and Codex archive
 *  their raw session, so it is the transcript itself; OpenCode's transcript
 *  is a sanitized rendering whose every word is a redaction marker, so only
 *  its separate raw export can carry the conversation. */
export function resumeUriFor(doc: SessionDoc): string | undefined {
  if (doc.source !== 'issue-agent') return undefined;
  return doc.resumeGcsUri ?? doc.transcriptGcsUri;
}
```

and in `selectResumeSession`, replace the `doc.transcriptGcsUri !== undefined`
filter with `resumeUriFor(doc) !== undefined`. In `requestReply`, set
`resumeTranscriptGcsUri` from `resumeUriFor(chosen)` rather than
`chosen.transcriptGcsUri`.

- [ ] **Step 5: Run the tests and commit**

Run: `npx vitest run apps/console/src/lib/work-reply.test.ts libs/telemetry/src`
Expected: PASS.

```bash
git add libs/telemetry/src apps/console/src/lib/work-reply.ts apps/console/src/lib/work-reply.test.ts
git commit -m "feat(telemetry): a session can name a resumable artifact distinct from its rendered one"
```

---

### Task 2: Capture and archive the raw export

**Files:**

- Modify: `apps/telemetry-watcher/src/lib/opencode-export-capture.ts`, `apps/telemetry-watcher/src/lib/finalize.ts`
- Test: `apps/telemetry-watcher/src/lib/opencode-export-capture.spec.ts`, `finalize.spec.ts`

- [ ] **Step 1: Write the failing tests**

In `opencode-export-capture.spec.ts`, using the file's existing
`runOpenCodeToFile` double:

```ts
it('captures a raw export beside the sanitized one', async () => {
  await captureOpenCodeExports(options);
  // Two invocations per session: one --sanitize (the rendered artifact),
  // one without (the resumable one).
  expect(calls).toContainEqual(['--pure', 'export', 'ses_1', '--sanitize']);
  expect(calls).toContainEqual(['--pure', 'export', 'ses_1']);
  expect(fs.existsSync(`${sessionsDir}/ses_1.jsonl`)).toBe(true);
  expect(fs.existsSync(`${sessionsDir}/ses_1.export.json`)).toBe(true);
});

it('prunes a stale raw export whose session is gone', async () => {
  fs.writeFileSync(`${sessionsDir}/ses_gone.export.json`, '{}');
  await captureOpenCodeExports(options);
  expect(fs.existsSync(`${sessionsDir}/ses_gone.export.json`)).toBe(false);
});

it('keeps the sanitized artifact when the raw export fails', async () => {
  // A raw-export failure must not cost us the rendered timeline.
  expect(fs.existsSync(`${sessionsDir}/ses_1.jsonl`)).toBe(true);
});
```

In `finalize.spec.ts`:

```ts
it('uploads the raw export and sets resumeGcsUri', async () => {
  expect(uploads).toContainEqual(
    expect.objectContaining({ object: 'runs/r1/opencode/ses_1.export.json' }),
  );
  expect(written.resumeGcsUri).toBe(
    'gs://bucket/runs/r1/opencode/ses_1.export.json',
  );
});

it('ships the doc without resumeGcsUri when there is no raw export', async () => {
  // Claude and Codex sessions have none, and must be unaffected.
  expect(written.resumeGcsUri).toBeUndefined();
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run apps/telemetry-watcher/src/lib/opencode-export-capture.spec.ts apps/telemetry-watcher/src/lib/finalize.spec.ts`
Expected: FAIL — only the sanitized export is captured, and no `resumeGcsUri` is written.

- [ ] **Step 3: Capture the raw export**

In `captureOpenCodeExports`'s per-session loop, after the sanitized artifact
is renamed into place, add a second capture that reuses the same trusted
executable, timeout and byte cap:

```ts
// The resumable artifact (spec decision 3, decided 2026-09-04). The
// sanitized file above is what the console renders; this one is the
// only thing a later run can actually resume from, because
// `--sanitize` replaces every word of the conversation with a
// redaction marker. Failing to capture it costs continuity, never the
// rendered timeline -- so it is caught separately from the loop's
// main try, and the sanitized artifact is already committed above.
const rawDestination = path.join(sessionsDir, `${session.id}.export.json`);
const rawTemporary = `${rawDestination}.tmp-${process.pid}-${Date.now()}`;
try {
  await runOpenCodeToFile(['--pure', 'export', session.id], rawTemporary, {
    timeout: commandTimeoutMs,
    maxBytes: exportMaxBytes,
  });
  fs.chmodSync(rawTemporary, 0o600);
  fs.renameSync(rawTemporary, rawDestination);
} catch (error) {
  logger.warn(
    `agent-lcars-telemetry-watcher: failed to capture a resumable OpenCode export for ${session.id}; this session will not be resumable`,
    error,
  );
  try {
    fs.unlinkSync(rawTemporary);
  } catch (cleanupError) {
    if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn(
        `agent-lcars-telemetry-watcher: failed to remove temporary OpenCode raw capture ${rawTemporary}`,
        cleanupError,
      );
    }
  }
}
```

Then extend the prune at the end of the function, which today deletes only
unselected `*.jsonl`:

```ts
  const selectedFiles = new Set(
    sessions.flatMap(({ id }) => [`${id}.jsonl`, `${id}.export.json`]),
  );
  // ...
      if (
        entry.isFile() &&
        (entry.name.endsWith('.jsonl') || entry.name.endsWith('.export.json')) &&
        !selectedFiles.has(entry.name)
      ) {
```

Without this the raw exports accumulate: the existing prune only matches
`.jsonl`, so a raw file whose session has aged out of the CLI list would
never be removed.

- [ ] **Step 4: Upload it and record the URI**

In `finalize.ts`'s per-session archive block, after the existing transcript
upload, add a sibling upload guarded on the file existing:

```ts
let resumeGcsUri: string | undefined;
const rawExport = `${file}`.replace(/\.jsonl$/u, '.export.json');
if (config.transcriptsBucket && adapter === 'opencode' && exists(rawExport)) {
  const object = resumeObjectPath({
    runId: config.runId,
    adapter,
    sessionId: summary.sessionId,
  });
  try {
    await deps.uploadTranscript({
      projectId: config.firestoreProjectId,
      bucket: config.transcriptsBucket,
      object,
      contents: readFile(rawExport),
    });
    resumeGcsUri = `gs://${config.transcriptsBucket}/${object}`;
  } catch (error) {
    // Same fail-soft shape as the transcript upload above: losing the
    // resumable artifact costs continuity, never the run.
    const message = `agent-lcars-telemetry-watcher: finalize failed to upload the resumable export for session ${summary.sessionId}, shipping doc without resumeGcsUri`;
    logger.warn(message, error);
    annotateWarning(`${message}: ${error}`);
  }
}
```

and add `...(resumeGcsUri && { resumeGcsUri })` to the `buildSessionWrite`
options beside the existing `transcriptGcsUri` spread. Use the file-reading
and existence helpers `finalize.ts` already injects for testability rather
than calling `fs` directly, matching how `rawContent` is obtained.

- [ ] **Step 5: Run the tests and commit**

Run: `npx vitest run apps/telemetry-watcher/src/lib`
Expected: PASS.

```bash
git add apps/telemetry-watcher/src/lib
git commit -m "feat(telemetry): archive a resumable raw OpenCode export beside the sanitized one"
```

---

### Task 3: Restore and resume in the container

**Files:**

- Modify: `apps/telemetry-watcher/src/lib/resume-transcript.ts`, `apps/telemetry-watcher/src/main.ts`
- Modify: `apps/runner-autoscaler/runner-image/direct-runner.sh`
- Test: `resume-transcript.spec.ts`, `main.spec.ts`, `direct-runner.test.sh`

- [ ] **Step 1: Write the failing tests**

In `resume-transcript.spec.ts`:

```ts
it('imports an opencode export through the trusted binary', async () => {
  const ran: string[][] = [];
  const path = await resumeTranscript({
    agent: 'opencode',
    sessionId: 'ses_1',
    transcriptGcsUri: 'gs://b/runs/r1/opencode/ses_1.export.json',
    cwd: '/home/runner/_work/checkout',
    claudeProjectsDir: '/home/runner/.claude/projects',
    download: async () => '{"info":{"id":"ses_1"},"messages":[]}',
    runOpenCode: async (args) => {
      ran.push(args);
      return '';
    },
    mkdir: () => undefined,
    writeFile: () => undefined,
  });
  expect(ran[0]).toEqual(['--pure', 'import', expect.any(String)]);
  expect(path).toBe('ses_1');
});

it('returns undefined when no trusted opencode binary is available', async () => {
  // Never fall back to PATH: that is the existing capture-side boundary.
});

it('rejects an unsafe opencode session id before running anything', async () => {
  expect(ranNothing).toBe(true);
});
```

In `direct-runner.test.sh`, following its flat fixture style, add:

1. **opencode resume happy path**: `FAKE_PIPELINE=opencode` with a `resume`
   object in the brief. Assert `runner resume` was called with
   `--agent opencode`, the session id and the transcript uri, and that the
   fake `opencode` binary's argv contains `run` **and** `--session <id>`.
2. **opencode fresh path (regression pin)**: no `resume` in the brief;
   assert no `--session` flag and no `runner resume` process.
3. **opencode restore failure is fatal**: fake `runner resume` exits
   non-zero; assert the script exits non-zero and `opencode run` never ran.

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run apps/telemetry-watcher/src/lib/resume-transcript.spec.ts` then `bash apps/runner-autoscaler/runner-image/direct-runner.test.sh`
Expected: FAIL — `agent: 'opencode'` is unhandled, and the runner has no OpenCode resume branch.

- [ ] **Step 3: Import in `resumeTranscript`**

Extend the existing per-agent branch. OpenCode is the one agent whose
restore is a _command_, not a file write: download to a temporary file, then
hand that file to the trusted binary.

```ts
if (options.agent === 'opencode') {
  // Import, not a file write: OpenCode's store is a SQLite database, and
  // `import` is its own first-class way in. The binary is resolved
  // through the same trusted-path guard capture uses -- never PATH.
  const executable =
    options.opencodeExecutable ?? resolveTrustedOpenCodeExecutable();
  if (!executable) {
    logger.warn(
      'agent-lcars-telemetry-watcher: no trusted OpenCode executable; continuing without a resumed session',
    );
    return undefined;
  }
  const contents = await download(options.transcriptGcsUri, {
    projectId: options.projectId,
  });
  const temporary = path.join(
    os.tmpdir(),
    `opencode-resume-${options.sessionId}.json`,
  );
  writeFile(temporary, contents);
  try {
    await runOpenCode(['--pure', 'import', temporary]);
    // The session id is preserved across export/import (measured), so the
    // caller's `--session <id>` addresses the restored conversation.
    return options.sessionId;
  } finally {
    unlink(temporary);
  }
}
```

Return the session id rather than a path here, and document that: for
Claude and Codex `runner resume` prints the file it wrote, and for OpenCode
there is no such file — the caller only needs a non-empty success signal.
Keep `main.ts`'s "print one line, nothing else" contract and accept
`--agent opencode`.

- [ ] **Step 4: Restore and resume in `direct-runner.sh`**

In the opencode branch, after the trusted-binary checks and before the run:

```bash
  OPENCODE_SESSION_ARGS=()
  if [ -n "$RESUME_SESSION_ID" ] && [ -n "$RESUME_TRANSCRIPT_URI" ]; then
    # Must complete before `opencode run` starts: both open the same
    # SQLite store. A caller that asked to resume must never silently
    # become a fresh session, so any failure here is fatal, matching the
    # Claude and Codex branches.
    if ! GOOGLE_APPLICATION_CREDENTIALS=/run/secrets/telemetry-writer.json \
      AGENT_TELEMETRY_PROJECT_ID=agent-lcars \
      node /usr/local/lib/agent-lcars/sidecar.cjs runner resume \
      --agent opencode \
      --session-id "$RESUME_SESSION_ID" --transcript-uri "$RESUME_TRANSCRIPT_URI" \
      --cwd "$PWD" >/dev/null 2>&1; then
      echo "FATAL: requested OpenCode session restore failed" >&2
      exit 1
    fi
    OPENCODE_SESSION_ARGS=(--session "$RESUME_SESSION_ID")
  fi
```

and add `"${OPENCODE_SESSION_ARGS[@]}"` to the `opencode run` invocation,
keeping `--model`, `--auto`, the `env -u OPENCODE_LLM_API_KEY` guard and the
timeout exactly as they are.

Capture the final message the same way the Claude branch does, with `tee`
into `$RUNNER_TEMP` and `PIPESTATUS`:

```bash
  LAST_MESSAGE_FILE="$RUNNER_TEMP/opencode-last-message.txt"
  ...
      --auto "$AGENT_PROMPT" | tee "$LAST_MESSAGE_FILE"
  AGENT_EXIT=${PIPESTATUS[0]}
```

**Best-effort, and say so in the PR body.** Unlike Claude's `--print` and
Codex's `--output-last-message`, `opencode run`'s default output is
_formatted_ progress, so the tail this captures may include more than the
final message. That is acceptable for a rendered turn and is strictly
better than no message. If the live proof shows it is too noisy to read,
the documented follow-up is `--format json` with the last assistant text
part extracted — do not switch to it speculatively, because it changes the
whole run log.

- [ ] **Step 5: Run the tests and commit**

Run: `npx vitest run apps/telemetry-watcher/src` then `bash apps/runner-autoscaler/runner-image/direct-runner.test.sh`
Expected: PASS.

```bash
git add apps/telemetry-watcher/src apps/runner-autoscaler/runner-image
git commit -m "feat(runner): an opencode reply round resumes its own session"
```

---

### Task 4: Console and the record

**Files:**

- Modify: `apps/console/src/app/sessions/[id]/session-header.tsx`
- Modify: `docs/superpowers/specs/2026-09-03-resumable-agent-conversations-design.md`
- Test: `session-header.test.tsx`

- [ ] **Step 1: Update the session page note**

Plan 3 narrowed the Codex note and left OpenCode with the generic "no
resume command yet". That is now misleading in the same way Codex's was: a
reply on the item continues an OpenCode conversation automatically. Give
OpenCode its own note saying exactly that, with a test pinning it. Do not
add a `fleet-tools` adapter; that stays out of scope.

- [ ] **Step 2: Update the spec**

Record that decision 3 was **decided by the maintainer on 2026-09-04:
archive the raw export, same treatment as Claude and Codex**. Replace the
OpenCode column of "Session continuity per CLI" with what this plan
actually built (two artifacts, `resumeGcsUri`, `import`, `--session`), and
move sub-project 4 in the Sequencing list from "blocked on decision 3" to
shipped, leaving its live proof outstanding.

- [ ] **Step 3: Run the tests and commit**

Run: `npx vitest run apps/console/src/app/sessions`
Expected: PASS.

```bash
git add apps/console/src/app/sessions docs/superpowers/specs
git commit -m "feat(console): opencode sessions continue through a reply"
```

---

### Task 5: Land, then prove it

- [ ] **Step 1: Land**

Run `npx nx affected -t lint typecheck --base=origin/main`, push, open the
PR, arm squash auto-merge, watch inline until merged, resolving every
review thread. The PR body must state that the raw export lands in the
private transcripts bucket under the same lifecycle as Claude's and
Codex's raw archives, per the maintainer's decision, and that the sanitized
artifact the console renders is unchanged.

- [ ] **Step 2: The real-path proof (spec proof 4)** — maintainer-gated

1. Create a native item on the `opencode` pipeline: _"Invent a
   six-character codeword, state it, and PARK. If you are resuming and
   already have a codeword from earlier in this conversation, state that
   one instead and PARK."_
2. Confirm r1 parks, and that **both** artifacts exist:
   `runs/<runId>/opencode/<sessionId>.jsonl` (sanitized) and
   `runs/<runId>/opencode/<sessionId>.export.json` (raw), and that the
   session doc carries `resumeGcsUri`.
3. Reply through `POST /items/{id}/reply`; confirm r2's params carry
   `resumeSessionId`.
4. While r2 is live, `docker exec` in and confirm the `runner resume
--agent opencode` process and an `opencode run … --session <id>`
   process.
5. Confirm r2 recalls the **same** codeword — the proof that raw content,
   not redaction markers, crossed the boundary.
6. Negative case: reply with `resume: false`; confirm a new session id and
   a different codeword.
7. Sanity-check the console timeline still renders from the sanitized
   artifact and shows no raw tool output.
8. Record it in `docs/native-work-smoke-runbook.md`.

---

## Self-review

**Spec coverage.** Implements the OpenCode row of "Session continuity per
CLI" in full — raw export capture, `resumeGcsUri`, `import`, `--session`,
message capture — plus the `resumeGcsUri` field the spec's data model
already called for but which plans 1–3 never needed (Claude and Codex
archive their own resumable artifact, so `transcriptGcsUri` sufficed).

**Deviations from the spec, recorded.**

1. The spec put `resumeGcsUri` on the session doc in sub-project 1. It was
   not implemented there because nothing needed it; this plan adds it where
   it is first load-bearing, with `resumeUriFor` keeping Claude and Codex on
   `transcriptGcsUri` unchanged.
2. The spec's OpenCode message capture said "last assistant text part from
   the `--format json` stream". This plan uses `tee` plus a bounded tail
   instead, because switching the run to JSON changes the whole runner log
   for every OpenCode run, and message capture is a rendering nicety, not
   the point of the plan. The JSON route is documented as the follow-up if
   the proof shows the formatted tail is unreadable.
3. `runner resume` returns a session id for OpenCode where it returns a
   file path for Claude and Codex, because there is no single restored
   file — the import writes into SQLite. Callers only check non-empty.

**The one real risk.** Two `opencode export` invocations per session per
capture pass, and capture runs on every sidecar tick as well as at
finalize. The raw export is roughly 2.6x the sanitized one for the sample
measured (1,031,211 against 392,223 bytes), against the existing 32 MB cap
and 10 s timeout per invocation, for at most 20 sessions. That is the
budget this doubles; if it proves too slow in practice the narrow fix is to
capture the raw export only in the finalize pass, not on every tick. Left
as-is deliberately: correctness first, and the tick already tolerates a
slow capture by design.

**Type consistency.** `resumeGcsUri`, `resumeObjectPath`, `resumeUriFor`
and `--agent opencode` are named identically in the tasks that define and
consume them. `.export.json` is the single extension used by the capture
(Task 2), the prune (Task 2), the object path (Task 1) and the finalize
sibling lookup (Task 2).

**Known soft spots for the executor.** `finalize.ts`'s injected
file-reading helpers and `opencode-export-capture.spec.ts`'s existing
doubles were not read in full while writing this plan; follow what those
files already do rather than introducing new injection points. The measured
OpenCode facts are pinned to 1.18.21 and the runner image installs OpenCode
from a **pinned** GitHub release with a SHA-256 check (unlike Codex), so
check `opencode-version` in the runner image and re-measure the
export/import round trip if it differs.

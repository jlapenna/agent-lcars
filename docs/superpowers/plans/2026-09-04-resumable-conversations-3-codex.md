# Resumable Conversations — Plan 3: Codex session continuity

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A reply on a Codex work item resumes the same Codex thread, the way a Claude reply already resumes the same Claude session — so "one work item is one conversation" holds for a second pipeline.

**Architecture:** Codex already archives its **raw rollout file** at `runs/<runId>/codex/<sessionId>.jsonl`, so unlike OpenCode there is nothing to change about capture. The whole feature is three small pieces: teach the sidecar's `runner resume` to write a rollout into a fresh `$CODEX_HOME`, invoke `codex exec resume <threadId>` instead of `codex exec`, and let `requestReply` select a `codex` session as resumable. The restore is simpler than Claude's because Codex resolves a thread purely by the id embedded in the rollout's filename.

**Tech Stack:** TypeScript (`apps/telemetry-watcher`, `libs/telemetry`), Vitest, bash (`direct-runner.sh`), `codex-cli` 0.151.0, Nx.

**Spec:** `docs/superpowers/specs/2026-09-03-resumable-agent-conversations-design.md` — "Session continuity per CLI" (the Codex column) and "Verified CLI facts".

**Depends on:** Plan 1 (merged, #1769) for `requestReply`, `RESUMABLE_PIPELINES`, `Run.result.message`, and the reply prompt. Independent of plan 2 (GitHub) and plan 4 (OpenCode); it may land in parallel with either.

## Verified Codex behavior

Everything below was **measured** against `codex-cli 0.151.0` on 2026-09-04, in a throwaway `CODEX_HOME` containing nothing but a copied rollout file and a `config.toml`. Do not re-litigate these from documentation. The runner image installs Codex **unpinned** (`npm install -g @openai/codex`, `apps/runner-autoscaler/runner-image/Dockerfile`), so the image's version drifts with every rebuild and may not be 0.151.0. Before implementing, run `codex --version` in the current image and, if it differs, re-measure the two facts that would break this design: bare-rollout resolution, and date-path irrelevance. `codex exec resume` was separately confirmed to accept `--json`, `--dangerously-bypass-approvals-and-sandbox` and `-o/--output-last-message`.

| Question                                              | Measured answer                                                                                                                                                           |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Does a bare rollout file in a fresh home resume?      | **Yes.** `codex exec resume <uuid>` replayed the prior turn and reported `session id: <uuid>`.                                                                            |
| Is `codex migrate-rollouts` needed first?             | **No.** The rollout inspected as `"status": "eligible"` (i.e. not yet migrated) and resumed anyway. Do not add a migration step.                                          |
| Does the date directory or filename timestamp matter? | **No.** The same rollout placed at `sessions/2020/01/01/rollout-2020-01-01T00-00-00-<uuid>.jsonl` resumed identically. **Only the uuid in the basename is load-bearing.** |
| Must the recorded `cwd` match the resuming cwd?       | **No.** The rollout recorded a completely different checkout and resumed without complaint. (`--all` only affects the interactive _picker_.)                              |
| Does resume mint a new session id or a new file?      | **Neither.** Same id, and the thread continues in the same rollout file — matching Claude's behavior and plan 1's "newest session for this task" resolution rule.         |
| What does an unknown id do?                           | Exits non-zero with `thread/resume: thread/resume failed: no rollout found for thread id <id>` — a clean, detectable failure.                                             |
| Model mismatch on resume?                             | Warns (`This session was recorded with model X but is resuming with Y`) and proceeds. **So the resume must not change the model**; leave model selection exactly as is.   |

## Global Constraints

- **No archive-side change.** `finalize.ts` already uploads Codex's raw rollout verbatim. Touch nothing in the capture path.
- **A requested resume that cannot be restored is fatal**, exactly as it already is for Claude: a resume must never silently degrade to a fresh thread. A run with _no_ resume request is unaffected.
- **Ordering inside `direct-runner.sh` is load-bearing.** Claude's restore runs early (before `prepare-dispatch.sh`) because `~/.claude` already exists. Codex's cannot: `$CODEX_HOME` is a per-run tmpfs directory created later, and `cp -a "$HOME/.codex/." "$CODEX_HOME/"` seeds it. The Codex restore must run **after** that seeding and **before** the `codex exec` call.
- **Do not weaken the auth guardrail.** `direct-runner.sh` asserts the image contains no `~/.codex/auth.json`, and auth is fetched per run through `RUNS_API/codex-auth`. The restore writes a rollout only — never credentials.
- Session ids continue to pass `isSafeIdentifier` before being joined into a filesystem path (`resume-transcript.ts` already does this; the Codex path must too).
- Persisted documents are never migrated; new fields optional; schemas stay `z.strictObject`.
- Work in the feature worktree. Push once the fast layer passes; CI's `Verify` is the gate.
- Commit trailers on every commit:
  ```
  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01BHX94T4vWdYy5jCCFyy7TZ
  ```

## File Structure

| File                                                                                 | Responsibility                                                                       |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `apps/telemetry-watcher/src/lib/resume-transcript.ts` (modify)                       | A per-agent destination-path rule; Codex writes a rollout, Claude keeps today's path |
| `apps/telemetry-watcher/src/main.ts` (modify)                                        | `runner resume` accepts `--agent <claude-code\|codex>` and a `--codex-home`          |
| `apps/runner-autoscaler/runner-image/direct-runner.sh` (modify)                      | Codex restore after `$CODEX_HOME` seeding; `codex exec resume`; last-message capture |
| `apps/runner-autoscaler/runner-image/direct-runner.test.sh` (modify)                 | Fixtures for the Codex resume path and its negative cases                            |
| `apps/console/src/lib/work-reply.ts` (modify)                                        | `RESUMABLE_PIPELINES` gains `codex: 'codex'`                                         |
| `apps/console/src/app/sessions/[id]/session-header.tsx` (modify)                     | The archive-resume note stops calling Codex unsupported                              |
| `docs/superpowers/specs/2026-09-03-resumable-agent-conversations-design.md` (modify) | Fold the measured facts into the spec's CLI table                                    |

---

### Task 1: `runner resume` can write a Codex rollout

**Files:**

- Modify: `apps/telemetry-watcher/src/lib/resume-transcript.ts`
- Modify: `apps/telemetry-watcher/src/main.ts`
- Test: `apps/telemetry-watcher/src/lib/resume-transcript.spec.ts`, `apps/telemetry-watcher/src/main.spec.ts`

**Interfaces:**

- Produces: `resumeTranscript({ agent: 'claude-code' | 'codex', sessionId, transcriptGcsUri, cwd, claudeProjectsDir, codexHome, ... })` returning the local path written, or `undefined`. Task 2 invokes it through `runner resume --agent codex --codex-home "$CODEX_HOME"`.

- [ ] **Step 1: Write the failing tests**

In `apps/telemetry-watcher/src/lib/resume-transcript.spec.ts`, alongside the existing Claude cases:

```ts
it('writes a codex rollout under the codex home, keyed only by session id', async () => {
  const written: Record<string, string> = {};
  const path = await resumeTranscript({
    agent: 'codex',
    sessionId: '019fb1be-238c-77d2-a0b2-14961c202368',
    transcriptGcsUri:
      'gs://b/runs/r1/codex/019fb1be-238c-77d2-a0b2-14961c202368.jsonl',
    cwd: '/home/runner/_work/checkout',
    claudeProjectsDir: '/home/runner/.claude/projects',
    codexHome: '/run/codex/home',
    download: async () => '{"type":"session_meta"}\n',
    mkdir: () => undefined,
    writeFile: (p, c) => {
      written[p] = c;
    },
  });
  // Codex resolves a thread purely by the uuid in the basename; the date
  // path is inert, so it is a constant rather than derived from anything.
  expect(path).toBe(
    '/run/codex/home/sessions/1970/01/01/rollout-1970-01-01T00-00-00-019fb1be-238c-77d2-a0b2-14961c202368.jsonl',
  );
  expect(written[path!]).toContain('session_meta');
});

it('still writes a claude session to the claude projects dir', async () => {
  // regression pin for the shipped behavior
});

it('rejects an unsafe codex session id before touching the filesystem', async () => {
  const path = await resumeTranscript({
    agent: 'codex',
    sessionId: '../../etc/passwd',
    /* ...as above... */
  });
  expect(path).toBeUndefined();
});

it('returns undefined for codex when no codex home was given', async () => {
  // the caller is direct-runner.sh, which only knows CODEX_HOME inside the
  // codex branch; a missing one is a caller bug, not a crash
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run apps/telemetry-watcher/src/lib/resume-transcript.spec.ts`
Expected: FAIL — `resumeTranscript` takes no `agent`.

- [ ] **Step 3: Add the per-agent destination rule**

In `resume-transcript.ts`, keep the existing guard and download, and branch only on where the file lands:

```ts
export interface ResumeTranscriptOptions {
  /** Defaults to 'claude-code' so existing callers are unchanged. */
  agent?: 'claude-code' | 'codex';
  sessionId: string;
  transcriptGcsUri: string;
  cwd: string;
  claudeProjectsDir: string;
  /** Required when `agent` is 'codex': the per-run CODEX_HOME. */
  codexHome?: string;
  // ...existing fields unchanged
}

/**
 * Where the restored transcript has to land for each CLI to find it.
 *
 * Claude Code keys its store by a slug of the checkout directory, so the
 * path depends on `cwd`. Codex does not: it resolves a thread by the uuid
 * in the rollout's basename, and ignores both the date directory and the
 * timestamp in the name (measured against codex-cli 0.151.0; see the
 * plan's "Verified Codex behavior" table). The epoch date below is
 * therefore a deliberate constant, not a derived value -- it makes a
 * restored rollout obvious on sight and avoids inventing a timestamp the
 * archive no longer carries, since the uploader renames the file to
 * `<sessionId>.jsonl`.
 */
function destinationFor(options: ResumeTranscriptOptions): string | undefined {
  if ((options.agent ?? 'claude-code') === 'codex') {
    if (options.codexHome === undefined) return undefined;
    return path.join(
      options.codexHome,
      'sessions/1970/01/01',
      `rollout-1970-01-01T00-00-00-${options.sessionId}.jsonl`,
    );
  }
  return path.join(
    options.claudeProjectsDir,
    claudeProjectSlugFor(options.cwd),
    `${options.sessionId}.jsonl`,
  );
}
```

Use it in `resumeTranscript` in place of the two inline `path.join` calls, returning `undefined` when it does, and `mkdir(path.dirname(file))` instead of the previously-hardcoded directory.

- [ ] **Step 4: Accept the flags on the CLI**

In `main.ts`'s `runner resume` argument parsing, add `--agent` (default `claude-code`, rejected unless it is `claude-code` or `codex`) and `--codex-home`, passing both into `resumeTranscript`. Keep every existing flag and the existing "print the written path, nothing else" contract — `direct-runner.sh` reads stdout.

- [ ] **Step 5: Run the tests and commit**

Run: `npx vitest run apps/telemetry-watcher/src/lib/resume-transcript.spec.ts apps/telemetry-watcher/src/main.spec.ts`
Expected: PASS.

```bash
git add apps/telemetry-watcher/src
git commit -m "feat(telemetry): runner resume can restore a codex rollout"
```

---

### Task 2: The Codex run resumes its thread

**Files:**

- Modify: `apps/runner-autoscaler/runner-image/direct-runner.sh`
- Test: `apps/runner-autoscaler/runner-image/direct-runner.test.sh`

- [ ] **Step 1: Write the failing shell fixtures**

In `direct-runner.test.sh`, following the file's flat fixture style (each section inlines its own fake `curl`/`jq`-fed brief and fake binaries), add:

1. **codex resume happy path**: `FAKE_PIPELINE=codex`, a brief carrying `resume: {sessionId, transcriptGcsUri}`. Assert the fake `node .../sidecar.cjs` recorded `runner resume` with `--agent codex`, `--codex-home`, the session id and the transcript uri; and that the fake `codex` binary's argv contains `exec resume <sessionId>` **and** still contains `--json` and `--dangerously-bypass-approvals-and-sandbox`.
2. **codex fresh path (regression pin)**: same but with no `resume` in the brief. Assert `codex`'s argv contains `exec` and **not** `resume`, and that no `runner resume` process ran.
3. **codex restore failure is fatal**: fake `runner resume` exits non-zero; assert the script exits non-zero and that `codex` was never invoked.
4. **codex last message**: the fake `codex` writes a known string to the file named by `-o`/`--output-last-message`; assert the `/complete` payload's `.message` carries it.

- [ ] **Step 2: Run them and watch them fail**

Run: `bash apps/runner-autoscaler/runner-image/direct-runner.test.sh`
Expected: FAIL — the Claude-only gate means no Codex restore happens and `codex exec` never becomes `codex exec resume`.

- [ ] **Step 3: Split the resume preparation by pipeline**

The existing early block is gated `if [ "$PIPELINE" = "claude" ] && ...`. Leave it exactly as it is — Claude's restore must stay early. Add the Codex restore **inside the codex branch**, after `cp -a "$HOME/.codex/." "$CODEX_HOME/"` and after the auth restore's `codex login status`, and before `codex exec`:

```bash
  CODEX_RESUME_ARGS=()
  if [ -n "$RESUME_SESSION_ID" ] && [ -n "$RESUME_TRANSCRIPT_URI" ]; then
    # Same telemetry-writer credential and project the upload used. A
    # caller that asked to resume must never silently become a fresh
    # thread, so any failure here is fatal -- matching the Claude branch.
    if ! resumed_path="$(GOOGLE_APPLICATION_CREDENTIALS=/run/secrets/telemetry-writer.json \
      AGENT_TELEMETRY_PROJECT_ID=agent-lcars \
      node /usr/local/lib/agent-lcars/sidecar.cjs runner resume \
      --agent codex --codex-home "$CODEX_HOME" \
      --session-id "$RESUME_SESSION_ID" --transcript-uri "$RESUME_TRANSCRIPT_URI" \
      --cwd "$PWD" 2>/dev/null)"; then
      echo "FATAL: requested Codex session restore failed" >&2
      exit 1
    fi
    if [ -z "$resumed_path" ]; then
      echo "FATAL: requested Codex session restore returned no local path" >&2
      exit 1
    fi
    # Codex resolves the thread by the uuid in that file's name; no
    # migration step is needed and the recorded cwd need not match.
    CODEX_RESUME_ARGS=(resume "$RESUME_SESSION_ID")
  fi
```

- [ ] **Step 4: Invoke `codex exec resume` and capture the final message**

Replace the `codex exec` invocation, keeping every existing flag, the stderr fifo, the `jq` failure-message filter and `PIPESTATUS`:

```bash
  CODEX_LAST_MESSAGE_FILE="$CODEX_RUNTIME_DIR/last-message.txt"
  timeout --signal=TERM --kill-after=30s "${CODEX_TIMEOUT_SECONDS}s" \
    codex exec "${CODEX_RESUME_ARGS[@]}" --json --dangerously-bypass-approvals-and-sandbox \
    --output-last-message "$CODEX_LAST_MESSAGE_FILE" \
    "$AGENT_PROMPT" 2> "$CODEX_STDERR_PIPE" |
```

Do **not** add or change any `-c model=...` override: a resumed thread warns and proceeds on a model mismatch, and picking a model here would introduce one.

Then make the shared completion payload read whichever last-message file the pipeline produced, by pointing the existing `LAST_MESSAGE_FILE` at it inside the codex branch:

```bash
  LAST_MESSAGE_FILE="$CODEX_LAST_MESSAGE_FILE"
```

placed right after the invocation, so the payload build added by plan 1 needs no change at all.

- [ ] **Step 5: Run the shell tests and commit**

Run: `bash apps/runner-autoscaler/runner-image/direct-runner.test.sh`
Expected: PASS.

```bash
git add apps/runner-autoscaler/runner-image
git commit -m "feat(runner): a codex reply round resumes its own thread"
```

---

### Task 3: The control plane offers Codex resume

**Files:**

- Modify: `apps/console/src/lib/work-reply.ts`
- Test: `apps/console/src/lib/work-reply.test.ts`
- Modify: `apps/console/src/app/sessions/[id]/session-header.tsx`
- Modify: `docs/superpowers/specs/2026-09-03-resumable-agent-conversations-design.md`

- [ ] **Step 1: Write the failing test**

In `work-reply.test.ts`:

```ts
it('selects a codex session for a codex reply', () => {
  const doc = session({ agent: 'codex' });
  expect(selectResumeSession([doc], runIds, 'codex')?.sessionId).toBe(
    doc.sessionId,
  );
});

it('still refuses to cross pipelines', () => {
  expect(
    selectResumeSession([session({ agent: 'codex' })], runIds, 'claude'),
  ).toBeUndefined();
  expect(
    selectResumeSession([session({ agent: 'claude-code' })], runIds, 'codex'),
  ).toBeUndefined();
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run apps/console/src/lib/work-reply.test.ts`
Expected: FAIL — `RESUMABLE_PIPELINES` has no `codex` entry, so the codex case returns `undefined`.

- [ ] **Step 3: Add the mapping**

```ts
const RESUMABLE_PIPELINES: Record<string, string> = {
  claude: 'claude-code',
  codex: 'codex',
};
```

The values are `SessionAgent` members (`libs/telemetry/src/lib/types.ts`); `opencode` stays absent until plan 4 gives it a resumable archive.

- [ ] **Step 4: Update the session page's note**

`session-header.tsx` currently gates the archive-resume command on `doc.agent === 'claude-code'` and tells the reader there is no command for other agents. Codex sessions are archived raw and are now genuinely resumable, so either extend the command to Codex (if `fleet-claude-agent-session` grows a Codex adapter in the same change) or, if it does not, narrow the "no resume command yet" note so it no longer implies Codex conversations cannot be continued at all — the reply route continues them. Pick one and say which in the PR body; do not leave the page asserting something that is now false.

- [ ] **Step 5: Fold the measured facts into the spec**

Replace the Codex column's unverified cells in the spec's "Verified CLI facts" table with this plan's measured answers, and add one line under "Session continuity per CLI" noting that no `migrate-rollouts` step is needed and that only the uuid in the rollout basename is load-bearing. The spec is the durable record; a future reader must not have to re-derive this.

- [ ] **Step 6: Run the tests and commit**

Run: `npx vitest run apps/console/src/lib/work-reply.test.ts apps/console/src/app/sessions`
Expected: PASS.

```bash
git add apps/console/src docs/superpowers/specs
git commit -m "feat(work): a codex reply resumes the item's own codex thread"
```

---

### Task 4: Land, then prove it

- [ ] **Step 1: Land**

Run `npx nx affected -t lint typecheck --base=origin/main`, push, open the PR, arm squash auto-merge, watch inline until merged, resolving every review thread.

- [ ] **Step 2: The real-path proof (spec proof 3)** — maintainer-gated live dispatch

1. Create a native item on the `codex` pipeline whose description says: _"Invent a six-character codeword, state it, and PARK. If you are resuming and already have a codeword from earlier in this conversation, state that one instead and PARK."_
2. Confirm r1 parks with a codeword in `result.message`, and that its session archived to `runs/<runId>/codex/<sessionId>.jsonl`.
3. Reply through `POST /items/{id}/reply`. Confirm r2's params carry `resumeSessionId`.
4. While r2 is live, `docker exec` into the container and confirm both the `runner resume --agent codex` process and a live `codex exec resume <sessionId>` process, and that the rollout exists under `$CODEX_HOME/sessions/`.
5. Confirm r2 recalls the **same** codeword, under the same session id.
6. Negative case: reply with `resume: false`; confirm a fresh thread, a new session id, and a different codeword.
7. Record it all in `docs/native-work-smoke-runbook.md`.

---

## Self-review

**Spec coverage.** This plan implements the Codex row of the spec's "Session continuity per CLI" table in full: restore (Task 1), the resume invocation and final-message capture (Task 2), and resumable selection in the control plane (Task 3). It additionally corrects the spec's own Codex column, which contained unverified guesses, with measured facts (Task 3 step 5).

**Deviations from the spec, recorded.**

1. The spec said the restore should "write the rollout file under `$CODEX_HOME/sessions/<date>/`, date and timestamp taken from the archived `session_meta` line". Measurement shows the date and timestamp are **inert** — only the uuid in the basename is read. Parsing `session_meta` to reconstruct them would be effort spent on a value nothing consumes, and would fail on an archive whose first line is malformed. A constant epoch path is used instead, documented at the code.
2. The spec's table said "no Codex archive-resume tool exists today" as a limitation of the operator CLI. This plan does not add one; it makes the _automated_ path work and (Task 3 step 4) forces an explicit decision about what the session page should now say, rather than leaving a stale claim.
3. The spec listed capturing the Codex session id from the `--json` stream's `thread.started` event as a possible mechanism. Not needed: the telemetry watcher already derives the id from `session_meta`, and resume neither mints a new id nor a new file, so nothing extra has to be captured.

**Why this is lower-risk than plan 4 (OpenCode).** Codex's archive is already the raw, resumable artifact; OpenCode's is a sanitized metadata export that cannot rebuild a session, so plan 4 must change what is captured and answer decision 3 first. Nothing here depends on that decision.

**Type consistency.** `ResumeTranscriptOptions.agent`/`codexHome` (Task 1) are the exact flags Task 2's `runner resume` call passes (`--agent`, `--codex-home`). `RESUMABLE_PIPELINES`' values are `SessionAgent` members, matching what `selectResumeSession` compares against `doc.agent`. `CODEX_RESUME_ARGS` is expanded into the same `codex exec` line that keeps `--json` and the bypass flag.

**Known soft spots for the executor.** The exact argument-parsing style of `main.ts`'s `runner resume` subcommand and the fixture idioms of `direct-runner.test.sh`'s Codex sections were not read in full while writing this plan; follow whatever those files already do rather than importing a new parser or test helper. The measured CLI facts in the table above are pinned to `codex-cli 0.151.0` — if the runner image has moved to a different version, re-measure the two that would break the design (bare-rollout resolution, and date-path irrelevance) before implementing.

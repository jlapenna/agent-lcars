# Resumable Conversations — Plan 2: GitHub issue and PR exchanges

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A maintainer answers a parked agent on the issue or pull request thread itself — an ordinary comment, no trigger word — and the same agent session resumes with that comment as its next turn, with the agent's question visible in the thread.

**Architecture:** `requestReply` (plan 1) generalizes from a work id to the orchestrator's own anchor union, so a GitHub-anchored task replies through exactly the machinery a native item already does. The pure webhook interpreter is left untouched: an ordinary comment it already ignores as `no-reply-command` gets a second, stateful pass in the route — the same shape `push-watch.ts` uses to mint native items off `push` — where the store can see whether the task is actually parked. Outbound, the drain's outcome comment carries `Run.result.message`, so the question reaches the thread even when the agent's own park comment is terse.

**Tech Stack:** TypeScript, zod 4 (`z.strictObject`), Vitest, Next.js App Router route handlers, GitHub webhooks (`issue_comment`), Firebase App Hosting env configuration (`apps/console/apphosting.yaml`), Nx.

**Spec:** `docs/superpowers/specs/2026-09-03-resumable-agent-conversations-design.md` — sections "Surfaces → GitHub issue and PR threads", "The reply primitive", "Concurrency, budgets, and failure modes", "Security and authorization".

**Depends on:** Plan 1 (`docs/superpowers/plans/2026-09-04-resumable-conversations-1-reply-primitive.md`), merged. This plan calls `requestReply`, reads `Run.result.message`, and relies on `Run.params`'s widened value bound. Do not start until plan 1 is on `main`.

## Global Constraints

- **The pure interpreter stays pure.** `interpretDelivery`/`interpretIssueCommentEvent` (`apps/console/src/lib/orchestrator-ingest.ts`) are stateless by design and cannot read the store, so they can never decide "is this task parked". All statefulness lives in the route, mirroring `handlePushWebhookDelivery`.
- **Explicit triggers are untouched.** `@claude` / `@agent` / `/codex` / `/oc` keep today's exact behavior: `mode: reply`, a fresh session, task created if absent. They are how work is _started_ by comment, so they must keep working on an issue that has no task yet — which is precisely what `requestReply` refuses (`NOT_FOUND`). Implicit replies are a separate, additive path.
- **Decision 1, taken as a working assumption:** an ordinary maintainer comment on a parked anchor resumes the agent, gated per repository by a new `AGENT_LCARS_IMPLICIT_REPLY_REPOS` allowlist (empty or unset = the feature is off everywhere). This mirrors `AGENT_LCARS_PUSH_WATCHED_REPOS` exactly rather than inventing a boolean flag, and matches `docs/ci-control-flags.md`'s `<ACTION>_ARMED` spirit: an external effect is off until explicitly enabled.
- **Author gate is unchanged and non-negotiable:** `author_association` must be `OWNER` or `MEMBER`, and `comment.user.type` must not be `Bot`. The agent's own park comment is a bot comment, so it can never trigger a reply to itself. This is the loop-prevention argument; do not weaken it.
- **A new env var must be registered** in `libs/env-vars/src/env-vars.ts` before use, or every call site in the monorepo fails typecheck at once.
- Persisted documents are never migrated; every new field optional; schemas stay `z.strictObject`.
- Work in the feature worktree. Push once the fast layer passes; CI's `Verify` is the gate.
- Commit trailers on every commit:
  ```
  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01BHX94T4vWdYy5jCCFyy7TZ
  ```

## File Structure

| File                                                          | Responsibility                                                                        |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `apps/console/src/lib/work-reply.ts` (modify)                 | `requestReply` takes a `TaskId` and an optional `work` payload instead of a work id   |
| `apps/console/src/lib/implicit-reply.ts` (create)             | `handleImplicitReplyDelivery`: the stateful second pass over an ignored issue comment |
| `apps/console/src/lib/orchestrator-routes.ts` (modify)        | Route an `ignore('no-reply-command')` through the implicit-reply path                 |
| `apps/console/src/lib/orchestrator-dispatch.ts` (modify)      | The outcome comment carries `run.result.message`                                      |
| `libs/env-vars/src/env-vars.ts` (modify)                      | `AGENT_LCARS_IMPLICIT_REPLY_REPOS`                                                    |
| `apps/console/apphosting.yaml` (modify)                       | Declare the variable, empty in steady state                                           |
| `tools/contract-tests/deploy-console-config.test.ts` (modify) | Pin the new variable's declaration                                                    |
| `docs/github-label-contract.md` (modify)                      | Document what an ordinary comment on a parked anchor now does                         |

Line numbers below are from `main` at the commit that merged plan 1's implementation; re-locate by the quoted code if they have drifted.

---

### Task 1: `requestReply` speaks the anchor union

**Files:**

- Modify: `apps/console/src/lib/work-reply.ts`
- Modify: `apps/console/src/lib/work-router.ts` (its one call site)
- Test: `apps/console/src/lib/work-reply.test.ts`

**Interfaces:**

- Produces:

  ```ts
  export interface ReplyRequest {
    task: TaskId; // was: id: string
    text: string;
    channel: 'api' | 'console' | 'github' | 'slack';
    principal: string;
    ref?: string;
    pipeline?: string;
    resume?: boolean;
    /** Backfills `Task.work` for a legacy GitHub task that has none.
     *  Ignored when the task already carries one (`requestRun` writes
     *  `work` once and then never touches it). */
    work?: WorkPayload;
  }
  ```

  Task 2 constructs a `ReplyRequest` with a `{ repo, issue }` task.

- [ ] **Step 1: Write the failing tests**

Add to `apps/console/src/lib/work-reply.test.ts` (which already has a Firestore-free double for `WorkContext` from plan 1):

```ts
it('replies to a GitHub-anchored task', async () => {
  const outcome = await requestReply(context, {
    task: { repo: 'octo/example', issue: 42 },
    text: 'Use Firestore.',
    channel: 'github',
    principal: 'github:jlapenna',
    ref: 'https://github.com/octo/example/issues/42#issuecomment-1',
  });
  expect(outcome).toMatchObject({ ok: true, resumed: true });
  const run = await store.readRun((outcome as { runId: string }).runId);
  expect(run?.params).toMatchObject({
    mode: 'reply',
    reply: 'Use Firestore.',
    replyChannel: 'github',
    replyPrincipal: 'github:jlapenna',
  });
});

it('derives the pipeline and spec for a legacy task with no work payload', async () => {
  // A task created before ingress unification has `work: undefined`;
  // `workPayloadSchema.parse` would throw on it.
  const outcome = await requestReply(contextWithLegacyTask, {
    task: { repo: 'octo/example', issue: 7 },
    text: 'go on',
    channel: 'github',
    principal: 'github:jlapenna',
    work: legacyWorkPayload,
  });
  expect(outcome).toMatchObject({ ok: true });
});

it('refuses a reply for a task that does not exist', async () => {
  await expect(
    requestReply(context, {
      task: { repo: 'octo/example', issue: 999 },
      text: 'hi',
      channel: 'github',
      principal: 'github:jlapenna',
    }),
  ).resolves.toMatchObject({ ok: false, code: 'NOT_FOUND' });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run apps/console/src/lib/work-reply.test.ts`
Expected: FAIL — `ReplyRequest` has no `task`, and the legacy case throws inside `workPayloadSchema.parse`.

- [ ] **Step 3: Generalize the primitive**

In `work-reply.ts`, replace `request.id` with `request.task` everywhere:

```ts
const task = await context.runtime.store.readTask(request.task);
if (task === undefined)
  return { ok: false, code: 'NOT_FOUND', message: 'no such item' };

const runs = await context.runtime.store.listRuns(request.task);
```

Make the spec resolution tolerate a task with no stored `work`, using the caller's payload as the fallback:

```ts
// A GitHub task created before ingress unification carries no `work`.
// The caller derives one from the anchor (Task 2) and hands it here;
// `requestRun` writes it once, backfilling the task on the way past.
const payload =
  task.task.work === undefined
    ? request.work
    : workPayloadSchema.parse(task.task.work);
if (payload === undefined)
  return {
    ok: false,
    code: 'CONFLICT',
    message: 'task has no work payload and the caller supplied none',
  };
const { spec } = payload;
```

and pass `work` through to the orchestrator alongside the params:

```ts
  const outcome = await context.runtime.orchestrator.request({
    taskId: request.task,
    requestId: /* unchanged */,
    pipeline,
    ...(task.task.work === undefined && request.work !== undefined
      ? { work: request.work }
      : {}),
    params: { /* unchanged */ },
  });
```

Fix the `requestId` fallback, which used the work id:

```ts
    requestId:
      request.ref === undefined
        ? `${taskKey(request.task)}:${task.task.runCount + 1}`
        : `reply:${request.ref}`,
```

importing `taskKey` from `@agent-lcars/orchestrator`.

- [ ] **Step 4: Update the one existing call site**

`work-router.ts`'s `reply` handler passes `task: { workId: input.id }` instead of `id: input.id`. Nothing else changes.

- [ ] **Step 5: Run the tests and commit**

Run: `npx vitest run apps/console/src/lib/work-reply.test.ts apps/console/src/lib/work-router.test.ts`
Expected: PASS.

```bash
git add apps/console/src/lib/work-reply.ts apps/console/src/lib/work-reply.test.ts apps/console/src/lib/work-router.ts
git commit -m "refactor(work): the reply primitive speaks the orchestrator anchor union"
```

---

### Task 2: An ordinary comment on a parked anchor is a reply

**Files:**

- Create: `apps/console/src/lib/implicit-reply.ts`
- Test: `apps/console/src/lib/implicit-reply.test.ts` (create)
- Modify: `libs/env-vars/src/env-vars.ts`, `apps/console/apphosting.yaml`, `tools/contract-tests/deploy-console-config.test.ts`

**Interfaces:**

- Consumes: `requestReply` (Task 1), `issueCommentEventSchema` and `workPayloadFromGithub` (export them from `orchestrator-ingest.ts` if they are file-local; do not duplicate either).
- Produces: `handleImplicitReplyDelivery(deps, input): Promise<RouteResult | undefined>` — `undefined` means "not an implicit reply, carry on with the normal ignore path".

- [ ] **Step 1: Register the env var**

`libs/env-vars/src/env-vars.ts`, in the `AGENT_LCARS_*` block, alphabetically:

```ts
  /** Comma-separated `owner/repo` list whose issue and PR threads accept an
   *  ordinary maintainer comment on a PARKED anchor as a reply that resumes
   *  the agent's session. Empty or unset disables the behavior everywhere;
   *  explicit `@claude`/`/codex`/`/oc` triggers are unaffected. Mirrors
   *  AGENT_LCARS_PUSH_WATCHED_REPOS. */
  AGENT_LCARS_IMPLICIT_REPLY_REPOS?: string;
```

Declare it empty in `apps/console/apphosting.yaml` next to `AGENT_LCARS_PUSH_WATCHED_REPOS`, with a comment naming this plan, and pin the declaration in `tools/contract-tests/deploy-console-config.test.ts` the way that file already pins its neighbours.

- [ ] **Step 2: Write the failing tests**

`apps/console/src/lib/implicit-reply.test.ts`:

```ts
it('replies when a member comments on a parked anchor in an enabled repo', async () => {
  const result = await handleImplicitReplyDelivery(
    deps,
    delivery({
      author_association: 'MEMBER',
      body: 'Use Firestore.',
    }),
  );
  expect(result).toMatchObject({ status: 200 });
  expect(requestReply).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      task: { repo: 'octo/example', issue: 42 },
      text: 'Use Firestore.',
      channel: 'github',
      principal: 'github:someone',
    }),
  );
});

it('ignores a repo that is not on the allowlist', async () => {
  expect(
    await handleImplicitReplyDelivery(depsNoAllowlist, delivery({})),
  ).toBeUndefined();
});

it('ignores a bot comment', async () => {
  expect(
    await handleImplicitReplyDelivery(deps, delivery({ userType: 'Bot' })),
  ).toBeUndefined();
});

it('ignores a non-member comment', async () => {
  expect(
    await handleImplicitReplyDelivery(
      deps,
      delivery({ author_association: 'CONTRIBUTOR' }),
    ),
  ).toBeUndefined();
});

it('ignores a comment on a task that is not parked', async () => {
  // requestReply itself refuses with task-busy; the route must swallow it
  // as an ordinary ignore, never a 5xx, or GitHub retries the delivery.
  requestReply.mockResolvedValue({
    ok: false,
    code: 'CONFLICT',
    message: 'task-busy',
  });
  expect(await handleImplicitReplyDelivery(deps, delivery({}))).toMatchObject({
    status: 200,
    body: { ignored: 'task-busy' },
  });
});

it('ignores an edited or deleted comment action', async () => {
  expect(
    await handleImplicitReplyDelivery(deps, delivery({ action: 'edited' })),
  ).toBeUndefined();
});
```

- [ ] **Step 3: Run them and watch them fail**

Run: `npx vitest run apps/console/src/lib/implicit-reply.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Write `implicit-reply.ts`**

```ts
import 'server-only';

import { splitEnvList } from '@agent-lcars/env';

import {
  issueCommentEventSchema,
  workPayloadFromGithub,
} from './orchestrator-ingest';
import { requestReply } from './work-reply';

/**
 * The stateful second pass over an `issue_comment` the pure interpreter
 * already declined as `no-reply-command`.
 *
 * It cannot live in `orchestrator-ingest.ts`: deciding "is this anchor
 * parked" needs the store, and that module is deliberately pure. This is
 * the same split `handlePushWebhookDelivery` already uses for `push`.
 *
 * Returns `undefined` when the delivery is not an implicit reply at all,
 * so the caller falls through to its existing ignore-and-refresh path.
 */
export async function handleImplicitReplyDelivery(
  deps: OrchestratorRouteDeps,
  input: { event: string; deliveryId: string; payload: unknown },
): Promise<RouteResult | undefined> {
  if (input.event !== 'issue_comment') return undefined;

  const allowed = new Set(
    splitEnvList('AGENT_LCARS_IMPLICIT_REPLY_REPOS').map((r) =>
      r.toLowerCase(),
    ),
  );
  if (allowed.size === 0) return undefined;

  const parsed = issueCommentEventSchema.safeParse(input.payload);
  if (!parsed.success) return undefined;
  const { action, repository, issue, comment, sender } = parsed.data;
  if (action !== 'created') return undefined;
  if (!allowed.has(repository.full_name.toLowerCase())) return undefined;

  // Identical to the explicit-trigger gate in `interpretIssueCommentEvent`,
  // and load-bearing for loop prevention: the agent's own park comment is
  // authored by a Bot, so it can never answer itself.
  if (
    comment.user?.type === 'Bot' ||
    (comment.author_association !== 'OWNER' &&
      comment.author_association !== 'MEMBER')
  ) {
    return undefined;
  }

  const outcome = await requestReply(deps.workContext, {
    task: { repo: repository.full_name, issue: issue.number },
    text: comment.body,
    channel: 'github',
    principal: `github:${sender.login}`,
    // The comment's own URL: an idempotent request id, so GitHub's own
    // redelivery of this hook maps back to the run it already minted.
    ref: comment.html_url,
    work: workPayloadFromGithub({
      title: issue.title,
      body: issue.body,
      // A reply continues the pipeline the parked run used;
      // `requestReply` resolves that from the latest run itself, so this
      // payload's pipeline is only the backfill default for a legacy task.
      pipeline: deps.defaultPipeline,
      repo: repository.full_name,
      actor: sender.login,
    }),
  });

  if (outcome.ok) {
    return {
      status: 200,
      body: { replied: outcome.runId, resumed: outcome.resumed },
    };
  }
  // Every refusal is an ordinary, expected outcome here -- an unparked
  // anchor, an unknown task, a principal with no grant. Returning 200 with
  // a reason keeps GitHub from retrying a delivery that will never succeed.
  if (outcome.code === 'NOT_FOUND') return undefined;
  return { status: 200, body: { ignored: outcome.message } };
}
```

Resolve `deps.workContext` and `deps.defaultPipeline` against the real `OrchestratorRouteDeps`: if the route deps carry no `WorkContext`, build one the same way `handlePushWebhookDelivery` builds what `mintItem` needs, and use the repository's configured default pipeline (or `'claude'`, the only pipeline every grant in `AGENT_LCARS_WORK_GRANTS` lists today) for the backfill payload only.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run apps/console/src/lib/implicit-reply.test.ts`
Expected: PASS.

- [ ] **Step 6: Wire it into the route**

`apps/console/src/lib/orchestrator-routes.ts`, inside `handleWebhookDelivery`'s `interpreted.kind === 'ignore'` branch, before the projection refresh:

```ts
if (interpreted.kind === 'ignore') {
  // An ordinary comment the pure interpreter declined may still be a
  // maintainer answering a parked agent. Only the store can tell, so
  // that check happens here (plan 2), not in the interpreter.
  if (interpreted.reason === 'no-reply-command') {
    const replied = await handleImplicitReplyDelivery(deps, input);
    if (replied !== undefined) return replied;
  }
  try {
    await refreshGithubAnchorProjection(deps, input);
  } catch (error) {
    /* unchanged */
  }
  return { status: 200, body: { ignored: interpreted.reason } };
}
```

- [ ] **Step 7: Add the route-level test and commit**

In `apps/console/src/lib/orchestrator-routes.test.ts`, add: a `no-reply-command` `issue_comment` delivery in an allow-listed repo reaches the implicit-reply path; the same delivery with the allowlist empty falls through to the existing projection refresh and returns `{ ignored: 'no-reply-command' }` byte-for-byte as today.

Run: `npx vitest run apps/console/src/lib/orchestrator-routes.test.ts apps/console/src/lib/implicit-reply.test.ts`
Expected: PASS.

```bash
git add apps/console/src/lib/implicit-reply.ts apps/console/src/lib/implicit-reply.test.ts apps/console/src/lib/orchestrator-routes.ts apps/console/src/lib/orchestrator-routes.test.ts libs/env-vars/src/env-vars.ts apps/console/apphosting.yaml tools/contract-tests/deploy-console-config.test.ts
git commit -m "feat(console): an ordinary comment on a parked anchor resumes the agent"
```

---

### Task 3: The question reaches the thread

**Files:**

- Modify: `apps/console/src/lib/orchestrator-dispatch.ts` (`outcomeCommentBody`)
- Test: `apps/console/src/lib/orchestrator-dispatch.test.ts`
- Modify: `docs/github-label-contract.md`

- [ ] **Step 1: Write the failing test**

In `orchestrator-dispatch.test.ts`, alongside the existing `outcomeCommentBody` cases:

```ts
it('includes the agent final message on a parked run', () => {
  const body = outcomeCommentBody(
    run({
      state: 'finished',
      result: {
        ok: true,
        summary: 'park',
        message: 'Which database should I use?',
      },
    }),
  );
  expect(body).toContain('Which database should I use?');
  expect(body).toContain('Parked');
});

it('is unchanged for a parked run that reported no message', () => {
  const body = outcomeCommentBody(
    run({ state: 'finished', result: { ok: true, summary: 'park' } }),
  );
  expect(body).toContain("see this run's own comment above");
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run apps/console/src/lib/orchestrator-dispatch.test.ts`
Expected: FAIL — the message is not rendered.

- [ ] **Step 3: Render the message**

In `outcomeCommentBody`'s park branch, prefer the agent's own words and keep the pointer as the fallback:

```ts
if (run.result?.summary === PARK_OUTCOME_SUMMARY) {
  // Prefer the agent's own final message: on an implicitly-replied
  // thread it is the question the maintainer is about to answer, and
  // a plain reply here now resumes the session (plan 2). Fall back to
  // pointing at the agent's own comment when no message was reported.
  lines.push(
    run.result.message === undefined
      ? "Parked -- see this run's own comment above for the blocker " +
          'and how to resume it.'
      : `Parked. ${run.result.message}\n\nReply on this thread to continue.`,
  );
}
```

- [ ] **Step 4: Run the tests, document, commit**

Run: `npx vitest run apps/console/src/lib/orchestrator-dispatch.test.ts`
Expected: PASS.

Add a short section to `docs/github-label-contract.md` stating that in an allow-listed repository, an ordinary `OWNER`/`MEMBER` comment on an anchor whose latest run parked is a reply that resumes the agent's session; that bot comments and non-members never trigger it; and that the explicit `@claude`/`/codex`/`/oc` triggers are unchanged and still work on any anchor.

```bash
git add apps/console/src/lib/orchestrator-dispatch.ts apps/console/src/lib/orchestrator-dispatch.test.ts docs/github-label-contract.md
git commit -m "feat(console): a parked outcome comment carries the agent's question"
```

---

### Task 4: Land, then prove it on the real path

- [ ] **Step 1: Verify, push, land**

Run `npx nx affected -t lint typecheck --base=origin/main`, push, open the PR, arm squash auto-merge, and watch inline until merged, resolving every review thread.

- [ ] **Step 2: Enable the allowlist for this repository**

Set `AGENT_LCARS_IMPLICIT_REPLY_REPOS=jlapenna/agent-lcars` in `apps/console/apphosting.yaml` and let the normal deploy path ship it. **This is a maintainer-gated step** — do not deploy directly; getting the change merged is as far as this goes.

- [ ] **Step 3: The real-path proof (spec proof 2)**

1. File an issue in this repository whose body says: _"Ask me which database to use, then PARK. When I answer, state the database I chose and the codeword from earlier in this conversation, then PARK again."_ Label it `agent:claude`.
2. Confirm r1 parks and that the outcome comment on the thread carries the question.
3. Comment **without any trigger word**: "Use Firestore."
4. Confirm the webhook produced a reply run r2 carrying `resumeSessionId`, that its container ran `runner resume` and `claude --resume`, and that r2's own message names Firestore and recalls the codeword.
5. Negative cases, each confirming no run was minted: a comment from a non-member; a comment while a run is live; a comment on the same thread from the bot itself.
6. Record all of it in `docs/native-work-smoke-runbook.md`.

---

## Self-review

**Spec coverage.** This plan implements the spec's "Surfaces → GitHub issue and PR threads" paragraph in full: the inbound implicit-reply branch with its author gate and flag (Task 2), the outbound question on the thread (Task 3), and the generalization of `requestReply` that the spec's own "one channel-neutral reply primitive" sentence requires (Task 1). Sub-project 5's Slack half and sub-projects 3–4's Codex and OpenCode continuity are deliberately absent.

**Decision 1 taken as an assumption.** The spec left "any maintainer comment resumes, or only trigger words" open. This plan implements the recommended option behind a per-repository allowlist that is empty by default, so merging it changes nothing until a maintainer sets the variable — the reversal is deleting one branch and one variable, and the fallback (explicit triggers only) is what the code already does when the allowlist is empty.

**Deviations from the spec, recorded.**

1. The spec says the implicit branch "sits behind a repository control flag (`docs/ci-control-flags.md` pattern)". That document governs _CI workflow_ flags in `config/github-variables.json`; a console runtime behavior is configured through `apphosting.yaml` and `libs/env-vars`. This plan uses the console's own precedent, `AGENT_LCARS_PUSH_WATCHED_REPOS`, which is additionally per-repository rather than global — strictly safer than the boolean the spec implied.
2. The spec puts the implicit branch "in `interpretIssueCommentEvent`". It cannot go there: that function is pure and stateless (the lcars reference calls this out explicitly), and the parked check needs the store. The branch lives in the route instead, mirroring `handlePushWebhookDelivery`. The observable behavior is what the spec described.
3. The spec's outbound half says the outcome comment includes `result.message` "under `control-plane-projections`". This plan renders it unconditionally, because `outcomeCommentBody` is already the only comment the drain posts for a GitHub anchor regardless of that flag, and a park with no message keeps today's exact text.

**Type consistency.** `ReplyRequest.task` (Task 1) is the field Task 2 constructs. `handleImplicitReplyDelivery`'s `undefined`-means-fall-through contract is used exactly that way at the single call site in Task 2 step 6. `run.result.message` (Task 3) is the field plan 1 added to `runResultSchema`.

**Known soft spots for the executor.** Three shapes are described rather than quoted because they were not read in full while writing this plan: whether `issueCommentEventSchema`/`workPayloadFromGithub` are exported from `orchestrator-ingest.ts` (export them if not; never duplicate them), what `OrchestratorRouteDeps` carries toward a `WorkContext`, and the exact fixture style of `orchestrator-dispatch.test.ts`'s `outcomeCommentBody` cases. Each is named at its step with an instruction; none changes the design.

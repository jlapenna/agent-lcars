# Native Work Items — Plan 1: Orchestrator and Control-Plane Foundation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the orchestrator and the hosted control-plane routes anchor-aware — a task may be a GitHub issue (`{ repo, issue }`, unchanged) or a native work item (`{ workId }`) — with zero behavior change for label-driven work, so Plan 2 (the `items` API) and Plan 3 (the native lane path) can build on it.

**Architecture:** `TaskId` becomes a union discriminated by key presence; `Task` gains an opaque, bounded `work` payload and an orchestrator-owned `closedAt`; a new `closeTask` decision closes an item with no live run; every `task.repo`/`task.issue` read in the console goes through one `anchorTarget` helper; the completion route binds the caller's OIDC token to the run through the dispatch marker and fails closed; telemetry session docs gain the orchestrator run ID (`intentId`) so item → sessions is a query.

**Tech Stack:** TypeScript, zod 4.4.3 (`z.strictObject`, `z.iso.datetime`), Vitest, Firestore (`@google-cloud/firestore` 9.0.0) + Firebase emulator (`firebase-tools`, Firestore port 4002 in `firebase.json`), Next.js App Router route handlers, `jose`, GitHub Actions workflows, Nx.

**Spec:** `docs/superpowers/specs/2026-08-23-native-work-items-design.md` — sections "Data model", "Runs — the existing completion route, generalized", "Auth → Binding a token to its run", "Backend 1", "Sessions", "Testing".

## Global Constraints

- Persisted documents are never migrated: the GitHub anchor stays byte-for-byte `{ repo, issue }`; every new field on `Task` is optional; every schema is `z.strictObject` with bounded strings (spec: "Data model").
- `taskKey()` emits `repo#issue` for GitHub anchors (unchanged) and `work:<ulid>` for native anchors; ULIDs are 26 Crockford-base32 characters (`^[0-9A-HJKMNP-TV-Z]{26}$`).
- The orchestrator never interprets `work`; it stores it (spec: "Invariants").
- Only the fallback finalizer's OIDC token may call the completion route — `job_workflow_ref` stays pinned to `agent-fallback-finalize.yml` (spec: "Runs"). Nothing in this plan accepts a token minted inside the agent job.
- Marker binding fails **closed**: a GitHub error on the binding lookup is `503`, never a settle (spec: "Auth → Binding").
- No real git in unit tests; no Firestore access from unit tests except through the emulator-backed store contract.
- Every task: work in the feature worktree, run the task's tests, commit with a conventional message. Push early; CI's `Verify` job is the full gate (`pnpm verify` locally only when there is a reason not to trust CI).
- Commit trailer on every commit: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## File Structure

| File                                                                                                         | Responsibility                                                                                                             |
| ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `libs/orchestrator/src/model.ts` (modify)                                                                    | Anchor union, `WORK_ID_RE`, `isGithubAnchor`/`isWorkAnchor`, `workPayloadSchema`, `Task.work`, `Task.closedAt`             |
| `libs/orchestrator/src/decide.ts` (modify)                                                                   | `RequestRunInput.work`, `task-closed`/`unknown-task` refusals, `closeTask` decision, `Decision.run` optional               |
| `libs/orchestrator/src/orchestrator.ts` (modify)                                                             | `RequestInput.work`, `Orchestrator.close(taskId)`                                                                          |
| `libs/orchestrator/src/firestore-store.ts`, `memory-store.ts` (modify)                                       | Anchor-aware `listRuns`; `apply` tolerates a run-less decision                                                             |
| `libs/orchestrator/src/store-contract.ts` (modify)                                                           | Contract cases for work anchors, `work`/`closedAt` round trip, run-less apply                                              |
| `libs/orchestrator/src/index.ts` (modify)                                                                    | Export the new names                                                                                                       |
| `libs/orchestrator/project.json` (modify), `.github/workflows/ci.yml` (modify)                               | `test-firestore` target running the store contract against the emulator, wired into `Verify`                               |
| `libs/orchestrator/README.md` (modify)                                                                       | Document anchors, `work`, `closeTask`                                                                                      |
| `apps/console/src/lib/anchor-target.ts` (create)                                                             | `anchorTarget(run, task?)`: the only place the console reads an anchor's repository/issue                                  |
| `apps/console/src/lib/orchestrator-dispatch.ts` (modify)                                                     | Dispatch inputs and outcome comments via `anchorTarget`; native anchors dispatch a `work` input and post nothing to GitHub |
| `apps/console/src/lib/orchestrator-terminal-runs.ts` (modify)                                                | Group live runs by `anchorTarget(run).repo`                                                                                |
| `apps/console/src/lib/orchestrator-routes.ts` (modify)                                                       | `handleCompletion` takes the verified identity, binds it to the run via the dispatch marker, fails closed                  |
| `apps/console/src/lib/run-binding.ts` (create)                                                               | `bindCompletionToRun`: fetch the Actions run named by the token, compare its marker to the run ID                          |
| `apps/console/src/app/api/control-plane/completion/route.ts` (modify)                                        | Pass the verified identity into `handleCompletion`; map `binding-unavailable` to `503`                                     |
| `apps/console/src/lib/control-plane-request.ts` (modify)                                                     | `issue` optional on the completion body (required only for GitHub anchors)                                                 |
| `.github/workflows/agent-fallback-finalize.yml` (modify)                                                     | Retry the completion POST on `503` with backoff                                                                            |
| `libs/telemetry/src/lib/types.ts`, `session-doc.ts` (modify)                                                 | `intentId` on issue-agent session docs                                                                                     |
| `apps/telemetry-watcher/src/lib/runner-config.ts`, `runner.ts` (modify), `bin/sidecar-lifecycle.sh` (modify) | `--intent-id` flag plumbed from `INTENT_ID`                                                                                |
| `.github/workflows/agent-lane.yml` (modify)                                                                  | `INTENT_ID: ${{ inputs.broker_intent_id }}` on the sidecar start and finalize steps                                        |
| `libs/dispatch-contracts/src/marker.spec.ts` (modify)                                                        | Pin that the existing marker grammar accepts `work:<ulid>/r<n>`                                                            |

Line numbers below are from `main` at `ac6e639`; re-locate by the quoted code if they have drifted.

---

### Task 1: Anchor union in `model.ts`

**Files:**

- Modify: `libs/orchestrator/src/model.ts:25-34`
- Modify: `libs/orchestrator/src/index.ts`
- Test: `libs/orchestrator/src/model.spec.ts` (create)

**Interfaces:**

- Consumes: nothing new.
- Produces:
  - `export const WORK_ID_RE: RegExp` — `/^[0-9A-HJKMNP-TV-Z]{26}$/u`
  - `export const githubAnchorSchema` (the existing `{ repo, issue }` strict object, unchanged)
  - `export const workAnchorSchema` — `z.strictObject({ workId: z.string().regex(WORK_ID_RE) })`
  - `export const taskIdSchema = z.union([githubAnchorSchema, workAnchorSchema])`
  - `export type GithubAnchor`, `export type WorkAnchor`, `export type TaskId = GithubAnchor | WorkAnchor`
  - `export function isGithubAnchor(id: TaskId): id is GithubAnchor`
  - `export function isWorkAnchor(id: TaskId): id is WorkAnchor`
  - `export function taskKey(id: TaskId): string` — `repo#issue` or `work:<workId>`

- [ ] **Step 1: Write the failing test**

```ts
// libs/orchestrator/src/model.spec.ts
import { describe, expect, it } from 'vitest';

import {
  isGithubAnchor,
  isWorkAnchor,
  taskIdSchema,
  taskKey,
  taskSchema,
  runSchema,
  outboxEntrySchema,
  WORK_ID_RE,
} from './model';

const ULID = '01J5Z3K9QX8F0N2B4V6C8D1E3G';

describe('taskIdSchema', () => {
  it('keeps the GitHub anchor shape byte-for-byte', () => {
    const parsed = taskIdSchema.parse({ repo: 'octo/example', issue: 7 });
    expect(parsed).toEqual({ repo: 'octo/example', issue: 7 });
    expect(isGithubAnchor(parsed)).toBe(true);
    expect(isWorkAnchor(parsed)).toBe(false);
  });

  it('accepts a native anchor keyed by workId', () => {
    const parsed = taskIdSchema.parse({ workId: ULID });
    expect(parsed).toEqual({ workId: ULID });
    expect(isWorkAnchor(parsed)).toBe(true);
    expect(isGithubAnchor(parsed)).toBe(false);
  });

  it('rejects an anchor that mixes both shapes', () => {
    expect(() =>
      taskIdSchema.parse({ repo: 'octo/example', issue: 7, workId: ULID }),
    ).toThrow();
  });

  it('rejects a workId that is not a ULID', () => {
    expect(WORK_ID_RE.test('not-a-ulid')).toBe(false);
    expect(() => taskIdSchema.parse({ workId: 'not-a-ulid' })).toThrow();
    // I, L, O, U are excluded from Crockford base32.
    expect(() =>
      taskIdSchema.parse({ workId: '01J5Z3K9QX8F0N2B4V6C8D1E3I' }),
    ).toThrow();
  });
});

describe('taskKey', () => {
  it('is unchanged for GitHub anchors', () => {
    expect(taskKey({ repo: 'octo/example', issue: 7 })).toBe('octo/example#7');
  });

  it('prefixes native anchors with work:', () => {
    expect(taskKey({ workId: ULID })).toBe(`work:${ULID}`);
  });
});

describe('persisted-shape fixtures', () => {
  // Documents exactly as FirestoreStore wrote them before this change.
  // Every one must still parse; this is the zero-migration guarantee.
  const T = '2026-08-15T12:00:00.000Z';

  it('parses a legacy task document', () => {
    expect(() =>
      taskSchema.parse({
        task: { repo: 'octo/example', issue: 7 },
        activeRunId: 'octo/example#7/r1',
        runCount: 1,
        consecutiveLost: 0,
        updatedAt: T,
      }),
    ).not.toThrow();
  });

  it('parses a legacy run document', () => {
    expect(() =>
      runSchema.parse({
        runId: 'octo/example#7/r1',
        task: { repo: 'octo/example', issue: 7 },
        state: 'running',
        pipeline: 'claude',
        requestId: 'delivery-1',
        params: { mode: 'implement' },
        leaseExpiresAt: T,
        events: [{ at: T, to: 'pending', by: 'request' }],
        createdAt: T,
        updatedAt: T,
      }),
    ).not.toThrow();
  });

  it('parses a legacy outbox document', () => {
    expect(() =>
      outboxEntrySchema.parse({
        entryId: 'dispatch/octo/example#7/r1',
        kind: 'dispatch-run',
        task: { repo: 'octo/example', issue: 7 },
        runId: 'octo/example#7/r1',
        state: 'pending',
        attempts: 0,
        createdAt: T,
        updatedAt: T,
      }),
    ).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `./tools/nx test @agent-lcars/orchestrator -- model.spec.ts`
Expected: FAIL — `isGithubAnchor`, `isWorkAnchor`, `WORK_ID_RE` are not exported; the `{ workId }` parse throws.

- [ ] **Step 3: Implement the anchor union**

Replace lines 25–34 of `libs/orchestrator/src/model.ts` (the `taskIdSchema`/`TaskId`/`taskKey` block) with:

```ts
/**
 * A task is identified by where the work lives. Two anchors exist:
 *
 * - a GitHub issue or pull request, `{ repo, issue }` -- the shape every
 *   persisted document already carries, kept byte-for-byte;
 * - a native work item, `{ workId }`, a ULID minted by the caller.
 *
 * The variants are discriminated by which key is present, never by a new
 * required field: `FirestoreStore` zod-parses every persisted Task, Run,
 * and OutboxEntry on read, so a variant requiring a field legacy documents
 * lack would reject the whole existing dataset.
 */
export const githubAnchorSchema = z.strictObject({
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/u),
  issue: z.number().int().positive(),
});
export type GithubAnchor = z.infer<typeof githubAnchorSchema>;

/** Crockford base32, 26 characters: a ULID. Excludes I, L, O, U. */
export const WORK_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/u;

export const workAnchorSchema = z.strictObject({
  workId: z.string().regex(WORK_ID_RE),
});
export type WorkAnchor = z.infer<typeof workAnchorSchema>;

export const taskIdSchema = z.union([githubAnchorSchema, workAnchorSchema]);
export type TaskId = z.infer<typeof taskIdSchema>;

export function isGithubAnchor(id: TaskId): id is GithubAnchor {
  return 'repo' in id;
}

export function isWorkAnchor(id: TaskId): id is WorkAnchor {
  return 'workId' in id;
}

/**
 * `repo#issue` for GitHub anchors (unchanged) and `work:<ulid>` for native
 * ones. `:` is outside the repo-name charset, so the two can never collide
 * as Firestore document ids.
 */
export function taskKey(id: TaskId): string {
  return isWorkAnchor(id) ? `work:${id.workId}` : `${id.repo}#${id.issue}`;
}
```

Then in `libs/orchestrator/src/index.ts` add the new names to the `model` export list (`githubAnchorSchema`, `workAnchorSchema`, `WORK_ID_RE`, `isGithubAnchor`, `isWorkAnchor`, `GithubAnchor`, `WorkAnchor`). Open the file and extend whatever `export { ... } from './model'` / `export type { ... }` lines exist — keep the existing style.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `./tools/nx test @agent-lcars/orchestrator`
Expected: PASS, including the pre-existing `orchestrator.spec.ts` and `store-contract.spec.ts` — nothing else in the lib reads `id.repo` except `firestore-store.ts:98-99`, which Task 4 changes; until then TypeScript narrows nothing there, so run `./tools/nx typecheck @agent-lcars/orchestrator` and expect exactly two errors at `firestore-store.ts:98-99` (`Property 'repo' does not exist on type ...`). Those are fixed in Task 4; do not silence them.

- [ ] **Step 5: Commit**

```bash
git add libs/orchestrator/src/model.ts libs/orchestrator/src/model.spec.ts libs/orchestrator/src/index.ts
git commit -m "feat(orchestrator): anchor union with native work ids

TaskId is now { repo, issue } | { workId }, discriminated by key presence
so every persisted document still parses. taskKey emits work:<ulid> for
the native variant.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: `work` payload and `closedAt` on `Task`; `requestRun` creates a task with `work`

**Files:**

- Modify: `libs/orchestrator/src/model.ts` (the `taskSchema` block, after `consecutiveLost`)
- Modify: `libs/orchestrator/src/decide.ts:27-37` (Refusal reasons), `:62-70` (`RequestRunInput`), `:79-108` (`requestRun`)
- Modify: `libs/orchestrator/src/orchestrator.ts:63-88` (`RequestInput`, `request`)
- Test: `libs/orchestrator/src/model.spec.ts`, `libs/orchestrator/src/orchestrator.spec.ts`

**Interfaces:**

- Consumes: Task 1's `WorkAnchor`, `isWorkAnchor`.
- Produces:
  - `export const workPayloadSchema` — `z.record(z.string().max(64), z.unknown())` refined so `JSON.stringify(value).length <= 32_768`; `export type WorkPayload`
  - `Task.work?: WorkPayload`, `Task.closedAt?: string` (ISO UTC)
  - `RequestRunInput.work?: WorkPayload`, `RequestInput.work?: WorkPayload` — written only when the request creates the task
  - New `Refusal['reason']` values: `'task-closed'`, `'unknown-task'`

- [ ] **Step 1: Write the failing tests**

Append to `libs/orchestrator/src/model.spec.ts`:

```ts
describe('taskSchema work payload', () => {
  const T = '2026-08-15T12:00:00.000Z';
  const base = { task: { workId: ULID }, runCount: 0, updatedAt: T };

  it('stores an opaque bounded work payload and closedAt', () => {
    const parsed = taskSchema.parse({
      ...base,
      work: { origin: { principal: 'user:jlapenna' }, spec: { title: 'x' } },
      closedAt: T,
    });
    expect(parsed.work).toEqual({
      origin: { principal: 'user:jlapenna' },
      spec: { title: 'x' },
    });
    expect(parsed.closedAt).toBe(T);
  });

  it('rejects a work payload over 32 KiB serialized', () => {
    expect(() =>
      taskSchema.parse({ ...base, work: { blob: 'x'.repeat(33_000) } }),
    ).toThrow();
  });
});
```

Append to `libs/orchestrator/src/orchestrator.spec.ts` (reuse its `fixture()`; add `const WORK: TaskId = { workId: '01J5Z3K9QX8F0N2B4V6C8D1E3G' };` next to `TASK`):

```ts
describe('native anchors', () => {
  it('creates the task with its work payload on first request', async () => {
    const { orchestrator, store } = fixture();
    const work = {
      origin: { principal: 'user:jlapenna' },
      spec: { title: 'x' },
    };
    const outcome = await orchestrator.request({
      taskId: WORK,
      requestId: WORK.workId,
      pipeline: 'claude',
      work,
    });
    expect(isRefusal(outcome)).toBe(false);
    const stored = await store.readTask(WORK);
    expect(stored?.task.work).toEqual(work);
    expect(stored?.task.activeRunId).toBe(`work:${WORK.workId}/r1`);
  });

  it('does not overwrite work on a later request for the same task', async () => {
    const { orchestrator, store } = fixture();
    await orchestrator.request({
      taskId: WORK,
      requestId: 'r1',
      pipeline: 'claude',
      work: { spec: { title: 'first' } },
    });
    const first = await orchestrator.request({
      taskId: WORK,
      requestId: 'r1',
      pipeline: 'claude',
    });
    if (isRefusal(first)) throw new Error(first.reason);
    await orchestrator.report(`work:${WORK.workId}/r1`, { ok: false });
    await orchestrator.request({
      taskId: WORK,
      requestId: 'r2',
      pipeline: 'claude',
      work: { spec: { title: 'second' } },
    });
    const stored = await store.readTask(WORK);
    expect(stored?.task.work).toEqual({ spec: { title: 'first' } });
    expect(stored?.task.activeRunId).toBe(`work:${WORK.workId}/r2`);
  });

  it('refuses a request on a closed task', async () => {
    const { orchestrator } = fixture();
    await orchestrator.request({
      taskId: WORK,
      requestId: 'r1',
      pipeline: 'claude',
      work: {},
    });
    await orchestrator.report(`work:${WORK.workId}/r1`, { ok: false });
    const closed = await orchestrator.close(WORK);
    expect(isRefusal(closed)).toBe(false);
    const again = await orchestrator.request({
      taskId: WORK,
      requestId: 'r2',
      pipeline: 'claude',
    });
    expect(again).toMatchObject({ refused: true, reason: 'task-closed' });
  });
});
```

(The `close` call is implemented in Task 3; this test fails until then — that is expected and listed in Task 3's Step 2.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `./tools/nx test @agent-lcars/orchestrator -- model.spec.ts orchestrator.spec.ts`
Expected: FAIL — `taskSchema` rejects `work`/`closedAt` (strict object); `request` has no `work`; `close` does not exist.

- [ ] **Step 3: Implement**

In `libs/orchestrator/src/model.ts`, add above `taskSchema`:

```ts
/**
 * A native work item's payload -- who asked and what for. The orchestrator
 * stores it and never interprets it, exactly as it treats `Run.params`;
 * `libs/work` owns the shape. Bounded so a runaway caller cannot bloat the
 * task document towards Firestore's 1 MiB limit.
 */
export const WORK_PAYLOAD_MAX_BYTES = 32_768;

export const workPayloadSchema = z
  .record(z.string().max(64), z.unknown())
  .refine((value) => JSON.stringify(value).length <= WORK_PAYLOAD_MAX_BYTES, {
    message: `work payload exceeds ${WORK_PAYLOAD_MAX_BYTES} bytes`,
  });
export type WorkPayload = z.infer<typeof workPayloadSchema>;
```

In `taskSchema`, after `consecutiveLost`, add:

```ts
  /** Native anchors only: the work item's payload, written once when the
   *  task is created by its first request and never modified by the
   *  orchestrator. Absent on GitHub-anchored tasks. */
  work: workPayloadSchema.optional(),
  /** Native anchors only: set by `closeTask` when an operator closes an
   *  item that has no live run. A closed task refuses further requests. */
  closedAt: isoUtc.optional(),
```

In `libs/orchestrator/src/decide.ts`:

1. Extend the `Refusal['reason']` union with two members:

```ts
    | 'task-closed' // closeTask set closedAt; no further runs
    | 'unknown-task'; // close on a task that was never created
```

2. Add `work?: WorkPayload;` to `RequestRunInput` (import `WorkPayload` from `./model`).
3. In `requestRun`, after the busy checks, refuse a closed task and carry `work` into the base task:

```ts
if (input.task?.closedAt !== undefined) {
  return refused('task-closed');
}
const baseTask: Task = {
  task: taskId,
  runCount: input.task?.runCount ?? 0,
  ...(input.task?.consecutiveLost === undefined
    ? {}
    : { consecutiveLost: input.task.consecutiveLost }),
  // Written once: only the request that creates the task may set `work`.
  ...(input.task?.work !== undefined
    ? { work: input.task.work }
    : input.work !== undefined
      ? { work: input.work }
      : {}),
  updatedAt: now,
};
```

In `libs/orchestrator/src/orchestrator.ts`, add `work?: WorkPayload;` to `RequestInput` and pass it through in `request`:

```ts
        ...(input.work === undefined ? {} : { work: input.work }),
```

Export `workPayloadSchema`, `WorkPayload`, `WORK_PAYLOAD_MAX_BYTES` from `index.ts`.

- [ ] **Step 4: Run the tests**

Run: `./tools/nx test @agent-lcars/orchestrator -- model.spec.ts orchestrator.spec.ts`
Expected: `model.spec.ts` PASS; in `orchestrator.spec.ts` the first two native-anchor tests PASS and only "refuses a request on a closed task" FAILS with `orchestrator.close is not a function`.

- [ ] **Step 5: Commit**

```bash
git add libs/orchestrator/src
git commit -m "feat(orchestrator): opaque work payload and closedAt on Task

requestRun writes work once, when the request creates the task, and
refuses a closed task with task-closed.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: `closeTask` decision and `Orchestrator.close`

**Files:**

- Modify: `libs/orchestrator/src/decide.ts:21-25` (`Decision`), append `closeTask`
- Modify: `libs/orchestrator/src/orchestrator.ts` (add `close`)
- Modify: `libs/orchestrator/src/memory-store.ts:43-60` (`apply`), `libs/orchestrator/src/firestore-store.ts:104-131` (`apply`)
- Modify: `libs/orchestrator/src/store-contract.ts` (run-less apply case)
- Test: `libs/orchestrator/src/orchestrator.spec.ts`, `libs/orchestrator/src/store-contract.spec.ts` (via the contract)

**Interfaces:**

- Consumes: Task 2's `closedAt`, `task-closed`, `unknown-task`.
- Produces:
  - `Decision.run?: Run` — a decision may carry no run (`closeTask` produces none); stores skip the run write when absent
  - `export function closeTask(input: { now: string; task: Task | undefined; activeRun: Run | undefined }): Decision | Refusal`
  - `Orchestrator.close(taskId: TaskId): Promise<Decision | Refusal>`

- [ ] **Step 1: Write the failing tests**

Append to `libs/orchestrator/src/orchestrator.spec.ts`:

```ts
describe('close', () => {
  it('refuses while a run is live', async () => {
    const { orchestrator } = fixture();
    await orchestrator.request({
      taskId: WORK,
      requestId: 'r1',
      pipeline: 'claude',
      work: {},
    });
    expect(await orchestrator.close(WORK)).toMatchObject({
      refused: true,
      reason: 'task-busy',
    });
  });

  it('sets closedAt once no run is live and is idempotent', async () => {
    const { orchestrator, store } = fixture();
    await orchestrator.request({
      taskId: WORK,
      requestId: 'r1',
      pipeline: 'claude',
      work: {},
    });
    await orchestrator.report(`work:${WORK.workId}/r1`, { ok: false });
    const first = await orchestrator.close(WORK);
    expect(isRefusal(first)).toBe(false);
    expect((await store.readTask(WORK))?.task.closedAt).toBe(T0);
    expect(await orchestrator.close(WORK)).toMatchObject({
      refused: true,
      reason: 'task-closed',
    });
  });

  it('refuses a task that was never created', async () => {
    const { orchestrator } = fixture();
    expect(await orchestrator.close(WORK)).toMatchObject({
      refused: true,
      reason: 'unknown-task',
    });
  });
});
```

In `libs/orchestrator/src/store-contract.ts`, inside `runOrchestratorStoreContract`'s `describe`, add a case (follow the file's existing helper style for building a `Decision`; it already constructs tasks/runs inline):

```ts
it('applies a decision that carries no run (closeTask)', async () => {
  const store = create();
  const id: TaskId = { workId: '01J5Z3K9QX8F0N2B4V6C8D1E3G' };
  const now = '2026-08-15T12:00:00.000Z';
  await store.apply({
    decision: {
      task: { task: id, runCount: 0, closedAt: now, updatedAt: now },
      outbox: [],
    },
    expectedRevision: undefined,
  });
  const read = await store.readTask(id);
  expect(read?.task.closedAt).toBe(now);
  expect(await store.listRuns(id)).toEqual([]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `./tools/nx test @agent-lcars/orchestrator`
Expected: FAIL — `close` undefined; the contract case fails to type-check because `Decision.run` is required.

- [ ] **Step 3: Implement**

`libs/orchestrator/src/decide.ts` — make the run optional and add the decision:

```ts
export interface Decision {
  readonly task: Task;
  /** Absent only for decisions that touch the task alone (`closeTask`). */
  readonly run?: Run;
  readonly outbox: readonly OutboxEntry[];
}
```

Append:

```ts
/**
 * Close a native task that has no live run: sets `closedAt`, after which
 * `requestRun` refuses it. The one piece of item state the orchestrator
 * stores on behalf of the work layer, kept here so it lives in the same
 * transaction discipline as everything else that touches a task.
 */
export function closeTask(input: {
  now: string;
  task: Task | undefined;
  activeRun: Run | undefined;
}): Decision | Refusal {
  const { now, task, activeRun } = input;
  if (task === undefined) return refused('unknown-task');
  if (task.closedAt !== undefined) return refused('task-closed');
  if (activeRun !== undefined && isLive(activeRun.state)) {
    return refused('task-busy', activeRun);
  }
  return { task: { ...task, closedAt: now, updatedAt: now }, outbox: [] };
}
```

`libs/orchestrator/src/orchestrator.ts` — add next to `cancel`:

```ts
  async close(taskId: TaskId): Promise<Decision | Refusal> {
    return this.transact(taskId, async (task, activeRun) =>
      closeTask({ now: this.clock.now(), task: task?.task, activeRun }),
    );
  }
```

(import `closeTask` from `./decide`; `transact` already reads the versioned task and active run — check its signature at the top of the class and match it.)

`libs/orchestrator/src/memory-store.ts` `apply` — where it writes `decision.run` into `#runs`, guard it:

```ts
if (decision.run !== undefined) {
  this.#runs.set(decision.run.runId, structuredClone(decision.run));
}
```

`libs/orchestrator/src/firestore-store.ts` `apply` — replace `tx.set(this.#runRef(decision.run.runId), decision.run);` with:

```ts
if (decision.run !== undefined) {
  tx.set(this.#runRef(decision.run.runId), decision.run);
}
```

Then fix every consumer that reads `decision.run` unconditionally: run `./tools/nx typecheck @agent-lcars/orchestrator @agent-lcars/console` and, at each error, narrow (`if (outcome.run === undefined) throw new Error('decision without run')` is wrong — instead branch on the decision kind: `request`/`confirmDispatch`/`renew`/`report`/`cancel` always produce a run, so at those call sites assert with a small helper added to `decide.ts`:

```ts
/** For decisions that always carry a run; throws if the invariant breaks. */
export function decidedRun(decision: Decision): Run {
  if (decision.run === undefined) {
    throw new Error('decision unexpectedly carries no run');
  }
  return decision.run;
}
```

and use `decidedRun(outcome)` where `outcome.run` was read). Export `closeTask` and `decidedRun` from `index.ts`.

- [ ] **Step 4: Run the tests**

Run: `./tools/nx test @agent-lcars/orchestrator && ./tools/nx typecheck @agent-lcars/orchestrator @agent-lcars/console`
Expected: PASS; typecheck clean except the two `firestore-store.ts:98-99` errors from Task 1 (fixed next).

- [ ] **Step 5: Commit**

```bash
git add libs/orchestrator/src apps/console/src
git commit -m "feat(orchestrator): closeTask decision and Orchestrator.close

A decision may now carry no run; both stores skip the run write when it
is absent. close refuses task-busy, task-closed, unknown-task.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Anchor-aware `listRuns` and the emulator-backed store contract in CI

**Files:**

- Modify: `libs/orchestrator/src/firestore-store.ts:92-102`
- Modify: `libs/orchestrator/src/store-contract.ts` (work-anchor cases)
- Modify: `libs/orchestrator/project.json` (add `test-firestore` target)
- Modify: `.github/workflows/ci.yml` (`Verify` job: run the target)

**Interfaces:**

- Consumes: Task 1's `isWorkAnchor`.
- Produces: `FirestoreStore.listRuns` works for both anchors; CI runs the Firestore half of the contract.

- [ ] **Step 1: Write the failing contract cases**

In `libs/orchestrator/src/store-contract.ts` add, following the existing cases' style:

```ts
it('lists runs for a native anchor and keeps anchors apart', async () => {
  const store = create();
  const orchestrator = new Orchestrator(store, {
    now: () => '2026-08-15T12:00:00.000Z',
  });
  const work: TaskId = { workId: '01J5Z3K9QX8F0N2B4V6C8D1E3G' };
  const issue: TaskId = { repo: 'octo/example', issue: 7 };
  await orchestrator.request({
    taskId: work,
    requestId: 'w1',
    pipeline: 'claude',
    work: {},
  });
  await orchestrator.request({
    taskId: issue,
    requestId: 'i1',
    pipeline: 'claude',
  });
  expect((await store.listRuns(work)).map((r) => r.runId)).toEqual([
    'work:01J5Z3K9QX8F0N2B4V6C8D1E3G/r1',
  ]);
  expect((await store.listRuns(issue)).map((r) => r.runId)).toEqual([
    'octo/example#7/r1',
  ]);
});

it('round-trips work and closedAt on a native task', async () => {
  const store = create();
  const orchestrator = new Orchestrator(store, {
    now: () => '2026-08-15T12:00:00.000Z',
  });
  const work: TaskId = { workId: '01J5Z3K9QX8F0N2B4V6C8D1E3H' };
  await orchestrator.request({
    taskId: work,
    requestId: 'w1',
    pipeline: 'claude',
    work: { origin: { principal: 'user:jlapenna' } },
  });
  await orchestrator.report('work:01J5Z3K9QX8F0N2B4V6C8D1E3H/r1', {
    ok: false,
  });
  await orchestrator.close(work);
  const read = await store.readTask(work);
  expect(read?.task.work).toEqual({ origin: { principal: 'user:jlapenna' } });
  expect(read?.task.closedAt).toBe('2026-08-15T12:00:00.000Z');
});
```

(`store-contract.ts` already imports `Orchestrator`? If not, import it from `./orchestrator` — check the file's imports; it constructs decisions through the orchestrator in several existing cases.)

- [ ] **Step 2: Run against both stores and verify the Firestore half fails**

Run (memory only): `./tools/nx test @agent-lcars/orchestrator -- store-contract.spec.ts`
Expected: memory cases PASS (it keys by `taskKey`); Firestore block skipped.

Run (emulator): `pnpm exec firebase emulators:exec --only firestore --project=demo-no-project "FIRESTORE_EMULATOR_HOST=localhost:4002 ./tools/nx test @agent-lcars/orchestrator --skip-nx-cache -- store-contract.spec.ts"`
Expected: FAIL in `FirestoreStore (emulator)` → "lists runs for a native anchor" with `Value for argument "value" is not a valid query constraint. Cannot use "undefined" as a Firestore value`.

- [ ] **Step 3: Implement the anchor-aware query**

Replace `listRuns` in `libs/orchestrator/src/firestore-store.ts`:

```ts
  async listRuns(id: TaskId): Promise<Run[]> {
    // Equality-only filters on single fields: served from Firestore's
    // automatic indexes without a composite index, for either anchor.
    const query = isWorkAnchor(id)
      ? this.#runs.where('task.workId', '==', id.workId)
      : this.#runs
          .where('task.repo', '==', id.repo)
          .where('task.issue', '==', id.issue);
    const snapshot = await query.get();
    return snapshot.docs.map((doc) => runSchema.parse(doc.data()));
  }
```

(import `isWorkAnchor` from `./model`.)

- [ ] **Step 4: Add the `test-firestore` target and the CI step**

In `libs/orchestrator/project.json` add a `targets` block (the project currently has none — Nx infers `test`/`typecheck`/`lint`/`build`; adding an explicit target alongside inferred ones is supported):

```json
{
  "name": "@agent-lcars/orchestrator",
  "$schema": "../../node_modules/nx/schemas/project-schema.json",
  "sourceRoot": "libs/orchestrator/src",
  "projectType": "library",
  "tags": ["platform:shared", "scope:shared"],
  "targets": {
    "test-firestore": {
      "executor": "nx:run-commands",
      "cache": false,
      "options": {
        "cwd": "{workspaceRoot}",
        "command": "pnpm exec firebase emulators:exec --only firestore --project=demo-no-project \"FIRESTORE_EMULATOR_HOST=localhost:4002 ./tools/nx test @agent-lcars/orchestrator --skip-nx-cache -- store-contract.spec.ts\""
      }
    }
  }
}
```

In `.github/workflows/ci.yml`, in the `Verify` job (the one that runs `pnpm verify`; find the step named `Verify` or the `pnpm verify` run line), add immediately after it:

```yaml
- name: Store contract against the Firestore emulator
  # The emulator needs a JDK; the trusted JIT image bakes 21, the
  # GitHub-hosted fallback gets it from setup-java below.
  uses: actions/setup-java@v4
  with:
    distribution: temurin
    java-version: '21'
- run: ./tools/nx run @agent-lcars/orchestrator:test-firestore
```

If the `Verify` job already contains a `setup-java` step (the E2E job does at `ci.yml:~480`; `Verify` may not), reuse it rather than adding a second one. Confirm with `grep -n "setup-java" .github/workflows/ci.yml`.

- [ ] **Step 5: Run everything**

Run: `./tools/nx run @agent-lcars/orchestrator:test-firestore && ./tools/nx test @agent-lcars/orchestrator && ./tools/nx typecheck @agent-lcars/orchestrator`
Expected: PASS, and the Task 1 typecheck errors are gone.

- [ ] **Step 6: Commit and push (the CI change is only proven by CI)**

```bash
git add libs/orchestrator .github/workflows/ci.yml
git commit -m "feat(orchestrator): anchor-aware listRuns; store contract on the emulator in CI

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git push -u origin HEAD
```

Open the PR now (`gh pr create --reviewer jlapenna --fill`) so `Verify` runs the new step while later tasks continue; the plan's remaining tasks land on the same branch.

---

### Task 5: `anchorTarget` in the console and every anchor dereference

**Files:**

- Create: `apps/console/src/lib/anchor-target.ts`
- Test: `apps/console/src/lib/anchor-target.test.ts` (create)
- Modify: `apps/console/src/lib/orchestrator-dispatch.ts:133-150, 199-207, 318-327`
- Modify: `apps/console/src/lib/orchestrator-terminal-runs.ts:200-214`
- Modify: `apps/console/src/lib/orchestrator-routes.ts:246-256`
- Test: `apps/console/src/lib/orchestrator-dispatch.test.ts`, `orchestrator-terminal-runs.test.ts`

**Interfaces:**

- Consumes: `isWorkAnchor`, `isGithubAnchor`, `Task`, `Run` from `@agent-lcars/orchestrator`.
- Produces:

  ```ts
  export interface AnchorTarget { repo: string; issue?: number }
  export function anchorTarget(run: Pick<Run, 'task'>, task?: Pick<Task, 'work'>): AnchorTarget
  export class UnresolvableAnchor extends Error
  ```

  For a GitHub anchor: `{ repo, issue }`. For a native anchor: `{ repo }` read from `task.work.spec.target.repo` (validated with a local `z.object({ spec: z.object({ target: z.object({ repo }) }) })` pick — the console does not import `libs/work`, which does not exist until Plan 2); throws `UnresolvableAnchor` when the payload lacks it.

- [ ] **Step 1: Write the failing test**

```ts
// apps/console/src/lib/anchor-target.test.ts
import { describe, expect, it } from 'vitest';

import { anchorTarget, UnresolvableAnchor } from './anchor-target';

const WORK = { workId: '01J5Z3K9QX8F0N2B4V6C8D1E3G' };

describe('anchorTarget', () => {
  it('reads repo and issue off a GitHub anchor', () => {
    expect(anchorTarget({ task: { repo: 'octo/example', issue: 7 } })).toEqual({
      repo: 'octo/example',
      issue: 7,
    });
  });

  it('reads the target repo off a native task payload', () => {
    expect(
      anchorTarget(
        { task: WORK },
        { work: { spec: { target: { repo: 'octo/example' } } } },
      ),
    ).toEqual({ repo: 'octo/example' });
  });

  it('throws when a native task carries no target repo', () => {
    expect(() => anchorTarget({ task: WORK }, { work: {} })).toThrow(
      UnresolvableAnchor,
    );
    expect(() => anchorTarget({ task: WORK })).toThrow(UnresolvableAnchor);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `./tools/nx test @agent-lcars/console -- anchor-target`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// apps/console/src/lib/anchor-target.ts
import 'server-only';

import { isWorkAnchor, type Run, type Task } from '@agent-lcars/orchestrator';
import { z } from 'zod';

export interface AnchorTarget {
  repo: string;
  /** Present for GitHub anchors only. */
  issue?: number;
}

export class UnresolvableAnchor extends Error {
  override readonly name = 'UnresolvableAnchor';
}

/** The slice of a native task's opaque `work` payload the console needs.
 *  `libs/work` (Plan 2) owns the full shape; this pick is deliberately
 *  loose about everything else. */
const targetPick = z.object({
  spec: z.object({ target: z.object({ repo: z.string().min(1) }) }),
});

/**
 * The one place the console turns an anchor into a repository (and, for
 * GitHub anchors, an issue). Every `run.task.repo` / `run.task.issue` read
 * goes through here so a native anchor cannot reach a GitHub URL builder
 * with `undefined` in it.
 */
export function anchorTarget(
  run: Pick<Run, 'task'>,
  task?: Pick<Task, 'work'>,
): AnchorTarget {
  if (!isWorkAnchor(run.task)) {
    return { repo: run.task.repo, issue: run.task.issue };
  }
  const parsed = targetPick.safeParse(task?.work);
  if (!parsed.success) {
    throw new UnresolvableAnchor(
      `native task work:${run.task.workId} has no spec.target.repo`,
    );
  }
  return { repo: parsed.data.spec.target.repo };
}
```

- [ ] **Step 4: Route every dereference through it**

`apps/console/src/lib/orchestrator-dispatch.ts`:

1. `handleDispatchRun` (lines 133–150): read the task once (`const task = (await store.readTask(run.task))?.task;`), then

```ts
let target: AnchorTarget;
try {
  target = anchorTarget(run, task);
} catch (error) {
  // A native run whose payload cannot name a repository can never be
  // dispatched: permanent, so settle the entry rather than retry it.
  await settleClaim(deps, entry, 'done');
  result.failed.push({ entryId: entry.entryId, error: errorMessage(error) });
  return;
}
const inputs =
  target.issue !== undefined
    ? {
        issue: String(target.issue),
        mode: run.params?.mode ?? 'implement',
        reply: run.params?.reply ?? '',
        runbook: run.params?.runbook ?? '',
        context: run.params?.context ?? '',
        broker_intent_id: run.runId,
        broker_generation: parseGeneration(run.runId),
        broker_dispatch_token: crypto.randomUUID(),
      }
    : {
        // Plan 3 teaches the worker workflows this input; until then a
        // native dispatch is refused by GitHub (`issue` is required) and
        // the entry retries like any other transient failure.
        work: JSON.stringify({ id: run.task, spec: task?.work?.['spec'] }),
        mode: 'implement',
        broker_intent_id: run.runId,
        broker_generation: parseGeneration(run.runId),
        broker_dispatch_token: crypto.randomUUID(),
      };
const url = `${githubApiBaseUrl(deps)}/repos/${target.repo}/actions/workflows/${run.pipeline}.yml/dispatches`;
```

and `tokens.tokenFor(target.repo)`.

2. `handleReportOutcome` (lines 199–207): after reading the run, resolve the target the same way; **if `target.issue === undefined` (native anchor), settle the entry `done` and return** — there is no issue to comment on and the item's state is derivable. Otherwise keep the existing comment/label code using `target.repo`/`target.issue`.

3. `addNeedsHumanLabelBestEffort` (lines 318–327): change its `task: TaskId` parameter to `target: AnchorTarget` and early-return when `target.issue === undefined`; update its call site.

`apps/console/src/lib/orchestrator-terminal-runs.ts` `groupByWorkflow` (line 205): the function only has runs, not tasks, so give it the repo via `anchorTarget` with the task looked up by the caller: change the signature to `groupByWorkflow(runs: readonly { run: Run; repo: string }[])` and have the caller (the function that lists live runs, ~line 100–130) build that array with `anchorTarget(run, (await deps.store.readTask(run.task))?.task).repo`, skipping (and recording in `failed`) any run whose anchor is unresolvable.

`apps/console/src/lib/orchestrator-routes.ts` `handleCompletion` line 254: `toRunResult(anchorTarget(run, task).repo, ...)` — Task 6 rewrites this function; here just make it compile with `anchorTarget`, keeping the `run.task.issue !== body.issue` check but guarded with `isGithubAnchor(run.task) &&`.

- [ ] **Step 5: Update the dispatch test for the native input shape**

Append to `apps/console/src/lib/orchestrator-dispatch.test.ts` (use its existing fixture for a fake `fetchImpl`/token provider; the file already asserts the `inputs` body of the `workflow_dispatch` POST for a GitHub anchor — mirror that test):

```ts
it('dispatches a native run with a work input and no issue', async () => {
  const { store, orchestrator, fetchCalls, drain } = fixture();
  await orchestrator.request({
    taskId: { workId: '01J5Z3K9QX8F0N2B4V6C8D1E3G' },
    requestId: 'w1',
    pipeline: 'claude',
    work: { spec: { title: 'x', target: { repo: 'octo/example' } } },
  });
  await drain();
  const dispatch = fetchCalls.find((c) =>
    c.url.endsWith('/actions/workflows/claude.yml/dispatches'),
  );
  expect(dispatch?.url).toContain('/repos/octo/example/');
  const body = JSON.parse(dispatch!.init.body as string);
  expect(body.inputs.issue).toBeUndefined();
  expect(JSON.parse(body.inputs.work)).toEqual({
    id: { workId: '01J5Z3K9QX8F0N2B4V6C8D1E3G' },
    spec: { title: 'x', target: { repo: 'octo/example' } },
  });
  expect(body.inputs.broker_intent_id).toBe(
    'work:01J5Z3K9QX8F0N2B4V6C8D1E3G/r1',
  );
});

it('settles report-outcome for a native run without calling GitHub', async () => {
  const { orchestrator, fetchCalls, drain } = fixture();
  await orchestrator.request({
    taskId: { workId: '01J5Z3K9QX8F0N2B4V6C8D1E3H' },
    requestId: 'w1',
    pipeline: 'claude',
    work: { spec: { target: { repo: 'octo/example' } } },
  });
  await drain();
  const before = fetchCalls.length;
  await orchestrator.report('work:01J5Z3K9QX8F0N2B4V6C8D1E3H/r1', {
    ok: false,
  });
  await drain();
  expect(
    fetchCalls.slice(before).filter((c) => c.url.includes('/issues/')),
  ).toEqual([]);
});
```

Adjust the fixture destructuring to whatever names the file actually uses (read its first 60 lines; it stubs `fetchImpl` and records calls).

- [ ] **Step 6: Run the console tests and typecheck**

Run: `./tools/nx test @agent-lcars/console -- anchor-target orchestrator-dispatch orchestrator-terminal-runs orchestrator-routes && ./tools/nx typecheck @agent-lcars/console`
Expected: PASS; no remaining `task.repo`/`task.issue` reads — confirm with `grep -rn "task\.repo\|task\.issue" apps/console/src/lib --include=*.ts | grep -v "test\.\|anchor-target"` returning nothing.

- [ ] **Step 7: Commit**

```bash
git add apps/console/src/lib
git commit -m "feat(console): resolve anchors through anchorTarget

Dispatch, outcome comments, needs-human labelling, terminal-run grouping
and completion all read the repository through one helper; a native
anchor dispatches a work input and posts nothing to GitHub.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Completion binds the finalizer's token to the run via the dispatch marker, fail-closed

**Files:**

- Create: `apps/console/src/lib/run-binding.ts`
- Test: `apps/console/src/lib/run-binding.test.ts` (create)
- Modify: `apps/console/src/lib/orchestrator-routes.ts:236-274` (`handleCompletion`)
- Modify: `apps/console/src/lib/control-plane-request.ts:50-61` (`issue` optional)
- Modify: `apps/console/src/app/api/control-plane/completion/route.ts`
- Modify: `.github/workflows/agent-fallback-finalize.yml:320-345` (retry on `503`)
- Test: `apps/console/src/lib/orchestrator-routes.test.ts`, `control-plane-request.test.ts`

**Interfaces:**

- Consumes: `CompletionOidcIdentity` (`apps/console/src/lib/github-actions-oidc.ts`: `{ repository, repositoryId, runId /* Actions run id */, workflow }`), `parseDispatchMarker` from `@agent-lcars/dispatch-contracts`, `anchorTarget`.
- Produces:

  ```ts
  export type RunBinding =
    | { bound: true }
    | { bound: false; reason: 'marker-mismatch' | 'no-marker' }
  export class BindingUnavailable extends Error   // GitHub unreachable / non-2xx
  export async function bindCompletionToRun(deps: { tokens: DispatchTokenProvider; fetchImpl?: typeof fetch; githubApiBaseUrl?: string }, identity: CompletionOidcIdentity, runId: string, repo: string): Promise<RunBinding>
  ```

  `handleCompletion(deps, body, identity)` — third parameter; returns `{ status: 503, body: { error: 'binding-unavailable' } }` on `BindingUnavailable`, `{ status: 403, body: { error: 'unbound-token' } }` when not bound.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/console/src/lib/run-binding.test.ts
import { describe, expect, it } from 'vitest';

import { bindCompletionToRun, BindingUnavailable } from './run-binding';

const identity = {
  repository: 'octo/example',
  repositoryId: 42,
  runId: 987654321,
  workflow: 'claude.yml',
};
const tokens = { tokenFor: async () => 'ghs_token' };

function fetchReturning(status: number, body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

describe('bindCompletionToRun', () => {
  it('binds when the Actions run named by the token carries the marker for this run', async () => {
    const fetchImpl = fetchReturning(200, {
      display_title: '#7: Claude implement [dispatch:g1:octo/example#7/r1]',
    });
    await expect(
      bindCompletionToRun(
        { tokens, fetchImpl },
        identity,
        'octo/example#7/r1',
        'octo/example',
      ),
    ).resolves.toEqual({ bound: true });
  });

  it('binds a native run id too', async () => {
    const fetchImpl = fetchReturning(200, {
      display_title: 'work [dispatch:g1:work:01J5Z3K9QX8F0N2B4V6C8D1E3G/r1]',
    });
    await expect(
      bindCompletionToRun(
        { tokens, fetchImpl },
        identity,
        'work:01J5Z3K9QX8F0N2B4V6C8D1E3G/r1',
        'octo/example',
      ),
    ).resolves.toEqual({ bound: true });
  });

  it('refuses when the marker names a different run', async () => {
    const fetchImpl = fetchReturning(200, {
      display_title: '#7: [dispatch:g1:octo/example#7/r2]',
    });
    await expect(
      bindCompletionToRun(
        { tokens, fetchImpl },
        identity,
        'octo/example#7/r1',
        'octo/example',
      ),
    ).resolves.toEqual({ bound: false, reason: 'marker-mismatch' });
  });

  it('refuses when the token names a run in another repository', async () => {
    await expect(
      bindCompletionToRun(
        { tokens, fetchImpl: fetchReturning(200, {}) },
        identity,
        'octo/example#7/r1',
        'other/repo',
      ),
    ).resolves.toEqual({ bound: false, reason: 'marker-mismatch' });
  });

  it('fails closed when GitHub is unavailable', async () => {
    await expect(
      bindCompletionToRun(
        { tokens, fetchImpl: fetchReturning(502, {}) },
        identity,
        'octo/example#7/r1',
        'octo/example',
      ),
    ).rejects.toBeInstanceOf(BindingUnavailable);
  });
});
```

Add to `apps/console/src/lib/orchestrator-routes.test.ts` (it already has a completion fixture that seeds a run and calls `handleCompletion`; extend it with a `binding` stub on deps):

```ts
it('returns 503 and settles nothing when the binding lookup is unavailable', async () => {
  const { deps, seedRun } = completionFixture({
    bind: async () => {
      throw new BindingUnavailable('502');
    },
  });
  const run = await seedRun();
  const result = await handleCompletion(deps, completionBody(run), IDENTITY);
  expect(result.status).toBe(503);
  expect((await deps.store.readRun(run.runId))?.state).toBe('running');
});

it('returns 403 and settles nothing when the token is not bound to the run', async () => {
  const { deps, seedRun } = completionFixture({
    bind: async () => ({ bound: false, reason: 'marker-mismatch' }),
  });
  const run = await seedRun();
  const result = await handleCompletion(deps, completionBody(run), IDENTITY);
  expect(result.status).toBe(403);
  expect((await deps.store.readRun(run.runId))?.state).toBe('running');
});

it('settles a native run addressed by runId with no issue in the body', async () => {
  const { deps, seedNativeRun } = completionFixture({
    bind: async () => ({ bound: true }),
  });
  const run = await seedNativeRun();
  const result = await handleCompletion(
    deps,
    {
      workflow: 'claude.yml',
      intentId: run.runId,
      outcome: 'success',
      outcomeReference: { number: 12 },
    },
    IDENTITY,
  );
  expect(result.status).toBe(200);
  const settled = await deps.store.readRun(run.runId);
  expect(settled?.state).toBe('finished');
  expect(settled?.result?.ref).toBe('https://github.com/octo/example/pull/12');
});
```

Add to `apps/console/src/lib/control-plane-request.test.ts`:

```ts
it('accepts a completion body without issue when intentId is present', () => {
  expect(() =>
    parseHostedCompletionRequestBody({
      workflow: 'claude.yml',
      intentId: 'work:01J5Z3K9QX8F0N2B4V6C8D1E3G/r1',
    }),
  ).not.toThrow();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `./tools/nx test @agent-lcars/console -- run-binding orchestrator-routes control-plane-request`
Expected: FAIL — `run-binding` module missing; `handleCompletion` takes two arguments; `issue` required.

- [ ] **Step 3: Implement `run-binding.ts`**

```ts
// apps/console/src/lib/run-binding.ts
import 'server-only';

import { parseDispatchMarker } from '@agent-lcars/dispatch-contracts';

import type { CompletionOidcIdentity } from './github-actions-oidc';
import type { DispatchTokenProvider } from './orchestrator-dispatch';

const GITHUB_API = 'https://api.github.com';

export type RunBinding =
  { bound: true } | { bound: false; reason: 'marker-mismatch' | 'no-marker' };

/** GitHub could not answer: the caller must fail closed, never settle. */
export class BindingUnavailable extends Error {
  override readonly name = 'BindingUnavailable';
}

export interface RunBindingDeps {
  tokens: DispatchTokenProvider;
  fetchImpl?: typeof fetch;
  githubApiBaseUrl?: string;
}

/**
 * Prove the verified token belongs to the workflow run the orchestrator
 * dispatched for `runId`: the OIDC claims prove "a trusted finalizer on an
 * allowed repository", and the dispatch marker in that Actions run's
 * display title proves "for *this* run". Same join
 * `orchestrator-terminal-runs.ts` uses to settle terminal runs.
 */
export async function bindCompletionToRun(
  deps: RunBindingDeps,
  identity: CompletionOidcIdentity,
  runId: string,
  repo: string,
): Promise<RunBinding> {
  if (identity.repository !== repo) {
    return { bound: false, reason: 'marker-mismatch' };
  }
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const base = (deps.githubApiBaseUrl ?? GITHUB_API).replace(/\/+$/u, '');
  let response: Response;
  try {
    const token = await deps.tokens.tokenFor(repo);
    response = await fetchImpl(
      `${base}/repos/${repo}/actions/runs/${identity.runId}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
        },
      },
    );
  } catch (error) {
    throw new BindingUnavailable(
      error instanceof Error ? error.message : String(error),
    );
  }
  if (!response.ok) {
    throw new BindingUnavailable(
      `actions run lookup returned ${response.status}`,
    );
  }
  const body = (await response.json()) as {
    display_title?: string;
    name?: string;
  };
  const marker = parseDispatchMarker(body.display_title ?? body.name);
  if (marker === undefined) return { bound: false, reason: 'no-marker' };
  return marker.intentId === runId
    ? { bound: true }
    : { bound: false, reason: 'marker-mismatch' };
}
```

(`DispatchTokenProvider` is the token-provider interface `orchestrator-dispatch.ts` already declares — export it if it is not exported.)

- [ ] **Step 4: Rewrite `handleCompletion`**

In `apps/console/src/lib/orchestrator-routes.ts`, add `bind: typeof bindCompletionToRun` to `OrchestratorRouteDeps` (so tests inject a stub) and replace `handleCompletion`:

```ts
export async function handleCompletion(
  deps: OrchestratorRouteDeps,
  body: HostedCompletionRequestBody,
  identity: CompletionOidcIdentity,
): Promise<RouteResult> {
  try {
    if (body.intentId === undefined) {
      return { status: 200, body: { ignored: 'unknown-run' } };
    }
    const runId = body.intentId;
    const run = await deps.store.readRun(runId);
    if (run === undefined) {
      return { status: 200, body: { ignored: 'unknown-run' } };
    }
    // GitHub anchors keep the issue tie as a cheap local pre-check; native
    // anchors have no issue and rely on the marker binding alone.
    if (isGithubAnchor(run.task) && run.task.issue !== body.issue) {
      return { status: 200, body: { ignored: 'unknown-run' } };
    }
    const task = (await deps.store.readTask(run.task))?.task;
    const target = anchorTarget(run, task);

    let binding: RunBinding;
    try {
      binding = await deps.bind(deps, identity, runId, target.repo);
    } catch (error) {
      if (error instanceof BindingUnavailable) {
        return { status: 503, body: { error: 'binding-unavailable' } };
      }
      throw error;
    }
    if (!binding.bound) {
      return {
        status: 403,
        body: { error: 'unbound-token', reason: binding.reason },
      };
    }

    const result = toRunResult(
      target.repo,
      body.outcome,
      body.outcomeReference,
    );
    const outcome = await deps.orchestrator.report(runId, result);
    if (isRefusal(outcome)) {
      if (outcome.reason === 'unknown-run') {
        return { status: 200, body: { ignored: 'unknown-run' } };
      }
      return { status: 200, body: { refused: outcome.reason } };
    }
    await deps.drain();
    return { status: 200, body: { runId, state: 'finished' } };
  } catch (error) {
    return internalError('completion', error);
  }
}
```

`OrchestratorRouteDeps` needs whatever `bindCompletionToRun` needs (`tokens`, optional `fetchImpl`/`githubApiBaseUrl`) — it already carries `store`, `orchestrator`, `drain`; add `tokens` if absent, sourcing it from `createOrchestratorRuntime()` the same way `orchestrator-dispatch.ts` gets its token provider.

In `apps/console/src/lib/control-plane-request.ts` make `issue` optional: `issue: z.number().int().safe().positive().optional(),`.

In `apps/console/src/app/api/control-plane/completion/route.ts`, keep the `verifyCompletionOidcToken` result: `const identity = await verifyCompletionOidcToken(...)` and pass it: `handleCompletion(runtime, body, identity)`. Map `result.status` through unchanged (`503`/`403` now reach the caller).

- [ ] **Step 5: Teach the finalizer to retry on `503`**

In `.github/workflows/agent-fallback-finalize.yml`, the "Return completion observation to the broker" step already loops on `completion_status` (≈ lines 320–345). Make the loop retry on `503` with backoff: where it currently tries the `curl` and checks `[[ "$completion_status" == 2?? ]]`, wrap it as

```bash
          for attempt in 1 2 3 4; do
            if completion_status="$(curl --silent --show-error \
              --output "$completion_response_file" --write-out '%{http_code}' \
              ... existing curl arguments unchanged ...
            )" && [[ "$completion_status" == 2?? ]]; then
              break
            fi
            if [[ "$completion_status" == 503 ]] && (( attempt < 4 )); then
              echo "::notice::Hosted completion unavailable (503); retrying in $((attempt * 15))s"
              sleep $((attempt * 15))
              continue
            fi
            break
          done
```

and leave the existing `case "$completion_status"` error reporting after the loop as is, so a final `503`/`403` still surfaces as `::error::`.

- [ ] **Step 6: Run the tests**

Run: `./tools/nx test @agent-lcars/console -- run-binding orchestrator-routes control-plane-request && ./tools/nx typecheck @agent-lcars/console && ./tools/nx lint @agent-lcars/console`
Expected: PASS. Also run the workflow contract tests if any pin the finalizer step text: `grep -rln "agent-fallback-finalize" apps libs tools --include=*.test.* --include=*.spec.*` and run those.

- [ ] **Step 7: Commit**

```bash
git add apps/console/src .github/workflows/agent-fallback-finalize.yml
git commit -m "feat(console): bind completion tokens to runs via the dispatch marker

The finalizer's OIDC token proves a trusted caller; the Actions run it
names must carry the marker for the run being completed. GitHub errors
fail closed with 503 and the finalizer retries with backoff. issue is
optional in the body so native runs complete by runId.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: `intentId` on telemetry session docs

**Files:**

- Modify: `libs/telemetry/src/lib/types.ts:222-226` (issue-agent doc), `:283-287` (`BuildSessionDocOptions`)
- Modify: `libs/telemetry/src/lib/session-doc.ts:93-96`
- Modify: `apps/telemetry-watcher/src/lib/runner-config.ts` (flag), `apps/telemetry-watcher/src/lib/runner.ts:103-105`
- Modify: `apps/telemetry-watcher/bin/sidecar-lifecycle.sh:92-95`
- Modify: `.github/workflows/agent-lane.yml` — the two `env:` blocks that set `RUN_ID: ${{ github.run_id }}` (≈ lines 1423 and 1466)
- Test: `libs/telemetry/src/lib/session-doc.spec.ts`, `apps/telemetry-watcher/src/lib/runner-config.spec.ts` (existing files; extend)

**Interfaces:**

- Produces: `SessionDoc` (source `issue-agent`) gains `intentId?: string` — the orchestrator run ID; `BuildSessionDocOptions.intentId?`; sidecar flag `--intent-id <id>` fed from `INTENT_ID`.

- [ ] **Step 1: Write the failing tests**

In `libs/telemetry/src/lib/session-doc.spec.ts` (find the existing test that asserts `runId`/`issueNumber` land on an issue-agent doc and add alongside it):

```ts
it('records the orchestrator run id as intentId on issue-agent docs', () => {
  const doc = buildSessionDoc(summary({ source: 'issue-agent' }), 'live', {
    runId: '987654321',
    issueNumber: 7,
    repo: 'octo/example',
    intentId: 'octo/example#7/r1',
  });
  expect(doc).toMatchObject({
    source: 'issue-agent',
    runId: '987654321',
    intentId: 'octo/example#7/r1',
  });
});
```

(`summary(...)` — use whatever fixture builder the spec already has for a `SessionSummary`.)

In `apps/telemetry-watcher/src/lib/runner-config.spec.ts`:

```ts
it('parses --intent-id', () => {
  const config = parseRunnerConfig([
    'sidecar',
    '--run-id',
    '1',
    '--intent-id',
    'work:01J5Z3K9QX8F0N2B4V6C8D1E3G/r1',
  ]);
  expect(config.intentId).toBe('work:01J5Z3K9QX8F0N2B4V6C8D1E3G/r1');
});
```

(match the parse function's actual exported name — `grep -n "^export function" apps/telemetry-watcher/src/lib/runner-config.ts`.)

- [ ] **Step 2: Run them to verify they fail**

Run: `./tools/nx test @agent-lcars/telemetry -- session-doc && ./tools/nx test @agent-lcars/telemetry-watcher -- runner-config`
Expected: FAIL — unknown option / property.

- [ ] **Step 3: Implement**

`libs/telemetry/src/lib/types.ts`: in the `issue-agent` session doc type add `intentId?: string;` after `runId?`, with the comment `/** The orchestrator run ID (`broker_intent_id`) — the join key from a work item to its sessions. `runId` is the GitHub Actions run id. */`; in `BuildSessionDocOptions` add `/** issue-agent sessions only. */ intentId?: string;`.

`libs/telemetry/src/lib/session-doc.ts` line 93: after the `runId` spread add `...(options.intentId && { intentId: options.intentId }),`.

`apps/telemetry-watcher/src/lib/runner-config.ts`: add `intentId?: string;` to both the config interface and the flags interface (lines ~10 and ~38), and in the flag loop add:

```ts
    } else if (arg === '--intent-id') {
      flags.intentId = next;
      index += 1;
```

(mirror exactly how `--run-id` advances the index at line ~92–94.) Update the doc comment listing the flags.

`apps/telemetry-watcher/src/lib/runner.ts` line 103–105: add `intentId: config.intentId,` to the options passed into `buildSessionDoc`.

`apps/telemetry-watcher/bin/sidecar-lifecycle.sh` after the `NUM` block:

```bash
if [ -n "${INTENT_ID:-}" ]; then
  ARGS+=(--intent-id "$INTENT_ID")
fi
```

`.github/workflows/agent-lane.yml`: in both `env:` blocks that set `RUN_ID: ${{ github.run_id }}` add the line `INTENT_ID: ${{ inputs.broker_intent_id }}` directly under it. Confirm the lane declares `broker_intent_id` as a reusable-workflow input (`grep -n "broker_intent_id" .github/workflows/agent-lane.yml`); it does — that is how the attempt identity reaches the job.

- [ ] **Step 4: Run the tests**

Run: `./tools/nx test @agent-lcars/telemetry @agent-lcars/telemetry-watcher && ./tools/nx typecheck @agent-lcars/telemetry @agent-lcars/telemetry-watcher @agent-lcars/console`
Expected: PASS (the console reads `SessionDoc` and must still compile).

- [ ] **Step 5: Commit**

```bash
git add libs/telemetry apps/telemetry-watcher .github/workflows/agent-lane.yml
git commit -m "feat(telemetry): record the orchestrator run id on session docs

runId on a session doc is the Actions run id; intentId is the join key a
work item needs to find its sessions.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Pin the marker grammar for native run IDs; document the anchors

**Files:**

- Modify: `libs/dispatch-contracts/src/marker.spec.ts`
- Modify: `libs/orchestrator/README.md`

**Interfaces:** none new. `DISPATCH_MARKER_RE` (`/\[dispatch:g(\d+):([A-Za-z0-9._:/#-]+)\]/u`) already accepts `:` and `/`, so `work:<ulid>/r<n>` needs no grammar change — this task makes that a pinned fact instead of an assumption.

- [ ] **Step 1: Write the test**

Append to `libs/dispatch-contracts/src/marker.spec.ts`:

```ts
describe('native run ids', () => {
  const intentId = 'work:01J5Z3K9QX8F0N2B4V6C8D1E3G/r1';

  it('round-trips a work: run id through the dispatch marker', () => {
    const marker = formatDispatchMarker({ generation: 1, intentId });
    expect(marker).toBe(`[dispatch:g1:${intentId}]`);
    expect(
      parseDispatchMarker(`native [${'dispatch'}:g1:${intentId}] title`),
    ).toEqual({
      generation: 1,
      intentId,
    });
  });
});
```

- [ ] **Step 2: Run it**

Run: `./tools/nx test @agent-lcars/dispatch-contracts -- marker`
Expected: PASS immediately (the grammar already accepts it). If it fails, the regex has changed since `ac6e639` — widen its character class to include `:` and `/` and re-run.

- [ ] **Step 3: Document**

In `libs/orchestrator/README.md`, add a section after the existing description of tasks/runs:

```markdown
## Anchors

A task is identified by an anchor: a GitHub issue or pull request
(`{ repo, issue }`, key `owner/name#123`) or a native work item
(`{ workId }`, key `work:<ulid>`). The two are discriminated by which key
is present; nothing persisted changed shape when the second anchor was
added. A native task carries an opaque, bounded `work` payload written by
the request that creates it and never read by the orchestrator, plus an
orchestrator-owned `closedAt` set by `closeTask` — a closed task refuses
further requests (`task-closed`). See
`docs/superpowers/specs/2026-08-23-native-work-items-design.md`.
```

- [ ] **Step 4: Commit and push**

```bash
git add libs/dispatch-contracts/src/marker.spec.ts libs/orchestrator/README.md
git commit -m "test(dispatch-contracts): pin the marker grammar for native run ids

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git push
```

---

### Task 9: Verify zero behavior change and land

**Files:** none new.

- [ ] **Step 1: Full local gate once** (the one case verify.md allows: this branch changes CI config and the store-contract target)

Run: `pnpm verify && ./tools/nx run @agent-lcars/orchestrator:test-firestore`
Expected: PASS.

- [ ] **Step 2: Confirm the label-driven path is byte-identical where it matters**

Run:

```bash
grep -rn "task\.repo\|task\.issue" apps/console/src/lib --include=*.ts | grep -v "\.test\.\|anchor-target.ts"
./tools/nx test @agent-lcars/console -- orchestrator-dispatch orchestrator-routes orchestrator-terminal-runs
```

Expected: the grep prints nothing; every pre-existing dispatch/outcome/completion test still passes unmodified except the two tests this plan explicitly extended (Task 5 Step 5, Task 6 Step 1).

- [ ] **Step 3: Watch CI and address review**

`gh pr checks <PR> --watch`; the new `Store contract against the Firestore emulator` step must appear and pass. Resolve every review thread per `.agents/skills/agent-lcars-dev/references/pr.md` (reply, push the fix, resolve via GraphQL). Merge with `gh pr merge --squash --delete-branch`, then confirm `main`'s `Verify` run is green and post the PR link on issue #1502.

---

## Self-review

**Spec coverage (sections this plan owns):**

- Data model → `Task` anchor union, `work`, `closedAt`, `closeTask`, zero migration: Tasks 1–3 ✔
- Backend 1 → `anchorTarget`, every dereference, anchor-aware `listRuns`, emulator in CI, `report-outcome` posts nothing for native anchors: Tasks 4–5 ✔ (the `work` dispatch input is emitted here; the workflows accept it in Plan 3)
- Runs / Auth → completion by `runId`, finalizer-only pin unchanged, marker binding fail-closed, finalizer retry: Task 6 ✔
- Sessions → `intentId`: Task 7 ✔
- Testing → persisted-shape fixtures (Task 1), store contract on the emulator (Task 4), marker pin (Task 8) ✔
- Not in this plan by design: `items` API, oRPC, grants, CLI, console pages (Plan 2); worker workflow native path, `agent-protocol` native mode (Plan 3).

**Placeholder scan:** none — every step carries code or an exact command. Line numbers are anchored to `ac6e639` with the instruction to re-locate by quoted code.

**Type consistency:** `TaskId`/`GithubAnchor`/`WorkAnchor`/`isWorkAnchor` (Task 1) are used with those names in Tasks 4–6; `WorkPayload` (Task 2) in Tasks 3–5; `Decision.run?`/`decidedRun` (Task 3) is the only signature change consumers see; `anchorTarget(run, task?)` (Task 5) is called with that argument order in Tasks 5–6; `handleCompletion(deps, body, identity)` and `deps.bind` (Task 6) match the route and the tests; `intentId` (Task 7) is the same name on the doc, the option, the flag, and the env var.

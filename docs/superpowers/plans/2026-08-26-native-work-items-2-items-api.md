# Native Work Items — Plan 2: `items` API on oRPC 2, grants, CLI, console pages

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a granted principal create, follow, cancel, and redispatch native work items through a contract-first REST API (`/api/work/v1/items`), the `lcars work` CLI, and two console pages — on top of Plan 1's anchor-aware orchestrator.

**Architecture:** `libs/work` owns the work-item schemas, the derived-state function, and the oRPC 2 contract (dependency-light, CLI-importable). The console implements the contract behind one catch-all route (`OpenAPIHandler` from `@orpc/openapi/fetch`), with a per-request context that accepts a Google service-account ID token _or_ an Auth.js session and maps either to a principal + scopes via a configured grant list. The console's `/work` pages call the same procedures as Next server functions. The `lcars` CLI gets a `work` subcommand tree using the typed `OpenAPILink` client. The OpenAPI document is generated from the contract and checked in.

**Tech Stack:** TypeScript, zod 4.4.3, oRPC 2 (`@orpc/contract`, `@orpc/server`, `@orpc/client`, `@orpc/openapi`, `@orpc/next`, `@orpc/zod` — all on the `beta` dist-tag, `2.0.0-beta.31` at time of writing), `jose` (Google JWKS), Auth.js v5 (`next-auth`), Next.js App Router + Mantine, `ulid`, Vitest, Nx, esbuild (CLI bundle).

**Spec:** `docs/superpowers/specs/2026-08-23-native-work-items-design.md` — sections "API" (Framework, `items`), "Auth", "Derived item state", "Sessions", "Console", "Testing". Plan 1 (`docs/superpowers/plans/2026-08-26-native-work-items-1-foundation.md`) must be merged first: this plan consumes `Task.work`, `Task.closedAt`, `Orchestrator.close`, `WORK_ID_RE`, `isWorkAnchor`, `anchorTarget`, and session docs' `intentId`.

## Global Constraints

- Third-party dependencies are declared only in the root `package.json` (`tools/check-dependencies.sh` fails otherwise); oRPC packages use the `beta` dist-tag, pinned by Renovate like any third-party dependency.
- `libs/work` is dependency-light and free of `server-only` imports: it may import `zod`, `@orpc/contract`, `@orpc/openapi` (for `openapi()` metadata), and `@agent-lcars/dispatch-contracts`; never `@agent-lcars/orchestrator`'s Firestore store, `next`, or anything Node-only. The CLI bundle imports it.
- Scopes: `work.operator` (the `items` routes) and `work.agent` (run routes — not served by this plan). No admin scope. Issuers confine what they confer: a Google ID token or an Auth.js session may yield `work.operator` only through the grant list; GitHub Actions tokens are not accepted on `items`.
- Grant list: `AGENT_LCARS_WORK_GRANTS` — JSON array of `{ "principal": "user:jlapenna", "subjects": ["<sa email>", "github:jlapenna"], "pipelines": ["claude"] }`. A subject not in any grant has no scope (`401` on bearer routes, `403` for a signed-in console user with no grant). A granted principal requesting a pipeline outside its list gets `403`.
- Global cap: `AGENT_LCARS_WORK_MAX_LIVE_RUNS` (integer, default `4`); exceeding it is `429` with `Retry-After: 60`.
- `spec.pipeline` is required (no default) and must be one of `PIPELINE_CONTRACTS`' keys; `spec.target.repo` is required and must satisfy `isControlPlaneRepository`; `spec.description` ≤ 16,384 characters; `spec.title` ≤ 256.
- Item IDs are client-generated ULIDs (`WORK_ID_RE`); `PUT /items/{id}` reads the task first and returns `200` with the existing item when it already exists.
- Derived state, first match wins: `closedAt` set or latest run `canceled` → `canceled`; a live run → `running`; latest `finished` + `ok` → `done`; latest `finished` + `!ok` → `parked`; latest `lost` and `consecutiveLost > MAX_AUTO_RETRIES` → `parked`; latest `lost` otherwise → `running`; no runs → `running` (a task is only ever created by a request that mints r1).
- The Edge proxy allow-lists `/api/work/v1/`; auth is enforced inside the handler at router level, and a behavioral test proves every contract route refuses an unauthenticated request.
- `docs/api/work-v1.openapi.json` is generated from the contract and checked in; CI fails if it drifts.
- No real git in unit tests; console E2E stays off (#1049); RSC boundary rules from `.agents/skills/agent-lcars-dev/references/verify.md` apply to the pages.
- Every commit: worktree, tests run, conventional message, trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. Push early; CI `Verify` is the gate.

## Export-name verification (do this in Task 1, reuse everywhere)

oRPC 2 is beta and its subpath exports have moved between betas. Task 1 records the actual export paths in its report; later tasks use these expected names and fall back to what Task 1 recorded:

| Symbol                           | Expected import                                         |
| -------------------------------- | ------------------------------------------------------- |
| `oc`                             | `@orpc/contract`                                        |
| `openapi` (route metadata)       | `@orpc/openapi`                                         |
| `implement`, `ORPCError`, `call` | `@orpc/server`                                          |
| `OpenAPIHandler`                 | `@orpc/openapi/fetch`                                   |
| `OpenAPIGenerator`               | `@orpc/openapi`                                         |
| `ZodToJsonSchemaConverter`       | `@orpc/zod/zod4` (fallback `@orpc/zod`)                 |
| `OpenAPILink`                    | `@orpc/openapi/fetch` (fallback `@orpc/openapi/client`) |
| `createORPCClient`               | `@orpc/client`                                          |
| `createServerFunctionable`       | `@orpc/next`                                            |

Verification one-liner (Task 1 Step 3): `node -e "for (const m of ['@orpc/contract','@orpc/openapi','@orpc/openapi/fetch','@orpc/server','@orpc/client','@orpc/next','@orpc/zod','@orpc/zod/zod4']) { try { console.log(m, Object.keys(require(m)).filter(k => /^(oc|openapi|implement|ORPCError|call|OpenAPIHandler|OpenAPIGenerator|ZodToJsonSchemaConverter|OpenAPILink|createORPCClient|createServerFunctionable)$/.test(k))) } catch (e) { console.log(m, 'MISSING') } }"`

## File Structure

| File                                                                                                                                   | Responsibility                                                                                        |
| -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `package.json`, `pnpm-lock.yaml` (modify)                                                                                              | oRPC 2 + `ulid` dependencies                                                                          |
| `libs/work/{package.json,project.json,tsconfig*.json,vitest.config.mts,eslint.config.mjs}` (create)                                    | Nx lib scaffold, mirroring `libs/dispatch-contracts` (dependency-light, `platform:shared`)            |
| `libs/work/src/spec.ts` (create)                                                                                                       | `workSpecSchema`, `workOriginSchema`, `workPayloadSchema`, `WorkSpec`, `WorkPayload`, size constants  |
| `libs/work/src/derive.ts` (create)                                                                                                     | `deriveItemState`, `ItemState`, `toItemView`                                                          |
| `libs/work/src/contract.ts` (create)                                                                                                   | The oRPC contract: `itemsContract` (create/get/list/cancel/redispatch), `itemViewSchema`, error map   |
| `libs/work/src/openapi.ts` (create)                                                                                                    | `generateWorkOpenApi()`                                                                               |
| `libs/work/src/index.ts` (create)                                                                                                      | Public surface                                                                                        |
| `tools/work-openapi.mjs` (create), `docs/api/work-v1.openapi.json` (create)                                                            | Generator script + checked-in document; `check` mode for CI                                           |
| `libs/env-vars/src/env-vars.ts`, `apps/console/apphosting.yaml` (modify)                                                               | `AGENT_LCARS_WORK_AUDIENCE`, `AGENT_LCARS_WORK_GRANTS`, `AGENT_LCARS_WORK_MAX_LIVE_RUNS`              |
| `apps/console/src/lib/work-grants.ts` (create)                                                                                         | Parse the grant list; `resolvePrincipal(subject)`, `mayRequestPipeline(principal, pipeline)`          |
| `apps/console/src/lib/work-auth.ts` (create)                                                                                           | `authenticateWorkRequest(request, deps)`: Google ID token (JWKS) or Auth.js session → `WorkPrincipal` |
| `apps/console/src/auth.ts`, `apps/console/src/types/next-auth.d.ts` (modify)                                                           | Expose `session.user.login`                                                                           |
| `libs/telemetry/src/server/store.ts` (modify)                                                                                          | `listSessionDocs` gains `intentId` filter                                                             |
| `apps/console/src/lib/work-router.ts` (create)                                                                                         | `implement(itemsContract)` + `requireOperator` middleware + procedures                                |
| `apps/console/src/app/api/work/v1/[[...rest]]/route.ts` (create)                                                                       | `OpenAPIHandler` mount                                                                                |
| `apps/console/src/proxy.ts`, `apps/console/src/proxy.test.ts` (modify)                                                                 | Allow-list `/api/work/v1/`; extend the scan                                                           |
| `apps/console/src/app/work/functions.ts` (create)                                                                                      | Server functions over the same procedures                                                             |
| `apps/console/src/app/work/page.tsx`, `apps/console/src/app/work/[id]/page.tsx`, `apps/console/src/app/work/work-actions.tsx` (create) | The two pages + the client actions component                                                          |
| `apps/telemetry-watcher/src/lib/work-command.ts` (create), `apps/telemetry-watcher/src/session-title-cli.ts` (modify)                  | `lcars work …` subcommands over the typed client                                                      |
| `libs/work/README.md`, `docs/deployment-boundary.md` (modify)                                                                          | Docs                                                                                                  |

Line numbers reference `main` after Plan 1 merges; re-locate by quoted code if drifted.

---

### Task 1: Dependencies and export verification

**Files:**

- Modify: `package.json` (root `dependencies`), `pnpm-lock.yaml`

**Interfaces:**

- Produces: the oRPC 2 packages and `ulid` installed at the workspace root; the verified export table in the report.

- [ ] **Step 1: Install**

Run from the worktree root:

```bash
pnpm add @orpc/contract@beta @orpc/server@beta @orpc/client@beta @orpc/openapi@beta @orpc/next@beta @orpc/zod@beta ulid
```

Expected: `package.json` gains seven entries under `dependencies` with `2.0.0-beta.N` ranges (`^2.0.0-beta.31` or newer) and `ulid` at its latest; the lockfile updates.

- [ ] **Step 2: Verify the workspace policy still passes**

Run: `pnpm check:dependencies`
Expected: `Dependency checks passed.` (external deps live only in the root manifest).

- [ ] **Step 3: Record the real export paths**

Run the verification one-liner from "Export-name verification" above and paste its output into your report. If `OpenAPILink` or `ZodToJsonSchemaConverter` is not where the table expects, note the path that has it — later tasks read your report before importing.

- [ ] **Step 4: Prove the toolchain compiles a contract**

Create a throwaway file `/tmp/orpc-smoke.mts` (outside the repo):

```ts
import { oc } from '@orpc/contract';
import { openapi } from '@orpc/openapi';
import { z } from 'zod';

const c = oc
  .meta(openapi({ method: 'GET', path: '/ping' }))
  .output(z.object({ ok: z.boolean() }));
console.log(typeof c);
```

Run: `cd <worktree> && node --experimental-strip-types /tmp/orpc-smoke.mts` (or `pnpm exec tsx /tmp/orpc-smoke.mts` if `tsx` is available). Expected: prints `object`. Delete the file.

- [ ] **Step 5: Commit and push (Renovate and CI see the new packages)**

```bash
git add package.json pnpm-lock.yaml
git commit -m "build: add oRPC 2 (beta) and ulid

The fleet's API framework, adopted on the 2.x line (wire format differs
from 1.x). Contract, server, client, openapi, next, zod integration.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git push -u origin HEAD
```

---

### Task 2: `libs/work` scaffold and the work spec schemas

**Files:**

- Create: `libs/work/package.json`, `libs/work/project.json`, `libs/work/tsconfig.json`, `libs/work/tsconfig.lib.json`, `libs/work/tsconfig.spec.json`, `libs/work/vitest.config.mts`, `libs/work/eslint.config.mjs`
- Create: `libs/work/src/spec.ts`, `libs/work/src/index.ts`
- Modify: `tsconfig.base.json` (path alias `@agent-lcars/work`)
- Test: `libs/work/src/spec.spec.ts`

**Interfaces:**

- Consumes: `PIPELINE_CONTRACTS` from `@agent-lcars/dispatch-contracts` (keys `claude | codex | opencode`).
- Produces:

  ```ts
  export const WORK_TITLE_MAX = 256;
  export const WORK_DESCRIPTION_MAX = 16_384;
  export const workTargetSchema   // z.strictObject({ repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/u) })
  export const workSpecSchema     // z.strictObject({ title, description, pipeline: z.enum(PIPELINES), target: workTargetSchema })
  export const workOriginSchema   // z.strictObject({ principal: z.string().min(1).max(128), channel: z.enum(['api','cron','console']) })
  export const workPayloadSchema  // z.strictObject({ origin: workOriginSchema, spec: workSpecSchema })
  export type WorkSpec, WorkOrigin, WorkPayload
  export const PIPELINES: readonly ['claude', 'codex', 'opencode']  // Object.keys(PIPELINE_CONTRACTS) frozen, typed
  ```

- [ ] **Step 1: Scaffold the lib by copying `libs/dispatch-contracts`' config files**

Copy each of `package.json`, `project.json`, `tsconfig.json`, `tsconfig.lib.json`, `tsconfig.spec.json`, `vitest.config.mts`, `eslint.config.mjs` from `libs/dispatch-contracts/` to `libs/work/`, then replace every occurrence of `dispatch-contracts` with `work` and the package name with `@agent-lcars/work`. Keep the tags `["platform:shared", "scope:shared"]`. Add to `tsconfig.base.json` `paths`: `"@agent-lcars/work": ["libs/work/src/index.ts"]`.

- [ ] **Step 2: Write the failing test**

```ts
// libs/work/src/spec.spec.ts
import { describe, expect, it } from 'vitest';

import {
  PIPELINES,
  WORK_DESCRIPTION_MAX,
  workPayloadSchema,
  workSpecSchema,
} from './spec';

const spec = {
  title: 'Add a health endpoint',
  description: 'Expose GET /healthz returning 200.',
  pipeline: 'claude',
  target: { repo: 'jlapenna/agent-lcars' },
};

describe('workSpecSchema', () => {
  it('accepts a complete spec', () => {
    expect(workSpecSchema.parse(spec)).toEqual(spec);
  });

  it('requires pipeline and only knows the fleet pipelines', () => {
    expect(() =>
      workSpecSchema.parse({ ...spec, pipeline: undefined }),
    ).toThrow();
    expect(() =>
      workSpecSchema.parse({ ...spec, pipeline: 'gemini' }),
    ).toThrow();
    expect(PIPELINES).toEqual(['claude', 'codex', 'opencode']);
  });

  it('requires target.repo in owner/name form', () => {
    expect(() => workSpecSchema.parse({ ...spec, target: {} })).toThrow();
    expect(() =>
      workSpecSchema.parse({ ...spec, target: { repo: 'no-slash' } }),
    ).toThrow();
  });

  it('bounds the description', () => {
    expect(() =>
      workSpecSchema.parse({
        ...spec,
        description: 'x'.repeat(WORK_DESCRIPTION_MAX + 1),
      }),
    ).toThrow();
  });

  it('rejects unknown keys (strict)', () => {
    expect(() => workSpecSchema.parse({ ...spec, mode: 'review' })).toThrow();
  });
});

describe('workPayloadSchema', () => {
  it('pairs origin with spec', () => {
    const payload = {
      origin: { principal: 'user:jlapenna', channel: 'api' },
      spec,
    };
    expect(workPayloadSchema.parse(payload)).toEqual(payload);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `./tools/nx test @agent-lcars/work`
Expected: FAIL — `./spec` not found.

- [ ] **Step 4: Implement**

```ts
// libs/work/src/spec.ts
import { PIPELINE_CONTRACTS } from '@agent-lcars/dispatch-contracts';
import { z } from 'zod';

/**
 * What a native work item asks for. Owned here, stored opaquely by the
 * orchestrator as `Task.work` (see the design spec, "Data model"), and
 * delivered to the worker as the `work` workflow input (Plan 3).
 */
export const WORK_TITLE_MAX = 256;
/** Fits the workflow_dispatch input budget (65,535 chars across all
 *  inputs) with room for the other inputs. */
export const WORK_DESCRIPTION_MAX = 16_384;

export const PIPELINES = Object.freeze(
  Object.keys(PIPELINE_CONTRACTS) as ['claude', 'codex', 'opencode'],
);

export const workTargetSchema = z.strictObject({
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/u),
});

export const workSpecSchema = z.strictObject({
  title: z.string().min(1).max(WORK_TITLE_MAX),
  description: z.string().min(1).max(WORK_DESCRIPTION_MAX),
  /** Required: invoking a pipeline is a granted capability. */
  pipeline: z.enum(PIPELINES),
  target: workTargetSchema,
});
export type WorkSpec = z.infer<typeof workSpecSchema>;

export const workOriginSchema = z.strictObject({
  /** LCARS-native principal, e.g. `user:jlapenna`, `svc:lcars-admin`. */
  principal: z.string().min(1).max(128),
  channel: z.enum(['api', 'cron', 'console']),
});
export type WorkOrigin = z.infer<typeof workOriginSchema>;

export const workPayloadSchema = z.strictObject({
  origin: workOriginSchema,
  spec: workSpecSchema,
});
export type WorkPayload = z.infer<typeof workPayloadSchema>;
```

```ts
// libs/work/src/index.ts
export * from './spec';
```

- [ ] **Step 5: Run the tests, lint, typecheck**

Run: `./tools/nx run-many -t test lint typecheck -p @agent-lcars/work`
Expected: PASS. Also `./tools/nx lint:circular` if the workspace exposes it (`pnpm lint:circular`): no cycle (`work → dispatch-contracts` only).

- [ ] **Step 6: Commit**

```bash
git add libs/work tsconfig.base.json
git commit -m "feat(work): libs/work with the work spec schemas

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Derived item state and the item view

**Files:**

- Create: `libs/work/src/derive.ts`
- Modify: `libs/work/src/index.ts`
- Test: `libs/work/src/derive.spec.ts`

**Interfaces:**

- Consumes: `Task`, `Run`, `MAX_AUTO_RETRIES`, `isLive` from `@agent-lcars/orchestrator` (types + two pure exports; the lib must NOT import the Firestore store — import from `@agent-lcars/orchestrator` is fine because its `index.ts` re-exports `decide`/`model` which are pure; do not import `firestore-store`). `WorkPayload` from `./spec`.
- Produces:

  ```ts
  export type ItemState = 'running' | 'done' | 'parked' | 'canceled';
  export function deriveItemState(
    task: Pick<Task, 'closedAt' | 'consecutiveLost'>,
    runs: readonly Run[],
  ): ItemState;
  export interface ItemView {
    id: string;
    state: ItemState;
    spec: WorkSpec;
    origin: WorkOrigin;
    createdAt: string;
    updatedAt: string;
    closedAt?: string;
    runs: ItemRunView[];
    sessions: ItemSessionView[];
  }
  export interface ItemRunView {
    runId: string;
    state: Run['state'];
    pipeline: string;
    createdAt: string;
    updatedAt: string;
    result?: Run['result'];
  }
  export interface ItemSessionView {
    sessionId: string;
    runId: string;
    startedAt: string;
    lastActivityAt: string;
    title?: string;
    status?: string;
    transcriptGcsUri?: string;
  }
  export function latestRun(runs: readonly Run[]): Run | undefined; // by createdAt desc, then runId
  export function toItemView(input: {
    workId: string;
    task: Task;
    runs: readonly Run[];
    sessions?: readonly ItemSessionView[];
  }): ItemView;
  ```

  `toItemView` throws if `task.work` fails `workPayloadSchema` (a native task always has one).

- [ ] **Step 1: Write the failing test**

```ts
// libs/work/src/derive.spec.ts
import type { Run, Task } from '@agent-lcars/orchestrator';
import { describe, expect, it } from 'vitest';

import { deriveItemState, latestRun, toItemView } from './derive';

const T = '2026-08-26T10:00:00.000Z';
const WORK_ID = '01J5Z3K9QX8F0N2B4V6C8D1E3G';
const payload = {
  origin: { principal: 'user:jlapenna', channel: 'api' as const },
  spec: {
    title: 't',
    description: 'd',
    pipeline: 'claude' as const,
    target: { repo: 'octo/example' },
  },
};

function run(n: number, state: Run['state'], extra: Partial<Run> = {}): Run {
  return {
    runId: `work:${WORK_ID}/r${n}`,
    task: { workId: WORK_ID },
    state,
    pipeline: 'claude',
    requestId: `r${n}`,
    leaseExpiresAt: T,
    events: [],
    createdAt: `2026-08-26T10:0${n}:00.000Z`,
    updatedAt: T,
    ...extra,
  };
}
function task(extra: Partial<Task> = {}): Task {
  return {
    task: { workId: WORK_ID },
    runCount: 1,
    updatedAt: T,
    work: payload,
    ...extra,
  };
}

describe('deriveItemState', () => {
  it.each([
    [
      'closedAt set',
      task({ closedAt: T }),
      [run(1, 'finished', { result: { ok: true } })],
      'canceled',
    ],
    ['latest run canceled', task(), [run(1, 'canceled')], 'canceled'],
    [
      'live run',
      task(),
      [run(1, 'finished', { result: { ok: false } }), run(2, 'pending')],
      'running',
    ],
    [
      'finished ok',
      task(),
      [run(1, 'finished', { result: { ok: true } })],
      'done',
    ],
    [
      'finished not ok',
      task(),
      [run(1, 'finished', { result: { ok: false } })],
      'parked',
    ],
    [
      'lost, budget spent',
      task({ consecutiveLost: 3 }),
      [run(1, 'lost')],
      'parked',
    ],
    [
      'lost, budget left',
      task({ consecutiveLost: 1 }),
      [run(1, 'lost')],
      'running',
    ],
    ['no runs yet', task(), [], 'running'],
  ] as const)('%s → %s', (_name, t, runs, expected) => {
    expect(deriveItemState(t, runs)).toBe(expected);
  });
});

describe('latestRun', () => {
  it('picks the newest by createdAt', () => {
    expect(
      latestRun([run(1, 'finished'), run(3, 'lost'), run(2, 'canceled')])
        ?.runId,
    ).toBe(`work:${WORK_ID}/r3`);
  });
});

describe('toItemView', () => {
  it('projects task, runs, and sessions', () => {
    const view = toItemView({
      workId: WORK_ID,
      task: task(),
      runs: [
        run(1, 'finished', {
          result: { ok: true, ref: 'https://github.com/octo/example/pull/9' },
        }),
      ],
      sessions: [
        {
          sessionId: 's1',
          runId: `work:${WORK_ID}/r1`,
          startedAt: T,
          lastActivityAt: T,
        },
      ],
    });
    expect(view.state).toBe('done');
    expect(view.spec.title).toBe('t');
    expect(view.runs[0]?.result?.ref).toContain('/pull/9');
    expect(view.sessions).toHaveLength(1);
  });

  it('throws when the task carries no valid work payload', () => {
    expect(() =>
      toItemView({
        workId: WORK_ID,
        task: task({ work: undefined }),
        runs: [],
      }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `./tools/nx test @agent-lcars/work -- derive` → FAIL, module missing.

- [ ] **Step 3: Implement**

```ts
// libs/work/src/derive.ts
import {
  isLive,
  MAX_AUTO_RETRIES,
  type Run,
  type Task,
} from '@agent-lcars/orchestrator';

import { type WorkOrigin, workPayloadSchema, type WorkSpec } from './spec';

export type ItemState = 'running' | 'done' | 'parked' | 'canceled';

/** Newest run first: createdAt descending, runId as a stable tiebreak. */
export function latestRun(runs: readonly Run[]): Run | undefined {
  return [...runs].sort(
    (a, b) =>
      b.createdAt.localeCompare(a.createdAt) || b.runId.localeCompare(a.runId),
  )[0];
}

/**
 * Item state is never stored; it is read off the task and its latest run.
 * First match wins, in the order the design spec's table lists them.
 */
export function deriveItemState(
  task: Pick<Task, 'closedAt' | 'consecutiveLost'>,
  runs: readonly Run[],
): ItemState {
  const latest = latestRun(runs);
  if (task.closedAt !== undefined || latest?.state === 'canceled')
    return 'canceled';
  if (latest === undefined) return 'running';
  if (isLive(latest.state)) return 'running';
  if (latest.state === 'finished') return latest.result?.ok ? 'done' : 'parked';
  // lost: the sweep retries until the budget is spent, then leaves it.
  return (task.consecutiveLost ?? 0) > MAX_AUTO_RETRIES ? 'parked' : 'running';
}

export interface ItemRunView {
  runId: string;
  state: Run['state'];
  pipeline: string;
  createdAt: string;
  updatedAt: string;
  result?: Run['result'];
}

export interface ItemSessionView {
  sessionId: string;
  runId: string;
  startedAt: string;
  lastActivityAt: string;
  title?: string;
  status?: string;
  transcriptGcsUri?: string;
}

export interface ItemView {
  id: string;
  state: ItemState;
  spec: WorkSpec;
  origin: WorkOrigin;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
  runs: ItemRunView[];
  sessions: ItemSessionView[];
}

export function toItemView(input: {
  workId: string;
  task: Task;
  runs: readonly Run[];
  sessions?: readonly ItemSessionView[];
}): ItemView {
  const payload = workPayloadSchema.parse(input.task.work);
  const runs = [...input.runs].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );
  return {
    id: input.workId,
    state: deriveItemState(input.task, input.runs),
    spec: payload.spec,
    origin: payload.origin,
    createdAt: runs[0]?.createdAt ?? input.task.updatedAt,
    updatedAt: input.task.updatedAt,
    ...(input.task.closedAt === undefined
      ? {}
      : { closedAt: input.task.closedAt }),
    runs: runs.map((r) => ({
      runId: r.runId,
      state: r.state,
      pipeline: r.pipeline,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      ...(r.result === undefined ? {} : { result: r.result }),
    })),
    sessions: [...(input.sessions ?? [])],
  };
}
```

Add `export * from './derive';` to `libs/work/src/index.ts`.

- [ ] **Step 4: Run tests + typecheck** — `./tools/nx run-many -t test typecheck -p @agent-lcars/work` → PASS. Confirm the lib's dependency graph stays clean: `./tools/nx graph --focus=@agent-lcars/work --print` (or `pnpm lint:circular`) shows `work → orchestrator, dispatch-contracts` and no cycle.

- [ ] **Step 5: Commit**

```bash
git add libs/work
git commit -m "feat(work): derived item state and item view

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: The oRPC contract and the checked-in OpenAPI document

**Files:**

- Create: `libs/work/src/contract.ts`, `libs/work/src/openapi.ts`
- Create: `tools/work-openapi.mjs`, `docs/api/work-v1.openapi.json`
- Modify: `libs/work/src/index.ts`, `package.json` (script `work:openapi`), `libs/work/project.json` (target `openapi-check`), `.github/workflows/ci.yml` (`Verify` runs the check)
- Test: `libs/work/src/contract.spec.ts`

**Interfaces:**

- Consumes: Task 2's schemas, Task 3's `ItemView` types; `WORK_ID_RE` from `@agent-lcars/orchestrator`.
- Produces:

  ```ts
  export const workIdSchema = z.string().regex(WORK_ID_RE);
  export const itemViewSchema  // zod mirror of ItemView (strict objects; result = { ok, summary?, ref? })
  export const itemsContract = {
    create: PUT /items/{id}   input { id, spec }            output itemViewSchema   errors FORBIDDEN, TOO_MANY_REQUESTS, CONFLICT
    get:    GET /items/{id}   input { id }                  output itemViewSchema   errors NOT_FOUND
    list:   GET /items        input { state?, principal?, repo?, limit? } output { items: itemViewSchema[] }
    cancel: POST /items/{id}/cancel     input { id }        output itemViewSchema   errors NOT_FOUND, CONFLICT
    redispatch: POST /items/{id}/redispatch input { id }    output itemViewSchema   errors NOT_FOUND, CONFLICT, TOO_MANY_REQUESTS
  }
  export type ItemsContract = typeof itemsContract;
  export async function generateWorkOpenApi(): Promise<object>
  ```

- [ ] **Step 1: Write the failing test**

```ts
// libs/work/src/contract.spec.ts
import { describe, expect, it } from 'vitest';

import { itemsContract } from './contract';
import { generateWorkOpenApi } from './openapi';

describe('itemsContract', () => {
  it('declares the five item procedures', () => {
    expect(Object.keys(itemsContract).sort()).toEqual([
      'cancel',
      'create',
      'get',
      'list',
      'redispatch',
    ]);
  });
});

describe('generateWorkOpenApi', () => {
  it('emits the five REST routes under /items with bearer security', async () => {
    const doc = (await generateWorkOpenApi()) as {
      openapi: string;
      paths: Record<string, Record<string, unknown>>;
      components: { securitySchemes?: Record<string, unknown> };
    };
    expect(doc.openapi).toMatch(/^3\./);
    expect(Object.keys(doc.paths).sort()).toEqual([
      '/items',
      '/items/{id}',
      '/items/{id}/cancel',
      '/items/{id}/redispatch',
    ]);
    expect(Object.keys(doc.paths['/items/{id}'] ?? {}).sort()).toEqual([
      'get',
      'put',
    ]);
    expect(doc.components.securitySchemes).toHaveProperty('bearerAuth');
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `./tools/nx test @agent-lcars/work -- contract` → FAIL.

- [ ] **Step 3: Implement the contract**

```ts
// libs/work/src/contract.ts
import { WORK_ID_RE } from '@agent-lcars/orchestrator';
import { oc } from '@orpc/contract';
import { openapi } from '@orpc/openapi';
import { z } from 'zod';

import { workOriginSchema, workSpecSchema } from './spec';

export const workIdSchema = z.string().regex(WORK_ID_RE);

const runResultSchema = z.strictObject({
  ok: z.boolean(),
  summary: z.string().max(4_096).optional(),
  ref: z.string().max(1_024).optional(),
});

export const itemRunViewSchema = z.strictObject({
  runId: z.string(),
  state: z.enum(['pending', 'running', 'finished', 'canceled', 'lost']),
  pipeline: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  result: runResultSchema.optional(),
});

export const itemSessionViewSchema = z.strictObject({
  sessionId: z.string(),
  runId: z.string(),
  startedAt: z.string(),
  lastActivityAt: z.string(),
  title: z.string().optional(),
  status: z.string().optional(),
  transcriptGcsUri: z.string().optional(),
});

export const itemStateSchema = z.enum([
  'running',
  'done',
  'parked',
  'canceled',
]);

export const itemViewSchema = z.strictObject({
  id: workIdSchema,
  state: itemStateSchema,
  spec: workSpecSchema,
  origin: workOriginSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  closedAt: z.string().optional(),
  runs: z.array(itemRunViewSchema),
  sessions: z.array(itemSessionViewSchema),
});

const bearer = { security: [{ bearerAuth: [] }] };
const withBearer = <T extends object>(current: T) => ({
  ...current,
  ...bearer,
});

const base = oc.meta(openapi({ tags: ['items'], spec: withBearer }));

export const itemsContract = {
  create: base
    .meta(
      openapi({
        method: 'PUT',
        path: '/items/{id}',
        operationId: 'createItem',
        summary: 'Create a work item (idempotent by client ULID)',
      }),
    )
    .errors({
      FORBIDDEN: { message: 'Principal may not request this pipeline' },
      TOO_MANY_REQUESTS: {
        message: 'Fleet is at its live-run cap',
        data: z.object({ retryAfterSeconds: z.number() }),
      },
      CONFLICT: { message: 'Item exists with a different spec' },
    })
    .input(z.strictObject({ id: workIdSchema, spec: workSpecSchema }))
    .output(itemViewSchema),
  get: base
    .meta(
      openapi({
        method: 'GET',
        path: '/items/{id}',
        operationId: 'getItem',
        summary: 'Read a work item',
      }),
    )
    .errors({ NOT_FOUND: { message: 'No such item' } })
    .input(z.strictObject({ id: workIdSchema }))
    .output(itemViewSchema),
  list: base
    .meta(
      openapi({
        method: 'GET',
        path: '/items',
        operationId: 'listItems',
        summary: 'List work items',
      }),
    )
    .input(
      z.strictObject({
        state: itemStateSchema.optional(),
        principal: z.string().max(128).optional(),
        repo: z.string().max(256).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      }),
    )
    .output(z.strictObject({ items: z.array(itemViewSchema) })),
  cancel: base
    .meta(
      openapi({
        method: 'POST',
        path: '/items/{id}/cancel',
        operationId: 'cancelItem',
        summary: 'Cancel a work item',
      }),
    )
    .errors({
      NOT_FOUND: { message: 'No such item' },
      CONFLICT: { message: 'Item already settled' },
    })
    .input(z.strictObject({ id: workIdSchema }))
    .output(itemViewSchema),
  redispatch: base
    .meta(
      openapi({
        method: 'POST',
        path: '/items/{id}/redispatch',
        operationId: 'redispatchItem',
        summary: 'Mint a fresh run for a parked item',
      }),
    )
    .errors({
      NOT_FOUND: { message: 'No such item' },
      CONFLICT: { message: 'Only a parked item can be redispatched' },
      TOO_MANY_REQUESTS: {
        message: 'Fleet is at its live-run cap',
        data: z.object({ retryAfterSeconds: z.number() }),
      },
    })
    .input(z.strictObject({ id: workIdSchema }))
    .output(itemViewSchema),
};
export type ItemsContract = typeof itemsContract;
```

```ts
// libs/work/src/openapi.ts
import { OpenAPIGenerator } from '@orpc/openapi';
import { ZodToJsonSchemaConverter } from '@orpc/zod/zod4';

import { itemsContract } from './contract';

/** The document `docs/api/work-v1.openapi.json` is generated from. */
export async function generateWorkOpenApi(): Promise<object> {
  const generator = new OpenAPIGenerator({
    converters: [new ZodToJsonSchemaConverter()],
  });
  return generator.generate(itemsContract, {
    base: {
      info: { title: 'Agent LCARS work items', version: '1' },
      servers: [{ url: '/api/work/v1' }],
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        },
      },
    },
  });
}
```

Use the import paths Task 1's report recorded if they differ. Add `export * from './contract'; export * from './openapi';` to `index.ts`.

- [ ] **Step 4: Generator script, checked-in document, CI check**

```js
// tools/work-openapi.mjs
// Usage: node tools/work-openapi.mjs [--check]
// Writes docs/api/work-v1.openapi.json from the contract, or with --check
// exits 1 when the checked-in file differs (CI).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const OUT = 'docs/api/work-v1.openapi.json';
const { generateWorkOpenApi } =
  await import('../dist/libs/work/index.js').catch(
    async () => import('../libs/work/src/index.ts'),
  );
const next = `${JSON.stringify(await generateWorkOpenApi(), null, 2)}\n`;
if (process.argv.includes('--check')) {
  const current = readFileSync(OUT, 'utf8');
  if (current !== next) {
    console.error(`${OUT} is stale; run: pnpm work:openapi`);
    process.exit(1);
  }
  console.log(`${OUT} is current`);
} else {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, next);
  console.log(`wrote ${OUT}`);
}
```

The `.ts` fallback import requires a TS-capable runner; wire the script through the same mechanism other `tools/*.mjs` scripts use to load workspace TS (check `tools/` for a precedent such as `tsx` or a built `dist` — pick whichever `package.json`'s existing scripts already rely on and state it in the report). Add to root `package.json` scripts: `"work:openapi": "node tools/work-openapi.mjs"`. Add to `libs/work/project.json` a target `openapi-check` (`nx:run-commands`, `node tools/work-openapi.mjs --check`, `cwd: {workspaceRoot}`), and to `.github/workflows/ci.yml`'s `Verify` job a step `- run: ./tools/nx run @agent-lcars/work:openapi-check` next to the Plan 1 emulator step. Generate the file: `pnpm work:openapi`.

- [ ] **Step 5: Run** — `./tools/nx run-many -t test typecheck -p @agent-lcars/work && node tools/work-openapi.mjs --check` → PASS / `is current`.

- [ ] **Step 6: Commit and push**

```bash
git add libs/work tools/work-openapi.mjs docs/api package.json .github/workflows/ci.yml
git commit -m "feat(work): oRPC contract for items and the checked-in OpenAPI document

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git push
```

---

### Task 5: Grants, environment, and the auth gate

**Files:**

- Modify: `libs/env-vars/src/env-vars.ts` (three keys), `apps/console/apphosting.yaml` (three entries, non-secret), `docs/deployment-boundary.md` (document them)
- Create: `apps/console/src/lib/work-grants.ts`, `apps/console/src/lib/work-auth.ts`
- Modify: `apps/console/src/auth.ts` (session callback), `apps/console/src/types/next-auth.d.ts`
- Test: `apps/console/src/lib/work-grants.test.ts`, `apps/console/src/lib/work-auth.test.ts`

**Interfaces:**

- Produces:

  ```ts
  // work-grants.ts
  export interface WorkGrant {
    principal: string;
    subjects: string[];
    pipelines: string[];
  }
  export function parseWorkGrants(raw: string | undefined): WorkGrant[]; // zod-validated JSON; [] when unset
  export function workGrants(): WorkGrant[]; // from process.env.AGENT_LCARS_WORK_GRANTS, cached
  export function resolvePrincipal(
    subject: string,
    grants?: WorkGrant[],
  ): WorkGrant | undefined;
  export function workMaxLiveRuns(): number; // AGENT_LCARS_WORK_MAX_LIVE_RUNS, default 4
  // work-auth.ts
  export interface WorkPrincipal {
    principal: string;
    subject: string;
    scopes: ReadonlySet<'work.operator'>;
    pipelines: readonly string[];
    via: 'google' | 'session';
  }
  export interface WorkAuthDeps {
    verifyGoogleIdToken: (
      token: string,
    ) => Promise<{ email: string; emailVerified: boolean }>;
    session: () => Promise<{ user?: { login?: string } } | null>;
    grants: () => WorkGrant[];
  }
  export async function authenticateWorkRequest(
    request: Request,
    deps: WorkAuthDeps,
  ): Promise<WorkPrincipal | undefined>;
  export function googleIdTokenVerifier(
    audience: string,
  ): WorkAuthDeps['verifyGoogleIdToken']; // jose + createRemoteJWKSet('https://www.googleapis.com/oauth2/v3/certs'), issuer 'https://accounts.google.com'
  ```

  Bearer path: `Authorization: Bearer <jwt>` → verify → subject = `email` (must be `email_verified`) → `resolvePrincipal(email)`; session path (no bearer header): `session()?.user?.login` → subject `github:<login>` → `resolvePrincipal`. Unknown subject → `undefined`.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/console/src/lib/work-grants.test.ts
import { describe, expect, it } from 'vitest';

import { parseWorkGrants, resolvePrincipal } from './work-grants';

const raw = JSON.stringify([
  {
    principal: 'user:jlapenna',
    subjects: [
      'jlapenna-work@agent-lcars.iam.gserviceaccount.com',
      'github:jlapenna',
    ],
    pipelines: ['claude', 'codex'],
  },
  {
    principal: 'svc:lcars-admin',
    subjects: ['lcars-admin@agent-lcars.iam.gserviceaccount.com'],
    pipelines: ['claude'],
  },
]);

describe('parseWorkGrants', () => {
  it('parses a valid list and returns [] when unset', () => {
    expect(parseWorkGrants(raw)).toHaveLength(2);
    expect(parseWorkGrants(undefined)).toEqual([]);
  });
  it('rejects malformed entries loudly', () => {
    expect(() => parseWorkGrants('[{"principal":"x"}]')).toThrow();
    expect(() => parseWorkGrants('not json')).toThrow();
  });
});

describe('resolvePrincipal', () => {
  const grants = parseWorkGrants(raw);
  it('maps any listed subject to its principal', () => {
    expect(resolvePrincipal('github:jlapenna', grants)?.principal).toBe(
      'user:jlapenna',
    );
    expect(
      resolvePrincipal(
        'jlapenna-work@agent-lcars.iam.gserviceaccount.com',
        grants,
      )?.principal,
    ).toBe('user:jlapenna');
  });
  it('is case-insensitive on subjects and unknown → undefined', () => {
    expect(resolvePrincipal('GitHub:JLapenna', grants)?.principal).toBe(
      'user:jlapenna',
    );
    expect(resolvePrincipal('nobody@example.com', grants)).toBeUndefined();
  });
});
```

```ts
// apps/console/src/lib/work-auth.test.ts
import { describe, expect, it } from 'vitest';

import { authenticateWorkRequest, type WorkAuthDeps } from './work-auth';
import { parseWorkGrants } from './work-grants';

const grants = parseWorkGrants(
  JSON.stringify([
    {
      principal: 'user:jlapenna',
      subjects: ['sa@example.iam.gserviceaccount.com', 'github:jlapenna'],
      pipelines: ['claude'],
    },
  ]),
);
function deps(over: Partial<WorkAuthDeps> = {}): WorkAuthDeps {
  return {
    verifyGoogleIdToken: async () => ({
      email: 'sa@example.iam.gserviceaccount.com',
      emailVerified: true,
    }),
    session: async () => null,
    grants: () => grants,
    ...over,
  };
}
const req = (headers: Record<string, string> = {}) =>
  new Request('https://lcars.test/api/work/v1/items', { headers });

describe('authenticateWorkRequest', () => {
  it('maps a verified Google service-account token to its principal', async () => {
    const p = await authenticateWorkRequest(
      req({ authorization: 'Bearer t' }),
      deps(),
    );
    expect(p).toMatchObject({
      principal: 'user:jlapenna',
      via: 'google',
      pipelines: ['claude'],
    });
    expect(p?.scopes.has('work.operator')).toBe(true);
  });
  it('refuses an unverified email and an unknown subject', async () => {
    expect(
      await authenticateWorkRequest(
        req({ authorization: 'Bearer t' }),
        deps({
          verifyGoogleIdToken: async () => ({
            email: 'sa@example.iam.gserviceaccount.com',
            emailVerified: false,
          }),
        }),
      ),
    ).toBeUndefined();
    expect(
      await authenticateWorkRequest(
        req({ authorization: 'Bearer t' }),
        deps({
          verifyGoogleIdToken: async () => ({
            email: 'other@x.io',
            emailVerified: true,
          }),
        }),
      ),
    ).toBeUndefined();
  });
  it('returns undefined when the token fails verification', async () => {
    expect(
      await authenticateWorkRequest(
        req({ authorization: 'Bearer bad' }),
        deps({
          verifyGoogleIdToken: async () => {
            throw new Error('bad');
          },
        }),
      ),
    ).toBeUndefined();
  });
  it('maps an Auth.js session to github:<login>', async () => {
    const p = await authenticateWorkRequest(
      req(),
      deps({ session: async () => ({ user: { login: 'jlapenna' } }) }),
    );
    expect(p).toMatchObject({
      principal: 'user:jlapenna',
      via: 'session',
      subject: 'github:jlapenna',
    });
  });
  it('a bearer header wins over a session and never falls back to it', async () => {
    const p = await authenticateWorkRequest(
      req({ authorization: 'Bearer t' }),
      deps({
        verifyGoogleIdToken: async () => {
          throw new Error('bad');
        },
        session: async () => ({ user: { login: 'jlapenna' } }),
      }),
    );
    expect(p).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify they fail** — `./tools/nx test @agent-lcars/console -- work-grants work-auth` → FAIL, modules missing.

- [ ] **Step 3: Implement**

`libs/env-vars/src/env-vars.ts` — add, in alphabetical position among the `AGENT_LCARS_*` keys:

```ts
  /** Audience the `lcars` CLI requests on Google ID tokens; the work API
   *  rejects any other audience. */
  AGENT_LCARS_WORK_AUDIENCE?: string;
  /** JSON grant list: [{ principal, subjects[], pipelines[] }]. */
  AGENT_LCARS_WORK_GRANTS?: string;
  /** Global live-run cap for native work items (default 4). */
  AGENT_LCARS_WORK_MAX_LIVE_RUNS?: string;
```

`apps/console/apphosting.yaml` — add three `- variable:` entries next to `AGENT_LCARS_ADMIN_GITHUB_LOGINS`, following that entry's exact shape (availability list, `value:` placeholder or omitted as that file does for optional vars); document them in `docs/deployment-boundary.md`'s environment table.

```ts
// apps/console/src/lib/work-grants.ts
import 'server-only';

import { z } from 'zod';

const grantSchema = z.strictObject({
  principal: z.string().min(1).max(128),
  subjects: z.array(z.string().min(1).max(256)).min(1),
  pipelines: z.array(z.string().min(1).max(64)).min(1),
});
const grantsSchema = z.array(grantSchema);

export type WorkGrant = z.infer<typeof grantSchema>;

export function parseWorkGrants(raw: string | undefined): WorkGrant[] {
  if (raw === undefined || raw.trim() === '') return [];
  return grantsSchema.parse(JSON.parse(raw));
}

let cached: WorkGrant[] | undefined;
export function workGrants(): WorkGrant[] {
  cached ??= parseWorkGrants(process.env['AGENT_LCARS_WORK_GRANTS']);
  return cached;
}

/** Subjects are compared case-insensitively (emails and GitHub logins are). */
export function resolvePrincipal(
  subject: string,
  grants: WorkGrant[] = workGrants(),
): WorkGrant | undefined {
  const needle = subject.toLowerCase();
  return grants.find((g) => g.subjects.some((s) => s.toLowerCase() === needle));
}

export function workMaxLiveRuns(): number {
  const raw = process.env['AGENT_LCARS_WORK_MAX_LIVE_RUNS'];
  if (raw === undefined || raw === '') return 4;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1)
    throw new Error(
      'AGENT_LCARS_WORK_MAX_LIVE_RUNS must be a positive integer',
    );
  return n;
}

export function _resetWorkGrantsForTesting(): void {
  cached = undefined;
}
```

```ts
// apps/console/src/lib/work-auth.ts
import 'server-only';

import { createRemoteJWKSet, jwtVerify } from 'jose';

import { resolvePrincipal, type WorkGrant } from './work-grants';

export type WorkScope = 'work.operator';

export interface WorkPrincipal {
  principal: string;
  subject: string;
  scopes: ReadonlySet<WorkScope>;
  pipelines: readonly string[];
  via: 'google' | 'session';
}

export interface WorkAuthDeps {
  verifyGoogleIdToken: (
    token: string,
  ) => Promise<{ email: string; emailVerified: boolean }>;
  session: () => Promise<{ user?: { login?: string } } | null>;
  grants: () => WorkGrant[];
}

const GOOGLE_ISSUER = 'https://accounts.google.com';
const googleJwks = createRemoteJWKSet(
  new URL('https://www.googleapis.com/oauth2/v3/certs'),
);

/** A Google-signed ID token for our audience. Service-account identity
 *  tokens (impersonated or direct) carry `email` + `email_verified`. */
export function googleIdTokenVerifier(
  audience: string,
): WorkAuthDeps['verifyGoogleIdToken'] {
  return async (token) => {
    const { payload } = await jwtVerify(token, googleJwks, {
      issuer: GOOGLE_ISSUER,
      audience,
    });
    return {
      email: typeof payload['email'] === 'string' ? payload['email'] : '',
      emailVerified: payload['email_verified'] === true,
    };
  };
}

function principalFor(
  subject: string,
  via: WorkPrincipal['via'],
  grants: WorkGrant[],
): WorkPrincipal | undefined {
  const grant = resolvePrincipal(subject, grants);
  if (grant === undefined) return undefined;
  return {
    principal: grant.principal,
    subject,
    scopes: new Set<WorkScope>(['work.operator']),
    pipelines: grant.pipelines,
    via,
  };
}

/**
 * Bearer token first; an Auth.js session only when no bearer header is
 * present. A bearer that fails never falls back to the session -- a
 * caller that presented a credential gets judged on it.
 */
export async function authenticateWorkRequest(
  request: Request,
  deps: WorkAuthDeps,
): Promise<WorkPrincipal | undefined> {
  const header = request.headers.get('authorization');
  if (header !== null) {
    const match = /^Bearer\s+(\S+)$/iu.exec(header);
    if (match === null) return undefined;
    try {
      const { email, emailVerified } = await deps.verifyGoogleIdToken(
        match[1] ?? '',
      );
      if (!emailVerified || email === '') return undefined;
      return principalFor(email, 'google', deps.grants());
    } catch {
      return undefined;
    }
  }
  const login = (await deps.session())?.user?.login;
  return login === undefined
    ? undefined
    : principalFor(`github:${login}`, 'session', deps.grants());
}
```

`apps/console/src/auth.ts` session callback — add `session.user.login = token.githubLogin;` (one line, next to `isAdmin`), and in `apps/console/src/types/next-auth.d.ts` add `login?: string;` to both `User` and `Session['user']`.

- [ ] **Step 4: Run** — `./tools/nx test @agent-lcars/console -- work-grants work-auth auth && ./tools/nx typecheck @agent-lcars/console @agent-lcars/env` → PASS. (The env registry cascade: an unregistered key breaks typecheck across the console — run the console typecheck, not just the lib's.)

- [ ] **Step 5: Commit**

```bash
git add libs/env-vars apps/console/apphosting.yaml docs/deployment-boundary.md apps/console/src
git commit -m "feat(console): work grants and the work API auth gate

Google service-account ID tokens or an Auth.js session map to a principal
through the grant list; nothing else yields work.operator.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Router implementation, route mount, proxy allow-list, session join

**Files:**

- Modify: `libs/telemetry/src/server/store.ts` (`ListSessionDocsOptions.intentId`)
- Create: `apps/console/src/lib/work-router.ts`, `apps/console/src/lib/work-sessions.ts`
- Create: `apps/console/src/app/api/work/v1/[[...rest]]/route.ts`
- Modify: `apps/console/src/proxy.ts` (`publicPrefixes`), `apps/console/src/proxy.test.ts`
- Test: `apps/console/src/lib/work-router.test.ts`, `libs/telemetry/src/server/store.spec.ts` (extend)

**Interfaces:**

- Consumes: `itemsContract`, `toItemView`, `deriveItemState`, `workPayloadSchema` (`@agent-lcars/work`); `Orchestrator`, `isRefusal`, `decidedRun`, `isLive`, `WORK_ID_RE` (`@agent-lcars/orchestrator`); `WorkPrincipal`, `authenticateWorkRequest`, `googleIdTokenVerifier`, `workMaxLiveRuns`; `createOrchestratorRuntime()` (`OrchestratorRouteDeps` with `store`, `orchestrator`, `drain`); `isControlPlaneRepository`; `listSessionDocs` (+ `intentId`).
- Produces:

  ```ts
  // work-router.ts
  export interface WorkContext {
    principal?: WorkPrincipal;
    runtime: OrchestratorRouteDeps;
    sessionsFor: (runIds: string[]) => Promise<ItemSessionView[]>;
    maxLiveRuns: number;
  }
  export const workRouter; // implement(itemsContract).$context<WorkContext>() with requireOperator on every procedure
  export function createWorkHandler(): OpenAPIHandler<WorkContext>;
  // work-sessions.ts
  export async function sessionsForRuns(
    runIds: string[],
  ): Promise<ItemSessionView[]>;
  ```

  Procedure semantics (spec "items" table): `create` — validate pipeline grant (`FORBIDDEN`), read task (`200` existing view; `CONFLICT` if the stored spec differs), count live native runs ≥ cap → `TOO_MANY_REQUESTS` `{ retryAfterSeconds: 60 }`, else `orchestrator.request({ taskId: { workId }, requestId: id, pipeline, work: { origin: { principal, channel: via === 'session' ? 'console' : 'api' }, spec } })`, `drain()`, return view. `get` — `NOT_FOUND` when no task. `list` — `store.listNativeTasks(filter)` (add to `OrchestratorStore`: `listTasks(filter: { anchor: 'work' })` returning `VersionedTask[]` — implement in both stores; Firestore: `where('task.task.workId', '>=', '')` or a dedicated `anchorKind` field written by Plan 1's `requestRun`… **ruling for the implementer:** add `kind: 'work'` to the task document at write time is a schema change; prefer the query on `task.task.workId` existence via `orderBy('task.task.workId')` which excludes documents lacking the field). `cancel` — derived `done`/`canceled` → `CONFLICT`; live run → `orchestrator.cancel(run.runId)`; `parked` → `orchestrator.close`. `redispatch` — derived not `parked` → `CONFLICT`; cap check; `orchestrator.request({ taskId, requestId: \`${id}:${task.runCount + 1}\`, pipeline, ... })`; `drain()`.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/console/src/lib/work-router.test.ts
import { MemoryStore, Orchestrator } from '@agent-lcars/orchestrator';
import { describe, expect, it } from 'vitest';

import { createWorkHandler, type WorkContext } from './work-router';

const ID = '01J5Z3K9QX8F0N2B4V6C8D1E3G';
const spec = {
  title: 't',
  description: 'd',
  pipeline: 'claude',
  target: { repo: 'jlapenna/agent-lcars' },
};
const operator = {
  principal: 'user:jlapenna',
  subject: 'github:jlapenna',
  scopes: new Set(['work.operator'] as const),
  pipelines: ['claude'],
  via: 'session' as const,
};

function context(over: Partial<WorkContext> = {}): WorkContext {
  const store = new MemoryStore();
  const orchestrator = new Orchestrator(store, {
    now: () => '2026-08-26T10:00:00.000Z',
  });
  return {
    principal: operator,
    runtime: {
      store,
      orchestrator,
      drain: async () => ({ dispatched: [], failed: [] }),
      settleTerminal: async () => ({}),
    } as unknown as WorkContext['runtime'],
    sessionsFor: async () => [],
    maxLiveRuns: 4,
    ...over,
  };
}
async function call(
  ctx: WorkContext,
  method: string,
  path: string,
  body?: unknown,
) {
  const handler = createWorkHandler();
  const { response } = await handler.handle(
    new Request(`https://lcars.test/api/work/v1${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { prefix: '/api/work/v1', context: ctx },
  );
  return {
    status: response?.status,
    json: response ? await response.json() : undefined,
  };
}

describe('items routes', () => {
  it('refuses every route without a principal', async () => {
    const ctx = context({ principal: undefined });
    for (const [m, p, b] of [
      ['PUT', `/items/${ID}`, { spec }],
      ['GET', `/items/${ID}`],
      ['GET', '/items'],
      ['POST', `/items/${ID}/cancel`],
      ['POST', `/items/${ID}/redispatch`],
    ] as const) {
      const r = await call(ctx, m, p, b);
      expect(r.status, `${m} ${p}`).toBe(401);
    }
  });

  it('creates an item, returns 201 then 200 on replay, and derives running', async () => {
    const ctx = context();
    const first = await call(ctx, 'PUT', `/items/${ID}`, { spec });
    expect(first.status).toBe(201);
    expect(first.json).toMatchObject({
      id: ID,
      state: 'running',
      origin: { principal: 'user:jlapenna', channel: 'console' },
    });
    const again = await call(ctx, 'PUT', `/items/${ID}`, { spec });
    expect(again.status).toBe(200);
    expect(again.json.runs).toHaveLength(1);
  });

  it('refuses a pipeline outside the grant with 403', async () => {
    const r = await call(context(), 'PUT', `/items/${ID}`, {
      spec: { ...spec, pipeline: 'codex' },
    });
    expect(r.status).toBe(403);
  });

  it('enforces the global live-run cap with 429', async () => {
    const ctx = context({ maxLiveRuns: 1 });
    await call(ctx, 'PUT', `/items/${ID}`, { spec });
    const r = await call(ctx, 'PUT', '/items/01J5Z3K9QX8F0N2B4V6C8D1E3H', {
      spec,
    });
    expect(r.status).toBe(429);
    expect(r.json).toMatchObject({ data: { retryAfterSeconds: 60 } });
  });

  it('cancels a running item and then refuses a second cancel', async () => {
    const ctx = context();
    await call(ctx, 'PUT', `/items/${ID}`, { spec });
    const c1 = await call(ctx, 'POST', `/items/${ID}/cancel`);
    expect(c1.status).toBe(200);
    expect(c1.json.state).toBe('canceled');
    expect((await call(ctx, 'POST', `/items/${ID}/cancel`)).status).toBe(409);
  });

  it('redispatches only a parked item', async () => {
    const ctx = context();
    await call(ctx, 'PUT', `/items/${ID}`, { spec });
    expect((await call(ctx, 'POST', `/items/${ID}/redispatch`)).status).toBe(
      409,
    );
    await ctx.runtime.orchestrator.report(`work:${ID}/r1`, {
      ok: false,
      summary: 'blocked',
    });
    expect((await call(ctx, 'GET', `/items/${ID}`)).json.state).toBe('parked');
    const r = await call(ctx, 'POST', `/items/${ID}/redispatch`);
    expect(r.status).toBe(200);
    expect(r.json.runs).toHaveLength(2);
    expect(r.json.state).toBe('running');
  });

  it('lists native items only', async () => {
    const ctx = context();
    await call(ctx, 'PUT', `/items/${ID}`, { spec });
    await ctx.runtime.orchestrator.request({
      taskId: { repo: 'octo/example', issue: 7 },
      requestId: 'x',
      pipeline: 'claude',
    });
    const r = await call(ctx, 'GET', '/items');
    expect(r.json.items.map((i: { id: string }) => i.id)).toEqual([ID]);
  });
});
```

Extend `libs/telemetry/src/server/store.spec.ts` (it has an emulator-gated or fake-Firestore harness — follow whichever it uses) with one case: `listSessionDocs(firestore, { intentId: 'work:X/r1' })` returns only docs whose `intentId` matches.

- [ ] **Step 2: Run to verify they fail** — `./tools/nx test @agent-lcars/console -- work-router` → FAIL.

- [ ] **Step 3: Implement**

`libs/telemetry/src/server/store.ts`: add `intentId?: string;` to `ListSessionDocsOptions` and, after the `issueNumber` filter, `if (options.intentId !== undefined) { query = query.where('intentId', '==', options.intentId); }`.

```ts
// apps/console/src/lib/work-sessions.ts
import 'server-only';

import { listSessionDocs } from '@agent-lcars/telemetry/server';
import type { ItemSessionView } from '@agent-lcars/work';

import { getTelemetryFirestore } from './telemetry-firestore'; // whichever helper the console already uses to read sessions (see runner-sessions.ts) — reuse it, do not create a second client

export async function sessionsForRuns(
  runIds: string[],
): Promise<ItemSessionView[]> {
  const firestore = getTelemetryFirestore();
  const all = await Promise.all(
    runIds.map((intentId) =>
      listSessionDocs(firestore, { intentId, source: 'issue-agent' }),
    ),
  );
  return all.flat().map((doc) => ({
    sessionId: doc.sessionId,
    runId: doc.intentId ?? '',
    startedAt: doc.startedAt,
    lastActivityAt: doc.lastActivityAt,
    ...(doc.title === undefined ? {} : { title: doc.title }),
    ...(doc.status === undefined ? {} : { status: doc.status }),
    ...(doc.transcriptGcsUri === undefined
      ? {}
      : { transcriptGcsUri: doc.transcriptGcsUri }),
  }));
}
```

```ts
// apps/console/src/lib/work-router.ts
import 'server-only';

import {
  decidedRun,
  isLive,
  isRefusal,
  isWorkAnchor,
  type Task,
} from '@agent-lcars/orchestrator';
import {
  deriveItemState,
  type ItemSessionView,
  itemsContract,
  toItemView,
  type WorkSpec,
} from '@agent-lcars/work';
import { OpenAPIHandler } from '@orpc/openapi/fetch';
import { implement, ORPCError } from '@orpc/server';

import { isControlPlaneRepository } from './deployment';
import type { OrchestratorRouteDeps } from './orchestrator-routes';
import type { WorkPrincipal } from './work-auth';

export interface WorkContext {
  principal?: WorkPrincipal;
  runtime: OrchestratorRouteDeps;
  sessionsFor: (runIds: string[]) => Promise<ItemSessionView[]>;
  maxLiveRuns: number;
}

const os = implement(itemsContract).$context<WorkContext>();

/** Router-level gate: every procedure below is built from `operator`. */
const operator = os.use(async ({ context, next }) => {
  if (
    context.principal === undefined ||
    !context.principal.scopes.has('work.operator')
  ) {
    throw new ORPCError('UNAUTHORIZED', { message: 'work.operator required' });
  }
  return next({ context: { ...context, principal: context.principal } });
});

async function view(ctx: WorkContext, workId: string, task: Task) {
  const runs = await ctx.runtime.store.listRuns({ workId });
  const sessions = await ctx.sessionsFor(runs.map((r) => r.runId));
  return toItemView({ workId, task, runs, sessions });
}

async function liveNativeRunCount(ctx: WorkContext): Promise<number> {
  const live = await ctx.runtime.store.listLiveRuns();
  return live.filter((r) => isWorkAnchor(r.task)).length;
}

function assertPipelineGranted(principal: WorkPrincipal, pipeline: string) {
  if (!principal.pipelines.includes(pipeline)) {
    throw new ORPCError('FORBIDDEN', {
      message: `${principal.principal} may not request pipeline ${pipeline}`,
    });
  }
}

export const workRouter = os.router({
  create: operator.create.handler(async ({ input, context, errors }) => {
    const principal = context.principal!;
    assertPipelineGranted(principal, input.spec.pipeline);
    if (!isControlPlaneRepository(input.spec.target.repo)) {
      throw errors.FORBIDDEN({
        message: `${input.spec.target.repo} is not a control-plane repository`,
      });
    }
    const existing = await context.runtime.store.readTask({ workId: input.id });
    if (existing !== undefined) {
      return view(context, input.id, existing.task); // 200 via successStatus below
    }
    if ((await liveNativeRunCount(context)) >= context.maxLiveRuns) {
      throw errors.TOO_MANY_REQUESTS({ data: { retryAfterSeconds: 60 } });
    }
    const outcome = await context.runtime.orchestrator.request({
      taskId: { workId: input.id },
      requestId: input.id,
      pipeline: input.spec.pipeline,
      work: {
        origin: {
          principal: principal.principal,
          channel: principal.via === 'session' ? 'console' : 'api',
        },
        spec: input.spec satisfies WorkSpec,
      },
    });
    if (isRefusal(outcome)) throw errors.CONFLICT({ message: outcome.reason });
    await context.runtime.drain();
    return view(context, input.id, outcome.task);
  }),
  get: operator.get.handler(async ({ input, context, errors }) => {
    const t = await context.runtime.store.readTask({ workId: input.id });
    if (t === undefined) throw errors.NOT_FOUND();
    return view(context, input.id, t.task);
  }),
  list: operator.list.handler(async ({ input, context }) => {
    const tasks = await context.runtime.store.listNativeTasks();
    const items = await Promise.all(
      tasks.map(async ({ task }) =>
        isWorkAnchor(task.task)
          ? view(context, task.task.workId, task)
          : undefined,
      ),
    );
    return {
      items: items
        .filter((i): i is NonNullable<typeof i> => i !== undefined)
        .filter((i) => input.state === undefined || i.state === input.state)
        .filter(
          (i) =>
            input.principal === undefined ||
            i.origin.principal === input.principal,
        )
        .filter(
          (i) => input.repo === undefined || i.spec.target.repo === input.repo,
        )
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, input.limit),
    };
  }),
  cancel: operator.cancel.handler(async ({ input, context, errors }) => {
    const t = await context.runtime.store.readTask({ workId: input.id });
    if (t === undefined) throw errors.NOT_FOUND();
    const runs = await context.runtime.store.listRuns({ workId: input.id });
    const state = deriveItemState(t.task, runs);
    if (state === 'done' || state === 'canceled') throw errors.CONFLICT();
    const live = runs.find((r) => isLive(r.state));
    const outcome =
      live !== undefined
        ? await context.runtime.orchestrator.cancel(
            live.runId,
            `canceled by ${context.principal!.principal}`,
          )
        : await context.runtime.orchestrator.close({ workId: input.id });
    if (isRefusal(outcome)) throw errors.CONFLICT({ message: outcome.reason });
    await context.runtime.drain();
    return view(context, input.id, outcome.task);
  }),
  redispatch: operator.redispatch.handler(
    async ({ input, context, errors }) => {
      const t = await context.runtime.store.readTask({ workId: input.id });
      if (t === undefined) throw errors.NOT_FOUND();
      const runs = await context.runtime.store.listRuns({ workId: input.id });
      if (deriveItemState(t.task, runs) !== 'parked') throw errors.CONFLICT();
      if ((await liveNativeRunCount(context)) >= context.maxLiveRuns) {
        throw errors.TOO_MANY_REQUESTS({ data: { retryAfterSeconds: 60 } });
      }
      const pipeline = runs[runs.length - 1]?.pipeline ?? 'claude';
      const outcome = await context.runtime.orchestrator.request({
        taskId: { workId: input.id },
        requestId: `${input.id}:${t.task.runCount + 1}`,
        pipeline,
      });
      if (isRefusal(outcome))
        throw errors.CONFLICT({ message: outcome.reason });
      decidedRun(outcome);
      await context.runtime.drain();
      return view(context, input.id, outcome.task);
    },
  ),
});

export function createWorkHandler() {
  return new OpenAPIHandler(workRouter, {
    // 201 for a fresh create, 200 on replay: set successStatus 201 on the
    // create contract's openapi meta and override to 200 via a
    // clientInterceptor when `view` came from an existing task -- simplest
    // is to return 201 always and let the replay test assert 200 via the
    // `X-Work-Replay: 1` header set by the handler; pick one, keep the
    // contract doc honest, and note the choice in your report.
  });
}
```

Store addition — `OrchestratorStore.listNativeTasks(): Promise<VersionedTask[]>` in `libs/orchestrator/src/store.ts`, implemented in `memory-store.ts` (filter `isWorkAnchor`) and `firestore-store.ts` (`this.#tasks.orderBy('task.task.workId').get()` — documents without the field are excluded by an `orderBy`), with a store-contract case. This is the one orchestrator change in Plan 2; it is a read.

**Ruling on the 201/200 question above** (do not leave it open): return **201** from `create` when the task was created and **200** when it already existed by using the contract's `successStatus: 201` and, on replay, throwing nothing — instead return the view with a response header via an `OpenAPIHandler` `clientInterceptor` is not supported for status; so: declare `successStatus: 201` on `create` and accept that a replay also returns `201` with the existing item, and document it in the contract summary ("201; replays return the existing item"). Adjust the test's replay expectation to `201` and assert `runs.length === 1` (idempotency is the real guarantee).

Route mount:

```ts
// apps/console/src/app/api/work/v1/[[...rest]]/route.ts
import 'server-only';

import { auth } from '@/auth';
import { createOrchestratorRuntime } from '@/lib/orchestrator-runtime';
import {
  authenticateWorkRequest,
  googleIdTokenVerifier,
} from '@/lib/work-auth';
import { workGrants, workMaxLiveRuns } from '@/lib/work-grants';
import { createWorkHandler } from '@/lib/work-router';
import { sessionsForRuns } from '@/lib/work-sessions';

const handler = createWorkHandler();
const verify = googleIdTokenVerifier(
  process.env['AGENT_LCARS_WORK_AUDIENCE'] ?? 'agent-lcars-work',
);

async function handle(request: Request): Promise<Response> {
  const principal = await authenticateWorkRequest(request, {
    verifyGoogleIdToken: verify,
    session: async () => (await auth()) as { user?: { login?: string } } | null,
    grants: workGrants,
  });
  const { matched, response } = await handler.handle(request, {
    prefix: '/api/work/v1',
    context: {
      principal,
      runtime: createOrchestratorRuntime(),
      sessionsFor: sessionsForRuns,
      maxLiveRuns: workMaxLiveRuns(),
    },
  });
  return matched && response
    ? response
    : new Response('Not found', { status: 404 });
}

export const GET = handle;
export const PUT = handle;
export const POST = handle;
export const DELETE = handle;
export const PATCH = handle;
```

`apps/console/src/proxy.ts`: add `'/api/work/v1'` to `publicPrefixes` with a comment (`// Bearer-authenticated work API; auth is the router-level middleware in work-router.ts`). `apps/console/src/proxy.test.ts`: extend the route scan so it walks `app/api/work` too and asserts the catch-all's directory is covered by `publicPrefixes`.

- [ ] **Step 4: Run** — `./tools/nx test @agent-lcars/console -- work-router proxy && ./tools/nx test @agent-lcars/orchestrator @agent-lcars/telemetry && ./tools/nx typecheck @agent-lcars/console` → PASS. Then `tools/console-build-smoke.sh` runs on push (pre-push hook) — a `'use client'` import of a `server-only` module would fail there.

- [ ] **Step 5: Commit and push**

```bash
git add apps/console/src libs/orchestrator/src libs/telemetry/src
git commit -m "feat(console): items API on oRPC 2 behind the work auth gate

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git push
```

---

### Task 7: Console pages and server functions

**Files:**

- Create: `apps/console/src/app/work/functions.ts`, `apps/console/src/app/work/page.tsx`, `apps/console/src/app/work/[id]/page.tsx`, `apps/console/src/app/work/work-actions.tsx`, `apps/console/src/app/work/work-list.tsx`
- Modify: the console navigation config that lists `current` keys (find where `'shuttlebay'`/`'agents'` are declared — `grep -rn "'shuttlebay'" apps/console/src/app --include=*.tsx | grep -v test | head`) to add `work`
- Test: `apps/console/src/app/work/work-list.test.tsx`, `apps/console/src/app/work/work-actions.test.tsx`

**Interfaces:**

- Consumes: `workRouter` procedures (`cancel`, `redispatch`, `get`, `list`) via `createServerFunctionable` from `@orpc/next`; `auth()`; `assertAdmin` is NOT used — a console user acts as `user:<login>` through the grant list, so a signed-in user without a grant sees the list read-only (the `list` call itself requires `work.operator`; render "no grant" instead of the list when `authenticateWorkRequest` yields `undefined` for the session).
- Produces: `cancelItem(id)`, `redispatchItem(id)` server functions; the two pages.

- [ ] **Step 1: Write the failing component tests**

```tsx
// apps/console/src/app/work/work-list.test.tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { WorkList } from './work-list';

const item = {
  id: '01J5Z3K9QX8F0N2B4V6C8D1E3G',
  state: 'parked' as const,
  spec: {
    title: 'Add healthz',
    description: 'd',
    pipeline: 'claude' as const,
    target: { repo: 'jlapenna/agent-lcars' },
  },
  origin: { principal: 'user:jlapenna', channel: 'api' as const },
  createdAt: '2026-08-26T10:00:00.000Z',
  updatedAt: '2026-08-26T10:05:00.000Z',
  runs: [],
  sessions: [],
};

describe('WorkList', () => {
  it('renders parked items first with their state and pipeline', () => {
    render(
      <WorkList
        items={[
          { ...item, id: '01J5Z3K9QX8F0N2B4V6C8D1E3H', state: 'running' },
          item,
        ]}
      />,
    );
    const rows = screen.getAllByRole('link', { name: /Add healthz/ });
    expect(rows[0]).toHaveAttribute('href', `/work/${item.id}`);
    expect(screen.getAllByText('parked')[0]).toBeInTheDocument();
  });
  it('shows an empty state', () => {
    render(<WorkList items={[]} />);
    expect(screen.getByText(/No work items yet/)).toBeInTheDocument();
  });
});
```

```tsx
// apps/console/src/app/work/work-actions.test.tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { WorkActions } from './work-actions';

describe('WorkActions', () => {
  it('offers redispatch only when parked and cancel unless settled', () => {
    const noop = vi.fn(async () => [null, undefined] as const);
    const { rerender } = render(
      <WorkActions id="x" state="parked" cancel={noop} redispatch={noop} />,
    );
    expect(screen.getByRole('button', { name: /Redispatch/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: /Cancel/ })).toBeEnabled();
    rerender(
      <WorkActions id="x" state="done" cancel={noop} redispatch={noop} />,
    );
    expect(screen.queryByRole('button', { name: /Redispatch/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Cancel/ })).toBeNull();
  });
});
```

(Use the console's existing test setup for Mantine — look at `apps/console/src/app/cancel-run-button.tsx`'s test for the render wrapper it uses and mirror it.)

- [ ] **Step 2: Run to verify they fail** — `./tools/nx test @agent-lcars/console -- work-list work-actions` → FAIL.

- [ ] **Step 3: Implement**

```ts
// apps/console/src/app/work/functions.ts
'use server';

import { createServerFunctionable } from '@orpc/next';

import { auth } from '@/auth';
import { createOrchestratorRuntime } from '@/lib/orchestrator-runtime';
import {
  authenticateWorkRequest,
  googleIdTokenVerifier,
} from '@/lib/work-auth';
import { workGrants, workMaxLiveRuns } from '@/lib/work-grants';
import { type WorkContext, workRouter } from '@/lib/work-router';
import { sessionsForRuns } from '@/lib/work-sessions';

async function context(): Promise<WorkContext> {
  // No bearer header on a server function: the session is the credential.
  const principal = await authenticateWorkRequest(
    new Request('https://console.local/'),
    {
      verifyGoogleIdToken: googleIdTokenVerifier('unused'),
      session: async () =>
        (await auth()) as { user?: { login?: string } } | null,
      grants: workGrants,
    },
  );
  return {
    principal,
    runtime: createOrchestratorRuntime(),
    sessionsFor: sessionsForRuns,
    maxLiveRuns: workMaxLiveRuns(),
  };
}

const functionable = createServerFunctionable({ context });

export const cancelItem = functionable(workRouter.cancel);
export const redispatchItem = functionable(workRouter.redispatch);
export const getItem = functionable(workRouter.get);
export const listItems = functionable(workRouter.list);
```

`work-list.tsx` (server-safe, no hooks): a Mantine `Table` of items sorted parked-first (`parked < running < done < canceled`), each title an `Anchor href={/work/${id}}`, columns state/pipeline/repo/principal/updated (use the console's `formatRelativeTime` from `../format`); empty state text "No work items yet."

`work-actions.tsx` (`'use client'`): props `{ id, state, cancel, redispatch }` where `cancel`/`redispatch` are the server functions (passed from the page); two `Button`s with `useTransition`; on click call the function with `{ id }`, then `router.refresh()`; render Cancel unless `state` is `done`/`canceled`; render Redispatch only when `parked`. Passing a server function reference from a server component to a client component is allowed (they are serializable references) — this is _not_ the component-as-prop trap from verify.md.

`page.tsx` — copy `shuttlebay/page.tsx`'s structure (`withConsolePageShell`, `Suspense`, `NavPageLoading`, `current: 'work'`, title "Work", subtitle "Native work items"); body: `const [err, data] = await listItems({ limit: 200 })`; if `err?.code === 'UNAUTHORIZED'` render `<Text>Your GitHub login has no work grant.</Text>`, else `<WorkList items={data.items} />`.

`[id]/page.tsx` — same shell; body: `getItem({ id: params.id })` → `NOT_FOUND` → `notFound()`; render spec (title, description in a `Code block`), state badge, origin, a runs table (runId, state, result ok/summary/ref as a link), sessions list (title/status, link to `/sessions/${sessionId}` which the console already serves), and `<WorkActions id state cancel={cancelItem} redispatch={redispatchItem} />`.

Add `work` to the nav `current` union and menu where `shuttlebay` is registered.

- [ ] **Step 4: Run** — `./tools/nx test @agent-lcars/console -- work && ./tools/nx typecheck @agent-lcars/console && tools/console-build-smoke.sh` → PASS (the smoke build catches server/client boundary mistakes).

- [ ] **Step 5: Commit and push**

```bash
git add apps/console/src
git commit -m "feat(console): /work pages over the items procedures as server functions

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git push
```

---

### Task 8: `lcars work` CLI

**Files:**

- Create: `apps/telemetry-watcher/src/lib/work-command.ts`
- Modify: `apps/telemetry-watcher/src/session-title-cli.ts` (route `work`), `apps/telemetry-watcher/src/lib/session-title-annotation-command.ts` (usage line mentions `work`)
- Test: `apps/telemetry-watcher/src/lib/work-command.spec.ts`

**Interfaces:**

- Consumes: `itemsContract` (`@agent-lcars/work`), `OpenAPILink` (`@orpc/openapi/fetch` or the path Task 1 recorded), `createORPCClient` (`@orpc/client`), `ulid`.
- Produces:

  ```ts
  export interface WorkCommandDeps {
    fetchImpl: typeof fetch;
    token: () => Promise<string>;
    origin: string;
    now: () => Date;
    sleep: (ms: number) => Promise<void>;
    stdout: (line: string) => void;
  }
  export function defaultWorkCommandDeps(
    env: NodeJS.ProcessEnv,
  ): WorkCommandDeps;
  export async function executeWorkCommand(
    argv: string[],
    deps: WorkCommandDeps,
  ): Promise<{ ok: boolean; usage?: string }>;
  ```

  Subcommands: `work create --repo owner/name --pipeline claude --title "..." (--description "..." | --description-file path)` → prints the new ULID and state; `work status <id> [--watch]` (polls every 15 s until `done`/`parked`/`canceled`); `work list [--state s] [--repo r]`; `work cancel <id>`; `work redispatch <id>`. Token: `LCARS_TOKEN` if set, else `gcloud auth print-identity-token --impersonate-service-account=$LCARS_SERVICE_ACCOUNT --audiences=$LCARS_AUDIENCE --include-email` (audience default `agent-lcars-work`); origin `LCARS_URL` default `https://lcars.jlapenna.net`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/telemetry-watcher/src/lib/work-command.spec.ts
import { describe, expect, it } from 'vitest';

import { executeWorkCommand, type WorkCommandDeps } from './work-command';

function deps(
  routes: Record<string, (init: RequestInit & { url: string }) => unknown>,
): WorkCommandDeps & { calls: string[]; out: string[] } {
  const calls: string[] = [];
  const out: string[] = [];
  return {
    calls,
    out,
    origin: 'https://lcars.test',
    token: async () => 'tok',
    now: () => new Date('2026-08-26T10:00:00.000Z'),
    sleep: async () => {},
    stdout: (l) => out.push(l),
    fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const key = `${init?.method ?? 'GET'} ${new URL(url).pathname}`;
      calls.push(key);
      expect(new Headers(init?.headers).get('authorization')).toBe(
        'Bearer tok',
      );
      const route =
        routes[key] ?? routes[key.replace(/\/[0-9A-Z]{26}/u, '/{id}')];
      if (!route) return new Response('nf', { status: 404 });
      return new Response(JSON.stringify(route({ ...init, url })), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch,
  };
}
const item = (state: string) => ({
  id: '01J5Z3K9QX8F0N2B4V6C8D1E3G',
  state,
  spec: {
    title: 't',
    description: 'd',
    pipeline: 'claude',
    target: { repo: 'o/r' },
  },
  origin: { principal: 'user:x', channel: 'api' },
  createdAt: 't',
  updatedAt: 't',
  runs: [],
  sessions: [],
});

describe('lcars work', () => {
  it('create PUTs a client-generated ULID and prints it', async () => {
    const d = deps({ 'PUT /api/work/v1/items/{id}': () => item('running') });
    const r = await executeWorkCommand(
      [
        'create',
        '--repo',
        'o/r',
        '--pipeline',
        'claude',
        '--title',
        't',
        '--description',
        'd',
      ],
      d,
    );
    expect(r.ok).toBe(true);
    expect(d.calls[0]).toMatch(
      /^PUT \/api\/work\/v1\/items\/[0-9A-HJKMNP-TV-Z]{26}$/u,
    );
    expect(d.out.join('\n')).toMatch(/running/);
  });
  it('status --watch polls until settled', async () => {
    let n = 0;
    const d = deps({
      'GET /api/work/v1/items/{id}': () => item(n++ < 2 ? 'running' : 'done'),
    });
    const r = await executeWorkCommand(
      ['status', '01J5Z3K9QX8F0N2B4V6C8D1E3G', '--watch'],
      d,
    );
    expect(r.ok).toBe(true);
    expect(d.calls.filter((c) => c.startsWith('GET')).length).toBe(3);
    expect(d.out.at(-1)).toMatch(/done/);
  });
  it('prints usage for an unknown subcommand', async () => {
    const r = await executeWorkCommand(['bogus'], deps({}));
    expect(r.ok).toBe(false);
    expect(r.usage).toMatch(/usage: work/);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `./tools/nx test @agent-lcars/telemetry-watcher -- work-command` → FAIL.

- [ ] **Step 3: Implement**

```ts
// apps/telemetry-watcher/src/lib/work-command.ts
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';

import { type ItemsContract, itemsContract } from '@agent-lcars/work';
import { createORPCClient } from '@orpc/client';
import type { RouterContractClient } from '@orpc/contract';
import { OpenAPILink } from '@orpc/openapi/fetch';
import { ulid } from 'ulid';

export interface WorkCommandDeps {
  fetchImpl: typeof fetch;
  token: () => Promise<string>;
  origin: string;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  stdout: (line: string) => void;
}

export const WORK_CLI_USAGE =
  'usage: work create --repo <owner/name> --pipeline <claude|codex|opencode> --title "<text>" (--description "<text>" | --description-file <path>)\n' +
  '       work status <id> [--watch] | work list [--state <s>] [--repo <owner/name>] | work cancel <id> | work redispatch <id>';

const execFileAsync = promisify(execFile);

export function defaultWorkCommandDeps(
  env: NodeJS.ProcessEnv,
): WorkCommandDeps {
  return {
    fetchImpl: globalThis.fetch,
    origin: env['LCARS_URL'] ?? 'https://lcars.jlapenna.net',
    now: () => new Date(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    stdout: (line) => process.stdout.write(`${line}\n`),
    token: async () => {
      if (env['LCARS_TOKEN']) return env['LCARS_TOKEN'];
      const sa = env['LCARS_SERVICE_ACCOUNT'];
      if (!sa)
        throw new Error(
          'set LCARS_TOKEN, or LCARS_SERVICE_ACCOUNT for gcloud impersonation',
        );
      const { stdout } = await execFileAsync('gcloud', [
        'auth',
        'print-identity-token',
        `--impersonate-service-account=${sa}`,
        `--audiences=${env['LCARS_AUDIENCE'] ?? 'agent-lcars-work'}`,
        '--include-email',
      ]);
      return stdout.trim();
    },
  };
}

function client(deps: WorkCommandDeps): RouterContractClient<ItemsContract> {
  const link = new OpenAPILink(itemsContract, {
    origin: deps.origin,
    url: '/api/work/v1',
    headers: async () => ({ authorization: `Bearer ${await deps.token()}` }),
    fetch: deps.fetchImpl,
  });
  return createORPCClient(link);
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

const SETTLED = new Set(['done', 'parked', 'canceled']);

function line(item: {
  id: string;
  state: string;
  spec: { title: string; pipeline: string; target: { repo: string } };
}): string {
  return `${item.id}  ${item.state.padEnd(8)}  ${item.spec.pipeline.padEnd(8)}  ${item.spec.target.repo}  ${item.spec.title}`;
}

export async function executeWorkCommand(
  argv: string[],
  deps: WorkCommandDeps,
): Promise<{ ok: boolean; usage?: string }> {
  const [sub, ...rest] = argv;
  const c = client(deps);
  try {
    switch (sub) {
      case 'create': {
        const repo = flag(rest, '--repo');
        const pipeline = flag(rest, '--pipeline');
        const title = flag(rest, '--title');
        const description =
          flag(rest, '--description') ??
          (flag(rest, '--description-file')
            ? readFileSync(flag(rest, '--description-file')!, 'utf8')
            : undefined);
        if (!repo || !pipeline || !title || !description)
          return { ok: false, usage: WORK_CLI_USAGE };
        const id = ulid(deps.now().getTime());
        const item = await c.create({
          id,
          spec: {
            title,
            description,
            pipeline: pipeline as 'claude' | 'codex' | 'opencode',
            target: { repo },
          },
        });
        deps.stdout(line(item));
        return { ok: true };
      }
      case 'status': {
        const id = rest[0];
        if (!id) return { ok: false, usage: WORK_CLI_USAGE };
        let item = await c.get({ id });
        deps.stdout(line(item));
        if (rest.includes('--watch')) {
          while (!SETTLED.has(item.state)) {
            await deps.sleep(15_000);
            item = await c.get({ id });
            deps.stdout(line(item));
          }
        }
        return { ok: true };
      }
      case 'list': {
        const state = flag(rest, '--state') as
          'running' | 'done' | 'parked' | 'canceled' | undefined;
        const { items } = await c.list({
          ...(state ? { state } : {}),
          ...(flag(rest, '--repo') ? { repo: flag(rest, '--repo') } : {}),
          limit: 50,
        });
        for (const item of items) deps.stdout(line(item));
        if (items.length === 0) deps.stdout('(no work items)');
        return { ok: true };
      }
      case 'cancel':
      case 'redispatch': {
        const id = rest[0];
        if (!id) return { ok: false, usage: WORK_CLI_USAGE };
        const item =
          sub === 'cancel'
            ? await c.cancel({ id })
            : await c.redispatch({ id });
        deps.stdout(line(item));
        return { ok: true };
      }
      default:
        return { ok: false, usage: WORK_CLI_USAGE };
    }
  } catch (error) {
    deps.stdout(
      `error: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { ok: false };
  }
}
```

`apps/telemetry-watcher/src/session-title-cli.ts` — before the existing session-title dispatch:

```ts
import { defaultWorkCommandDeps, executeWorkCommand } from './lib/work-command';

const argv = process.argv.slice(2);
if (argv[0] === 'work') {
  const result = await executeWorkCommand(
    argv.slice(1),
    defaultWorkCommandDeps(process.env),
  );
  if (result.usage) process.stderr.write(`${result.usage}\n`);
  process.exit(result.ok ? 0 : 1);
}
```

(top-level `await` — confirm the bundle target supports it; `session-title-cli.ts` is ESM-authored and esbuild emits CJS: if top-level await fails the build, wrap in an async IIFE.) Update `SESSION_TITLE_CLI_USAGE` to append ` | work …` (see `WORK_CLI_USAGE`).

- [ ] **Step 4: Run** — `./tools/nx test @agent-lcars/telemetry-watcher -- work-command session-title && ./tools/nx run @agent-lcars/telemetry-watcher:session-title-cli` (the esbuild bundle must succeed with the new imports) → PASS. Smoke the bundle: `node dist/apps/telemetry-watcher-session-title-cli/lcars-session-title.cjs work` → prints usage, exit 1.

- [ ] **Step 5: Commit and push**

```bash
git add apps/telemetry-watcher/src
git commit -m "feat(cli): lcars work create|status|list|cancel|redispatch

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git push
```

---

### Task 9: Docs, PR, land

**Files:**

- Create: `libs/work/README.md`
- Modify: `docs/deployment-boundary.md` (if not done in Task 5), `apps/telemetry-watcher/deploy/install-session-title-cli.sh` (no change expected — confirm the wrapper needs none since the bundle name is unchanged)

- [ ] **Step 1: README**

```markdown
# @agent-lcars/work

Native work items: the spec schemas (`spec.ts`), the derived item state
and view (`derive.ts`), and the oRPC 2 contract for `/api/work/v1/items`
(`contract.ts`) with its OpenAPI document generator (`openapi.ts`).

Dependency-light on purpose: the `lcars` CLI bundles this library to get a
typed client from the contract, so nothing here may import `server-only`,
Firestore, or Next. The console implements the contract in
`apps/console/src/lib/work-router.ts`.

Regenerate `docs/api/work-v1.openapi.json` with `pnpm work:openapi`; CI
fails when it is stale. Design:
`docs/superpowers/specs/2026-08-23-native-work-items-design.md`.
```

- [ ] **Step 2: Full gate, PR, CI, merge**

`pnpm verify` once (this branch adds CI steps and a new lib). `gh pr create --reviewer jlapenna --fill`; `gh pr checks --watch`; resolve review threads per `pr.md`; merge with `gh pr merge --squash --delete-branch` (admin merge is permitted when the only block is the unattributed-changes approval rule — say so in the PR). Post the PR link on #1502 and tick sub-project 1's API items.

---

## Self-review

**Spec coverage:** API → Framework (T1, T4, T6), `items` table (T4, T6), Auth (T5: grants, Google via SA, session; issuer confinement), Derived item state (T3), Sessions join on `intentId` (T6 + Plan 1), Console (T7), CLI (T8), Testing → contract/OpenAPI check (T4), route tests + proxy scan + auth-on-every-route (T6). Not in this plan: run routes / lane (Plan 3).

**Placeholder scan:** the 201/200 replay question in T6 is ruled inline (201 always; test asserts idempotency by run count). `getTelemetryFirestore` in `work-sessions.ts` names "whichever helper `runner-sessions.ts` uses" — the implementer must read that file; acceptable because the helper exists and is named there. Export paths are verified in T1 and carried by report.

**Type consistency:** `WorkContext` (T6) is what `functions.ts` (T7) builds; `ItemSessionView` (T3) is what `work-sessions.ts` (T6) returns; `itemsContract` (T4) is what the router (T6) implements and the CLI (T8) links; `listNativeTasks` (T6) is added to the store interface once and used once.

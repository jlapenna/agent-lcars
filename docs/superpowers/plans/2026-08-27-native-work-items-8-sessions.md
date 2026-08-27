# Native Work Items — Plan 8: session resume and persistence

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `redispatch` may resume a parked item's prior Claude Code session
(the lane and direct-runner mode share one download-then-`--resume`
mechanism, verified against the pinned `claude-code-action`), and a session
belonging to a still-open native item is exempt from Firestore's `expireAt`
TTL reaping until the item settles, via a new scheduled tick that rewrites
`expireAt` forward through credentials the fleet already grants.

**Architecture:** `redispatch` gains `resumeSessionId`, validated against
the item's own runs and stored on the fresh `Run.params` (no orchestrator
schema change — `params` is already an opaque `Record<string, string>`);
the outbox drain and sub-project 4's `GET /runs/{id}/brief` both surface it
as `resume: { sessionId, transcriptGcsUri }` from the same `run.params`,
so neither needs a new dependency. Both runners invert the sidecar's own
Claude-Code-project-directory encoding (`/` → `-`, `default-checkout.ts`)
to write the downloaded transcript to the exact local path Claude Code
reads a session from, then pass `--resume <sessionId>` — the lane via
`claude_args` (verified: the pinned `claude-code-action` forwards it,
unmodified, to the SDK-spawned `claude` subprocess), direct mode via a
literal CLI flag. Persistence routes around a real IAM wall this plan
cannot cross without Terraform: the console can read the orchestrator but
not write telemetry; `telemetry_writer` can write telemetry but not read
the orchestrator. A new scheduled workflow combines both credentials the
fleet already grants this repository — GitHub Actions OIDC for a new
narrow `work.reaper` read scope on `GET /items`, and WIF impersonation of
`telemetry_writer` for the `expireAt` rewrite — with zero new Terraform,
IAM, or secrets.

**Tech Stack:** oRPC 2 contract-first (`libs/work`), Zod v4, `@google-cloud/
storage`/`@google-cloud/firestore`/`firebase-admin/firestore`, GitHub
Actions (`workflow_dispatch`/`schedule`, OIDC, `google-github-actions/
auth` WIF impersonation), Vitest, Bash.

**Spec:** `docs/superpowers/specs/2026-08-23-native-work-items-design.md`
— "Sub-project 6: session resume and persistence" (this plan implements
that section in full), plus "Sessions", "Data model", "API", "Auth" for
the machinery this extends. Requires sub-project 4 (`QueueExecutor` —
`docs/superpowers/plans/2026-08-27-native-work-items-6-queue.md`, merged:
this plan extends its `runsContract`/`runs-router.ts`/`WorkScope`) and
sub-project 5 (ingress unification, merged per Sequencing) already on
`main`.

## Global Constraints

- Third-party dependencies are root-only and need Renovate; this plan adds
  none — `@google-cloud/storage`, `@google-cloud/firestore`, and
  `firebase-admin` are already dependencies of the files this plan
  extends.
- No new Terraform, IAM, secrets, or runtime env vars. The session-pin-tick
  OIDC audience (`agent-lcars-session-pin-tick`) is a hardcoded constant in
  `github-actions-oidc.ts`, exactly like the reconciler's and the schedule
  tick's — not an `AGENT_LCARS_*` env var. The pin tick's Firestore write
  credential is the existing `telemetry_writer` WIF impersonation binding
  (`fleet_writer_impersonation["jlapenna/agent-lcars"]`,
  `infra/terraform/main.tf`) already used by `.github/actions/
telemetry-start`; its read credential is a fourth GitHub-Actions-OIDC
  branch on `authenticateWorkRequest`, exactly like `work.cron`'s — no
  grant-list entry, since OIDC principals are hardcoded, not looked up.
- One resume mechanism for both runners: download the archived transcript
  to Claude Code's own local session path, then pass `--resume
<sessionId>`. No lane-specific fallback (context-prepending) is
  implemented — verification (Task 6's self-review note) found the pinned
  `claude-code-action` forwards `--resume` through `claude_args`
  unmodified.
- `libs/orchestrator` gets no schema change: `resumeSessionId`/
  `resumeTranscriptGcsUri` travel as two string values on the existing
  `Run.params: Record<string, string>`.
- No real git in unit tests. Console E2E is not run locally (paused by
  maintainer direction, #1049); this plan adds no console E2E spec.
- Never `--no-verify`. Use a worktree; never touch the primary checkout.
  Implementers run the fast layer locally (focused vitest, typecheck of
  the touched project, `pnpm exec prettier --check`), then push; CI
  carries the Firestore-emulator contract run, the workflow/action tests,
  and the OpenAPI drift check.
- Every commit carries `Co-Authored-By: Claude Fable 5
<noreply@anthropic.com>` and `Claude-Session:
https://claude.ai/code/session_01BiTUeJCQByPUqRLZUpt3CD`.

## File Structure

| File                                                                                            | Responsibility                                                                                   |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `libs/work/src/contract.ts`, `contract.spec.ts`                                                 | `redispatch` gains `resumeSessionId` + `BAD_REQUEST`; `runBriefSchema` gains `resume`            |
| `docs/api/work-v1.openapi.json`                                                                 | Regenerated, checked-in OpenAPI document                                                         |
| `apps/console/src/lib/work-mint.ts`                                                             | `WorkContext.getSessionDoc`                                                                      |
| `apps/console/src/lib/work-sessions.ts`                                                         | `sessionForResume`                                                                               |
| `apps/console/src/lib/work-router.ts`, `work-router.test.ts`                                    | `redispatch` validates/threads resume; `list`/`get` move to a `reader` (operator-or-reaper) gate |
| `apps/console/src/lib/orchestrator-dispatch.ts`, `.test.ts`                                     | Drain includes `work.resume` from `run.params`                                                   |
| `apps/console/src/lib/runs-router.ts`, `.test.ts`                                               | `brief` includes `resume` from `run.params`                                                      |
| `apps/console/src/lib/github-actions-oidc.ts`, `.test.ts`                                       | `assertSessionPinTickOidcClaims`/`verifySessionPinTickOidcToken`                                 |
| `apps/console/src/lib/work-auth.ts`, `.test.ts`                                                 | `work.reaper` scope; fourth OIDC branch                                                          |
| `apps/console/src/app/api/work/v1/[[...rest]]/route.ts`, `apps/console/src/app/work/context.ts` | Wire `getSessionDoc` + `verifySessionPinTickOidcToken`                                           |
| `libs/telemetry/src/lib/runner-capture.ts`, `.spec.ts`                                          | `claudeProjectSlugFor`                                                                           |
| `libs/telemetry/src/server/store.ts`, `store.spec.ts`/`store.test.ts`                           | `touchSessionExpiry`                                                                             |
| `apps/telemetry-watcher/src/lib/transcript-upload.ts`, `.spec.ts`                               | `downloadTranscript`                                                                             |
| `apps/telemetry-watcher/src/lib/resume-transcript.ts`, `.spec.ts`                               | `resumeTranscript` (slug + download + write)                                                     |
| `apps/telemetry-watcher/src/main.ts`, `.spec.ts`                                                | `runner resume` CLI subcommand                                                                   |
| `.github/actions/resume-session/action.yml`                                                     | Lane-side composite: parses `work.resume`, calls `runner resume`                                 |
| `.github/workflows/agent-lane.yml`                                                              | New step; `claude_args` gains conditional `--resume`                                             |
| `apps/runner-autoscaler/runner-image/direct-runner.sh`, `direct-runner.test.sh`                 | Resume block: download + `--resume` flag                                                         |
| `apps/telemetry-watcher/bin/session-pin-tick.ts`, `.spec.ts`                                    | The reaper: lists open items, touches `expireAt` for their sessions                              |
| `.github/workflows/work-session-pin-tick.yml`                                                   | Scheduled trigger: OIDC read + WIF write                                                         |
| `tools/workflow-session-pin-tick.test.sh` (registered in `ci.yml`)                              | Workflow text-assertion test                                                                     |
| `apps/console/src/app/work/work-actions.tsx`, `.test.tsx`                                       | Resume checkbox on redispatch                                                                    |
| `apps/console/src/app/work/[id]/page.tsx`                                                       | Resume candidate computation; pinned badge on sessions                                           |
| `.github/workflows/work-create.yml` (land task)                                                 | `resume` input on the `redispatch` action                                                        |
| `docs/native-work-smoke-runbook.md` (land task)                                                 | The proof's evidence                                                                             |

---

### Task 1: `redispatch` and `brief` contract changes; OpenAPI regeneration

**Files:**

- Modify: `libs/work/src/contract.ts`
- Modify: `libs/work/src/contract.spec.ts`
- Regenerate: `docs/api/work-v1.openapi.json`

**Interfaces:**

- Produces: `itemsContract.redispatch.input` gains `resumeSessionId:
z.string().max(256).optional()`; its `.errors()` gains `BAD_REQUEST`.
  `runBriefSchema` gains `resume:
z.strictObject({ sessionId: z.string(), transcriptGcsUri: z.string()
}).optional()`. Consumed by Task 2 (`work-router.ts`'s `redispatch`
  handler) and Task 3 (`runs-router.ts`'s `brief` handler).

- [ ] **Step 1: Write the failing tests**

```ts
// libs/work/src/contract.spec.ts -- add near the existing itemsContract/
// runsContract describe blocks.
describe('itemsContract.redispatch', () => {
  it('accepts an optional resumeSessionId and declares BAD_REQUEST', () => {
    const shape = itemsContract.redispatch['~orpc'].inputSchema;
    expect(shape).toBeDefined();
    const parsed = itemsContract.redispatch['~orpc'].inputSchema?.parse({
      id: '01J5Z3K9QX8F0N2B4V6C8D1E3G',
      resumeSessionId: 'sess_123',
    });
    expect(parsed).toMatchObject({ resumeSessionId: 'sess_123' });
    expect(
      itemsContract.redispatch['~orpc'].inputSchema?.parse({
        id: '01J5Z3K9QX8F0N2B4V6C8D1E3G',
      }),
    ).toEqual({ id: '01J5Z3K9QX8F0N2B4V6C8D1E3G' });
  });
});

describe('runsContract.brief resume field', () => {
  it('runBriefSchema accepts an optional resume object', () => {
    const withResume = runBriefSchema.parse({
      id: '01J5Z3K9QX8F0N2B4V6C8D1E3G',
      spec: {
        title: 't',
        description: 'd',
        pipeline: 'claude',
        target: { repo: 'octo/example' },
      },
      anchor: {
        type: 'work',
        id: '01J5Z3K9QX8F0N2B4V6C8D1E3G',
        title: 't',
        body: 'd',
        target_repo: 'octo/example',
        html_url: 'https://lcars.test/work/01J5Z3K9QX8F0N2B4V6C8D1E3G',
      },
      attemptId: 'g1:work:01J5Z3K9QX8F0N2B4V6C8D1E3G/r1',
      generation: 1,
      intentId: 'work:01J5Z3K9QX8F0N2B4V6C8D1E3G/r1',
      resume: {
        sessionId: 'sess_123',
        transcriptGcsUri:
          'gs://agent-lcars-session-transcripts/runs/x/claude-code/sess_123.jsonl',
      },
    });
    expect(withResume.resume?.sessionId).toBe('sess_123');
  });
});

describe('generateWorkOpenApi resume additions', () => {
  it('documents 400 for redispatch', async () => {
    const doc = (await generateWorkOpenApi()) as {
      paths: Record<
        string,
        Record<string, { responses: Record<string, unknown> }>
      >;
    };
    expect(
      Object.keys(
        doc.paths['/items/{id}/redispatch']?.['post']?.responses ?? {},
      ).sort(),
    ).toEqual(['200', '400', '403', '404', '409', '429']);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `./tools/nx test @agent-lcars/work -- contract` → FAIL (`resumeSessionId`/`resume` not accepted; 400 not documented).

- [ ] **Step 3: Implement**

```ts
// libs/work/src/contract.ts -- itemsContract.redispatch: replace its
// .errors()/.input() calls.
    .errors({
      NOT_FOUND: { message: 'No such item' },
      FORBIDDEN: {
        message: 'Principal may not request this pipeline or repository',
      },
      CONFLICT: { message: 'Only a parked item can be redispatched, or the named session has no archived transcript' },
      TOO_MANY_REQUESTS: {
        message: 'Fleet is at its live-run cap',
        data: z.object({ retryAfterSeconds: z.number() }),
      },
      // Sub-project 6: `resumeSessionId` names a session that either
      // doesn't exist, doesn't belong to a run of this item, or isn't a
      // claude-code session -- a malformed request, not a state conflict.
      BAD_REQUEST: {
        message: 'resumeSessionId does not name a resumable session for this item',
      },
    })
    .input(
      z.strictObject({
        id: workIdSchema,
        // Session ids are opaque UUIDs from the agent CLI, not ULIDs --
        // bounded generously above any real id.
        resumeSessionId: z.string().min(1).max(256).optional(),
      }),
    )
    .output(itemViewSchema),
```

```ts
// libs/work/src/contract.ts -- runBriefSchema (sub-project 4): add one
// field after `intentId`.
export const runBriefSchema = z.strictObject({
  id: workIdSchema,
  spec: workSpecSchema,
  anchor: z.strictObject({
    type: z.literal('work'),
    id: workIdSchema,
    title: z.string(),
    body: z.string(),
    target_repo: z.string(),
    html_url: z.string(),
  }),
  attemptId: z.string(),
  generation: z.number().int().positive(),
  intentId: z.string(),
  // Sub-project 6: present iff the run's params carried a resume request.
  // The same shape the drain puts on the `work` workflow_dispatch input's
  // `resume` field -- one shape for both runners.
  resume: z
    .strictObject({
      sessionId: z.string(),
      transcriptGcsUri: z.string(),
    })
    .optional(),
});
```

- [ ] **Step 4: Run** — `./tools/nx test @agent-lcars/work -- contract` → PASS; `./tools/nx typecheck @agent-lcars/work` → clean.

- [ ] **Step 5: Regenerate the checked-in OpenAPI document**

```bash
pnpm exec tsx tools/work-openapi.mts
./tools/nx run @agent-lcars/work:openapi-check
```

- [ ] **Step 6: Commit**

```bash
git add libs/work/src/contract.ts libs/work/src/contract.spec.ts docs/api/work-v1.openapi.json
git commit -m "$(cat <<'EOF'
feat(work): redispatch resumeSessionId and brief resume contract fields

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BiTUeJCQByPUqRLZUpt3CD
EOF
)"
git push -u origin HEAD
```

---

### Task 2: `redispatch` validates and threads the resume request

**Files:**

- Modify: `apps/console/src/lib/work-mint.ts`
- Modify: `apps/console/src/lib/work-sessions.ts`
- Modify: `apps/console/src/lib/work-router.ts`
- Modify: `apps/console/src/lib/work-router.test.ts`
- Modify: `apps/console/src/app/api/work/v1/[[...rest]]/route.ts`
- Modify: `apps/console/src/app/work/context.ts`

**Interfaces:**

- Consumes: `itemsContract.redispatch.input.resumeSessionId` (Task 1);
  `SessionDoc`/`sessionAgent` from `@agent-lcars/telemetry`;
  `getSessionDoc`/`getAgentTelemetryReaderFirestore` from
  `@agent-lcars/telemetry/server`.
- Produces: `WorkContext.getSessionDoc: (sessionId: string) =>
Promise<SessionDoc | undefined>`; `sessionForResume(sessionId):
Promise<SessionDoc | undefined>`, wired as `getSessionDoc` at both
  `WorkContext` construction sites in this same task (`route.ts`'s
  `handle` and `context.ts`'s `context()`) — `WorkContext.getSessionDoc`
  is a required field, so both sites must be updated in the same task
  that adds it, or `./tools/nx typecheck @agent-lcars/console` fails on
  every other `WorkContext` literal in the codebase, not just this task's
  own test doubles. Task 8 (which also touches both files, for the OIDC
  verifier) must not reintroduce this wiring — it is already done here.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/console/src/lib/work-router.test.ts -- add to the harness's
// `WorkContext` builder a `getSessionDoc` stub, and add these cases
// alongside the existing redispatch describe block.
function context(over: Partial<WorkContext> = {}): WorkContext {
  return {
    // ...existing fields...
    getSessionDoc: async () => undefined,
    ...over,
  };
}

describe('redispatch with resumeSessionId', () => {
  it('threads params.resumeSessionId/resumeTranscriptGcsUri onto the fresh run', async () => {
    const store = parkedItemStore(); // existing test helper: a task with one finished, ok:false run
    const ctx = context({
      runtime: runtimeFor(store),
      getSessionDoc: async (id) =>
        id === 'sess_1'
          ? {
              source: 'issue-agent',
              sessionId: 'sess_1',
              intentId: (await store.listRuns({ workId: 'ITEM1' }))[0]?.runId,
              transcriptGcsUri: 'gs://bucket/runs/x/claude-code/sess_1.jsonl',
              agent: 'claude-code',
              liveness: 'ended',
              startedAt: 't0',
              lastActivityAt: 't0',
              turns: 1,
              toolCallCounts: {},
              tokens: {
                inputTokens: 0,
                outputTokens: 0,
                cacheCreationTokens: 0,
                cacheReadTokens: 0,
              },
              deliverables: { prNumbers: [], commitShas: [] },
            }
          : undefined,
    });
    const result = await workRouter.redispatch(
      {
        id: 'ITEM1',
        resumeSessionId: 'sess_1',
      },
      { context: ctx },
    );
    const runs = await ctx.runtime.store.listRuns({ workId: 'ITEM1' });
    const fresh = runs.find((r) => r.state === 'pending');
    expect(fresh?.params).toEqual({
      resumeSessionId: 'sess_1',
      resumeTranscriptGcsUri: 'gs://bucket/runs/x/claude-code/sess_1.jsonl',
    });
  });

  it('refuses BAD_REQUEST for a session belonging to a different item', async () => {
    const store = parkedItemStore();
    const ctx = context({
      runtime: runtimeFor(store),
      getSessionDoc: async () => ({
        source: 'issue-agent',
        sessionId: 'sess_2',
        intentId: 'work:OTHERITEM/r1',
        transcriptGcsUri: 'gs://bucket/x.jsonl',
        agent: 'claude-code',
        liveness: 'ended',
        startedAt: 't0',
        lastActivityAt: 't0',
        turns: 1,
        toolCallCounts: {},
        tokens: {
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
        },
        deliverables: { prNumbers: [], commitShas: [] },
      }),
    });
    await expect(
      workRouter.redispatch(
        { id: 'ITEM1', resumeSessionId: 'sess_2' },
        { context: ctx },
      ),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('refuses CONFLICT for a same-item session with no transcript', async () => {
    const store = parkedItemStore();
    const ctx = context({
      runtime: runtimeFor(store),
      getSessionDoc: async () => ({
        source: 'issue-agent',
        sessionId: 'sess_3',
        intentId: (await store.listRuns({ workId: 'ITEM1' }))[0]?.runId,
        agent: 'claude-code',
        liveness: 'ended',
        startedAt: 't0',
        lastActivityAt: 't0',
        turns: 1,
        toolCallCounts: {},
        tokens: {
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
        },
        deliverables: { prNumbers: [], commitShas: [] },
      }),
    });
    await expect(
      workRouter.redispatch(
        { id: 'ITEM1', resumeSessionId: 'sess_3' },
        { context: ctx },
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `./tools/nx test @agent-lcars/console -- work-router` → FAIL (`getSessionDoc` unknown on `WorkContext`; `resumeSessionId` unhandled).

- [ ] **Step 3: Implement**

```ts
// apps/console/src/lib/work-mint.ts -- add the import and the field.
import type { SessionDoc } from '@agent-lcars/telemetry';
// ...
export interface WorkContext {
  principal?: WorkPrincipal;
  runtime: OrchestratorRouteDeps;
  sessionsFor: (runIds: string[]) => Promise<ItemSessionView[]>;
  /** Reads one session doc by id, for `redispatch`'s `resumeSessionId`
   *  validation (sub-project 6) -- the same read-only telemetry accessor
   *  `sessionsFor` uses, scoped to a single session. */
  getSessionDoc: (sessionId: string) => Promise<SessionDoc | undefined>;
  maxLiveRuns: number;
  scheduleStore: ScheduleStore;
  grants: () => WorkGrant[];
  now: () => Date;
}
```

```ts
// apps/console/src/lib/work-sessions.ts -- add alongside sessionsForRuns.
import {
  getSessionDoc,
  getAgentTelemetryReaderFirestore,
} from '@agent-lcars/telemetry/server';
import type { SessionDoc } from '@agent-lcars/telemetry';

/**
 * Reads one session doc by id, for `redispatch`'s `resumeSessionId`
 * validation (sub-project 6). Read-only, the same accessor
 * `sessionsForRuns` uses; degrades to `undefined` on any failure rather
 * than throwing -- a lookup failure here becomes the handler's own
 * BAD_REQUEST, not a 500.
 */
export async function sessionForResume(
  sessionId: string,
): Promise<SessionDoc | undefined> {
  try {
    const firestore = await getAgentTelemetryReaderFirestore();
    return await getSessionDoc(firestore, sessionId);
  } catch (error) {
    console.error('agent-lcars: failed to read session for resume:', error);
    return undefined;
  }
}
```

```ts
// apps/console/src/lib/work-router.ts -- imports gain sessionAgent;
// replace the redispatch handler body.
import { sessionAgent } from '@agent-lcars/telemetry';
// ...
  redispatch: operator.redispatch.handler(
    async ({ input, context, errors }) => {
      const task = await context.runtime.store.readTask({ workId: input.id });
      if (task === undefined) throw errors.NOT_FOUND();
      const runs = await context.runtime.store.listRuns({ workId: input.id });
      if (deriveItemState(task.task, runs) !== 'parked') {
        throw errors.CONFLICT({
          message: 'only a parked item can be redispatched',
        });
      }

      const { spec } = workPayloadSchema.parse(task.task.work);
      const forbidden = forbiddenReason(context.principal, spec);
      if (forbidden !== undefined) {
        throw errors.FORBIDDEN({ message: forbidden });
      }

      let resumeParams: Record<string, string> | undefined;
      if (input.resumeSessionId !== undefined) {
        const session = await context.getSessionDoc(input.resumeSessionId);
        const runIds = new Set(runs.map((run) => run.runId));
        if (
          session === undefined ||
          session.source !== 'issue-agent' ||
          session.intentId === undefined ||
          !runIds.has(session.intentId) ||
          sessionAgent(session) !== 'claude-code'
        ) {
          throw errors.BAD_REQUEST({
            message:
              'resumeSessionId must name a claude-code session belonging to a run of this item',
          });
        }
        if (session.transcriptGcsUri === undefined) {
          throw errors.CONFLICT({
            message: 'session has no archived transcript to resume from',
          });
        }
        resumeParams = {
          resumeSessionId: input.resumeSessionId,
          resumeTranscriptGcsUri: session.transcriptGcsUri,
        };
      }

      if ((await liveNativeRunCount(context)) >= context.maxLiveRuns) {
        throw errors.TOO_MANY_REQUESTS({
          data: { retryAfterSeconds: RETRY_AFTER_SECONDS },
        });
      }

      const outcome = await context.runtime.orchestrator.request({
        taskId: { workId: input.id },
        requestId: `${input.id}:${task.task.runCount + 1}`,
        pipeline: spec.pipeline,
        ...(resumeParams === undefined ? {} : { params: resumeParams }),
      });
      if (isRefusal(outcome)) {
        throw errors.CONFLICT({ message: outcome.reason });
      }
      decidedRun(outcome);
      await context.runtime.drain();
      return view(context, input.id, outcome.task);
    },
  ),
```

`WorkContext.getSessionDoc` is a required field, so both places that
construct a real `WorkContext` need it wired in this same task, or
typechecking the console fails everywhere else a `WorkContext` literal is
built:

```ts
// apps/console/src/app/api/work/v1/[[...rest]]/route.ts -- add the
// import and the context field.
import { sessionForResume, sessionsForRuns } from '@/lib/work-sessions';
// ...
const { matched, response } = await handler.handle(request, {
  prefix: PREFIX,
  context: {
    ...(principal === undefined ? {} : { principal }),
    runtime: createOrchestratorRuntime(),
    sessionsFor: sessionsForRuns,
    getSessionDoc: sessionForResume,
    maxLiveRuns: workMaxLiveRuns(),
    scheduleStore: createScheduleStore(),
    grants: workGrants,
    now: () => new Date(),
  },
});
```

```ts
// apps/console/src/app/work/context.ts -- add the import and the field.
import { sessionForResume, sessionsForRuns } from '@/lib/work-sessions';
// ...
return {
  principal,
  runtime: createOrchestratorRuntime(),
  sessionsFor: sessionsForRuns,
  getSessionDoc: sessionForResume,
  maxLiveRuns: workMaxLiveRuns(),
  scheduleStore: createScheduleStore(),
  grants: workGrants,
  now: () => new Date(),
};
```

- [ ] **Step 4: Run** — `./tools/nx test @agent-lcars/console -- work-router` → PASS; `./tools/nx typecheck @agent-lcars/console` → clean (this is the check that would have caught the missing wiring — both `WorkContext` construction sites now satisfy the widened interface).

- [ ] **Step 5: Commit**

```bash
git add apps/console/src/lib/work-mint.ts apps/console/src/lib/work-sessions.ts apps/console/src/lib/work-router.ts apps/console/src/lib/work-router.test.ts apps/console/src/app/api/work/v1/\[\[...rest\]\]/route.ts apps/console/src/app/work/context.ts
git commit -m "$(cat <<'EOF'
feat(console): redispatch validates and threads resumeSessionId

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BiTUeJCQByPUqRLZUpt3CD
EOF
)"
git push
```

---

### Task 3: The resume reaches the worker — drain input and the direct-mode brief

**Files:**

- Modify: `apps/console/src/lib/orchestrator-dispatch.ts`
- Modify: `apps/console/src/lib/orchestrator-dispatch.test.ts`
- Modify: `apps/console/src/lib/runs-router.ts`
- Modify: `apps/console/src/lib/runs-router.test.ts`

**Interfaces:**

- Consumes: `Run.params.resumeSessionId`/`resumeTranscriptGcsUri` (Task 2);
  `runBriefSchema.resume` (Task 1).
- Produces: the `work` `workflow_dispatch` input's `resume` field; the
  `brief` route's `resume` field. Both read straight off `run.params` —
  neither gains a new dependency.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/console/src/lib/orchestrator-dispatch.test.ts -- add near the
// existing native-anchor dispatch test.
it('includes resume in the work input when the run carries a resumeSessionId', async () => {
  const { store, orchestrator, deps } = harness();
  const requestOutcome = await orchestrator.request({
    taskId: { workId: 'ITEM1' },
    requestId: 'r1',
    pipeline: 'claude',
    work: {
      origin: { principal: 'user:jlapenna', channel: 'api' },
      spec: nativeSpec(),
    },
    params: {
      resumeSessionId: 'sess_1',
      resumeTranscriptGcsUri: 'gs://bucket/runs/x/claude-code/sess_1.jsonl',
    },
  });
  decidedRun(requestOutcome);
  await drainOutbox(deps);
  const call = deps.fetchImpl.mock.calls[0];
  const body = JSON.parse((call?.[1] as { body: string }).body);
  const work = JSON.parse(body.inputs.work);
  expect(work.resume).toEqual({
    sessionId: 'sess_1',
    transcriptGcsUri: 'gs://bucket/runs/x/claude-code/sess_1.jsonl',
  });
});

it('omits resume when the run carries no resumeSessionId (negative case)', async () => {
  const { orchestrator, deps } = harness();
  const requestOutcome = await orchestrator.request({
    taskId: { workId: 'ITEM2' },
    requestId: 'r1',
    pipeline: 'claude',
    work: {
      origin: { principal: 'user:jlapenna', channel: 'api' },
      spec: nativeSpec(),
    },
  });
  decidedRun(requestOutcome);
  await drainOutbox(deps);
  const call = deps.fetchImpl.mock.calls[0];
  const body = JSON.parse((call?.[1] as { body: string }).body);
  const work = JSON.parse(body.inputs.work);
  expect(work.resume).toBeUndefined();
});
```

```ts
// apps/console/src/lib/runs-router.test.ts -- add alongside the existing
// brief describe block.
it('brief includes resume when the claimed run carries resumeSessionId', async () => {
  const { store, run } = await claimedRun({
    params: {
      resumeSessionId: 'sess_1',
      resumeTranscriptGcsUri: 'gs://bucket/runs/x/claude-code/sess_1.jsonl',
    },
  });
  const brief = await runsRouter.brief(
    { runId: run.runId },
    { context: contextFor(store, run) },
  );
  expect(brief.resume).toEqual({
    sessionId: 'sess_1',
    transcriptGcsUri: 'gs://bucket/runs/x/claude-code/sess_1.jsonl',
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `./tools/nx test @agent-lcars/console -- orchestrator-dispatch runs-router` → FAIL (`resume` never set).

- [ ] **Step 3: Implement**

```ts
// apps/console/src/lib/orchestrator-dispatch.ts -- inside
// handleDispatchRun's isWorkAnchor(run.task) branch, replace the
// `inputs = { work: ... }` assignment.
inputs = {
  work: JSON.stringify({
    id: run.task.workId,
    spec,
    // Sub-project 6: both params are written together by
    // work-router.ts's redispatch handler (Task 2) -- checking both
    // rather than just resumeSessionId keeps a half-written params
    // record (which should never happen, but this is cheap insurance)
    // from producing a resume object with no transcript to fetch.
    ...(run.params?.['resumeSessionId'] !== undefined &&
    run.params?.['resumeTranscriptGcsUri'] !== undefined
      ? {
          resume: {
            sessionId: run.params['resumeSessionId'],
            transcriptGcsUri: run.params['resumeTranscriptGcsUri'],
          },
        }
      : {}),
  }),
  mode: 'implement',
  broker_intent_id: run.runId,
  broker_generation: parseGeneration(run.runId),
  broker_dispatch_token: crypto.randomUUID(),
};
```

```ts
// apps/console/src/lib/runs-router.ts -- inside the `brief` handler,
// extend the returned object.
return {
  id: run.task.workId,
  spec: specRecord as never,
  anchor: {
    type: 'work' as const,
    id: run.task.workId,
    title: specRecord.title,
    body: specRecord.description,
    target_repo: target.repo,
    html_url: `${process.env['AGENT_LCARS_CONSOLE_URL'] ?? 'https://lcars.jlapenna.net'}/work/${run.task.workId}`,
  },
  attemptId: `g${generation}:${run.runId}`,
  generation,
  intentId: run.runId,
  ...(run.params?.['resumeSessionId'] !== undefined &&
  run.params?.['resumeTranscriptGcsUri'] !== undefined
    ? {
        resume: {
          sessionId: run.params['resumeSessionId'],
          transcriptGcsUri: run.params['resumeTranscriptGcsUri'],
        },
      }
    : {}),
};
```

- [ ] **Step 4: Run** — `./tools/nx test @agent-lcars/console -- orchestrator-dispatch runs-router` → PASS; `./tools/nx typecheck @agent-lcars/console` → clean.

- [ ] **Step 5: Commit**

```bash
git add apps/console/src/lib/orchestrator-dispatch.ts apps/console/src/lib/orchestrator-dispatch.test.ts apps/console/src/lib/runs-router.ts apps/console/src/lib/runs-router.test.ts
git commit -m "$(cat <<'EOF'
feat(console): thread resume through the drain input and the run brief

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BiTUeJCQByPUqRLZUpt3CD
EOF
)"
git push
```

---

### Task 4: Session-path derivation and the shared transcript download

**Files:**

- Modify: `libs/telemetry/src/lib/runner-capture.ts`
- Modify: `libs/telemetry/src/lib/runner-capture.spec.ts`
- Modify: `apps/telemetry-watcher/src/lib/transcript-upload.ts`
- Modify: `apps/telemetry-watcher/src/lib/transcript-upload.spec.ts`
- Create: `apps/telemetry-watcher/src/lib/resume-transcript.ts`
- Create: `apps/telemetry-watcher/src/lib/resume-transcript.spec.ts`

**Interfaces:**

- Produces: `claudeProjectSlugFor(absoluteCwd: string): string` (exported
  from `@agent-lcars/telemetry`); `downloadTranscript(gcsUri: string,
options?: { projectId?: string }): Promise<string>`; `resumeTranscript(
options): Promise<string | undefined>` (returns the written file path, or
  `undefined` on any failure — fails soft). Consumed by Task 5 (`main.ts`'s
  `runner resume` subcommand).

- [ ] **Step 1: Write the failing tests**

```ts
// libs/telemetry/src/lib/runner-capture.spec.ts -- add.
import { claudeProjectSlugFor } from './runner-capture';

describe('claudeProjectSlugFor', () => {
  it.each([
    ['/home/jlapenna/p/agent-lcars', '-home-jlapenna-p-agent-lcars'],
    ['/tmp/agent-lcars-direct/checkout', '-tmp-agent-lcars-direct-checkout'],
    ['/', '-'],
  ])('replaces every "/" with "-": %s -> %s', (cwd, expected) => {
    expect(claudeProjectSlugFor(cwd)).toBe(expected);
  });
});
```

```ts
// apps/telemetry-watcher/src/lib/transcript-upload.spec.ts -- add
// alongside the existing uploadTranscript describe block.
describe('downloadTranscript', () => {
  it('parses the gs:// URI and downloads via the same client uploadTranscript uses', async () => {
    const download = vi.fn().mockResolvedValue([Buffer.from('{"a":1}\n')]);
    const bucket = vi.fn().mockReturnValue({
      file: vi.fn().mockReturnValue({ download }),
    });
    vi.spyOn(storageModule, 'Storage').mockImplementation(
      () =>
        ({ bucket }) as unknown as InstanceType<typeof storageModule.Storage>,
    );
    const contents = await downloadTranscript(
      'gs://agent-lcars-session-transcripts/runs/x/claude-code/sess_1.jsonl',
    );
    expect(bucket).toHaveBeenCalledWith('agent-lcars-session-transcripts');
    expect(contents).toBe('{"a":1}\n');
  });

  it('throws on a malformed URI', async () => {
    await expect(downloadTranscript('not-a-gs-uri')).rejects.toThrow(
      /Malformed transcript GCS URI/,
    );
  });
});
```

```ts
// apps/telemetry-watcher/src/lib/resume-transcript.spec.ts -- create.
import { resumeTranscript } from './resume-transcript';

describe('resumeTranscript', () => {
  it('writes the downloaded transcript to the slug-derived path', async () => {
    const download = vi.fn().mockResolvedValue('{"line":1}\n');
    const mkdir = vi.fn();
    const writeFile = vi.fn();
    const result = await resumeTranscript({
      sessionId: 'sess_1',
      transcriptGcsUri: 'gs://bucket/runs/x/claude-code/sess_1.jsonl',
      cwd: '/home/runner/work/agent-lcars/agent-lcars',
      claudeProjectsDir: '/home/runner/.claude/projects',
      download,
      mkdir,
      writeFile,
    });
    expect(mkdir).toHaveBeenCalledWith(
      '/home/runner/.claude/projects/-home-runner-work-agent-lcars-agent-lcars',
    );
    expect(writeFile).toHaveBeenCalledWith(
      '/home/runner/.claude/projects/-home-runner-work-agent-lcars-agent-lcars/sess_1.jsonl',
      '{"line":1}\n',
    );
    expect(result).toBe(
      '/home/runner/.claude/projects/-home-runner-work-agent-lcars-agent-lcars/sess_1.jsonl',
    );
  });

  it('fails soft: returns undefined when the download throws', async () => {
    const result = await resumeTranscript({
      sessionId: 'sess_1',
      transcriptGcsUri: 'gs://bucket/x.jsonl',
      cwd: '/x',
      claudeProjectsDir: '/home/runner/.claude/projects',
      download: async () => {
        throw new Error('network');
      },
      mkdir: () => undefined,
      writeFile: () => undefined,
    });
    expect(result).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `./tools/nx test @agent-lcars/telemetry -- runner-capture` and `./tools/nx test agent-lcars-telemetry-watcher -- transcript-upload resume-transcript` → FAIL (functions not found).

- [ ] **Step 3: Implement**

```ts
// libs/telemetry/src/lib/runner-capture.ts -- add after transcriptObjectPath.
/**
 * Claude Code's own project-directory encoding for an absolute checkout
 * path: every `/` becomes `-`. Verified against the sidecar's own
 * privacy-allowlist code (`apps/telemetry-watcher/src/lib/
default-checkout.ts`'s `checkoutSlugGlobs`, which builds `<root>-*` globs
 * for exactly this substitution) rather than assumed. Inverted by
 * `resume-transcript.ts` (sub-project 6): given a checkout directory, this
 * names the subdirectory under `~/.claude/projects/` a resumed session's
 * transcript must be written to before Claude Code can `--resume` it.
 */
export function claudeProjectSlugFor(absoluteCwd: string): string {
  return absoluteCwd.replace(/\//g, '-');
}
```

```ts
// apps/telemetry-watcher/src/lib/transcript-upload.ts -- add below
// uploadTranscript, reusing getStorageClient.
interface ParsedGcsUri {
  bucket: string;
  object: string;
}

function parseGcsUri(uri: string): ParsedGcsUri | undefined {
  const match = /^gs:\/\/([^/]+)\/(.+)$/.exec(uri);
  if (!match) return undefined;
  return { bucket: match[1] as string, object: match[2] as string };
}

/**
 * Downloads a transcript from GCS by its `gs://` URI -- the read-side
 * counterpart to `uploadTranscript`, sharing its cached `Storage` client
 * and credential wiring (sub-project 6's resume mechanism: the same
 * `telemetry_writer` identity that already uploads transcripts also
 * downloads them, needing no new IAM). Mirrors `libs/telemetry/src/server/
transcript-store.ts`'s `fetchSessionTranscript`, which this app cannot
 * import (that module is console-only, using the console's own
 * `roles/storage.objectViewer` grant and ambient ADC rather than an
 * explicit credentials file) -- a small, deliberate duplication at the
 * app-local-client boundary, the same shape this repo already accepts for
 * `.swcrc`/`.prettierrc`-style foundation files.
 */
export async function downloadTranscript(
  gcsUri: string,
  options: { projectId?: string } = {},
): Promise<string> {
  const parsed = parseGcsUri(gcsUri);
  if (!parsed) {
    throw new Error(`Malformed transcript GCS URI: ${gcsUri}`);
  }
  const [contents] = await getStorageClient(options.projectId)
    .bucket(parsed.bucket)
    .file(parsed.object)
    .download();
  return contents.toString('utf-8');
}
```

```ts
// apps/telemetry-watcher/src/lib/resume-transcript.ts -- create.
import { logger } from '@agent-lcars/logging';
import { claudeProjectSlugFor } from '@agent-lcars/telemetry';
import * as fs from 'fs';
import * as path from 'path';

import { downloadTranscript } from './transcript-upload';

export interface ResumeTranscriptOptions {
  sessionId: string;
  transcriptGcsUri: string;
  cwd: string;
  claudeProjectsDir: string;
  projectId?: string;
  download?: (
    gcsUri: string,
    options?: { projectId?: string },
  ) => Promise<string>;
  mkdir?: (dir: string) => void;
  writeFile?: (filePath: string, contents: string) => void;
}

/**
 * Downloads a prior session's archived transcript into Claude Code's own
 * local session store for `cwd`, so a later `claude --resume <sessionId>`
 * (the lane's `claude_args`, or direct mode's literal CLI flag) finds it.
 * Fails soft -- returns `undefined`, never throws -- on any download or
 * filesystem failure: a resume that cannot be prepared degrades to a
 * fresh run, matching every other telemetry failure mode in this
 * codebase (never block dispatch on a telemetry-adjacent step).
 */
export async function resumeTranscript(
  options: ResumeTranscriptOptions,
): Promise<string | undefined> {
  const download = options.download ?? downloadTranscript;
  const mkdir =
    options.mkdir ?? ((dir: string) => fs.mkdirSync(dir, { recursive: true }));
  const writeFile =
    options.writeFile ??
    ((filePath: string, contents: string) =>
      fs.writeFileSync(filePath, contents));

  const dir = path.join(
    options.claudeProjectsDir,
    claudeProjectSlugFor(options.cwd),
  );
  const file = path.join(dir, `${options.sessionId}.jsonl`);

  try {
    const contents = await download(options.transcriptGcsUri, {
      projectId: options.projectId,
    });
    mkdir(dir);
    writeFile(file, contents);
    return file;
  } catch (error) {
    logger.warn(
      `agent-lcars-telemetry-watcher: resume-transcript failed for session ${options.sessionId}, continuing without --resume`,
      error,
    );
    return undefined;
  }
}
```

Add `export * from './resume-transcript';` alongside the other exports the
watcher's internal modules use directly (this file has no public index —
`main.ts` imports it by relative path, as Task 5 does).

- [ ] **Step 4: Run** — `./tools/nx test @agent-lcars/telemetry -- runner-capture` and `./tools/nx test agent-lcars-telemetry-watcher -- transcript-upload resume-transcript` → PASS; typecheck both projects clean.

- [ ] **Step 5: Commit**

```bash
git add libs/telemetry/src/lib/runner-capture.ts libs/telemetry/src/lib/runner-capture.spec.ts apps/telemetry-watcher/src/lib/transcript-upload.ts apps/telemetry-watcher/src/lib/transcript-upload.spec.ts apps/telemetry-watcher/src/lib/resume-transcript.ts apps/telemetry-watcher/src/lib/resume-transcript.spec.ts
git commit -m "$(cat <<'EOF'
feat(telemetry): claudeProjectSlugFor, downloadTranscript, resumeTranscript

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BiTUeJCQByPUqRLZUpt3CD
EOF
)"
git push
```

---

### Task 5: `runner resume` CLI subcommand

**Files:**

- Modify: `apps/telemetry-watcher/src/main.ts`
- Modify: `apps/telemetry-watcher/src/main.spec.ts` (create if absent —
  check for an existing `main.spec.ts`/`main.test.ts` before creating a
  second one)

**Interfaces:**

- Consumes: `resumeTranscript` (Task 4).
- Produces: `node sidecar.cjs runner resume --session-id <id>
--transcript-uri <gcsUri> --cwd <dir> [--projects-dir <dir>] [--project-id
<id>]` — prints the written file path to stdout on success, nothing on
  failure or when required flags are missing; always exits 0 (fail-soft,
  matching `runner sidecar`/`runner finalize`). `--project-id` is
  optional and falls back to the `AGENT_TELEMETRY_PROJECT_ID` env var —
  the same variable `finalize.ts`'s `config.firestoreProjectId` is
  already populated from (`runner-config.ts`'s `loadRunnerConfig` reads
  it via `loadSharedConfig()`), so a caller that already exports it for
  `runner sidecar`/`runner finalize` (as `sidecar-lifecycle.sh` does)
  needs no extra flag. Consumed by Task 6 (the lane's composite action)
  and Task 7 (`direct-runner.sh`), both of which export
  `AGENT_TELEMETRY_PROJECT_ID=agent-lcars` on the `runner resume`
  invocation itself, exactly as `sidecar-lifecycle.sh` already does for
  `runner sidecar`/`runner finalize`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/telemetry-watcher/src/main.spec.ts -- create if this file does not
// already exist; if it does, add this describe block to it.
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// This exercises the real CLI entrypoint end to end (fake network via a
// stubbed fetch is not available for a spawned process, so this test
// instead stubs the module-level Storage client the way
// transcript-upload.spec.ts does, by running the *function* main.ts
// wires up rather than spawning node -- see runRunnerResume, exported for
// testing below).
import { _runRunnerResumeForTesting } from './main';

describe('runner resume subcommand', () => {
  it('writes the transcript to the computed local session path and prints it', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-resume-'));
    const projectsDir = path.join(tmp, 'projects');
    const printed = await _runRunnerResumeForTesting(
      [
        '--session-id',
        'sess_1',
        '--transcript-uri',
        'gs://bucket/runs/x/claude-code/sess_1.jsonl',
        '--cwd',
        '/home/runner/work/repo/repo',
        '--projects-dir',
        projectsDir,
      ],
      { download: async () => '{"line":1}\n' },
    );
    const expected = path.join(
      projectsDir,
      '-home-runner-work-repo-repo',
      'sess_1.jsonl',
    );
    expect(printed).toBe(expected);
    expect(fs.readFileSync(expected, 'utf8')).toBe('{"line":1}\n');
  });

  it('threads --project-id through to downloadTranscript', async () => {
    const download = vi.fn().mockResolvedValue('{}\n');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-resume-'));
    await _runRunnerResumeForTesting(
      [
        '--session-id',
        'sess_1',
        '--transcript-uri',
        'gs://bucket/runs/x/claude-code/sess_1.jsonl',
        '--cwd',
        '/home/runner/work/repo/repo',
        '--projects-dir',
        path.join(tmp, 'projects'),
        '--project-id',
        'agent-lcars',
      ],
      { download },
    );
    expect(download).toHaveBeenCalledWith(
      'gs://bucket/runs/x/claude-code/sess_1.jsonl',
      { projectId: 'agent-lcars' },
    );
  });

  it('falls back to AGENT_TELEMETRY_PROJECT_ID when --project-id is omitted', async () => {
    const previous = process.env['AGENT_TELEMETRY_PROJECT_ID'];
    process.env['AGENT_TELEMETRY_PROJECT_ID'] = 'agent-lcars';
    try {
      const download = vi.fn().mockResolvedValue('{}\n');
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-resume-'));
      await _runRunnerResumeForTesting(
        [
          '--session-id',
          'sess_1',
          '--transcript-uri',
          'gs://bucket/runs/x/claude-code/sess_1.jsonl',
          '--cwd',
          '/home/runner/work/repo/repo',
          '--projects-dir',
          path.join(tmp, 'projects'),
        ],
        { download },
      );
      expect(download).toHaveBeenCalledWith(
        'gs://bucket/runs/x/claude-code/sess_1.jsonl',
        { projectId: 'agent-lcars' },
      );
    } finally {
      if (previous === undefined)
        delete process.env['AGENT_TELEMETRY_PROJECT_ID'];
      else process.env['AGENT_TELEMETRY_PROJECT_ID'] = previous;
    }
  });

  it('prints nothing and never throws when a required flag is missing', async () => {
    const printed = await _runRunnerResumeForTesting(
      ['--session-id', 'sess_1'],
      {
        download: async () => '{}',
      },
    );
    expect(printed).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `./tools/nx test agent-lcars-telemetry-watcher -- main` → FAIL (`_runRunnerResumeForTesting` not exported).

- [ ] **Step 3: Implement**

```ts
// apps/telemetry-watcher/src/main.ts -- add the import and the new
// subcommand handling.
import { resumeTranscript } from './lib/resume-transcript';

interface RunnerResumeFlags {
  sessionId?: string;
  transcriptUri?: string;
  cwd?: string;
  projectsDir?: string;
  projectId?: string;
}

function parseRunnerResumeFlags(argv: string[]): RunnerResumeFlags {
  const flags: RunnerResumeFlags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (next === undefined) continue;
    if (arg === '--session-id') {
      flags.sessionId = next;
      i++;
    } else if (arg === '--transcript-uri') {
      flags.transcriptUri = next;
      i++;
    } else if (arg === '--cwd') {
      flags.cwd = next;
      i++;
    } else if (arg === '--projects-dir') {
      flags.projectsDir = next;
      i++;
    } else if (arg === '--project-id') {
      flags.projectId = next;
      i++;
    }
  }
  return flags;
}

/**
 * `node sidecar.cjs runner resume --session-id <id> --transcript-uri
 * <gcsUri> --cwd <dir> [--projects-dir <dir>] [--project-id <id>]` --
 * downloads a prior session's transcript into Claude Code's local
 * session store, so a caller's own subsequent `claude --resume
 * <sessionId>` (direct mode) or `claude_args: --resume <sessionId>` (the
 * lane) finds it (sub-project 6). Prints the written path on success;
 * prints nothing (never throws, never exits nonzero) when a required
 * flag is missing or the download fails -- fail-soft, matching `runner
 * sidecar`/`runner finalize`: a broken resume must degrade to a fresh
 * run, never fail the dispatch. `--project-id` falls back to
 * `AGENT_TELEMETRY_PROJECT_ID` -- the same env var `runner-config.ts`'s
 * `loadRunnerConfig` already reads into `RunnerConfig.firestoreProjectId`
 * (`finalize.ts` passes that value as `uploadTranscript`'s own
 * `projectId`), so a caller that already exports it for `runner
 * sidecar`/`runner finalize` needs no extra flag here. Exported for
 * testing so a spec can exercise the real logic without spawning `node`
 * and without a real GCS call.
 */
export async function _runRunnerResumeForTesting(
  argv: string[],
  deps: {
    resumeTranscript?: typeof resumeTranscript;
    download?: Parameters<typeof resumeTranscript>[0]['download'];
  } = {},
): Promise<string | undefined> {
  const flags = parseRunnerResumeFlags(argv);
  if (!flags.sessionId || !flags.transcriptUri || !flags.cwd) {
    return undefined;
  }
  const projectId =
    flags.projectId ?? process.env['AGENT_TELEMETRY_PROJECT_ID'];
  const resume = deps.resumeTranscript ?? resumeTranscript;
  return resume({
    sessionId: flags.sessionId,
    transcriptGcsUri: flags.transcriptUri,
    cwd: flags.cwd,
    claudeProjectsDir: flags.projectsDir ?? defaultClaudeProjectsDir(),
    ...(projectId && { projectId }),
    ...(deps.download && { download: deps.download }),
  });
}

function runRunnerResume(argv: string[]): void {
  _runRunnerResumeForTesting(argv)
    .then((written) => {
      if (written) process.stdout.write(written);
    })
    .catch((error) => {
      logger.error(
        'agent-lcars-telemetry-watcher: runner resume crashed; exiting 0 anyway (telemetry must never fail the agent job)',
        error,
      );
    })
    .finally(() => process.exit(0));
}
```

In `main()`'s dispatch, add a third branch alongside `sidecar`/`finalize`:

```ts
if (mode === 'runner' && subcommand === 'resume') {
  runRunnerResume(rest);
  return;
}
```

- [ ] **Step 4: Run** — `./tools/nx test agent-lcars-telemetry-watcher -- main` → PASS; `./tools/nx typecheck agent-lcars-telemetry-watcher` → clean.

- [ ] **Step 5: Commit**

```bash
git add apps/telemetry-watcher/src/main.ts apps/telemetry-watcher/src/main.spec.ts
git commit -m "$(cat <<'EOF'
feat(telemetry-watcher): runner resume CLI subcommand

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BiTUeJCQByPUqRLZUpt3CD
EOF
)"
git push
```

---

### Task 6: Lane resume step and `claude_args`

**Files:**

- Create: `.github/actions/resume-session/action.yml`
- Create: `.github/actions/resume-session/resume.test.sh`
- Modify: `.github/workflows/agent-lane.yml`
- Modify: `.github/workflows/ci.yml` (register the new test)

**Interfaces:**

- Consumes: `run resume` CLI subcommand (Task 5); `work.resume` (Task 3);
  `steps.telemetry-start.outputs['credentials-file-path']` (existing).
- Produces: `resume-session` composite action's `session-id` output
  (empty when no resume happened); `agent-lane.yml`'s "Run Claude Code"
  step gains a conditional `--resume <id>` in `claude_args`.

- [ ] **Step 1: Write the failing test**

```bash
# .github/actions/resume-session/resume.test.sh -- create, modeled on
# direct-runner.test.sh's fake-PATH-binary pattern.
#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tmp="$(mktemp -d)"
export tmp
trap 'rm -rf "$tmp"' EXIT

mkdir -p "$tmp/bin" "$tmp/lib/agent-lcars"
cat > "$tmp/lib/agent-lcars/sidecar.cjs" <<'FAKE'
console.log('/fake/claude/projects/-fake-cwd/sess_1.jsonl');
FAKE

cat > "$tmp/bin/node" <<'FAKE'
#!/usr/bin/env bash
echo "$@" > "$tmp/node-args.log"
node_real="$(command -v -p node)"
FAKE
# (the fixture shells out to the fake sidecar path above rather than a
# real node subprocess -- keep this fixture's `node` a thin recorder, and
# assert on the composite step's own bash logic, not on Node execution.)
chmod +x "$tmp/bin/node"

export PATH="$tmp/bin:$PATH"

WORK_JSON='{"id":"01X","spec":{"title":"t","description":"d","pipeline":"claude","target":{"repo":"o/r"}},"resume":{"sessionId":"sess_1","transcriptGcsUri":"gs://b/x.jsonl"}}'
GOOGLE_APPLICATION_CREDENTIALS="$tmp/creds.json" bash "$here/resume.sh" \
  "$WORK_JSON" "/usr/local/lib/agent-lcars/sidecar.cjs" > "$tmp/out.txt"

grep -q 'sess_1' "$tmp/node-args.log" || { echo "FAIL: session id not passed"; exit 1; }
echo "PASS"
```

- [ ] **Step 2: Run to verify it fails** — `bash .github/actions/resume-session/resume.test.sh` → FAIL (`resume.sh` does not exist).

- [ ] **Step 3: Implement**

```bash
#!/usr/bin/env bash
# .github/actions/resume-session/resume.sh
#
# Downloads a prior session's transcript into Claude Code's local session
# store when the dispatched work carries a resume request. Fail-soft: any
# missing input or failed download prints nothing, and this always exits
# 0 -- a broken resume degrades to a fresh run (sub-project 6).
#
# Usage: resume.sh '<work-json>' <sidecar-bin-path>
set -uo pipefail

WORK_JSON="${1:-}"
SIDECAR_BIN="${2:-/usr/local/lib/agent-lcars/sidecar.cjs}"

session_id="$(jq -r '.resume.sessionId // empty' <<<"$WORK_JSON" 2>/dev/null || true)"
transcript_uri="$(jq -r '.resume.transcriptGcsUri // empty' <<<"$WORK_JSON" 2>/dev/null || true)"

if [ -z "$session_id" ] || [ -z "$transcript_uri" ] || \
   [ -z "${GOOGLE_APPLICATION_CREDENTIALS:-}" ] || [ ! -s "$SIDECAR_BIN" ]; then
  exit 0
fi

# AGENT_TELEMETRY_PROJECT_ID is exported inline exactly as
# sidecar-lifecycle.sh already does for `runner sidecar`/`runner
# finalize` -- the same GCS project the transcript was uploaded to.
resumed_path="$(AGENT_TELEMETRY_PROJECT_ID=agent-lcars node "$SIDECAR_BIN" runner resume \
  --session-id "$session_id" --transcript-uri "$transcript_uri" --cwd "$PWD" \
  2>/dev/null || true)"

if [ -n "$resumed_path" ]; then
  echo "session-id=$session_id"
fi
exit 0
```

```yaml
# .github/actions/resume-session/action.yml
name: Resume prior session
description: >-
  Downloads a prior session's archived transcript into Claude Code's local
  session store when the dispatched work carries a resume request
  (native work items sub-project 6), so a later `--resume <sessionId>`
  finds it.

inputs:
  work-json:
    description: The raw `work` workflow_dispatch input (JSON), read for `.resume`.
    required: true
  credentials-file-path:
    description: telemetry-writer credentials file path (telemetry-start's output).
    required: true

outputs:
  session-id:
    description: The resumed session id, or empty when no resume happened.
    value: ${{ steps.resume.outputs.session-id }}

runs:
  using: composite
  steps:
    - name: Download prior session transcript
      id: resume
      shell: bash
      env:
        GOOGLE_APPLICATION_CREDENTIALS: ${{ inputs.credentials-file-path }}
      run: |
        set -euo pipefail
        out="$(bash "${{ github.action_path }}/resume.sh" '${{ inputs.work-json }}' /usr/local/lib/agent-lcars/sidecar.cjs)"
        echo "$out" >> "$GITHUB_OUTPUT"
```

```yaml
# .github/workflows/agent-lane.yml -- new step, right after "Start
# telemetry sidecar (published)" and before "Run Claude Code".
- name: Resume prior session
  id: resume-session
  if: ${{ inputs.pipeline == 'claude' }}
  uses: ./.github/actions/resume-session
  with:
    work-json: ${{ inputs.work }}
    credentials-file-path: ${{ steps.telemetry-start.outputs['credentials-file-path'] || steps.telemetry-start-published.outputs['credentials-file-path'] }}
```

In the "Run Claude Code" step's `claude_args`, append a conditional
`--resume` line:

```yaml
claude_args: |
  --max-turns ${{ steps.budget.outputs.max_turns }}
  --allowedTools "Bash,Edit,Write,MultiEdit"
  --disallowedTools "ScheduleWakeup,SendMessage,Monitor,Task"
  ${{ steps.resume-session.outputs.session-id && format('--resume {0}', steps.resume-session.outputs.session-id) || '' }}
```

Register the test in `ci.yml`, alongside the other `.test.sh` steps:

```yaml
- name: Test resume-session action
  run: bash .github/actions/resume-session/resume.test.sh
```

- [ ] **Step 4: Run** — `bash .github/actions/resume-session/resume.test.sh` → PASS; `pnpm exec prettier --check .github/actions/resume-session/action.yml .github/workflows/agent-lane.yml .github/workflows/ci.yml`.

- [ ] **Step 5: Commit**

```bash
git add .github/actions/resume-session/ .github/workflows/agent-lane.yml .github/workflows/ci.yml
git commit -m "$(cat <<'EOF'
feat(agents): lane resume step and conditional --resume in claude_args

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BiTUeJCQByPUqRLZUpt3CD
EOF
)"
git push
```

---

### Task 7: Direct-runner mode resume

**Files:**

- Modify: `apps/runner-autoscaler/runner-image/direct-runner.sh`
- Modify: `apps/runner-autoscaler/runner-image/direct-runner.test.sh`

**Interfaces:**

- Consumes: `brief.resume` (Task 3); `sidecar.cjs runner resume` (Task 5).
- Produces: direct mode's `claude` invocation gains a conditional
  `--resume <sessionId>` flag.

- [ ] **Step 1: Extend the failing fixture**

```bash
# direct-runner.test.sh -- change the fake curl's */brief branch to
# include a resume object, and add an assertion that the fake claude
# binary (or a new probe) observed --resume.
  */brief)
    cat <<'JSON'
{"id":"01DIRECTRUNNERTESTFIXTURE1","spec":{"title":"t","description":"d","pipeline":"claude","target":{"repo":"octo/example"}},"anchor":{"type":"work","id":"01DIRECTRUNNERTESTFIXTURE1","title":"t","body":"d","target_repo":"octo/example","html_url":"https://lcars.test/work/01DIRECTRUNNERTESTFIXTURE1"},"attemptId":"g1:work:01DIRECTRUNNERTESTFIXTURE1/r1","generation":1,"intentId":"work:01DIRECTRUNNERTESTFIXTURE1/r1","resume":{"sessionId":"sess_1","transcriptGcsUri":"gs://bucket/runs/x/claude-code/sess_1.jsonl"}}
JSON
    ;;
```

Add a fake `sidecar.cjs`-invoking `node` (mirroring `resume-session`'s own
test) that records its args, and a fake `claude` that writes the args it
was called with to `$tmp/claude-args.log`; assert `--resume sess_1`
appears in that log after running `direct-runner.sh`.

- [ ] **Step 2: Run to verify it fails** — `bash apps/runner-autoscaler/runner-image/direct-runner.test.sh` → FAIL (no `--resume` passed).

- [ ] **Step 3: Implement**

```bash
# direct-runner.sh -- after the existing `INTENT_ID=...`/`export
# GITHUB_REPOSITORY=...` block, capture the resume fields:
RESUME_SESSION_ID="$(jq -r '.resume.sessionId // empty' <<<"$brief")"
RESUME_TRANSCRIPT_URI="$(jq -r '.resume.transcriptGcsUri // empty' <<<"$brief")"
```

```bash
# direct-runner.sh -- after `cd "$workspace"` and the git credential
# setup, before the PROMPT/sidecar-start block:
RESUME_FLAG=()
if [ -n "$RESUME_SESSION_ID" ] && [ -n "$RESUME_TRANSCRIPT_URI" ]; then
  # GOOGLE_APPLICATION_CREDENTIALS and AGENT_TELEMETRY_PROJECT_ID are
  # exported inline exactly as sidecar-lifecycle.sh already does for
  # `runner sidecar`/`runner finalize` -- the same telemetry-writer
  # credential and GCS project the transcript was uploaded to/from.
  resumed_path="$(GOOGLE_APPLICATION_CREDENTIALS=/run/secrets/telemetry-writer.json \
    AGENT_TELEMETRY_PROJECT_ID=agent-lcars \
    node /usr/local/lib/agent-lcars/sidecar.cjs runner resume \
    --session-id "$RESUME_SESSION_ID" --transcript-uri "$RESUME_TRANSCRIPT_URI" \
    --cwd "$PWD" 2>/dev/null || true)"
  if [ -n "$resumed_path" ]; then
    RESUME_FLAG=(--resume "$RESUME_SESSION_ID")
  fi
fi
```

```bash
# direct-runner.sh -- the claude invocation gains the flag array:
claude \
  --dangerously-skip-permissions \
  --allowedTools "Bash,Edit,Write,MultiEdit" \
  --disallowedTools "ScheduleWakeup,SendMessage,Monitor,Task" \
  "${RESUME_FLAG[@]}" \
  --print "$AGENT_PROMPT"
```

- [ ] **Step 4: Run** — `bash apps/runner-autoscaler/runner-image/direct-runner.test.sh` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/runner-autoscaler/runner-image/direct-runner.sh apps/runner-autoscaler/runner-image/direct-runner.test.sh
git commit -m "$(cat <<'EOF'
feat(runner-image): direct-runner.sh resumes a prior session

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BiTUeJCQByPUqRLZUpt3CD
EOF
)"
git push
```

---

### Task 8: `work.reaper` scope, the `reader` gate, and `touchSessionExpiry`

**Files:**

- Modify: `apps/console/src/lib/github-actions-oidc.ts`
- Modify: `apps/console/src/lib/github-actions-oidc.test.ts`
- Modify: `apps/console/src/lib/work-auth.ts`
- Modify: `apps/console/src/lib/work-auth.test.ts`
- Modify: `apps/console/src/lib/work-router.ts`
- Modify: `apps/console/src/lib/work-router.test.ts`
- Modify: `apps/console/src/app/api/work/v1/[[...rest]]/route.ts` (Task 2
  already added `getSessionDoc: sessionForResume` here; this task's own
  edit is additive — the `verifySessionPinTickOidcToken` wiring only)
- Modify: `apps/console/src/app/work/context.ts` (same — Task 2's
  `getSessionDoc` wiring already lands there; this task adds the OIDC
  verifier only)
- Modify: `libs/telemetry/src/server/store.ts`
- Modify: `libs/telemetry/src/server/store.spec.ts` (this file already
  exists, using `firestore-jest-mock`'s `FakeFirestore` — no emulator, no
  `skipIf` — see Step 1/Step 3 below for the exact convention to match)

**Interfaces:**

- Produces: `assertSessionPinTickOidcClaims(claims, repository):
SessionPinTickOidcIdentity`; `verifySessionPinTickOidcToken(token,
repository): Promise<SessionPinTickOidcIdentity>`. `WorkScope` gains
  `'work.reaper'`; `authenticateWorkRequest` gains a fourth branch
  returning `{ principal: 'pin:tick', subject: 'pin:tick', scopes:
{'work.reaper'}, pipelines: [], via: 'oidc' }`. `workRouter`'s `list`/`get`
  move to a `reader` gate (`work.operator` **or** `work.reaper`);
  `create`/`cancel`/`redispatch` stay on `operator`.
  `touchSessionExpiry(sessionId: string, expireAt: string): Promise<void>`
  exported from `@agent-lcars/telemetry/server`. Consumed by Task 9 (the
  pin-sweep script).

- [ ] **Step 1: Write the failing tests**

```ts
// apps/console/src/lib/github-actions-oidc.test.ts -- mirror the
// schedule-tick describe block; add SESSION_PIN_TICK_OIDC_AUDIENCE/
// SESSION_PIN_TICK_WORKFLOW_PATH constants matching the values below, and
// import assertSessionPinTickOidcClaims.
const SESSION_PIN_TICK_OIDC_AUDIENCE = 'agent-lcars-session-pin-tick';
const SESSION_PIN_TICK_WORKFLOW_PATH =
  '.github/workflows/work-session-pin-tick.yml';

const sessionPinTickClaims = {
  aud: SESSION_PIN_TICK_OIDC_AUDIENCE,
  repository,
  repository_id: '1307149765',
  run_id: '93099054200',
  job_workflow_ref: `${repository}/${SESSION_PIN_TICK_WORKFLOW_PATH}@refs/heads/main`,
  ref: 'refs/heads/main',
  event_name: 'schedule',
};

describe('GitHub Actions session-pin-tick OIDC claims', () => {
  it('accepts the scheduled and manual tick workflow on main', () => {
    expect(
      assertSessionPinTickOidcClaims(sessionPinTickClaims, repository),
    ).toEqual({
      repository,
      repositoryId: 1_307_149_765,
      runId: 93_099_054_200,
    });
  });

  it.each([
    [{ ...sessionPinTickClaims, repository: 'attacker/fork' }, 'repository'],
    [
      {
        ...sessionPinTickClaims,
        job_workflow_ref: `${repository}/.github/workflows/ci.yml@refs/heads/main`,
      },
      'job_workflow_ref',
    ],
    [{ ...sessionPinTickClaims, ref: 'refs/heads/feature' }, 'ref'],
    [{ ...sessionPinTickClaims, event_name: 'pull_request' }, 'event_name'],
  ])('rejects a caller with the wrong %s claim', (claims, field) => {
    expect(() => assertSessionPinTickOidcClaims(claims, repository)).toThrow(
      field,
    );
  });
});
```

```ts
// apps/console/src/lib/work-auth.test.ts -- add verifySessionPinTickOidcToken
// to deps()'s defaults, and this test:
it('falls through to the session-pin-tick verifier when neither Google nor schedule-tick match', async () => {
  const p = await authenticateWorkRequest(
    req({ authorization: 'Bearer t' }),
    deps({
      verifyGoogleIdToken: async () => {
        throw new Error('not Google');
      },
      verifyScheduleTickOidcToken: async () => {
        throw new Error('not schedule-tick');
      },
      verifySessionPinTickOidcToken: async () => ({ ok: true }),
    }),
  );
  expect(p).toMatchObject({
    principal: 'pin:tick',
    subject: 'pin:tick',
    via: 'oidc',
  });
  expect(p?.scopes.has('work.reaper')).toBe(true);
});
```

```ts
// apps/console/src/lib/work-router.test.ts -- add.
describe('list/get accept work.reaper without work.operator', () => {
  it('list succeeds for a reaper-scoped principal', async () => {
    const ctx = context({
      principal: {
        principal: 'pin:tick',
        subject: 'pin:tick',
        scopes: new Set(['work.reaper']),
        pipelines: [],
        via: 'oidc',
      },
    });
    await expect(
      workRouter.list({ limit: 50 }, { context: ctx }),
    ).resolves.toBeDefined();
  });

  it('create still refuses a reaper-only principal', async () => {
    const ctx = context({
      principal: {
        principal: 'pin:tick',
        subject: 'pin:tick',
        scopes: new Set(['work.reaper']),
        pipelines: [],
        via: 'oidc',
      },
    });
    await expect(
      workRouter.create({ id: 'ID', spec: nativeSpec() }, { context: ctx }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
});
```

```ts
// libs/telemetry/src/server/store.spec.ts -- this file has no emulator
// and no `skipIf`: it mocks `firebase-admin/firestore` with
// `firestore-jest-mock`'s `FakeFirestore` (see the file's existing
// `describe('agent-telemetry store', ...)` block, `beforeEach`, and the
// `sessionDoc`/`sessionWrite` helpers already defined there). Add
// `touchSessionExpiry` to the `./store` import, and this describe block
// alongside the existing `upsertSession` one, inside the same
// `describe('agent-telemetry store', ...)`:
describe('touchSessionExpiry', () => {
  it('rewrites only expireAt, leaving other fields untouched', async () => {
    await upsertSession(sessionWrite({ turns: 3 }));
    const future = new Date('2027-08-27T00:00:00.000Z').toISOString();

    await touchSessionExpiry('session-1', future);

    const snap = await fakeFirestore
      .collection('sessions')
      .doc('session-1')
      .get();
    expect(snap.data()?.['expireAt']).toEqual(
      Timestamp.fromDate(new Date(future)),
    );
    expect(snap.data()?.['turns']).toBe(3);
  });

  it('writes expireAt as a native Firestore Timestamp, not the ISO string', async () => {
    await upsertSession(sessionWrite());

    await touchSessionExpiry('session-1', '2027-01-01T00:00:00.000Z');

    const snap = await fakeFirestore
      .collection('sessions')
      .doc('session-1')
      .get();
    expect(snap.data()?.['expireAt']).toBeInstanceOf(Timestamp);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `./tools/nx test @agent-lcars/console -- github-actions-oidc work-auth work-router` and `./tools/nx test @agent-lcars/telemetry -- store` → FAIL.

- [ ] **Step 3: Implement**

```ts
// apps/console/src/lib/github-actions-oidc.ts -- add after
// verifyScheduleTickOidcToken.
const SESSION_PIN_TICK_OIDC_AUDIENCE = 'agent-lcars-session-pin-tick';
const SESSION_PIN_TICK_WORKFLOW_PATH =
  '.github/workflows/work-session-pin-tick.yml';

export interface SessionPinTickOidcIdentity {
  repository: string;
  repositoryId: number;
  runId: number;
}

export function assertSessionPinTickOidcClaims(
  claims: JWTPayload,
  repository: string,
): SessionPinTickOidcIdentity {
  const expectedJobWorkflowRef = `${repository}/${SESSION_PIN_TICK_WORKFLOW_PATH}@refs/heads/main`;
  if (claims['repository'] !== repository) {
    throw new Error('OIDC repository claim does not match the control plane');
  }
  if (claims['job_workflow_ref'] !== expectedJobWorkflowRef) {
    throw new Error(
      'OIDC job_workflow_ref claim is not the session pin tick workflow on main',
    );
  }
  if (claims['ref'] !== 'refs/heads/main') {
    throw new Error('OIDC ref claim is not main');
  }
  if (
    !['schedule', 'workflow_dispatch'].includes(String(claims['event_name']))
  ) {
    throw new Error(
      'OIDC event_name claim is not an allowed session-pin-tick event',
    );
  }
  return {
    repository,
    repositoryId: positiveIntegerClaim(
      claims['repository_id'],
      'repository_id',
    ),
    runId: positiveIntegerClaim(claims['run_id'], 'run_id'),
  };
}

export async function verifySessionPinTickOidcToken(
  token: string,
  repository: string,
): Promise<SessionPinTickOidcIdentity> {
  const { payload } = await jwtVerify(token, githubActionsJwks, {
    issuer: GITHUB_ACTIONS_ISSUER,
    audience: SESSION_PIN_TICK_OIDC_AUDIENCE,
  });
  return assertSessionPinTickOidcClaims(payload, repository);
}
```

```ts
// apps/console/src/lib/work-auth.ts -- WorkScope, WorkAuthDeps, and
// authenticateWorkRequest changes.
export type WorkScope =
  'work.operator' | 'work.cron' | 'work.executor' | 'work.reaper';

export interface WorkAuthDeps {
  verifyGoogleIdToken: (
    token: string,
  ) => Promise<{ email: string; emailVerified: boolean }>;
  verifyScheduleTickOidcToken: (token: string) => Promise<unknown>;
  /** GitHub Actions OIDC verifier for the session-pin-tick trigger
   *  (`work-session-pin-tick.yml`, sub-project 6) -- tried after the
   *  schedule-tick verifier, on the same "not Google, try the next
   *  pinned workflow" fallthrough `authenticateWorkRequest` already uses. */
  verifySessionPinTickOidcToken: (token: string) => Promise<unknown>;
  session: () => Promise<{ user?: { login?: string } } | null>;
  grants: () => WorkGrant[];
}

// ...inside authenticateWorkRequest, after the schedule-tick try/catch:
try {
  await deps.verifyScheduleTickOidcToken(token);
  return {
    principal: 'cron:tick',
    subject: 'cron:tick',
    scopes: new Set<WorkScope>(['work.cron']),
    pipelines: [],
    via: 'oidc',
  };
} catch {
  // fall through
}
try {
  await deps.verifySessionPinTickOidcToken(token);
  return {
    principal: 'pin:tick',
    subject: 'pin:tick',
    scopes: new Set<WorkScope>(['work.reaper']),
    pipelines: [],
    via: 'oidc',
  };
} catch {
  return undefined;
}
```

```ts
// apps/console/src/lib/work-router.ts -- add a second gate beside
// `operator`, and repoint list/get.
/** `list`/`get` additionally accept `work.reaper` (sub-project 6's
 *  session-pin tick, a read-only caller) -- `create`/`cancel`/`redispatch`
 *  stay `operator`-only; a reaper-scoped principal must never mint or
 *  settle a run. */
const reader = os.use(async ({ context, next }) => {
  const { principal } = context;
  if (
    principal === undefined ||
    (!principal.scopes.has('work.operator') && !principal.scopes.has('work.reaper'))
  ) {
    throw new ORPCError('UNAUTHORIZED', {
      message: 'work.operator or work.reaper scope required',
    });
  }
  return next({ context: { principal } });
});

export const workRouter = os.router({
  create: operator.create.handler(/* unchanged */ ...),
  get: reader.get.handler(/* unchanged body */ ...),
  list: reader.list.handler(/* unchanged body */ ...),
  cancel: operator.cancel.handler(/* unchanged */ ...),
  redispatch: operator.redispatch.handler(/* unchanged from Task 2 */ ...),
});
```

```ts
// apps/console/src/app/api/work/v1/[[...rest]]/route.ts and
// apps/console/src/app/work/context.ts -- both gain the same edit. Note:
// `getSessionDoc: sessionForResume` is NOT added here -- Task 2 already
// wired it into both files' `WorkContext` object literals. This task's
// diff against each file touches only the `authenticateWorkRequest` deps
// object below.
import {
  verifyScheduleTickOidcToken,
  verifySessionPinTickOidcToken,
} from '@/lib/github-actions-oidc';
// ...
const principal = await authenticateWorkRequest(
  request /* or the stub Request in context.ts */,
  {
    verifyGoogleIdToken,
    verifyScheduleTickOidcToken: (token) =>
      verifyScheduleTickOidcToken(token, controlPlaneRepository()),
    verifySessionPinTickOidcToken: (token) =>
      verifySessionPinTickOidcToken(token, controlPlaneRepository()),
    session: async () => (await auth()) as { user?: { login?: string } } | null,
    grants: workGrants,
  },
);
```

```ts
// libs/telemetry/src/server/store.ts -- add below upsertSession.
/**
 * Rewrites only `expireAt` on an existing session doc -- the
 * watermark-only write the session-pin reaper needs (sub-project 6), as
 * opposed to `upsertSession`'s full reduce-then-merge write. Same
 * Timestamp conversion `upsertSession` already applies to the same field,
 * for the same reason: the collection's native Firestore TTL policy only
 * recognizes a Timestamp, not the ISO string `SessionDoc` carries.
 */
export async function touchSessionExpiry(
  sessionId: string,
  expireAt: string,
): Promise<void> {
  const firestore = getAgentTelemetryWriterFirestore();
  await firestore
    .collection(SESSIONS_COLLECTION)
    .doc(sessionId)
    .set(
      { expireAt: AdminTimestamp.fromDate(new Date(expireAt)) },
      { merge: true },
    );
}
```

- [ ] **Step 4: Run** — `./tools/nx test @agent-lcars/console -- github-actions-oidc work-auth work-router` and `./tools/nx test @agent-lcars/telemetry -- store` → PASS (the `store.spec.ts` run needs no emulator and nothing is `skipIf`-gated — `FakeFirestore` runs the same locally and in CI); typecheck both clean.

- [ ] **Step 5: Commit**

```bash
git add apps/console/src/lib/github-actions-oidc.ts apps/console/src/lib/github-actions-oidc.test.ts apps/console/src/lib/work-auth.ts apps/console/src/lib/work-auth.test.ts apps/console/src/lib/work-router.ts apps/console/src/lib/work-router.test.ts apps/console/src/app/api/work/v1/\[\[...rest\]\]/route.ts apps/console/src/app/work/context.ts libs/telemetry/src/server/store.ts libs/telemetry/src/server/store.spec.ts
git commit -m "$(cat <<'EOF'
feat(console): work.reaper scope, reader gate, and touchSessionExpiry

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BiTUeJCQByPUqRLZUpt3CD
EOF
)"
git push
```

---

### Task 9: The pin-sweep script and its scheduled workflow

**Files:**

- Create: `apps/telemetry-watcher/bin/session-pin-tick.ts`
- Create: `apps/telemetry-watcher/bin/session-pin-tick.spec.ts`
- Create: `.github/workflows/work-session-pin-tick.yml`
- Create: `tools/workflow-session-pin-tick.test.sh`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**

- Consumes: `touchSessionExpiry` (Task 8); `GET /items?state=...` (Task 8's
  `reader` gate).
- Produces: `pinOpenItemSessions(deps): Promise<{ pinned: string[] }>` —
  the tested unit; a thin `main()` wrapper reads
  `SESSION_PIN_TICK_BEARER`/`AGENT_LCARS_CONSOLE_URL` from the environment.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/telemetry-watcher/bin/session-pin-tick.spec.ts
import { pinOpenItemSessions } from './session-pin-tick';

function itemsResponse(
  items: { id: string; sessions: { sessionId: string }[] }[],
) {
  return new Response(JSON.stringify({ items }), { status: 200 });
}

describe('pinOpenItemSessions', () => {
  it('touches expireAt for every session of every running or parked item', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        itemsResponse([
          { id: 'A', sessions: [{ sessionId: 's1' }, { sessionId: 's2' }] },
        ]),
      )
      .mockResolvedValueOnce(
        itemsResponse([{ id: 'B', sessions: [{ sessionId: 's3' }] }]),
      );
    const touchExpiry = vi.fn();
    const { pinned } = await pinOpenItemSessions({
      bearer: 'tok',
      now: new Date('2026-08-27T00:00:00.000Z'),
      fetchImpl,
      touchExpiry,
    });
    expect(pinned.sort()).toEqual(['s1', 's2', 's3']);
    expect(touchExpiry).toHaveBeenCalledWith('s1', '2027-08-27T00:00:00.000Z');
    expect(fetchImpl.mock.calls[0]?.[0]).toContain('state=running');
    expect(fetchImpl.mock.calls[1]?.[0]).toContain('state=parked');
  });

  it('touches nothing when both states return no items (a settled item is simply absent)', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(itemsResponse([]))
      .mockResolvedValueOnce(itemsResponse([]));
    const touchExpiry = vi.fn();
    const { pinned } = await pinOpenItemSessions({
      bearer: 'tok',
      fetchImpl,
      touchExpiry,
    });
    expect(pinned).toEqual([]);
    expect(touchExpiry).not.toHaveBeenCalled();
  });

  it('throws on a non-ok response rather than silently skipping', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 401 }));
    await expect(
      pinOpenItemSessions({ bearer: 'tok', fetchImpl, touchExpiry: vi.fn() }),
    ).rejects.toThrow(/401/);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `./tools/nx test agent-lcars-telemetry-watcher -- session-pin-tick` → FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
#!/usr/bin/env -S pnpm exec tsx
// apps/telemetry-watcher/bin/session-pin-tick.ts
//
// Sub-project 6's reaper. Lists every open (running/parked) native item
// via the read-only work API (a GitHub-Actions-OIDC bearer, work.reaper
// scope -- see work-auth.ts) and rewrites `expireAt` forward on every
// session those items carry, via telemetry_writer's own Firestore write
// access (WIF-impersonated by the calling workflow). Run by
// work-session-pin-tick.yml, not baked into the runner image -- this is
// a repo-level CI script, invoked with `pnpm exec tsx`, not part of
// sidecar.cjs's bundle.
import { touchSessionExpiry } from '@agent-lcars/telemetry/server';

/** Matches libs/telemetry/src/lib/session-doc.ts's
 *  ISSUE_AGENT_SESSION_RETENTION_DAYS -- kept as a local literal rather
 *  than importing that module (server-only, Next-specific bundling
 *  concerns this standalone script does not need); if that retention
 *  value ever changes, this constant must change with it. Flagged in the
 *  self-review as a manually-synced value, not a shared import. */
const RETENTION_DAYS = 365;

interface ItemSessionLike {
  sessionId: string;
}
interface ItemLike {
  id: string;
  sessions: ItemSessionLike[];
}
interface ItemsResponse {
  items: ItemLike[];
}

export interface PinOpenItemSessionsDeps {
  bearer: string;
  consoleUrl?: string;
  now?: Date;
  fetchImpl?: typeof fetch;
  touchExpiry?: typeof touchSessionExpiry;
}

export async function pinOpenItemSessions(
  deps: PinOpenItemSessionsDeps,
): Promise<{ pinned: string[] }> {
  const consoleUrl = deps.consoleUrl ?? 'https://lcars.jlapenna.net';
  const fetchImpl = deps.fetchImpl ?? fetch;
  const touchExpiry = deps.touchExpiry ?? touchSessionExpiry;
  const now = deps.now ?? new Date();
  const expireAt = new Date(
    now.getTime() + RETENTION_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  const pinned: string[] = [];
  for (const state of ['running', 'parked'] as const) {
    const response = await fetchImpl(
      `${consoleUrl}/api/work/v1/items?state=${state}&limit=200`,
      { headers: { authorization: `Bearer ${deps.bearer}` } },
    );
    if (!response.ok) {
      throw new Error(`GET /items?state=${state} -> ${response.status}`);
    }
    const body = (await response.json()) as ItemsResponse;
    for (const item of body.items) {
      for (const session of item.sessions) {
        await touchExpiry(session.sessionId, expireAt);
        pinned.push(session.sessionId);
      }
    }
  }
  return { pinned };
}

async function main(): Promise<void> {
  const bearer = process.env['SESSION_PIN_TICK_BEARER'];
  if (!bearer) {
    console.error('SESSION_PIN_TICK_BEARER is required');
    process.exit(1);
  }
  const { pinned } = await pinOpenItemSessions({
    bearer,
    ...(process.env['AGENT_LCARS_CONSOLE_URL'] && {
      consoleUrl: process.env['AGENT_LCARS_CONSOLE_URL'],
    }),
  });
  console.log(
    `pinned ${pinned.length} session(s): ${pinned.join(', ') || '(none)'}`,
  );
}

// tsx-executed entrypoint guard -- mirrors main.ts's own module-vs-import
// discipline (this file is imported directly by session-pin-tick.spec.ts
// without running main()).
if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
```

```yaml
# .github/workflows/work-session-pin-tick.yml
name: Work Session Pin Tick

# Sub-project 6: rewrites expireAt forward on every session belonging to
# a still-open (running/parked) native work item, so Firestore's native
# TTL policy on sessions.expireAt never reaps them out from under an item
# that is still in play. See
# docs/superpowers/specs/2026-08-23-native-work-items-design.md,
# "Sub-project 6: session resume and persistence".

on:
  schedule:
    # Offset from :00/:30, matching dispatch-reconcile.yml's stampede
    # avoidance. 365 days of retention headroom means a missed tick or
    # several is not an incident.
    - cron: '17,47 * * * *'
  workflow_dispatch:

permissions:
  contents: read
  id-token: write

concurrency:
  group: work-session-pin-tick
  cancel-in-progress: false

jobs:
  pin:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4
        with:
          sparse-checkout: |
            apps/telemetry-watcher/bin
            apps/telemetry-watcher/package.json
            package.json
            pnpm-lock.yaml
            pnpm-workspace.yaml

      - uses: pnpm/action-setup@a7487c7e89a18df4991f7f222e4898a00d66ddda # v4
      - uses: actions/setup-node@0a44ba7841725637a19e28fa30b79a866c81b0a1 # v4
        with:
          node-version-file: package.json
          cache: pnpm

      - run: pnpm install --frozen-lockfile --prod=false

      # Read side: a session-pin-tick-audienced GitHub Actions OIDC token,
      # verified by work-auth.ts's fourth branch (work.reaper scope, no
      # grant-list entry needed -- an OIDC principal, like cron:tick).
      - name: Mint a session-pin-tick bearer
        id: pin-tick-token
        run: |
          set -euo pipefail
          resp="$(curl -sS -H "Authorization: Bearer ${ACTIONS_ID_TOKEN_REQUEST_TOKEN}" \
            "${ACTIONS_ID_TOKEN_REQUEST_URL}&audience=agent-lcars-session-pin-tick")"
          echo "token=$(jq -r .value <<<"$resp")" >> "$GITHUB_OUTPUT"

      # Write side: WIF-impersonate telemetry_writer -- the exact same
      # binding .github/actions/telemetry-start already exercises for
      # every dispatched run (fleet_writer_impersonation, infra/terraform/
      # main.tf). No new Terraform, IAM, or secret.
      - name: Authenticate telemetry writer
        id: telemetry-auth
        uses: google-github-actions/auth@7c6bc770dae815cd3e89ee6cdf493a5fab2cc093 # v3
        with:
          workload_identity_provider: ${{ vars.GCP_WIF_PROVIDER }}
          service_account: ${{ vars.GCP_TELEMETRY_WRITER_SA }}
          token_format: access_token

      - name: Run the pin sweep
        env:
          SESSION_PIN_TICK_BEARER: ${{ steps.pin-tick-token.outputs.token }}
          GOOGLE_APPLICATION_CREDENTIALS: ${{ steps.telemetry-auth.outputs.credentials_file_path }}
        run: pnpm exec tsx apps/telemetry-watcher/bin/session-pin-tick.ts
```

```bash
#!/usr/bin/env bash
# tools/workflow-session-pin-tick.test.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
file="$here/.github/workflows/work-session-pin-tick.yml"

grep -q "cron: '17,47 \* \* \* \*'" "$file" || { echo "FAIL: cadence"; exit 1; }
grep -q 'workflow_dispatch:' "$file" || { echo "FAIL: manual trigger"; exit 1; }
grep -q 'id-token: write' "$file" || { echo "FAIL: id-token permission"; exit 1; }
grep -q 'audience=agent-lcars-session-pin-tick' "$file" || { echo "FAIL: read audience"; exit 1; }
grep -q 'token_format: access_token' "$file" || { echo "FAIL: write token format"; exit 1; }
grep -q 'session-pin-tick.ts' "$file" || { echo "FAIL: script invocation"; exit 1; }
echo "PASS"
```

Register in `ci.yml`:

```yaml
- name: Test work-session-pin-tick.yml
  run: bash tools/workflow-session-pin-tick.test.sh
```

- [ ] **Step 4: Run** — `./tools/nx test agent-lcars-telemetry-watcher -- session-pin-tick` → PASS; `bash tools/workflow-session-pin-tick.test.sh` → PASS; `pnpm exec prettier --check .github/workflows/work-session-pin-tick.yml`.

- [ ] **Step 5: Commit**

```bash
git add apps/telemetry-watcher/bin/session-pin-tick.ts apps/telemetry-watcher/bin/session-pin-tick.spec.ts .github/workflows/work-session-pin-tick.yml tools/workflow-session-pin-tick.test.sh .github/workflows/ci.yml
git commit -m "$(cat <<'EOF'
feat(work): session-pin-tick reaper and its scheduled workflow

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BiTUeJCQByPUqRLZUpt3CD
EOF
)"
git push
```

---

### Task 10: Console — resume checkbox and pinned badge

**Files:**

- Modify: `apps/console/src/app/work/work-actions.tsx`
- Modify: `apps/console/src/app/work/work-actions.test.tsx`
- Modify: `apps/console/src/app/work/[id]/page.tsx`

**Interfaces:**

- Consumes: `itemsContract.redispatch.input.resumeSessionId` (Task 1,
  automatically widens `redispatchItem`'s type — no edit to
  `work/actions.ts` needed).
- Produces: `WorkActions`' `redispatch` prop widens to accept
  `{ id: string; resumeSessionId?: string }`; a new optional
  `resumeCandidate` prop.

- [ ] **Step 1: Write the failing tests**

```tsx
// apps/console/src/app/work/work-actions.test.tsx -- add.
it('offers a checked-by-default resume checkbox when a resumeCandidate exists', async () => {
  const redispatch = vi.fn().mockResolvedValue([null, {}]);
  render(
    <WorkActions
      id="ID1"
      state="parked"
      cancel={vi.fn().mockResolvedValue([null, {}])}
      redispatch={redispatch}
      resumeCandidate={{ sessionId: 'sess_1', title: 'Prior turn' }}
    />,
  );
  expect(screen.getByText(/Resume from session/i)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /Redispatch/i }));
  await waitFor(() =>
    expect(redispatch).toHaveBeenCalledWith({
      id: 'ID1',
      resumeSessionId: 'sess_1',
    }),
  );
});

it('omits resumeSessionId once the checkbox is unchecked', async () => {
  const redispatch = vi.fn().mockResolvedValue([null, {}]);
  render(
    <WorkActions
      id="ID1"
      state="parked"
      cancel={vi.fn().mockResolvedValue([null, {}])}
      redispatch={redispatch}
      resumeCandidate={{ sessionId: 'sess_1' }}
    />,
  );
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: /Redispatch/i }));
  await waitFor(() => expect(redispatch).toHaveBeenCalledWith({ id: 'ID1' }));
});

it('renders no resume checkbox with no resumeCandidate', () => {
  render(
    <WorkActions
      id="ID1"
      state="parked"
      cancel={vi.fn()}
      redispatch={vi.fn()}
    />,
  );
  expect(screen.queryByText(/Resume from session/i)).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run to verify it fails** — `./tools/nx test @agent-lcars/console -- work-actions` → FAIL (`resumeCandidate` prop unknown).

- [ ] **Step 3: Implement**

```tsx
// apps/console/src/app/work/work-actions.tsx -- replace the type and the
// component body.
'use client';

import type { ItemState } from '@agent-lcars/work/derive';
import { Button, Checkbox, Group, Stack } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import { showErrorToast } from '../show-error-toast';

export type WorkActionResult = readonly [
  { code: string; message: string } | null,
  unknown,
];
export type WorkAction = (input: { id: string }) => Promise<WorkActionResult>;
export type RedispatchAction = (input: {
  id: string;
  resumeSessionId?: string;
}) => Promise<WorkActionResult>;

export interface ResumeCandidate {
  sessionId: string;
  title?: string;
}

export function WorkActions({
  id,
  state,
  cancel,
  redispatch,
  resumeCandidate,
}: {
  id: string;
  state: ItemState;
  cancel: WorkAction;
  redispatch: RedispatchAction;
  resumeCandidate?: ResumeCandidate;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [resumeChecked, setResumeChecked] = useState(true);

  const canCancel = state !== 'done' && state !== 'canceled';
  const canRedispatch = state === 'parked';

  if (!canCancel && !canRedispatch) return null;

  const runCancel = () => {
    startTransition(async () => {
      const [err] = await cancel({ id });
      if (err) {
        showErrorToast(err.message);
        return;
      }
      notifications.show({ message: 'Canceled', color: 'green' });
      router.refresh();
    });
  };

  const runRedispatch = () => {
    startTransition(async () => {
      const [err] = await redispatch({
        id,
        ...(resumeChecked && resumeCandidate
          ? { resumeSessionId: resumeCandidate.sessionId }
          : {}),
      });
      if (err) {
        showErrorToast(err.message);
        return;
      }
      notifications.show({ message: 'Redispatched', color: 'green' });
      router.refresh();
    });
  };

  return (
    <Stack gap="xs">
      {canRedispatch && resumeCandidate && (
        <Checkbox
          checked={resumeChecked}
          onChange={(event) => setResumeChecked(event.currentTarget.checked)}
          label={`Resume from session ${resumeCandidate.sessionId} (${resumeCandidate.title ?? resumeCandidate.sessionId})`}
          size="sm"
        />
      )}
      <Group gap="xs">
        {canRedispatch && (
          <Button
            size="compact-sm"
            disabled={isPending}
            loading={isPending}
            onClick={runRedispatch}
          >
            Redispatch
          </Button>
        )}
        {canCancel && (
          <Button
            variant="subtle"
            color="red"
            size="compact-sm"
            disabled={isPending}
            loading={isPending}
            onClick={runCancel}
          >
            Cancel
          </Button>
        )}
      </Group>
    </Stack>
  );
}
```

```tsx
// apps/console/src/app/work/[id]/page.tsx -- compute resumeCandidate and
// pass it through; add the pinned badge to SessionsList.
function SessionsList({
  sessions,
  pinned,
}: {
  sessions: ItemView['sessions'];
  pinned: boolean;
}) {
  if (sessions.length === 0) {
    return <Text c="dimmed" size="sm">No sessions yet.</Text>;
  }
  return (
    <Stack gap={4}>
      {sessions.map((session) => (
        <Group key={session.sessionId} gap="xs">
          <Anchor href={`/sessions/${encodeURIComponent(session.sessionId)}`} size="sm">
            {session.title ?? session.sessionId}
            {session.status ? ` · ${session.status}` : ''}
          </Anchor>
          {pinned && (
            <Badge size="xs" variant="outline" color="cyan">
              pinned
            </Badge>
          )}
        </Group>
      ))}
    </Stack>
  );
}

// Inside WorkDetailViewContent, after `const { item } = detail;`:
  const latestRunView = item.runs.at(-1);
  const resumeCandidate = latestRunView
    ? [...item.sessions]
        .filter((s) => s.runId === latestRunView.runId)
        .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))[0]
    : undefined;

// WorkActions call site:
      <WorkActions
        id={item.id}
        state={item.state}
        cancel={cancelItem}
        redispatch={redispatchItem}
        {...(resumeCandidate && {
          resumeCandidate: {
            sessionId: resumeCandidate.sessionId,
            ...(resumeCandidate.title && { title: resumeCandidate.title }),
          },
        })}
      />

// SessionsList call site:
        <SessionsList
          sessions={item.sessions}
          pinned={item.state === 'running' || item.state === 'parked'}
        />
```

- [ ] **Step 4: Run** — `./tools/nx test @agent-lcars/console -- work-actions` → PASS; `./tools/nx typecheck @agent-lcars/console` → clean.

- [ ] **Step 5: Commit**

```bash
git add apps/console/src/app/work/work-actions.tsx apps/console/src/app/work/work-actions.test.tsx apps/console/src/app/work/\[id\]/page.tsx
git commit -m "$(cat <<'EOF'
feat(console): resume checkbox on redispatch and a pinned-sessions badge

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BiTUeJCQByPUqRLZUpt3CD
EOF
)"
git push
```

---

### Task 11: Land the branch, then the real-path proof

- [ ] **Step 1: Land** — `pnpm verify` (or the fast layer per task,
      already run); open the PR with `--reviewer jlapenna`; watch CI
      (Verify, `@agent-lcars/telemetry`'s `FakeFirestore`-based
      `store.spec.ts` covering `touchSessionExpiry` — no emulator
      involved, per Task 8 — the OpenAPI drift check, and the new
      shell/workflow tests); resolve review threads; squash-merge (admin
      merge permitted when the only block is the unattributed-changes
      approval rule). Confirm `main`'s `Verify` is green and the App
      Hosting rollout for the console completed.

- [ ] **Step 2: `work-create.yml` grows a `resume` input** on the
      `redispatch` action:

  ```yaml
  resume:
    description: redispatch — resume the latest session of the latest run
    required: false
    default: 'false'
    type: boolean
  ```

  In the "Call the work API" step's `env:`, add `RESUME: ${{ inputs.resume
}}`. Replace the `redispatch)` case:

  ```bash
            redispatch)
              body=''
              if [ "$RESUME" = 'true' ]; then
                get_status="$(call GET "$api/$ITEM_ID")"
                if [ "$get_status" = "200" ]; then
                  latest_run="$(jq -r '.runs[-1].runId // empty' "$response")"
                  resume_session_id="$(jq -r --arg r "$latest_run" \
                    '[.sessions[] | select(.runId == $r)] | sort_by(.lastActivityAt) | last | .sessionId // empty' \
                    "$response")"
                  if [ -n "$resume_session_id" ]; then
                    body="$(jq -cn --arg s "$resume_session_id" '{resumeSessionId: $s}')"
                  fi
                fi
              fi
              if [ -n "$body" ]; then
                status="$(call POST "$api/$ITEM_ID/redispatch" "$body")"
              else
                status="$(call POST "$api/$ITEM_ID/redispatch")"
              fi
              echo "POST /api/work/v1/items/$ITEM_ID/redispatch -> $status"; show
              case "$status" in
                200|400|409) echo "- redispatch $ITEM_ID -> $status" >> "$GITHUB_STEP_SUMMARY" ;;
                *) echo "::error::work API returned $status"; exit 1 ;;
              esac
              ;;
  ```

  `pnpm exec prettier --check .github/workflows/work-create.yml`; commit,
  push, open as its own small PR (touches only a workflow file already
  covered by `.github/actions/published-actions.contract.test.mjs` and
  actionlint in CI); merge before Step 3.

  ```bash
  git add .github/workflows/work-create.yml
  git commit -m "$(cat <<'EOF'
  ci(work): resume input on the redispatch action

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01BiTUeJCQByPUqRLZUpt3CD
  EOF
  )"
  git push
  ```

- [ ] **Step 3: The proof**

  1. Create the smoke item:

     ```bash
     gh workflow run work-create.yml \
       -f action=create \
       -f title='Session resume smoke' \
       -f description="Remember the phrase 'blue tangerine' and PARK. If you are resuming a prior session, state the phrase from that session, then PARK again." \
       -f repo=jlapenna/agent-lcars -f pipeline=claude
     gh run watch "$(gh run list --workflow work-create.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
     ```

     Record the item id from the step summary; `gh workflow run
work-create.yml -f action=get -f id=<itemId>` until `state: parked`.

  2. Redispatch with resume:

     ```bash
     gh workflow run work-create.yml -f action=redispatch -f id=<itemId> -f resume=true
     gh run watch "$(gh run list --workflow work-create.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
     ```

  3. Watch the dispatched agent job's own Actions run — the "Resume prior
     session" step's `session-id` output is non-empty, and "Run Claude
     Code"'s resolved `claude_args` (visible in the step's own log)
     carries `--resume <id>`.

  4. Once parked again, `get` the item and read the second run's session
     (`/sessions/<id>` on the console, or the raw transcript) — confirm it
     states "blue tangerine". If it does not, the resume mechanism did not
     actually carry context: file it on the tracking issue with the run
     URL, fall back to the documented context-prepending mechanism
     (spec's "Resume mechanics" section) as a follow-up task, and record
     the finding in the runbook either way — a negative result here is
     real information, not a blocker to closing this sub-project's other
     tasks.

  5. Persistence: read the just-parked item's session doc's current
     `expireAt` (via the console's session detail page or a direct
     Firestore read). Manually run `work-session-pin-tick.yml`
     (`workflow_dispatch`) and re-read the doc: `expireAt` has moved to
     `now + 365d`. Optionally, for a tighter demonstration, hand-write a
     **throwaway** test session doc (`sessionId` prefixed `smoke-`,
     `source: issue-agent`, `intentId` set to the proof item's latest
     `runId`, `expireAt` a few minutes out) via `secrets-cli`/direct
     Firestore write (maintainer only), tick the workflow again, and
     confirm the throwaway doc's `expireAt` also moved out — proving the
     tick pins by-item, not by-doc-age.

  6. Cancel the proof item (`action=cancel`) so its sessions stop being
     pinned on the next tick.

  7. Append a "Sub-project 6" section to `docs/native-work-smoke-runbook.md`
     with: the item id, both run ids and their sessions, the resume
     command, the phrase-confirmation evidence (or its negative result),
     the pin-tick run URL, and the before/after `expireAt` values. Tick
     sub-project 6 on the tracking issue and comment with the smoke run
     links.

  ```bash
  git add docs/native-work-smoke-runbook.md
  git commit -m "$(cat <<'EOF'
  docs: sub-project 6 smoke — session resume and persistence

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01BiTUeJCQByPUqRLZUpt3CD
  EOF
  )"
  git push
  ```

---

## Self-review

**Spec coverage:** resume request contract + validation (Task 1, 2), drain
and brief threading (Task 3), session-path derivation and download (Task
4), CLI wiring (Task 5), lane mechanism (Task 6), direct-mode mechanism
(Task 7), pinning's scope/gate/store primitive (Task 8), the reaper script
and its workflow (Task 9), console UI (Task 10), land + proof (Task 11).
CLI: none, as decided (no task touches `apps/lcars`). OpenAPI regeneration
is Task 1's Step 5.

**Placeholder scan:** every step above carries real, complete code — no
"add appropriate handling" language. Task 6's `resume.test.sh` fixture is
deliberately narrow (asserts the recorded `node` invocation, not a full
Claude session) — this is a scope choice for a bash unit test around a
composite action's own shell logic, not an unwritten assertion.

**Guesses recorded (verify at implementation time):**

1. **`claude-code-action` `--resume` support is inferred from its source
   at the pinned SHA, not from a live run.** The evidence chain (`parse-
sdk-options.ts`'s generic `extraArgs` passthrough; the action's own
   `session_id` output documentation naming `--resume` as the intended
   continuation mechanism) is strong, but Task 11's proof is the actual
   test. If it fails, the documented fallback (prior-transcript context
   prepended to the brief) is the retreat position, and Task 6 would need
   a follow-up task — not written here, since writing untested fallback
   code against an unconfirmed failure mode would itself be a guess.
2. **`vars.GCP_TELEMETRY_WRITER_SA`** — resolved during pre-execution
   review: the coordinator confirmed this repository variable already
   exists, so Task 11's original "one-time maintainer config" step (which
   would have added it) was removed entirely; Task 9's workflow
   (`work-session-pin-tick.yml`) references `vars.GCP_TELEMETRY_WRITER_SA`
   directly, with no land-time prerequisite. The residual guess is
   narrower than before: this plan still did not independently verify the
   variable's exact spelling against `gh variable list` output or
   `.github/actions/telemetry-start`'s actual callers — if the real name
   differs, Task 9's workflow needs a one-line fix, not a new maintainer
   step.
3. **`resume-session`'s dual local/published step split.** `agent-lane.yml`
   wires `telemetry-start` as two steps (`telemetry-start`/
   `telemetry-start-published`) for a reason this plan did not fully
   trace (likely a checkout-context difference for consumer repos calling
   the reusable workflow). Task 6 wires `resume-session` as a single local
   `uses: ./.github/actions/resume-session` step, reasoning that a
   reusable workflow's local action paths always resolve against the repo
   that owns the workflow file (`jlapenna/agent-lcars`) regardless of the
   caller — and that native work items are control-plane-repository-only
   in v1 (`isControlPlaneRepository`), so a `work.resume` field can only
   ever appear on this repo's own runs. If that reasoning is wrong,
   splitting into two steps mirroring `telemetry-start`'s own pattern is
   the fix, not a redesign.
4. **`ACTIONS_ID_TOKEN_REQUEST_URL`/`ACTIONS_ID_TOKEN_REQUEST_TOKEN`**
   (Task 9's workflow) is the standard, documented raw mechanism for a
   step to mint its own GitHub Actions OIDC token for an arbitrary
   audience without a marketplace action; used here instead of
   `google-github-actions/auth`'s `id_token` mode specifically so the
   workflow needs only ONE marketplace action (for the Google WIF
   exchange) rather than two overlapping OIDC-minting mechanisms. Not
   executed against a live workflow by this plan.
5. **`GCP_WIF_PROVIDER`** is copied from the existing pattern
   `work-schedules-tick.yml`/`work-create.yml` already use for
   `vars.GCP_WIF_PROVIDER` — reused, not newly guessed. (`GCP_TELEMETRY_
WRITER_SA`'s existence is resolved per guess #2 above; its exact spelling
   is the only piece still unverified.)
6. **Task 8's landing order.** Task 8's `WorkScope` union
   (`'work.operator' | 'work.cron' | 'work.executor' | 'work.reaper'`) is
   written assuming `work.cron` (sub-project 3) and `work.executor`
   (sub-project 4, `QueueExecutor` PR #1539) are both already on `main`'s
   `work-auth.ts` by the time this task is implemented — true once PR
   #1539 merges/rebases, per this plan's own "Requires sub-project 4 …
   merged" header. If Task 8 is implemented before that merge lands, its
   diff against the _current_ `work-auth.ts` (still only `'work.operator'
| 'work.cron'`) needs `'work.executor'` dropped from the union and the
   Google-ID-token/`work.executor` grant-check code Task 8's snippets
   assume already exists — a sequencing risk to check at execution time,
   not a design gap.

**Type/shape consistency:** `WorkContext.getSessionDoc`'s return type
(`SessionDoc | undefined`, Task 2) is what `sessionForResume` (Task 2)
returns and what the `redispatch` handler (Task 2) narrows via
`session.source`/`session.intentId`/`sessionAgent(session)`/
`session.transcriptGcsUri` — all real `IssueAgentSessionDoc` fields.
`Run.params.resumeSessionId`/`resumeTranscriptGcsUri` (Task 2) are the
exact two string keys both `orchestrator-dispatch.ts` (Task 3) and
`runs-router.ts`'s `brief` (Task 3) read — no third name introduced
anywhere. `runBriefSchema.resume` (Task 1) and the drain's `work.resume`
JSON (Task 3) share the identical `{ sessionId, transcriptGcsUri }` shape
— one shape for both runners, as the architecture states.
`claudeProjectSlugFor` (Task 4) is the one function both `resume-
transcript.ts` (Task 4) and the CLI subcommand (Task 5) call — no second
hand-copied `/` → `-` substitution anywhere, including in the bash sides
(Tasks 6, 7), which never compute the slug themselves — they pass `--cwd`
and let the TS function do it. `WorkScope`'s `'work.reaper'` (Task 8) is
the one value both `authenticateWorkRequest`'s new branch and
`work-router.ts`'s `reader` gate check.

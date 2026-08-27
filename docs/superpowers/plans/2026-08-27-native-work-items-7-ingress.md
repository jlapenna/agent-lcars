# Native Work Items — Plan 7: ingress unification

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every GitHub-anchored task (label webhook, reply, console
retrigger, console pipeline reassignment) gets a `Task.work` payload the
same way a native item does; the
dispatch brief is always built from `work`, not a live issue read; the
console becomes the sole writer of the issue-side acknowledgements a human
still watches for (eyes reaction, fleet-assignee claim, park label); and the
dispatched-agent protocol collapses to the native rules for every anchor,
gated by a per-consumer `control-plane-projections` lane flag that defaults
off. agent-lcars's own workers flip it on and prove the whole path with two
real dispatched issues.

**Architecture:** `libs/work/src/spec.ts`'s `workOriginSchema.channel` gains
`'github'`; a new `apps/console/src/lib/work-from-github.ts` derives a
`WorkPayload` from a GitHub issue/PR's title+body, reused by the four
sites that call `orchestrator.request()` for a GitHub anchor (the label
webhook, the reply-comment webhook, the console's own retrigger action,
and console pipeline reassignment). `orchestrator-dispatch.ts`'s drain
emits the same `work` JSON `workflow_dispatch` input for a GitHub-anchored
run that already carries `work` as it does for a native one, and — right
after `confirmDispatch` — posts the eyes reaction and the fleet-assignee
claim itself instead of leaving them to the lane. `handleReportOutcome`
gains the `status:needs-human` label on the `finished, ok: false` case it
was previously missing. `prepare.sh` (`prepare-agent-dispatch`) gains a
third branch: `WORK` and `ISSUE` both present builds the brief from
`WORK.spec` with the issue's real number/URL/type for linking (never
hardcoding `pull-request` vs `issue`). A new `control-plane-projections`
lane input threads through `agent-lane.yml`, the three published shims, and
`dispatch-bootstrap/action.yml`'s claim step, landing in the brief as
`runtime.projections`. `agent-protocol.md`'s §1–§4 become the native rules
for every anchor whenever `runtime.projections === true || anchor.type ===
'work'` — the latter half covers a native run's brief arriving through
sub-project 4's own route, which has no obligation to set the flag — with
the current issue-mode text kept verbatim as a "Legacy (projections off)"
subsection every consumer still on the default reads.

**Tech Stack:** TypeScript/Zod (`libs/work`, `apps/console/src/lib`),
Vitest, GitHub Actions composite/reusable workflow YAML, bash
(`prepare.sh`, tested the `prepare.test.sh` way — no test runner, explicit
`bash <path>` assertions), the console's existing GitHub App client
(`getGithubClient()`/`DispatchTokenProvider`).

**Spec:** `docs/superpowers/specs/2026-08-23-native-work-items-design.md` —
"Sub-project 5: ingress unification" (this plan implements that section in
full), plus "Data model" (`Task.work`, the anchor union),
"Dispatched-agent protocol in native mode" (§5a, being promoted to the main
protocol text), and "Sequencing" item 5. Builds on sub-project 1 (`work`
for native anchors, merged) and assumes sub-project 4's run routes
(`docs/superpowers/plans/...-6-queue.md`, in flight) land first; this plan
does not modify anything in that branch.

## Global Constraints

- No Terraform, no new IAM binding, no new GCP Secret Manager entry, no new
  runtime env var. The projection writes (eyes reaction, assignee claim,
  park label) use the console's existing GitHub App client
  (`getGithubClient()`/`DispatchTokenProvider`) — the same credential
  `orchestrator-dispatch.ts` already holds for the outcome comment it
  posts today.
- `control-plane-projections` is a `boolean` `workflow_call` input,
  default `false`, matching the existing `dispatch-bootstrap` input's
  shape exactly — every fleet consumer's lane call is byte-identical in
  behavior until it adds this one `with:` line.
- `agent-fallback-finalize.yml`'s "Report and park bootstrap-independent
  failure" step is **not** touched or gated by this plan: it is the
  last-resort writer for a completion callback that never reached the
  control plane at all, a case this sub-project's console-side projections
  cannot cover either (see the spec section's "Projections" note). Do not
  add a `control-plane-projections` condition to it.
- `requestRun`'s "write once" rule (`decide.ts`'s `baseTask`) is unchanged
  by this plan: a `work` payload derived here is carried forward on every
  later request of the same task, never re-derived once set. No new
  "update work" route or mechanism is added.
- `handleDispatchRequest` (`/api/control-plane/request`, the OIDC internal
  automation path) is explicitly **not** given `work` derivation in this
  plan — its callers send no issue title/body and deriving one would cost
  every internal-automation dispatch an extra GitHub read this plan's
  proof does not exercise. A task first created through that path stays
  legacy until the next label/reply request derives `work` for it.
- Quick Tasks are not converted to native items in this plan. No `work:`
  anchor is minted for one, no `PUT /items` call is added anywhere in the
  Quick Task path.
- No real git in unit tests. Console E2E is not run locally (paused by
  maintainer direction, #1049); this plan adds no new console E2E spec.
- Never `--no-verify`. Use a worktree; never touch the primary checkout.
  Implementers run the fast layer locally (focused vitest, typecheck of
  the touched project, `pnpm exec prettier --check`, `bash
./tools/...test.sh` for the bash contract tests), then push; CI carries
  the rest.
- Every commit carries `Co-Authored-By: Claude Fable 5
<noreply@anthropic.com>` and `Claude-Session:
https://claude.ai/code/session_01BiTUeJCQByPUqRLZUpt3CD`.

## File Structure

| File                                                                                          | Responsibility                                                                                                                                                  |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `libs/work/src/spec.ts`, `spec.spec.ts` (modify)                                              | `workOriginSchema.channel` gains `'github'`                                                                                                                     |
| `libs/orchestrator/src/model.ts` (modify)                                                     | `taskSchema.work` doc comment, made anchor-agnostic (doc-only)                                                                                                  |
| `apps/console/src/lib/work-from-github.ts`, `.test.ts` (create)                               | `workPayloadFromGithub`, `githubOrigin`, `truncatedDescription` — pure GitHub→`WorkPayload` derivation                                                          |
| `apps/console/src/lib/orchestrator-ingest.ts`, `.test.ts` (modify)                            | webhook schemas gain `title`/`body`/`sender`; `IngestDecision.work?`                                                                                            |
| `apps/console/src/lib/orchestrator-routes.ts`, `.test.ts` (modify)                            | `handleWebhookDelivery` forwards `work` to `orchestrator.request`                                                                                               |
| `apps/console/src/lib/backend-actions.ts`, `.test.ts` (modify)                                | `retriggerIssue`/`reassignPipeline` derive and forward `work` when the task doesn't already carry one                                                           |
| `apps/console/src/app/actions.ts` (modify)                                                    | threads the session's github login into `retriggerIssue`/`reassignPipeline`                                                                                     |
| `apps/console/src/lib/orchestrator-dispatch.ts`, `.test.ts` (modify)                          | `handleDispatchRun` emits `work` for a GitHub anchor and posts the eyes/claim projection; `handleReportOutcome` sets `needsHumanLabel` for `finished, ok:false` |
| `.github/actions/prepare-agent-dispatch/prepare.sh`, `prepare.test.sh`, `action.yml` (modify) | `WORK`+`ISSUE` branch; `control-plane-projections` input → `runtime.projections`                                                                                |
| `.github/workflows/agent-lane.yml` (modify)                                                   | `control-plane-projections` input; gates both claim steps; forwards to `prepare-agent-dispatch`; reword the default-prompt park clause (#1528)                  |
| `.github/actions/dispatch-bootstrap/action.yml` (modify)                                      | `control-plane-projections` input gates its claim step                                                                                                          |
| `.github/workflows/agent-lane-{claude,codex,opencode}.yml` (modify)                           | forward the new input                                                                                                                                           |
| `.github/workflows/{claude,codex,opencode}.yml` (modify)                                      | pass `control-plane-projections: true`                                                                                                                          |
| `tools/contract-tests/worker-workflow-contract.test.ts` (modify)                              | manifest + forwarding assertions for the new input; `agent-protocol.md`'s section-number/marker pins (it already reads this file)                               |
| `.github/actions/published-actions.contract.test.mjs` (modify)                                | `prepare-agent-dispatch`'s new input                                                                                                                            |
| `.github/actions/prepare-agent-dispatch/prepare.test.sh` (modify)                             | `WORK`+`ISSUE` branch (including a PR-backed anchor case); `CONTROL_PLANE_PROJECTIONS` → `runtime.projections`                                                  |
| `agents/shared/skills/agent-protocol/reference/agent-protocol.md` (modify)                    | §1–§4 collapse to native rules under `runtime.projections === true \|\| anchor.type === 'work'`; legacy subsection retained                                     |
| `tools/contract-tests/lane-default-prompt.test.ts` (modify)                                   | pins the reworded, flag-agnostic park clause in `agent-lane.yml`'s default prompt (#1528)                                                                       |
| `apps/console/src/lib/authoritative-task-state.ts`, `.test.ts` (modify)                       | `AuthoritativeTaskState.spec?: WorkSpec`                                                                                                                        |
| `apps/console/src/lib/task-detail.ts`, `.test.ts` (modify)                                    | threads `spec` into `TaskDetailResult`                                                                                                                          |
| `apps/console/src/app/task/logical-work-card.tsx`, `.test.tsx` (modify)                       | renders the `work.spec` snapshot when present                                                                                                                   |
| `apps/console/src/app/quick-task-button.tsx`, `.test.tsx` (modify)                            | state badge reads `AuthoritativeTaskState` instead of scanning issue content                                                                                    |
| `docs/native-work-smoke-runbook.md` (modify, land task)                                       | the sub-project 5 real-path proof evidence                                                                                                                      |

---

### Task 1: `work.origin.channel` gains `'github'`, and a pure derivation helper

**Files:**

- Modify: `libs/work/src/spec.ts`
- Modify: `libs/work/src/spec.spec.ts`
- Modify: `libs/orchestrator/src/model.ts` (doc comment only)
- Create: `apps/console/src/lib/work-from-github.ts`
- Create: `apps/console/src/lib/work-from-github.test.ts`

**Interfaces:**

- Produces: `workOriginSchema` accepts `channel: 'github'` (alongside
  `'api' | 'cron' | 'console'`). `truncatedDescription(body: string | null
| undefined): string`; `githubOrigin(actor: string | undefined, label?:
string): WorkOrigin`; `workPayloadFromGithub(source: GithubWorkSource):
WorkPayload` (`apps/console/src/lib/work-from-github.ts`, all exported).
  Consumed by Task 2 (webhook ingest) and Task 3 (console retrigger).

- [ ] **Step 1: Write the failing tests**

```ts
// libs/work/src/spec.spec.ts -- add inside the existing workOriginSchema
// describe block (or create one if the file has none yet for this schema)
it('accepts the github channel', () => {
  expect(
    workOriginSchema.parse({ principal: 'github:jlapenna', channel: 'github' })
      .channel,
  ).toBe('github');
});
```

```ts
// apps/console/src/lib/work-from-github.test.ts
import { describe, expect, it } from 'vitest';

import {
  githubOrigin,
  truncatedDescription,
  workPayloadFromGithub,
} from './work-from-github';

describe('truncatedDescription', () => {
  it('returns a short body verbatim, trimmed', () => {
    expect(truncatedDescription('  hello  ')).toBe('hello');
  });

  it('falls back to a placeholder for a null or empty body', () => {
    expect(truncatedDescription(null)).toBe('(no description)');
    expect(truncatedDescription(undefined)).toBe('(no description)');
    expect(truncatedDescription('   ')).toBe('(no description)');
  });

  it('clamps an overlong body with a truncation marker', () => {
    const body = 'x'.repeat(20_000);
    const result = truncatedDescription(body);
    expect(result.length).toBeGreaterThan(16_384);
    expect(result.startsWith('x'.repeat(16_384))).toBe(true);
    expect(result).toContain('truncated to 16384 of 20000 characters');
  });
});

describe('githubOrigin', () => {
  it('prefers the actor login', () => {
    expect(githubOrigin('jlapenna', 'agent:claude')).toEqual({
      principal: 'github:jlapenna',
      channel: 'github',
    });
  });

  it('falls back to the label when no actor is known', () => {
    expect(githubOrigin(undefined, 'agent:claude')).toEqual({
      principal: 'github:label:agent:claude',
      channel: 'github',
    });
  });

  it('falls back to unknown when neither actor nor label is known', () => {
    expect(githubOrigin(undefined, undefined)).toEqual({
      principal: 'github:unknown',
      channel: 'github',
    });
  });
});

describe('workPayloadFromGithub', () => {
  it('builds a full WorkPayload from an issue-shaped source', () => {
    expect(
      workPayloadFromGithub({
        title: 'Fix the thing',
        body: 'Please fix the thing.',
        pipeline: 'claude',
        repo: 'jlapenna/agent-lcars',
        actor: 'jlapenna',
      }),
    ).toEqual({
      origin: { principal: 'github:jlapenna', channel: 'github' },
      spec: {
        title: 'Fix the thing',
        description: 'Please fix the thing.',
        pipeline: 'claude',
        target: { repo: 'jlapenna/agent-lcars' },
      },
    });
  });

  it('clamps a title over WORK_TITLE_MAX defensively', () => {
    const title = 'y'.repeat(300);
    const payload = workPayloadFromGithub({
      title,
      body: 'b',
      pipeline: 'codex',
      repo: 'jlapenna/agent-lcars',
      actor: 'jlapenna',
    });
    expect(payload.spec.title).toBe('y'.repeat(256));
  });
});
```

- [ ] **Step 2: Run to verify it fails**

`./tools/nx test @agent-lcars/work -- spec` → FAIL (`'github'` not
accepted). `./tools/nx test @agent-lcars/console -- work-from-github` →
FAIL (module not found).

- [ ] **Step 3: Implement**

`libs/work/src/spec.ts`:

```ts
export const workOriginSchema = z.strictObject({
  /** LCARS-native principal, e.g. `user:jlapenna`, `svc:lcars-admin`,
   *  `github:<login>` for a task derived from a GitHub webhook or console
   *  retrigger (sub-project 5). */
  principal: z.string().min(1).max(128),
  channel: z.enum(['api', 'cron', 'console', 'github']),
});
```

```ts
// apps/console/src/lib/work-from-github.ts
import 'server-only';

import {
  WORK_DESCRIPTION_MAX,
  WORK_TITLE_MAX,
  type WorkOrigin,
  type WorkPayload,
} from '@agent-lcars/work';

import type { Pipeline } from './orchestrator-ingest';

/** `workSpecSchema.description` is `min(1)`; a GitHub issue or PR may have
 *  a null or whitespace-only body. */
const EMPTY_DESCRIPTION = '(no description)';

/** Mirrors `prepare.sh`'s own clamp-and-marker shape for `anchor.body`, so
 *  a task derived here and a brief later built from an unrelated overlong
 *  body degrade the same visible way. */
export function truncatedDescription(body: string | null | undefined): string {
  const text = body?.trim();
  if (!text) return EMPTY_DESCRIPTION;
  if (text.length <= WORK_DESCRIPTION_MAX) return text;
  return (
    text.slice(0, WORK_DESCRIPTION_MAX) +
    `\n\n[work: truncated to ${WORK_DESCRIPTION_MAX} of ${text.length} ` +
    `characters. Read the full body on the issue.]`
  );
}

/** GitHub's own issue/PR title limit (256 characters) already equals
 *  `WORK_TITLE_MAX`; this clamp is defensive, not expected to ever
 *  actually shorten a real title. */
function clampedTitle(title: string): string {
  return title.length <= WORK_TITLE_MAX
    ? title
    : title.slice(0, WORK_TITLE_MAX);
}

/**
 * The `work.origin.principal` for a GitHub-derived task: `github:<login>`
 * when the webhook (or the console session) named an actor, else
 * `github:label:<label>` for a label webhook whose delivery carried no
 * `sender`, else `github:unknown`. See the design spec's "`work` for
 * every anchor" derivation table.
 */
export function githubOrigin(
  actor: string | undefined,
  label?: string,
): WorkOrigin {
  const suffix = actor ?? (label !== undefined ? `label:${label}` : 'unknown');
  return { principal: `github:${suffix}`, channel: 'github' };
}

export interface GithubWorkSource {
  title: string;
  body: string | null | undefined;
  pipeline: Pipeline;
  repo: string;
  /** The webhook `sender.login`, or the console session's github login for
   *  a retrigger. */
  actor: string | undefined;
  /** Label-webhook fallback only, used by `githubOrigin` when `actor` is
   *  absent -- irrelevant for a retrigger, which always has a session
   *  actor. */
  label?: string;
}

/**
 * Builds the `WorkPayload` a GitHub-anchored `requestRun` call attaches to
 * a task on its first request (`decide.ts`'s `baseTask` carries it forward
 * on every later request -- see the design spec's "write once" note).
 */
export function workPayloadFromGithub(source: GithubWorkSource): WorkPayload {
  return {
    origin: githubOrigin(source.actor, source.label),
    spec: {
      title: clampedTitle(source.title),
      description: truncatedDescription(source.body),
      pipeline: source.pipeline,
      target: { repo: source.repo },
    },
  };
}
```

`libs/orchestrator/src/model.ts`'s `taskSchema.work` doc comment is
anchor-specific text left over from before this sub-project — a one-line
doc-only fix, no schema/behavior change:

```ts
// libs/orchestrator/src/model.ts -- replace taskSchema's `work` doc
// comment (the field declaration itself, `work: workPayloadSchema.
// optional(),`, is unchanged)
  /** The work item's payload, written once when the task is created by
   *  its first request and never modified by the orchestrator afterward.
   *  A native anchor always carries one; a GitHub anchor carries one once
   *  console-side derivation has populated it (sub-project 5's `work` for
   *  every anchor) and is absent otherwise -- a legacy task, or one
   *  requested through a path that does not derive it
   *  (`handleDispatchRequest`; see the design spec). */
  work: workPayloadSchema.optional(),
```

- [ ] **Step 4: Run** — `./tools/nx test @agent-lcars/work -- spec` and
      `./tools/nx test @agent-lcars/console -- work-from-github` → PASS;
      typecheck all three touched projects; `pnpm exec prettier --check
libs/work/src/spec.ts apps/console/src/lib/work-from-github.ts`.

- [ ] **Step 5: Commit**

```bash
git add libs/work/src/spec.ts libs/work/src/spec.spec.ts \
  libs/orchestrator/src/model.ts \
  apps/console/src/lib/work-from-github.ts \
  apps/console/src/lib/work-from-github.test.ts
git commit -m "feat(work): github origin channel and a GitHub->WorkPayload derivation helper

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BiTUeJCQByPUqRLZUpt3CD"
```

---

### Task 2: The label webhook derives and forwards `work`

**Files:**

- Modify: `apps/console/src/lib/orchestrator-ingest.ts`
- Modify: `apps/console/src/lib/orchestrator-ingest.test.ts`
- Modify: `apps/console/src/lib/orchestrator-routes.ts`
- Modify: `apps/console/src/lib/orchestrator-routes.test.ts`

**Interfaces:**

- Consumes: `workPayloadFromGithub` (Task 1).
- Produces: `IngestDecision.work?: WorkPayload` (from `@agent-lcars/work`).
  Consumed by `handleWebhookDelivery` in this same task; no other task
  reads it.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/console/src/lib/orchestrator-ingest.test.ts -- new cases, added to
// the existing `interpretDelivery` `cases` array. Existing cases are
// UNCHANGED: their fixtures omit `issue.title`, so `work` stays absent and
// their `expected` objects (with no `work` key) still match exactly.
{
  name: 'issues labeled with a title/body/sender derives work',
  event: 'issues',
  payload: issuesLabeledPayload({
    issue: { number: 42, title: 'Fix the thing', body: 'Please fix it.' },
    sender: { login: 'jlapenna' },
  }),
  expected: {
    kind: 'request',
    taskId: { repo: REPO, issue: 42 },
    requestId: DELIVERY_ID,
    pipeline: 'claude',
    params: { mode: 'implement' },
    work: {
      origin: { principal: 'github:jlapenna', channel: 'github' },
      spec: {
        title: 'Fix the thing',
        description: 'Please fix it.',
        pipeline: 'claude',
        target: { repo: REPO },
      },
    },
  },
},
{
  name: 'issues labeled with a title but no sender falls back to the label',
  event: 'issues',
  payload: issuesLabeledPayload({
    issue: { number: 42, title: 'Fix the thing', body: null },
  }),
  expected: {
    kind: 'request',
    taskId: { repo: REPO, issue: 42 },
    requestId: DELIVERY_ID,
    pipeline: 'claude',
    params: { mode: 'implement' },
    work: {
      origin: { principal: 'github:label:agent:claude', channel: 'github' },
      spec: {
        title: 'Fix the thing',
        description: '(no description)',
        pipeline: 'claude',
        target: { repo: REPO },
      },
    },
  },
},
{
  name: 'issue_comment reply derives work from the issue being replied to, not the comment',
  event: 'issue_comment',
  payload: issueCommentPayload({
    issue: { number: 9, title: 'Question about X', body: 'Some context.' },
    sender: { login: 'jlapenna' },
  }),
  expected: {
    kind: 'request',
    taskId: { repo: REPO, issue: 9 },
    requestId: DELIVERY_ID,
    pipeline: 'claude',
    params: { mode: 'reply', reply: '@claude please take a look' },
    work: {
      origin: { principal: 'github:jlapenna', channel: 'github' },
      spec: {
        title: 'Question about X',
        description: 'Some context.',
        pipeline: 'claude',
        target: { repo: REPO },
      },
    },
  },
},
```

- [ ] **Step 2: Run to verify it fails** — `./tools/nx test
@agent-lcars/console -- orchestrator-ingest` → FAIL (`title`/`body`/
      `sender` rejected or dropped; no `work` key on the decision).

- [ ] **Step 3: Implement**

`orchestrator-ingest.ts` — extend the three event schemas and thread
`work` through `buildRequestDecision`:

```ts
import { type WorkPayload } from '@agent-lcars/work';

import { workPayloadFromGithub } from './work-from-github';

// ...

const repositorySchema = z.object({ full_name: z.string().min(1) });
const labelSchema = z.object({ name: z.string().min(1) });
/** GitHub always sends a top-level `sender` -- the actor who triggered
 *  this specific delivery (whoever applied the label, whoever posted the
 *  comment). Optional here only so a malformed/legacy-shaped test fixture
 *  degrades to the label fallback instead of failing to parse. */
const senderSchema = z.object({ login: z.string().min(1) }).optional();
/** GitHub always sends `title`; `body` may be `null`. Both optional here
 *  so a payload shape this parser has not seen before still admits the
 *  dispatch -- it just derives no `work` for it (see the `issue.title`
 *  guard in each `interpret*Event` below), matching how a legacy task
 *  (pre-sub-project-5) already dispatches with no `work` payload. */
const issueBodySchema = z.object({
  number: z.number().int().positive(),
  title: z.string().min(1).optional(),
  body: z.string().nullable().optional(),
});

const issuesEventSchema = z.object({
  action: z.string(),
  repository: repositorySchema,
  issue: issueBodySchema,
  label: labelSchema.optional(),
  sender: senderSchema,
});

const pullRequestEventSchema = z.object({
  action: z.string(),
  repository: repositorySchema,
  pull_request: issueBodySchema,
  label: labelSchema.optional(),
  sender: senderSchema,
});

const issueCommentEventSchema = z.object({
  action: z.string(),
  repository: repositorySchema,
  issue: issueBodySchema,
  comment: z.object({
    body: z.string(),
    author_association: z.string(),
    user: z.object({ type: z.string() }).optional(),
  }),
  sender: senderSchema,
});
```

```ts
export interface IngestDecision {
  kind: 'request';
  taskId: TaskId;
  requestId: string;
  pipeline: Pipeline;
  params: Record<string, string>;
  /** Present when the anchor (issue or PR) carried a title -- absent for a
   *  payload shape this parser could not read one from, which dispatches
   *  exactly as it did before sub-project 5 (no `work` on the task, or the
   *  task's already-set `work` carried forward -- see `decide.ts`'s
   *  `baseTask`). */
  work?: WorkPayload;
}
```

```ts
function buildRequestDecision(
  repo: string,
  issue: number,
  requestId: string,
  pipeline: Pipeline,
  params: Record<string, string>,
  work?: WorkPayload,
): IngestResult {
  const taskId = taskIdSchema.safeParse({ repo, issue });
  if (!taskId.success) return ignore('malformed-payload');
  return {
    kind: 'request',
    taskId: taskId.data,
    requestId,
    pipeline,
    params,
    ...(work === undefined ? {} : { work }),
  };
}
```

`interpretIssuesEvent`:

```ts
function interpretIssuesEvent(
  payload: unknown,
  deliveryId: string,
): IngestResult {
  const parsed = issuesEventSchema.safeParse(payload);
  if (!parsed.success) return ignore('malformed-payload');
  const { action, repository, issue, label, sender } = parsed.data;

  const repoIgnore = checkRepository(repository.full_name);
  if (repoIgnore) return repoIgnore;
  if (action !== 'labeled') return ignore('unhandled-action');

  const pipeline = label && IMPLEMENT_LABELS[label.name];
  if (!pipeline) return ignore('no-trigger-label');

  const work = issue.title
    ? workPayloadFromGithub({
        title: issue.title,
        body: issue.body,
        pipeline,
        repo: repository.full_name,
        actor: sender?.login,
        label: label.name,
      })
    : undefined;

  return buildRequestDecision(
    repository.full_name,
    issue.number,
    deliveryId,
    pipeline,
    { mode: 'implement' },
    work,
  );
}
```

`interpretPullRequestEvent` gains the identical `work` derivation, applied
before _both_ of its `buildRequestDecision` calls (`implementPipeline` and
`reviewPipeline`), reading from `pullRequest.title`/`pullRequest.body`
instead of `issue.title`/`.body`, and `pullRequest.number` for the anchor.

`interpretIssueCommentEvent`:

```ts
function interpretIssueCommentEvent(
  payload: unknown,
  deliveryId: string,
): IngestResult {
  const parsed = issueCommentEventSchema.safeParse(payload);
  if (!parsed.success) return ignore('malformed-payload');
  const { action, repository, issue, comment, sender } = parsed.data;

  const repoIgnore = checkRepository(repository.full_name);
  if (repoIgnore) return repoIgnore;
  if (action !== 'created') return ignore('unhandled-action');

  const pipeline = matchReplyCommand(comment.body);
  if (!pipeline) return ignore('no-reply-command');

  if (
    comment.user?.type === 'Bot' ||
    (comment.author_association !== 'OWNER' &&
      comment.author_association !== 'MEMBER')
  ) {
    return ignore('untrusted-author');
  }

  // Derived from the ISSUE being replied to, not the comment -- the
  // comment text is already `params.reply`, a separate field the brief
  // reads independently (see the design spec's "brief is built from
  // work" note).
  const work = issue.title
    ? workPayloadFromGithub({
        title: issue.title,
        body: issue.body,
        pipeline,
        repo: repository.full_name,
        actor: sender?.login,
      })
    : undefined;

  return buildRequestDecision(
    repository.full_name,
    issue.number,
    deliveryId,
    pipeline,
    { mode: 'reply', reply: comment.body },
    work,
  );
}
```

`orchestrator-routes.ts`'s `handleWebhookDelivery` forwards it:

```ts
const outcome = await deps.orchestrator.request({
  taskId: interpreted.taskId,
  requestId: interpreted.requestId,
  pipeline: interpreted.pipeline,
  params: interpreted.params,
  ...(interpreted.work === undefined ? {} : { work: interpreted.work }),
});
```

- [ ] **Step 4: Add the `orchestrator-routes.test.ts` regression**

```ts
// apps/console/src/lib/orchestrator-routes.test.ts -- new case in the
// existing handleWebhookDelivery describe block
it('forwards a derived work payload from interpretDelivery to orchestrator.request', async () => {
  const deps = fixture();
  const requestSpy = vi.spyOn(deps.orchestrator, 'request');
  await handleWebhookDelivery(deps, {
    event: 'issues',
    deliveryId: 'd1',
    payload: {
      action: 'labeled',
      repository: { full_name: 'jlapenna/agent-lcars' },
      issue: { number: 1, title: 'T', body: 'B' },
      label: { name: 'agent:claude' },
      sender: { login: 'jlapenna' },
    },
  });
  expect(requestSpy).toHaveBeenCalledWith(
    expect.objectContaining({
      work: {
        origin: { principal: 'github:jlapenna', channel: 'github' },
        spec: {
          title: 'T',
          description: 'B',
          pipeline: 'claude',
          target: { repo: 'jlapenna/agent-lcars' },
        },
      },
    }),
  );
});
```

(Match this repo's existing `fixture()` helper name/shape in
`orchestrator-routes.test.ts` — if it is not already a `vi.spyOn`-friendly
real `Orchestrator`, use whatever stub/spy pattern the file's other
`handleWebhookDelivery` tests already use for asserting call arguments.)

- [ ] **Step 5: Run** — `./tools/nx test @agent-lcars/console --
orchestrator-ingest orchestrator-routes` → PASS; typecheck; prettier.

- [ ] **Step 6: Commit**

```bash
git add apps/console/src/lib/orchestrator-ingest.ts \
  apps/console/src/lib/orchestrator-ingest.test.ts \
  apps/console/src/lib/orchestrator-routes.ts \
  apps/console/src/lib/orchestrator-routes.test.ts
git commit -m "feat(console): label webhook derives and forwards a work payload

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BiTUeJCQByPUqRLZUpt3CD"
```

---

### Task 3: Console retrigger and pipeline reassignment derive and forward `work`

**Files:**

- Modify: `apps/console/src/lib/backend-actions.ts`
- Modify: `apps/console/src/lib/backend-actions.test.ts`
- Modify: `apps/console/src/app/actions.ts`

**Interfaces:**

- Consumes: `workPayloadFromGithub` (Task 1).
- Produces: `retriggerIssue(repo, issueNumber, callerId, note?,
actorLogin?)` and `reassignPipeline(repo, issueNumber, targetPipeline,
callerId, actorLogin?)` — `actorLogin` is a new, optional trailing
  parameter on both (kept optional and appended last so every existing
  call site/test that omits it is unaffected). When the task has no
  `work` yet, each reads the issue (`reassignPipeline` reuses the read it
  already makes for its own label swap; `retriggerIssue` has no other
  reason to read it and adds one) and derives `work`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/console/src/lib/backend-actions.test.ts -- new case in the
// existing `retriggerIssue` describe block
it('derives and forwards work from the live issue when the task has none yet', async () => {
  githubMock.rest.issues.get.mockResolvedValue({
    data: { title: 'Live title', body: 'Live body' },
  });
  const requestSpy = vi.spyOn(orchestrator, 'request');
  // ... existing fixture wiring for repo/store/orchestrator from this
  // file's other retriggerIssue tests ...
  await retriggerIssue(repo, 42, VALID_CALLER_ID, undefined, 'jlapenna');
  expect(requestSpy).toHaveBeenCalledWith(
    expect.objectContaining({
      work: {
        origin: { principal: 'github:jlapenna', channel: 'github' },
        spec: {
          title: 'Live title',
          description: 'Live body',
          pipeline: 'claude',
          target: { repo: 'jlapenna/agent-lcars' },
        },
      },
    }),
  );
});

it('does not re-read the issue or forward work when the task already carries one', async () => {
  // store.readTask stubbed to return a task with `work` already set
  const requestSpy = vi.spyOn(orchestrator, 'request');
  await retriggerIssue(repo, 42, VALID_CALLER_ID, undefined, 'jlapenna');
  expect(githubMock.rest.issues.get).not.toHaveBeenCalled();
  expect(requestSpy).toHaveBeenCalledWith(
    expect.not.objectContaining({ work: expect.anything() }),
  );
});
```

(Use this test file's existing mock/fixture names for `githubMock`,
`repo`, `store`, `orchestrator`, and `VALID_CALLER_ID` — `backend-actions.test.ts`
already has extensive `retriggerIssue` coverage to pattern-match against;
do not invent new fixture plumbing where the file's own helpers already
cover octokit/orchestrator stubbing.)

- [ ] **Step 2: Run to verify it fails** — `./tools/nx test
@agent-lcars/console -- backend-actions` → FAIL (`work` never forwarded;
      `actorLogin` param does not exist).

- [ ] **Step 3: Implement**

In `backend-actions.ts`, add the import and extend `retriggerIssue`:

```ts
import { workPayloadFromGithub } from './work-from-github';
```

```ts
export async function retriggerIssue(
  repo: WatchedRepo,
  issueNumber: number,
  callerId: string,
  note?: string,
  actorLogin?: string,
): Promise<RetriggerOutcome> {
  if (!DISPATCH_CALLER_ID_PATTERN.test(callerId)) {
    throw new ActionError('A valid dispatch caller ID is required', 400);
  }

  const { store, orchestrator, drain } = createOrchestratorRuntime();
  const taskId = { repo: controlPlaneRepository(), issue: issueNumber };
  const [runs, existingTask] = await Promise.all([
    store.listRuns(taskId),
    store.readTask(taskId),
  ]);
  const previousPipeline = latestOrchestratorPipeline(runs);
  const pipelineFallback = previousPipeline === undefined;
  const pipeline = previousPipeline ?? RETRIGGER_FALLBACK_PIPELINE;
  const integration = requireAgentIntegration(repo, pipeline);

  await clearNeedsHumanLabel(repo, issueNumber);

  const trimmedNote = note?.trim();
  if (trimmedNote) {
    const octokit = getGithubClient();
    await octokit.rest.issues.createComment({
      owner: repo.owner,
      repo: repo.name,
      issue_number: issueNumber,
      body: trimmedNote,
    });
    if (containsReplyTrigger(trimmedNote, integration)) {
      return { pipelineFallback };
    }
  }

  // A task that already carries `work` keeps it forever (decide.ts's
  // "write once" rule) -- deriving one here would be discarded, so this
  // reads the live issue only when there is something for the derivation
  // to actually set.
  let work;
  if (existingTask?.task.work === undefined) {
    const octokit = getGithubClient();
    const { data: issue } = await octokit.rest.issues.get({
      owner: repo.owner,
      repo: repo.name,
      issue_number: issueNumber,
    });
    work = workPayloadFromGithub({
      title: issue.title,
      body: issue.body,
      pipeline,
      repo: repoKey(repo),
      actor: actorLogin,
    });
  }

  const outcome = await orchestrator.request({
    taskId,
    requestId: `console-retry:${randomUUID()}`,
    pipeline,
    params: { mode: 'implement' },
    ...(work === undefined ? {} : { work }),
  });
  if (isRefusal(outcome)) {
    if (outcome.reason === 'task-busy') {
      throw new ActionError('A run is already active for this task', 409);
    }
    throw new ActionError('Retrigger could not be processed', 500);
  }
  await drain();
  return { pipelineFallback };
}
```

`app/actions.ts`'s `retriggerIssue` wrapper threads the session login
through:

```ts
export async function retriggerIssue(
  repo: WatchedRepo,
  number: number,
  callerId: string,
  note?: string,
): Promise<ActionResult> {
  const session = await requireAdmin();
  try {
    const { pipelineFallback } = await retriggerIssueLib(
      resolveWatchedRepo(repo),
      number,
      callerId,
      note,
      session.user.login,
    );
    revalidateDashboard();
    return {
      ok: true,
      ...(pipelineFallback
        ? {
            note: 'No prior run on record for this task - defaulted to the claude pipeline.',
          }
        : {}),
    };
  } catch (error) {
    return { ok: false, message: toUserErrorMessage(error) };
  }
}
```

- [ ] **Step 4: Extend `reassignPipeline` the same way**

`reassignPipeline` already fetches the live issue for its own label swap
(`octokit.rest.issues.get`), so deriving `work` there costs no extra
GitHub call. Write the failing test first:

```ts
// apps/console/src/lib/backend-actions.test.ts -- new case in the
// existing `reassignPipeline` describe block
it('derives and forwards work from the already-fetched issue when the task has none yet', async () => {
  githubMock.rest.issues.get.mockResolvedValue({
    data: { title: 'Live title', body: 'Live body', labels: [] },
  });
  const requestSpy = vi.spyOn(orchestrator, 'request');
  await reassignPipeline(repo, 42, 'codex', VALID_CALLER_ID, 'jlapenna');
  // Not a second read: the label swap's own issues.get is the only one.
  expect(githubMock.rest.issues.get).toHaveBeenCalledTimes(1);
  expect(requestSpy).toHaveBeenCalledWith(
    expect.objectContaining({
      work: {
        origin: { principal: 'github:jlapenna', channel: 'github' },
        spec: {
          title: 'Live title',
          description: 'Live body',
          pipeline: 'codex',
          target: { repo: 'jlapenna/agent-lcars' },
        },
      },
    }),
  );
});

it('does not forward work when the task already carries one', async () => {
  // store.readTask stubbed to return a task with `work` already set
  const requestSpy = vi.spyOn(orchestrator, 'request');
  await reassignPipeline(repo, 42, 'codex', VALID_CALLER_ID, 'jlapenna');
  expect(requestSpy).toHaveBeenCalledWith(
    expect.not.objectContaining({ work: expect.anything() }),
  );
});
```

Run to verify it fails (`./tools/nx test @agent-lcars/console --
backend-actions` → FAIL: `work` never forwarded, `actorLogin` param does
not exist), then implement — `reassignPipeline` gains the same optional
trailing `actorLogin?: string` parameter as `retriggerIssue`, and reads
`store.readTask(taskId)` alongside its existing `store.readActiveRun(taskId)`
read (`Promise.all`, mirroring Step 3 above):

```ts
export async function reassignPipeline(
  repo: WatchedRepo,
  issueNumber: number,
  targetPipeline: Pipeline,
  callerId: string,
  actorLogin?: string,
): Promise<void> {
  if (!DISPATCH_CALLER_ID_PATTERN.test(callerId)) {
    throw new ActionError('A valid dispatch caller ID is required', 400);
  }
  const targetIntegration = requireAgentIntegration(repo, targetPipeline);
  const pipelineLabels = supportedAgentPipelines(repo)
    .map((pipeline) => agentIntegration(repo, pipeline)?.label)
    .filter((label): label is string => Boolean(label));

  const octokit = getGithubClient();
  const { data: issue } = await octokit.rest.issues.get({
    owner: repo.owner,
    repo: repo.name,
    issue_number: issueNumber,
  });
  const labels = issue.labels.map((label) =>
    typeof label === 'string' ? label : (label.name ?? ''),
  );
  await octokit.rest.issues.setLabels({
    owner: repo.owner,
    repo: repo.name,
    issue_number: issueNumber,
    labels: labels
      .filter(
        (label) =>
          !pipelineLabels.includes(label) && label !== 'status:needs-human',
      )
      .concat(targetIntegration.label),
  });

  const { store, orchestrator, drain } = createOrchestratorRuntime();
  const taskId = { repo: controlPlaneRepository(), issue: issueNumber };
  const [activeRun, existingTask] = await Promise.all([
    store.readActiveRun(taskId),
    store.readTask(taskId),
  ]);
  if (activeRun) {
    await orchestrator.cancel(
      activeRun.runId,
      `reassigned to ${targetPipeline} from console`,
    );
  }

  // Reuses the issue already read above for the label swap -- no second
  // GitHub call, unlike retriggerIssue (Step 3), which has no other
  // reason to read the issue.
  const work =
    existingTask?.task.work === undefined
      ? workPayloadFromGithub({
          title: issue.title,
          body: issue.body,
          pipeline: targetPipeline,
          repo: repoKey(repo),
          actor: actorLogin,
        })
      : undefined;

  const outcome = await orchestrator.request({
    taskId,
    requestId: `console-reassign:${randomUUID()}`,
    pipeline: targetPipeline,
    params:
      activeRun?.params?.mode !== undefined
        ? { mode: activeRun.params.mode }
        : { mode: 'implement' },
    ...(work === undefined ? {} : { work }),
  });
  if (isRefusal(outcome)) {
    if (outcome.reason === 'task-busy') {
      throw new ActionError('A run is already active for this task', 409);
    }
    throw new ActionError('Reassignment could not be processed', 500);
  }
  await drain();
}
```

`app/actions.ts`'s `reassignPipeline` wrapper threads the session login
through the same way Step 3's `retriggerIssue` wrapper does:

```ts
export async function reassignPipeline(
  repo: WatchedRepo,
  number: number,
  pipeline: Pipeline,
  callerId: string,
): Promise<ActionResult> {
  const session = await requireAdmin();
  try {
    await reassignPipelineLib(
      resolveWatchedRepo(repo),
      number,
      pipeline,
      callerId,
      session.user.login,
    );
    revalidateDashboard();
    return { ok: true };
  } catch (error) {
    return { ok: false, message: toUserErrorMessage(error) };
  }
}
```

- [ ] **Step 5: Run** — `./tools/nx test @agent-lcars/console --
backend-actions` → PASS; typecheck; prettier.

- [ ] **Step 6: Commit**

```bash
git add apps/console/src/lib/backend-actions.ts \
  apps/console/src/lib/backend-actions.test.ts \
  apps/console/src/app/actions.ts
git commit -m "feat(console): retrigger and pipeline reassignment derive work from the live issue

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BiTUeJCQByPUqRLZUpt3CD"
```

---

### Task 4: The drain emits `work` for a GitHub-anchored dispatch

**Files:**

- Modify: `apps/console/src/lib/orchestrator-dispatch.ts`
- Modify: `apps/console/src/lib/orchestrator-dispatch.test.ts`

**Interfaces:**

- Consumes: `Task.work` (already on every anchor after Tasks 1–3).
- Produces: `handleDispatchRun`'s observable contract gains "a GitHub-anchored
  run whose task carries `work` emits both `issue` and `work` workflow
  inputs." Consumed by Task 5 (`prepare.sh`'s new branch reads that `work`
  input alongside `issue`).

- [ ] **Step 1: Write the failing test**

```ts
// apps/console/src/lib/orchestrator-dispatch.test.ts -- new case in the
// existing handleDispatchRun/drainOutbox describe block
it('a GitHub-anchored run with a work payload emits both issue and work inputs', async () => {
  const { store, orchestrator } = fixture();
  const requested = await orchestrator.request({
    taskId: { repo: 'jlapenna/agent-lcars', issue: 42 },
    requestId: 'req-1',
    pipeline: 'claude',
    params: { mode: 'implement' },
    work: {
      origin: { principal: 'github:jlapenna', channel: 'github' },
      spec: {
        title: 'T',
        description: 'D',
        pipeline: 'claude',
        target: { repo: 'jlapenna/agent-lcars' },
      },
    },
  });
  if (isRefusal(requested)) throw new Error('unexpected refusal');
  const runId = decidedRun(requested).runId;

  const { fetchImpl, calls } = fakeFetch(204);
  await drainOutbox({ store, orchestrator, tokens, fetchImpl });

  const dispatchCall = calls.find((c) => c.url.includes('/dispatches'));
  const body = JSON.parse(dispatchCall!.init.body as string);
  expect(body.inputs.issue).toBe('42');
  expect(JSON.parse(body.inputs.work)).toEqual({
    id: undefined, // GitHub anchors have no `work.id` -- see Step 3's note
  });
});
```

(Match this file's existing `fixture()`/`fakeFetch()` helpers and the
shape of `calls` they already record — `orchestrator-dispatch.test.ts`
already has extensive `handleDispatchRun` coverage for the native-anchor
`work` input to pattern-match against exactly; do not re-derive the
fixture from scratch. Correct the placeholder assertion above once the
real shape from Step 3 is in hand — see that step's note on what a
GitHub-anchored `work` input actually contains.)

- [ ] **Step 2: Run to verify it fails** — `./tools/nx test
@agent-lcars/console -- orchestrator-dispatch` → FAIL (GitHub-anchor branch
      builds no `work` input today).

- [ ] **Step 3: Implement**

In `handleDispatchRun`, the `task` read becomes unconditional (today it is
only read `if (isWorkAnchor(run.task))`) so a GitHub anchor's `work` is
available too, and the `else` (GitHub-anchor) branch gains a `work` input
whenever `task?.work` is set:

```ts
const task = (await store.readTask(run.task))?.task;
let target: AnchorTarget;
try {
  target = anchorTarget(run, task);
} catch (error) {
  await settleClaim(deps, entry, 'done');
  result.failed.push({ entryId: entry.entryId, error: errorMessage(error) });
  return;
}

let inputs: Record<string, string>;
if (isWorkAnchor(run.task)) {
  let spec: WorkSpec;
  try {
    spec = workSpecSchema.parse(task?.work?.['spec']);
  } catch (error) {
    await settleClaim(deps, entry, 'done');
    result.failed.push({
      entryId: entry.entryId,
      error: errorMessage(error),
    });
    return;
  }
  inputs = {
    work: JSON.stringify({ id: run.task.workId, spec }),
    mode: 'implement',
    broker_intent_id: run.runId,
    broker_generation: parseGeneration(run.runId),
    broker_dispatch_token: crypto.randomUUID(),
  };
} else {
  // A GitHub anchor's `work` (present once Tasks 1-3 have derived one for
  // this task) carries no separate `id` -- the anchor already names the
  // task via `issue`. `spec.parse` failing here (an overlong/malformed
  // stored payload) is the same permanent-failure shape as the native
  // branch above: settle done, do not retry a spec that can never parse.
  let workInput: string | undefined;
  if (task?.work !== undefined) {
    try {
      workInput = JSON.stringify({
        spec: workSpecSchema.parse(task.work['spec']),
      });
    } catch (error) {
      await settleClaim(deps, entry, 'done');
      result.failed.push({
        entryId: entry.entryId,
        error: errorMessage(error),
      });
      return;
    }
  }
  inputs = {
    issue: String(target.issue),
    ...(workInput === undefined ? {} : { work: workInput }),
    mode: run.params?.mode ?? 'implement',
    reply: run.params?.reply ?? '',
    runbook: run.params?.runbook ?? '',
    context: run.params?.context ?? '',
    broker_intent_id: run.runId,
    broker_generation: parseGeneration(run.runId),
    broker_dispatch_token: crypto.randomUUID(),
  };
}
```

Fix the test's placeholder assertion to match this shape:
`JSON.parse(body.inputs.work)` is `{ spec: { title: 'T', description: 'D',
pipeline: 'claude', target: { repo: 'jlapenna/agent-lcars' } } }` — no
`id` field (a GitHub anchor is already named by `issue`).

- [ ] **Step 4: Run** — `./tools/nx test @agent-lcars/console --
orchestrator-dispatch` → PASS; typecheck; prettier.

- [ ] **Step 5: Commit**

```bash
git add apps/console/src/lib/orchestrator-dispatch.ts \
  apps/console/src/lib/orchestrator-dispatch.test.ts
git commit -m "feat(console): drain emits a work input for GitHub-anchored dispatch too

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BiTUeJCQByPUqRLZUpt3CD"
```

---

### Task 5: `prepare.sh` builds the brief from `WORK` for an issue anchor too

**Files:**

- Modify: `.github/actions/prepare-agent-dispatch/prepare.sh`
- Modify: `.github/actions/prepare-agent-dispatch/prepare.test.sh`
- Modify: `.github/actions/prepare-agent-dispatch/action.yml`
- Modify: `.github/actions/published-actions.contract.test.mjs`

**Interfaces:**

- Consumes: the `work` workflow input a GitHub-anchored dispatch now
  carries (Task 4).
- Produces: the brief's `anchor.type` for a GitHub anchor keeps being
  _inferred_ from the raw GitHub response — never hardcoded — whenever
  `ISSUE` is set, regardless of whether `WORK` is also set: a plain issue
  still resolves `issue`, a PR-backed anchor still resolves `pull-request`,
  exactly as the legacy (no-`WORK`) branch already relies on. Only
  `anchor.title`/`anchor.body` change: they come from `WORK.spec` when
  `WORK` is present, from the live issue/PR read otherwise (unchanged
  legacy behavior). Consumed by Task 6 (adds `runtime.projections` to the
  same brief) and the protocol rewrite (Task 9), which assumes this brief
  shape.

- [ ] **Step 1: Write the failing test**

```bash
# .github/actions/prepare-agent-dispatch/prepare.test.sh -- append two new
# sections after the existing native_root section and before the
# malformed_root section, in this file's own flat fixture style (no helper
# functions -- every other section in this file inlines its own fake `gh`
# script, fixture files, env exports, and `jq -e` assertions; do the same
# here rather than inventing `assert_json_field`/`run_prepare_sh` helpers
# the file does not have).

# A GitHub-anchored task that carries a work payload (WORK and ISSUE both
# set, sub-project 5): the brief's title/body come from WORK.spec, but its
# number/html_url/labels/assignees/state still come from the live issue --
# and, critically, `type` is not hardcoded here, so a PR-backed anchor
# still resolves "pull-request" through the same fallback the legacy
# (no-WORK) branch already relies on.
work_and_issue_root="$test_root/work-and-issue"
mkdir -p "$work_and_issue_root/runner-temp" "$work_and_issue_root/consumer"

wi_bin="$work_and_issue_root/bin"
mkdir -p "$wi_bin"
WI_ANCHOR="$work_and_issue_root/anchor.json"
WI_COMMENTS="$work_and_issue_root/comments.json"
cat > "$wi_bin/gh" <<'FAKE_GH'
#!/usr/bin/env bash
set -euo pipefail
test "$1" = api
case "$2" in
  */comments*) cat "$WI_COMMENTS" ;;
  */issues/42) cat "$WI_ANCHOR" ;;
  *) echo "unexpected gh api path: $2" >&2; exit 64 ;;
esac
FAKE_GH
chmod +x "$wi_bin/gh"

# The live issue's own title/body deliberately DIFFER from WORK.spec, to
# prove the brief uses the WORK snapshot, not this live read.
cat > "$WI_ANCHOR" <<'JSON'
{"number":42,"state":"open","state_reason":null,"title":"Live title (stale)","body":"Live body (stale)","labels":[{"name":"agent:claude"}],"assignees":[{"login":"agent-lcars-bot"}],"html_url":"https://github.com/jlapenna/agent-lcars/issues/42"}
JSON
echo '[]' > "$WI_COMMENTS"

WORK='{"spec":{"title":"Snapshot title","description":"Snapshot body","pipeline":"claude","target":{"repo":"jlapenna/agent-lcars"}}}'
ISSUE="42"
MODE="implement"
REPLY=""
CONTEXT=""
RUNNER_TEMP="$work_and_issue_root/runner-temp"
GITHUB_ENV="$work_and_issue_root/github-env"
GITHUB_OUTPUT="$work_and_issue_root/github-output"
GITHUB_REPOSITORY="jlapenna/agent-lcars"
export WORK ISSUE MODE REPLY CONTEXT RUNNER_TEMP GITHUB_ENV GITHUB_OUTPUT \
  GITHUB_REPOSITORY WI_ANCHOR WI_COMMENTS

(
  cd "$work_and_issue_root/consumer"
  GITHUB_WORKSPACE="$work_and_issue_root/consumer" PATH="$wi_bin:$PATH" \
    bash "$action_dir/prepare.sh"
)

wi_context_path="$RUNNER_TEMP/agent-dispatch/context.json"
jq -e '
  .anchor.type == "issue" and
  .anchor.number == 42 and
  .anchor.title == "Snapshot title" and
  .anchor.body == "Snapshot body" and
  .anchor.labels == ["agent:claude"] and
  .anchor.assignees == ["agent-lcars-bot"] and
  .anchor.html_url == "https://github.com/jlapenna/agent-lcars/issues/42" and
  .anchor.id == null' "$wi_context_path" >/dev/null

# Same fixture, but the live issue IS a pull request (`pull_request` key
# present): the brief must still resolve "pull-request", proving the new
# branch does not hardcode `type: "issue"`.
cat > "$WI_ANCHOR" <<'JSON'
{"number":42,"state":"open","state_reason":null,"title":"Live title (stale)","body":"Live body (stale)","labels":[],"assignees":[],"html_url":"https://github.com/jlapenna/agent-lcars/pull/42","pull_request":{"url":"https://api.github.com/repos/jlapenna/agent-lcars/pulls/42"}}
JSON

(
  cd "$work_and_issue_root/consumer"
  GITHUB_WORKSPACE="$work_and_issue_root/consumer" PATH="$wi_bin:$PATH" \
    bash "$action_dir/prepare.sh"
)

jq -e '.anchor.type == "pull-request"' "$wi_context_path" >/dev/null

echo "prepare.test.sh: work-and-issue anchor cases passed"
```

- [ ] **Step 2: Run to verify it fails** — `bash
.github/actions/prepare-agent-dispatch/prepare.test.sh` → FAIL (today's
      script either ignores `WORK` when `ISSUE` is set, or the native branch's
      `anchor.type: 'work'` wins and drops the issue metadata and the
      `pull_request` field entirely).

- [ ] **Step 3: Implement**

Replace `prepare.sh`'s `if [ -n "${WORK:-}" ]; then ... else ... fi`
three-way split:

```bash
if [ -n "${WORK:-}" ] && [ -z "${ISSUE:-}" ]; then
  # Native work item: no GitHub read at all -- unchanged from today.
  if ! jq -e '.id and .spec.title and .spec.target.repo' <<<"$WORK" >/dev/null 2>&1; then
    echo "::error::WORK is malformed: expected {id, spec:{title, target:{repo}}}" >&2
    exit 1
  fi
  work_json="$(jq -c . <<<"$WORK")"
  anchor_json="$(jq -cn --argjson w "$work_json" --arg console "${CONSOLE_URL:-https://lcars.jlapenna.net}" '{
    type: "work",
    id: $w.id,
    title: $w.spec.title,
    body: $w.spec.description,
    target_repo: $w.spec.target.repo,
    html_url: ($console + "/work/" + $w.id),
    labels: [], assignees: [], state: "open", state_reason: null
  }')"
  comments_json='[]'
  REPLY=''
elif [ -n "${WORK:-}" ] && [ -n "${ISSUE:-}" ]; then
  # Sub-project 5: a GitHub-anchored task that carries a work payload.
  # The task text comes from WORK.spec -- the issue is evidence for
  # linking (number, html_url, labels, assignees, state, and -- via the
  # merge below -- whether this anchor is actually a PR) and, in reply
  # mode, for the comment thread; it is not the source of the brief's
  # title/body.
  if ! jq -e '.spec.title and .spec.target.repo' <<<"$WORK" >/dev/null 2>&1; then
    echo "::error::WORK is malformed: expected {spec:{title, target:{repo}}}" >&2
    exit 1
  fi
  work_json="$(jq -c . <<<"$WORK")"
  issue_json="$(gh api "repos/$GITHUB_REPOSITORY/issues/$ISSUE")"
  comments_json="$(gh api "repos/$GITHUB_REPOSITORY/issues/$ISSUE/comments?per_page=100" --paginate)"
  # Merge, right side wins: every field the raw issue/PR response carries
  # (number, labels, assignees, state, state_reason, html_url, and --
  # load-bearing -- pull_request) survives untouched, with only
  # title/body overridden from WORK.spec. No `type` is set here on
  # purpose -- the downstream anchor.type fallback ($anchor.type // (if
  # $anchor.pull_request then "pull-request" else "issue" end)) infers it
  # from the merged $anchor.pull_request exactly as the legacy (no-WORK)
  # branch below already relies on, so a PR-backed anchor keeps its
  # "pull-request" type instead of being hardcoded to "issue".
  anchor_json="$(jq -cn --argjson w "$work_json" --argjson i "$issue_json" \
    '$i + { title: $w.spec.title, body: $w.spec.description }')"
else
  # Legacy: no work payload yet on this task (pre-sub-project-5, or a task
  # created through the internal-request path -- see the design spec's
  # "handleDispatchRequest is not a derivation site" note). Unchanged.
  anchor_json="$(gh api "repos/$GITHUB_REPOSITORY/issues/$ISSUE")"
  comments_json="$(gh api "repos/$GITHUB_REPOSITORY/issues/$ISSUE/comments?per_page=100" --paginate)"
fi
```

The downstream `jq -n` assembly's `anchor.type` line already reads
`($anchor.type // (if $anchor.pull_request then "pull-request" else "issue"
end))` — the new middle branch never sets `type` itself, so a plain issue
still infers `"issue"` and a PR-backed anchor still infers `"pull-request"`,
exactly like the legacy (no-`WORK`) branch, which passes the raw GitHub
response straight through; the `id`/`target_repo` gate (`if $anchor.type ==
"work" then ... else null end`) also needs no change, since both `"issue"`
and `"pull-request"` leave those fields `null` exactly as they already are
today.

`action.yml` — update the `work` input's own doc string (no longer
mutually exclusive with `issue`) and add the new
`control-plane-projections` input used by Task 6:

```yaml
work:
  description: >-
    JSON dispatch payload: `{"spec":{"title","description","pipeline","target":{"repo"}}}`
    for a GitHub-anchored task that carries one (sub-project 5), or
    `{"id","spec":{...}}` for a native work item with no issue anchor. When
    `issue` is also set, the brief's `anchor.title`/`anchor.body` come from
    this input's `spec`, merged over the issue's own number/labels/
    assignees/state/pull_request for linking and type inference. When
    `issue` is empty, the brief's `anchor` is `type: "work"` built from
    this input alone, with no GitHub read. Empty for a legacy issue-anchored
    dispatch with no work payload yet.
  required: false
  default: ''
```

(the `control-plane-projections` input itself is added by Task 6, which
also updates this file — do not add it here to keep this task's diff
scoped to the WORK/ISSUE branch.)

- [ ] **Step 4: Run** — `bash
.github/actions/prepare-agent-dispatch/prepare.test.sh` → PASS (native,
      legacy, work-and-issue, and work-and-pull-request cases); confirm the
      existing WORK-only and no-WORK cases are untouched (regression pins).

- [ ] **Step 5: Update the published-actions manifest**

```js
// .github/actions/published-actions.contract.test.mjs -- update
// `PUBLISHED['prepare-agent-dispatch']`'s `work` doc comment stays as-is
// (the manifest only asserts requiredness/default, both unchanged); no
// entry changes here since this task adds no new input. Confirm the test
// still passes -- it is a regression guard, not something this task edits.
```

- [ ] **Step 6: Commit**

```bash
git add .github/actions/prepare-agent-dispatch/prepare.sh \
  .github/actions/prepare-agent-dispatch/prepare.test.sh \
  .github/actions/prepare-agent-dispatch/action.yml
git commit -m "feat(dispatch): prepare.sh builds the brief from WORK for an issue anchor too

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BiTUeJCQByPUqRLZUpt3CD"
```

---

### Task 6: `control-plane-projections` lane flag, end to end

**Files:**

- Modify: `.github/workflows/agent-lane.yml`
- Modify: `.github/actions/dispatch-bootstrap/action.yml`
- Modify: `.github/actions/prepare-agent-dispatch/prepare.sh`
- Modify: `.github/actions/prepare-agent-dispatch/action.yml`
- Modify: `.github/actions/prepare-agent-dispatch/prepare.test.sh`
- Modify: `.github/actions/published-actions.contract.test.mjs`
- Modify: `.github/workflows/agent-lane-{claude,codex,opencode}.yml`
- Modify: `.github/workflows/{claude,codex,opencode}.yml`
- Modify: `tools/contract-tests/worker-workflow-contract.test.ts`

**Interfaces:**

- Produces: a `boolean` `control-plane-projections` input (default
  `false`) on `agent-lane.yml` and all three published shims, forwarded to
  `dispatch-bootstrap` (gates its claim step) and to
  `prepare-agent-dispatch` (sets the brief's `runtime.projections`).
  Consumed by Task 9 (the protocol rewrite reads `runtime.projections`).

This task is almost entirely wiring across many small YAML/bash edits with
one shared shape (`'true'`/`'false'` threaded verbatim); its own test is
the workflow-contract assertion in Step 3, not a red/green cycle per file.

- [ ] **Step 1: `agent-lane.yml`**

In `on.workflow_call.inputs`, add beside `dispatch-bootstrap`:

```yaml
control-plane-projections:
  description: >-
    When true, the console owns the issue-side eyes reaction, fleet
    assignee claim, and park label/comment for this dispatch (sub-project
    5) -- this lane skips its own claim step and the agent follows the
    protocol's native rules instead of writing the issue directly. Default
    false: every consumer's lane call is unchanged until it opts in.
  required: false
  default: false
  type: boolean
```

Gate both claim steps (the `dispatch-bootstrap`-era one lives in
`dispatch-bootstrap/action.yml`, Step 2 below; the legacy one is inline in
this file):

```yaml
- name: Claim the issue as the agent fleet
  if: ${{ !inputs.dispatch-bootstrap && inputs.issue != '' && !inputs.control-plane-projections }}
  id: claim
  uses: jlapenna/agent-lcars/.github/actions/claim-issue@main # latest
  # ...unchanged with block...
```

Both `prepare-agent-dispatch` invocations (consumer-era and
`dispatch-bootstrap`-era) forward the new input alongside the existing
`work: ${{ inputs.work }}` line:

```yaml
control-plane-projections: ${{ inputs.control-plane-projections }}
```

- [ ] **Step 2: `dispatch-bootstrap/action.yml`**

New input:

```yaml
control-plane-projections:
  description: >-
    Passthrough of the lane's own `control-plane-projections` input
    (sub-project 5) -- when true, skips this action's own claim step
    because the console claims the issue itself on dispatch confirm.
  required: false
  default: 'false'
```

Gate the claim step:

```yaml
- name: Claim the issue as the agent fleet
  id: claim
  if: inputs.issue != '' && inputs.control-plane-projections != 'true'
  uses: ./.github/actions/claim-issue
  with:
    token: ${{ steps.agent-lcars-token.outputs.token }}
    issue: ${{ inputs.issue }}
    claim-login: ${{ inputs.agent-fleet-login }}
```

`agent-lane.yml`'s `dispatch-bootstrap` invocation gains
`control-plane-projections: ${{ inputs.control-plane-projections }}` in its
own `with:` block.

- [ ] **Step 3: `prepare-agent-dispatch`**

`action.yml` — new input, matching the pattern of every other passthrough
boolean-as-string input in this action:

```yaml
control-plane-projections:
  description: >-
    When 'true', the brief's `runtime.projections` is `true` -- the
    protocol's native rules apply to this dispatch regardless of anchor
    (sub-project 5). Default 'false'.
  required: false
  default: 'false'
```

Add it to the step's `env:` block:

```yaml
env:
  # ...existing entries...
  CONTROL_PLANE_PROJECTIONS: ${{ inputs.control-plane-projections }}
```

`prepare.sh` — validate and thread it into the final `jq -n` assembly's
`runtime` object, alongside `started_at`/`deadline`/etc:

```bash
if [ "${CONTROL_PLANE_PROJECTIONS:-false}" != 'true' ] && [ "${CONTROL_PLANE_PROJECTIONS:-false}" != 'false' ]; then
  echo "::error::CONTROL_PLANE_PROJECTIONS must be 'true' or 'false'" >&2
  exit 1
fi
```

```bash
  --argjson projections "$([ "${CONTROL_PLANE_PROJECTIONS:-false}" = 'true' ] && echo true || echo false)" \
  # ...
    runtime: {
      started_at: $started_at,
      deadline: $deadline,
      budget_minutes: $budget_minutes,
      projections: $projections,
      checkpoints: { ... unchanged ... }
    },
```

`prepare.test.sh` — a new case asserting `CONTROL_PLANE_PROJECTIONS=true`
produces `.runtime.projections == true` and the default (unset) produces
`false`; extend Task 5's `WORK`+`ISSUE` case to also assert `runtime.
projections` under both flag values.

`published-actions.contract.test.mjs` — add to
`PUBLISHED['prepare-agent-dispatch'].inputs`:

```js
'control-plane-projections': { required: false, default: 'false' },
```

- [ ] **Step 4: The three published shims and agent-lcars's own workflows**

`agent-lane-{claude,codex,opencode}.yml`: each declares
`control-plane-projections` with the identical `required: false, default:
false, type: boolean` shape as `dispatch-bootstrap` already has, and
forwards it in the `with:` block calling `agent-lane.yml`:
`control-plane-projections: ${{ inputs.control-plane-projections }}`.

`.github/workflows/{claude,codex,opencode}.yml`: each already passes
`dispatch-bootstrap: true` to its shim; add
`control-plane-projections: true` alongside it.

- [ ] **Step 5: Extend the workflow contract test**

```ts
// tools/contract-tests/worker-workflow-contract.test.ts -- add to
// COMMON_LANE_INPUTS
'control-plane-projections': { required: false, type: 'boolean', default: false },
```

Add a new `it` in the `'published reusable lane workflow surface'`
describe block asserting the union lane's own `control-plane-projections`
input matches `{required: false, type: 'boolean', default: false}` (the
existing per-pipeline `LANE_SURFACES[pipeline].inputs` loop already covers
the shims once `control-plane-projections` is added there too — add it to
each pipeline's manifest entry, matching `dispatch-bootstrap`'s existing
entry line for line).

Add a new `it` asserting `.github/workflows/{claude,codex,opencode}.yml`
each set `control-plane-projections: true` in their `with:` block calling
the shim (mirroring however this file already asserts
`dispatch-bootstrap: true` there, if it does — otherwise add both
assertions together, reading the caller workflow with the same
`loadWorkflow` helper this file already exports/uses).

- [ ] **Step 6: Run**

`bash .github/actions/prepare-agent-dispatch/prepare.test.sh` → PASS.
`node --test .github/actions/published-actions.contract.test.mjs` (or this
repo's actual invocation — check `ci.yml`/`package.json` for the exact
command already registered for this file) → PASS.
`./tools/nx test @agent-lcars/console -- worker-workflow-contract` (or
wherever `tools/contract-tests` runs from — check its `vitest.config.mts`
project name) → PASS. `actionlint` (or whatever this repo's workflow-lint
step is) over the touched YAML files.

- [ ] **Step 7: Commit**

```bash
git add .github/workflows/agent-lane.yml \
  .github/actions/dispatch-bootstrap/action.yml \
  .github/actions/prepare-agent-dispatch/prepare.sh \
  .github/actions/prepare-agent-dispatch/action.yml \
  .github/actions/prepare-agent-dispatch/prepare.test.sh \
  .github/actions/published-actions.contract.test.mjs \
  .github/workflows/agent-lane-claude.yml \
  .github/workflows/agent-lane-codex.yml \
  .github/workflows/agent-lane-opencode.yml \
  .github/workflows/claude.yml \
  .github/workflows/codex.yml \
  .github/workflows/opencode.yml \
  tools/contract-tests/worker-workflow-contract.test.ts
git commit -m "feat(dispatch): control-plane-projections lane flag, agent-lcars opts in

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BiTUeJCQByPUqRLZUpt3CD"
```

---

### Task 7: Console projection — eyes reaction + fleet-assignee claim on dispatch confirm

**Files:**

- Modify: `apps/console/src/lib/orchestrator-dispatch.ts`
- Modify: `apps/console/src/lib/orchestrator-dispatch.test.ts`

**Interfaces:**

- Consumes: `agentFleetLogin()` (`deployment.ts`, existing).
- Produces: `handleDispatchRun`'s observable contract gains "a GitHub-anchored
  run posts an eyes reaction and an assignee claim right after
  `confirmDispatch` succeeds." No new exports; this is additive behavior on
  an existing function.

- [ ] **Step 1: Write the failing test**

```ts
// apps/console/src/lib/orchestrator-dispatch.test.ts
it('posts an eyes reaction and claims the fleet assignee after confirming a GitHub-anchored dispatch', async () => {
  const { store, orchestrator } = fixture();
  const requested = await orchestrator.request({
    taskId: { repo: 'jlapenna/agent-lcars', issue: 42 },
    requestId: 'req-1',
    pipeline: 'claude',
    params: { mode: 'implement' },
  });
  if (isRefusal(requested)) throw new Error('unexpected refusal');

  const { fetchImpl, calls } = fakeFetch(204);
  await drainOutbox({ store, orchestrator, tokens, fetchImpl });

  const reactionCall = calls.find((c) =>
    c.url.endsWith('/issues/42/reactions'),
  );
  expect(reactionCall).toBeDefined();
  expect(JSON.parse(reactionCall!.init.body as string)).toEqual({
    content: 'eyes',
  });

  const assigneeCall = calls.find((c) =>
    c.url.endsWith('/issues/42/assignees'),
  );
  expect(assigneeCall).toBeDefined();
  expect(JSON.parse(assigneeCall!.init.body as string)).toEqual({
    assignees: ['agent-lcars-bot'],
  });
});

it('a native anchor posts no eyes reaction or claim', async () => {
  const { store, orchestrator } = fixture();
  const requested = await orchestrator.request({
    taskId: { workId: '01PROJECTIONTESTFIXTUREX01' },
    requestId: 'req-1',
    pipeline: 'claude',
    work: {
      origin: { principal: 'user:jlapenna', channel: 'api' },
      spec: {
        title: 't',
        description: 'd',
        pipeline: 'claude',
        target: { repo: 'octo/example' },
      },
    },
  });
  if (isRefusal(requested)) throw new Error('unexpected refusal');

  const { fetchImpl, calls } = fakeFetch(204);
  await drainOutbox({ store, orchestrator, tokens, fetchImpl });

  expect(calls.some((c) => c.url.includes('/reactions'))).toBe(false);
  expect(calls.some((c) => c.url.includes('/assignees'))).toBe(false);
});

it('a failed claim/reaction call does not fail the dispatch', async () => {
  const { store, orchestrator } = fixture();
  const requested = await orchestrator.request({
    taskId: { repo: 'jlapenna/agent-lcars', issue: 42 },
    requestId: 'req-1',
    pipeline: 'claude',
    params: { mode: 'implement' },
  });
  if (isRefusal(requested)) throw new Error('unexpected refusal');

  // First call (workflow_dispatch) succeeds; reaction/assignee calls fail.
  let call = 0;
  const fetchImpl = (async () => {
    call += 1;
    return new Response(null, { status: call === 1 ? 204 : 500 });
  }) as typeof fetch;
  const result = await drainOutbox({ store, orchestrator, tokens, fetchImpl });

  expect(result.dispatched).toHaveLength(1);
  expect(result.failed).toHaveLength(0);
});
```

- [ ] **Step 2: Run to verify it fails** — `./tools/nx test
@agent-lcars/console -- orchestrator-dispatch` → FAIL (no reaction/claim
      calls made today).

- [ ] **Step 3: Implement**

```ts
import { agentFleetLogin } from './deployment';
```

```ts
/** Additive, idempotent, best-effort -- mirrors `claim.sh`'s own posture
 *  exactly (a failed claim/reaction must not cost the dispatch, which has
 *  already succeeded by the time this runs). Posts the single visible
 *  acknowledgement a human watching the issue looks for; it is
 *  deliberately not a byte-identical replay of the agent's own former §2
 *  action (one eyes reaction on the issue body, not one per comment the
 *  agent has individually read -- the console has not read any comments
 *  at this point). See the design spec's "Projections" note. */
async function claimGithubAnchor(
  deps: DispatchDeps,
  target: AnchorTarget,
): Promise<void> {
  if (target.issue === undefined) return;
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const apiBaseUrl = githubApiBaseUrl(deps);
  try {
    const token = await deps.tokens.tokenFor(target.repo);
    await fetchImpl(
      `${apiBaseUrl}/repos/${target.repo}/issues/${target.issue}/reactions`,
      {
        method: 'POST',
        headers: githubHeaders(token),
        body: JSON.stringify({ content: 'eyes' }),
      },
    );
    await fetchImpl(
      `${apiBaseUrl}/repos/${target.repo}/issues/${target.issue}/assignees`,
      {
        method: 'POST',
        headers: githubHeaders(token),
        body: JSON.stringify({ assignees: [agentFleetLogin()] }),
      },
    );
  } catch {
    // Swallowed deliberately -- see the doc comment above.
  }
}
```

In `handleDispatchRun`, right after `await
orchestrator.confirmDispatch(run.runId);`:

```ts
await orchestrator.confirmDispatch(run.runId);
await claimGithubAnchor(deps, target);
await settleClaim(deps, entry, 'done');
result.dispatched.push(run.runId);
```

- [ ] **Step 4: Run** — `./tools/nx test @agent-lcars/console --
orchestrator-dispatch` → PASS; typecheck; prettier.

- [ ] **Step 5: Commit**

```bash
git add apps/console/src/lib/orchestrator-dispatch.ts \
  apps/console/src/lib/orchestrator-dispatch.test.ts
git commit -m "feat(console): project the eyes reaction and fleet-assignee claim on dispatch confirm

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BiTUeJCQByPUqRLZUpt3CD"
```

---

### Task 8: Console projection — the park label on every parked outcome

**Files:**

- Modify: `apps/console/src/lib/orchestrator-dispatch.ts`
- Modify: `apps/console/src/lib/orchestrator-dispatch.test.ts`

**Interfaces:**

- Produces: `handleReportOutcome`'s observable contract changes: a
  `finished, ok: false` GitHub-anchored run now also gets the
  `status:needs-human` label (previously only the `lost`-budget-exhausted
  case did). No new exports.

- [ ] **Step 1: Write the failing test**

```ts
// apps/console/src/lib/orchestrator-dispatch.test.ts
it('a finished-not-ok outcome also gets the status:needs-human label', async () => {
  const { store, orchestrator } = fixture();
  const requested = await orchestrator.request({
    taskId: { repo: 'jlapenna/agent-lcars', issue: 42 },
    requestId: 'req-1',
    pipeline: 'claude',
    params: { mode: 'implement' },
  });
  if (isRefusal(requested)) throw new Error('unexpected refusal');
  const runId = decidedRun(requested).runId;
  await orchestrator.confirmDispatch(runId);
  await orchestrator.report(runId, { ok: false, summary: 'blocked' });

  // routedFetch, not fakeFetch (which only ever takes one status): this
  // one drainOutbox call settles two outbox entries -- the original
  // dispatch-run entry, now stale since confirmDispatch was called
  // directly above rather than through a drain (handleDispatchRun's own
  // `run.state !== 'pending'` guard settles it `done` without ever
  // calling fetch), and the report-outcome entry `report()` created,
  // which needs both a comment (201) and a label (200) call to succeed.
  const { fetchImpl, calls } = routedFetch();
  await drainOutbox({ store, orchestrator, tokens, fetchImpl });

  const labelCall = calls.find((c) => c.url.endsWith('/issues/42/labels'));
  expect(labelCall).toBeDefined();
  expect(JSON.parse(labelCall!.init.body as string)).toEqual({
    labels: ['status:needs-human'],
  });
});
```

(`routedFetch` is this file's existing URL-routed fixture — dispatch calls
204, label calls 200, everything else 201 — already used by the file's
other mixed dispatch-plus-report tests; the existing budget-exhausted
`lost` case already exercises the label call today, and this test just
proves the same call now also fires for the `finished, ok: false` case,
which the existing tests already prove it did NOT before this task.)

- [ ] **Step 2: Run to verify it fails** — `./tools/nx test
@agent-lcars/console -- orchestrator-dispatch` → FAIL (no label call for
      the finished-not-ok case).

- [ ] **Step 3: Implement**

In `handleReportOutcome`, the non-`lost` branch's `needsHumanLabel`
changes from a hardcoded `false` to a check on the result:

```ts
const outcome =
  run.state === 'lost'
    ? await describeLostOutcome(store, run, task)
    : {
        body: outcomeCommentBody(run),
        needsHumanLabel: run.state === 'finished' && run.result?.ok === false,
      };
```

No other line in `handleReportOutcome` changes — `addNeedsHumanLabelBestEffort`
is already called whenever `outcome.needsHumanLabel` is true, for both
branches.

- [ ] **Step 4: Run** — `./tools/nx test @agent-lcars/console --
orchestrator-dispatch` → PASS (including every existing `lost`/
      finished-ok test, unaffected); typecheck; prettier.

- [ ] **Step 5: Commit**

```bash
git add apps/console/src/lib/orchestrator-dispatch.ts \
  apps/console/src/lib/orchestrator-dispatch.test.ts
git commit -m "feat(console): park label on a finished-not-ok outcome, not only exhausted retries

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BiTUeJCQByPUqRLZUpt3CD"
```

---

### Task 9: Protocol collapse — `agent-protocol.md` §1–§4 become native rules under `runtime.projections`

**Files:**

- Modify: `agents/shared/skills/agent-protocol/reference/agent-protocol.md`
- Modify: `tools/contract-tests/worker-workflow-contract.test.ts`
- Modify: `.github/workflows/agent-lane.yml` (default-prompt park clause)
- Modify: `tools/contract-tests/lane-default-prompt.test.ts`

**Interfaces:**

- Consumes: the brief's `runtime.projections` field (Task 6).
- Produces: no code interface — a documentation contract. Section numbers
  §1–§5 are preserved (their _content_ changes); §5a is removed as a
  separate section, its table promoted into §1–§4's own rows; a new
  "Legacy (projections off)" subsection holds the byte-identical former
  §1–§4 text. The native rules apply whenever `runtime.projections ===
true || anchor.type === 'work'` — the `anchor.type === 'work'` half
  matters because a native run's brief may arrive through sub-project 4's
  `GET /runs/{id}/brief` route rather than through `prepare.sh`, and that
  route has no obligation to stamp `runtime.projections`; a native anchor
  has no issue to write to either way, so it must get the native rules
  regardless of that field's presence.

- [ ] **Step 1: Write the failing contract-test assertions**

`tools/contract-tests/lane-default-prompt.test.ts` extracts and _runs_
`agent-lane.yml`'s own prompt-rendering step (see this file's own top
comment) — it never reads `agent-protocol.md` at all, so the protocol
doc's own section-number/marker pins belong in `tools/contract-tests/
worker-workflow-contract.test.ts` instead, which already `readFileSync`s
`.agents/skills/agent-protocol/reference/agent-protocol.md` for its
existing `'headless handoff forbids review requests and requires verified
auto-merge'` test (that path resolves through the `.agents/skills/...`
symlink to the same file this task edits). Add a sibling `it` in the same
describe block:

```ts
// tools/contract-tests/worker-workflow-contract.test.ts -- new case,
// alongside the existing 'headless handoff forbids review requests...'
// test that already reads this same file the same way
it('collapses §1-4 to native rules gated on runtime.projections or a work anchor, with a legacy subsection', () => {
  const protocol = readFileSync(
    path.join(
      repoRoot,
      '.agents/skills/agent-protocol/reference/agent-protocol.md',
    ),
    'utf8',
  );
  expect(protocol).toContain(
    "runtime.projections === true || anchor.type === 'work'",
  );
  expect(protocol).toContain('## Legacy (projections off)');
  expect(protocol).not.toContain('## 5a. Native work items');
  const legacy = protocol.slice(
    protocol.indexOf('## Legacy (projections off)'),
  );
  expect(legacy).toContain('eyes (👀) reaction');
  expect(legacy).toContain('status:needs-human');
  expect(legacy).toContain(
    'gh issue edit <N> --add-label status:needs-human --add-assignee jlapenna',
  );
});
```

Separately, `agent-lane.yml`'s own rendered default prompt names the
legacy issue-mode park recipe by name ("park using the protocol's exact
comment, label, and maintainer-assignee recipe") — already wrong for a
native (issue-less) dispatch even before this sub-project, since a native
run's parking is `PARK <blocker>`, not a label/comment/assignee. Reword it
to be flag-agnostic and pin the new wording (closes #1528):

```ts
// tools/contract-tests/lane-default-prompt.test.ts -- new case, alongside
// this file's other AGENT_PROMPT content assertions (see renderLaneDefaults)
it('describes parking as flag-agnostic (#1528) rather than naming the issue-mode label/comment recipe', () => {
  const { AGENT_PROMPT } = renderLaneDefaults({ pipeline: 'claude' });
  expect(AGENT_PROMPT).toContain(
    "park per the protocol's parking rule for this dispatch",
  );
  expect(AGENT_PROMPT).not.toContain('maintainer-assignee recipe');
});
```

- [ ] **Step 2: Run to verify both fail** — `./tools/nx test
@agent-lcars/console -- worker-workflow-contract lane-default-prompt` (or
      wherever these two contract-tests projects run from) → FAIL.

- [ ] **Step 3: Rewrite `agent-protocol.md` §1–§5a**

Replace §1 ("Takeover comment") through §5 ("Deliverable rule") and the
current §5a with the following structure (keeping §0 and §6–§12
unchanged):

```markdown
## 1. Takeover — your first action

**When `runtime.projections === true || anchor.type === 'work'`** (check
the dispatch brief's `runtime.projections` field, and its `anchor.type` —
a native run has neither an issue to post to nor, sometimes, a
`runtime.projections` field at all, so it always takes this branch): skip.
The console posts the eyes reaction and claims the issue for the fleet the
moment your dispatch is confirmed — before your turn starts — and derives
the takeover affordance from your session doc. Post nothing.

**Otherwise**, follow "Legacy (projections off)" below.

## 2. Eyes reaction and assignee claim

**When `runtime.projections === true || anchor.type === 'work'`**: skip —
already done for you (see §1).

**Otherwise**, follow "Legacy (projections off)" below.

## 3. Progress

**When `runtime.projections === true || anchor.type === 'work'`**:
`lcars session title "<what you are doing>"` and `lcars session status
"<state>"` — the channel §12 already requires, and now your only progress
channel. No issue write.

**Otherwise**, follow "Legacy (projections off)" below.

## 4. Parking — blocked on a human

**When `runtime.projections === true || anchor.type === 'work'`**: end
your response with `PARK <blocker>`. The finalizer reports `ok: false`;
the console applies the `status:needs-human` label and posts the park
comment for you (for an issue anchor — a `work` anchor has no issue to
label). Your blocker text reaches a human only through `lcars session
status` (§12) and this run's log — set it there before you end your turn.
Post nothing to GitHub.

**Otherwise**, follow "Legacy (projections off)" below.

## 5. Deliverable rule — silence is failure

Unchanged for every anchor and every `runtime.projections` value: a run
that reasons to a conclusion and never posts or acts on it is a failed
run. Stamp your attempt's claim marker on the deliverable — the PR
description, evidence comment, review body, or close comment (see below
for the exact marker text). One branch on the reference format:

- **Issue anchor** (`anchor.type` is `issue`, `anchor.number` set — every
  label-driven or reply dispatch, with or without a `work` payload):
  reference the anchor as `Fixes #<N>` in the PR body, as always. A no-op
  is available: post the structured `<!-- agent-result:v1:no-op -->`
  comment alongside your attempt-claim marker.
- **Work anchor** (`anchor.type` is `work`, no issue): reference the item
  as `Work: work:<id>` (never `Fixes #N`). No no-op is available: if the
  request is already satisfied, `PARK` with that evidence instead (§4).

[... the rest of §5's existing marker-format text, unchanged ...]

## Legacy (projections off)

Read this section instead of §1–§4 above whenever `anchor.type` is
`issue` and the dispatch brief's `runtime.projections` is absent or
`false` — every consumer that has not opted into control-plane
projections yet, and every GitHub-anchored task still dispatching through
the pre-`work` brief path.

### Takeover comment — your first action

[... the former §1 text, byte-for-byte unchanged ...]

### Eyes-reaction acknowledgement

[... the former §2 text, byte-for-byte unchanged ...]

### One edited progress comment

[... the former §3 text, byte-for-byte unchanged, including its Dispatch
mode table ...]

### Parking — blocked on a human

[... the former §4 text, byte-for-byte unchanged ...]
```

Delete the standalone "## 5a. Native work items (no issue anchor)" section
and its table entirely — its content is now §1–§4's own gated branches
above, plus §5's anchor-type branch for the deliverable's reference
format.

- [ ] **Step 4: Reword `agent-lane.yml`'s default-prompt park clause**

In the "Resolve the canonical dispatch prompt" step's `default_body`
heredoc (`.github/workflows/agent-lane.yml`), change:

```
for a real blocker, park
using the protocol's exact comment, label, and maintainer-assignee
recipe; for an already-resolved request, post the evidence-backed
no-op.
```

to:

```
for a real blocker, park
per the protocol's parking rule for this dispatch; for an
already-resolved request, post the evidence-backed no-op.
```

(This prompt is rendered identically regardless of `control-plane-
projections` or anchor type — it points the agent at the protocol's own
§4, which is itself now the thing that branches, rather than describing
one specific recipe that was already wrong for a native dispatch.)

- [ ] **Step 5: Run** — both contract-test files from Step 1/2 → PASS;
      re-read the whole rewritten protocol file once for internal
      consistency (no dangling `§5a` cross-reference anywhere in this repo
      — `grep -rn '§5a\|section 5a' agents/ .github/ tools/` should return
      nothing after this task).

- [ ] **Step 6: Commit**

```bash
git add agents/shared/skills/agent-protocol/reference/agent-protocol.md \
  tools/contract-tests/worker-workflow-contract.test.ts \
  .github/workflows/agent-lane.yml \
  tools/contract-tests/lane-default-prompt.test.ts
git commit -m "docs(agent-protocol): collapse to native rules under runtime.projections or a work anchor

Closes #1528.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BiTUeJCQByPUqRLZUpt3CD"
```

---

### Task 10: Task detail page shows the `work.spec` snapshot when present

**Files:**

- Modify: `apps/console/src/lib/authoritative-task-state.ts`
- Modify: `apps/console/src/lib/authoritative-task-state.test.ts`
- Modify: `apps/console/src/lib/task-detail.ts`
- Modify: `apps/console/src/lib/task-detail.test.ts`
- Modify: `apps/console/src/app/task/logical-work-card.tsx`
- Modify: `apps/console/src/app/task/logical-work-card.test.tsx`

**Interfaces:**

- Produces: `AuthoritativeTaskState.spec?: WorkSpec` (from
  `@agent-lcars/work`); `TaskDetailResult`'s `ok` variant gains `spec?:
WorkSpec`; `LogicalWorkCard` gains an optional `spec?: WorkSpec` prop,
  rendered only when present. No other task consumes this — leaf of the
  plan's console-visibility work.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/console/src/lib/authoritative-task-state.test.ts -- new case
it("surfaces the task doc's work.spec when present", async () => {
  await store.writeTask({
    task: { repo: 'jlapenna/agent-lcars', issue: 42 },
    runCount: 0,
    updatedAt: T0,
    work: {
      origin: { principal: 'github:jlapenna', channel: 'github' },
      spec: {
        title: 'T',
        description: 'D',
        pipeline: 'claude',
        target: { repo: 'jlapenna/agent-lcars' },
      },
    },
  });
  const state = await readAuthoritativeTaskState({
    repository: 'jlapenna/agent-lcars',
    issue: 42,
  });
  expect(state?.spec).toEqual({
    title: 'T',
    description: 'D',
    pipeline: 'claude',
    target: { repo: 'jlapenna/agent-lcars' },
  });
});

it('omits spec when the task carries no work payload', async () => {
  await store.writeTask({
    task: { repo: 'jlapenna/agent-lcars', issue: 43 },
    runCount: 0,
    updatedAt: T0,
  });
  const state = await readAuthoritativeTaskState({
    repository: 'jlapenna/agent-lcars',
    issue: 43,
  });
  expect(state?.spec).toBeUndefined();
});
```

(Match this test file's existing store-fixture setup — it already writes
task docs directly against a `MemoryStore`/equivalent test double for its
other `readAuthoritativeTaskState` cases.)

```ts
// apps/console/src/app/task/logical-work-card.test.tsx -- new case
it('renders the work.spec snapshot when present', () => {
  render(
    <LogicalWorkCard
      work={workFixture()}
      runs={[]}
      anchorState="open"
      spec={{
        title: 'Snapshot title',
        description: 'Snapshot body',
        pipeline: 'claude',
        target: { repo: 'jlapenna/agent-lcars' },
      }}
    />,
  );
  expect(screen.getByText(/Snapshot title/)).toBeInTheDocument();
});

it('renders nothing extra when spec is absent', () => {
  render(<LogicalWorkCard work={workFixture()} runs={[]} anchorState="open" />);
  expect(screen.queryByTestId('work-spec-snapshot')).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run to verify it fails** — `./tools/nx test
@agent-lcars/console -- authoritative-task-state task-detail
logical-work-card` → FAIL.

- [ ] **Step 3: Implement**

`authoritative-task-state.ts`:

```ts
import { type WorkSpec, workSpecSchema } from '@agent-lcars/work';

export interface AuthoritativeTaskState {
  schema: typeof AUTHORITATIVE_TASK_STATE_SCHEMA;
  task: { repo: string; issue: number };
  storageRevision: number;
  updatedAt: string;
  activeRunId?: string;
  runs: OrchestratorRun[];
  /** The `work.spec` snapshot this task's brief was (or will be) built
   *  from, when Tasks 1-3 have derived one for it -- absent for a task
   *  still on the legacy issue-reading brief path. Parsed defensively:
   *  a malformed stored payload (should not happen; `mintItem`/the
   *  derivation helpers only ever write a `workSpecSchema`-valid value)
   *  omits `spec` rather than failing this whole read. */
  spec?: WorkSpec;
}
```

```ts
export async function readAuthoritativeTaskState({
  repository,
  issue,
}: {
  repository: string;
  issue: number;
}): Promise<AuthoritativeTaskState | undefined> {
  const { store } = createOrchestratorRuntime();
  const taskId = { repo: repository, issue };
  const versioned = await store.readTask(taskId);
  if (!versioned) return undefined;
  const runs = await store.listRuns(taskId);
  const parsedSpec = workSpecSchema.safeParse(
    (versioned.task.work as Record<string, unknown> | undefined)?.['spec'],
  );
  return {
    schema: AUTHORITATIVE_TASK_STATE_SCHEMA,
    task: taskId,
    storageRevision: versioned.revision,
    updatedAt: versioned.task.updatedAt,
    ...(versioned.task.activeRunId === undefined
      ? {}
      : { activeRunId: versioned.task.activeRunId }),
    runs,
    ...(parsedSpec.success ? { spec: parsedSpec.data } : {}),
  };
}
```

`task-detail.ts` — thread it into the `'ok'` result variant and the return
site:

```ts
export type TaskDetailResult =
  | {
      status: 'ok';
      work: LogicalWork;
      runs: OrchestratorRun[];
      item: ActionItem;
      repo: WatchedRepo;
      anchorState: 'open' | 'closed';
      generatedAt: string;
      /** The task's `work.spec` snapshot, when one has been derived
       *  (sub-project 5) -- see `AuthoritativeTaskState.spec`. */
      spec?: WorkSpec;
    }
  | { status: 'not-found' }
  | { status: 'error'; warning: string };
```

In `getTaskDetail`, `readAuthoritativeTaskStates` is already called
(`authoritative`); its returned `state` for this task's key already
carries `spec` once Task 1's field lands. Thread it into the final
`return`:

```ts
const state = authoritative.states.get(key);
return {
  status: 'ok',
  work,
  runs: state?.runs ?? [],
  item,
  repo,
  anchorState: issue.state === 'closed' ? 'closed' : 'open',
  generatedAt: oldestFetchedAt([sourceFetchedAt, activityFetchedAt]),
  ...(state?.spec === undefined ? {} : { spec: state.spec }),
};
```

(Match the exact existing return statement's other fields — this plan
only adds the trailing `spec` spread; do not restructure the surrounding
`applyOrchestratorTruth`/`classifyIssue` calls this file already makes.)

`logical-work-card.tsx` — new optional prop, rendered as a small
supplementary block (not replacing the live issue title already shown
elsewhere on the page):

```tsx
interface LogicalWorkCardProps {
  work: LogicalWork;
  runs: OrchestratorRun[];
  anchorState: 'open' | 'closed';
  /** The dispatch brief's `work.spec` snapshot, when this task carries one
   *  (sub-project 5) -- what the agent's brief actually saw, which may
   *  differ from the issue's current live title/body if it was edited
   *  after the first dispatch. */
  spec?: WorkSpec;
}

export function LogicalWorkCard({
  work,
  runs,
  anchorState,
  spec,
}: LogicalWorkCardProps) {
  return (
    <>
      {spec !== undefined && (
        <div data-testid="work-spec-snapshot" className="work-spec-snapshot">
          <Text size="xs" c="dimmed">
            Dispatch brief snapshot
          </Text>
          <Text size="sm" fw={600}>
            {spec.title}
          </Text>
          <Text size="sm" c="dimmed" lineClamp={3}>
            {spec.description}
          </Text>
        </div>
      )}
      {/* ...existing card content, unchanged... */}
    </>
  );
}
```

Wire `spec` through from `TaskDetailViewContent`
(`apps/console/src/app/task/[owner]/[repo]/[issue]/page.tsx`):
`<LogicalWorkCard work={detail.work} runs={detail.runs}
anchorState={detail.anchorState} spec={detail.spec} />`.

- [ ] **Step 4: Run** — `./tools/nx test @agent-lcars/console --
authoritative-task-state task-detail logical-work-card` → PASS; typecheck;
      prettier.

- [ ] **Step 5: Commit**

```bash
git add apps/console/src/lib/authoritative-task-state.ts \
  apps/console/src/lib/authoritative-task-state.test.ts \
  apps/console/src/lib/task-detail.ts \
  apps/console/src/lib/task-detail.test.ts \
  apps/console/src/app/task/logical-work-card.tsx \
  apps/console/src/app/task/logical-work-card.test.tsx \
  "apps/console/src/app/task/[owner]/[repo]/[issue]/page.tsx"
git commit -m "feat(console): task detail page shows the work.spec snapshot when present

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BiTUeJCQByPUqRLZUpt3CD"
```

---

### Task 11: Quick Task UI reads derived state instead of scanning issue content

**Files:**

- Modify: `apps/console/src/app/quick-task-button.tsx`
- Modify: `apps/console/src/app/quick-task-button.test.tsx`

**Interfaces:**

- Consumes: `AuthoritativeTaskState` (Task 10's `spec` field is not needed
  here — only the existing `runs`/`activeRunId` fields this component did
  not previously read).
- Produces: no new exports; the Quick Task button's post-creation state
  badge reads the created issue's `AuthoritativeTaskState` instead of
  polling/scanning the issue's labels/comments client-side.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/console/src/app/quick-task-button.test.tsx -- new case in the
// existing post-creation status describe block. Match this file's
// existing mock for whatever server function it already calls to learn
// the created task's state (if the component today has no such read at
// all -- state was inferred purely from the receipt -- this proves the
// new read replaces that inference).
it('shows the orchestrator-derived state once the created issue has one', async () => {
  authoritativeStateMock.mockResolvedValue({
    schema: AUTHORITATIVE_TASK_STATE_SCHEMA,
    task: { repo: 'jlapenna/agent-lcars', issue: 99 },
    storageRevision: 1,
    updatedAt: '2026-08-27T00:00:00.000Z',
    activeRunId: 'jlapenna/agent-lcars#99/r1',
    runs: [{ runId: 'jlapenna/agent-lcars#99/r1', state: 'running' /* ...*/ }],
  });
  render(<QuickTaskButton {...propsAfterCreate(99)} />);
  expect(await screen.findByText(/running/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run to verify it fails** — `./tools/nx test
@agent-lcars/console -- quick-task-button` → FAIL (no such read/badge
      exists yet, or the existing one infers state from stale local data).

- [ ] **Step 3: Implement**

Read `apps/console/src/app/quick-task-button.tsx` in full before editing —
it is not summarized further here since its exact current
state-badge/polling mechanism (or absence of one) determines the precise
diff; wire in a call to `readAuthoritativeTaskState` (server-function
wrapped, following whatever pattern this component already uses to call
console server functions post-creation — e.g. `/work`'s existing
`createServerFunctionable` pattern, or a plain server action if that is
what this component already uses elsewhere) keyed by the receipt's
`task.repository`/`task.issueNumber`, and derive a small state label
(`running` / `parked` / `done` / `unknown`) from `activeRunId`/`runs`
the same way `/work`'s own `deriveItemState`-equivalent logic already
does for native items (do not reimplement that derivation a third time —
if `@agent-lcars/work/derive` exposes a reusable state function over a
task+runs shape, prefer it over a bespoke one here; if it is native-item-
specific and cannot take a GitHub `AuthoritativeTaskState` shape as-is,
write the smallest local adapter rather than generalizing `derive.ts`
itself, which is out of this plan's scope).

- [ ] **Step 4: Add a regression proving Task 2's derivation covers Quick Tasks for free**

```ts
// apps/console/src/lib/orchestrator-ingest.test.ts -- one more case,
// proving a Quick-Task-shaped labeled-issue payload (the issue Quick
// Tasks create already carries both QUICK_TASK_LABEL and the pipeline
// label at creation -- see backend-actions.ts's createQuickTaskOnce)
// derives `work` through the exact same path as any other labeled issue.
{
  name: 'a Quick Task issue (intake:quick-task + agent:claude labels) derives work like any other labeled issue',
  event: 'issues',
  payload: issuesLabeledPayload({
    issue: {
      number: 55,
      title: 'Quick task: fix the thing',
      body: 'Please fix it.\n\n<!-- agent-lcars:quick-task-request:v1 ... -->',
    },
    label: { name: 'agent:claude' },
    sender: { login: 'jlapenna' },
  }),
  expected: {
    kind: 'request',
    taskId: { repo: REPO, issue: 55 },
    requestId: DELIVERY_ID,
    pipeline: 'claude',
    params: { mode: 'implement' },
    work: {
      origin: { principal: 'github:jlapenna', channel: 'github' },
      spec: {
        title: 'Quick task: fix the thing',
        description: 'Please fix it.\n\n<!-- agent-lcars:quick-task-request:v1 ... -->',
        pipeline: 'claude',
        target: { repo: REPO },
      },
    },
  },
},
```

- [ ] **Step 5: Run** — `./tools/nx test @agent-lcars/console --
quick-task-button orchestrator-ingest` → PASS; typecheck; prettier.

- [ ] **Step 6: Commit**

```bash
git add apps/console/src/app/quick-task-button.tsx \
  apps/console/src/app/quick-task-button.test.tsx \
  apps/console/src/lib/orchestrator-ingest.test.ts
git commit -m "feat(console): Quick Task UI reads orchestrator-derived state

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BiTUeJCQByPUqRLZUpt3CD"
```

---

### Task 12: Land and prove the real path

**Files:**

- Modify: `docs/native-work-smoke-runbook.md`

- [ ] **Step 1: Push and open the PR**

```bash
git push -u origin HEAD
gh pr create --title "feat(work): ingress unification (native work items, sub-project 5)" \
  --body "Implements Sub-project 5 of docs/superpowers/specs/2026-08-23-native-work-items-design.md. See that doc's new \"Sub-project 5: ingress unification\" section for the full design."
```

Wait for CI (`Verify` required check) green and resolve any review threads
per the `agent-lcars-dev` skill's guardrails; merge once green and
approved.

- [ ] **Step 2: Real-path proof — label-driven run under projections**

After the merge deploys (agent-lcars's own workers now pass
`control-plane-projections: true`):

```bash
gh issue create --repo jlapenna/agent-lcars \
  --title "Sub-project 5 smoke: label-driven run under projections" \
  --body "One-line README edit under a \"Sub-project 5 smoke\" heading. Close, do not merge, the resulting PR." \
  --label agent:claude
```

Confirm and record:

- The run's job step conclusions show the lane's own claim step
  `skipped` (`gh run view <run-id> --json jobs`).
- The eyes reaction and assignee on the issue were posted by the console
  (`gh api repos/jlapenna/agent-lcars/issues/<N>/reactions` /
  `.../assignees`, timestamped at dispatch-confirm, before the agent job
  started).
- `/task/jlapenna/agent-lcars/<N>` shows the `work.spec` snapshot.
- The PR carries `<!-- attempt-claim:$ATTEMPT_ID -->` and `Fixes #<N>`.
- The outcome comment on the issue was posted by the projection
  (`orchestrator-dispatch.ts`'s `handleReportOutcome`), not the agent.

- [ ] **Step 3: Real-path proof — park under projections**

```bash
gh issue create --repo jlapenna/agent-lcars \
  --title "Sub-project 5 smoke: park under projections" \
  --body "PARK sub-project-5-smoke" \
  --label agent:claude
```

Confirm and record: the `status:needs-human` label and the park comment
both appeared on the issue with no `gh issue edit`/`gh issue comment` call
from inside the agent's own run log — both came from the console
projection (Task 8).

- [ ] **Step 4: Append the runbook section**

Append a new "## Sub-project 5: ingress unification" section to
`docs/native-work-smoke-runbook.md`, following the file's existing format
exactly (contract table, commands used, source-evidence table with real
run URLs/timestamps) — model it on the file's own "Sub-project 3: cron
ingress" section.

- [ ] **Step 5: Commit and push the runbook update**

```bash
git add docs/native-work-smoke-runbook.md
git commit -m "docs: sub-project 5 smoke — ingress unification under control-plane projections

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BiTUeJCQByPUqRLZUpt3CD"
git push
```

## Self-review

**1. Spec coverage.**

- Decision 1 (`Task.work` for every anchor) → Tasks 1–3. `workOriginSchema.
channel` gains `'github'`. The webhook, reply, console-retrigger, and
  console pipeline-reassignment sites are covered (the last added in
  review — `reassignPipeline` already reads the issue for its own label
  swap, so it costs nothing extra); `handleDispatchRequest` (the
  internal-automation `/api/control-plane/request` route) is deliberately
  **not** covered — the spec section and Global Constraints both call this
  out as the plan's one scoped-out derivation site, since its callers
  carry no issue title/body and adding a GitHub read there was not part of
  the binding decisions' named list ("label webhook, reconcile, console
  retrigger"). "Reconcile" in the decision's own wording is satisfied by
  `decide.ts`'s existing carry-forward behavior (no new code — documented
  in the spec section), not by `handleReconcile`/`/api/control-plane/
reconcile` itself, which never derives a fresh `work` payload for
  anything.
- Decision 2 (brief from `work` for every anchor) → Tasks 4–5.
  `GET /runs/{id}/brief` serving GitHub anchors is explicitly deferred as
  a follow-up line, not a task, matching the decision's own "unless
  trivial" carve-out — it is not trivial (sub-project 4 is still in
  flight and its route has no GitHub-anchor consumer today), so it is
  left as a documented follow-up.
- Decision 3 (projections replace issue-side affordances) → Tasks 6–8. One
  deliberate narrowing, documented in both the spec section and here: the
  eyes reaction becomes one post on the issue body at dispatch-confirm
  time, not a byte-identical replay of the agent's former per-comment §2
  behavior (the console has read no comments at that point — there is
  nothing to replay). A second deliberate deviation: `agent-fallback-
finalize.yml`'s "Report and park bootstrap-independent failure" step is
  explicitly **not** gated behind `control-plane-projections` — it is the
  last-resort writer for exactly the case (completion callback never
  reached the control plane) where no console-side projection could have
  run either; gating it would silently drop the maintainer's only signal
  in that failure mode. The literal "remove the finalizer's park comment/
  label step" instruction is satisfied by Task 9's protocol rewrite
  (which stops the agent's own §4 `gh issue edit` call) instead of a
  workflow-YAML deletion, because that agent-driven write — not a
  separate finalizer step — was the actual normal-path writer being
  replaced.
- Decision 4 (protocol collapse; Quick Task ruling) → Task 9 (protocol),
  Task 11 (Quick Task UI + the free-derivation regression). Quick Tasks
  are explicitly not converted to native items (Global Constraints, spec
  section, Task 11's scope note). Fixed in review: the gate is
  `runtime.projections === true || anchor.type === 'work'`, not
  `runtime.projections === true` alone, because a native run's brief may
  reach the agent through sub-project 4's `GET /runs/{id}/brief` route
  instead of `prepare.sh`, and that route has no obligation to stamp
  `runtime.projections`. Also fixed in review: `lane-default-prompt.
test.ts` never reads `agent-protocol.md` at all (it extracts and runs
  `agent-lane.yml`'s own prompt-rendering step), so the protocol doc's own
  section-number/marker pins moved to `tools/contract-tests/
worker-workflow-contract.test.ts`, which already reads that file for an
  unrelated auto-merge-wording assertion; `lane-default-prompt.test.ts`
  instead gained its own, correctly-scoped assertion — the reworded,
  flag-agnostic park clause in `agent-lane.yml`'s rendered default prompt
  (closes #1528, a pre-existing bug the review surfaced: that prompt named
  the issue-mode label/comment/assignee recipe unconditionally, which was
  already wrong for a native dispatch before this sub-project).
- Decision 5 (console minimal; task detail shows `work.spec`) → Task 10.
  No new `/work` filter/tab added, matching "out of scope."
- Decision 6 (no Terraform/IAM/secrets; existing GitHub App client) → every
  task; called out in Global Constraints; Task 7/8's projections reuse
  `getGithubClient()`/`DispatchTokenProvider`/`agentFleetLogin()`, all
  pre-existing.
- Decision 7 (testing) → each task's own Steps 1/2/4; Task 6 covers the
  lane-flag contract tests and `published-actions.contract.test.mjs`
  explicitly.
- Decision 8 (real-path proof, two issues) → Task 12, Steps 2–3, followed
  by the runbook append in Step 4.

**2. Placeholder scan.** No "TBD"/"handle appropriately"/bare "similar to
Task N" left anywhere real code was required. Two places are deliberately
left as _directed research_, not vague placeholders, because they depend
on reading a file this plan's author did not fully transcribe rather than
on an unresolved design question: Task 6 Step 6 ("wherever this repo's
actual invocation... check `ci.yml`") and Task 11 Step 3 ("read
`quick-task-button.tsx` in full before editing"). Both name exactly what
to go find and why; neither hides a design decision.

**3. Type consistency.** `WorkPayload`/`WorkSpec`/`WorkOrigin` names are
used consistently as `@agent-lcars/work`'s typed shapes throughout (Tasks
1–5, 10); the orchestrator's own opaque `WorkPayload` (a bounded
`Record<string, unknown>`, `libs/orchestrator/src/model.ts`) is never
named as a type in this plan's new code — every call site passes a typed
`@agent-lcars/work` literal/value directly into `orchestrator.request({
work })`, exactly mirroring the existing, proven pattern in `work-mint.ts`'s
`mintItem`. `workPayloadFromGithub`/`githubOrigin`/`truncatedDescription`
signatures are identical between Task 1's definition and every later
task's call sites (Tasks 2, 3, 11's regression case).

**4. Guesses this plan makes, listed explicitly (per the task's binding
instruction):**

- **`control-plane-projections` input type.** The binding decision writes
  it as `'true' | 'false'` (string values). This plan makes it a `boolean`
  `workflow_call` input (default `false`), matching the existing
  `dispatch-bootstrap` input's exact shape, rather than inventing a novel
  string-enum input type this codebase does not otherwise use for a
  two-value flag. Downstream, `${{ inputs.control-plane-projections }}`
  renders as the literal string `'true'`/`'false'` in any expression that
  reads it, so every composite-action `with:` passthrough and `if:` guard
  in this plan compares against those same string literals — behaviorally
  identical to what the binding decision describes, differing only in the
  top-level YAML type declaration. Flagged as the plan's one input-shape
  guess.
- **Eyes reaction scope.** Narrowed to one reaction on the issue body at
  dispatch-confirm time (see Self-review point 1, decision 3). The console
  cannot replicate "eyes on every comment the agent has read" because it
  runs before the agent reads anything.
- **`agent-fallback-finalize.yml`'s park step.** Left unconditional, not
  gated by `control-plane-projections` (see Self-review point 1, decision
  3). This is the plan's most consequential deviation from the binding
  decision's literal text, and is why it is called out in three places
  (Global Constraints, the spec section, and here).
- **`handleDispatchRequest` scope.** Explicitly excluded from `work`
  derivation (Self-review point 1, decision 1). If a future sub-project
  wants that path covered too, it needs either an extra GitHub read per
  internal-automation dispatch or a design change to what that route's
  callers send.
- **`retriggerIssue`/`reassignPipeline`'s new `actorLogin` parameter.**
  Appended as the last, optional parameter on both rather than inserted
  earlier, specifically so every existing call site and test that
  constructs a call without it keeps compiling and passing unchanged — a
  guess about minimizing blast radius over API tidiness, consistent with
  this codebase's general pattern of additive-only signature changes (e.g.
  `WorkGrant.scopes?` in the sub-project 4 plan this one was modeled
  against).
- **Task 10's `LogicalWorkCard` exact markup/copy** ("Dispatch brief
  snapshot" label, `lineClamp={3}`) is this plan's own UI judgment call,
  not something the spec or binding decisions specify — the binding
  decision only says the page must show the spec "when present," leaving
  the exact rendering to implementation. Reviewed and adjustable without
  touching the spec.
- **Task 11's exact Quick Task UI diff is intentionally under-specified**
  (Step 3 directs reading the real file rather than guessing its current
  shape) — this plan's author did not read `quick-task-button.tsx` in
  full, since Task 11's actual code-shape risk is low (the component
  already has a receipt/state-badge concept per the design spec's Quick
  Task ruling) relative to the cost of transcribing a file not otherwise
  load-bearing for this plan's other tasks. This is the plan's one
  "closest option, verify against the real file" placement, flagged
  explicitly rather than papered over with invented markup.

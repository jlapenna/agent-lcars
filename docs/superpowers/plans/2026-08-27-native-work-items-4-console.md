# Native Work Items 4: Parked-Work Visibility and Console Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Parked native work is visible on the Bridge; `/work` is a primary destination with a create form; native runs are linked and cancelable on the existing console surfaces (#1530).

**Architecture:** Console-only. The Bridge mounts a server component that reuses the `/work` page's `listItems` server function and the existing `WorkActions`; `/work` gains a client form calling a new `createItem` server function over `workRouter.create`; the agent activity panel and the cancel path learn to read a native run's identity from the dispatch marker's `intentId` (`work:<ulid>/r<n>`).

**Tech Stack:** Next.js app router (server components + server functions via `@orpc/next` `createServerFunctionable`), Mantine, Vitest + Testing Library, Playwright E2E (`apps/console-e2e`, CI only).

**Spec:** `docs/superpowers/specs/2026-08-23-native-work-items-design.md` — section "Sub-project 2: parked-work visibility and console polish".

## Global Constraints

- No new secrets, Terraform, IAM, or runtime env vars. No external notification channel (maintainer ruling 2026-08-27: "we do not need telegram integration").
- `workRouter.create` stays the single create path: grants, live-run cap, and validation are not duplicated in the console.
- The `/work` pages remain session-gated (not admin-gated); the Bridge remains admin-gated (`assertAdmin`).
- Work ids are 26-character Crockford base32 ULIDs (`WORK_ID_RE` in `libs/orchestrator/src/model.ts`): `/^[0-9A-HJKMNP-TV-Z]{26}$/u`.
- Native run ids are `work:<ulid>/r<n>`; the dispatch marker on an Actions run is `[dispatch:g<generation>:<intentId>]` and `intentId` is that run id (`apps/console/src/lib/agent-activity.ts` `attemptMarkerFromDisplayTitle`).
- Console RSC boundary: server-only modules (`@/auth`, `@/lib/orchestrator-runtime`) never import into client components; client components receive server functions as props (the existing `WorkActions` pattern).
- No real git in unit tests. Console E2E is not run locally (paused by maintainer direction, #1049) — CI runs it as a required check.
- Maintainer directive: implementers run the fast layer locally (focused vitest, typecheck of the touched project, prettier), then push; CI carries suites/builds/E2E.
- Every commit carries `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01BiTUeJCQByPUqRLZUpt3CD`.

---

### Task 1: `ulid()` in `@agent-lcars/work` and `workIdFromIntentId`

**Files:**

- Create: `libs/work/src/ulid.ts`, `libs/work/src/ulid.spec.ts`
- Modify: `libs/work/src/index.ts` (export)

**Interfaces:**

- Produces: `ulid(now?: number): string` (26 chars, `WORK_ID_RE`-valid, 10-char time prefix + 16 random chars, browser and Node safe via `globalThis.crypto.getRandomValues`); `workIdFromIntentId(intentId: string): string | undefined` (`work:<ulid>/r<n>` → `<ulid>`, else `undefined`). Task 3 (form) and Task 5 (panel + cancel) consume both.

- [ ] **Step 1: Write the failing tests**

```ts
// libs/work/src/ulid.spec.ts
import { describe, expect, it } from 'vitest';

import { ulid, workIdFromIntentId } from './ulid';

const WORK_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/u;

describe('ulid', () => {
  it('is 26 Crockford base32 characters', () => {
    expect(ulid()).toMatch(WORK_ID_RE);
  });

  it('encodes the time prefix monotonically for later timestamps', () => {
    const earlier = ulid(1_700_000_000_000);
    const later = ulid(1_700_000_000_000 + 60_000);
    expect(later.slice(0, 10) > earlier.slice(0, 10)).toBe(true);
  });

  it('does not repeat across many calls', () => {
    const seen = new Set(Array.from({ length: 1000 }, () => ulid()));
    expect(seen.size).toBe(1000);
  });
});

describe('workIdFromIntentId', () => {
  it('extracts the ulid from a native run id', () => {
    expect(workIdFromIntentId('work:01M107KR3X6VDH7NZ4JDXZNSS2/r3')).toBe(
      '01M107KR3X6VDH7NZ4JDXZNSS2',
    );
  });

  it.each([
    'gh:jlapenna/agent-lcars#12/r1',
    'work:01M107KR3X6VDH7NZ4JDXZNSS2',
    'work:not-a-ulid/r1',
    '',
  ])('returns undefined for %j', (input) => {
    expect(workIdFromIntentId(input)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `./tools/nx test @agent-lcars/work -- ulid` → FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
// libs/work/src/ulid.ts
/** Crockford base32 alphabet (no I, L, O, U) — the same alphabet
 *  `WORK_ID_RE` in `@agent-lcars/orchestrator` accepts. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const NATIVE_RUN_ID_RE = /^work:([0-9A-HJKMNP-TV-Z]{26})\/r\d+$/u;

/**
 * A ULID: 10 time characters (milliseconds since the epoch, base32,
 * most significant first) + 16 random characters. Browser- and Node-safe:
 * only `globalThis.crypto.getRandomValues` is used, so the `/work` create
 * form can mint the idempotency key client-side.
 */
export function ulid(now: number = Date.now()): string {
  let time = now;
  let prefix = '';
  for (let i = 0; i < 10; i += 1) {
    prefix = ALPHABET[time % 32] + prefix;
    time = Math.floor(time / 32);
  }
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let suffix = '';
  for (const byte of bytes) suffix += ALPHABET[byte % 32];
  return prefix + suffix;
}

/** `work:<ulid>/r<n>` (a native orchestrator run id, also the dispatch
 *  marker's `intentId`) → `<ulid>`; anything else → `undefined`. */
export function workIdFromIntentId(intentId: string): string | undefined {
  return NATIVE_RUN_ID_RE.exec(intentId)?.[1];
}
```

Add `export * from './ulid';` to `libs/work/src/index.ts`. (The barrel is CLI-bundle-safe: this module has no server-only imports.)

- [ ] **Step 4: Run** — `./tools/nx test @agent-lcars/work -- ulid` → PASS; `./tools/nx typecheck @agent-lcars/work` → clean.

- [ ] **Step 5: Commit**

```bash
git add libs/work/src/ulid.ts libs/work/src/ulid.spec.ts libs/work/src/index.ts
git commit -m "feat(work): ulid() and workIdFromIntentId helpers

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: `/work` in the primary navigation

**Files:**

- Modify: `apps/console/src/app/console-navigation.ts` (add the destination; drop the "not in destinations" comment)
- Modify: `apps/console/src/app/console-header.test.tsx` (`offers every console destination` list gains `['Work', '/work']`)
- Modify: `apps/console-e2e/src/mobile-header-every-page.spec.ts` (`AUTHENTICATED_VIEWS` gains `{ name: 'Work', path: '/work', current: 'work' }` after Shuttlebay)
- Test: `apps/console/src/app/console-header.test.tsx`

**Interfaces:**

- Consumes: `NavKey` already includes `'work'`; the `/work` pages already pass `current: 'work'` to the page shell.
- Produces: a `CONSOLE_DESTINATIONS` entry `{ key: 'work', href: '/work', label: 'Work', accent: 'violet' }` between `shuttlebay` and `sessions`.

- [ ] **Step 1: Write the failing test** — in `console-header.test.tsx`'s `offers every console destination` case, add `['Work', '/work']` to the expected list in position order (after Shuttlebay), and add:

```tsx
it('marks Work as current on the work pages', () => {
  renderHeader('work');
  expect(
    screen.getByRole('link', { name: 'Work' }).getAttribute('aria-current'),
  ).toBe('page');
});
```

- [ ] **Step 2: Run to verify it fails** — `./tools/nx test @agent-lcars/console -- console-header` → FAIL (no `Work` link).

- [ ] **Step 3: Implement** — in `console-navigation.ts` insert after the Shuttlebay entry:

```ts
  { key: 'work', href: '/work', label: 'Work', accent: 'violet' },
```

and replace the comment block that says `work` has no `CONSOLE_DESTINATIONS` entry with: `// 'work' joined the destinations in sub-project 2; the /work pages set it as current.` Confirm `accent`'s type accepts `'violet'` (`global.css` already styles `[data-accent='violet']`; if the union in `console-navigation.ts` is narrower, add `'violet'` to it).

In `mobile-header-every-page.spec.ts` add to `AUTHENTICATED_VIEWS` after Shuttlebay:

```ts
  { name: 'Work', path: '/work', current: 'work' },
```

(The E2E session has no work grant; `/work` renders the "no grant" text under the shared header, which is all this spec asserts.)

- [ ] **Step 4: Run** — `./tools/nx test @agent-lcars/console -- console-header` → PASS; `./tools/nx typecheck @agent-lcars/console`; `pnpm exec prettier --check` on touched files. CI's E2E is the tablet-width check: if `mobile-header-every-page` fails at 768 px for `/work`, the fix is CSS on `.lcars-nav-pill` (`white-space: nowrap` is fine; the rail must be allowed to wrap — it already is) — report what CI says.

- [ ] **Step 5: Commit and push**

```bash
git add apps/console/src/app/console-navigation.ts apps/console/src/app/console-header.test.tsx apps/console-e2e/src/mobile-header-every-page.spec.ts
git commit -m "feat(console): Work joins the primary navigation

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git push
```

---

### Task 3: Create form on `/work`

**Files:**

- Modify: `apps/console/src/app/work/actions.ts` (add `createItem`)
- Create: `apps/console/src/app/work/work-create-form.tsx`, `apps/console/src/app/work/work-create-form.test.tsx`
- Modify: `apps/console/src/app/work/page.tsx` (mount the form above the list)

**Interfaces:**

- Consumes: `workRouter.create` (input `{ id, spec: { title, description, pipeline, target: { repo } } }`, returns the item view; errors `FORBIDDEN`, `TOO_MANY_REQUESTS`, validation); `ulid()` from Task 1; `PIPELINES` from `@agent-lcars/work`; `controlPlaneRepository()` (`apps/console/src/lib/…` — the same helper `backend-actions.ts` uses) for the default repo string.
- Produces: `createItem(input)` server function (same tuple shape as `cancelItem` — `[error, data]`) and `WorkCreateForm({ create, defaultRepo, pipelines })`.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/console/src/app/work/work-create-form.test.tsx
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { WorkCreateForm } from './work-create-form';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

function renderForm(create = vi.fn()) {
  render(
    <WorkCreateForm
      create={create}
      defaultRepo="jlapenna/agent-lcars"
      pipelines={['claude', 'codex']}
    />,
  );
  return create;
}

describe('WorkCreateForm', () => {
  it('submits { id, spec } with a ulid and navigates to the item', async () => {
    const create = renderForm(
      vi.fn().mockResolvedValue([null, { id: 'X', state: 'running' }]),
    );
    await userEvent.type(screen.getByLabelText('Title'), 'Add healthz');
    await userEvent.type(
      screen.getByLabelText('Description'),
      'Expose /healthz',
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Create work item' }),
    );
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const [input] = create.mock.calls[0];
    expect(input.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/u);
    expect(input.spec).toEqual({
      title: 'Add healthz',
      description: 'Expose /healthz',
      pipeline: 'claude',
      target: { repo: 'jlapenna/agent-lcars' },
    });
    await waitFor(() => expect(push).toHaveBeenCalledWith(`/work/${input.id}`));
  });

  it.each([
    ['FORBIDDEN', 'no grant for that pipeline or repository'],
    ['TOO_MANY_REQUESTS', 'live-run cap reached'],
  ])('renders %s inline', async (code, text) => {
    renderForm(vi.fn().mockResolvedValue([{ code, message: 'x' }, null]));
    await userEvent.type(screen.getByLabelText('Title'), 'T');
    await userEvent.type(screen.getByLabelText('Description'), 'D');
    await userEvent.click(
      screen.getByRole('button', { name: 'Create work item' }),
    );
    expect(await screen.findByText(new RegExp(text))).toBeInTheDocument();
  });
});
```

(Match the repo's Testing Library setup: read `work-actions.test.tsx` for the render helper/provider wrapper and user-event import it uses, and mirror them.)

- [ ] **Step 2: Run to verify it fails** — `./tools/nx test @agent-lcars/console -- work-create-form` → FAIL.

- [ ] **Step 3: Implement**

`actions.ts` — next to the other wrappers:

```ts
const createItemFn = functionable(workRouter.create);

export async function createItem(input: Parameters<typeof createItemFn>[0]) {
  return createItemFn(input);
}
```

`work-create-form.tsx`:

```tsx
'use client';

import { ulid } from '@agent-lcars/work';
import {
  Button,
  Group,
  Select,
  Stack,
  Text,
  TextInput,
  Textarea,
} from '@mantine/core';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

type CreateResult =
  [null, { id: string }] | [{ code: string; message: string }, null];

export type CreateItemAction = (input: {
  id: string;
  spec: {
    title: string;
    description: string;
    pipeline: string;
    target: { repo: string };
  };
}) => Promise<CreateResult>;

const REFUSALS: Record<string, string> = {
  FORBIDDEN:
    'Your grant does not cover that pipeline or repository (no grant for that pipeline or repository).',
  TOO_MANY_REQUESTS:
    'The live-run cap reached; redispatch or cancel a running item first.',
};

/**
 * The `/work` create form. The id is minted client-side so a retried
 * submission is idempotent (the API answers 201 with the existing item);
 * grants, the cap, and validation all live in `workRouter.create`.
 */
export function WorkCreateForm({
  create,
  defaultRepo,
  pipelines,
}: {
  create: CreateItemAction;
  defaultRepo: string;
  pipelines: readonly string[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [repo, setRepo] = useState(defaultRepo);
  const [pipeline, setPipeline] = useState<string>(pipelines[0] ?? 'claude');
  const [error, setError] = useState<string | undefined>();

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(undefined);
    const id = ulid();
    startTransition(async () => {
      const [err] = await create({
        id,
        spec: { title, description, pipeline, target: { repo } },
      });
      if (err) {
        setError(REFUSALS[err.code] ?? err.message);
        return;
      }
      router.push(`/work/${id}`);
    });
  }

  return (
    <form onSubmit={submit} aria-label="Create work item">
      <Stack gap="xs">
        <TextInput
          label="Title"
          required
          maxLength={256}
          value={title}
          onChange={(e) => setTitle(e.currentTarget.value)}
        />
        <Textarea
          label="Description"
          required
          autosize
          minRows={3}
          maxLength={16_384}
          value={description}
          onChange={(e) => setDescription(e.currentTarget.value)}
        />
        <Group grow>
          <TextInput
            label="Repository"
            required
            value={repo}
            onChange={(e) => setRepo(e.currentTarget.value)}
          />
          <Select
            label="Pipeline"
            data={[...pipelines]}
            value={pipeline}
            onChange={(value) => value && setPipeline(value)}
            allowDeselect={false}
          />
        </Group>
        {error ? (
          <Text c="red" size="sm">
            {error}
          </Text>
        ) : null}
        <Group justify="flex-end">
          <Button type="submit" loading={isPending}>
            Create work item
          </Button>
        </Group>
      </Stack>
    </form>
  );
}
```

`page.tsx` — in `WorkBody`, above `<WorkList …/>`, render `<WorkCreateForm create={createItem} defaultRepo={controlPlaneRepositoryKey} pipelines={PIPELINES} />` where the repo key is `owner/name` from the control-plane repository helper (`grep -rn "controlPlaneRepository" apps/console/src/lib | head` — reuse it; do not hardcode). Only render the form when `listItems` succeeded (a user without a grant sees the "no grant" text only).

- [ ] **Step 4: Run** — `./tools/nx test @agent-lcars/console -- work-create-form work-actions` → PASS; `./tools/nx typecheck @agent-lcars/console`; prettier.

- [ ] **Step 5: Commit and push**

```bash
git add apps/console/src/app/work
git commit -m "feat(console): create work items from /work

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git push
```

---

### Task 4: Parked-work panel on the Bridge

**Files:**

- Create: `apps/console/src/app/parked-work-panel.tsx`, `apps/console/src/app/parked-work-panel.test.tsx`
- Modify: `apps/console/src/app/page.tsx` (mount above `AgentActivityPanel`)

**Interfaces:**

- Consumes: `listItems` (server function; `[err, { items }]`), `ItemView` from `@agent-lcars/work/derive`, `WorkActions` + `cancelItem`/`redispatchItem` from `apps/console/src/app/work/…`, `formatRelativeTime` from `./format`.
- Produces: `ParkedWorkPanel({ items })` (pure, server-safe) and `ParkedWork()` (async server component that fetches and renders `ParkedWorkPanel`, or nothing).

- [ ] **Step 1: Write the failing test**

```tsx
// apps/console/src/app/parked-work-panel.test.tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ParkedWorkPanel } from './parked-work-panel';

function item(
  overrides: Partial<{
    id: string;
    state: string;
    title: string;
    updatedAt: string;
    summary: string;
  }>,
) {
  const {
    id = '01M107KR3X6VDH7NZ4JDXZNSS2',
    state = 'parked',
    title = 'T',
    updatedAt = '2026-08-27T04:30:00.000Z',
    summary = 'outcome-gate-failure',
  } = overrides;
  return {
    id,
    state,
    spec: {
      title,
      description: 'd',
      pipeline: 'claude',
      target: { repo: 'jlapenna/agent-lcars' },
    },
    origin: { principal: 'user:jlapenna', channel: 'console' },
    createdAt: updatedAt,
    updatedAt,
    runs: [
      {
        runId: `work:${id}/r1`,
        state: 'finished',
        pipeline: 'claude',
        createdAt: updatedAt,
        updatedAt,
        result: { ok: false, summary },
      },
    ],
    sessions: [],
  };
}

describe('ParkedWorkPanel', () => {
  it('renders nothing when no item is parked', () => {
    const { container } = render(
      <ParkedWorkPanel
        items={[item({ state: 'running' }) as never]}
        cancel={vi.fn()}
        redispatch={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('lists parked items oldest first with a link, the outcome, and actions', () => {
    render(
      <ParkedWorkPanel
        items={[
          item({
            id: '01M107KR3X6VDH7NZ4JDXZNSS3',
            title: 'newer',
            updatedAt: '2026-08-27T05:00:00.000Z',
          }) as never,
          item({
            id: '01M107KR3X6VDH7NZ4JDXZNSS2',
            title: 'older',
            updatedAt: '2026-08-27T04:00:00.000Z',
          }) as never,
          item({ id: '01M107KR3X6VDH7NZ4JDXZNSS4', state: 'done' }) as never,
        ]}
        cancel={vi.fn()}
        redispatch={vi.fn()}
      />,
    );
    const links = screen.getAllByRole('link', { name: /older|newer/ });
    expect(links.map((l) => l.textContent)).toEqual(['older', 'newer']);
    expect(links[0]).toHaveAttribute(
      'href',
      '/work/01M107KR3X6VDH7NZ4JDXZNSS2',
    );
    expect(screen.getAllByText('outcome-gate-failure')).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: /redispatch/i })).toHaveLength(
      2,
    );
    expect(
      screen.getByRole('heading', { name: /Parked work \(2\)/ }),
    ).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `./tools/nx test @agent-lcars/console -- parked-work-panel` → FAIL.

- [ ] **Step 3: Implement**

```tsx
// apps/console/src/app/parked-work-panel.tsx
import type { ItemView } from '@agent-lcars/work/derive';
import { Anchor, Group, Stack, Text, Title } from '@mantine/core';

import { formatRelativeTime } from './format';
import { cancelItem, listItems, redispatchItem } from './work/actions';
import { WorkActions, type WorkAction } from './work/work-actions';

/** Pure renderer: hidden at zero parked items; oldest-parked first. */
export function ParkedWorkPanel({
  items,
  cancel,
  redispatch,
}: {
  items: ItemView[];
  cancel: WorkAction;
  redispatch: WorkAction;
}) {
  const parked = items
    .filter((item) => item.state === 'parked')
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  if (parked.length === 0) return null;
  return (
    <section aria-label="Parked work" data-testid="parked-work-panel">
      <Title order={3} size="h5">
        Parked work ({parked.length})
      </Title>
      <Stack gap="xs" mt="xs">
        {parked.map((item) => {
          const latest = item.runs[item.runs.length - 1];
          return (
            <Group key={item.id} justify="space-between" wrap="wrap" gap="sm">
              <Stack gap={2}>
                <Anchor href={`/work/${item.id}`} size="sm" fw={600}>
                  {item.spec.title}
                </Anchor>
                <Text size="xs" c="dimmed">
                  {item.spec.target.repo} ·{' '}
                  <span>{latest?.result?.summary ?? 'lost'}</span> · parked{' '}
                  {formatRelativeTime(item.updatedAt)}
                </Text>
              </Stack>
              <WorkActions
                id={item.id}
                state={item.state}
                cancel={cancel}
                redispatch={redispatch}
              />
            </Group>
          );
        })}
      </Stack>
    </section>
  );
}

/** Bridge slot: fetches through the same grant-checked server function the
 *  /work page uses; an admin without a work grant sees no panel. */
export async function ParkedWork() {
  const [err, data] = await listItems({ limit: 200 });
  if (err) return null;
  return (
    <ParkedWorkPanel
      items={data.items}
      cancel={cancelItem}
      redispatch={redispatchItem}
    />
  );
}
```

Match `WorkActions`'s real prop names (read `work-actions.tsx`) and keep `ParkedWorkPanel` free of server-only imports if the test environment complains — if so, move `ParkedWork` (the async fetcher) into `page.tsx` and keep the pure panel in its own file.

`page.tsx` — inside `IndexBody`'s returned fragment, before `<AgentActivityPanel …>`:

```tsx
<Suspense fallback={null}>
  <ParkedWork />
</Suspense>
```

- [ ] **Step 4: Run** — `./tools/nx test @agent-lcars/console -- parked-work-panel` → PASS; typecheck; prettier.

- [ ] **Step 5: Commit and push**

```bash
git add apps/console/src/app/parked-work-panel.tsx apps/console/src/app/parked-work-panel.test.tsx apps/console/src/app/page.tsx
git commit -m "feat(console): parked native work on the Bridge

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git push
```

---

### Task 5: Native runs on the existing surfaces (#1530)

**Files:**

- Modify: `apps/console/src/app/agent-activity-panel.tsx` (`actionHref` ~:124 and the anchor `href` ~:411: native attempts link to `/work/<id>`)
- Modify: `apps/console/src/lib/backend-actions.ts` (`notifyReconcileForCancelledRun` ~:463-500, `reflectCancelledRunInOrchestrator` ~:520)
- Test: `apps/console/src/app/agent-activity-panel.test.tsx`, `apps/console/src/lib/backend-actions.test.ts`

**Interfaces:**

- Consumes: `workIdFromIntentId` (Task 1), `attemptMarkerFromDisplayTitle` (`agent-activity.ts`), `ExecutionAttempt.intentId` (`logical-work.ts`).
- Produces: `reflectCancelledRunInOrchestrator(anchor: { issue: number } | { runId: string })`.

- [ ] **Step 1: Write the failing tests**

`agent-activity-panel.test.tsx` — a run with `issueNumber: undefined` and `intentId: 'work:01M107KR3X6VDH7NZ4JDXZNSS2/r1'` (see how the file builds `ExecutionAttempt` fixtures) renders its title as a link to `/work/01M107KR3X6VDH7NZ4JDXZNSS2`, not to `run.url`.

`backend-actions.test.ts` — find the existing cancel-reflection test (grep `reflectCancelledRunInOrchestrator` / `display_title`). Add: with `display_title: 'native work: Claude issue agent [dispatch:g1:work:01M107KR3X6VDH7NZ4JDXZNSS2/r1]'` and `status: 'completed'`, the orchestrator stub's `cancel` is called with `('work:01M107KR3X6VDH7NZ4JDXZNSS2/r1', 'canceled from console')`, `readActiveRun` is not called, and the reconcile handler runs once.

- [ ] **Step 2: Run to verify they fail** — `./tools/nx test @agent-lcars/console -- agent-activity-panel backend-actions` → FAIL.

- [ ] **Step 3: Implement**

`agent-activity-panel.tsx`:

```ts
import { workIdFromIntentId } from '@agent-lcars/work';

function workHrefForRun(run: ExecutionAttempt): string | undefined {
  const workId = run.intentId ? workIdFromIntentId(run.intentId) : undefined;
  return workId ? `/work/${workId}` : undefined;
}
```

In `actionHref` (~~:124): `if (issueNumber === undefined) return workHrefForRun(run);`. At the anchor (~~:411): `href={item?.url ?? issueUrlForRun(run) ?? workHrefForRun(run) ?? run.url}`. If the panel's run type there is `AgentRun` rather than `ExecutionAttempt`, parse the marker from `run.displayTitle` with `attemptMarkerFromDisplayTitle` instead (`marker?.intentId`).

`backend-actions.ts`:

```ts
type CancelAnchor = { issue: number } | { runId: string };

function cancelAnchorFromDisplayTitle(
  displayTitle: string,
): CancelAnchor | undefined {
  const issue = issueNumberFromDisplayTitle(displayTitle);
  if (issue !== undefined) return { issue };
  const marker = attemptMarkerFromDisplayTitle(displayTitle);
  return marker && workIdFromIntentId(marker.intentId)
    ? { runId: marker.intentId }
    : undefined;
}

async function reflectCancelledRunInOrchestrator(
  anchor: CancelAnchor,
): Promise<void> {
  try {
    const { store, orchestrator } = createOrchestratorRuntime();
    const runId =
      'runId' in anchor
        ? anchor.runId
        : (
            await store.readActiveRun({
              repo: controlPlaneRepository(),
              issue: anchor.issue,
            })
          )?.runId;
    if (runId === undefined) return;
    await orchestrator.cancel(runId, 'canceled from console');
  } catch (error) {
    console.error(
      'agent-lcars: failed to reflect the cancelled run into the orchestrator for %j:',
      anchor,
      error,
    );
  }
}
```

In `notifyReconcileForCancelledRun`, replace `anchorNumber` with `anchor ??= cancelAnchorFromDisplayTitle(run.display_title)` and call `reflectCancelledRunInOrchestrator(anchor)` then `notifyReconcile(...)` (change `notifyReconcile`'s parameter to accept the anchor for its log line, or pass `'issue' in anchor ? anchor.issue : anchor.runId`).

- [ ] **Step 4: Run** — both test files PASS; typecheck; prettier.

- [ ] **Step 5: Commit and push**

```bash
git add apps/console/src/app/agent-activity-panel.tsx apps/console/src/app/agent-activity-panel.test.tsx apps/console/src/lib/backend-actions.ts apps/console/src/lib/backend-actions.test.ts
git commit -m "fix(console): link and cancel native runs by their dispatch marker (#1530)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git push
```

---

### Task 6: Land, then the real-path check

- [ ] **Step 1: Land** — PR with `--reviewer jlapenna`; CI green (Verify, E2E incl. `mobile-header-every-page` with `/work`); admin squash-merge when only the unattributed-changes approval rule blocks. Confirm `main`'s CI and the deploy-console rollout.

- [ ] **Step 2: A parked item for real** — `gh workflow run work-create.yml -f action=create -f title='Native work smoke: park' -f description='This is a control-plane smoke. Do not change any file. End your response with: PARK smoke-test — no work requested.' -f repo=jlapenna/agent-lcars -f pipeline=claude`; follow the claude run to completion; `gh workflow run work-create.yml -f action=get -f id=<id>` → `state: parked`, `runs[0].result.ok: false`. The Bridge now shows the panel (unit-tested; the maintainer eyeballs it). Then redispatch is exercised through the API path the panel calls: `POST /items/<id>/redispatch` is not on `work-create.yml`, so add `redispatch` to its `action` choice list in this PR (same shape as `cancel`, accepting `200|409`) and run it; the second run may also park — that is fine, the check is that `runs[1]` appears. Finally `cancel` the item (`200` while parked, then `409`).

- [ ] **Step 3: Record** — append a "Sub-project 2" section to `docs/native-work-smoke-runbook.md` with the item id, run URLs, and the `get` output before/after redispatch; commit on a follow-up branch; PR; merge. Tick sub-project 2 on #1502 and close #1530 with the merge commit.

---

## Self-review

**Spec coverage:** Bridge panel (T4), nav (T2), create form (T3), #1530 attribution + cancel (T5), `ulid`/`workIdFromIntentId` (T1), testing list (each task's Step 1; E2E entry in T2), real path (T6).

**Placeholder scan:** T3 leaves the control-plane-repo helper name to a grep because the exact export differs between `backend-actions.ts` and the work router — bounded to one identifier. T5's `AgentRun` vs `ExecutionAttempt` note gives both concrete branches. T6's `redispatch` workflow action is fully specified by analogy to `cancel` in the same file.

**Type consistency:** `createItem` returns the `[err, data]` tuple like `cancelItem`; `WorkAction` is the type `work-actions.tsx` already exports; `ItemView.updatedAt` is an ISO string (`derive.ts`), so `localeCompare` sorts chronologically.

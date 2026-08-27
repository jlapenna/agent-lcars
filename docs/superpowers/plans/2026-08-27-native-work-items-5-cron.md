# Native Work Items — Plan 5: cron ingress

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An operator declares a cron expression and a spec once; a
scheduled tick mints a native work item for each due slot through the
existing `items.create` path (grants, live-run cap, idempotent minting),
console CRUD for schedules, and one real recurring smoke proven end to
end.

**Architecture:** A new `schedules` resource beside `items`, gated by
`work.operator` for CRUD and a new `work.cron` scope (GitHub Actions OIDC
only) for `POST /schedules/tick`. `mintItem` is extracted from
`items.create`'s body into `apps/console/src/lib/work-mint.ts` so the tick
and the client-driven create share the identical existing-item / cap /
request / drain sequence. A new `libs/orchestrator` `ScheduleStore`
persists schedules exactly as opaquely as `Task.work` persists an item's
payload. A pure, dependency-free `libs/work/src/cron.ts` parses the
5-field UTC grammar and computes each schedule's latest due slot. A new
scheduled workflow (`work-schedules-tick.yml`) calls the tick every 5
minutes with GitHub Actions OIDC, mirroring the existing
`dispatch-reconcile.yml` pattern.

**Tech Stack:** oRPC 2 (contract-first, `@orpc/server`/`@orpc/openapi`),
Zod v4, Next.js app router server functions (`@orpc/next`
`createServerFunctionable`), Firestore (`@google-cloud/firestore`),
GitHub Actions (`workflow_dispatch`/`schedule`, OIDC, the
`request-control-plane` composite action), Vitest.

**Spec:** `docs/superpowers/specs/2026-08-23-native-work-items-design.md`
— "Sub-project 3: cron ingress" (this plan implements that section in
full), plus "Data model", "API", "Auth" for the `items`/`mintItem`
machinery being extracted. Requires sub-project 1 (v1, merged) and
sub-project 2 (console polish, plan 4 —
`docs/superpowers/plans/2026-08-27-native-work-items-4-console.md`)
merged: this plan imports `ulid()` and `workIdFromIntentId` from
`@agent-lcars/work`, added there.

## Global Constraints

- Third-party dependencies are root-only and need Renovate; this plan adds
  none — the cron grammar is hand-written (`libs/work/src/cron.ts`).
- No new Terraform, IAM, secrets, or runtime env vars. The schedule-tick
  OIDC audience is a hardcoded constant in `github-actions-oidc.ts`
  (`agent-lcars-work-schedules`), exactly like the reconciler's and the
  internal-request route's audiences — not an `AGENT_LCARS_*` env var.
- `mintItem` is the single place `items.create` and `schedules.tick` mint
  a native item: no second copy of the existing-item / `CONFLICT` / cap /
  `request` / `drain` sequence.
- `libs/orchestrator` never depends on `libs/work` (unchanged direction);
  `ScheduleStore`'s `spec` field stays an opaque bounded record at the
  store layer, exactly like `Task.work`. `libs/work`'s schedule router is
  what validates it as `workSpecSchema`.
- Work and schedule ids are 26-character Crockford base32 ULIDs
  (`WORK_ID_RE` in `libs/orchestrator/src/model.ts`):
  `/^[0-9A-HJKMNP-TV-Z]{26}$/u`.
- No real git in unit tests. Console E2E is not run locally (paused by
  maintainer direction, #1049) — CI runs it as a required check; this plan
  adds no console E2E spec (the `/work/schedules` page is covered by unit
  tests, matching how plan 4 covered `/work`'s create form).
- Never `--no-verify`. Use a worktree; never touch the primary checkout.
  Implementers run the fast layer locally (focused vitest, typecheck of
  the touched project, `pnpm exec prettier --check`), then push; CI
  carries the Firestore-emulator contract run, the workflow/action tests,
  and the OpenAPI drift check.
- Every commit carries `Co-Authored-By: Claude Fable 5
<noreply@anthropic.com>` and `Claude-Session:
https://claude.ai/code/session_01BiTUeJCQByPUqRLZUpt3CD`.

## File Structure

| File                                                                                                                                 | Responsibility                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| `libs/work/src/cron.ts` (create)                                                                                                     | `parseCron`, `latestDueSlot`, `nextDueSlot`, `slotItemId` — pure, no dependency |
| `libs/orchestrator/src/schedule-store.ts`, `memory-schedule-store.ts`, `firestore-schedule-store.ts` (create)                        | `Schedule` schema, `ScheduleStore` interface, both implementations              |
| `libs/orchestrator/src/store-contract.ts`, `store-contract.spec.ts` (modify)                                                         | `runScheduleStoreContract`, wired for both stores                               |
| `libs/work/src/contract.ts`, `openapi.ts` (modify)                                                                                   | `schedulesContract`; combined OpenAPI generation                                |
| `docs/api/work-v1.openapi.json` (regenerate)                                                                                         | Checked-in, CI-diffed OpenAPI document                                          |
| `apps/console/src/lib/github-actions-oidc.ts` (modify)                                                                               | `assertScheduleTickOidcClaims`/`verifyScheduleTickOidcToken`                    |
| `apps/console/src/lib/work-auth.ts` (modify)                                                                                         | `work.cron` scope; third `authenticateWorkRequest` branch                       |
| `apps/console/src/lib/work-grants.ts` (modify)                                                                                       | `grantForPrincipal` (lookup by canonical principal, not subject)                |
| `apps/console/src/lib/work-mint.ts` (create)                                                                                         | `WorkContext`, `mintItem`, `forbiddenReason`, shared by `items` and `schedules` |
| `apps/console/src/lib/work-router.ts` (modify)                                                                                       | `items` routes on top of `work-mint`; combined `OpenAPIHandler`                 |
| `apps/console/src/lib/schedule-router.ts` (create)                                                                                   | `schedules` routes: create/get/list/enable/disable/tick                         |
| `apps/console/src/lib/orchestrator-runtime.ts` (modify)                                                                              | `createScheduleStore()`                                                         |
| `apps/console/src/app/api/work/v1/[[...rest]]/route.ts` (modify)                                                                     | Context wiring: `scheduleStore`, `grants`, `now`, the OIDC verifier             |
| `apps/console/src/app/work/actions.ts` (modify)                                                                                      | Same context wiring for the server-function path                                |
| `apps/console/src/app/work/page.tsx` (modify)                                                                                        | "Schedules" link                                                                |
| `apps/console/src/app/work/schedules/{page.tsx,actions.ts,schedule-list.tsx,schedule-create-form.tsx,schedule-actions.tsx}` (create) | The `/work/schedules` page                                                      |
| `.github/workflows/work-schedules-tick.yml` (create)                                                                                 | Scheduled tick trigger                                                          |
| `tools/workflow-schedule-tick.test.sh` (create)                                                                                      | Workflow text-assertion test, registered in `ci.yml`                            |
| `.github/workflows/work-create.yml` (modify, land task)                                                                              | `schedule-create`/`schedule-disable` actions for the real-path proof            |
| `docs/native-work-smoke-runbook.md` (modify, land task)                                                                              | The cron smoke's evidence                                                       |

---

### Task 1: Cron grammar and slot minting

**Files:**

- Create: `libs/work/src/cron.ts`
- Create: `libs/work/src/cron.spec.ts`
- Modify: `libs/work/src/index.ts`

**Interfaces:**

- Produces: `parseCron(expr: string): CronSpec` (throws `Error` on a
  malformed expression); `latestDueSlot(spec: CronSpec, now: Date, after?:
Date): Date | undefined`; `nextDueSlot(spec: CronSpec, from: Date,
horizonDays?: number): Date | undefined` (the earliest matching boundary
  `>= from`, searched forward up to `horizonDays` days, default 366);
  `slotItemId(scheduleId: string, slot: Date): Promise<string>` (26-char,
  `WORK_ID_RE`-valid). Consumed by Task 3 (contract's `cron` input
  validation) and Task 5 (`nextDueSlot` rejects a never-firing cron at
  create time; `latestDueSlot`/`slotItemId` drive the tick handler).

- [ ] **Step 1: Write the failing tests**

```ts
// libs/work/src/cron.spec.ts
import { describe, expect, it } from 'vitest';

import { latestDueSlot, nextDueSlot, parseCron, slotItemId } from './cron';

const WORK_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/u;

describe('parseCron', () => {
  it('parses "*" fields as every value in range', () => {
    const spec = parseCron('* * * * *');
    expect(spec.minute.size).toBe(60);
    expect(spec.hour.size).toBe(24);
    expect(spec.dayOfMonth.size).toBe(31);
    expect(spec.month.size).toBe(12);
    expect(spec.dayOfWeek.size).toBe(7);
  });

  it('parses a list', () => {
    expect(
      [...parseCron('0,15,30,45 * * * *').minute].sort((a, b) => a - b),
    ).toEqual([0, 15, 30, 45]);
  });

  it('parses a range', () => {
    expect([...parseCron('0 9-17 * * *').hour].sort((a, b) => a - b)).toEqual([
      9, 10, 11, 12, 13, 14, 15, 16, 17,
    ]);
  });

  it('parses a step', () => {
    expect([...parseCron('*/15 * * * *').minute].sort((a, b) => a - b)).toEqual(
      [0, 15, 30, 45],
    );
  });

  it('parses a ranged step', () => {
    expect([...parseCron('0 8-20/4 * * *').hour].sort((a, b) => a - b)).toEqual(
      [8, 12, 16, 20],
    );
  });

  it.each([
    ['* * * *'],
    ['* * * * * *'],
    ['60 * * * *'],
    ['* 24 * * *'],
    ['x * * * *'],
    ['1-60 * * * *'],
    ['*/0 * * * *'],
  ])('throws on invalid expression "%s"', (expr) => {
    expect(() => parseCron(expr)).toThrow();
  });
});

describe('latestDueSlot', () => {
  it('returns the latest matching minute boundary at or before now', () => {
    const spec = parseCron('*/15 * * * *');
    const now = new Date('2026-08-27T10:22:30.000Z');
    expect(latestDueSlot(spec, now)?.toISOString()).toBe(
      '2026-08-27T10:15:00.000Z',
    );
  });

  it('returns undefined once `after` already covers the latest match', () => {
    const spec = parseCron('*/15 * * * *');
    const now = new Date('2026-08-27T10:22:30.000Z');
    const after = new Date('2026-08-27T10:15:00.000Z');
    expect(latestDueSlot(spec, now, after)).toBeUndefined();
  });

  it('returns the newer slot once now has advanced past it', () => {
    const spec = parseCron('*/15 * * * *');
    const now = new Date('2026-08-27T10:31:00.000Z');
    const after = new Date('2026-08-27T10:15:00.000Z');
    expect(latestDueSlot(spec, now, after)?.toISOString()).toBe(
      '2026-08-27T10:30:00.000Z',
    );
  });

  it('matches an exact minute boundary at now', () => {
    const spec = parseCron('0 * * * *');
    const now = new Date('2026-08-27T11:00:00.000Z');
    expect(latestDueSlot(spec, now)?.toISOString()).toBe(
      '2026-08-27T11:00:00.000Z',
    );
  });
});

describe('slotItemId', () => {
  const slot = new Date('2026-08-27T10:15:00.000Z');

  it('is deterministic for the same schedule and slot, and WORK_ID_RE-valid', async () => {
    const a = await slotItemId('01J5Z3K9QX8F0N2B4V6C8D1E3G', slot);
    const b = await slotItemId('01J5Z3K9QX8F0N2B4V6C8D1E3G', slot);
    expect(a).toBe(b);
    expect(a).toMatch(WORK_ID_RE);
  });

  it('differs for a different schedule or a different slot', async () => {
    const a = await slotItemId('01J5Z3K9QX8F0N2B4V6C8D1E3G', slot);
    const b = await slotItemId('01J5Z3K9QX8F0N2B4V6C8D1E3H', slot);
    const c = await slotItemId(
      '01J5Z3K9QX8F0N2B4V6C8D1E3G',
      new Date('2026-08-27T10:30:00.000Z'),
    );
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });

  it("encodes the slot time as the id's 10-char prefix", async () => {
    const id = await slotItemId('01J5Z3K9QX8F0N2B4V6C8D1E3G', slot);
    const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    let t = slot.getTime();
    let prefix = '';
    for (let i = 0; i < 10; i += 1) {
      prefix = ALPHABET[t % 32] + prefix;
      t = Math.floor(t / 32);
    }
    expect(id.slice(0, 10)).toBe(prefix);
  });
});

describe('field combination is ANDed, not POSIX dom-OR-dow', () => {
  it('matches only when day-of-month AND day-of-week both hold (pinning test)', () => {
    const spec = parseCron('0 0 1 * 1'); // the 1st, only when it is a Monday
    // 2026-06-01 is a Monday: dom=1 and dow=Monday both hold.
    expect(
      latestDueSlot(spec, new Date('2026-06-01T00:10:00.000Z'))?.toISOString(),
    ).toBe('2026-06-01T00:00:00.000Z');
    // Every day in (2026-08-01, 2026-09-02] either has dom=1 (2026-09-01,
    // a Tuesday) or dow=Monday (2026-08-03/10/17/24/31), never both. POSIX
    // cron ORs dom and dow when both are restricted, so it would fire on
    // any of them; this grammar ANDs every field, so none matches.
    expect(
      latestDueSlot(
        spec,
        new Date('2026-09-02T00:00:00.000Z'),
        new Date('2026-08-01T00:00:00.000Z'),
      ),
    ).toBeUndefined();
  });
});

describe('nextDueSlot', () => {
  it('returns the earliest matching boundary at or after `from`', () => {
    const spec = parseCron('*/15 * * * *');
    const from = new Date('2026-08-27T10:22:30.000Z');
    expect(nextDueSlot(spec, from)?.toISOString()).toBe(
      '2026-08-27T10:30:00.000Z',
    );
  });

  it('returns `from` itself when it already matches', () => {
    const spec = parseCron('0 * * * *');
    const from = new Date('2026-08-27T11:00:00.000Z');
    expect(nextDueSlot(spec, from)?.toISOString()).toBe(
      '2026-08-27T11:00:00.000Z',
    );
  });

  it('returns undefined for an expression that can never fire within the horizon', () => {
    // No February has a 31st -- dom=31 and month=2 can never both hold.
    const spec = parseCron('0 0 31 2 *');
    expect(
      nextDueSlot(spec, new Date('2026-08-27T10:00:00.000Z')),
    ).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `./tools/nx test @agent-lcars/work -- cron` → FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
// libs/work/src/cron.ts
/**
 * A 5-field cron expression (`min hour dom mon dow`), UTC only, minute
 * granularity. No third-party dependency: third-party deps in this repo
 * are root-only and need Renovate (AGENTS.md), and this grammar is small
 * enough not to need one.
 */

interface FieldSpec {
  readonly min: number;
  readonly max: number;
}

const FIELDS: readonly FieldSpec[] = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // day of month
  { min: 1, max: 12 }, // month
  { min: 0, max: 6 }, // day of week (0 = Sunday)
];

export interface CronSpec {
  readonly minute: ReadonlySet<number>;
  readonly hour: ReadonlySet<number>;
  readonly dayOfMonth: ReadonlySet<number>;
  readonly month: ReadonlySet<number>;
  readonly dayOfWeek: ReadonlySet<number>;
}

/** Parses one cron field ('*', a list 'a,b,c', a range 'a-b', or a step
 *  '*\/n' or 'a-b/n') into the set of matching values within
 *  [spec.min, spec.max]. Throws on anything else -- an invalid cron
 *  expression is a caller bug (a malformed schedule), not a runtime
 *  condition to degrade through. */
function parseField(raw: string, spec: FieldSpec): Set<number> {
  const values = new Set<number>();
  for (const part of raw.split(',')) {
    const stepMatch = /^(\*|\d+-\d+)\/(\d+)$/u.exec(part);
    const rangeText = stepMatch ? (stepMatch[1] ?? '*') : part;
    const stepText = stepMatch ? stepMatch[2] : undefined;
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step <= 0) {
      throw new Error(`invalid cron step in "${part}"`);
    }

    let lo: number;
    let hi: number;
    if (rangeText === '*') {
      lo = spec.min;
      hi = spec.max;
    } else {
      const rangeMatch = /^(\d+)(?:-(\d+))?$/u.exec(rangeText);
      if (rangeMatch === null) {
        throw new Error(`invalid cron field "${part}"`);
      }
      lo = Number(rangeMatch[1]);
      hi = rangeMatch[2] === undefined ? lo : Number(rangeMatch[2]);
    }
    if (lo > hi || lo < spec.min || hi > spec.max) {
      throw new Error(
        `cron field "${part}" out of range [${spec.min}, ${spec.max}]`,
      );
    }
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return values;
}

/** Parses a 5-field UTC cron expression. Throws `Error` when the
 *  expression is not exactly 5 whitespace-separated fields, or any field
 *  is malformed or out of range. */
export function parseCron(expr: string): CronSpec {
  const fields = expr.trim().split(/\s+/u);
  if (fields.length !== 5) {
    throw new Error(
      `cron expression must have 5 fields, got ${fields.length}: "${expr}"`,
    );
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields.map((field, i) =>
    parseField(field as string, FIELDS[i] as FieldSpec),
  );
  return {
    minute: minute as Set<number>,
    hour: hour as Set<number>,
    dayOfMonth: dayOfMonth as Set<number>,
    month: month as Set<number>,
    dayOfWeek: dayOfWeek as Set<number>,
  };
}

/** All five fields are ANDed: a date matches only when minute, hour,
 *  day-of-month, month, AND day-of-week all hold simultaneously. This is
 *  deliberately not POSIX cron's special case, where restricting both
 *  day-of-month and day-of-week ORs them instead ("the 1st, OR any
 *  Friday"). ANDing is simpler to reason about and to test (see
 *  `cron.spec.ts`'s "field combination is ANDed" pinning test), at the
 *  cost of the rare intentionally-POSIX expression not being
 *  expressible -- acceptable for a fleet-internal scheduler. */
function matchesSpec(spec: CronSpec, date: Date): boolean {
  return (
    spec.minute.has(date.getUTCMinutes()) &&
    spec.hour.has(date.getUTCHours()) &&
    spec.dayOfMonth.has(date.getUTCDate()) &&
    spec.month.has(date.getUTCMonth() + 1) &&
    spec.dayOfWeek.has(date.getUTCDay())
  );
}

/** Bounds the backward walk below at just over a year of minutes, so a
 *  legitimate low-frequency cron (e.g. monthly, yearly) is still found,
 *  while a search that somehow never matches cannot loop forever. */
const MAX_LOOKBACK_MINUTES = 366 * 24 * 60;

/**
 * The latest minute boundary `<= now` that matches `spec` and is strictly
 * after `after` (a schedule's `lastSlotAt`, or `undefined` for "never
 * ticked"). Walks backward one minute at a time. Returns `undefined` when
 * no due slot exists in that window -- either every match so far is at or
 * before `after`, or (practically impossible for a valid 5-field
 * expression) nothing matched within {@link MAX_LOOKBACK_MINUTES}.
 */
export function latestDueSlot(
  spec: CronSpec,
  now: Date,
  after?: Date,
): Date | undefined {
  const cursor = new Date(now);
  cursor.setUTCSeconds(0, 0);
  const lowerBound = after === undefined ? undefined : after.getTime();

  for (let step = 0; step < MAX_LOOKBACK_MINUTES; step += 1) {
    if (lowerBound !== undefined && cursor.getTime() <= lowerBound) {
      return undefined;
    }
    if (matchesSpec(spec, cursor)) return new Date(cursor);
    cursor.setUTCMinutes(cursor.getUTCMinutes() - 1);
  }
  return undefined;
}

/** Default horizon for {@link nextDueSlot}: a year of forward search is
 *  enough to catch every legitimate low-frequency cron (monthly, yearly)
 *  while still bounding an impossible expression's cost to one walk, done
 *  once at create time rather than paid by every tick forever. */
const DEFAULT_HORIZON_DAYS = 366;

/**
 * The earliest minute boundary `>= from` that matches `spec`, searching
 * forward up to `horizonDays` days (default {@link DEFAULT_HORIZON_DAYS}).
 * Used only at schedule-create time to reject a cron expression that can
 * never fire -- e.g. `0 0 31 2 *` (no February has a 31st) parses cleanly
 * under this grammar's field-by-field validation but never matches any
 * real date. Returns `undefined` when nothing matches within the horizon.
 */
export function nextDueSlot(
  spec: CronSpec,
  from: Date,
  horizonDays = DEFAULT_HORIZON_DAYS,
): Date | undefined {
  const cursor = new Date(from);
  cursor.setUTCSeconds(0, 0);
  const maxSteps = horizonDays * 24 * 60;

  for (let step = 0; step < maxSteps; step += 1) {
    if (matchesSpec(spec, cursor)) return new Date(cursor);
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }
  return undefined;
}

/** Crockford base32 (no I, L, O, U) -- the same alphabet
 *  `WORK_ID_PATTERN` (`contract.ts`) and the orchestrator's `WORK_ID_RE`
 *  accept. Kept local rather than imported from `./ulid`: this module has
 *  no dependency on that file, and nothing else in `libs/work` needs a
 *  Crockford encoder today. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function crockfordTimePrefix(epochMs: number): string {
  let time = epochMs;
  let prefix = '';
  for (let i = 0; i < 10; i += 1) {
    prefix = ALPHABET[time % 32] + prefix;
    time = Math.floor(time / 32);
  }
  return prefix;
}

/**
 * A deterministic work item id for one schedule's due slot: the 10-char
 * Crockford time prefix of `slot.getTime()` (so it sorts and reads like
 * every other ULID) followed by 16 Crockford characters derived from
 * `sha256(scheduleId + ':' + slot.toISOString())`. Retrying the same slot
 * (a re-tick before `lastSlotAt` advances, or a replay) always produces
 * the same id, so minting it is idempotent for free -- the second call
 * hits the item the first mint already created instead of starting a
 * second run. Uses Web Crypto (`globalThis.crypto.subtle`), available in
 * both Node 20+ and the browser, so this stays free of a server-only or
 * Node-only dependency, like every other export of this library.
 */
export async function slotItemId(
  scheduleId: string,
  slot: Date,
): Promise<string> {
  const material = `${scheduleId}:${slot.toISOString()}`;
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(material),
  );
  const bytes = new Uint8Array(digest).slice(0, 16);
  let suffix = '';
  for (const byte of bytes) suffix += ALPHABET[byte % 32];
  return crockfordTimePrefix(slot.getTime()) + suffix;
}
```

Add `export * from './cron';` to `libs/work/src/index.ts` (alongside the
existing `contract`/`openapi`/`spec` exports).

- [ ] **Step 4: Run** — `./tools/nx test @agent-lcars/work -- cron` → PASS; `./tools/nx typecheck @agent-lcars/work` → clean.

- [ ] **Step 5: Commit**

```bash
git add libs/work/src/cron.ts libs/work/src/cron.spec.ts libs/work/src/index.ts
git commit -m "feat(work): cron grammar and deterministic slot minting

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BiTUeJCQByPUqRLZUpt3CD"
```

---

### Task 2: `ScheduleStore` in `libs/orchestrator`

**Files:**

- Create: `libs/orchestrator/src/schedule-store.ts`
- Create: `libs/orchestrator/src/memory-schedule-store.ts`
- Create: `libs/orchestrator/src/firestore-schedule-store.ts`
- Modify: `libs/orchestrator/src/store-contract.ts` (add `runScheduleStoreContract`)
- Modify: `libs/orchestrator/src/store-contract.spec.ts` (wire both stores)
- Modify: `libs/orchestrator/src/index.ts` (exports)

**Interfaces:**

- Produces: `Schedule` type and `scheduleSchema`; `ScheduleStore` with
  `readSchedule(scheduleId): Promise<Schedule | undefined>`,
  `writeSchedule(schedule): Promise<void>`,
  `listSchedules(limit?): Promise<Schedule[]>`,
  `listEnabledSchedules(): Promise<Schedule[]>`; `MemoryScheduleStore`,
  `FirestoreScheduleStore` (+ `FirestoreScheduleStoreOptions`). Consumed
  by Task 5's `WorkContext.scheduleStore` and `orchestrator-runtime.ts`.

- [ ] **Step 1: Write the failing contract**

```ts
// libs/orchestrator/src/store-contract.ts -- append, after the existing
// `runOrchestratorStoreContract` function and its imports. Add to the
// import list at the top of the file:
//   import type { Schedule, ScheduleStore } from './schedule-store';

const SCHEDULE_T0 = '2026-08-15T12:00:00.000Z';

/**
 * Behavioural contract every `ScheduleStore` implementation must satisfy,
 * parallel to {@link runOrchestratorStoreContract} but for schedules,
 * which have no mutex and no version guard -- see `schedule-store.ts`'s
 * `writeSchedule` doc for why last-write-wins is acceptable here.
 */
export function runScheduleStoreContract(
  name: string,
  makeStore: () => ScheduleStore | Promise<ScheduleStore>,
): void {
  describe(`ScheduleStore contract: ${name}`, () => {
    function schedule(over: Partial<Schedule> = {}): Schedule {
      return {
        scheduleId: '01J5Z3K9QX8F0N2B4V6C8D1E3G',
        cron: '*/15 * * * *',
        spec: { title: 't' },
        enabled: true,
        createdBy: 'user:jlapenna',
        createdAt: SCHEDULE_T0,
        updatedAt: SCHEDULE_T0,
        ...over,
      };
    }

    it('round-trips a written schedule', async () => {
      const store = await makeStore();
      await store.writeSchedule(schedule());
      expect(await store.readSchedule('01J5Z3K9QX8F0N2B4V6C8D1E3G')).toEqual(
        schedule(),
      );
    });

    it('reads undefined for an unknown schedule', async () => {
      const store = await makeStore();
      expect(await store.readSchedule('missing')).toBeUndefined();
    });

    it('overwrites on a second write (last write wins)', async () => {
      const store = await makeStore();
      await store.writeSchedule(schedule());
      await store.writeSchedule(schedule({ enabled: false }));
      expect(
        (await store.readSchedule('01J5Z3K9QX8F0N2B4V6C8D1E3G'))?.enabled,
      ).toBe(false);
    });

    it('lists newest first and honors a limit', async () => {
      const store = await makeStore();
      const ids = [
        '01J5Z3K9QX8F0N2B4V6C8D1E3A',
        '01J5Z3K9QX8F0N2B4V6C8D1E3B',
        '01J5Z3K9QX8F0N2B4V6C8D1E3C',
      ];
      for (const scheduleId of ids) {
        await store.writeSchedule(schedule({ scheduleId }));
      }
      expect((await store.listSchedules()).map((s) => s.scheduleId)).toEqual(
        [...ids].reverse(),
      );
      expect((await store.listSchedules(2)).map((s) => s.scheduleId)).toEqual([
        '01J5Z3K9QX8F0N2B4V6C8D1E3C',
        '01J5Z3K9QX8F0N2B4V6C8D1E3B',
      ]);
    });

    it('lists only enabled schedules', async () => {
      const store = await makeStore();
      await store.writeSchedule(
        schedule({ scheduleId: '01J5Z3K9QX8F0N2B4V6C8D1E3D', enabled: true }),
      );
      await store.writeSchedule(
        schedule({
          scheduleId: '01J5Z3K9QX8F0N2B4V6C8D1E3E',
          enabled: false,
        }),
      );
      expect(
        (await store.listEnabledSchedules()).map((s) => s.scheduleId),
      ).toEqual(['01J5Z3K9QX8F0N2B4V6C8D1E3D']);
    });
  });
}
```

```ts
// libs/orchestrator/src/store-contract.spec.ts -- add alongside the
// existing MemoryStore/FirestoreStore wiring
import { FirestoreScheduleStore } from './firestore-schedule-store';
import { MemoryScheduleStore } from './memory-schedule-store';
import { runScheduleStoreContract } from './store-contract';

runScheduleStoreContract(
  'MemoryScheduleStore',
  () => new MemoryScheduleStore(),
);

// ...inside the existing `describe.skipIf(emulatorHost === undefined)`
// block that already runs `runOrchestratorStoreContract('FirestoreStore', ...)`,
// add a second call sharing the same prefixCounter:
runScheduleStoreContract('FirestoreScheduleStore', () => {
  prefixCounter += 1;
  return new FirestoreScheduleStore({
    projectId: 'demo-orchestrator',
    databaseId: '(default)',
    collectionPrefix: `orchestrator-test-${Date.now()}-${prefixCounter}-`,
    emulatorHost: emulatorHost ?? 'localhost:8080',
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `./tools/nx test @agent-lcars/orchestrator -- store-contract` → FAIL (modules not found).

- [ ] **Step 3: Implement**

```ts
// libs/orchestrator/src/schedule-store.ts
import { z } from 'zod';

import { WORK_ID_RE } from './model';

const isoUtc = z.iso.datetime({ offset: false });

/** Same bound `Task.work` uses (`WORK_PAYLOAD_MAX_BYTES` in `model.ts`) --
 *  a schedule's `spec` is exactly a `WorkSpec`, minted on every due slot,
 *  so it must fit inside the same budget a one-shot item's payload does. */
export const SCHEDULE_SPEC_MAX_BYTES = 32_768;

export const scheduleSchema = z.strictObject({
  scheduleId: z.string().regex(WORK_ID_RE),
  /** 5-field UTC cron expression; opaque here -- `@agent-lcars/work`'s
   *  `parseCron` is what interprets it. Bounded generously above any
   *  legal expression. */
  cron: z.string().min(1).max(64),
  /** A `WorkSpec`, opaque at this layer exactly as `Task.work.spec` is --
   *  see `model.ts`'s `workPayloadSchema` for the identical pattern.
   *  `@agent-lcars/work`'s schedule router parses it with `workSpecSchema`
   *  on every read and write. */
  spec: z
    .record(z.string().max(64), z.unknown())
    .refine(
      (value) =>
        new TextEncoder().encode(JSON.stringify(value)).length <=
        SCHEDULE_SPEC_MAX_BYTES,
      { message: `schedule spec exceeds ${SCHEDULE_SPEC_MAX_BYTES} bytes` },
    ),
  enabled: z.boolean(),
  /** LCARS-native principal that created the schedule -- the identity
   *  grants are checked against at every tick, never the tick caller's
   *  own `cron:tick` identity, which has no grant of its own. */
  createdBy: z.string().min(1).max(128),
  createdAt: isoUtc,
  updatedAt: isoUtc,
  /** The latest due slot a tick has already minted for. Absent means
   *  "never ticked". */
  lastSlotAt: isoUtc.optional(),
  lastItemId: z.string().regex(WORK_ID_RE).optional(),
  /** Set by a tick that auto-disables the schedule once its creator's
   *  grant no longer covers it ('grant-revoked'), or by the operator
   *  disable route ('operator'). */
  disabledReason: z.enum(['grant-revoked', 'operator']).optional(),
});
export type Schedule = z.infer<typeof scheduleSchema>;

/**
 * Durability boundary for schedules, parallel to `OrchestratorStore` but
 * deliberately a separate interface: a schedule is not a `Task`, has no
 * mutex, and the tick's read/mint/write-back cycle needs nothing an
 * `OrchestratorStore` implementation provides.
 */
export interface ScheduleStore {
  readSchedule(scheduleId: string): Promise<Schedule | undefined>;
  /** Create-or-replace. No version/updatedAt guard -- every writer
   *  (create, enable/disable, a tick's `lastSlotAt` advance) starts from
   *  its own `readSchedule` in the same request, and a schedule is
   *  configuration plus a watermark, not a mutex over live work. */
  writeSchedule(schedule: Schedule): Promise<void>;
  /** Newest first -- `scheduleId` is a ULID, so descending lexicographic
   *  order on it is descending creation order (matches
   *  `OrchestratorStore.listNativeTasks`). */
  listSchedules(limit?: number): Promise<Schedule[]>;
  listEnabledSchedules(): Promise<Schedule[]>;
}
```

```ts
// libs/orchestrator/src/memory-schedule-store.ts
import type { Schedule, ScheduleStore } from './schedule-store';

/** Reference implementation; also the test double. */
export class MemoryScheduleStore implements ScheduleStore {
  readonly #schedules = new Map<string, Schedule>();

  async readSchedule(scheduleId: string): Promise<Schedule | undefined> {
    return structuredClone(this.#schedules.get(scheduleId));
  }

  async writeSchedule(schedule: Schedule): Promise<void> {
    this.#schedules.set(schedule.scheduleId, structuredClone(schedule));
  }

  async listSchedules(limit?: number): Promise<Schedule[]> {
    const all = [...this.#schedules.values()].sort((a, b) =>
      b.scheduleId.localeCompare(a.scheduleId),
    );
    return structuredClone(all.slice(0, limit ?? 200));
  }

  async listEnabledSchedules(): Promise<Schedule[]> {
    return structuredClone(
      [...this.#schedules.values()].filter((s) => s.enabled),
    );
  }
}
```

```ts
// libs/orchestrator/src/firestore-schedule-store.ts
import {
  type CollectionReference,
  type DocumentReference,
  Firestore,
} from '@google-cloud/firestore';

import {
  type Schedule,
  scheduleSchema,
  type ScheduleStore,
} from './schedule-store';

export interface FirestoreScheduleStoreOptions {
  readonly projectId: string;
  readonly databaseId: string;
  /** Defaults to `orchestrator-`, matching `FirestoreStore` -- the
   *  collection is `<prefix>schedules`, alongside `<prefix>tasks`,
   *  `<prefix>runs`, `<prefix>outbox`. */
  readonly collectionPrefix?: string;
  readonly emulatorHost?: string;
}

export class FirestoreScheduleStore implements ScheduleStore {
  readonly #firestore: Firestore;
  readonly #schedules: CollectionReference;

  constructor(options: FirestoreScheduleStoreOptions) {
    const prefix = options.collectionPrefix ?? 'orchestrator-';
    this.#firestore = new Firestore({
      projectId: options.projectId,
      databaseId: options.databaseId,
      ...(options.emulatorHost === undefined
        ? {}
        : { host: options.emulatorHost, ssl: false }),
    });
    this.#schedules = this.#firestore.collection(`${prefix}schedules`);
  }

  async readSchedule(scheduleId: string): Promise<Schedule | undefined> {
    const snapshot = await this.#ref(scheduleId).get();
    return snapshot.exists ? scheduleSchema.parse(snapshot.data()) : undefined;
  }

  async writeSchedule(schedule: Schedule): Promise<void> {
    await this.#ref(schedule.scheduleId).set(schedule);
  }

  async listSchedules(limit?: number): Promise<Schedule[]> {
    const snapshot = await this.#schedules
      .orderBy('scheduleId', 'desc')
      .limit(limit ?? 200)
      .get();
    return snapshot.docs.map((doc) => scheduleSchema.parse(doc.data()));
  }

  async listEnabledSchedules(): Promise<Schedule[]> {
    const snapshot = await this.#schedules.where('enabled', '==', true).get();
    return snapshot.docs.map((doc) => scheduleSchema.parse(doc.data()));
  }

  #ref(scheduleId: string): DocumentReference {
    return this.#schedules.doc(encodeURIComponent(scheduleId));
  }
}
```

In `libs/orchestrator/src/index.ts`, add:

```ts
export {
  FirestoreScheduleStore,
  type FirestoreScheduleStoreOptions,
} from './firestore-schedule-store';
export { MemoryScheduleStore } from './memory-schedule-store';
export * from './schedule-store';
```

- [ ] **Step 4: Run** — `./tools/nx test @agent-lcars/orchestrator -- store-contract` → PASS (MemoryScheduleStore cases; the FirestoreScheduleStore describe block is `skipIf` with no emulator locally). `./tools/nx typecheck @agent-lcars/orchestrator` → clean.

- [ ] **Step 5: Commit**

```bash
git add libs/orchestrator/src/schedule-store.ts libs/orchestrator/src/memory-schedule-store.ts libs/orchestrator/src/firestore-schedule-store.ts libs/orchestrator/src/store-contract.ts libs/orchestrator/src/store-contract.spec.ts libs/orchestrator/src/index.ts
git commit -m "feat(orchestrator): ScheduleStore, memory and Firestore implementations

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BiTUeJCQByPUqRLZUpt3CD"
git push -u origin HEAD
```

---

### Task 3: `schedulesContract` and OpenAPI regeneration

**Files:**

- Modify: `libs/work/src/contract.ts`
- Modify: `libs/work/src/openapi.ts`
- Modify: `libs/work/src/contract.spec.ts`
- Regenerate: `docs/api/work-v1.openapi.json`

**Interfaces:**

- Produces: `schedulesContract` with procedures `create`, `get`, `list`,
  `enable`, `disable`, `tick` (paths `/schedules`, `/schedules/{id}`,
  `/schedules/{id}/enable`, `/schedules/{id}/disable`,
  `/schedules/tick`); `generateWorkOpenApi()` emits both `/items/*` and
  `/schedules/*`. Consumed by Task 5's `schedule-router.ts`
  (`implement(schedulesContract)`).

- [ ] **Step 1: Write the failing tests**

```ts
// libs/work/src/contract.spec.ts -- add these two blocks; extend the
// existing `generateWorkOpenApi` describe block's two `it`s as shown.
import { schedulesContract } from './contract'; // add to the existing import

describe('schedulesContract', () => {
  it('declares the six schedule procedures', () => {
    expect(Object.keys(schedulesContract).sort()).toEqual([
      'create',
      'disable',
      'enable',
      'get',
      'list',
      'tick',
    ]);
  });
});

describe('generateWorkOpenApi', () => {
  it('emits both the items and schedules REST routes with bearer security', async () => {
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
      '/schedules',
      '/schedules/tick',
      '/schedules/{id}',
      '/schedules/{id}/disable',
      '/schedules/{id}/enable',
    ]);
    expect(doc.components.securitySchemes).toHaveProperty('bearerAuth');
  });

  it('documents every status each route can actually answer with', async () => {
    const doc = (await generateWorkOpenApi()) as {
      paths: Record<
        string,
        Record<string, { responses: Record<string, unknown> }>
      >;
    };
    const statuses = Object.fromEntries(
      Object.entries(doc.paths).flatMap(([path, methods]) =>
        Object.entries(methods).map(([method, operation]) => [
          `${method.toUpperCase()} ${path}`,
          Object.keys(operation.responses).sort(),
        ]),
      ),
    );

    expect(statuses).toEqual({
      'PUT /items/{id}': ['201', '403', '409', '429'],
      'GET /items/{id}': ['200', '404'],
      'GET /items': ['200'],
      'POST /items/{id}/cancel': ['200', '404', '409'],
      'POST /items/{id}/redispatch': ['200', '403', '404', '409', '429'],
      'PUT /schedules/{id}': ['201', '400', '403', '409'],
      'GET /schedules/{id}': ['200', '404'],
      'GET /schedules': ['200'],
      'POST /schedules/{id}/enable': ['200', '404'],
      'POST /schedules/{id}/disable': ['200', '404'],
      'POST /schedules/tick': ['200'],
    });
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `./tools/nx test @agent-lcars/work -- contract` → FAIL (`schedulesContract` not found).

- [ ] **Step 3: Implement**

```ts
// libs/work/src/contract.ts -- add near the top, after the existing
// imports:
import { parseCron } from './cron';

// -- add after `itemsContract`'s closing `};` and its `export type
// ItemsContract`:

/** A `cron` field is only accepted once it parses: `parseCron` throws on
 *  anything malformed, so a bad expression is refused at the API's input
 *  validation boundary (400) rather than reaching the store. */
const cronExpressionSchema = z
  .string()
  .min(1)
  .max(64)
  .refine(
    (value) => {
      try {
        parseCron(value);
        return true;
      } catch {
        return false;
      }
    },
    { message: 'must be a valid 5-field UTC cron expression' },
  );

const scheduleViewSchema = z.strictObject({
  id: workIdSchema,
  cron: z.string(),
  spec: workSpecSchema,
  enabled: z.boolean(),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastSlotAt: z.string().optional(),
  lastItemId: workIdSchema.optional(),
  disabledReason: z.enum(['grant-revoked', 'operator']).optional(),
});

const scheduleBase = oc.meta(
  openapi({ tags: ['schedules'], spec: withBearer }),
);

export const schedulesContract = {
  create: scheduleBase
    .meta(
      openapi({
        method: 'PUT',
        path: '/schedules/{id}',
        operationId: 'createSchedule',
        summary: 'Create a cron schedule (idempotent by client ULID)',
        successStatus: 201,
        successDescription:
          'Created. A replay of the same id, cron, and spec returns the existing schedule.',
      }),
    )
    .errors({
      FORBIDDEN: { message: 'Principal may not request this pipeline' },
      CONFLICT: {
        message: 'Schedule exists with a different cron or spec',
      },
      // Declared explicitly (rather than left to oRPC's automatic 400 on
      // a zod input-validation failure) so the generated OpenAPI document
      // lists 400 for this route -- see `contract.spec.ts`'s "documents
      // every status" test. The router's create handler (Task 5) also
      // throws this explicitly for the one case zod's `cronExpressionSchema`
      // cannot catch: a syntactically valid cron that never fires.
      BAD_REQUEST: { message: 'Malformed cron expression' },
    })
    .input(
      z.strictObject({
        id: workIdSchema,
        cron: cronExpressionSchema,
        spec: workSpecSchema,
        enabled: z.boolean().optional(),
      }),
    )
    .output(scheduleViewSchema),
  get: scheduleBase
    .meta(
      openapi({
        method: 'GET',
        path: '/schedules/{id}',
        operationId: 'getSchedule',
        summary: 'Read a cron schedule',
      }),
    )
    .errors({ NOT_FOUND: { message: 'No such schedule' } })
    .input(z.strictObject({ id: workIdSchema }))
    .output(scheduleViewSchema),
  list: scheduleBase
    .meta(
      openapi({
        method: 'GET',
        path: '/schedules',
        operationId: 'listSchedules',
        summary: 'List cron schedules',
      }),
    )
    .input(
      z.strictObject({
        limit: z.coerce.number().int().min(1).max(200).default(50),
      }),
    )
    .output(z.strictObject({ schedules: z.array(scheduleViewSchema) })),
  enable: scheduleBase
    .meta(
      openapi({
        method: 'POST',
        path: '/schedules/{id}/enable',
        operationId: 'enableSchedule',
        summary: 'Enable a cron schedule',
      }),
    )
    .errors({ NOT_FOUND: { message: 'No such schedule' } })
    .input(z.strictObject({ id: workIdSchema }))
    .output(scheduleViewSchema),
  disable: scheduleBase
    .meta(
      openapi({
        method: 'POST',
        path: '/schedules/{id}/disable',
        operationId: 'disableSchedule',
        summary: 'Disable a cron schedule',
      }),
    )
    .errors({ NOT_FOUND: { message: 'No such schedule' } })
    .input(z.strictObject({ id: workIdSchema }))
    .output(scheduleViewSchema),
  tick: scheduleBase
    .meta(
      openapi({
        method: 'POST',
        path: '/schedules/tick',
        operationId: 'tickSchedules',
        summary:
          "Mint items for every enabled schedule's latest due slot (GitHub Actions OIDC only)",
      }),
    )
    .input(z.strictObject({}))
    .output(
      z.strictObject({
        ticked: z.number(),
        minted: z.array(
          z.strictObject({ scheduleId: workIdSchema, itemId: workIdSchema }),
        ),
        skippedCap: z.array(workIdSchema),
        disabled: z.array(workIdSchema),
      }),
    ),
};
export type SchedulesContract = typeof schedulesContract;
```

`libs/work/src/openapi.ts`:

```ts
import { OpenAPIGenerator } from '@orpc/openapi';
import { ZodToJsonSchemaConverter } from '@orpc/zod';

import { itemsContract, schedulesContract } from './contract';

/** The document `docs/api/work-v1.openapi.json` is generated from. */
export async function generateWorkOpenApi(): Promise<object> {
  const generator = new OpenAPIGenerator({
    converters: [new ZodToJsonSchemaConverter()],
  });
  return generator.generate(
    { items: itemsContract, schedules: schedulesContract },
    {
      base: {
        info: { title: 'Agent LCARS work items', version: '1' },
        servers: [{ url: '/api/work/v1' }],
        components: {
          securitySchemes: {
            bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
          },
        },
      },
    },
  );
}
```

- [ ] **Step 4: Run** — `./tools/nx test @agent-lcars/work -- contract` → PASS; `./tools/nx typecheck @agent-lcars/work` → clean.

- [ ] **Step 5: Regenerate the checked-in OpenAPI document**

```bash
pnpm exec tsx tools/work-openapi.mts
./tools/nx run @agent-lcars/work:openapi-check
```

Expected: the script prints `wrote docs/api/work-v1.openapi.json`, and the
`openapi-check` target then reports the file current.

- [ ] **Step 6: Commit**

```bash
git add libs/work/src/contract.ts libs/work/src/contract.spec.ts libs/work/src/openapi.ts docs/api/work-v1.openapi.json
git commit -m "feat(work): schedulesContract and regenerated OpenAPI document

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BiTUeJCQByPUqRLZUpt3CD"
git push
```

---

### Task 4: OIDC verification and the `work.cron` scope

**Files:**

- Modify: `apps/console/src/lib/github-actions-oidc.ts`
- Modify: `apps/console/src/lib/github-actions-oidc.test.ts`
- Modify: `apps/console/src/lib/work-auth.ts`
- Modify: `apps/console/src/lib/work-auth.test.ts`

**Interfaces:**

- Produces: `assertScheduleTickOidcClaims(claims, repository):
ScheduleTickOidcIdentity`, `verifyScheduleTickOidcToken(token,
repository): Promise<ScheduleTickOidcIdentity>`. `WorkScope` gains
  `'work.cron'`; `WorkPrincipal.via` gains `'oidc'`;
  `WorkAuthDeps.verifyScheduleTickOidcToken: (token: string) =>
Promise<unknown>`; `authenticateWorkRequest` returns `{ principal:
'cron:tick', subject: 'cron:tick', scopes: {'work.cron'}, pipelines: [],
via: 'oidc' }` for a valid schedule-tick bearer. Consumed by Task 5's
  `cronTick` router middleware and by `route.ts`/`actions.ts` wiring.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/console/src/lib/github-actions-oidc.test.ts -- add near the
// reconciler describe block; add `assertScheduleTickOidcClaims` to the
// existing import from './github-actions-oidc'.
const SCHEDULE_TICK_OIDC_AUDIENCE = 'agent-lcars-work-schedules';
const SCHEDULE_TICK_WORKFLOW_PATH = '.github/workflows/work-schedules-tick.yml';

const scheduleTickClaims = {
  aud: SCHEDULE_TICK_OIDC_AUDIENCE,
  repository,
  repository_id: '1307149765',
  run_id: '93099054125',
  job_workflow_ref: `${repository}/${SCHEDULE_TICK_WORKFLOW_PATH}@refs/heads/main`,
  ref: 'refs/heads/main',
  event_name: 'schedule',
};

describe('GitHub Actions schedule-tick OIDC claims', () => {
  it('accepts the scheduled and manual tick workflow on main', () => {
    expect(
      assertScheduleTickOidcClaims(scheduleTickClaims, repository),
    ).toEqual({
      repository,
      repositoryId: 1_307_149_765,
      runId: 93_099_054_125,
    });
    expect(
      assertScheduleTickOidcClaims(
        { ...scheduleTickClaims, event_name: 'workflow_dispatch' },
        repository,
      ),
    ).toEqual({
      repository,
      repositoryId: 1_307_149_765,
      runId: 93_099_054_125,
    });
  });

  it.each([
    [{ ...scheduleTickClaims, repository: 'attacker/fork' }, 'repository'],
    [
      {
        ...scheduleTickClaims,
        job_workflow_ref: `${repository}/.github/workflows/ci.yml@refs/heads/main`,
      },
      'job_workflow_ref',
    ],
    [{ ...scheduleTickClaims, ref: 'refs/heads/feature' }, 'ref'],
    [{ ...scheduleTickClaims, event_name: 'pull_request' }, 'event_name'],
    [{ ...scheduleTickClaims, repository_id: 'not-a-number' }, 'repository_id'],
    [{ ...scheduleTickClaims, run_id: '0' }, 'run_id'],
  ])('rejects a caller with the wrong %s claim', (claims, field) => {
    expect(() => assertScheduleTickOidcClaims(claims, repository)).toThrow(
      field,
    );
  });
});
```

```ts
// apps/console/src/lib/work-auth.test.ts -- add to `deps()`'s defaults
// and add these tests.
function deps(over: Partial<WorkAuthDeps> = {}): WorkAuthDeps {
  return {
    verifyGoogleIdToken: async () => ({
      email: 'sa@example.iam.gserviceaccount.com',
      emailVerified: true,
    }),
    verifyScheduleTickOidcToken: async () => {
      throw new Error('not a schedule-tick token');
    },
    session: async () => null,
    grants: () => grants,
    ...over,
  };
}

// -- add inside `describe('authenticateWorkRequest', ...)`:
it('falls through to the schedule-tick verifier when the bearer is not a Google token', async () => {
  const p = await authenticateWorkRequest(
    req({ authorization: 'Bearer t' }),
    deps({
      verifyGoogleIdToken: async () => {
        throw new Error('not Google');
      },
      verifyScheduleTickOidcToken: async () => ({ ok: true }),
    }),
  );
  expect(p).toMatchObject({
    principal: 'cron:tick',
    subject: 'cron:tick',
    via: 'oidc',
    pipelines: [],
  });
  expect(p?.scopes.has('work.cron')).toBe(true);
});

it('refuses a bearer neither verifier accepts', async () => {
  const p = await authenticateWorkRequest(
    req({ authorization: 'Bearer t' }),
    deps({
      verifyGoogleIdToken: async () => {
        throw new Error('not Google');
      },
      verifyScheduleTickOidcToken: async () => {
        throw new Error('not schedule-tick either');
      },
    }),
  );
  expect(p).toBeUndefined();
});
```

- [ ] **Step 2: Run to verify it fails** — `./tools/nx test @agent-lcars/console -- github-actions-oidc work-auth` → FAIL.

- [ ] **Step 3: Implement**

```ts
// apps/console/src/lib/github-actions-oidc.ts -- add after
// verifyReconcileOidcToken, before the completion-finalizer section.

// #1502 sub-project 3: the scheduled tick trigger for cron-ingressed work
// (docs/superpowers/specs/2026-08-23-native-work-items-design.md,
// "Sub-project 3: cron ingress"). One canonical caller, like the
// reconciler -- pinned to the control-plane home, not the allow-list.
const SCHEDULE_TICK_OIDC_AUDIENCE = 'agent-lcars-work-schedules';
const SCHEDULE_TICK_WORKFLOW_PATH = '.github/workflows/work-schedules-tick.yml';

export interface ScheduleTickOidcIdentity {
  repository: string;
  repositoryId: number;
  runId: number;
}

export function assertScheduleTickOidcClaims(
  claims: JWTPayload,
  repository: string,
): ScheduleTickOidcIdentity {
  const expectedJobWorkflowRef = `${repository}/${SCHEDULE_TICK_WORKFLOW_PATH}@refs/heads/main`;
  if (claims['repository'] !== repository) {
    throw new Error('OIDC repository claim does not match the control plane');
  }
  if (claims['job_workflow_ref'] !== expectedJobWorkflowRef) {
    throw new Error(
      'OIDC job_workflow_ref claim is not the schedule tick workflow on main',
    );
  }
  if (claims['ref'] !== 'refs/heads/main') {
    throw new Error('OIDC ref claim is not main');
  }
  if (
    !['schedule', 'workflow_dispatch'].includes(String(claims['event_name']))
  ) {
    throw new Error(
      'OIDC event_name claim is not an allowed schedule-tick event',
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

export async function verifyScheduleTickOidcToken(
  token: string,
  repository: string,
): Promise<ScheduleTickOidcIdentity> {
  const { payload } = await jwtVerify(token, githubActionsJwks, {
    issuer: GITHUB_ACTIONS_ISSUER,
    audience: SCHEDULE_TICK_OIDC_AUDIENCE,
  });
  return assertScheduleTickOidcClaims(payload, repository);
}
```

```ts
// apps/console/src/lib/work-auth.ts -- replace the WorkScope/WorkPrincipal/
// WorkAuthDeps declarations and authenticateWorkRequest.
export type WorkScope = 'work.operator' | 'work.cron';

export interface WorkPrincipal {
  principal: string;
  subject: string;
  scopes: ReadonlySet<WorkScope>;
  pipelines: readonly string[];
  via: 'google' | 'session' | 'oidc';
}

export interface WorkAuthDeps {
  verifyGoogleIdToken: (
    token: string,
  ) => Promise<{ email: string; emailVerified: boolean }>;
  /** GitHub Actions OIDC verifier for the scheduled tick trigger
   *  (`work-schedules-tick.yml`). Only reached when the bearer is not a
   *  valid Google token for our audience -- see `authenticateWorkRequest`
   *  below. Resolves on a trusted token, throws otherwise; the identity
   *  itself is not needed past "this is the trusted tick caller". */
  verifyScheduleTickOidcToken: (token: string) => Promise<unknown>;
  session: () => Promise<{ user?: { login?: string } } | null>;
  grants: () => WorkGrant[];
}

// ...principalFor/googleIdTokenVerifier unchanged...

/**
 * Bearer token first, tried against Google and then, on failure, against
 * the schedule-tick OIDC verifier; an Auth.js session only when no bearer
 * header is present. A bearer that fails both never falls back to the
 * session -- a caller that presented a credential is judged on it.
 */
export async function authenticateWorkRequest(
  request: Request,
  deps: WorkAuthDeps,
): Promise<WorkPrincipal | undefined> {
  const header = request.headers.get('authorization');
  if (header !== null) {
    const match = /^Bearer\s+(\S+)$/iu.exec(header);
    if (match === null) return undefined;
    const token = match[1] ?? '';
    try {
      const { email, emailVerified } = await deps.verifyGoogleIdToken(token);
      if (emailVerified && email !== '') {
        return principalFor(email, 'google', deps.grants());
      }
    } catch {
      // Not a Google-issued token for our audience -- fall through to the
      // GitHub Actions schedule-tick branch below.
    }
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
      return undefined;
    }
  }
  const login = (await deps.session())?.user?.login;
  return login === undefined
    ? undefined
    : principalFor(`github:${login}`, 'session', deps.grants());
}
```

- [ ] **Step 4: Run** — `./tools/nx test @agent-lcars/console -- github-actions-oidc work-auth` → PASS; `./tools/nx typecheck @agent-lcars/console`.

- [ ] **Step 5: Commit**

```bash
git add apps/console/src/lib/github-actions-oidc.ts apps/console/src/lib/github-actions-oidc.test.ts apps/console/src/lib/work-auth.ts apps/console/src/lib/work-auth.test.ts
git commit -m "feat(console): work.cron scope via schedule-tick GitHub Actions OIDC

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BiTUeJCQByPUqRLZUpt3CD"
git push
```

---

### Task 5: `mintItem` extraction and the `schedules` router

**Files:**

- Create: `apps/console/src/lib/work-mint.ts`
- Modify: `apps/console/src/lib/work-router.ts`
- Modify: `apps/console/src/lib/work-router.test.ts`
- Modify: `apps/console/src/lib/work-grants.ts`
- Modify: `apps/console/src/lib/work-grants.test.ts`
- Create: `apps/console/src/lib/schedule-router.ts`
- Create: `apps/console/src/lib/schedule-router.test.ts`
- Modify: `apps/console/src/lib/orchestrator-runtime.ts`
- Modify: `apps/console/src/app/api/work/v1/[[...rest]]/route.ts`
- Modify: `apps/console/src/app/work/actions.ts`

**Interfaces:**

- Consumes: `parseCron`/`latestDueSlot`/`nextDueSlot`/`slotItemId`/
  `schedulesContract` (Task 1, 3); `Schedule`/`ScheduleStore`/
  `MemoryScheduleStore`/`FirestoreScheduleStore` (Task 2); `WorkScope`/
  `WorkPrincipal`/`verifyScheduleTickOidcToken` (Task 4).
- Produces: `apps/console/src/lib/work-mint.ts` exports `WorkContext`
  (gains `scheduleStore: ScheduleStore`, `grants: () => WorkGrant[]`,
  `now: () => Date`), `mintItem(context, {id, spec, origin,
grantsPrincipal}): Promise<MintOutcome>`, `MintOutcome`,
  `GrantsPrincipal`, `forbiddenReason`, `RETRY_AFTER_SECONDS`. `work-grants.ts`
  gains `grantForPrincipal(principal, grants?): WorkGrant | undefined`.
  `schedule-router.ts` exports `scheduleRouter`. `work-router.ts` re-exports
  `WorkContext` and exports `createWorkHandler()` serving both routers.
  `orchestrator-runtime.ts` exports `createScheduleStore(): ScheduleStore`.
  Consumed by Task 6's console actions.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/console/src/lib/work-grants.test.ts -- add
describe('grantForPrincipal', () => {
  const grants = parseWorkGrants(raw);
  it('finds a grant by its canonical principal, not a subject', () => {
    expect(grantForPrincipal('user:jlapenna', grants)?.pipelines).toEqual([
      'claude',
      'codex',
    ]);
    expect(grantForPrincipal('github:jlapenna', grants)).toBeUndefined();
    expect(grantForPrincipal('user:nobody', grants)).toBeUndefined();
  });
});
```

(Add `grantForPrincipal` to the existing `import { parseWorkGrants,
resolvePrincipal } from './work-grants';` line.)

```ts
// apps/console/src/lib/schedule-router.test.ts -- new file
import {
  MemoryScheduleStore,
  MemoryStore,
  Orchestrator,
} from '@agent-lcars/orchestrator';
import { latestDueSlot, parseCron, slotItemId } from '@agent-lcars/work';
import { describe, expect, it } from 'vitest';

import { createWorkHandler } from './work-router';
import type { WorkContext } from './work-mint';

const ID = '01J5Z3K9QX8F0N2B4V6C8D1E3G';
const OTHER_ID = '01J5Z3K9QX8F0N2B4V6C8D1E3H';
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
const cronTick = {
  principal: 'cron:tick',
  subject: 'cron:tick',
  scopes: new Set(['work.cron'] as const),
  pipelines: [],
  via: 'oidc' as const,
};
const GRANTS = [
  {
    principal: 'user:jlapenna',
    subjects: ['github:jlapenna'],
    pipelines: ['claude'],
  },
];
const NOW = new Date('2026-08-27T10:22:00.000Z');

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
    scheduleStore: new MemoryScheduleStore(),
    grants: () => GRANTS,
    now: () => NOW,
    ...over,
  };
}

function withPrincipal(
  ctx: WorkContext,
  principal: WorkContext['principal'],
): WorkContext {
  return { ...ctx, principal };
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
      ...(body === undefined
        ? {}
        : {
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }),
    }),
    { prefix: '/api/work/v1', context: ctx },
  );
  return {
    status: response?.status,
    json: response ? await response.json() : undefined,
  };
}

describe('schedules routes', () => {
  it('refuses schedule CRUD without the work.operator scope', async () => {
    const ctx = context({ principal: undefined });
    for (const [m, p, b] of [
      ['PUT', `/schedules/${ID}`, { cron: '0 * * * *', spec }],
      ['GET', `/schedules/${ID}`],
      ['GET', '/schedules'],
      ['POST', `/schedules/${ID}/enable`],
      ['POST', `/schedules/${ID}/disable`],
    ] as const) {
      expect((await call(ctx, m, p, b)).status, `${m} ${p}`).toBe(401);
    }
  });

  it('refuses tick without the work.cron scope, even for an operator', async () => {
    expect((await call(context(), 'POST', '/schedules/tick', {})).status).toBe(
      401,
    );
  });

  it('creates a schedule and replays it idempotently', async () => {
    const ctx = context();
    const body = { cron: '0 * * * *', spec, enabled: true };
    const first = await call(ctx, 'PUT', `/schedules/${ID}`, body);
    expect(first.status).toBe(201);
    expect(first.json).toMatchObject({
      id: ID,
      cron: '0 * * * *',
      enabled: true,
      spec,
    });

    const again = await call(ctx, 'PUT', `/schedules/${ID}`, body);
    expect(again.status).toBe(201);
    expect(again.json).toEqual(first.json);
  });

  it('rejects a malformed cron expression with 400', async () => {
    const r = await call(context(), 'PUT', `/schedules/${ID}`, {
      cron: 'not a cron',
      spec,
    });
    expect(r.status).toBe(400);
  });

  it('refuses a replay with a different cron or spec with 409', async () => {
    const ctx = context();
    await call(ctx, 'PUT', `/schedules/${ID}`, { cron: '0 * * * *', spec });
    const r = await call(ctx, 'PUT', `/schedules/${ID}`, {
      cron: '0 0 * * *',
      spec,
    });
    expect(r.status).toBe(409);
  });

  it('refuses a pipeline outside the grant with 403', async () => {
    const r = await call(context(), 'PUT', `/schedules/${ID}`, {
      cron: '0 * * * *',
      spec: { ...spec, pipeline: 'codex' },
    });
    expect(r.status).toBe(403);
  });

  it('lists newest first, enables, and disables', async () => {
    const ctx = context();
    await call(ctx, 'PUT', `/schedules/${ID}`, { cron: '0 * * * *', spec });
    await call(ctx, 'PUT', `/schedules/${OTHER_ID}`, {
      cron: '0 * * * *',
      spec,
    });

    const listed = await call(ctx, 'GET', '/schedules');
    expect(listed.json.schedules.map((s: { id: string }) => s.id)).toEqual([
      OTHER_ID,
      ID,
    ]);

    const disabled = await call(ctx, 'POST', `/schedules/${ID}/disable`);
    expect(disabled.status).toBe(200);
    expect(disabled.json).toMatchObject({
      enabled: false,
      disabledReason: 'operator',
    });

    const enabled = await call(ctx, 'POST', `/schedules/${ID}/enable`);
    expect(enabled.status).toBe(200);
    expect(enabled.json.enabled).toBe(true);
    expect(enabled.json.disabledReason).toBeUndefined();
  });

  it('answers 404 for an unknown schedule', async () => {
    expect((await call(context(), 'GET', `/schedules/${ID}`)).status).toBe(404);
    expect(
      (await call(context(), 'POST', `/schedules/${ID}/enable`)).status,
    ).toBe(404);
    expect(
      (await call(context(), 'POST', `/schedules/${ID}/disable`)).status,
    ).toBe(404);
  });
});

describe('tick', () => {
  it('leaves a schedule alone once lastSlotAt already covers the latest due slot', async () => {
    const ctx = context();
    await ctx.scheduleStore.writeSchedule({
      scheduleId: ID,
      cron: '*/15 * * * *',
      spec,
      enabled: true,
      createdBy: 'user:jlapenna',
      createdAt: '2026-08-27T09:00:00.000Z',
      updatedAt: '2026-08-27T09:00:00.000Z',
      lastSlotAt: '2026-08-27T10:15:00.000Z',
    });
    const r = await call(
      withPrincipal(ctx, cronTick),
      'POST',
      '/schedules/tick',
      {},
    );
    expect(r.json).toEqual({
      ticked: 1,
      minted: [],
      skippedCap: [],
      disabled: [],
    });
  });

  it('mints the latest due slot, advances lastSlotAt, and a re-tick in the same minute is a no-op', async () => {
    const ctx = context();
    await call(ctx, 'PUT', `/schedules/${ID}`, {
      cron: '* * * * *',
      spec,
    });
    const tickCtx = withPrincipal(ctx, cronTick);

    const first = await call(tickCtx, 'POST', '/schedules/tick', {});
    expect(first.status).toBe(200);
    expect(first.json.ticked).toBe(1);
    expect(first.json.minted).toHaveLength(1);
    const itemId = first.json.minted[0].itemId;

    const gotAfterFirst = await call(ctx, 'GET', `/schedules/${ID}`);
    expect(gotAfterFirst.json.lastItemId).toBe(itemId);
    expect(gotAfterFirst.json.lastSlotAt).toBe(NOW.toISOString());

    // The clock is frozen at NOW: a second tick asks `latestDueSlot` for a
    // slot strictly AFTER `lastSlotAt`, which is also NOW -- there isn't
    // one yet, so nothing mints and the watermark does not move. (This is
    // a different case from idempotent replay -- see the next test for
    // that: a re-tick of an ALREADY-PASSED slot, where `mintItem` finds
    // the task `slotItemId` already names.)
    const second = await call(tickCtx, 'POST', '/schedules/tick', {});
    expect(second.json).toEqual({
      ticked: 1,
      minted: [],
      skippedCap: [],
      disabled: [],
    });
    const gotAfterSecond = await call(ctx, 'GET', `/schedules/${ID}`);
    expect(gotAfterSecond.json.lastSlotAt).toBe(gotAfterFirst.json.lastSlotAt);
    expect(gotAfterSecond.json.lastItemId).toBe(itemId);
  });

  it("replays mintItem's idempotent-create path when the deterministic slot item already exists", async () => {
    const ctx = context();
    const cronExpr = '* * * * *';
    const slot = latestDueSlot(parseCron(cronExpr), NOW);
    if (slot === undefined) throw new Error('expected a due slot at NOW');
    const itemId = await slotItemId(ID, slot);

    // Pre-seed the task directly through the orchestrator, at the exact
    // id and spec a tick would mint -- proving a cron mint goes through
    // `mintItem`'s existing-item branch (idempotent-create), not a second
    // `requestRun`, when the deterministic id already names a task. This
    // is the actual re-tick-of-the-same-slot idempotency guarantee
    // `slotItemId` is designed around (see Task 1); a frozen-clock re-tick
    // in the same minute (previous test) never reaches this branch at all,
    // because `latestDueSlot` finds no new slot to try.
    await ctx.runtime.orchestrator.request({
      taskId: { workId: itemId },
      requestId: itemId,
      pipeline: spec.pipeline,
      work: { origin: { principal: `cron:${ID}`, channel: 'cron' }, spec },
    });
    await ctx.scheduleStore.writeSchedule({
      scheduleId: ID,
      cron: cronExpr,
      spec,
      enabled: true,
      createdBy: 'user:jlapenna',
      createdAt: '2026-08-27T09:00:00.000Z',
      updatedAt: '2026-08-27T09:00:00.000Z',
    });

    const r = await call(
      withPrincipal(ctx, cronTick),
      'POST',
      '/schedules/tick',
      {},
    );
    expect(r.json.minted).toEqual([{ scheduleId: ID, itemId }]);

    const item = await call(ctx, 'GET', `/items/${itemId}`);
    expect(item.json.runs).toHaveLength(1); // still just the pre-seeded run
    expect(item.json.origin).toEqual({
      principal: `cron:${ID}`,
      channel: 'cron',
    });
  });

  it('skips a schedule at the live-run cap and does not advance lastSlotAt', async () => {
    const ctx = context({ maxLiveRuns: 0 });
    await call(ctx, 'PUT', `/schedules/${ID}`, { cron: '* * * * *', spec });
    const r = await call(
      withPrincipal(ctx, cronTick),
      'POST',
      '/schedules/tick',
      {},
    );
    expect(r.json).toMatchObject({
      minted: [],
      skippedCap: [ID],
      disabled: [],
    });
    expect(
      (await call(ctx, 'GET', `/schedules/${ID}`)).json.lastSlotAt,
    ).toBeUndefined();
  });

  it("disables a schedule whose creator's grant no longer covers its pipeline", async () => {
    const ctx = context();
    await call(ctx, 'PUT', `/schedules/${ID}`, { cron: '* * * * *', spec });
    const tickCtx = withPrincipal({ ...ctx, grants: () => [] }, cronTick);
    const r = await call(tickCtx, 'POST', '/schedules/tick', {});
    expect(r.json).toMatchObject({
      minted: [],
      skippedCap: [],
      disabled: [ID],
    });
    expect(await call(ctx, 'GET', `/schedules/${ID}`)).toMatchObject({
      json: { enabled: false, disabledReason: 'grant-revoked' },
    });
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `./tools/nx test @agent-lcars/console -- work-grants schedule-router` → FAIL (`grantForPrincipal`/`schedule-router` not found).

- [ ] **Step 3: Implement**

`apps/console/src/lib/work-grants.ts` -- add after `resolvePrincipal`:

```ts
/** Looks up a grant by its canonical LCARS principal (`user:jlapenna`,
 *  `svc:lcars-admin`) rather than by subject -- what a schedule's
 *  `createdBy` field already stores. Used only by the schedule tick, which
 *  must re-check the schedule creator's grant, never the tick caller's own
 *  (`cron:tick` has no grant of its own). */
export function grantForPrincipal(
  principal: string,
  grants: WorkGrant[] = workGrants(),
): WorkGrant | undefined {
  return grants.find((g) => g.principal === principal);
}
```

`apps/console/src/lib/work-mint.ts` (new file):

```ts
import 'server-only';

import {
  isRefusal,
  isWorkAnchor,
  type ScheduleStore,
  type Task,
} from '@agent-lcars/orchestrator';
import {
  type WorkOrigin,
  workPayloadSchema,
  type WorkSpec,
  workSpecSchema,
} from '@agent-lcars/work';
import {
  toItemView,
  type ItemSessionView,
  type ItemView,
} from '@agent-lcars/work/derive';

import { isControlPlaneRepository } from './deployment';
import type { OrchestratorRouteDeps } from './orchestrator-routes';
import type { WorkGrant } from './work-grants';
import type { WorkPrincipal } from './work-auth';

/** How long a caller turned away by the live-run cap should wait. Sent both
 *  as the error payload the contract declares and as a `Retry-After`
 *  response header (see `work-router.ts`'s `createWorkHandler`). */
export const RETRY_AFTER_SECONDS = 60;

export interface WorkContext {
  /** Resolved by the route from the request's bearer token or session;
   *  `undefined` means "no recognized principal", which every procedure
   *  turns into a 401 through its scope gate. */
  principal?: WorkPrincipal;
  runtime: OrchestratorRouteDeps;
  sessionsFor: (runIds: string[]) => Promise<ItemSessionView[]>;
  maxLiveRuns: number;
  /** Schedule storage -- separate from `OrchestratorRouteDeps` on purpose:
   *  a schedule is not a `Task` (see `schedule-store.ts`). */
  scheduleStore: ScheduleStore;
  /** The grant list, injected the way `sessionsFor` is: the schedule tick
   *  handler re-resolves a schedule's `createdBy` principal against it
   *  directly (`grantForPrincipal`), independent of the tick caller's own
   *  principal (`cron:tick`, which has no grant). */
  grants: () => WorkGrant[];
  /** Injected clock: the tick handler's "latest due slot" computation must
   *  be deterministic under test, not tied to wall-clock `Date.now()`. */
  now: () => Date;
}

export async function view(
  context: WorkContext,
  workId: string,
  task: Task,
): Promise<ItemView> {
  const runs = await context.runtime.store.listRuns({ workId });
  const sessions = await context.sessionsFor(runs.map((run) => run.runId));
  return toItemView({ workId, task, runs, sessions });
}

/** The cap is a fleet-wide budget on *native* work, not on the
 *  orchestrator: GitHub-anchored runs are not this API's to throttle. */
export async function liveNativeRunCount(
  context: WorkContext,
): Promise<number> {
  const live = await context.runtime.store.listLiveRuns();
  return live.filter((run) => isWorkAnchor(run.task)).length;
}

/** Who a mint's grant is checked against: the caller for `items.create`,
 *  a schedule's `createdBy` for `schedules.tick`. */
export interface GrantsPrincipal {
  principal: string;
  pipelines: readonly string[];
}

/**
 * The two capability checks every run-minting call must clear: invoking a
 * pipeline is granted per principal, and the target repository must be one
 * this control plane admits. Both evaluated against the grants and the
 * repository list **as they stand now** -- see the design spec's
 * `redispatch` rationale, which applies identically to a tick.
 */
export function forbiddenReason(
  principal: GrantsPrincipal,
  spec: WorkSpec,
): string | undefined {
  if (!principal.pipelines.includes(spec.pipeline)) {
    return `${principal.principal} may not request pipeline ${spec.pipeline}`;
  }
  if (!isControlPlaneRepository(spec.target.repo)) {
    return `${spec.target.repo} is not a control-plane repository`;
  }
  return undefined;
}

/** Both sides go through the same schema first, so the comparison is over
 *  normalized values rather than whatever shape the caller happened to
 *  send. */
export function sameSpec(a: WorkSpec, b: WorkSpec): boolean {
  return (
    JSON.stringify(workSpecSchema.parse(a)) ===
    JSON.stringify(workSpecSchema.parse(b))
  );
}

export type MintOutcome =
  | { kind: 'forbidden'; message: string }
  | { kind: 'conflict'; message: string }
  | { kind: 'cap' }
  | { kind: 'existing'; task: Task }
  | { kind: 'minted'; task: Task };

/**
 * Shared by `items.create` and `schedules.tick` (extracted from
 * `items.create`'s body, #1502 sub-project 3): read-or-create-by-id,
 * grant-checked, cap-checked. `id` is the work item id (a client ULID for
 * `create`, `slotItemId(scheduleId, slot)` for a tick); `grantsPrincipal`
 * is who the pipeline/repo grant is checked against.
 */
export async function mintItem(
  context: WorkContext,
  input: {
    id: string;
    spec: WorkSpec;
    origin: WorkOrigin;
    grantsPrincipal: GrantsPrincipal;
  },
): Promise<MintOutcome> {
  const forbidden = forbiddenReason(input.grantsPrincipal, input.spec);
  if (forbidden !== undefined) return { kind: 'forbidden', message: forbidden };

  const existing = await context.runtime.store.readTask({ workId: input.id });
  if (existing !== undefined) {
    const stored = workPayloadSchema.parse(existing.task.work);
    if (!sameSpec(stored.spec, input.spec)) {
      return {
        kind: 'conflict',
        message: `item ${input.id} already exists with a different spec`,
      };
    }
    return { kind: 'existing', task: existing.task };
  }

  if ((await liveNativeRunCount(context)) >= context.maxLiveRuns) {
    return { kind: 'cap' };
  }

  const outcome = await context.runtime.orchestrator.request({
    taskId: { workId: input.id },
    requestId: input.id,
    pipeline: input.spec.pipeline,
    work: { origin: input.origin, spec: input.spec },
  });
  if (isRefusal(outcome)) {
    return { kind: 'conflict', message: outcome.reason };
  }
  await context.runtime.drain();
  return { kind: 'minted', task: outcome.task };
}
```

`apps/console/src/lib/work-router.ts` -- replace the local
`WorkContext`/`view`/`liveNativeRunCount`/`forbiddenReason`/`sameSpec`
declarations and the `create` handler, and combine the OpenAPI handler:

```ts
import 'server-only';

import {
  decidedRun,
  isLive,
  isRefusal,
  isWorkAnchor,
} from '@agent-lcars/orchestrator';
import { itemsContract, workPayloadSchema } from '@agent-lcars/work';
import { deriveItemState } from '@agent-lcars/work/derive';
import { OpenAPIHandler } from '@orpc/openapi/fetch';
import { implement, ORPCError } from '@orpc/server';

import { scheduleRouter } from './schedule-router';
import {
  forbiddenReason,
  liveNativeRunCount,
  mintItem,
  RETRY_AFTER_SECONDS,
  sameSpec,
  view,
  type WorkContext,
} from './work-mint';

export type { WorkContext } from './work-mint';

const os = implement(itemsContract).$context<WorkContext>();

const operator = os.use(async ({ context, next }) => {
  const { principal } = context;
  if (principal === undefined || !principal.scopes.has('work.operator')) {
    throw new ORPCError('UNAUTHORIZED', {
      message: 'work.operator scope required',
    });
  }
  return next({ context: { principal } });
});

export const workRouter = os.router({
  create: operator.create.handler(async ({ input, context, errors }) => {
    const { principal } = context;
    const result = await mintItem(context, {
      id: input.id,
      spec: input.spec,
      origin: {
        principal: principal.principal,
        channel: principal.via === 'session' ? 'console' : 'api',
      },
      grantsPrincipal: principal,
    });
    if (result.kind === 'forbidden') {
      throw errors.FORBIDDEN({ message: result.message });
    }
    if (result.kind === 'conflict') {
      throw errors.CONFLICT({ message: result.message });
    }
    if (result.kind === 'cap') {
      throw errors.TOO_MANY_REQUESTS({
        data: { retryAfterSeconds: RETRY_AFTER_SECONDS },
      });
    }
    return view(context, input.id, result.task);
  }),

  // get/list/cancel/redispatch: UNCHANGED from the current file, still
  // importing `forbiddenReason`, `liveNativeRunCount`, `sameSpec`, `view`
  // from `./work-mint` instead of defining them locally. Keep every line
  // of their bodies as-is -- only the top-of-file declarations move.
});

export function createWorkHandler(): OpenAPIHandler<WorkContext> {
  return new OpenAPIHandler(
    { items: workRouter, schedules: scheduleRouter },
    {
      routingInterceptors: [
        async (options) => {
          const result = await options.next();
          if (result.matched && result.response.status === 429) {
            result.response.headers['retry-after'] =
              String(RETRY_AFTER_SECONDS);
          }
          return result;
        },
      ],
    },
  );
}
```

(The `get`/`list`/`cancel`/`redispatch` handler bodies are unchanged --
copy them from the current file verbatim under the new imports. Remove the
now-unused local `RETRY_AFTER_SECONDS` const, `WorkContext` interface,
`view`, `liveNativeRunCount`, `forbiddenReason`, `sameSpec` function
definitions, replaced by the imports above.)

`apps/console/src/lib/schedule-router.ts` (new file):

```ts
import 'server-only';

import type { Schedule } from '@agent-lcars/orchestrator';
import {
  type CronSpec,
  latestDueSlot,
  nextDueSlot,
  parseCron,
  schedulesContract,
  slotItemId,
  workSpecSchema,
} from '@agent-lcars/work';
import { implement, ORPCError } from '@orpc/server';

import { grantForPrincipal } from './work-grants';
import { forbiddenReason, mintItem, type WorkContext } from './work-mint';

const os = implement(schedulesContract).$context<WorkContext>();

const operator = os.use(async ({ context, next }) => {
  const { principal } = context;
  if (principal === undefined || !principal.scopes.has('work.operator')) {
    throw new ORPCError('UNAUTHORIZED', {
      message: 'work.operator scope required',
    });
  }
  return next({ context: { principal } });
});

const cronTick = os.use(async ({ context, next }) => {
  const { principal } = context;
  if (principal === undefined || !principal.scopes.has('work.cron')) {
    throw new ORPCError('UNAUTHORIZED', {
      message: 'work.cron scope required',
    });
  }
  return next({ context });
});

function view(schedule: Schedule) {
  return {
    id: schedule.scheduleId,
    cron: schedule.cron,
    spec: workSpecSchema.parse(schedule.spec),
    enabled: schedule.enabled,
    createdBy: schedule.createdBy,
    createdAt: schedule.createdAt,
    updatedAt: schedule.updatedAt,
    ...(schedule.lastSlotAt === undefined
      ? {}
      : { lastSlotAt: schedule.lastSlotAt }),
    ...(schedule.lastItemId === undefined
      ? {}
      : { lastItemId: schedule.lastItemId }),
    ...(schedule.disabledReason === undefined
      ? {}
      : { disabledReason: schedule.disabledReason }),
  };
}

function sameSchedule(
  a: Schedule,
  b: { cron: string; spec: unknown },
): boolean {
  return (
    a.cron === b.cron &&
    JSON.stringify(workSpecSchema.parse(a.spec)) ===
      JSON.stringify(workSpecSchema.parse(b.spec))
  );
}

export const scheduleRouter = os.router({
  create: operator.create.handler(async ({ input, context, errors }) => {
    const { principal } = context;
    // The same check `items.create` runs: pipeline grant + control-plane
    // repo admission. One ruling, one function -- `schedule-router.ts`
    // does not fork it.
    const forbidden = forbiddenReason(principal, input.spec);
    if (forbidden !== undefined) throw errors.FORBIDDEN({ message: forbidden });

    // `cronExpressionSchema` (Task 3) already refuses a malformed
    // expression before the handler runs; re-parsing here is what lets
    // this throw the exact documented BAD_REQUEST message rather than
    // trusting zod's own refine message. It also produces the `CronSpec`
    // `nextDueSlot` needs next.
    let cron: CronSpec;
    try {
      cron = parseCron(input.cron);
    } catch {
      throw errors.BAD_REQUEST({ message: 'Malformed cron expression' });
    }
    // A syntactically valid expression that can never actually fire (e.g.
    // `0 0 31 2 *` -- no February has a 31st) would otherwise sit enabled
    // forever, costing a full `MAX_LOOKBACK_MINUTES` walk on every tick
    // for nothing. Reject it once, here, instead.
    if (nextDueSlot(cron, context.now()) === undefined) {
      throw errors.BAD_REQUEST({
        message: 'cron expression never fires within a year',
      });
    }

    const existing = await context.scheduleStore.readSchedule(input.id);
    if (existing !== undefined) {
      if (!sameSchedule(existing, { cron: input.cron, spec: input.spec })) {
        throw errors.CONFLICT({
          message: `schedule ${input.id} already exists with a different cron or spec`,
        });
      }
      return view(existing);
    }

    const now = context.now().toISOString();
    const schedule: Schedule = {
      scheduleId: input.id,
      cron: input.cron,
      spec: input.spec,
      enabled: input.enabled ?? true,
      createdBy: principal.principal,
      createdAt: now,
      updatedAt: now,
    };
    await context.scheduleStore.writeSchedule(schedule);
    return view(schedule);
  }),

  get: operator.get.handler(async ({ input, context, errors }) => {
    const schedule = await context.scheduleStore.readSchedule(input.id);
    if (schedule === undefined) throw errors.NOT_FOUND();
    return view(schedule);
  }),

  list: operator.list.handler(async ({ input, context }) => {
    const schedules = await context.scheduleStore.listSchedules(input.limit);
    return { schedules: schedules.map(view) };
  }),

  enable: operator.enable.handler(async ({ input, context, errors }) => {
    const schedule = await context.scheduleStore.readSchedule(input.id);
    if (schedule === undefined) throw errors.NOT_FOUND();
    const { disabledReason: _disabledReason, ...rest } = schedule;
    const next: Schedule = {
      ...rest,
      enabled: true,
      updatedAt: context.now().toISOString(),
    };
    await context.scheduleStore.writeSchedule(next);
    return view(next);
  }),

  disable: operator.disable.handler(async ({ input, context, errors }) => {
    const schedule = await context.scheduleStore.readSchedule(input.id);
    if (schedule === undefined) throw errors.NOT_FOUND();
    const next: Schedule = {
      ...schedule,
      enabled: false,
      disabledReason: 'operator',
      updatedAt: context.now().toISOString(),
    };
    await context.scheduleStore.writeSchedule(next);
    return view(next);
  }),

  tick: cronTick.tick.handler(async ({ context }) => {
    const schedules = await context.scheduleStore.listEnabledSchedules();
    const now = context.now();
    const minted: { scheduleId: string; itemId: string }[] = [];
    const skippedCap: string[] = [];
    const disabled: string[] = [];

    for (const schedule of schedules) {
      const cron = parseCron(schedule.cron);
      const lastSlotAt =
        schedule.lastSlotAt === undefined
          ? undefined
          : new Date(schedule.lastSlotAt);
      const slot = latestDueSlot(cron, now, lastSlotAt);
      if (slot === undefined) continue;

      const itemId = await slotItemId(schedule.scheduleId, slot);
      const spec = workSpecSchema.parse(schedule.spec);
      const grant = grantForPrincipal(schedule.createdBy, context.grants());

      const result = await mintItem(context, {
        id: itemId,
        spec,
        origin: { principal: `cron:${schedule.scheduleId}`, channel: 'cron' },
        grantsPrincipal: {
          principal: schedule.createdBy,
          pipelines: grant?.pipelines ?? [],
        },
      });

      if (result.kind === 'forbidden') {
        await context.scheduleStore.writeSchedule({
          ...schedule,
          enabled: false,
          disabledReason: 'grant-revoked',
          updatedAt: now.toISOString(),
        });
        disabled.push(schedule.scheduleId);
        continue;
      }
      if (result.kind === 'cap') {
        skippedCap.push(schedule.scheduleId);
        continue;
      }
      // 'conflict' cannot happen here: `itemId` is deterministic per
      // (scheduleId, slot) -- see `slotItemId` -- so a same-slot re-tick
      // always replays the identical spec `mintItem` already stored.
      minted.push({ scheduleId: schedule.scheduleId, itemId });
      await context.scheduleStore.writeSchedule({
        ...schedule,
        lastSlotAt: slot.toISOString(),
        lastItemId: itemId,
        updatedAt: now.toISOString(),
      });
    }

    return { ticked: schedules.length, minted, skippedCap, disabled };
  }),
});
```

`schedule-router.ts`'s `create` deliberately checks the target repo too
(via the shared `forbiddenReason`), even though `mintItem` will re-check
it again at tick time regardless -- the same double-check `redispatch`
already accepts, so a schedule for a repo that has since left the control
plane is refused at the point a human is looking at the response, not
silently deferred to the next tick's `disabled` list.

`apps/console/src/lib/orchestrator-runtime.ts` -- add:

```ts
import {
  FirestoreScheduleStore,
  type ScheduleStore,
} from '@agent-lcars/orchestrator';

let cachedScheduleStore: ScheduleStore | undefined;

export function createScheduleStore(): ScheduleStore {
  cachedScheduleStore ??= new FirestoreScheduleStore({
    projectId: required('PROJECT_ID'),
    databaseId: required('DISPATCH_FIRESTORE_DATABASE_ID'),
  });
  return cachedScheduleStore;
}
```

`apps/console/src/app/api/work/v1/[[...rest]]/route.ts` -- update the
`context` object and imports:

```ts
import { auth } from '@/auth';
import { controlPlaneRepository } from '@/lib/deployment';
import { verifyScheduleTickOidcToken } from '@/lib/github-actions-oidc';
import {
  createOrchestratorRuntime,
  createScheduleStore,
} from '@/lib/orchestrator-runtime';
import {
  authenticateWorkRequest,
  googleIdTokenVerifier,
} from '@/lib/work-auth';
import { workGrants, workMaxLiveRuns } from '@/lib/work-grants';
import { createWorkHandler } from '@/lib/work-router';
import { sessionsForRuns } from '@/lib/work-sessions';

const PREFIX = '/api/work/v1';

const handler = createWorkHandler();
const verifyGoogleIdToken = googleIdTokenVerifier(
  process.env['AGENT_LCARS_WORK_AUDIENCE'] ?? 'agent-lcars-work',
);

async function handle(request: Request): Promise<Response> {
  const principal = await authenticateWorkRequest(request, {
    verifyGoogleIdToken,
    verifyScheduleTickOidcToken: (token) =>
      verifyScheduleTickOidcToken(token, controlPlaneRepository()),
    session: async () => (await auth()) as { user?: { login?: string } } | null,
    grants: workGrants,
  });
  const { matched, response } = await handler.handle(request, {
    prefix: PREFIX,
    context: {
      ...(principal === undefined ? {} : { principal }),
      runtime: createOrchestratorRuntime(),
      sessionsFor: sessionsForRuns,
      maxLiveRuns: workMaxLiveRuns(),
      scheduleStore: createScheduleStore(),
      grants: workGrants,
      now: () => new Date(),
    },
  });
  return matched && response !== undefined
    ? response
    : Response.json({ error: 'Not found' }, { status: 404 });
}

export const GET = handle;
export const PUT = handle;
export const POST = handle;
export const DELETE = handle;
export const PATCH = handle;
```

`apps/console/src/app/work/actions.ts` -- update the `context()` helper
identically (import `controlPlaneRepository`/`verifyScheduleTickOidcToken`/
`createScheduleStore`; add `scheduleStore: createScheduleStore(), grants:
workGrants, now: () => new Date()` and the third `WorkAuthDeps` field, same
as `route.ts` above).

`apps/console/src/lib/work-router.test.ts` -- update the `context()`
helper to satisfy the widened `WorkContext`:

```ts
import {
  MemoryScheduleStore,
  MemoryStore,
  Orchestrator,
} from '@agent-lcars/orchestrator';
// ...
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
    scheduleStore: new MemoryScheduleStore(),
    grants: () => [],
    now: () => new Date('2026-08-26T10:00:00.000Z'),
    ...over,
  };
}
```

- [ ] **Step 4: Run** — `./tools/nx test @agent-lcars/console -- work-grants work-router schedule-router work-mint` (there is no `work-mint.spec.ts` -- it is exercised through both routers' tests) → PASS; `./tools/nx typecheck @agent-lcars/console` → clean; `./tools/nx test @agent-lcars/console -- work-auth` still PASS (Task 4 unaffected).

- [ ] **Step 5: Commit**

```bash
git add apps/console/src/lib/work-mint.ts apps/console/src/lib/work-router.ts apps/console/src/lib/work-router.test.ts apps/console/src/lib/work-grants.ts apps/console/src/lib/work-grants.test.ts apps/console/src/lib/schedule-router.ts apps/console/src/lib/schedule-router.test.ts apps/console/src/lib/orchestrator-runtime.ts apps/console/src/app/api/work/v1 apps/console/src/app/work/actions.ts
git commit -m "feat(console): extract mintItem and add the schedules router

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BiTUeJCQByPUqRLZUpt3CD"
git push
```

---

### Task 6: Console `/work/schedules`

**Files:**

- Create: `apps/console/src/app/work/schedules/page.tsx`
- Create: `apps/console/src/app/work/schedules/actions.ts`
- Create: `apps/console/src/app/work/schedules/schedule-list.tsx`
- Create: `apps/console/src/app/work/schedules/schedule-list.test.tsx`
- Create: `apps/console/src/app/work/schedules/schedule-create-form.tsx`
- Create: `apps/console/src/app/work/schedules/schedule-create-form.test.tsx`
- Create: `apps/console/src/app/work/schedules/schedule-actions.tsx`
- Modify: `apps/console/src/app/work/page.tsx`

**Interfaces:**

- Consumes: `scheduleRouter` (Task 5); `ulid()` from `@agent-lcars/work`
  (sub-project 2, already merged per this plan's `Spec` line); `parseCron`
  (Task 1); `PIPELINES` (`@agent-lcars/work`); `controlPlaneRepository()`
  (`apps/console/src/lib/deployment.ts`).
- Produces: `/work/schedules` page; `createSchedule`, `listSchedules`,
  `enableSchedule`, `disableSchedule` server functions (`[error, data]`
  tuple, same as `work/actions.ts`).

- [ ] **Step 1: Write the failing tests**

```tsx
// apps/console/src/app/work/schedules/schedule-create-form.test.tsx
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ScheduleCreateForm } from './schedule-create-form';

function renderForm(create = vi.fn()) {
  render(
    <ScheduleCreateForm
      create={create}
      defaultRepo="jlapenna/agent-lcars"
      pipelines={['claude', 'codex']}
    />,
  );
  return create;
}

describe('ScheduleCreateForm', () => {
  it('submits { id, cron, spec, enabled } with a ulid id', async () => {
    const create = renderForm(vi.fn().mockResolvedValue([null, { id: 'X' }]));
    await userEvent.type(screen.getByLabelText('Title'), 'Nightly sync');
    await userEvent.type(
      screen.getByLabelText('Description'),
      'Run the nightly sync.',
    );
    await userEvent.clear(screen.getByLabelText(/Cron/));
    await userEvent.type(screen.getByLabelText(/Cron/), '0 3 * * *');
    await userEvent.click(
      screen.getByRole('button', { name: 'Create schedule' }),
    );
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const [input] = create.mock.calls[0];
    expect(input.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/u);
    expect(input.cron).toBe('0 3 * * *');
    expect(input.enabled).toBe(true);
    expect(input.spec).toEqual({
      title: 'Nightly sync',
      description: 'Run the nightly sync.',
      pipeline: 'claude',
      target: { repo: 'jlapenna/agent-lcars' },
    });
  });

  it('rejects an invalid cron expression client-side without calling create', async () => {
    const create = renderForm();
    await userEvent.type(screen.getByLabelText('Title'), 'T');
    await userEvent.type(screen.getByLabelText('Description'), 'D');
    await userEvent.clear(screen.getByLabelText(/Cron/));
    await userEvent.type(screen.getByLabelText(/Cron/), 'not a cron');
    await userEvent.click(
      screen.getByRole('button', { name: 'Create schedule' }),
    );
    expect(
      await screen.findByText(/valid 5-field UTC cron expression/),
    ).toBeInTheDocument();
    expect(create).not.toHaveBeenCalled();
  });

  it.each([['FORBIDDEN', 'no grant for that pipeline or repository']])(
    'renders %s inline',
    async (code, text) => {
      renderForm(vi.fn().mockResolvedValue([{ code, message: 'x' }, null]));
      await userEvent.type(screen.getByLabelText('Title'), 'T');
      await userEvent.type(screen.getByLabelText('Description'), 'D');
      await userEvent.click(
        screen.getByRole('button', { name: 'Create schedule' }),
      );
      expect(await screen.findByText(new RegExp(text))).toBeInTheDocument();
    },
  );
});
```

```tsx
// apps/console/src/app/work/schedules/schedule-list.test.tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ScheduleList, type ScheduleView } from './schedule-list';

function schedule(over: Partial<ScheduleView> = {}): ScheduleView {
  return {
    id: '01M107KR3X6VDH7NZ4JDXZNSS2',
    cron: '0 * * * *',
    spec: {
      title: 'Hourly sync',
      description: 'd',
      pipeline: 'claude',
      target: { repo: 'jlapenna/agent-lcars' },
    },
    enabled: true,
    ...over,
  };
}

describe('ScheduleList', () => {
  it('shows an empty state with no schedules', () => {
    render(<ScheduleList schedules={[]} enable={vi.fn()} disable={vi.fn()} />);
    expect(screen.getByText('No schedules yet.')).toBeInTheDocument();
  });

  it('renders title, cron, pipeline, repo, enabled state, and a last-item link', () => {
    render(
      <ScheduleList
        schedules={[schedule({ lastItemId: '01M107KR3X6VDH7NZ4JDXZNSS3' })]}
        enable={vi.fn()}
        disable={vi.fn()}
      />,
    );
    expect(screen.getByText('Hourly sync')).toBeInTheDocument();
    expect(screen.getByText('0 * * * *')).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: '01M107KR3X6VDH7NZ4JDXZNSS3' }),
    ).toHaveAttribute('href', '/work/01M107KR3X6VDH7NZ4JDXZNSS3');
    expect(screen.getByRole('button', { name: 'Disable' })).toBeInTheDocument();
  });

  it('offers Enable for a disabled schedule', () => {
    render(
      <ScheduleList
        schedules={[schedule({ enabled: false })]}
        enable={vi.fn()}
        disable={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Enable' })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `./tools/nx test @agent-lcars/console -- schedule-create-form schedule-list` → FAIL (modules not found).

- [ ] **Step 3: Implement**

`apps/console/src/app/work/schedules/schedule-actions.tsx`:

```tsx
'use client';

import { Button, Group } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';

import { showErrorToast } from '../../show-error-toast';

type ScheduleActionResult = readonly [
  { code: string; message: string } | null,
  unknown,
];
export type ScheduleAction = (input: {
  id: string;
}) => Promise<ScheduleActionResult>;

export function ScheduleActions({
  id,
  enabled,
  enable,
  disable,
}: {
  id: string;
  enabled: boolean;
  enable: ScheduleAction;
  disable: ScheduleAction;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const run = (action: ScheduleAction, successMessage: string) => {
    startTransition(async () => {
      const [err] = await action({ id });
      if (err) {
        showErrorToast(err.message);
        return;
      }
      notifications.show({ message: successMessage, color: 'green' });
      router.refresh();
    });
  };

  return (
    <Group gap="xs">
      {enabled ? (
        <Button
          variant="subtle"
          color="red"
          size="compact-sm"
          disabled={isPending}
          loading={isPending}
          onClick={() => run(disable, 'Disabled')}
        >
          Disable
        </Button>
      ) : (
        <Button
          size="compact-sm"
          disabled={isPending}
          loading={isPending}
          onClick={() => run(enable, 'Enabled')}
        >
          Enable
        </Button>
      )}
    </Group>
  );
}
```

`apps/console/src/app/work/schedules/schedule-list.tsx`:

```tsx
import type { WorkSpec } from '@agent-lcars/work';
import {
  Anchor,
  Table,
  TableTbody,
  TableTd,
  TableTh,
  TableThead,
  TableTr,
  Text,
} from '@mantine/core';

import { ScheduleActions, type ScheduleAction } from './schedule-actions';

export interface ScheduleView {
  id: string;
  cron: string;
  spec: WorkSpec;
  enabled: boolean;
  lastItemId?: string;
}

/** The `/work/schedules` list table: server-safe (no hooks), so the page
 *  can render it directly from the server-fetched `listSchedules` result. */
export function ScheduleList({
  schedules,
  enable,
  disable,
}: {
  schedules: ScheduleView[];
  enable: ScheduleAction;
  disable: ScheduleAction;
}) {
  if (schedules.length === 0) {
    return (
      <Text c="dimmed" size="sm">
        No schedules yet.
      </Text>
    );
  }

  return (
    <Table striped highlightOnHover verticalSpacing="xs" fz="sm">
      <TableThead>
        <TableTr>
          <TableTh>Title</TableTh>
          <TableTh>Cron</TableTh>
          <TableTh>Pipeline</TableTh>
          <TableTh>Repo</TableTh>
          <TableTh>Enabled</TableTh>
          <TableTh>Last item</TableTh>
          <TableTh />
        </TableTr>
      </TableThead>
      <TableTbody>
        {schedules.map((schedule) => (
          <TableTr key={schedule.id}>
            <TableTd>{schedule.spec.title}</TableTd>
            <TableTd>
              <code>{schedule.cron}</code>
            </TableTd>
            <TableTd>{schedule.spec.pipeline}</TableTd>
            <TableTd>{schedule.spec.target.repo}</TableTd>
            <TableTd>{schedule.enabled ? 'yes' : 'no'}</TableTd>
            <TableTd>
              {schedule.lastItemId ? (
                <Anchor href={`/work/${schedule.lastItemId}`} size="sm">
                  {schedule.lastItemId}
                </Anchor>
              ) : (
                <Text c="dimmed" size="sm">
                  never
                </Text>
              )}
            </TableTd>
            <TableTd>
              <ScheduleActions
                id={schedule.id}
                enabled={schedule.enabled}
                enable={enable}
                disable={disable}
              />
            </TableTd>
          </TableTr>
        ))}
      </TableTbody>
    </Table>
  );
}
```

`apps/console/src/app/work/schedules/schedule-create-form.tsx`:

```tsx
'use client';

import { parseCron, PIPELINES, ulid } from '@agent-lcars/work';
import {
  Button,
  Group,
  Select,
  Stack,
  Switch,
  Text,
  TextInput,
  Textarea,
} from '@mantine/core';
import { useState, useTransition } from 'react';

type CreateResult =
  [null, { id: string }] | [{ code: string; message: string }, null];

export type CreateScheduleAction = (input: {
  id: string;
  cron: string;
  spec: {
    title: string;
    description: string;
    pipeline: string;
    target: { repo: string };
  };
  enabled: boolean;
}) => Promise<CreateResult>;

const REFUSALS: Record<string, string> = {
  FORBIDDEN: 'no grant for that pipeline or repository',
};

/**
 * The `/work/schedules` create form. The id is minted client-side (`ulid`)
 * so a retried submission is idempotent -- the API answers 201 with the
 * existing schedule; the cron expression is checked client-side with the
 * same `parseCron` the server uses, so a typo is caught before the round
 * trip.
 */
export function ScheduleCreateForm({
  create,
  defaultRepo,
  pipelines = PIPELINES,
}: {
  create: CreateScheduleAction;
  defaultRepo: string;
  pipelines?: readonly string[];
}) {
  const [isPending, startTransition] = useTransition();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [repo, setRepo] = useState(defaultRepo);
  const [pipeline, setPipeline] = useState<string>(pipelines[0] ?? 'claude');
  const [cron, setCron] = useState('0 * * * *');
  const [enabled, setEnabled] = useState(true);
  const [error, setError] = useState<string | undefined>();

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(undefined);
    try {
      parseCron(cron);
    } catch (parseError) {
      setError(
        parseError instanceof Error
          ? parseError.message
          : 'must be a valid 5-field UTC cron expression',
      );
      return;
    }
    const id = ulid();
    startTransition(async () => {
      const [err] = await create({
        id,
        cron,
        spec: { title, description, pipeline, target: { repo } },
        enabled,
      });
      if (err) {
        setError(REFUSALS[err.code] ?? err.message);
        return;
      }
      setTitle('');
      setDescription('');
    });
  }

  return (
    <form onSubmit={submit} aria-label="Create schedule">
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
        <TextInput
          label="Cron (UTC, 5-field: min hour dom mon dow)"
          required
          value={cron}
          onChange={(e) => setCron(e.currentTarget.value)}
        />
        <Switch
          label="Enabled"
          checked={enabled}
          onChange={(e) => setEnabled(e.currentTarget.checked)}
        />
        {error ? (
          <Text c="red" size="sm">
            {error}
          </Text>
        ) : null}
        <Group justify="flex-end">
          <Button type="submit" loading={isPending}>
            Create schedule
          </Button>
        </Group>
      </Stack>
    </form>
  );
}
```

`apps/console/src/app/work/schedules/actions.ts`:

```ts
'use server';

import { createServerFunctionable } from '@orpc/next';

import { auth } from '@/auth';
import { controlPlaneRepository } from '@/lib/deployment';
import { verifyScheduleTickOidcToken } from '@/lib/github-actions-oidc';
import {
  createOrchestratorRuntime,
  createScheduleStore,
} from '@/lib/orchestrator-runtime';
import { scheduleRouter } from '@/lib/schedule-router';
import {
  authenticateWorkRequest,
  googleIdTokenVerifier,
} from '@/lib/work-auth';
import { workGrants, workMaxLiveRuns } from '@/lib/work-grants';
import type { WorkContext } from '@/lib/work-mint';
import { sessionsForRuns } from '@/lib/work-sessions';

async function context(): Promise<WorkContext> {
  const principal = await authenticateWorkRequest(
    new Request('https://console.local/'),
    {
      verifyGoogleIdToken: googleIdTokenVerifier('unused'),
      verifyScheduleTickOidcToken: (token) =>
        verifyScheduleTickOidcToken(token, controlPlaneRepository()),
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
    scheduleStore: createScheduleStore(),
    grants: workGrants,
    now: () => new Date(),
  };
}

const functionable = createServerFunctionable({ context });

const createScheduleFn = functionable(scheduleRouter.create);
const listSchedulesFn = functionable(scheduleRouter.list);
const enableScheduleFn = functionable(scheduleRouter.enable);
const disableScheduleFn = functionable(scheduleRouter.disable);

export async function createSchedule(
  input: Parameters<typeof createScheduleFn>[0],
) {
  return createScheduleFn(input);
}
export async function listSchedules(
  input: Parameters<typeof listSchedulesFn>[0],
) {
  return listSchedulesFn(input);
}
export async function enableSchedule(
  input: Parameters<typeof enableScheduleFn>[0],
) {
  return enableScheduleFn(input);
}
export async function disableSchedule(
  input: Parameters<typeof disableScheduleFn>[0],
) {
  return disableScheduleFn(input);
}
```

`apps/console/src/app/work/schedules/page.tsx`:

```tsx
import { PIPELINES } from '@agent-lcars/work';
import { Text } from '@mantine/core';
import { redirect } from 'next/navigation';
import { Suspense } from 'react';

import { auth } from '@/auth';
import { controlPlaneRepository } from '@/lib/deployment';

import { NavPageLoading, PageLoading } from '../../page-loading';
import { withConsolePageShell } from '../../with-console-page-shell';
import {
  createSchedule,
  disableSchedule,
  enableSchedule,
  listSchedules,
} from './actions';
import { ScheduleCreateForm } from './schedule-create-form';
import { ScheduleList } from './schedule-list';

async function SchedulesBody() {
  const [err, data] = await listSchedules({ limit: 200 });
  if (err) {
    return (
      <Text c="dimmed" size="sm">
        {err.code === 'UNAUTHORIZED'
          ? 'Your GitHub login has no work grant.'
          : `Could not load schedules: ${err.message}`}
      </Text>
    );
  }
  return (
    <>
      <ScheduleCreateForm
        create={createSchedule}
        defaultRepo={controlPlaneRepository()}
        pipelines={PIPELINES}
      />
      <ScheduleList
        schedules={data.schedules}
        enable={enableSchedule}
        disable={disableSchedule}
      />
    </>
  );
}

function SchedulesViewContent() {
  return (
    <Suspense fallback={<PageLoading rows={4} header={false} />}>
      <SchedulesBody />
    </Suspense>
  );
}

const SchedulesView = withConsolePageShell(SchedulesViewContent, {
  className: 'work-schedules-page-shell',
  current: 'work',
  title: 'Schedules',
  subtitle: 'Recurring native work',
});

async function SchedulesPageShell() {
  const session = await auth();
  if (!session) redirect('/login');
  return <SchedulesView />;
}

export default function SchedulesPage() {
  return (
    <Suspense
      fallback={
        <NavPageLoading
          current="work"
          title="Schedules"
          className="work-schedules-page-shell"
          rows={4}
        />
      }
    >
      <SchedulesPageShell />
    </Suspense>
  );
}
```

`apps/console/src/app/work/page.tsx` -- add a link to the new page. In
`WorkViewContent`, wrap the existing `<Suspense>` with the link above it:

```tsx
import { Anchor } from '@mantine/core';
// ...add to the existing '@mantine/core' import list rather than a new line

function WorkViewContent() {
  return (
    <>
      <Anchor href="/work/schedules" size="sm">
        Schedules →
      </Anchor>
      <Suspense fallback={<PageLoading rows={4} header={false} />}>
        <WorkBody />
      </Suspense>
    </>
  );
}
```

- [ ] **Step 4: Run** — `./tools/nx test @agent-lcars/console -- schedule-create-form schedule-list` → PASS; `./tools/nx typecheck @agent-lcars/console`; `pnpm exec prettier --check` on touched files.

- [ ] **Step 5: Commit**

```bash
git add apps/console/src/app/work/schedules apps/console/src/app/work/page.tsx
git commit -m "feat(console): /work/schedules — list, create, enable, disable

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BiTUeJCQByPUqRLZUpt3CD"
git push
```

---

### Task 7: The scheduled tick trigger workflow

**Files:**

- Create: `.github/workflows/work-schedules-tick.yml`
- Create: `tools/workflow-schedule-tick.test.sh`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**

- Consumes: `jlapenna/agent-lcars/.github/actions/request-control-plane@main`
  (existing action); `assertScheduleTickOidcClaims`'s expected claim shape
  (Task 4: audience `agent-lcars-work-schedules`, `job_workflow_ref`
  `.github/workflows/work-schedules-tick.yml@refs/heads/main`).
- Produces: a workflow that calls `POST
/api/work/v1/schedules/tick` every 5 minutes with an empty JSON body.

- [ ] **Step 1: Write the failing test**

```bash
# tools/workflow-schedule-tick.test.sh
#!/usr/bin/env bash
# The scheduled tick trigger must exist, run on a 5-minute cadence plus
# workflow_dispatch, request only id-token: write, and call the control
# plane at the schedules tick endpoint with the schedule-tick audience and
# an explicit empty-object payload (never a truly bodyless POST -- the
# tick procedure's input schema expects valid JSON). Pure text assertions
# on the YAML -- no git, no GitHub.
set -euo pipefail
cd "$(dirname "$0")/.."
fail=0
f=.github/workflows/work-schedules-tick.yml
[ -f "$f" ] || { echo "$f: missing"; exit 1; }
grep -q "cron: '\*/5 \* \* \* \*'" "$f" || { echo "$f: expected a 5-minute schedule"; fail=1; }
grep -q "workflow_dispatch:" "$f" || { echo "$f: missing workflow_dispatch trigger"; fail=1; }
grep -q "^permissions: {}$" "$f" || { echo "$f: top-level permissions must be {}"; fail=1; }
grep -q "id-token: write" "$f" || { echo "$f: job must grant id-token: write"; fail=1; }
grep -q "request-control-plane@main" "$f" || { echo "$f: must call request-control-plane"; fail=1; }
grep -q "endpoint: https://lcars.jlapenna.net/api/work/v1/schedules/tick" "$f" || { echo "$f: wrong endpoint"; fail=1; }
grep -q "audience: agent-lcars-work-schedules" "$f" || { echo "$f: wrong audience"; fail=1; }
grep -q "payload: '{}'" "$f" || { echo "$f: must POST an explicit empty JSON object"; fail=1; }
exit $fail
```

- [ ] **Step 2: Run to verify it fails** — `bash tools/workflow-schedule-tick.test.sh` → exits 1 (`missing`).

- [ ] **Step 3: Implement**

```yaml
# .github/workflows/work-schedules-tick.yml
name: Work Schedules Tick

# Mints a native work item for every enabled cron schedule's latest due
# slot. See
# docs/superpowers/specs/2026-08-23-native-work-items-design.md,
# "Sub-project 3: cron ingress".

on:
  schedule:
    - cron: '*/5 * * * *'
  workflow_dispatch:

permissions: {}

concurrency:
  group: work-schedules-tick
  cancel-in-progress: false

jobs:
  tick:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    permissions:
      id-token: write
    steps:
      - name: Invoke the schedule tick with GitHub Actions OIDC
        uses: jlapenna/agent-lcars/.github/actions/request-control-plane@main # latest
        with:
          endpoint: https://lcars.jlapenna.net/api/work/v1/schedules/tick
          audience: agent-lcars-work-schedules
          payload: '{}'
          timeout-seconds: '60'
```

In `.github/workflows/ci.yml`, add a step right after "Test worker
workflow anchor gates":

```yaml
- name: Test worker workflow anchor gates
  run: bash tools/workflow-anchor-gates.test.sh

- name: Test the work-schedules-tick workflow
  run: bash tools/workflow-schedule-tick.test.sh
```

- [ ] **Step 4: Run** — `bash tools/workflow-schedule-tick.test.sh` → PASS; `pnpm exec prettier --check .github/workflows/work-schedules-tick.yml .github/workflows/ci.yml`. Actionlint runs in CI (the "Validate GitHub Actions workflows" step already globs `.github/workflows/*.yml`) — no local install required, but reading the new file once against the pattern of `dispatch-reconcile.yml` (which it mirrors byte-for-byte in shape) is cheap insurance.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/work-schedules-tick.yml tools/workflow-schedule-tick.test.sh .github/workflows/ci.yml
git commit -m "ci(work): scheduled tick trigger for cron-ingressed work items

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BiTUeJCQByPUqRLZUpt3CD"
git push
```

---

### Task 8: Land the branch, then the real-path proof

- [ ] **Step 1: Land** — `pnpm verify` (or the fast layer per task, already
      run); open the PR with `--reviewer jlapenna`; watch CI (Verify, the
      Firestore-emulator contract run covering `ScheduleStore`, the OpenAPI
      drift check, `tools/workflow-schedule-tick.test.sh`); resolve review
      threads; squash-merge (admin merge permitted when the only block is the
      unattributed-changes approval rule). Confirm `main`'s `Verify` is green
      and the App Hosting rollout for the console completed.

- [ ] **Step 2: `work-create.yml` grows `schedule-create`/`schedule-disable`**
      so the real-path proof needs no browser session — same WIF identity the
      existing `create`/`get`/`cancel` actions use (its grant already covers
      `claude`, per `docs/native-work-smoke-runbook.md`'s "Source evidence").
      On a follow-up branch (this land task, not a new sub-project):

  In `.github/workflows/work-create.yml`, widen the `action` choice and
  add a `cron` input:

  ```yaml
  action:
    description: create, get, cancel, schedule-create, or schedule-disable
    required: false
    default: create
    type: choice
    options: [create, get, cancel, schedule-create, schedule-disable]
  ```

  ```yaml
  cron:
    description: schedule-create — 5-field UTC cron expression
    required: false
    default: ''
    type: string
  ```

  In the "Call the work API" step's `env:`, add `CRON: ${{ inputs.cron }}`.
  In its `run:` script, widen the id-required guard and the
  auto-generation guard to also cover `schedule-create`:

  ```bash
          if [ "$ACTION" != "create" ] && [ "$ACTION" != "schedule-create" ] && [ -z "$ITEM_ID" ]; then
            echo "::error::$ACTION needs an id"; exit 1
          fi
          if { [ "$ACTION" = "create" ] || [ "$ACTION" = "schedule-create" ]; } && [ -z "$ITEM_ID" ]; then
            ITEM_ID="$(node -e '
              const A = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
              let t = Date.now(), s = "";
              for (let i = 0; i < 10; i++) { s = A[t % 32] + s; t = Math.floor(t / 32); }
              const r = require("crypto").randomBytes(16);
              let x = "";
              for (let i = 0; i < 16; i++) x += A[r[i] % 32];
              process.stdout.write(s + x);
            ')"
          fi
  ```

  Add two new `case` branches alongside `create`/`get`/`cancel`:

  ```bash
            schedule-create)
              if [ -z "$TITLE" ] || [ -z "$DESCRIPTION" ] || [ -z "$CRON" ]; then
                echo "::error::schedule-create needs title, description, and cron"; exit 1
              fi
              body="$(jq -cn --arg c "$CRON" --arg t "$TITLE" --arg d "$DESCRIPTION" --arg r "$REPO" --arg p "$PIPELINE" \
                '{cron: $c, spec: {title: $t, description: $d, pipeline: $p, target: {repo: $r}}}')"
              status="$(call PUT "$CONSOLE_URL/api/work/v1/schedules/$ITEM_ID" "$body")"
              echo "PUT /api/work/v1/schedules/$ITEM_ID -> $status"; show
              [ "$status" = "201" ] || { echo "::error::work API returned $status"; exit 1; }
              {
                echo "## Schedule created"
                echo
                echo "- id: \`$ITEM_ID\`"
                echo "- cron: \`$CRON\`"
              } >> "$GITHUB_STEP_SUMMARY"
              ;;
            schedule-disable)
              status="$(call POST "$CONSOLE_URL/api/work/v1/schedules/$ITEM_ID/disable")"
              echo "POST /api/work/v1/schedules/$ITEM_ID/disable -> $status"; show
              case "$status" in
                200) echo "- disable $ITEM_ID -> $status" >> "$GITHUB_STEP_SUMMARY" ;;
                *) echo "::error::work API returned $status"; exit 1 ;;
              esac
              ;;
  ```

  Run `pnpm exec prettier --check .github/workflows/work-create.yml`;
  commit and push:

  ```bash
  git add .github/workflows/work-create.yml
  git commit -m "$(cat <<'EOF'
  ci(work): schedule-create and schedule-disable actions on work-create.yml

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01BiTUeJCQByPUqRLZUpt3CD
  EOF
  )"
  git push
  ```

Open this as its own small PR (touches only a workflow file already
covered by `.github/actions/published-actions.contract.test.mjs` and
actionlint in CI); merge it before Step 3.

- [ ] **Step 3: One recurring schedule, end to end**

1. Pick a cron matching a specific UTC minute roughly 10 minutes ahead:

   ```bash
   target="$(date -u -d '+10 minutes' +%M)"
   hour="$(date -u -d '+10 minutes' +%H)"
   echo "cron: $target $hour * * *"
   ```

2. Create the schedule:

   ```bash
   gh workflow run work-create.yml \
     -f action=schedule-create \
     -f title='Control-plane cron smoke' \
     -f description='Control-plane cron smoke. Do not change any file. End your response with: PARK cron-smoke — no work requested.' \
     -f repo=jlapenna/agent-lcars -f pipeline=claude \
     -f cron="$target $hour * * *"
   gh run watch "$(gh run list --workflow work-create.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
   ```

   Record the schedule id from the step summary.

3. Watch the tick mint it: `gh run list --workflow work-schedules-tick.yml --limit 3`; once a run lands after the target minute, `gh run watch <id>` and read its log — the `POST .../schedules/tick` response line names `minted: [{scheduleId, itemId}]` for this schedule.

4. `get` the minted item via `work-create.yml`:

   ```bash
   gh workflow run work-create.yml -f action=get -f id=<itemId>
   ```

   Expect `state: parked` once the claude run completes (the smoke's
   description ends in `PARK cron-smoke`), or `running` if the run is
   still in flight.

5. Disable the schedule so it does not re-fire:

   ```bash
   gh workflow run work-create.yml -f action=schedule-disable -f id=<scheduleId>
   ```

6. If any step fails: file it on #1502 with the run URL, do not paper
   over it — fix forward on a new branch.

- [ ] **Step 4: Write the runbook**

Append a "Sub-project 3: cron ingress" section to
`docs/native-work-smoke-runbook.md`, in the style of the existing
sections: the schedule id, its cron, the target minute, the
`work-schedules-tick.yml` run URL and its tick response line, the minted
item id and its `get` output, and the disable confirmation. Commit on a
follow-up branch, open a PR, merge it. Tick sub-project 3 on #1502 and
leave a comment naming the smoke run.

---

## Self-review

**Spec coverage:** resource + routes (Task 3, 5), schedule document +
`ScheduleStore` (Task 2), cron grammar (Task 1), tick semantics including
the deterministic slot id, skip/cap/grant rules (Task 5), auth for the
tick (Task 4), console page (Task 6), no CLI changes (nowhere touched),
OpenAPI regeneration (Task 3), proxy needs no change (documented in the
spec section; no proxy file touched), testing list (each task's Step 1;
workflow test in Task 7), real-path proof (Task 8).

**Placeholder scan:** Task 5's `schedule-router.ts` calls the single
shared `forbiddenReason` from `work-mint.ts` directly (no fork, per the
pre-execution review ruling) -- `create`'s pipeline-and-repo check and
`tick`'s per-schedule check are the same function, not two copies. Task
5's `work-router.ts` step says "unchanged from the current file" for
`get`/`list`/`cancel`/`redispatch` — those bodies already exist verbatim
in the repository today and are not being edited, only their free
functions' import source; nothing about their logic is left undefined.

**Type/shape consistency:** `WorkContext` (Task 5's `work-mint.ts`) is the
one definition both `work-router.ts` and `schedule-router.ts` import;
`MintOutcome`'s `kind` values (`forbidden`/`conflict`/`cap`/`existing`/
`minted`) are matched exhaustively in both `items.create` (Task 5) and
`schedules.tick` (Task 5); `Schedule`'s fields (Task 2) match
`scheduleViewSchema` (Task 3) and the router's `view()`/`writeSchedule`
calls (Task 5) field-for-field; `slotItemId`'s `Promise<string>` (Task 1)
is `await`ed at its one call site (Task 5's tick handler); `nextDueSlot`
(Task 1) is called with the same `CronSpec` `parseCron` just produced
(Task 5's `create` handler), and its `BAD_REQUEST` message matches the
one declared in `schedulesContract.create.errors` (Task 3).

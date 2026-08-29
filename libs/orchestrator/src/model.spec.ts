import { describe, expect, it } from 'vitest';

import {
  GITHUB_REPO_MAX_LENGTH,
  isGithubAnchor,
  isWorkAnchor,
  outboxEntrySchema,
  parsePersistedRun,
  RUN_ID_MAX_LENGTH,
  runQueueSchema,
  runSchema,
  taskIdSchema,
  taskKey,
  taskSchema,
  WORK_ID_RE,
  WORK_PAYLOAD_MAX_BYTES,
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

  it('accepts the longest legal GitHub repository name and rejects a longer one', () => {
    const longest = `${'o'.repeat(39)}/${'r'.repeat(100)}`;
    expect(longest).toHaveLength(GITHUB_REPO_MAX_LENGTH);
    expect(
      taskIdSchema.safeParse({ repo: longest, issue: Number.MAX_SAFE_INTEGER })
        .success,
    ).toBe(true);
    expect(
      taskIdSchema.safeParse({ repo: `${longest}x`, issue: 1 }).success,
    ).toBe(false);
  });
});

describe('taskKey', () => {
  it('is unchanged for GitHub anchors', () => {
    expect(taskKey({ repo: 'octo/example', issue: 7 })).toBe('octo/example#7');
  });

  it('prefixes native anchors with work:', () => {
    expect(taskKey({ workId: ULID })).toBe(`work:${ULID}`);
  });

  it('bounds every minted GitHub run ID, including maximal issue and generation suffixes', () => {
    const task = {
      repo: `${'o'.repeat(39)}/${'r'.repeat(100)}`,
      issue: Number.MAX_SAFE_INTEGER,
    };
    const runId = `${taskKey(task)}/r${Number.MAX_SAFE_INTEGER + 1}`;
    expect(runId).toHaveLength(RUN_ID_MAX_LENGTH);
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

  it('persists the longest minted GitHub run ID and its generated dependent IDs', () => {
    const task = {
      repo: `${'o'.repeat(39)}/${'r'.repeat(100)}`,
      issue: Number.MAX_SAFE_INTEGER,
    };
    // The terminal safe generation has the same 16-digit width as the
    // increment `mintRun` would produce from it, without creating an unsafe
    // next persisted task counter in this schema fixture.
    const runId = `${taskKey(task)}/r${Number.MAX_SAFE_INTEGER}`;
    expect(runId).toHaveLength(RUN_ID_MAX_LENGTH);

    expect(
      runSchema.safeParse({
        runId,
        task,
        state: 'pending',
        pipeline: 'claude',
        requestId: `retry:${runId}`,
        leaseExpiresAt: T,
        events: [{ at: T, to: 'pending', by: 'request' }],
        createdAt: T,
        updatedAt: T,
      }).success,
    ).toBe(true);
    expect(
      taskSchema.safeParse({
        task,
        activeRunId: runId,
        runCount: Number.MAX_SAFE_INTEGER,
        updatedAt: T,
      }).success,
    ).toBe(true);
    expect(
      outboxEntrySchema.safeParse({
        entryId: `dispatch/${runId}`,
        kind: 'dispatch-run',
        task,
        runId,
        state: 'pending',
        attempts: 0,
        createdAt: T,
        updatedAt: T,
      }).success,
    ).toBe(true);
  });

  // Missing fixture (final-review item 3/8): every other fixture above is
  // GitHub-anchored with no `work`, or (below) native-anchored with a
  // trivial `work`. Nothing here exercised a GITHUB-anchored task
  // carrying a real `WorkPayload`-shaped `work` -- the exact document
  // shape `work-from-github.ts`'s `workPayloadFromGithub` produces once a
  // GitHub-anchored task has one (sub-project 5). Sized right at the real
  // byte bound `truncatedDescription`'s byte-aware clamp (item 3) exists
  // to keep out of storage: a 3-bytes-per-character description (CJK)
  // packed with this fixture's other fields to land exactly on
  // WORK_PAYLOAD_MAX_BYTES (32,768) when serialized.
  it('parses a GitHub-anchored task carrying a work payload exactly at the real byte bound', () => {
    // '漢' is 3 bytes in UTF-8; 10,868 characters is the largest count
    // that, together with this fixture's origin/title/pipeline/target and
    // JSON structure, serializes to exactly 32,768 bytes -- one more
    // character would overflow WORK_PAYLOAD_MAX_BYTES.
    const description = '漢'.repeat(10_868);
    const work = {
      origin: { principal: 'github:jlapenna', channel: 'github' },
      spec: {
        title: 'Fix the thing',
        description,
        pipeline: 'claude',
        target: { repo: 'octo/example' },
      },
    };
    const bytes = new TextEncoder().encode(JSON.stringify(work)).length;
    expect(bytes).toBe(WORK_PAYLOAD_MAX_BYTES);

    const parsed = taskSchema.parse({
      task: { repo: 'octo/example', issue: 7 },
      runCount: 1,
      updatedAt: T,
      work,
    });
    expect(parsed.work).toEqual(work);
  });
});

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

  it('accepts a work payload whose serialized UTF-8 length is exactly 32,768 bytes', () => {
    // `{"blob":"` + n x's + `"}` = n + 11 bytes; n = 32_757 lands exactly on
    // the 32,768-byte limit.
    const work = { blob: 'x'.repeat(32_757) };
    expect(new TextEncoder().encode(JSON.stringify(work)).length).toBe(
      WORK_PAYLOAD_MAX_BYTES,
    );
    expect(() => taskSchema.parse({ ...base, work })).not.toThrow();
  });

  it('rejects a work payload whose serialized UTF-8 length is 32,769 bytes', () => {
    const work = { blob: 'x'.repeat(32_758) };
    expect(new TextEncoder().encode(JSON.stringify(work)).length).toBe(
      WORK_PAYLOAD_MAX_BYTES + 1,
    );
    expect(() => taskSchema.parse({ ...base, work })).toThrow();
  });

  it('counts UTF-8 bytes, not UTF-16 code units, for multi-byte characters', () => {
    // 11,000 code units but 33,000 UTF-8 bytes (each '漢' is 3 bytes) --
    // must be rejected even though `.length` (code units) is under the cap.
    const work = { blob: '漢'.repeat(11_000) };
    expect(work.blob.length).toBe(11_000);
    expect(() => taskSchema.parse({ ...base, work })).toThrow();
  });
});

describe('persisted Run projection / Run.queue', () => {
  const base = {
    runId: 'work:01M107KR3X6VDH7NZ4JDXZNSS2/r1',
    task: { workId: '01M107KR3X6VDH7NZ4JDXZNSS2' },
    state: 'pending' as const,
    pipeline: 'claude',
    requestId: 'req-1',
    leaseExpiresAt: '2026-08-27T00:00:00.000Z',
    events: [],
    createdAt: '2026-08-27T00:00:00.000Z',
    updatedAt: '2026-08-27T00:00:00.000Z',
  };

  it('strips unknown persisted fields while strictly validating known fields', () => {
    const persisted = { ...base, retiredField: 'old value' };
    expect(runSchema.safeParse(persisted).success).toBe(false);
    expect(parsePersistedRun(persisted)).toEqual(base);
    expect(() =>
      parsePersistedRun({ ...persisted, state: 'not-a-run-state' }),
    ).toThrow();
  });

  it('accepts a queued claim state', () => {
    const parsed = runSchema.parse({
      ...base,
      queue: { state: 'queued' },
    });
    expect(parsed.queue).toEqual({ state: 'queued' });
  });

  it('accepts a claimed state with claimedBy/tokenHash', () => {
    const claimed = {
      state: 'claimed' as const,
      claimedAt: '2026-08-27T00:05:00.000Z',
      claimedBy: 'runner-pike-1',
      tokenHash: 'a'.repeat(64),
    };
    expect(runQueueSchema.parse(claimed)).toEqual(claimed);
  });

  it('rejects a tokenHash that is not a 64-character hex sha256', () => {
    expect(() =>
      runQueueSchema.parse({ state: 'claimed', tokenHash: 'short' }),
    ).toThrow();
  });
});

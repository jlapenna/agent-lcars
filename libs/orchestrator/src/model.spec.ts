import { describe, expect, it } from 'vitest';

import {
  isGithubAnchor,
  isWorkAnchor,
  outboxEntrySchema,
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

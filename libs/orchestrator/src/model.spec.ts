import { describe, expect, it } from 'vitest';

import {
  GITHUB_REPO_MAX_LENGTH,
  isWorkAnchor,
  outboxEntrySchema,
  RUN_ID_MAX_LENGTH,
  RUN_PARAMS_MAX_BYTES,
  runQueueSchema,
  runSchema,
  taskDocumentSchema,
  taskIdSchema,
  taskKey,
  taskSchema,
  WORK_ID_RE,
  WORK_PARAM_TEXT_MAX_BYTES,
  WORK_PAYLOAD_MAX_BYTES,
} from './model';

const ULID = '01J5Z3K9QX8F0N2B4V6C8D1E3G';

describe('taskIdSchema', () => {
  it('keeps the GitHub anchor shape byte-for-byte', () => {
    const parsed = taskIdSchema.parse({ repo: 'octo/example', issue: 7 });
    expect(parsed).toEqual({ repo: 'octo/example', issue: 7 });
    expect(isWorkAnchor(parsed)).toBe(false);
  });

  it('accepts a native anchor keyed by workId', () => {
    const parsed = taskIdSchema.parse({ workId: ULID });
    expect(parsed).toEqual({ workId: ULID });
    expect(isWorkAnchor(parsed)).toBe(true);
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

describe('strict persisted-shape fixtures', () => {
  const T = '2026-08-15T12:00:00.000Z';

  it('rejects a Task document missing its Work payload', () => {
    expect(
      taskSchema.safeParse({
        task: { repo: 'octo/example', issue: 7 },
        activeRunId: 'octo/example#7/r1',
        runCount: 1,
        consecutiveLost: 0,
        updatedAt: T,
      }).success,
    ).toBe(false);
  });

  it('rejects a Run document missing requestSource or carrying infra history', () => {
    const base = {
      runId: 'octo/example#7/r1',
      task: { repo: 'octo/example', issue: 7 },
      state: 'running' as const,
      pipeline: 'claude',
      requestId: 'delivery-1',
      leaseExpiresAt: T,
      events: [{ at: T, to: 'pending' as const, by: 'request' as const }],
      createdAt: T,
      updatedAt: T,
    };
    expect(runSchema.safeParse(base).success).toBe(false);
    expect(
      runSchema.safeParse({
        ...base,
        requestSource: 'caller',
        events: [{ at: T, to: 'pending', by: 'infra' }],
      }).success,
    ).toBe(false);
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
        requestSource: 'auto-retry',
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
        consecutiveLost: 0,
        work: { spec: { title: 'maximal Work' } },
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
  // WORK_PAYLOAD_MAX_BYTES when serialized.
  it('parses a GitHub-anchored task carrying a work payload exactly at the real byte bound', () => {
    const description = multibyteDescriptionFilling(WORK_PAYLOAD_MAX_BYTES);
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
      consecutiveLost: 0,
      updatedAt: T,
      work,
    });
    expect(parsed.work).toEqual(work);
  });
});

describe('taskSchema work payload', () => {
  const T = '2026-08-15T12:00:00.000Z';
  const base = {
    task: { workId: ULID },
    runCount: 0,
    consecutiveLost: 0,
    updatedAt: T,
  };

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

  it("is a documented share of Firestore's 1 MiB document limit", () => {
    // The task document can hold two payloads (work and desiredRevision).
    expect(WORK_PAYLOAD_MAX_BYTES).toBe(262_144);
    expect(2 * WORK_PAYLOAD_MAX_BYTES).toBeLessThanOrEqual(1_048_576 / 2);
  });

  it('accepts a payload far past the retired 32 KiB bound', () => {
    expect(() =>
      taskSchema.parse({ ...base, work: { blob: 'x'.repeat(200_000) } }),
    ).not.toThrow();
  });

  it('accepts a work payload whose serialized UTF-8 length is exactly the bound', () => {
    // `{"blob":"` + n x's + `"}` = n + 11 bytes.
    const work = { blob: 'x'.repeat(WORK_PAYLOAD_MAX_BYTES - 11) };
    expect(new TextEncoder().encode(JSON.stringify(work)).length).toBe(
      WORK_PAYLOAD_MAX_BYTES,
    );
    expect(() => taskSchema.parse({ ...base, work })).not.toThrow();
  });

  it('rejects a work payload whose serialized UTF-8 length is one byte over the bound', () => {
    const work = { blob: 'x'.repeat(WORK_PAYLOAD_MAX_BYTES - 10) };
    expect(new TextEncoder().encode(JSON.stringify(work)).length).toBe(
      WORK_PAYLOAD_MAX_BYTES + 1,
    );
    expect(() => taskSchema.parse({ ...base, work })).toThrow();
  });

  it('counts UTF-8 bytes, not UTF-16 code units, for multi-byte characters', () => {
    // 100,000 code units but 300,000 UTF-8 bytes (each '漢' is 3 bytes) --
    // must be rejected even though `.length` (code units) is under the cap.
    const work = { blob: '漢'.repeat(100_000) };
    expect(work.blob.length).toBeLessThan(WORK_PAYLOAD_MAX_BYTES);
    expect(() => taskSchema.parse({ ...base, work })).toThrow();
  });
});

describe('runSchema params byte budget', () => {
  const base = {
    runId: 'work:01M107KR3X6VDH7NZ4JDXZNSS2/r1',
    task: { workId: '01M107KR3X6VDH7NZ4JDXZNSS2' },
    state: 'pending' as const,
    pipeline: 'claude',
    requestId: 'req-1',
    requestSource: 'caller' as const,
    leaseExpiresAt: '2026-08-15T12:00:00.000Z',
    events: [],
    createdAt: '2026-08-15T12:00:00.000Z',
    updatedAt: '2026-08-15T12:00:00.000Z',
  };
  // Two JSON quote bytes plus the characters fill one parameter exactly.
  const fullText = 'x'.repeat(WORK_PARAM_TEXT_MAX_BYTES - 2);

  it('keeps a reply and context far past the retired 16,384-character cap', () => {
    const params = { mode: 'reply', reply: fullText, context: fullText };
    expect(runSchema.parse({ ...base, params }).params).toEqual(params);
  });

  it('refuses one parameter past the runner per-string budget', () => {
    expect(() =>
      runSchema.parse({ ...base, params: { reply: `${fullText}x` } }),
    ).toThrow(/run parameter exceeds/u);
  });

  it('refuses a parameter record past its share of the run document', () => {
    const params = { a: fullText, b: fullText, c: fullText };
    expect(() => runSchema.parse({ ...base, params })).toThrow(
      new RegExp(`run parameters exceed ${RUN_PARAMS_MAX_BYTES}`, 'u'),
    );
  });
});

describe('persisted Run projection / Run.queue', () => {
  const base = {
    runId: 'work:01M107KR3X6VDH7NZ4JDXZNSS2/r1',
    task: { workId: '01M107KR3X6VDH7NZ4JDXZNSS2' },
    state: 'pending' as const,
    pipeline: 'claude',
    requestId: 'req-1',
    requestSource: 'caller' as const,
    leaseExpiresAt: '2026-08-27T00:00:00.000Z',
    events: [],
    createdAt: '2026-08-27T00:00:00.000Z',
    updatedAt: '2026-08-27T00:00:00.000Z',
  };

  it('rejects unknown fields instead of projecting them away', () => {
    const persisted = { ...base, retiredField: 'old value' };
    expect(runSchema.safeParse(persisted).success).toBe(false);
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

  it('round-trips a run whose transition history passed the former 64-event cap', () => {
    const events = Array.from({ length: 200 }, (_, i) => ({
      at: new Date(Date.UTC(2026, 7, 27, 0, 0, i)).toISOString(),
      to: i % 2 === 0 ? ('running' as const) : ('pending' as const),
      by: 'dispatch' as const,
    }));
    const stored = JSON.parse(JSON.stringify({ ...base, events }));
    const parsed = runSchema.parse(stored);
    expect(parsed.events).toHaveLength(200);
    expect(parsed.events).toEqual(events);
  });

  it('rejects a tokenHash that is not a 64-character hex sha256', () => {
    expect(() =>
      runQueueSchema.parse({ state: 'claimed', tokenHash: 'short' }),
    ).toThrow();
  });
});

/** A '漢'-dense description (3 UTF-8 bytes each) that makes the GitHub
 *  fixture payload below serialize to exactly `bytes`. */
function multibyteDescriptionFilling(bytes: number): string {
  const overhead = new TextEncoder().encode(
    JSON.stringify(githubFixtureWork('')),
  ).length;
  const room = bytes - overhead;
  const wide = Math.floor(room / 3);
  return '漢'.repeat(wide) + 'x'.repeat(room - wide * 3);
}

function githubFixtureWork(description: string) {
  return {
    origin: { principal: 'github:jlapenna', channel: 'github' },
    spec: {
      title: 'Fix the thing',
      description,
      pipeline: 'claude',
      target: { repo: 'octo/example' },
    },
  };
}

describe('taskDocumentSchema derived state (#3566)', () => {
  const task = {
    task: { workId: ULID },
    runCount: 1,
    consecutiveLost: 0,
    updatedAt: '2026-11-25T12:00:00.000Z',
    work: { origin: { principal: 'user:jlapenna' } },
  };

  it('reads a document with or without stored item state', () => {
    expect(taskDocumentSchema.parse({ task, revision: 3 })).toEqual({
      task,
      revision: 3,
    });
    expect(
      taskDocumentSchema.parse({
        task,
        revision: 3,
        derived: { state: 'parked', latestRunId: 'run-1', event: false },
      }).derived,
    ).toEqual({ state: 'parked', latestRunId: 'run-1', event: false });
  });

  it('reads stopped and event sort keys and ignores fields it does not know', () => {
    expect(
      taskDocumentSchema.parse({
        task,
        revision: 3,
        derived: {
          state: 'failed',
          event: true,
          stoppedAt: '2026-11-25T12:00:00.000Z',
          eventAt: '2026-11-25T12:00:00.000Z',
          fromANewerWriter: 1,
        },
      }).derived,
    ).toEqual({
      state: 'failed',
      event: true,
      stoppedAt: '2026-11-25T12:00:00.000Z',
      eventAt: '2026-11-25T12:00:00.000Z',
    });
  });

  it('rejects malformed stored item state', () => {
    for (const derived of [
      { state: '', event: false },
      { state: 'parked' },
      { state: 'parked', event: false, stoppedAt: 'yesterday' },
    ])
      expect(() =>
        taskDocumentSchema.parse({ task, revision: 3, derived }),
      ).toThrow();
  });
});

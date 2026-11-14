import { describe, expect, it } from 'vitest';

import {
  clawWorkSpecSchema,
  isSourceManagedWork,
  PIPELINES,
  readStoredWorkSpec,
  STORED_PIPELINES,
  storedClawWorkSpec,
  WORK_DESCRIPTION_MAX,
  workOriginSchema,
  workPayloadSchema,
  workSpecSchema,
} from './spec';

const spec = {
  title: 'Add a health endpoint',
  description: 'Expose GET /healthz returning 200.',
  pipeline: 'claude',
  priority: 'normal',
  target: { repo: 'jlapenna/agent-lcars' },
};

describe('workSpecSchema', () => {
  it('defaults historical or omitted priority to normal and validates the closed vocabulary', () => {
    const { priority: _priority, ...old } = spec;
    expect(workSpecSchema.parse(old).priority).toBe('normal');
    for (const priority of ['urgent', 'normal', 'background']) {
      expect(workSpecSchema.parse({ ...old, priority }).priority).toBe(
        priority,
      );
    }
    expect(() =>
      workSpecSchema.parse({ ...old, priority: 'superurgent' }),
    ).toThrow();
  });
  it('keeps fallback opt-in, ordered and restricted to distinct alternative providers', () => {
    expect(workSpecSchema.parse(spec)).not.toHaveProperty('fallbackPipelines');
    expect(
      workSpecSchema.parse({
        ...spec,
        fallbackPipelines: ['opencode', 'codex'],
      }).fallbackPipelines,
    ).toEqual(['opencode', 'codex']);
    expect(
      workSpecSchema.parse({ ...spec, fallbackPipelines: [] })
        .fallbackPipelines,
    ).toEqual([]);
    for (const fallbackPipelines of [
      ['claude'],
      ['codex', 'codex'],
      ['gemini'],
      ['codex', 'opencode', 'claude'],
    ])
      expect(() =>
        workSpecSchema.parse({ ...spec, fallbackPipelines }),
      ).toThrow();
  });
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
    expect(PIPELINES).toEqual(['claude', 'codex', 'opencode', 'agy']);
  });

  it('requires target.repo in owner/name form', () => {
    expect(() => workSpecSchema.parse({ ...spec, target: {} })).toThrow();
    expect(() =>
      workSpecSchema.parse({ ...spec, target: { repo: 'no-slash' } }),
    ).toThrow();
  });

  it('keeps an issue anchor out of the repository-only target', () => {
    expect(() =>
      workSpecSchema.parse({
        ...spec,
        target: { repo: 'jlapenna/agent-lcars', issue: 1652 },
      }),
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

describe('workOriginSchema', () => {
  it('accepts the github channel', () => {
    expect(
      workOriginSchema.parse({
        principal: 'github:jlapenna',
        channel: 'github',
      }).channel,
    ).toBe('github');
  });

  it('accepts a slack origin carrying a thread address', () => {
    expect(
      workOriginSchema.parse({
        principal: 'svc:sprinkles-lcars-bot',
        channel: 'slack',
        thread: 'T0123/C0456/1788673935.123456',
      }).thread,
    ).toBe('T0123/C0456/1788673935.123456');
  });

  it('still accepts an origin with no thread', () => {
    expect(
      workOriginSchema.parse({ principal: 'user:jlapenna', channel: 'console' })
        .thread,
    ).toBeUndefined();
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

describe('readStoredWorkSpec', () => {
  const base = { title: 'T', description: 'd' };

  it('reads each stored shape into title, pipeline and target repository', () => {
    expect(
      readStoredWorkSpec({
        ...base,
        pipeline: 'claude',
        target: { repo: 'octo/example' },
      }),
    ).toEqual({ title: 'T', pipeline: 'claude', repo: 'octo/example' });
    expect(
      readStoredWorkSpec({
        ...base,
        pipeline: 'goose',
        priority: 'background',
        target: { repo: 'octo/jobs' },
        jobOccurrence: 'a'.repeat(64),
      }),
    ).toEqual({ title: 'T', pipeline: 'goose', repo: 'octo/jobs' });
    expect(
      readStoredWorkSpec({
        ...base,
        pipeline: 'inbox-summary',
        priority: 'background',
        sourceKey: 'octo/example#1',
      }),
    ).toEqual({ title: 'T', pipeline: 'inbox-summary' });
    expect(readStoredWorkSpec({ ...base, ...clawSpec })).toEqual({
      title: 'Claw investigation adhoc:01J5Z3K9QX8F0N2B4V6C8D1E3G',
      pipeline: 'claw-investigator',
    });
  });

  it('names every stored pipeline', () => {
    expect(STORED_PIPELINES).toEqual([
      'claude',
      'codex',
      'opencode',
      'agy',
      'goose',
      'inbox-summary',
      'handoff-summary',
      'claw-investigator',
    ]);
  });

  it('rejects a value matching no stored shape', () => {
    expect(readStoredWorkSpec({ ...base, pipeline: 'claude' })).toBeUndefined();
    expect(readStoredWorkSpec(undefined)).toBeUndefined();
  });
});

const clawSpec = {
  title: 'Claw investigation adhoc:01J5Z3K9QX8F0N2B4V6C8D1E3G',
  description: 'Read-only claw investigation.',
  pipeline: 'claw-investigator',
  priority: 'background',
  operation: 'investigate:v1',
  sourceKey: 'adhoc:01J5Z3K9QX8F0N2B4V6C8D1E3G',
};

describe('clawWorkSpecSchema', () => {
  const origin = { principal: 'user:jlapenna', channel: 'console' };

  it('stores a target-less background investigation', () => {
    expect(clawWorkSpecSchema.parse(clawSpec)).toEqual(clawSpec);
    expect(storedClawWorkSpec({ origin, spec: clawSpec })).toEqual(clawSpec);
  });

  it('is source-managed, so public mutation routes refuse it', () => {
    expect(isSourceManagedWork({ origin, spec: clawSpec })).toBe(true);
  });

  it.each([
    ['a target', { target: { repo: 'octo/example' } }],
    ['another priority', { priority: 'normal' }],
    ['another operation', { operation: 'oncall-investigate:v1' }],
    // The immutable spec never holds a round's question.
    ['a question', { input: { question: 'q' } }],
  ])('rejects %s', (_name, change) => {
    expect(
      clawWorkSpecSchema.safeParse({ ...clawSpec, ...change }).success,
    ).toBe(false);
  });

  it('is never a public coding spec, and other shapes are never claw', () => {
    expect(workSpecSchema.safeParse(clawSpec).success).toBe(false);
    expect(storedClawWorkSpec({ origin, spec })).toBeUndefined();
    expect(storedClawWorkSpec(undefined)).toBeUndefined();
  });
});

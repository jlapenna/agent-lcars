import { describe, expect, it } from 'vitest';

import {
  PIPELINES,
  WORK_DESCRIPTION_MAX,
  workOriginSchema,
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

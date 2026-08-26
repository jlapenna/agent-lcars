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

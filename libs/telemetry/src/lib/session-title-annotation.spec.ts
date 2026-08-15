import { describe, expect, it } from 'vitest';

import { parseSessionTitleAnnotationV1 } from './session-title-annotation';

const valid = {
  version: 1,
  sessionId: 'session-title-1',
  updatedAt: '2026-08-15T10:00:00.000Z',
  title: 'Native annotation title',
};

describe('parseSessionTitleAnnotationV1', () => {
  it('accepts the exact v1 envelope and normalizes its title', () => {
    expect(
      parseSessionTitleAnnotationV1(
        { ...valid, title: '  A\n title\twith irregular whitespace  ' },
        'session-title-1',
      ),
    ).toEqual({ ...valid, title: 'A title with irregular whitespace' });
  });

  it('uses the existing 80-character title normalization policy', () => {
    const annotation = parseSessionTitleAnnotationV1(
      { ...valid, title: 'x'.repeat(100) },
      'session-title-1',
    );

    expect(annotation?.title).toHaveLength(80);
    expect(annotation?.title.endsWith('…')).toBe(true);
  });

  it.each([
    ['missing key', { version: 1, sessionId: 'session-title-1', title: 'x' }],
    ['unknown key', { ...valid, extra: true }],
    ['wrong type', { ...valid, version: '1' }],
    ['unsupported version', { ...valid, version: 2 }],
    ['unsafe id', { ...valid, sessionId: '../outside' }],
    ['mismatched id', { ...valid, sessionId: 'other-session' }],
    ['invalid date', { ...valid, updatedAt: '2026-02-30T10:00:00Z' }],
    ['non-ISO date', { ...valid, updatedAt: 'August 15, 2026' }],
    ['blank title', { ...valid, title: ' \n\t ' }],
  ])('rejects a %s envelope', (_reason, value) => {
    expect(
      parseSessionTitleAnnotationV1(value, 'session-title-1'),
    ).toBeUndefined();
  });

  it('rejects an unsafe filename-derived id before comparing the envelope', () => {
    expect(
      parseSessionTitleAnnotationV1(valid, '../session-title-1'),
    ).toBeUndefined();
  });

  it('rejects hostile reflective input without escaping the unknown boundary', () => {
    const hostile = new Proxy(valid, {
      ownKeys: () => {
        throw new Error('hostile reflection');
      },
    });

    expect(
      parseSessionTitleAnnotationV1(hostile, 'session-title-1'),
    ).toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';

import { parseSessionStatusAnnotationV1 } from './session-status-annotation';

const valid = {
  version: 1,
  sessionId: 'session-status-1',
  updatedAt: '2026-08-16T10:00:00.000Z',
  status: 'waiting on CI for #1247',
};

describe('parseSessionStatusAnnotationV1', () => {
  it('accepts the exact v1 envelope and normalizes its status', () => {
    expect(
      parseSessionStatusAnnotationV1(
        { ...valid, status: '  A\n status\twith irregular whitespace  ' },
        'session-status-1',
      ),
    ).toEqual({ ...valid, status: 'A status with irregular whitespace' });
  });

  it('uses the existing 80-character title normalization policy', () => {
    const annotation = parseSessionStatusAnnotationV1(
      { ...valid, status: 'x'.repeat(100) },
      'session-status-1',
    );

    expect(annotation?.status).toHaveLength(80);
    expect(annotation?.status.endsWith('…')).toBe(true);
  });

  it.each([
    ['missing key', { version: 1, sessionId: 'session-status-1', status: 'x' }],
    ['unknown key', { ...valid, extra: true }],
    ['wrong type', { ...valid, version: '1' }],
    ['unsupported version', { ...valid, version: 2 }],
    ['unsafe id', { ...valid, sessionId: '../outside' }],
    ['mismatched id', { ...valid, sessionId: 'other-session' }],
    ['invalid date', { ...valid, updatedAt: '2026-02-30T10:00:00Z' }],
    ['non-ISO date', { ...valid, updatedAt: 'August 16, 2026' }],
    ['blank status', { ...valid, status: ' \n\t ' }],
    // A title envelope is a DIFFERENT shape (a `title` key, not `status`) —
    // this is the whole point of a dedicated envelope rather than a v2 of
    // the title one: the two channels' files must never parse as each
    // other's, even though both are otherwise identical four-key v1
    // envelopes.
    [
      'a title envelope (wrong field name)',
      {
        version: 1,
        sessionId: 'session-status-1',
        updatedAt: '2026-08-16T10:00:00.000Z',
        title: 'Not a status',
      },
    ],
  ])('rejects a %s envelope', (_reason, value) => {
    expect(
      parseSessionStatusAnnotationV1(value, 'session-status-1'),
    ).toBeUndefined();
  });

  it('rejects an unsafe filename-derived id before comparing the envelope', () => {
    expect(
      parseSessionStatusAnnotationV1(valid, '../session-status-1'),
    ).toBeUndefined();
  });

  it('rejects hostile reflective input without escaping the unknown boundary', () => {
    const hostile = new Proxy(valid, {
      ownKeys: () => {
        throw new Error('hostile reflection');
      },
    });

    expect(
      parseSessionStatusAnnotationV1(hostile, 'session-status-1'),
    ).toBeUndefined();
  });
});

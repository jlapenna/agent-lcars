import { buildSessionWrite, claudeCodeAdapter } from '@agent-lcars/telemetry';
import { FieldValue } from '@google-cloud/firestore';
import { describe, expect, it } from 'vitest';

import { hookEventPayload, isTransientFirestoreError } from './hook-store';

it('explicitly deletes missing bridge and checkout fields from a merged Firestore map', () => {
  const [summary] = claudeCodeAdapter.reduce([
    JSON.stringify({
      type: 'user',
      sessionId: 'session-a',
      timestamp: '2026-10-16T21:00:00.000Z',
      message: { role: 'user', content: [] },
    }),
  ]);
  const payload = hookEventPayload(buildSessionWrite(summary, 'live'));
  expect(payload.deliverables).toMatchObject({
    claudeSessionId: FieldValue.delete(),
    publicationCheckouts: FieldValue.delete(),
  });
});

describe('isTransientFirestoreError', () => {
  it('retries network, contention, quota, and auth failures', () => {
    for (const code of [2, 4, 8, 10, 14, 16]) {
      expect(isTransientFirestoreError({ code })).toBe(true);
    }
    expect(isTransientFirestoreError(new Error('socket hang up'))).toBe(true);
  });

  it('drops permanent failures', () => {
    for (const code of [3, 5, 6, 7, 9, 11, 12, 13]) {
      expect(isTransientFirestoreError({ code })).toBe(false);
    }
  });
});

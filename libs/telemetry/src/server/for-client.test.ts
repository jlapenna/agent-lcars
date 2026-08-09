import { GeoPoint, Timestamp } from '@google-cloud/firestore';
import { describe, expect, it } from 'vitest';

import { forClient } from './for-client';

describe('forClient', () => {
  it('dehydrates Firestore values and strips metadata at every depth', () => {
    const timestamp = Timestamp.fromDate(new Date('2026-08-09T12:00:00Z'));
    const result = forClient({
      timestamp,
      date: new Date('2026-08-09T12:01:00Z'),
      point: new GeoPoint(42.36, -71.06),
      metadata: { internal: true },
      nested: { metadata: { internal: true }, timestamp },
    });

    expect(result).toEqual({
      timestamp: '2026-08-09T12:00:00.000Z',
      date: '2026-08-09T12:01:00.000Z',
      point: { latitude: 42.36, longitude: -71.06, __type: 'GeoPoint' },
      nested: { timestamp: '2026-08-09T12:00:00.000Z' },
    });
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it('never lets an unknown class instance cross the boundary', () => {
    class InternalFirestoreValue {}

    const result = forClient({
      valid: 'yes',
      unsafe: new InternalFirestoreValue(),
    });

    expect(result).toEqual({ valid: 'yes' });
  });
});

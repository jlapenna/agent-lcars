import { describe, expect, it } from 'vitest';

import {
  assertEmptyReconcileBody,
  HostedReconcileRequestError,
  parseReconcileBearerToken,
} from './control-plane-reconcile-request';

describe('control-plane reconcile request parsing', () => {
  it('accepts the scheduler bearer and an empty body', () => {
    expect(parseReconcileBearerToken('Bearer scheduler-token')).toBe(
      'scheduler-token',
    );
    expect(() => assertEmptyReconcileBody(' \n')).not.toThrow();
  });

  it.each([null, '', 'Basic scheduler-token', 'Bearer '])(
    'rejects a malformed scheduler authorization header',
    (header) => {
      expect(() => parseReconcileBearerToken(header)).toThrow(
        HostedReconcileRequestError,
      );
    },
  );

  it('rejects an unexpected reconcile payload', () => {
    expect(() => assertEmptyReconcileBody('{}')).toThrow(
      HostedReconcileRequestError,
    );
  });
});

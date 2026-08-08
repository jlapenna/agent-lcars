import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';

import proxy from './proxy';

describe('console proxy public control-plane routes', () => {
  it('lets non-browser control-plane callers reach their own authentication', () => {
    for (const path of [
      '/api/control-plane/completion',
      '/api/control-plane/reconcile',
      '/api/control-plane/webhook',
      '/api/control-plane/webhook/process',
    ]) {
      const request = new NextRequest(
        `https://agent-console.supersprinkles.racing${path}`,
        { method: 'POST' },
      );

      expect(proxy(request).status).toBe(200);
    }
  });
});

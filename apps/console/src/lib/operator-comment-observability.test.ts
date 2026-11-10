import { logger } from '@agent-lcars/logging';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { recordOperatorComment } from './operator-comment-observability';

describe('recordOperatorComment', () => {
  afterEach(() => vi.restoreAllMocks());

  it('logs only the bounded census contract', () => {
    const structured = vi
      .spyOn(logger, 'structured')
      .mockImplementation(() => undefined);

    recordOperatorComment('posted');
    recordOperatorComment('rejected_token');

    expect(structured.mock.calls).toEqual([
      [
        'info',
        'LCARS operator comment outcome',
        { component: 'lcars-operator-comment', outcome: 'posted' },
        { enrich: false },
      ],
      [
        'warn',
        'LCARS operator comment outcome',
        { component: 'lcars-operator-comment', outcome: 'rejected_token' },
        { enrich: false },
      ],
    ]);
  });
});

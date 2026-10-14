import { describe, expect, it } from 'vitest';

import { arcRunnerCount, isRunnerOnline } from './runner-status-contract';

const pod = (kind: string, lane: string, state: string) => ({
  kind,
  lane,
  state,
});

describe('arcRunnerCount', () => {
  it('counts ARC pods online and in all, never direct agent Jobs', () => {
    expect(
      arcRunnerCount([
        pod('arc', 'ci', 'busy'),
        pod('arc', 'ci', 'idle'),
        pod('arc', 'ci', 'online'),
        pod('arc', 'e2e', 'draining'),
        pod('arc', 'e2e', 'starting'),
        pod('arc', 'e2e', 'offline'),
        pod('direct', 'direct', 'busy'),
      ]),
    ).toEqual({ online: 4, total: 6 });
  });

  it('narrows to the lanes a page shows', () => {
    expect(
      arcRunnerCount(
        [pod('arc', 'ci', 'busy'), pod('arc', 'e2e', 'idle')],
        [{ lane: 'e2e' }],
      ),
    ).toEqual({ online: 1, total: 1 });
  });

  it('is unknown without runner rows rather than zero', () => {
    expect(arcRunnerCount(undefined)).toBeUndefined();
    expect(arcRunnerCount([])).toEqual({ online: 0, total: 0 });
  });
});

describe('isRunnerOnline', () => {
  it('treats only starting and offline pods as down', () => {
    expect(
      ['starting', 'idle', 'busy', 'online', 'draining', 'offline'].map(
        isRunnerOnline,
      ),
    ).toEqual([false, true, true, true, true, false]);
  });
});

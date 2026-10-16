import { describe, expect, it } from 'vitest';

import { workReadWarnings } from './work-workspace';

describe('workReadWarnings', () => {
  it('reports every source once the read completed', () => {
    expect(workReadWarnings({})).toEqual({
      warnings: [],
      sourcesChecked: true,
    });
  });

  it('warns when the read failed', () => {
    expect(
      workReadWarnings({ error: { code: 'INTERNAL', message: 'timeout' } }),
    ).toEqual({
      warnings: ['Work API unavailable: timeout'],
      sourcesChecked: true,
    });
  });

  it('warns when a later page failed', () => {
    expect(
      workReadWarnings({
        stoppedOn: { code: 'INTERNAL', message: 'page 3 failed' },
      }),
    ).toEqual({
      warnings: ['Work API stopped reading older work: page 3 failed'],
      sourcesChecked: true,
    });
  });

  it('claims nothing without the Work grant or a read', () => {
    const silent = { warnings: [], sourcesChecked: false };
    expect(
      workReadWarnings({ error: { code: 'UNAUTHORIZED', message: 'no' } }),
    ).toEqual(silent);
    expect(workReadWarnings(undefined)).toEqual(silent);
  });
});

import { parseDispatchMarker } from '@agent-lcars/dispatch-contracts';
import { afterEach, describe, expect, it } from 'vitest';

import {
  E2E_RUN_IDS,
  setPopulatedFixtures,
  workflowRun,
} from './e2e-github-fixtures';

describe('workflowRun', () => {
  afterEach(() => {
    setPopulatedFixtures(false);
  });

  it('serves the single-run lookup for a known run id, carrying the dispatch marker', () => {
    setPopulatedFixtures(true);
    const run = workflowRun(E2E_RUN_IDS.running);
    expect(run?.id).toBe(E2E_RUN_IDS.running);
    expect(run?.status).toBe('in_progress');
    // `run-binding.ts`'s completion binder and `orchestrator-terminal-runs.ts`
    // both key off `display_title` carrying a parseable dispatch marker --
    // this is the fixture data those callers actually consume.
    expect(parseDispatchMarker(run?.display_title)).not.toBeUndefined();
  });

  it('404s (returns undefined) for an unknown run id', () => {
    setPopulatedFixtures(true);
    expect(workflowRun(999_999_999)).toBeUndefined();
  });

  it('does not serve curated fixture runs when populated mode is off', () => {
    setPopulatedFixtures(false);
    expect(workflowRun(E2E_RUN_IDS.running)).toBeUndefined();
  });
});

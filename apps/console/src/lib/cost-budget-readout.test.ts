import { beforeEach, describe, expect, it, vi } from 'vitest';

const archive = vi.hoisted(() => vi.fn());
vi.mock('./session-archive', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./session-archive')>()),
  getSessionArchive: archive,
}));
import {
  configureTestWatchedRepos,
  TEST_HOME_REPOSITORY,
} from '../test-support/watched-repos';
import { costBudgetResponse } from './cost-budget-readout';
import { aggregateSessionSpend } from './session-spend';
import type { WorkPrincipal } from './work-auth';
const principal: WorkPrincipal = {
  principal: 'svc:reader',
  subject: 'reader@example.com',
  scopes: new Set(['costs.reader']),
  pipelines: [],
  via: 'google',
};
const request = (query = '?days=30') =>
  new Request(`https://console.test/api/work/v1/costs/budget${query}`);
describe('operator Costs readout', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    configureTestWatchedRepos([TEST_HOME_REPOSITORY]);
    vi.stubEnv('AGENT_LCARS_COST_BUDGET_USD', '100');
    vi.stubEnv('AGENT_LCARS_COST_WARNING_PERCENT', '80');
    archive.mockResolvedValue({
      available: true,
      spend: aggregateSessionSpend([]),
    });
  });
  it('requires the narrow read scope and a fixed valid selection before reading', async () => {
    expect((await costBudgetResponse(request(), undefined)).status).toBe(403);
    expect(
      (
        await costBudgetResponse(request(), {
          ...principal,
          scopes: new Set(['work.reader']),
        })
      ).status,
    ).toBe(403);
    for (const query of [
      '',
      '?days=0',
      '?days=91',
      '?days=30&days=1',
      '?days=30&extra=yes',
      '?days=30&repo=',
      '?days=30&q=%20',
      '?days=30&repo=not/watched',
    ])
      expect((await costBudgetResponse(request(query), principal)).status).toBe(
        400,
      );
    expect(archive).not.toHaveBeenCalled();
  });
  it('passes the complete fixed selection through the real Costs parser', async () => {
    const params = new URLSearchParams({
      days: '1h',
      source: 'cli',
      repo: `${TEST_HOME_REPOSITORY.owner}/${TEST_HOME_REPOSITORY.name}`,
      agent: 'codex',
      issue: '42',
      q: 'needle',
    });
    const response = await costBudgetResponse(request(`?${params}`), principal);
    expect(response.status).toBe(200);
    const { owner, name } = TEST_HOME_REPOSITORY;
    expect(archive).toHaveBeenCalledWith(
      {
        days: 1 / 24,
        source: 'cli',
        repo: { owner, name },
        agent: 'codex',
        issueNumber: 42,
        q: 'needle',
      },
      { includeSpend: true },
    );
  });
  it.each([
    [0, true, 1, 'unavailable'],
    [85, true, 1, 'warning'],
    [110, true, 1, 'exceeded'],
    [10, false, 0, 'below-warning'],
  ])(
    'uses the shared assessment for known %s with incomplete=%s and unpriced=%s',
    async (known, limited, unpriced, assessment) => {
      const spend = aggregateSessionSpend([]);
      spend.coverageLimited = limited;
      spend.totals = {
        ...spend.totals,
        costUsd: known,
        reportedCostUsd: Math.max(0, known - 2),
        estimatedCostUsd: Math.min(2, known),
        unpricedSessions: unpriced,
      };
      archive.mockResolvedValue({ available: true, spend });
      const response = await costBudgetResponse(
        request('?days=30&source=cli'),
        principal,
      );
      expect(response.headers.get('Cache-Control')).toContain('no-store');
      expect(await response.json()).toMatchObject({
        version: 1,
        selection: { days: '30', source: 'cli' },
        basis: 'selected cumulative-session subtotal',
        assessment,
        coverageComplete: !limited && unpriced === 0,
        totals: {
          knownUsd: known,
          estimatedUsd: Math.min(2, known),
          reportedUsd: Math.max(0, known - 2),
        },
      });
      expect(archive).toHaveBeenCalledWith(
        expect.objectContaining({ days: 30 }),
        { includeSpend: true },
      );
    },
  );
  it('does not turn missing budget or unavailable evidence into a healthy state', async () => {
    vi.stubEnv('AGENT_LCARS_COST_BUDGET_USD', '');
    expect(
      await (await costBudgetResponse(request(), principal)).json(),
    ).toMatchObject({ assessment: 'unconfigured' });
    archive.mockResolvedValue({ available: false });
    expect(
      await (await costBudgetResponse(request(), principal)).json(),
    ).toMatchObject({ assessment: 'unavailable', coverageComplete: false });
    archive.mockRejectedValue(new Error('private datastore detail'));
    const failed = await costBudgetResponse(request(), principal);
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain('private');
  });
});

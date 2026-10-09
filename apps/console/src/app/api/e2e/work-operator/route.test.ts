// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { workGrants } from '@/lib/work-grants';

import { POST } from './route';

beforeEach(() => {
  vi.stubEnv('E2E_TESTING', 'true');
  vi.stubEnv('AGENT_LCARS_WORK_GRANTS', '[]');
  for (const name of ['K_SERVICE', 'K_REVISION', 'CLOUD_RUN_JOB'])
    vi.stubEnv(name, undefined);
});
afterEach(() => vi.unstubAllEnvs());
const request = () =>
  new Request('https://console.test/api/e2e/work-operator', {
    method: 'POST',
    body: JSON.stringify({ revoked: false }),
  });

it('refuses grant mutation outside hermetic E2E', async () => {
  vi.stubEnv('E2E_TESTING', 'false');
  expect((await POST(request())).status).toBe(403);
  expect(workGrants()).toEqual([]);
});
it.each(['K_SERVICE', 'K_REVISION', 'CLOUD_RUN_JOB'])(
  'refuses grant mutation on Cloud Run (%s)',
  async (name) => {
    vi.stubEnv(name, 'deployed');
    expect((await POST(request())).status).toBe(403);
    expect(workGrants()).toEqual([]);
  },
);

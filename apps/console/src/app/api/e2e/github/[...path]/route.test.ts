// @vitest-environment node
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetGithubActionFixture } from '@/lib/e2e-github-fixtures';
import { SESSION_EXPIRY_WORKFLOW_FILE } from '@/lib/github-actions-oidc';

import { POST } from './route';

const REPOSITORY = 'fixture/controller';
const EXPIRY = { ref: 'main', inputs: { item: 'work:fixture/r1' } };

beforeEach(() => {
  vi.stubEnv('E2E_TESTING', 'true');
  vi.stubEnv('AGENT_LCARS_CONTROL_PLANE_REPOSITORY', REPOSITORY);
  resetGithubActionFixture();
});
afterEach(() => {
  resetGithubActionFixture();
  vi.unstubAllEnvs();
});

function dispatch(workflow: string, body: unknown, repository = REPOSITORY) {
  const path = `repos/${repository}/actions/workflows/${workflow}/dispatches`;
  return POST(
    new NextRequest(`http://localhost/api/e2e/github/${path}`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ path: path.split('/') }) },
  );
}

describe('hermetic GitHub workflow dispatch boundary', () => {
  it('accepts the supported native session-expiry dispatch', async () => {
    expect((await dispatch(SESSION_EXPIRY_WORKFLOW_FILE, EXPIRY)).status).toBe(
      204,
    );
  });

  it.each([
    { ref: 'feature', inputs: EXPIRY.inputs },
    { ref: 'main', inputs: {} },
    { ref: 'main', inputs: { item: '' } },
  ])('rejects malformed session-expiry input: %j', async (body) => {
    expect((await dispatch(SESSION_EXPIRY_WORKFLOW_FILE, body)).status).toBe(
      422,
    );
  });

  it('rejects provider workflow dispatch even with the retired broker token envelope', async () => {
    const response = await dispatch('agent-codex.yml', {
      ref: 'main',
      inputs: {
        issue: '7',
        mode: 'implement',
        broker_intent_id: 'fixture/controller#7/r1',
        broker_generation: '1',
        broker_dispatch_token: 'fixture-only-retired-token',
      },
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ message: 'Not Found' });
  });

  it('does not accept unknown workflows with session-expiry input', async () => {
    expect((await dispatch('unknown.yml', EXPIRY)).status).toBe(404);
  });

  it('does not dispatch session expiry in another repository', async () => {
    expect(
      (
        await dispatch(
          SESSION_EXPIRY_WORKFLOW_FILE,
          EXPIRY,
          'another/controller',
        )
      ).status,
    ).toBe(404);
  });

  it('does not expose the fixture outside E2E', async () => {
    vi.stubEnv('E2E_TESTING', 'false');
    expect((await dispatch(SESSION_EXPIRY_WORKFLOW_FILE, EXPIRY)).status).toBe(
      404,
    );
  });
});

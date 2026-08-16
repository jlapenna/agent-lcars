import crypto from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { enqueueGitHubWebhook } = vi.hoisted(() => ({
  enqueueGitHubWebhook: vi.fn(),
}));

vi.mock('@/lib/hosted-webhook-queue', () => ({ enqueueGitHubWebhook }));

import { POST } from './route';

const SECRET = 'test-webhook-secret';
const HOME_REPO = 'jlapenna/agent-lcars';

function sign(rawBody: string): string {
  return `sha256=${crypto
    .createHmac('sha256', SECRET)
    .update(rawBody)
    .digest('hex')}`;
}

function webhookRequest(
  repositoryFullName: string,
  headers: Record<string, string> = {},
): Request {
  const rawBody = JSON.stringify({
    repository: { full_name: repositoryFullName },
  });
  return new Request('https://console.test/api/control-plane/webhook', {
    method: 'POST',
    body: rawBody,
    headers: {
      'x-github-delivery': 'e29e8f0a-7530-11f0-9f9d-8f1bc3e88820',
      'x-github-event': 'issues',
      'x-hub-signature-256': sign(rawBody),
      ...headers,
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env['AGENT_LCARS_WEBHOOK_SECRET'] = SECRET;
  enqueueGitHubWebhook.mockResolvedValue({
    outcome: 'queued',
    deliveryId: 'e29e8f0a-7530-11f0-9f9d-8f1bc3e88820',
  });
});

afterEach(() => {
  delete process.env['AGENT_LCARS_WEBHOOK_SECRET'];
  delete process.env['AGENT_LCARS_CONTROL_PLANE_REPOSITORIES'];
});

describe('POST /api/control-plane/webhook repository admission', () => {
  it('admits the control-plane repository by default', async () => {
    const response = await POST(webhookRequest(HOME_REPO));
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      outcome: 'queued',
    });
    expect(enqueueGitHubWebhook).toHaveBeenCalledTimes(1);
  });

  it('ignores a repository outside the control plane by default', async () => {
    const response = await POST(webhookRequest('someone-else/other-repo'));
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      outcome: 'ignored',
      reason: 'repository outside control plane',
    });
    expect(enqueueGitHubWebhook).not.toHaveBeenCalled();
  });

  it('admits a second repository once the allow-list env var lists it', async () => {
    process.env['AGENT_LCARS_CONTROL_PLANE_REPOSITORIES'] =
      `${HOME_REPO},other-org/other-repo`;

    const response = await POST(webhookRequest('other-org/other-repo'));
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      outcome: 'queued',
    });
    expect(enqueueGitHubWebhook).toHaveBeenCalledTimes(1);
  });

  it('still refuses a repository not in the configured allow-list', async () => {
    process.env['AGENT_LCARS_CONTROL_PLANE_REPOSITORIES'] =
      `${HOME_REPO},other-org/other-repo`;

    const response = await POST(webhookRequest('unlisted-org/unlisted-repo'));
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      outcome: 'ignored',
      reason: 'repository outside control plane',
    });
    expect(enqueueGitHubWebhook).not.toHaveBeenCalled();
  });
});

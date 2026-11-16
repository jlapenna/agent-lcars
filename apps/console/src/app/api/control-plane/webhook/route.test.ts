import crypto from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { enqueueGitHubWebhook } = vi.hoisted(() => ({
  enqueueGitHubWebhook: vi.fn(),
}));

vi.mock('@/lib/hosted-webhook-queue', () => ({ enqueueGitHubWebhook }));

import { GITHUB_WEBHOOK_MAX_BYTES, POST } from './route';

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
  delete process.env['AGENT_LCARS_WATCHED_REPOS'];
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

  it.each(['check_run', 'pull_request_review', 'pull_request_review_thread'])(
    'admits the %s projection signal event for a configured repository',
    async (event) => {
      const response = await POST(
        webhookRequest(HOME_REPO, { 'x-github-event': event }),
      );
      expect(response.status).toBe(202);
      expect(enqueueGitHubWebhook).toHaveBeenCalledTimes(1);
    },
  );

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
    process.env['AGENT_LCARS_WATCHED_REPOS'] = JSON.stringify([
      { owner: 'jlapenna', name: 'agent-lcars' },
      { owner: 'other-org', name: 'other-repo' },
    ]);

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
    process.env['AGENT_LCARS_WATCHED_REPOS'] = JSON.stringify([
      { owner: 'jlapenna', name: 'agent-lcars' },
      { owner: 'other-org', name: 'other-repo' },
    ]);

    const response = await POST(webhookRequest('unlisted-org/unlisted-repo'));
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      outcome: 'ignored',
      reason: 'repository outside control plane',
    });
    expect(enqueueGitHubWebhook).not.toHaveBeenCalled();
  });

  it.each([HOME_REPO, 'jlapenna/repo-tools'])(
    'ignores push events for %s without queueing work',
    async (repo) => {
      const response = await POST(
        webhookRequest(repo, { 'x-github-event': 'push' }),
      );
      expect(response.status).toBe(202);
      await expect(response.json()).resolves.toMatchObject({
        outcome: 'ignored',
        reason: 'unsupported event',
      });
      expect(enqueueGitHubWebhook).not.toHaveBeenCalled();
    },
  );
});

describe('POST /api/control-plane/webhook body bound', () => {
  function endlessBody() {
    const chunk = new Uint8Array(1024 * 1024);
    const state = { pulled: 0, cancelled: false };
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        state.pulled += chunk.byteLength;
        controller.enqueue(chunk);
      },
      cancel() {
        state.cancelled = true;
      },
    });
    return { stream, state };
  }

  it("rejects a body over GitHub's 25 MB cap without buffering the rest", async () => {
    const { stream, state } = endlessBody();
    const response = await POST(
      new Request('https://console.test/api/control-plane/webhook', {
        method: 'POST',
        body: stream,
        duplex: 'half',
        headers: {
          'x-github-delivery': 'e29e8f0a-7530-11f0-9f9d-8f1bc3e88820',
          'x-github-event': 'issues',
          'x-hub-signature-256': 'sha256=00',
        },
      } as RequestInit),
    );
    expect(response.status).toBe(413);
    expect(state.cancelled).toBe(true);
    expect(state.pulled).toBeLessThanOrEqual(
      GITHUB_WEBHOOK_MAX_BYTES + 3 * 1024 * 1024,
    );
    expect(enqueueGitHubWebhook).not.toHaveBeenCalled();
  });

  it('rejects a declared Content-Length over the cap before reading', async () => {
    const { stream, state } = endlessBody();
    const response = await POST(
      new Request('https://console.test/api/control-plane/webhook', {
        method: 'POST',
        body: stream,
        duplex: 'half',
        headers: {
          'content-length': String(GITHUB_WEBHOOK_MAX_BYTES + 1),
          'x-github-event': 'issues',
        },
      } as RequestInit),
    );
    expect(response.status).toBe(413);
    expect(state.pulled).toBeLessThanOrEqual(2 * 1024 * 1024);
  });

  it('still admits a signed body larger than the old implicit default', async () => {
    const rawBody = JSON.stringify({
      repository: { full_name: HOME_REPO },
      padding: 'p'.repeat(2 * 1024 * 1024),
    });
    const response = await POST(
      new Request('https://console.test/api/control-plane/webhook', {
        method: 'POST',
        body: rawBody,
        headers: {
          'x-github-delivery': 'e29e8f0a-7530-11f0-9f9d-8f1bc3e88820',
          'x-github-event': 'issues',
          'x-hub-signature-256': sign(rawBody),
        },
      }),
    );
    expect(response.status).not.toBe(413);
    expect(enqueueGitHubWebhook).toHaveBeenCalledTimes(1);
  });
});

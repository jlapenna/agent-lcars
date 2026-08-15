import { beforeEach, describe, expect, it, vi } from 'vitest';

const { verifyCompletionOidcToken, completeHostedWorker } = vi.hoisted(() => ({
  verifyCompletionOidcToken: vi.fn(),
  completeHostedWorker: vi.fn(),
}));

vi.mock('@/lib/github-actions-oidc', () => ({ verifyCompletionOidcToken }));
vi.mock('@/lib/hosted-completion', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/hosted-completion')>()),
  completeHostedWorker,
}));

import { HostedCompletionInputError } from '@/lib/hosted-completion';

import { POST } from './route';

const body = {
  issue: 736,
  generation: 2,
  intentId: 'intent:abc123',
  token: 'abcdefghijklmnop',
  workflow: 'codex.yml',
};
const identity = {
  repository: 'jlapenna/agent-lcars',
  repositoryId: 1_307_149_765,
  runId: 93_099_054_125,
  workflow: 'codex.yml',
};

function request(token?: string, requestBody: unknown = body): Request {
  return new Request('https://console.test/api/control-plane/completion', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(requestBody),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  verifyCompletionOidcToken.mockResolvedValue(identity);
  completeHostedWorker.mockResolvedValue({
    issue: 736,
    workerRunId: 93_099_054_125,
    workflow: 'codex.yml',
  });
});

describe('POST /api/control-plane/completion', () => {
  it('rejects a request without a GitHub Actions OIDC bearer token', async () => {
    const response = await POST(request());
    expect(response.status).toBe(401);
    expect(completeHostedWorker).not.toHaveBeenCalled();
  });

  it('processes a completion under the signed worker identity', async () => {
    const response = await POST(request('signed-token'));
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(verifyCompletionOidcToken).toHaveBeenCalledWith(
      'signed-token',
      'jlapenna/agent-lcars',
    );
    expect(completeHostedWorker).toHaveBeenCalledWith({ identity, body });
  });

  it('rejects invalid completion bindings without a retryable response', async () => {
    completeHostedWorker.mockRejectedValue(
      new HostedCompletionInputError('bad binding'),
    );
    const response = await POST(request('signed-token'));
    expect(response.status).toBe(400);
  });

  it('rejects malformed JSON before invoking the controller', async () => {
    const response = await POST(
      new Request('https://console.test/api/control-plane/completion', {
        method: 'POST',
        headers: { Authorization: 'Bearer signed-token' },
        body: '{',
      }),
    );
    expect(response.status).toBe(400);
    expect(completeHostedWorker).not.toHaveBeenCalled();
  });

  it.each([
    ['an extra field', { ...body, attacker: true }],
    ['a wrong issue type', { ...body, issue: '736' }],
    ['a wrong generation type', { ...body, generation: '2' }],
    ['a malformed token', { ...body, token: 'short' }],
  ])(
    'rejects %s before invoking the controller',
    async (_label, requestBody) => {
      const response = await POST(request('signed-token', requestBody));
      expect(response.status).toBe(400);
      expect(completeHostedWorker).not.toHaveBeenCalled();
    },
  );

  it('returns a transient failure without changing the error contract', async () => {
    completeHostedWorker.mockRejectedValue(new Error('controller unavailable'));
    const response = await POST(request('signed-token'));
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: 'Hosted completion failed',
    });
  });

  it('does not process a completion when OIDC claims fail', async () => {
    verifyCompletionOidcToken.mockRejectedValue(new Error('wrong workflow'));
    const response = await POST(request('wrong-token'));
    expect(response.status).toBe(401);
    expect(completeHostedWorker).not.toHaveBeenCalled();
  });
});

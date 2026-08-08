import crypto from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { CompletionRunNotTerminalError, reconcileCompletedWorker } = vi.hoisted(
  () => ({
    CompletionRunNotTerminalError: class CompletionRunNotTerminalError extends Error {},
    reconcileCompletedWorker: vi.fn(),
  }),
);

vi.mock('@/lib/hosted-completion-reconcile', () => ({
  CompletionRunNotTerminalError,
  reconcileCompletedWorker,
}));

import { POST } from './route';

const SECRET = 'completion-reconcile-test-secret';
const PAYLOAD = {
  repository: 'jlapenna/agent-lcars',
  repositoryId: 1_307_149_765,
  issue: 736,
  workerRunId: 93_099_054_125,
};

function request({ signed = true }: { signed?: boolean } = {}): Request {
  const body = JSON.stringify(PAYLOAD);
  const signature = `sha256=${crypto
    .createHmac('sha256', SECRET)
    .update(body)
    .digest('hex')}`;
  return new Request(
    'https://console.test/api/control-plane/completion/reconcile',
    {
      method: 'POST',
      headers: {
        'x-agent-lcars-signature-256': signed ? signature : 'sha256=bad',
      },
      body,
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('AGENT_LCARS_WEBHOOK_SECRET', SECRET);
  reconcileCompletedWorker.mockResolvedValue({
    issue: 736,
    workerRunId: 93_099_054_125,
  });
});

describe('POST /api/control-plane/completion/reconcile', () => {
  it('rejects a payload whose raw bytes do not match the signature', async () => {
    const response = await POST(request({ signed: false }));
    expect(response.status).toBe(401);
    expect(reconcileCompletedWorker).not.toHaveBeenCalled();
  });

  it('reconciles the authenticated worker payload', async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(reconcileCompletedWorker).toHaveBeenCalledWith(PAYLOAD);
    await expect(response.json()).resolves.toEqual({
      issue: 736,
      workerRunId: 93_099_054_125,
    });
  });

  it('asks Cloud Tasks to retry until the worker is terminal', async () => {
    reconcileCompletedWorker.mockRejectedValueOnce(
      new CompletionRunNotTerminalError(),
    );
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('5');
  });
});

import assert from 'node:assert/strict';

import { test } from 'vitest';

import { processCompletionCallback } from './completion-processing';
import { admitHostedDelivery } from './hosted-admission';

test('admission injects storage without reading CLI configuration', async () => {
  const port = { name: 'port' };
  let received: Record<string, unknown> | undefined;
  await admitHostedDelivery(
    {
      normalized: { kind: 'ignored', reason: 'not-selected' },
      githubToken: 'token',
      isPullRequest: false,
      transportRunId: 42,
      authorityOwner: 'hosted:42',
    },
    {
      storagePortFactory: () => port as never,
      process: async (input) => {
        received = input as unknown as Record<string, unknown>;
      },
    },
  );
  assert.equal(received?.transportRunId, 42);
  assert.equal((received?.storagePortFactory as () => unknown)(), port);
});

test('completion processing validates and sends the typed callback payload', async () => {
  let sent: Record<string, unknown> | undefined;
  const result = await processCompletionCallback(
    {
      issue: '822',
      generation: '2',
      intentId: 'intent-2',
      token: 'dispatch-token',
      workflow: 'codex.yml',
      oidcRequestUrl: 'https://oidc.example/token',
      oidcRequestToken: 'oidc-token',
      outcome: 'pull-request',
      outcomeReference: '900',
    },
    {
      send: async (input) => {
        sent = input as unknown as Record<string, unknown>;
      },
    },
  );
  assert.deepEqual(result.payload.outcomeReference, {
    kind: 'pull-request',
    number: 900,
  });
  assert.equal((sent?.payload as { generation: number }).generation, 2);
});

test('completion processing rejects an outcome reference without a PR outcome', async () => {
  await assert.rejects(
    processCompletionCallback(
      {
        issue: '822',
        generation: '2',
        intentId: 'intent-2',
        token: 'dispatch-token',
        workflow: 'codex.yml',
        oidcRequestUrl: 'https://oidc.example/token',
        oidcRequestToken: 'oidc-token',
        outcome: 'park',
        outcomeReference: '900',
      },
      { send: async () => undefined },
    ),
    /requires a positive PR number/u,
  );
});

import assert from 'node:assert/strict';

import {
  COMPLETION_OIDC_AUDIENCE,
  HOSTED_COMPLETION_URL,
} from '@agent-lcars/dispatch-contracts';
import { test } from 'vitest';

import { sendHostedCompletion } from './hosted-completion-client.js';

const payload = {
  issue: 736,
  generation: 4,
  intentId: 'intent:hosted-completion',
  token: 'dispatch_token_123456',
  workflow: 'codex.yml',
  outcome: 'pull-request' as const,
  outcomeReference: { kind: 'pull-request' as const, number: 776 },
};

test('mints the exact audience and posts the binding with the signed token', async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    requests.push({ url: String(input), init: init ?? {} });
    if (requests.length === 1) {
      return new Response(JSON.stringify({ value: 'signed-worker-token' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ issue: 736 }), { status: 200 });
  };

  await sendHostedCompletion({
    payload,
    oidcRequestUrl: 'https://token.actions.githubusercontent.com/id-token?x=1',
    oidcRequestToken: 'request-token',
    fetchImpl,
    sleep: async () => undefined,
  });

  assert.equal(requests.length, 2);
  const oidcUrl = new URL(requests[0].url);
  assert.equal(oidcUrl.searchParams.get('x'), '1');
  assert.equal(oidcUrl.searchParams.get('audience'), COMPLETION_OIDC_AUDIENCE);
  assert.equal(requests[0].init.method, 'GET');
  assert.equal(
    new Headers(requests[0].init.headers).get('Authorization'),
    'Bearer request-token',
  );
  assert.equal(requests[1].url, HOSTED_COMPLETION_URL);
  assert.equal(requests[1].init.method, 'POST');
  assert.equal(
    new Headers(requests[1].init.headers).get('Authorization'),
    'Bearer signed-worker-token',
  );
  assert.deepEqual(JSON.parse(String(requests[1].init.body)), payload);
});

test('retries a retryable hosted failure without minting another token', async () => {
  let tokenRequests = 0;
  let completionRequests = 0;
  const delays: number[] = [];
  const fetchImpl = async (input: string | URL | Request) => {
    if (
      String(input).startsWith('https://token.actions.githubusercontent.com')
    ) {
      tokenRequests += 1;
      return new Response(JSON.stringify({ value: 'signed-worker-token' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    completionRequests += 1;
    return new Response('', { status: completionRequests === 1 ? 503 : 200 });
  };

  await sendHostedCompletion({
    payload,
    oidcRequestUrl: 'https://token.actions.githubusercontent.com/id-token',
    oidcRequestToken: 'request-token',
    fetchImpl,
    sleep: async (milliseconds) => {
      delays.push(milliseconds);
    },
  });

  assert.equal(tokenRequests, 1);
  assert.equal(completionRequests, 2);
  assert.deepEqual(delays, [1_000]);
});

test('retries a transient OIDC token failure before posting completion', async () => {
  let tokenRequests = 0;
  let completionRequests = 0;
  const delays: number[] = [];
  const fetchImpl = async (input: string | URL | Request) => {
    if (
      String(input).startsWith('https://token.actions.githubusercontent.com')
    ) {
      tokenRequests += 1;
      if (tokenRequests === 1) return new Response('', { status: 503 });
      return new Response(JSON.stringify({ value: 'signed-worker-token' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    completionRequests += 1;
    return new Response('', { status: 200 });
  };

  await sendHostedCompletion({
    payload,
    oidcRequestUrl: 'https://token.actions.githubusercontent.com/id-token',
    oidcRequestToken: 'request-token',
    fetchImpl,
    sleep: async (milliseconds) => {
      delays.push(milliseconds);
    },
  });

  assert.equal(tokenRequests, 2);
  assert.equal(completionRequests, 1);
  assert.deepEqual(delays, [1_000]);
});

test('does not retry a rejected binding or expose either token', async () => {
  let completionRequests = 0;
  const fetchImpl = async (input: string | URL | Request) => {
    if (
      String(input).startsWith('https://token.actions.githubusercontent.com')
    ) {
      return new Response(JSON.stringify({ value: 'signed-worker-token' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    completionRequests += 1;
    return new Response('secret diagnostic body', { status: 400 });
  };

  await assert.rejects(
    sendHostedCompletion({
      payload,
      oidcRequestUrl: 'https://token.actions.githubusercontent.com/id-token',
      oidcRequestToken: 'request-token',
      fetchImpl,
      sleep: async () => undefined,
    }),
    (error: Error) => {
      assert.match(error.message, /HTTP 400/u);
      assert.doesNotMatch(error.message, /signed-worker-token/u);
      assert.doesNotMatch(error.message, /request-token/u);
      assert.doesNotMatch(error.message, /secret diagnostic body/u);
      return true;
    },
  );
  assert.equal(completionRequests, 1);
});

test('rejects a non-HTTPS completion endpoint before requesting OIDC', async () => {
  let requests = 0;
  await assert.rejects(
    sendHostedCompletion({
      payload,
      completionUrl: 'http://example.test/api/control-plane/completion',
      oidcRequestUrl: 'https://token.actions.githubusercontent.com/id-token',
      oidcRequestToken: 'request-token',
      fetchImpl: async () => {
        requests += 1;
        return new Response('', { status: 200 });
      },
    }),
    /must be an HTTPS URL/u,
  );
  assert.equal(requests, 0);
});

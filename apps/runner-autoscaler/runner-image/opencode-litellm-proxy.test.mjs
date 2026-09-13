import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import test from 'vitest';

import {
  createLiteLLMProxy,
  resolvePhysicalModel,
} from './opencode-litellm-proxy.mjs';

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

test('maps the selected LiteLLM deployment to its canonical physical model', () => {
  const data = [
    {
      model_name: 'qwen3.8-flash-next',
      litellm_params: { model: 'openai/qwen3.8-flash-next' },
      model_info: { id: 'deployment-1' },
    },
    {
      model_name: 'default',
      litellm_params: { model: 'openai/default' },
      model_info: { id: 'deployment-1' },
    },
  ];
  assert.equal(
    resolvePhysicalModel({ data }, 'deployment-1'),
    'qwen3.8-flash-next',
  );
});

test('fails closed when a deployment maps ambiguously', () => {
  const data = [
    {
      model_name: 'route-a',
      litellm_params: { model: 'openai/model-a' },
      model_info: { id: 'deployment-1' },
    },
    {
      model_name: 'route-b',
      litellm_params: { model: 'openai/model-b' },
      model_info: { id: 'deployment-1' },
    },
  ];
  assert.equal(resolvePhysicalModel({ data }, 'deployment-1'), undefined);
});

test('records the deployment selected on an authenticated response', async () => {
  const root = await mkdtemp(join(tmpdir(), 'opencode-litellm-proxy-'));
  const outputFile = join(root, 'resolved-model');
  const upstream = createServer((request, response) => {
    assert.equal(request.headers.authorization, 'Bearer virtual-key');
    if (request.url === '/model/info') {
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          data: [
            {
              model_name: 'qwen3.8-flash-next',
              litellm_params: { model: 'openai/qwen3.8-flash-next' },
              model_info: { id: 'deployment-1' },
            },
            {
              model_name: 'default',
              litellm_params: { model: 'openai/default' },
              model_info: { id: 'deployment-1' },
            },
          ],
        }),
      );
      return;
    }
    response.setHeader('x-litellm-model-id', 'deployment-1');
    response.end('{"ok":true}');
  });
  const upstreamURL = await listen(upstream);
  const proxy = createLiteLLMProxy({ upstream: upstreamURL, outputFile });
  const proxyURL = await listen(proxy);

  try {
    const response = await fetch(`${proxyURL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer virtual-key',
        'content-type': 'application/json',
      },
      body: '{"model":"default"}',
    });
    assert.equal(response.status, 200);
    assert.equal(await readFile(outputFile, 'utf8'), 'qwen3.8-flash-next\n');
  } finally {
    await Promise.all([
      new Promise((resolve) => upstream.close(resolve)),
      new Promise((resolve) => proxy.close(resolve)),
    ]);
    await rm(root, { recursive: true, force: true });
  }
});

test('preserves inference when deployment metadata is unavailable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'opencode-litellm-proxy-'));
  const outputFile = join(root, 'resolved-model');
  const upstream = createServer((request, response) => {
    if (request.url === '/model/info') {
      response.end('not json');
      return;
    }
    response.setHeader('x-litellm-model-id', 'deployment-1');
    response.end('{"ok":true}');
  });
  const upstreamURL = await listen(upstream);
  const proxy = createLiteLLMProxy({ upstream: upstreamURL, outputFile });
  const proxyURL = await listen(proxy);

  try {
    const response = await fetch(`${proxyURL}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer virtual-key' },
      body: '{"model":"default"}',
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), '{"ok":true}');
  } finally {
    await Promise.all([
      new Promise((resolve) => upstream.close(resolve)),
      new Promise((resolve) => proxy.close(resolve)),
    ]);
    await rm(root, { recursive: true, force: true });
  }
});

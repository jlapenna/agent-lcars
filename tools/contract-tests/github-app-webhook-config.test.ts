import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  configureAppWebhook,
  createAppJwt,
  readWebhookSecret,
} from '../configure-github-app-webhook.mjs';

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
});
const privatePem = privateKey
  .export({ type: 'pkcs8', format: 'pem' })
  .toString();

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('GitHub App webhook configuration', () => {
  it('signs a short-lived RS256 App JWT with the configured client ID', () => {
    const now = Date.parse('2026-08-08T10:00:00.000Z');
    const jwt = createAppJwt('Iv1.client', privatePem, now);
    const [header, payload, signature] = jwt.split('.');

    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({
      alg: 'RS256',
      typ: 'JWT',
    });
    expect(JSON.parse(Buffer.from(payload, 'base64url').toString())).toEqual({
      iss: 'Iv1.client',
      iat: Math.floor(now / 1000) - 60,
      exp: Math.floor(now / 1000) + 540,
    });
    expect(
      crypto.verify(
        'RSA-SHA256',
        Buffer.from(`${header}.${payload}`),
        publicKey,
        Buffer.from(signature, 'base64url'),
      ),
    ).toBe(true);
  });

  it('sets the secret without returning it and verifies active subscriptions', async () => {
    const webhookSecret = 'never-return-this-secret';
    const webhookUrl = 'https://console.test/api/control-plane/webhook';
    const fetchImpl = vi.fn(
      async (url: string | URL, options?: RequestInit) => {
        const path = new URL(String(url)).pathname;
        if (path === '/app' && !options?.method) {
          return response({
            slug: 'agent-lcars',
            events: ['issues', 'issue_comment', 'pull_request'],
            hook_attributes: { active: true, url: webhookUrl },
          });
        }
        return response({ url: webhookUrl, content_type: 'json' });
      },
    );

    const result = await configureAppWebhook({
      clientId: 'Iv1.client',
      privateKey: privatePem,
      webhookSecret,
      webhookUrl,
      fetchImpl,
    });
    expect(result).toEqual({
      app: 'agent-lcars',
      active: true,
      url: webhookUrl,
      contentType: 'json',
      events: ['issue_comment', 'issues', 'pull_request'],
    });
    const patch = fetchImpl.mock.calls.find(
      ([url, options]) =>
        new URL(String(url)).pathname === '/app/hook/config' &&
        options?.method === 'PATCH',
    );
    expect(JSON.parse(String(patch?.[1]?.body))).toEqual({
      url: webhookUrl,
      content_type: 'json',
      secret: webhookSecret,
      insecure_ssl: '0',
    });
    expect(JSON.stringify(result)).not.toContain(webhookSecret);
    expect(
      fetchImpl.mock.calls.map(([url, options]) => ({
        path: new URL(String(url)).pathname,
        method: options?.method ?? 'GET',
      })),
    ).toEqual([
      { path: '/app', method: 'GET' },
      { path: '/app/hook/config', method: 'PATCH' },
      { path: '/app/hook/config', method: 'GET' },
    ]);
  });

  it('reads the HMAC secret from GCP instead of a repository secret', async () => {
    const workflow = await fs.readFile(
      '.github/workflows/configure-github-app-webhook.yml',
      'utf8',
    );

    expect(workflow).toContain('google-github-actions/auth@v3');
    expect(workflow).toContain('gcloud secrets versions access latest');
    expect(workflow).toContain('--out-file="$webhook_secret_file"');
    expect(workflow).not.toMatch(/WEBHOOK_SECRET="\$\(/u);
    expect(workflow).not.toContain('secrets.AGENT_LCARS_WEBHOOK_SECRET');
  });

  it('preserves every webhook-secret byte read from Secret Manager', async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'agent-lcars-webhook-secret-'),
    );
    const secretFile = path.join(directory, 'secret');
    try {
      await fs.writeFile(secretFile, 'leading-and-trailing\n');
      await expect(readWebhookSecret(secretFile)).resolves.toBe(
        'leading-and-trailing\n',
      );
    } finally {
      await fs.rm(directory, { recursive: true });
    }
  });

  it('fails loudly when GitHub still has the webhook disabled', async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      if (new URL(String(url)).pathname === '/app') {
        return response({
          slug: 'agent-lcars',
          events: ['issues', 'issue_comment', 'pull_request'],
          hook_attributes: { active: false },
        });
      }
      return response({
        url: 'https://console.test/api/control-plane/webhook',
        content_type: 'json',
      });
    });

    await expect(
      configureAppWebhook({
        clientId: 'Iv1.client',
        privateKey: privatePem,
        webhookSecret: 'secret',
        webhookUrl: 'https://console.test/api/control-plane/webhook',
        fetchImpl,
      }),
    ).rejects.toThrow('webhook is not active');
  });
});

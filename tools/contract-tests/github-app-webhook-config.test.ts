import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import {
  configureAppWebhook,
  createAppJwt,
  pushWatchedReposFromApphosting,
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

const REQUIRED_EVENTS = [
  'check_run',
  'issue_comment',
  'issues',
  'pull_request',
  'pull_request_review',
  'pull_request_review_thread',
  'push',
];

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

  it('sets the secret without returning it and verifies subscriptions', async () => {
    const webhookSecret = 'never-return-this-secret';
    const webhookUrl = 'https://console.test/api/control-plane/webhook';
    const fetchImpl = vi.fn(
      async (url: string | URL, options?: RequestInit) => {
        const path = new URL(String(url)).pathname;
        if (path === '/app' && !options?.method) {
          return response({
            slug: 'agent-lcars',
            events: [
              'check_run',
              'issue_comment',
              'issues',
              'pull_request',
              'pull_request_review',
              'pull_request_review_thread',
              'push',
            ],
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
      url: webhookUrl,
      contentType: 'json',
      events: [
        'check_run',
        'issue_comment',
        'issues',
        'pull_request',
        'pull_request_review',
        'pull_request_review_thread',
        'push',
      ],
      pushWatchedRepos: [],
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

    // Pinned by SHA fleet-wide (supply-chain hardening adopted from
    // homelab); the assertion enforces the pin so a float cannot return.
    expect(workflow).toMatch(/google-github-actions\/auth@[0-9a-f]{40} # v3/);
    expect(workflow).toContain('webhook_secret_version:');
    expect(workflow).toContain(
      'gcloud secrets versions access "$WEBHOOK_SECRET_VERSION"',
    );
    expect(workflow).not.toContain('gcloud secrets versions access latest');
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

  it('does not treat non-authoritative hook activation metadata as a configuration gate', async () => {
    const webhookUrl = 'https://console.test/api/control-plane/webhook';
    for (const hookAttributes of [undefined, { active: false }]) {
      const fetchImpl = vi.fn(
        async (url: string | URL, options?: RequestInit) => {
          const path = new URL(String(url)).pathname;
          if (path === '/app' && !options?.method) {
            return response({
              slug: 'agent-lcars',
              events: [
                'check_run',
                'issue_comment',
                'issues',
                'pull_request',
                'pull_request_review',
                'pull_request_review_thread',
                'push',
              ],
              ...(hookAttributes ? { hook_attributes: hookAttributes } : {}),
            });
          }
          return response({ url: webhookUrl, content_type: 'json' });
        },
      );

      await expect(
        configureAppWebhook({
          clientId: 'Iv1.client',
          privateKey: privatePem,
          webhookSecret: 'secret',
          webhookUrl,
          fetchImpl,
        }),
      ).resolves.toMatchObject({ url: webhookUrl });
      expect(fetchImpl).toHaveBeenCalledTimes(3);
    }
  });

  it('does not mutate GitHub when a required event is missing', async () => {
    const fetchImpl = vi.fn(async () =>
      response({
        slug: 'agent-lcars',
        events: [
          'check_run',
          'issues',
          'pull_request',
          'pull_request_review',
          'pull_request_review_thread',
          'push',
        ],
        hook_attributes: { active: true },
      }),
    );

    await expect(
      configureAppWebhook({
        clientId: 'Iv1.client',
        privateKey: privatePem,
        webhookSecret: 'secret',
        webhookUrl: 'https://console.test/api/control-plane/webhook',
        fetchImpl,
      }),
    ).rejects.toThrow('missing required webhook events: issue_comment');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  // #1754: push-watch shipped 2026-09-01 and never fired, because the App
  // was not installed on jlapenna/repo-tools. Every check stayed green for
  // five days -- an App only delivers events for repositories it is
  // installed on, and nothing asserted that.
  it('refuses a push-watched repository the App is not installed on', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/repos/jlapenna/repo-tools/installation')) {
        return new Response(JSON.stringify({ message: 'Not Found' }), {
          status: 404,
        });
      }
      if (url.endsWith('/installation')) {
        return response({ id: 987 });
      }
      return response({
        slug: 'agent-lcars',
        events: REQUIRED_EVENTS,
        hook_attributes: { active: true },
      });
    }) as unknown as typeof fetch;

    await expect(
      configureAppWebhook({
        clientId: 'Iv1.client',
        privateKey: privatePem,
        webhookSecret: 'secret',
        webhookUrl: 'https://console.test/api/control-plane/webhook',
        pushWatchedRepos: ['jlapenna/homelab', 'jlapenna/repo-tools'],
        fetchImpl,
      }),
    ).rejects.toThrow(
      'not installed on push-watched repositories: jlapenna/repo-tools',
    );
  });

  it('reports the events GitHub actually has, not the required list', async () => {
    // The summary used to echo REQUIRED_EVENTS, so its output described
    // intent while reading like state. That is why a run log listing six
    // events was misread as proof `push` was unsubscribed (#1754).
    const configured = [...REQUIRED_EVENTS, 'release'];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/app/hook/config')) {
        return response({
          url: 'https://console.test/api/control-plane/webhook',
          content_type: 'json',
        });
      }
      return response({
        slug: 'agent-lcars',
        events: configured,
        hook_attributes: { active: true },
      });
    }) as unknown as typeof fetch;

    const result = await configureAppWebhook({
      clientId: 'Iv1.client',
      privateKey: privatePem,
      webhookSecret: 'secret',
      webhookUrl: 'https://console.test/api/control-plane/webhook',
      fetchImpl,
    });

    expect(result.events).toEqual(configured);
  });

  it('changes nothing in verify-only mode, so it can run unattended', async () => {
    const calls: { method: string; url: string }[] = [];
    const fetchImpl = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ method: init?.method ?? 'GET', url: String(input) });
        if (String(input).endsWith('/app/hook/config')) {
          return response({
            url: 'https://console.test/api/control-plane/webhook',
            content_type: 'json',
          });
        }
        return response({
          slug: 'agent-lcars',
          events: REQUIRED_EVENTS,
          hook_attributes: { active: true },
        });
      },
    ) as unknown as typeof fetch;

    const result = await configureAppWebhook({
      clientId: 'Iv1.client',
      privateKey: privatePem,
      // No secret at all: a scheduled run has none, which is the whole
      // reason verify-only exists.
      webhookUrl: 'https://console.test/api/control-plane/webhook',
      verifyOnly: true,
      fetchImpl,
    });

    expect(calls.every(({ method }) => method === 'GET')).toBe(true);
    expect(result.verifiedOnly).toBe(true);
  });

  it('reads the push-watched repositories from the deployed config', () => {
    // Single source of truth: the list asserted against GitHub is the same
    // one the console actually push-watches.
    expect(
      pushWatchedReposFromApphosting(
        [
          'env:',
          '  - variable: AGENT_LCARS_PUSH_WATCHED_REPOS',
          "    value: 'jlapenna/repo-tools, jlapenna/homelab'",
          '    availability:',
          '      - RUNTIME',
        ].join('\n'),
      ),
    ).toEqual(['jlapenna/repo-tools', 'jlapenna/homelab']);

    expect(pushWatchedReposFromApphosting('env: []')).toEqual([]);

    // A variable declared with no value must yield nothing rather than
    // adopting the next entry's value.
    expect(
      pushWatchedReposFromApphosting(
        [
          '  - variable: AGENT_LCARS_PUSH_WATCHED_REPOS',
          '  - variable: SOMETHING_ELSE',
          "    value: 'jlapenna/not-this-one'",
        ].join('\n'),
      ),
    ).toEqual([]);
  });

  it('parses the real apphosting.yaml this workflow asserts against', async () => {
    // The synthetic cases above pin the parser; this pins it against the
    // actual file shape, which is what the scheduled run reads. A parser
    // that only handles fixtures would assert nothing in production.
    const source = await fs.readFile(
      fileURLToPath(
        new URL('../../apps/console/apphosting.yaml', import.meta.url),
      ),
      'utf8',
    );
    const repos = pushWatchedReposFromApphosting(source);

    expect(repos.length).toBeGreaterThan(0);
    for (const repo of repos) expect(repo).toMatch(/^[\w.-]+\/[\w.-]+$/);
  });
});

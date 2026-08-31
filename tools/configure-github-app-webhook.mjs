#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const API_VERSION = '2022-11-28';
const EXPECTED_APP_SLUG = 'agent-lcars';
const REQUIRED_EVENTS = [
  'check_run',
  'issue_comment',
  'issues',
  'pull_request',
  'pull_request_review',
  'pull_request_review_thread',
];

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

export async function readWebhookSecret(filePath) {
  const value = await fs.readFile(filePath, 'utf8');
  if (value.length === 0) throw new Error('WEBHOOK_SECRET_FILE is empty');
  return value;
}

export function createAppJwt(clientId, privateKey, now = Date.now()) {
  const issuedAt = Math.floor(now / 1000) - 60;
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(
    JSON.stringify({ iss: clientId, iat: issuedAt, exp: issuedAt + 600 }),
  );
  const signingInput = `${header}.${payload}`;
  const signature = crypto.sign(
    'RSA-SHA256',
    Buffer.from(signingInput),
    privateKey,
  );
  return `${signingInput}.${signature.toString('base64url')}`;
}

export async function configureAppWebhook({
  clientId,
  privateKey,
  webhookSecret,
  webhookUrl,
  fetchImpl = fetch,
  now = Date.now(),
}) {
  const token = createAppJwt(clientId, privateKey, now);
  const request = async (path, options = {}) => {
    const response = await fetchImpl(`https://api.github.com${path}`, {
      ...options,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': API_VERSION,
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      },
    });
    if (!response.ok) {
      throw new Error(
        `GitHub App API ${options.method ?? 'GET'} ${path} failed with HTTP ${response.status}: ${await response.text()}`,
      );
    }
    return response.json();
  };

  // Prove which App the credential belongs to before changing anything. A
  // valid but mismatched client/key pair must never mutate an unrelated App.
  const app = await request('/app');
  if (app.slug !== EXPECTED_APP_SLUG) {
    throw new Error(
      `Refusing to configure unexpected GitHub App slug: ${String(app.slug)}`,
    );
  }

  // GitHub's App webhook-config API can update the URL and secret, but App
  // activation and event subscriptions are settings-page controls. The
  // authenticated App response does expose subscriptions, but its
  // `hook_attributes.active` value is not authoritative for an existing App
  // (the live registration UI can be active while this field is absent or
  // false). Validate the events here; activation remains an operator-owned
  // rollout prerequisite and the production canary proves live delivery.
  const configuredEvents = Array.isArray(app.events) ? app.events : [];
  const missingEvents = REQUIRED_EVENTS.filter(
    (event) => !configuredEvents.includes(event),
  );
  if (missingEvents.length > 0) {
    throw new Error(
      `GitHub App is missing required webhook events: ${missingEvents.join(', ')}`,
    );
  }
  await request('/app/hook/config', {
    method: 'PATCH',
    body: JSON.stringify({
      url: webhookUrl,
      content_type: 'json',
      secret: webhookSecret,
      insecure_ssl: '0',
    }),
  });

  const config = await request('/app/hook/config');
  if (config.url !== webhookUrl || config.content_type !== 'json') {
    throw new Error('GitHub App webhook configuration did not converge');
  }

  return {
    app: app.slug,
    url: config.url,
    contentType: config.content_type,
    events: REQUIRED_EVENTS,
  };
}

async function main() {
  const result = await configureAppWebhook({
    clientId: required('APP_CLIENT_ID'),
    privateKey: required('APP_PRIVATE_KEY'),
    // Read the Secret Manager payload as a file and do not trim it. GitHub
    // must receive the same bytes App Hosting uses for HMAC verification,
    // including any intentional trailing newline.
    webhookSecret: await readWebhookSecret(required('WEBHOOK_SECRET_FILE')),
    webhookUrl: required('WEBHOOK_URL'),
  });
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

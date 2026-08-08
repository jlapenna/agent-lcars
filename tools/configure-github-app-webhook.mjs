#!/usr/bin/env node

import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const API_VERSION = '2022-11-28';
const EXPECTED_APP_SLUG = 'agent-lcars';
const REQUIRED_EVENTS = ['issue_comment', 'issues', 'pull_request'];

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function base64url(value) {
  return Buffer.from(value).toString('base64url');
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

  const configuredEvents = Array.isArray(app.events) ? app.events : [];
  const missingEvents = REQUIRED_EVENTS.filter(
    (event) => !configuredEvents.includes(event),
  );
  if (missingEvents.length > 0) {
    throw new Error(
      `GitHub App is missing required webhook events: ${missingEvents.join(', ')}`,
    );
  }
  if (app.hook_attributes?.active !== true) {
    throw new Error(
      'GitHub App webhook configuration is saved but the webhook is not active',
    );
  }

  return {
    app: app.slug,
    active: true,
    url: config.url,
    contentType: config.content_type,
    events: REQUIRED_EVENTS,
  };
}

async function main() {
  const result = await configureAppWebhook({
    clientId: required('APP_CLIENT_ID'),
    privateKey: required('APP_PRIVATE_KEY'),
    webhookSecret: required('WEBHOOK_SECRET'),
    webhookUrl: required('WEBHOOK_URL'),
  });
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

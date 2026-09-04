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
  // Requires the App to also hold the "Contents: Read" permission — like
  // event subscriptions, that is a settings-page/installation-approval
  // control this script cannot grant, only verify is already in place.
  'push',
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
  // Repositories that must be inside the App installation for their
  // deliveries to exist at all. An App only sends events for repositories it
  // is installed on, so a repo named in AGENT_LCARS_PUSH_WATCHED_REPOS but
  // absent from the installation is a feature that silently never fires --
  // exactly what happened to push-watch for five days (#1754).
  pushWatchedRepos = [],
  // Assert configuration without changing it. The PATCH below is the only
  // step needing the webhook secret, so verify-only runs need no secret and
  // can therefore run unattended on a schedule (#1761).
  verifyOnly = false,
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

  /** GitHub answers "is this App installed on that repo" with 404, which is
   *  an answer here rather than a failure -- so this variant reports the
   *  status instead of throwing on it. */
  const requestStatus = async (path) => {
    const response = await fetchImpl(`https://api.github.com${path}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': API_VERSION,
      },
    });
    return response.status;
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
  const uninstalled = [];
  for (const repo of pushWatchedRepos) {
    const status = await requestStatus(`/repos/${repo}/installation`);
    if (status === 404) {
      uninstalled.push(repo);
      continue;
    }
    if (status !== 200) {
      throw new Error(
        `Could not determine App installation for ${repo}: HTTP ${status}`,
      );
    }
  }
  if (uninstalled.length > 0) {
    throw new Error(
      `GitHub App is not installed on push-watched repositories: ${uninstalled.join(', ')}`,
    );
  }

  if (verifyOnly) {
    const current = await request('/app/hook/config');
    return {
      app: app.slug,
      url: current.url,
      contentType: current.content_type,
      events: configuredEvents,
      pushWatchedRepos,
      verifiedOnly: true,
    };
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
    // GitHub's own subscription list, not REQUIRED_EVENTS. Reporting the
    // constant made this output describe intent while reading like state,
    // and cost a wrong root cause during the #1754 investigation.
    events: configuredEvents,
    pushWatchedRepos,
  };
}

/** The deployed value is the source of truth: reading it here means the
 *  assertion cannot drift from what the console actually push-watches.
 *
 *  Parsed without a YAML library on purpose. This workflow runs
 *  `node tools/configure-github-app-webhook.mjs` with no `pnpm install`
 *  step, so the script has no `node_modules` -- every import here is a Node
 *  builtin, and adding a dependency would break the very run that is
 *  supposed to catch configuration drift. The shape matched is narrow (one
 *  `- variable:` entry and its `value:`) and is itself pinned by
 *  `deploy-console-config.test.ts`. */
export function pushWatchedReposFromApphosting(yamlSource) {
  const lines = yamlSource.split('\n');
  const start = lines.findIndex((line) =>
    /^\s*-\s*variable:\s*AGENT_LCARS_PUSH_WATCHED_REPOS\s*$/.test(line),
  );
  if (start === -1) return [];
  for (const line of lines.slice(start + 1)) {
    // Stop at the next entry rather than scanning on, so a missing `value:`
    // yields nothing instead of silently adopting a later entry's value.
    if (/^\s*-\s*variable:/.test(line)) break;
    const match = /^\s*value:\s*(.*)$/.exec(line);
    if (!match) continue;
    return match[1]
      .trim()
      .replace(/^['"]|['"]$/g, '')
      .split(/[,:]/)
      .map((repo) => repo.trim())
      .filter((repo) => repo.length > 0);
  }
  return [];
}

async function main() {
  const verifyOnly = process.env['VERIFY_ONLY']?.trim() === 'true';
  const result = await configureAppWebhook({
    clientId: required('APP_CLIENT_ID'),
    privateKey: required('APP_PRIVATE_KEY'),
    // Read the Secret Manager payload as a file and do not trim it. GitHub
    // must receive the same bytes App Hosting uses for HMAC verification,
    // including any intentional trailing newline. A verify-only run changes
    // nothing, so it needs no secret -- which is what lets it run on a
    // schedule with no operator input.
    webhookSecret: verifyOnly
      ? undefined
      : await readWebhookSecret(required('WEBHOOK_SECRET_FILE')),
    webhookUrl: required('WEBHOOK_URL'),
    pushWatchedRepos: pushWatchedReposFromApphosting(
      await fs.readFile('apps/console/apphosting.yaml', 'utf8'),
    ),
    verifyOnly,
  });
  console.log(JSON.stringify(result, null, 2));
}

// `process.argv[1]` is undefined when this module is imported from a
// context without a script path (`node --input-type=module -e ...`), and
// `pathToFileURL(undefined)` throws -- which made the module unimportable
// there rather than simply not running `main()`.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}

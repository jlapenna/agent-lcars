// @vitest-environment node

import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';

import { validateStartupConfiguration } from './startup-configuration';

vi.mock('google-auth-library', () => ({ GoogleAuth: class {} }));

const VARS = [
  'AGENT_LCARS_ADMIN_GITHUB_LOGIN',
  'AGENT_LCARS_CONSOLE_URL',
  'AGENT_LCARS_ARTIFACT_SHARE_BASE_URL',
  'AGENT_LCARS_CONTROL_PLANE_REPOSITORY',
  'AGENT_LCARS_CODEX_CENTRAL_AUTH_OBJECT',
  'AGENT_LCARS_CONTROL_PLANE_REPOSITORIES',
  'AGENT_LCARS_WATCHED_REPOS',
  'AGENT_LCARS_WORK_GRANTS',
  'AGENT_LCARS_OUTCOME_WEBHOOKS',
  'AGENT_LCARS_APP_CLIENT_ID',
  'AGENT_LCARS_APP_PRIVATE_KEY',
  'AGENT_LCARS_WEBHOOK_SECRET',
  'PROJECT_ID',
  'AGENT_LCARS_WEBHOOK_QUEUE',
  'AGENT_LCARS_WEBHOOK_QUEUE_LOCATION',
  'AUTH_URL',
  'QUICK_TASK_EVIDENCE_BUCKET',
  'AGENT_LCARS_WORK_AUDIENCE',
];

const privateKey = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
}).privateKey;

const saved: Record<string, string | undefined> = {};

function completeEnv() {
  process.env['AGENT_LCARS_APP_CLIENT_ID'] = 'test-app';
  process.env['AGENT_LCARS_APP_PRIVATE_KEY'] = privateKey;
  process.env['AGENT_LCARS_WEBHOOK_SECRET'] = 'test-webhook';
  process.env['PROJECT_ID'] = 'test-project';
  process.env['AGENT_LCARS_WEBHOOK_QUEUE'] = 'test-queue';
  process.env['AGENT_LCARS_WEBHOOK_QUEUE_LOCATION'] = 'us-central1';
  process.env['AUTH_URL'] = 'http://localhost:4200';
  process.env['QUICK_TASK_EVIDENCE_BUCKET'] = 'test-bucket';
  process.env['AGENT_LCARS_WORK_AUDIENCE'] = 'test-audience';
  process.env['AGENT_LCARS_ADMIN_GITHUB_LOGIN'] = 'someone';
  process.env['AGENT_LCARS_CONSOLE_URL'] = 'https://lcars.example.test';
  process.env['AGENT_LCARS_ARTIFACT_SHARE_BASE_URL'] =
    'https://share.example.test';
  process.env['AGENT_LCARS_CONTROL_PLANE_REPOSITORY'] = 'owner/console';
  process.env['AGENT_LCARS_CODEX_CENTRAL_AUTH_OBJECT'] =
    'owner/console/auth.json';
  process.env['AGENT_LCARS_CONTROL_PLANE_REPOSITORIES'] = 'owner/a,owner/b';
  process.env['AGENT_LCARS_WATCHED_REPOS'] = JSON.stringify([
    { owner: 'owner', name: 'a', alias: 'a' },
    { owner: 'owner', name: 'b', alias: 'b' },
  ]);
  process.env['AGENT_LCARS_WORK_GRANTS'] = JSON.stringify([
    {
      principal: 'user:someone',
      subjects: ['github:someone'],
      pipelines: ['claude'],
      scopes: ['work.operator'],
    },
  ]);
  process.env['AGENT_LCARS_OUTCOME_WEBHOOKS'] = JSON.stringify({
    slack: { url: 'https://bot.example/outcome', audience: 'aud' },
  });
}

// Async so each case reads as the boot's pass/fail verdict.
async function validate() {
  validateStartupConfiguration();
}

beforeEach(() => {
  for (const name of VARS) saved[name] = process.env[name];
  completeEnv();
});

afterEach(() => {
  for (const name of VARS) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

describe('validateStartupConfiguration', () => {
  it('accepts a complete, consistent configuration', async () => {
    await expect(validate()).resolves.toBeUndefined();
  });

  // The committed production values must pass the same boot gate, so a
  // malformed edit fails CI instead of the next App Hosting rollout.
  it('accepts the configuration committed in apphosting.yaml', async () => {
    const config = parseYaml(
      readFileSync(
        path.join(import.meta.dirname, '../../apphosting.yaml'),
        'utf8',
      ),
    ) as {
      env: {
        variable: string;
        value?: string;
        secret?: string;
        availability: string[];
      }[];
    };
    const secretNames = [
      'AGENT_LCARS_APP_PRIVATE_KEY',
      'AGENT_LCARS_WEBHOOK_SECRET',
    ];
    for (const name of VARS) {
      const entry = config.env.find((e) => e.variable === name);
      expect(entry?.availability).toContain('RUNTIME');
    }
    for (const name of secretNames) {
      expect(config.env.find((e) => e.variable === name)?.secret).toBeTypeOf(
        'string',
      );
    }
    for (const name of VARS.filter((name) => !secretNames.includes(name))) {
      const entry = config.env.find((e) => e.variable === name);
      expect(entry?.value).toBeTypeOf('string');
      process.env[name] = entry?.value;
    }
    await expect(validate()).resolves.toBeUndefined();
  });

  it.each([
    'AGENT_LCARS_APP_CLIENT_ID',
    'AGENT_LCARS_APP_PRIVATE_KEY',
    'AGENT_LCARS_WEBHOOK_SECRET',
    'PROJECT_ID',
    'AGENT_LCARS_WEBHOOK_QUEUE',
    'AGENT_LCARS_WEBHOOK_QUEUE_LOCATION',
    'AUTH_URL',
    'QUICK_TASK_EVIDENCE_BUCKET',
    'AGENT_LCARS_WORK_AUDIENCE',
  ])('rejects missing or blank %s before accepting traffic', async (name) => {
    delete process.env[name];
    await expect(validate()).rejects.toThrow(name);
    process.env[name] = '  ';
    await expect(validate()).rejects.toThrow(name);
  });

  it('rejects an unparseable App key with a redacted variable-specific error', async () => {
    process.env['AGENT_LCARS_APP_PRIVATE_KEY'] = 'not-a-private-key';
    await expect(validate()).rejects.toThrow(
      'AGENT_LCARS_APP_PRIVATE_KEY must be a valid PEM private key',
    );
  });

  it.each([
    generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey,
    generateKeyPairSync('ed25519').privateKey,
    generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey,
  ])('rejects a parseable key that cannot sign RS256', async (key) => {
    process.env['AGENT_LCARS_APP_PRIVATE_KEY'] = key
      .export({ type: 'pkcs8', format: 'pem' })
      .toString();
    await expect(validate()).rejects.toThrow('AGENT_LCARS_APP_PRIVATE_KEY');
  });

  it.each(['relative/path', 'ftp://example.test'])(
    'rejects invalid AUTH_URL %s',
    async (url) => {
      process.env['AUTH_URL'] = url;
      await expect(validate()).rejects.toThrow('AUTH_URL');
    },
  );

  it('revalidates a rotated App key without making network requests', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    try {
      await validate();
      process.env['AGENT_LCARS_APP_PRIVATE_KEY'] = 'bad-rotation';
      await expect(validate()).rejects.toThrow('AGENT_LCARS_APP_PRIVATE_KEY');
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });

  it('is safe to repeat', async () => {
    await validate();
    await expect(validate()).resolves.toBeUndefined();
  });

  it('accepts a deployment with no work grants or outcome targets', async () => {
    delete process.env['AGENT_LCARS_WORK_GRANTS'];
    delete process.env['AGENT_LCARS_OUTCOME_WEBHOOKS'];
    await expect(validate()).resolves.toBeUndefined();
  });

  it('still requires the deployment identity', async () => {
    delete process.env['AGENT_LCARS_CONSOLE_URL'];
    await expect(validate()).rejects.toThrow('AGENT_LCARS_CONSOLE_URL');
  });

  it('fails the boot when the admitted and watched repositories diverge', async () => {
    process.env['AGENT_LCARS_CONTROL_PLANE_REPOSITORIES'] = 'owner/a';
    await expect(validate()).rejects.toThrow(
      'AGENT_LCARS_CONTROL_PLANE_REPOSITORIES must exactly match AGENT_LCARS_WATCHED_REPOS',
    );
  });

  it('fails the boot when the admitted repositories are unset', async () => {
    delete process.env['AGENT_LCARS_CONTROL_PLANE_REPOSITORIES'];
    await expect(validate()).rejects.toThrow(
      'AGENT_LCARS_CONTROL_PLANE_REPOSITORIES',
    );
  });

  it('fails the boot on malformed watched repositories', async () => {
    process.env['AGENT_LCARS_WATCHED_REPOS'] = '[{"owner":';
    await expect(validate()).rejects.toThrow();
  });

  it('fails the boot on a work grant naming an unknown pipeline', async () => {
    process.env['AGENT_LCARS_WORK_GRANTS'] = JSON.stringify([
      {
        principal: 'user:someone',
        subjects: ['github:someone'],
        pipelines: ['clade'],
        scopes: ['work.operator'],
      },
    ]);
    await expect(validate()).rejects.toThrow();
  });

  it('fails the boot on outcome webhooks that are not JSON', async () => {
    process.env['AGENT_LCARS_OUTCOME_WEBHOOKS'] = '{slack:';
    await expect(validate()).rejects.toThrow(
      'AGENT_LCARS_OUTCOME_WEBHOOKS is not valid JSON',
    );
  });

  it('fails the boot on an outcome webhook entry without an audience', async () => {
    process.env['AGENT_LCARS_OUTCOME_WEBHOOKS'] = JSON.stringify({
      slack: { url: 'https://bot.example/outcome' },
    });
    await expect(validate()).rejects.toThrow('"slack"');
  });

  it('fails the boot on an outcome webhook map that is an array', async () => {
    process.env['AGENT_LCARS_OUTCOME_WEBHOOKS'] = '[]';
    await expect(validate()).rejects.toThrow('JSON object');
  });
});

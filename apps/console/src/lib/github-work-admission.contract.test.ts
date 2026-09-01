import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const sourceRoot = existsSync(resolve(process.cwd(), 'apps/console/src/lib'))
  ? resolve(process.cwd(), 'apps/console/src/lib')
  : resolve(process.cwd(), 'src/lib');
const lib = (name: string) => readFileSync(resolve(sourceRoot, name), 'utf8');

describe('GitHub Work admission ownership', () => {
  it('keeps GitHub-anchor request and drain inside the one internal service', () => {
    const service = lib('github-work-admission.ts');
    expect(service).toContain('runtime.orchestrator.request(');
    expect(service).toContain('runtime.drain()');

    for (const file of ['github-dispatch-router.ts', 'backend-actions.ts']) {
      const source = lib(file);
      expect(source).toContain("from './github-work-admission'");
      expect(source).not.toContain('orchestrator.request(');
      expect(source).not.toContain('runtime.drain()');
    }

    const webhook = lib('orchestrator-routes.ts');
    const webhookOnly = webhook.slice(
      webhook.indexOf('export async function handleWebhookDelivery'),
      webhook.indexOf('export async function handleReconcile'),
    );
    expect(webhookOnly).toContain('admitGithubWork(deps');
    expect(webhookOnly).not.toContain('deps.orchestrator.request(');
    expect(webhookOnly).not.toContain('deps.drain()');
  });
});

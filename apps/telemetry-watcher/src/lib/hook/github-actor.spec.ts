import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { defaultHookCommandDependencies } from './hook-command';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

async function observe(script: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lcars-github-actor-'));
  roots.push(root);
  fs.writeFileSync(
    path.join(root, 'gh'),
    `#!${process.execPath}\nconst expected = ['api', '--hostname', 'github.com', 'user', '--jq', '.login'];\nif (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(expected)) process.exit(9);\n${script}\n`,
    { mode: 0o700 },
  );
  const deps = defaultHookCommandDependencies({
    ...process.env,
    PATH: `${root}:${process.env.PATH}`,
    GH_HOST: 'untrusted.example',
  });
  if (!deps.resolveGithubActor) throw new Error('missing identity observer');
  return deps.resolveGithubActor();
}

describe('bounded authenticated GitHub actor observer', () => {
  it('reads only the github.com authenticated user and trims its login', async () => {
    expect(await observe("console.log('  jlapenna  ')")).toBe('jlapenna');
  });
  it.each([
    "console.log('someone/else')",
    "console.log('jlapenna'); process.exitCode = 1",
    "console.log('x'.repeat(5000))",
  ])(
    'fails closed on invalid, rejected or oversized identity responses: %s',
    async (script) => {
      expect(await observe(script)).toBeUndefined();
    },
  );
  it('bounds a hung credential/API subprocess without blocking shipping indefinitely', async () => {
    expect(await observe('setTimeout(() => {}, 120000)')).toBeUndefined();
  });
});

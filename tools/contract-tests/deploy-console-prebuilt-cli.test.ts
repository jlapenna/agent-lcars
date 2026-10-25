import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { expect, it } from 'vitest';

const workspace = path.resolve(import.meta.dirname, '../..');

it('deploys a prebuilt image through v1 without managed-runtime backend fields', async () => {
  const fixture = await mkdtemp(
    path.join(os.tmpdir(), 'console-prebuilt-cli-'),
  );
  try {
    const bin = path.join(fixture, 'bin');
    await mkdir(bin);
    await writeFile(
      path.join(bin, 'gcloud'),
      '#!/bin/sh\ncase "$1 $2" in\n "projects describe") echo 611425338852 ;;\n "auth print-access-token") echo fixture-access-token ;;\n *) exit 97 ;;\nesac\n',
      { mode: 0o755 },
    );
    const preload = path.join(fixture, 'api.mjs');
    await writeFile(
      preload,
      String.raw`
import { appendFile } from 'node:fs/promises';
const parent = '/v1/projects/agent-lcars/locations/us-central1/backends/agent-lcars';
let build;
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(input);
  const method = options.method ?? 'GET';
  const body = options.body ? JSON.parse(options.body) : null;
  await appendFile(process.env.FIXTURE_REQUESTS, JSON.stringify({ method, path: url.pathname, query: url.search, body }) + '\n');
  const response = (value) => new Response(JSON.stringify(value), { status: 200 });
  if (url.origin !== 'https://firebaseapphosting.googleapis.com') throw new Error('Unexpected API origin');
  // This is the actual v1 Backend shape: runtime and automatic base-image
  // update policy are not Backend fields for a prebuilt container.
  if (method === 'GET' && url.pathname === parent) return response({ name: parent.slice(4), uri: 'https://fixture.example' });
  if (method === 'POST' && url.pathname === parent + '/builds') {
    build = { ...body, name: parent.slice(4) + '/builds/' + url.searchParams.get('buildId'), state: 'READY', image: process.env.FIXTURE_IMAGE };
    return response({ done: true, response: build });
  }
  if (method === 'POST' && url.pathname === parent + '/rollouts') return response({ done: true });
  if (method === 'GET' && url.pathname === '/v1/' + build?.name) return response(build);
  if (method === 'GET' && url.pathname === '/v1/' + build?.name.replace('/builds/', '/rollouts/')) return response({ name: build.name.replace('/builds/', '/rollouts/'), build: build.name, state: 'SUCCEEDED' });
  if (method === 'GET' && url.pathname === parent + '/traffic') return response({ current: { splits: [{ build: build.name.replace('projects/agent-lcars/', 'projects/611425338852/'), percent: 100 }] } });
  throw new Error('Unexpected API request: ' + method + ' ' + url);
};
`,
    );
    const requests = path.join(fixture, 'requests.jsonl');
    const output = path.join(fixture, 'output');
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: workspace,
      encoding: 'utf8',
    }).trim();
    const image =
      'us-central1-docker.pkg.dev/agent-lcars/firebaseapphosting-images/console@sha256:' +
      '1'.repeat(64);
    const child = spawnSync(
      process.execPath,
      [
        '--import',
        preload,
        'tools/deploy-console-prebuilt.mjs',
        '--project',
        'agent-lcars',
        '--region',
        'us-central1',
        '--backend',
        'agent-lcars',
        '--root-dir',
        'apps/console',
        '--commit',
        commit,
        '--image',
        image,
      ],
      {
        cwd: workspace,
        encoding: 'utf8',
        timeout: 15_000,
        env: {
          ...process.env,
          PATH: bin + path.delimiter + process.env.PATH,
          FIXTURE_REQUESTS: requests,
          FIXTURE_IMAGE: image,
          GITHUB_OUTPUT: output,
          GITHUB_RUN_ID: 'v1-backend-contract',
          GITHUB_RUN_ATTEMPT: '1',
        },
      },
    );
    expect(child.status, child.stderr).toBe(0);
    const calls = (await readFile(requests, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const registered = calls.find(
      (call) => call.method === 'POST' && call.path.endsWith('/builds'),
    );
    expect(registered.body.source).toEqual({ container: { image } });
    expect(registered.body.labels['commit-sha']).toBe(commit);
    expect(
      calls.filter(
        (call) =>
          call.method === 'POST' &&
          call.path.endsWith('/rollouts') &&
          !call.query.includes('validateOnly'),
      ),
    ).toHaveLength(1);
    expect(await readFile(output, 'utf8')).toContain('source_uri=' + image);
    expect(child.stdout).toContain('owns 100% traffic');
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

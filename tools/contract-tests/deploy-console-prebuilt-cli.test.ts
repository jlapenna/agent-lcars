import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { expect, it } from 'vitest';

const workspace = path.resolve(import.meta.dirname, '../..');

it.each([
  'ready',
  'transient',
  'transient-ready',
  'failed',
  'failed-at-registration',
  'failed-metadata-unavailable',
  'denied',
  'legacy-denied',
  'invalid',
])(
  'validates and deploys a v1 prebuilt image with %s build metadata',
  async (scenario) => {
    const transient =
      scenario === 'transient' || scenario === 'transient-ready';
    const secretDenied = scenario === 'denied' || scenario === 'legacy-denied';
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
const scenario = process.env.FIXTURE_SCENARIO;
let build;
let validationAttempts = 0;
function failBuild() {
  build.state = 'FAILED';
  const denied = scenario === 'denied' || scenario === 'legacy-denied';
  const errorSource = 'CLOUD_RUN';
  const error = {
    code: denied ? 9 : 5,
    message: scenario === 'denied'
      ? "Permission 'secretmanager.versions.access' denied for resource 'projects/private/secrets/DO_NOT_LOG/versions/1' (or it may not exist)."
      : scenario === 'legacy-denied'
        ? 'Permission denied on secret projects/private/secrets/DO_NOT_LOG/versions/1'
        : 'Secret projects/private/secrets/DO_NOT_LOG/versions/latest was not found',
  };
  if (scenario === 'legacy-denied') {
    build.error = error;
    build.errorSource = errorSource;
  } else {
    build.errors = [{ error, errorSource }];
  }
}
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
    if (scenario === 'failed-at-registration') failBuild();
    return response({ done: true, response: build });
  }
  if (method === 'POST' && url.pathname === parent + '/rollouts') {
    if (url.searchParams.get('validateOnly') && ++validationAttempts === 1) {
      if (scenario === 'failed' || scenario === 'denied' || scenario === 'legacy-denied' || scenario === 'failed-metadata-unavailable') {
        failBuild();
        const message = 'The request was invalid: build "' + url.searchParams.get('rolloutId') + '" failed and a new rollout cannot be created: BUILD_FAILED';
        return new Response(JSON.stringify({ error: {
          code: 400, message, status: 'INVALID_ARGUMENT',
          details: [{ '@type': 'type.googleapis.com/google.rpc.BadRequest', fieldViolations: [{ field: 'build' }] }],
        } }), { status: 400 });
      }
      if (scenario === 'transient' || scenario === 'invalid') build.state = 'DEPLOYING';
      if (scenario === 'transient' || scenario === 'transient-ready' || scenario === 'invalid') {
        const field = scenario === 'invalid' ? 'displayName' : 'build';
        return new Response(JSON.stringify({ error: {
          message: 'DO_NOT_LOG',
          details: [{ '@type': 'type.googleapis.com/google.rpc.BadRequest', fieldViolations: [{ field }] }],
        } }), { status: 400 });
      }
    }
    build.state = 'READY';
    return response({ done: true });
  }
  if (method === 'GET' && url.pathname === '/v1/' + build?.name) {
    if (scenario === 'failed-metadata-unavailable') return new Response('DO_NOT_LOG', { status: 403 });
    return response(build);
  }
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
            FIXTURE_SCENARIO: scenario,
            GITHUB_OUTPUT: output,
            GITHUB_RUN_ID: 'v1-backend-contract',
            GITHUB_RUN_ATTEMPT: '1',
          },
        },
      );
      const calls = (await readFile(requests, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      const registered = calls.find(
        (call) => call.method === 'POST' && call.path.endsWith('/builds'),
      );
      expect(registered.body.source).toEqual({ container: { image } });
      expect(registered.body.labels['commit-sha']).toBe(commit);
      const rollouts = calls.filter(
        (call) => call.method === 'POST' && call.path.endsWith('/rollouts'),
      );
      const validations = rollouts.filter((call) =>
        call.query.includes('validateOnly=true'),
      );
      const creations = rollouts.filter(
        (call) => !call.query.includes('validateOnly'),
      );
      const buildId = new URLSearchParams(registered.query).get('buildId');
      expect(child.error).toBeUndefined();
      expect(validations).toHaveLength(
        transient ? 2 : scenario === 'failed-at-registration' ? 0 : 1,
      );
      if (scenario === 'ready' || transient) {
        expect(child.status, child.stderr).toBe(0);
        expect(creations).toHaveLength(1);
        expect(await readFile(output, 'utf8')).toContain('source_uri=' + image);
        expect(child.stdout).toContain('owns 100% traffic');
      } else {
        expect(child.status).toBe(1);
        expect(creations).toHaveLength(0);
        expect(child.stderr).not.toContain('DO_NOT_LOG');
        if (scenario === 'invalid') {
          expect(child.stderr).toContain('HTTP 400');
        } else if (scenario === 'failed-metadata-unavailable') {
          expect(child.stderr).toContain(`BUILD_FAILED for build ${buildId}`);
        } else {
          expect(child.stderr).toContain(
            `build ${buildId} entered terminal state FAILED`,
          );
          expect(child.stderr).toContain(
            secretDenied
              ? 'runtime secret access failure'
              : 'could not resolve a runtime secret or version',
          );
        }
      }
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  },
);

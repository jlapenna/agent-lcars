import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const script = await readFile(
  new URL('../console-standalone-smoke.sh', import.meta.url),
  'utf8',
);
const server = await readFile(
  new URL('./fixtures/console-standalone-smoke-server.cjs', import.meta.url),
  'utf8',
);

async function fixture(kind: string) {
  const root = await mkdtemp(path.join(tmpdir(), 'lcars-standalone-contract-'));
  const repo = path.join(root, 'repo');
  const temporary = path.join(root, 'temporary');
  const bin = path.join(root, 'bin');
  const standalone = path.join(repo, 'dist/apps/console/.next/standalone');
  const protos = path.join(
    standalone,
    'node_modules/.pnpm/@google-cloud+tasks@1/node_modules/@google-cloud/tasks/build/protos',
  );
  await Promise.all([
    mkdir(path.join(repo, 'tools'), { recursive: true }),
    mkdir(path.join(standalone, 'apps/console'), { recursive: true }),
    mkdir(path.join(standalone, 'dist/apps/console/.next/server'), {
      recursive: true,
    }),
    mkdir(protos, { recursive: true }),
    mkdir(temporary),
    mkdir(bin),
  ]);
  await Promise.all([
    writeFile(path.join(repo, 'tools/console-standalone-smoke.sh'), script),
    writeFile(
      path.join(repo, 'tools/console-standalone-externals.mjs'),
      '// Fixture import probe; real bundle is qualified separately.\n',
    ),
    writeFile(path.join(standalone, 'apps/console/server.js'), server),
    writeFile(path.join(protos, 'protos.json'), '{}'),
    writeFile(
      path.join(bin, 'node'),
      `#!${process.execPath}\nif (process.argv[2] === '-e') process.stdout.write('fixture-unregistered-key');\nelse if (process.argv[2].endsWith('console-standalone-externals.mjs')) console.log('Fixture dependency check');\nelse require(process.argv[2]);\n`,
      { mode: 0o755 },
    ),
  ]);
  const records = async (
    file: string,
  ): Promise<Array<Record<string, unknown>>> => {
    try {
      return (await readFile(path.join(root, file), 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  };
  return {
    root,
    records,
    async smokeRequests() {
      // Shared hosts can probe listeners independently. Count the smoke's
      // request fingerprint, retaining raw ingress in records for diagnosis.
      return (await records('requests.jsonl')).filter(
        (request) =>
          request['method'] === 'POST' &&
          request['url'] === '/api/control-plane/webhook' &&
          request['signature'] === 'sha256=invalid',
      );
    },
    async run() {
      try {
        const result = await exec(
          'bash',
          [path.join(repo, 'tools/console-standalone-smoke.sh')],
          {
            cwd: repo,
            timeout: 40_000,
            env: {
              ...process.env,
              PATH: `${bin}:${process.env['PATH']}`,
              TMPDIR: temporary,
              SMOKE_FIXTURE_ROOT: root,
              SMOKE_FIXTURE_KIND: kind,
            },
          },
        );
        return { code: 0, ...result };
      } catch (error) {
        const result = error as Error & {
          code?: number;
          stdout: string;
          stderr: string;
        };
        return {
          code: result.code,
          stdout: result.stdout,
          stderr: result.stderr,
        };
      }
    },
    async dispose() {
      for (const child of await records('processes.jsonl')) {
        const pid = Number(child['pid']);
        try {
          // Never signal a reused PID or a process belonging to another test.
          const command = await readFile(`/proc/${pid}/cmdline`, 'utf8');
          if (command.includes(root)) process.kill(pid, 'SIGKILL');
        } catch (error) {
          if (
            !['ENOENT', 'ESRCH'].includes(
              (error as NodeJS.ErrnoException).code ?? '',
            )
          )
            throw error;
        }
      }
      await rm(root, { recursive: true, force: true });
    },
  };
}

describe('owned standalone smoke boot and response', () => {
  it('boots the isolated child and probes the invalid webhook signature', async () => {
    const f = await fixture('normal');
    try {
      expect(await f.run()).toMatchObject({ code: 0 });
      expect(await f.records('attempts.jsonl')).toHaveLength(1);
      expect(await f.smokeRequests()).toMatchObject([
        {
          foreign: false,
          method: 'POST',
          url: '/api/control-plane/webhook',
          signature: 'sha256=invalid',
        },
      ]);
    } finally {
      await f.dispose();
    }
  });
  it('retries a proved occupied port without accepting or killing the foreign401 listener', async () => {
    const f = await fixture('collision-once');
    try {
      const result = await f.run();
      expect(result).toMatchObject({ code: 0 });
      expect(result.stdout).toContain('port occupied; retrying');
      expect(await f.records('attempts.jsonl')).toHaveLength(2);
      expect(await f.smokeRequests()).toHaveLength(1);
      expect(
        (await f.smokeRequests()).every(
          (request) => request['foreign'] === false,
        ),
      ).toBe(true);
      const foreign = (await f.records('processes.jsonl')).find(
        (child) => child['foreign'],
      );
      expect(foreign).toBeDefined();
      expect(() => process.kill(Number(foreign?.['pid']), 0)).not.toThrow();
    } finally {
      await f.dispose();
    }
  });
  it('bounds repeated occupied candidates instead of weakening the boot gate', async () => {
    const f = await fixture('collision-always');
    try {
      expect(await f.run()).toMatchObject({ code: 1 });
      expect(await f.records('attempts.jsonl')).toHaveLength(5);
      expect(await f.smokeRequests()).toHaveLength(0);
    } finally {
      await f.dispose();
    }
  }, 20_000);
  it('does not retry a non-bind startup failure', async () => {
    const f = await fixture('startup-error');
    try {
      expect(await f.run()).toMatchObject({ code: 1 });
      expect(await f.records('attempts.jsonl')).toHaveLength(1);
      expect(await f.smokeRequests()).toHaveLength(0);
    } finally {
      await f.dispose();
    }
  });
  it('cannot pass on401 before its child reports readiness', async () => {
    const f = await fixture('no-readiness');
    try {
      expect(await f.run()).toMatchObject({ code: 1 });
      expect(await f.records('requests.jsonl')).toContainEqual({
        foreign: false,
        method: 'GET',
        url: '/',
      });
      expect(await f.smokeRequests()).toHaveLength(0);
    } finally {
      await f.dispose();
    }
  }, 45_000);
  it('bounds a hung HTTP response and stops the owned child', async () => {
    const f = await fixture('hung-response');
    try {
      expect(await f.run()).toMatchObject({ code: 1 });
      const calls = await f.smokeRequests();
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.length).toBeLessThan(20);
      for (const child of await f.records('processes.jsonl'))
        expect(() => process.kill(Number(child['pid']), 0)).toThrow();
    } finally {
      await f.dispose();
    }
  }, 45_000);
  it('rejects HTTP 401 headers when the response body never completes', async () => {
    const f = await fixture('hung-body');
    try {
      expect(await f.run()).toMatchObject({ code: 1 });
      const calls = await f.smokeRequests();
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.length).toBeLessThan(20);
      for (const child of await f.records('processes.jsonl'))
        expect(() => process.kill(Number(child['pid']), 0)).toThrow();
    } finally {
      await f.dispose();
    }
  }, 45_000);
});

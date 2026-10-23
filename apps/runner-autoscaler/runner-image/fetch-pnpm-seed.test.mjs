/* eslint-disable vitest/no-import-node-test -- the isolated image regression runs without Vitest installed. */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(new URL('./fetch-pnpm-seed.mjs', import.meta.url));
const pin = JSON.parse(
  await readFile(
    new URL(
      './pnpm-seed/fleet/jlapenna__agent-lcars/package.json',
      import.meta.url,
    ),
  ),
).packageManager;

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, COREPACK_ENABLE_NETWORK: '0' },
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, output }));
  });
}

test(
  'native fetch preserves target CPU, explicit architectures and offline content',
  { timeout: 120000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'pnpm-seed-cpu-'));
    const packages = {};
    const requests = [];
    let broken = false;
    const server = createServer((request, response) => {
      requests.push(request.url);
      const name = request.url.split('/')[1];
      const pkg = packages[name];
      if (!pkg || (broken && request.url.endsWith('.tgz'))) {
        response.writeHead(404).end();
        return;
      }
      if (request.url.endsWith('.tgz')) {
        response.end(pkg.tar);
        return;
      }
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          name,
          'dist-tags': { latest: '1.0.0' },
          time: { '1.0.0': new Date(Date.now() - 3600000).toISOString() },
          versions: {
            '1.0.0': {
              ...pkg.manifest,
              dist: {
                integrity: pkg.integrity,
                tarball: `${registry}${name}/-/package.tgz`,
              },
            },
          },
        }),
      );
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const registry = `http://127.0.0.1:${server.address().port}/`;
    t.after(async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await rm(root, { recursive: true, force: true });
    });
    for (const cpu of ['common', 'x64', 'arm64']) {
      const name = `seed-platform-${cpu}`;
      const manifest = {
        name,
        version: '1.0.0',
        ...(cpu === 'common'
          ? {}
          : { cpu: [cpu], os: ['linux'], libc: ['glibc'] }),
      };
      const directory = join(root, name);
      await mkdir(join(directory, 'package'), { recursive: true });
      await writeFile(
        join(directory, 'package/package.json'),
        JSON.stringify(manifest),
      );
      await writeFile(join(directory, 'package/content.txt'), cpu);
      const packed = spawnSync('tar', [
        '-czf',
        '-',
        '-C',
        directory,
        'package',
      ]);
      assert.equal(packed.status, 0);
      packages[name] = {
        manifest,
        tar: packed.stdout,
        integrity: `sha512-${createHash('sha512').update(packed.stdout).digest('base64')}`,
      };
    }
    const dependencies = {
      'seed-platform-common': { specifier: '1.0.0', version: '1.0.0' },
    };
    const optionalDependencies = Object.fromEntries(
      ['x64', 'arm64'].map((cpu) => [
        `seed-platform-${cpu}`,
        { specifier: '1.0.0', version: '1.0.0' },
      ]),
    );
    const lock = JSON.stringify({
      lockfileVersion: '9.0',
      settings: { autoInstallPeers: true, excludeLinksFromLockfile: false },
      importers: { '.': { dependencies, optionalDependencies } },
      packages: Object.fromEntries(
        Object.entries(packages).map(([name, pkg]) => [
          `${name}@1.0.0`,
          {
            resolution: { integrity: pkg.integrity },
            ...(pkg.manifest.cpu
              ? {
                  cpu: pkg.manifest.cpu,
                  os: ['linux'],
                  libc: ['glibc'],
                  optional: true,
                }
              : {}),
          },
        ]),
      ),
      snapshots: Object.fromEntries(
        Object.entries(packages).map(([name, pkg]) => [
          `${name}@1.0.0`,
          pkg.manifest.cpu ? { optional: true } : {},
        ]),
      ),
    });
    const cases = [
      ['default-arm64', 'arm64', undefined, ['arm64']],
      ['default-x64', 'amd64', undefined, ['x64']],
      ['current', 'arm64', ['current'], ['arm64']],
      ['multi', 'arm64', ['current', 'x64', 'arm64'], ['x64', 'arm64']],
      ['explicit-other', 'arm64', ['x64'], ['x64']],
      ['empty', 'arm64', [], []],
    ];
    for (const [name, target, cpus, expected] of cases) {
      await t.test(name, async () => {
        const project = join(root, name);
        await mkdir(project);
        const manifest = JSON.stringify({
          name: 'fixture',
          version: '1.0.0',
          packageManager: pin,
          dependencies: { 'seed-platform-common': '1.0.0' },
          optionalDependencies: {
            'seed-platform-x64': '1.0.0',
            'seed-platform-arm64': '1.0.0',
          },
        });
        await writeFile(join(project, 'package.json'), manifest);
        await writeFile(join(project, 'pnpm-lock.yaml'), lock);
        await writeFile(join(project, '.npmrc'), `registry=${registry}\n`);
        await writeFile(
          join(project, 'pnpm-workspace.yaml'),
          JSON.stringify({
            fetchRetries: 0,
            supportedArchitectures: {
              os: ['linux'],
              libc: ['glibc'],
              ...(cpus === undefined ? {} : { cpu: cpus }),
            },
          }),
        );
        const store = join(project, 'store');
        const cache = join(project, 'cache');
        requests.length = 0;
        const fetched = await run(
          process.execPath,
          [helper, target, store, cache],
          project,
        );
        assert.equal(fetched.code, 0, fetched.output);
        assert.deepEqual(
          requests
            .filter((url) => url.endsWith('.tgz'))
            .map((url) => url.split('/')[1])
            .sort(),
          [
            'seed-platform-common',
            ...expected.map((cpu) => `seed-platform-${cpu}`),
          ].sort(),
        );
        const before = requests.length;
        const installed = await run(
          'pnpm',
          [
            'install',
            '--offline',
            '--frozen-lockfile',
            '--ignore-scripts',
            '--config.minimum-release-age=0',
            '--store-dir',
            store,
            `--config.cache-dir=${cache}`,
            ...expected.map((cpu) => `--cpu=${cpu}`),
          ],
          project,
        );
        assert.equal(installed.code, 0, installed.output);
        assert.equal(
          requests.length,
          before,
          'offline install made a registry request',
        );
        for (const cpu of ['common', ...expected])
          assert.equal(
            await readFile(
              join(project, `node_modules/seed-platform-${cpu}/content.txt`),
              'utf8',
            ),
            cpu,
          );
        assert.equal(
          await readFile(join(project, 'pnpm-lock.yaml'), 'utf8'),
          lock,
        );
        assert.equal(
          await readFile(join(project, 'package.json'), 'utf8'),
          manifest,
        );
        const version = await run('pnpm', ['--version'], project);
        assert.equal(version.code, 0, version.output);
        assert.equal(
          version.output.trim(),
          pin.slice('pnpm@'.length).split('+')[0],
        );
      });
    }
    await t.test('unsupported target fails before fetching', async () => {
      requests.length = 0;
      const result = await run(process.execPath, [helper, 'riscv64'], root);
      assert.notEqual(result.code, 0);
      assert.match(result.output, /unsupported seed target/);
      assert.equal(requests.length, 0);
    });
    await t.test('configuration read failure refuses fetch', async () => {
      const project = join(root, 'default-arm64');
      await writeFile(
        join(project, 'pnpm-workspace.yaml'),
        'supportedArchitectures: [\n',
      );
      requests.length = 0;
      const result = await run(process.execPath, [helper, 'arm64'], project);
      assert.notEqual(result.code, 0);
      assert.match(result.output, /could not read pnpm/);
      assert.equal(requests.length, 0);
    });
    await t.test('fetch failure propagates', async () => {
      const project = join(root, 'default-arm64');
      await writeFile(
        join(project, 'pnpm-workspace.yaml'),
        JSON.stringify({ fetchRetries: 0 }),
      );
      await rm(join(project, 'node_modules'), { recursive: true, force: true });
      broken = true;
      const result = await run(
        process.execPath,
        [
          helper,
          'arm64',
          join(project, 'failed-store'),
          join(project, 'failed-cache'),
        ],
        project,
      );
      assert.notEqual(result.code, 0, result.output);
      assert.match(result.output, /404/);
    });
  },
);

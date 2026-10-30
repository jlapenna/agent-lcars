#!/usr/bin/env node
import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  createArchive,
  loadAppHostingConfig,
  prepareBuildEnv,
} from './deploy-console-prebuilt.mjs';

const capture = async (command, args) =>
  (
    await promisify(execFile)(command, args, { maxBuffer: 1024 * 1024 })
  ).stdout.trim();
const run = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options });
    child.on('error', reject);
    child.on('exit', (code, signal) =>
      code === 0
        ? resolve()
        : reject(new Error(`${command} exited ${code ?? signal}`)),
    );
  });

// The runner is native amd64, matching Cloud Run's execution ABI. No Docker
// daemon, remote builder, QEMU, or Cloud Build participates in construction.
if (process.platform !== 'linux' || process.arch !== 'x64')
  throw new Error('Console image construction requires native linux/amd64');
const repo = await capture('git', ['rev-parse', '--show-toplevel']);
const commit = await capture('git', ['rev-parse', 'HEAD']);
const output = path.resolve(process.argv[2] ?? '.console-deploy');
if (output === repo)
  throw new Error('Image outputs must have their own directory');
const config = await loadAppHostingConfig(
  path.join(repo, 'apps/console/apphosting.yaml'),
  'agent-lcars',
);
const command = /^node ([A-Za-z0-9_./-]+)$/u.exec(config.runCommand);
if (!command || command[1].split('/').includes('..'))
  throw new Error('Expected a direct Node standalone launcher');
await mkdir(output, { recursive: true });
await run('bash', ['-c', config.buildCommand], {
  cwd: repo,
  env: {
    ...prepareBuildEnv(config),
    CI: 'true',
    LCARS_CONSOLE_BUILD_CPUS: '1',
  },
});
await run('bash', ['tools/console-standalone-smoke.sh'], { cwd: repo });
const archive = await createArchive(
  repo,
  ['dist/apps/console/.next/standalone'],
  `console-${commit}`,
);
const imageTar = path.join(output, 'console-image.tar');
try {
  await run('crane', [
    'mutate',
    '--platform=linux/amd64',
    'gcr.io/distroless/nodejs26-debian13@sha256:05ac5fead194ecb788387bd5f89b826f9ced2068db3a0b04759e003da6472d97',
    `--append=${archive.archivePath}`,
    `--cmd=/${command[1]}`,
    '--workdir=/',
    '--user=65532:65532',
    '--env=NODE_ENV=production',
    '--env=HOSTNAME=0.0.0.0',
    '--env=PORT=8080',
    `--label=org.opencontainers.image.revision=${commit}`,
    `--tag=agent-lcars-console:${commit}`,
    `--output=${imageTar}`,
  ]);
} finally {
  await rm(archive.tempDirectory, { recursive: true, force: true });
}
await run('crane', ['validate', `--tarball=${imageTar}`]);
const imageDigest = await capture('crane', ['digest', `--tarball=${imageTar}`]);
const hash = createHash('sha256');
for await (const chunk of createReadStream(imageTar)) hash.update(chunk);
await writeFile(
  path.join(output, 'image.json'),
  `${JSON.stringify({ commit, imageDigest, tarSha256: hash.digest('hex') }, null, 2)}\n`,
);
// The importer needs only this script and its one YAML dependency, not another
// workspace installation. Runtime secret references stay in the checked-out YAML.
await cp(
  path.join(repo, 'tools/deploy-console-prebuilt.mjs'),
  path.join(output, 'deploy-console-prebuilt.mjs'),
);
await mkdir(path.join(output, 'node_modules'), { recursive: true });
await cp(
  await realpath(path.join(repo, 'node_modules/yaml')),
  path.join(output, 'node_modules/yaml'),
  { recursive: true },
);
console.log(`Built ${imageDigest} from ${commit}`);

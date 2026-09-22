#!/usr/bin/env node
// Execute native probes against image-baked handlers, never host-mounted ones.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [provider, binary, expectedVersion, imageId, scenario] =
  process.argv.slice(2);
if (
  !['claude', 'codex', 'opencode'].includes(provider) ||
  !binary?.startsWith('/') ||
  !expectedVersion ||
  !/^sha256:[a-f0-9]{64}$/.test(imageId ?? '') ||
  process.getuid() === 0
)
  throw new Error(
    'Run as the image job user: <provider> <absolute-binary> <exact-version> <inspected-image-id> [scenario]',
  );

const source = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const baked = '/opt/agent-tools';
const runtime = '/usr/local/lib/agent-lcars/runtime';
const sha256 = (path) =>
  createHash('sha256').update(readFileSync(path)).digest('hex');
const moduleHashes = {};
for (const name of readdirSync(join(source, 'packages/fleet-tools/bin')).filter(
  (name) => /^(worker-|fleet-identity).*\.(cjs|mjs)$/.test(name),
)) {
  const expected = sha256(join(source, 'packages/fleet-tools/bin', name));
  const actual = sha256(join(baked, 'bin', name));
  if (actual !== expected) throw new Error(`Image source mismatch: ${name}`);
  moduleHashes[name] = actual;
}
if (!moduleHashes['worker-policy.cjs'])
  throw new Error('Worker modules missing');
const helper = 'worker-policy-bootstrap.sh';
const helperHash = sha256(join(runtime, helper));
if (
  helperHash !==
  sha256(join(source, 'apps/runner-autoscaler/runner-image/runtime', helper))
)
  throw new Error('Image bootstrap helper source mismatch');

const workspace = mkdtempSync(join(tmpdir(), 'lcars-image-probe-'));
cpSync(join(source, 'tools/probes'), join(workspace, 'tools/probes'), {
  recursive: true,
});
mkdirSync(join(workspace, 'packages'));
symlinkSync(baked, join(workspace, 'packages/fleet-tools'));
mkdirSync(join(workspace, 'apps/runner-autoscaler/runner-image'), {
  recursive: true,
});
symlinkSync(
  runtime,
  join(workspace, 'apps/runner-autoscaler/runner-image/runtime'),
);
if (realpathSync(join(workspace, 'packages/fleet-tools')) !== baked)
  throw new Error('Probe does not resolve image-baked handlers');

const driver =
  provider === 'opencode'
    ? 'opencode-hook-boundary.mjs'
    : 'command-hook-boundary.mjs';
const args = [
  join(workspace, 'tools/probes', driver),
  ...(provider === 'opencode' ? [] : [provider]),
  binary,
  expectedVersion,
  ...(scenario ? [scenario] : []),
];
const result = spawnSync(process.execPath, args, {
  cwd: workspace,
  env: { PATH: process.env.PATH, HOME: process.env.HOME },
  encoding: 'utf8',
  timeout: 45 * 60000,
  maxBuffer: 8 * 1024 * 1024,
});
writeFileSync(join(workspace, 'stdout.txt'), result.stdout ?? '');
writeFileSync(join(workspace, 'stderr.txt'), result.stderr ?? '');
let nativeReport;
try {
  nativeReport = JSON.parse(result.stdout);
} catch {
  /* Retain diagnostics. */
}
const passed =
  result.status === 0 &&
  !result.error &&
  nativeReport?.observations?.length > 0 &&
  nativeReport.observations.every(
    (entry) => entry.observedExpectedPrimitive === true,
  );
const report = {
  imageId,
  provider,
  jobUid: process.getuid(),
  moduleHashes,
  bootstrapHelperHash: helperHash,
  passed,
  qualification: 'not-evaluated',
  nativeReport,
  diagnosticsDirectory: workspace,
  error: result.error?.message,
};
writeFileSync(
  join(workspace, 'image-observations.json'),
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report, null, 2));
process.exitCode = passed ? 0 : 1;

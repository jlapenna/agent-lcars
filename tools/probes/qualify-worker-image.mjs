#!/usr/bin/env node
// Isolated local candidate qualification. No build, publish, or rollout.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  artifactHashes,
  evaluateImageEvidence,
} from './qualification-evidence.mjs';
import { imageScenario } from './qualification-scenario.mjs';
import { imageVersion } from './qualification-version.mjs';

const [provider, imageId, outputPath, ...extra] = process.argv.slice(2);
if (
  !['claude', 'codex', 'opencode'].includes(provider) ||
  !/^sha256:[a-f0-9]{64}$/.test(imageId ?? '') ||
  !outputPath ||
  extra.length
)
  throw new Error(
    'usage: qualify-worker-image.mjs <provider> <inspected-sha256-image-id> <new-output-directory>',
  );

const source = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = resolve(outputPath);
// Mount syntax cannot safely represent these path delimiters.
if (source.includes(',') || source.includes(':'))
  throw new Error('Source path contains an unsupported mount delimiter');
const command = (binary, args, timeout = 30000) => {
  const result = spawnSync(binary, args, {
    cwd: source,
    encoding: 'utf8',
    timeout,
    killSignal: 'SIGKILL',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      binary + ' failed: ' + (result.error?.message ?? result.stderr),
    );
  return result.stdout.trim();
};
const sourceCommit = command('git', ['rev-parse', 'HEAD']);
command('git', [
  'diff',
  '--exit-code',
  'HEAD',
  '--',
  'tools/probes',
  'packages/fleet-tools/bin',
  'apps/runner-autoscaler/runner-image',
]);
if (
  command('git', [
    'ls-files',
    '--others',
    '--exclude-standard',
    '--',
    'tools/probes',
    'packages/fleet-tools/bin',
    'apps/runner-autoscaler/runner-image',
  ])
)
  throw new Error('Qualification inputs must be committed');
const startedAt = new Date().toISOString();
const inspected = JSON.parse(command('docker', ['image', 'inspect', imageId]));
if (inspected.length !== 1 || inspected[0].Id !== imageId)
  throw new Error(
    'Candidate must resolve to the exact inspected local image ID',
  );
mkdirSync(output); // Never overwrite another qualification run.

const isolation = [
  '--network',
  'none',
  '--user',
  '1001:1001',
  '--cpus',
  '2',
  '--memory',
  '2g',
  '--pids-limit',
  '256',
];
const [binary, providerVersion, ...unexpected] = (
  await imageVersion(
    [
      ...isolation,
      '--entrypoint',
      '/bin/bash',
      imageId,
      '-c',
      'command -v "$1"; "$1" --version',
      'qualification-version',
      provider,
    ],
    output,
  )
).split('\n');
if (!binary?.startsWith('/') || !providerVersion || unexpected.length)
  throw new Error('Cannot establish exact image-baked CLI identity');
const expected = {
  provider,
  providerVersion,
  imageId,
  sourceCommit,
  ...artifactHashes(source),
};
writeFileSync(join(output, 'expected.json'), JSON.stringify(expected, null, 2));

const mounts = [
  'tools/probes',
  'packages/fleet-tools/bin',
  'apps/runner-autoscaler/runner-image/direct-runner.sh',
  ...[
    'worker-policy-bootstrap.sh',
    'verify-outcome.sh',
    'worker-completion.sh',
  ].map((name) => 'apps/runner-autoscaler/runner-image/runtime/' + name),
].flatMap((path) => [
  '--mount',
  'type=bind,src=' +
    join(source, path) +
    ',dst=/qualification/' +
    path +
    ',readonly',
]);
const reports = [];
for (const scenario of ['native', 'setup-negative']) {
  const report = await imageScenario(
    [
      ...isolation,
      ...mounts,
      '-e',
      'LCARS_PROBE_KEEP_EVIDENCE=1',
      '--entrypoint',
      'node',
      imageId,
      '/qualification/tools/probes/in-runner-image.mjs',
      provider,
      binary,
      providerVersion,
      imageId,
      ...(scenario === 'native' ? [] : [scenario]),
    ],
    output,
    scenario,
  );
  reports.push(report);
}
const result = evaluateImageEvidence(expected, ...reports);
writeFileSync(
  join(output, 'qualification.json'),
  JSON.stringify(
    {
      ...expected,
      ...result,
      startedAt,
      completedAt: new Date().toISOString(),
      evidence: [
        'native/image-observations.json',
        'setup-negative/image-observations.json',
      ],
    },
    null,
    2,
  ),
);
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.offlinePassed ? 0 : 1;

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
const [binary, providerVersion, ...unexpected] = command('docker', [
  'run',
  '--rm',
  ...isolation,
  '--entrypoint',
  '/bin/bash',
  imageId,
  '-c',
  'command -v "$1"; "$1" --version',
  'qualification-version',
  provider,
]).split('\n');
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
  const container = command('docker', [
    'create',
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
  ]);
  let copied = false;
  try {
    const execution = spawnSync('docker', ['start', '--attach', container], {
      encoding: 'utf8',
      timeout: 50 * 60000,
      maxBuffer: 16 * 1024 * 1024,
    });
    writeFileSync(
      join(output, scenario + '.stdout.txt'),
      execution.stdout ?? '',
    );
    writeFileSync(
      join(output, scenario + '.stderr.txt'),
      execution.stderr ?? '',
    );
    // docker start can disconnect on timeout while the container keeps running.
    if (execution.error) command('docker', ['kill', container]);
    const report = JSON.parse(execution.stdout);
    const state = JSON.parse(
      command('docker', ['inspect', '--format', '{{json .State}}', container]),
    );
    if (
      execution.error ||
      execution.status !== 0 ||
      state.Running ||
      state.ExitCode !== 0
    )
      report.passed = false;
    if (
      !/^\/tmp\/lcars-image-probe-[A-Za-z0-9]+$/.test(
        report.diagnosticsDirectory ?? '',
      )
    )
      throw new Error('Invalid image diagnostics directory');
    command(
      'docker',
      [
        'cp',
        container + ':' + report.diagnosticsDirectory,
        join(output, scenario),
      ],
      120000,
    );
    const nativeRoot = report.nativeReport?.evidenceDirectory;
    if (/^\/tmp\/lcars-[A-Za-z0-9-]+$/.test(nativeRoot ?? ''))
      command(
        'docker',
        [
          'cp',
          container + ':' + nativeRoot,
          join(output, scenario + '-diagnostics'),
        ],
        120000,
      );
    reports.push(report);
    copied = true;
  } finally {
    // Keep a failed container when its diagnostics could not be collected.
    if (copied) command('docker', ['rm', container]);
    else
      process.stderr.write(
        'Uncollected qualification container retained: ' + container + '\n',
      );
  }
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

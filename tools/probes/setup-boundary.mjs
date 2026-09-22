#!/usr/bin/env node
// Candidate-image setup failures must be terminal before the task launch path.
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [provider, binary, expectedVersion] = process.argv.slice(2);
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
if (
  !['codex', 'claude', 'opencode'].includes(provider) ||
  !binary?.startsWith('/')
)
  throw new Error('Expected provider and absolute CLI path');
const root = mkdtempSync(join(tmpdir(), `lcars-${provider}-setup-probe-`));
const version = spawnSync(binary, ['--version'], {
  encoding: 'utf8',
  timeout: 10000,
});
if (version.status !== 0 || version.stdout.trim() !== expectedVersion)
  throw new Error('Pinned CLI version mismatch');

const observations = [];
for (const mode of ['malformed-config', 'symlink-config', 'missing-setup']) {
  const dir = mkdtempSync(join(root, `${mode}-`));
  const config = join(dir, 'provider.json');
  const original =
    mode === 'malformed-config'
      ? '{invalid configuration\n'
      : '{"preserve":"unrelated"}\n';
  const target =
    mode === 'symlink-config' ? join(dir, 'linked-original.json') : config;
  writeFileSync(target, original);
  if (target !== config) symlinkSync(target, config);
  const retained = join(dir, 'unpublished-work');
  writeFileSync(retained, 'retain useful work\n');
  const brief = join(dir, 'brief.json');
  writeFileSync(
    brief,
    JSON.stringify({
      repository: 'octo/example',
      mode: 'implement',
      anchor: { type: 'issue', number: 42 },
    }),
  );
  const launched = join(dir, 'launch-reached');
  const result = spawnSync(
    'bash',
    [
      '-c',
      'source "$1"; worker_policy_bootstrap "$2" || exit $?; printf "launch reached" > "$3"',
      'setup-boundary',
      join(
        repoRoot,
        'apps/runner-autoscaler/runner-image/runtime/worker-policy-bootstrap.sh',
      ),
      config,
      launched,
    ],
    {
      cwd: dir,
      env: {
        PATH: process.env.PATH,
        HOME: dir,
        RUNNER_TEMP: dir,
        PIPELINE: provider,
        LCARS_WORKER_POLICY_PROVIDERS: provider,
        LCARS_RUN_ID: 'octo/example#42/r1',
        ATTEMPT_ID: 'g1:octo/example#42/r1',
        AGENT_DISPATCH_CONTEXT: brief,
        WORKER_POLICY_SETUP:
          mode === 'missing-setup'
            ? join(dir, 'absent-setup.cjs')
            : join(repoRoot, 'packages/fleet-tools/bin/worker-hook-setup.cjs'),
      },
      encoding: 'utf8',
      timeout: 15000,
    },
  );
  const preservedWork =
    readFileSync(retained, 'utf8') === 'retain useful work\n';
  const preservedConfig = readFileSync(target, 'utf8') === original;
  const launchReached = existsSync(launched);
  const expectedFailure = result.stderr?.includes('worker will not launch');
  writeFileSync(join(dir, 'stdout.txt'), result.stdout ?? '');
  writeFileSync(join(dir, 'stderr.txt'), result.stderr ?? '');
  observations.push({
    mode,
    code: result.status,
    preservedWork,
    preservedConfig,
    launchReached,
    observedExpectedPrimitive:
      result.status === 1 &&
      !result.error &&
      expectedFailure &&
      !launchReached &&
      preservedWork &&
      preservedConfig,
  });
}
const report = {
  provider,
  providerVersion: expectedVersion,
  qualification: 'not-evaluated',
  observations,
  evidenceDirectory: root,
};
writeFileSync(join(root, 'observations.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exitCode = observations.every(
  (entry) => entry.observedExpectedPrimitive,
)
  ? 0
  : 1;

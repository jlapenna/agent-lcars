// Track the version-probe container too: killing a Docker client does not stop it.
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function imageVersion(args, output, timeout = 30000, docker = 'docker') {
  const invoke = (command) =>
    spawnSync(docker, command, {
      encoding: 'utf8',
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    });
  const created = invoke(['create', ...args]);
  if (created.error || created.status !== 0 || !created.stdout.trim())
    throw new Error('Cannot create image version probe');
  const container = created.stdout.trim();
  let stopped = false;
  try {
    const execution = spawnSync(docker, ['start', '--attach', container], {
      encoding: 'utf8',
      timeout,
      maxBuffer: 1024 * 1024,
    });
    writeFileSync(join(output, 'version.stdout.txt'), execution.stdout ?? '');
    writeFileSync(join(output, 'version.stderr.txt'), execution.stderr ?? '');
    if (execution.error) {
      const killed = invoke(['kill', container]);
      stopped = !killed.error && killed.status === 0;
      throw new Error('Image version probe timed out or failed to attach');
    }
    const inspected = invoke([
      'inspect',
      '--format',
      '{{json .State}}',
      container,
    ]);
    if (inspected.error || inspected.status !== 0)
      throw new Error('Cannot verify image version probe exit');
    const state = JSON.parse(inspected.stdout);
    stopped = state.Running === false;
    if (!stopped || execution.status !== 0 || state.ExitCode !== 0)
      throw new Error('Image version probe did not complete successfully');
    return execution.stdout.trim();
  } finally {
    // Also cover collection/parsing exceptions while the container is running.
    if (!stopped) {
      const killed = invoke(['kill', container]);
      stopped = !killed.error && killed.status === 0;
    }
    const removed = stopped ? invoke(['rm', container]) : null;
    if (!removed || removed.error || removed.status !== 0)
      process.stderr.write(
        'Version probe container retained: ' + container + '\n',
      );
  }
}

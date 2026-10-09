import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runImageContainer } from './qualification-container.mjs';

export function imageVersion(
  args,
  output,
  timeout = 30000,
  docker = 'docker',
  options = {},
) {
  return runImageContainer(
    args,
    async (container, execution, command) => {
      writeFileSync(join(output, 'version.stdout.txt'), execution.stdout ?? '');
      writeFileSync(join(output, 'version.stderr.txt'), execution.stderr ?? '');
      if (execution.error || execution.status !== 0)
        throw new Error('Image version probe timed out or failed to attach');
      const state = JSON.parse(
        await command(['inspect', '--format', '{{json .State}}', container]),
      );
      if (state?.Running !== false || state.ExitCode !== 0)
        throw new Error('Image version probe did not complete successfully');
      return execution.stdout.trim();
    },
    { docker, timeout, ...options },
  );
}

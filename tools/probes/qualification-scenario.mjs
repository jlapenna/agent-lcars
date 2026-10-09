import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runImageContainer } from './qualification-container.mjs';

export function imageScenario(args, output, scenario, options = {}) {
  return runImageContainer(
    args,
    async (container, execution, command) => {
      writeFileSync(
        join(output, scenario + '.stdout.txt'),
        execution.stdout ?? '',
      );
      writeFileSync(
        join(output, scenario + '.stderr.txt'),
        execution.stderr ?? '',
      );
      if (execution.error || execution.status !== 0)
        throw new Error('Image scenario timed out or failed to attach');
      const report = JSON.parse(execution.stdout);
      const state = JSON.parse(
        await command(['inspect', '--format', '{{json .State}}', container]),
      );
      if (state?.Running !== false || state.ExitCode !== 0)
        throw new Error('Image scenario did not complete successfully');
      if (
        !/^\/tmp\/lcars-image-probe-[A-Za-z0-9]+$/.test(
          report.diagnosticsDirectory ?? '',
        )
      )
        throw new Error('Invalid image diagnostics directory');
      await command(
        [
          'cp',
          container + ':' + report.diagnosticsDirectory,
          join(output, scenario),
        ],
        120000,
      );
      const nativeRoot = report.nativeReport?.evidenceDirectory;
      if (!/^\/tmp\/lcars-[A-Za-z0-9-]+$/.test(nativeRoot ?? ''))
        throw new Error(
          'Missing or invalid native fixture diagnostics directory',
        );
      await command(
        [
          'cp',
          container + ':' + nativeRoot,
          join(output, scenario + '-diagnostics'),
        ],
        120000,
      );
      return report;
    },
    { timeout: 50 * 60000, ...options },
  );
}

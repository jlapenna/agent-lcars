import { spawnSync } from 'node:child_process';

import {
  defaultHookCommandDependencies,
  executeHookCommand,
  flusherBundlePath,
} from './lib/hook/hook-command';
import { executeIntegrationCommand } from './lib/hook/integration';
import {
  defaultInvestigateCommandDeps,
  executeInvestigateCommand,
} from './lib/investigate-command';
import { executeSessionTitleAnnotationCommand } from './lib/session-title-annotation-command';
import { defaultWorkCommandDeps, executeWorkCommand } from './lib/work-command';

// The bundle target (`session-title-cli`) builds CJS, which cannot execute a
// top-level `await` -- the `work` dispatch is async (it calls the LCARS API
// and, for status --watch, polls), so it runs inside an IIFE instead.
void (async () => {
  const argv = process.argv.slice(2);
  if (argv[0] === 'session' && argv[1] === 'archive') {
    // Keep storage credentials and clients in the existing flusher bundle.
    const child = spawnSync(
      process.execPath,
      [flusherBundlePath(), 'archive', ...argv.slice(2)],
      {
        stdio: 'inherit',
        timeout: 120_000,
      },
    );
    process.exitCode = child.status === 0 ? 0 : 1;
    return;
  }
  if (argv[0] === 'investigate') {
    const result = await executeInvestigateCommand(
      argv.slice(1),
      defaultInvestigateCommandDeps(process.env),
    );
    process.exitCode = result.ok ? 0 : 1;
    return;
  }
  if (argv[0] === 'hook') {
    // Runtime hook entry (docs/hooks-telemetry-design.md). Exit 0 whatever
    // happened: a hook that fails or prints would degrade the agent, and
    // `hook-command.ts` already recorded the decision in hook.log.
    await executeHookCommand(argv.slice(1), defaultHookCommandDependencies());
    process.exitCode = 0;
    return;
  }
  if (argv[0] === 'integration') {
    // Operator command: installs/removes the runtime hook entries and the
    // launcher stub they call (docs/hooks-telemetry-design.md §4.7).
    process.exitCode = executeIntegrationCommand(argv.slice(1));
    return;
  }
  if (argv[0] === 'work') {
    // `executeWorkCommand` already writes its own usage/error lines to
    // stderr through `WorkCommandDeps.stderr` -- printing `result.usage`
    // again here would just duplicate that line.
    const result = await executeWorkCommand(
      argv.slice(1),
      defaultWorkCommandDeps(process.env),
    );
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  const result = executeSessionTitleAnnotationCommand(argv);
  if (result.usage) {
    // Covers both an explicit --help/-h/no-argv request and every
    // invalid-command result -- an agent that ran this CLI wrong learns the
    // whole surface right here instead of having to go find docs.
    process.stderr.write(`${result.usage}\n`);
  }
  if (!result.ok) {
    // Keep failures useful to a shell while never disclosing titles, paths,
    // session ids, or platform/filesystem details.
    process.stderr.write('session title command failed\n');
    process.exitCode = 1;
  }
})();

import { executeSessionTitleAnnotationCommand } from './lib/session-title-annotation-command';
import { defaultWorkCommandDeps, executeWorkCommand } from './lib/work-command';

// The bundle target (`session-title-cli`) builds CJS, which cannot execute a
// top-level `await` -- the `work` dispatch is async (it calls the LCARS API
// and, for status --watch, polls), so it runs inside an IIFE instead.
void (async () => {
  const argv = process.argv.slice(2);
  if (argv[0] === 'work') {
    const result = await executeWorkCommand(
      argv.slice(1),
      defaultWorkCommandDeps(process.env),
    );
    if (result.usage) process.stderr.write(`${result.usage}\n`);
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

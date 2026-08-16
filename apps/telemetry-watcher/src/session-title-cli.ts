import { executeSessionTitleAnnotationCommand } from './lib/session-title-annotation-command';

const result = executeSessionTitleAnnotationCommand(process.argv.slice(2));
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

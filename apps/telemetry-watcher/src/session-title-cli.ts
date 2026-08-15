import { executeSessionTitleAnnotationCommand } from './lib/session-title-annotation-command';

const result = executeSessionTitleAnnotationCommand(process.argv.slice(2));
if (!result.ok) {
  // Keep failures useful to a shell while never disclosing titles, paths,
  // session ids, or platform/filesystem details.
  process.stderr.write('session title command failed\n');
  process.exitCode = 1;
}

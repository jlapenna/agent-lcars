import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function applyJobSecrets(delivery, environment, directory) {
  try {
    if (
      !delivery ||
      !delivery.environment ||
      !delivery.files ||
      Object.keys(delivery).some(
        (key) => !['environment', 'files'].includes(key),
      )
    )
      throw new Error();
    const environmentEntries = Object.entries(delivery.environment);
    const fileEntries = Object.entries(delivery.files);
    if (environmentEntries.length + fileEntries.length > 16) throw new Error();
    const valueValid = (value) =>
      typeof value === 'string' &&
      value.length > 0 &&
      !value.includes('\0') &&
      Buffer.byteLength(value) <= 16384;
    for (const [key, value] of environmentEntries) {
      if (
        !/^[A-Z][A-Z0-9_]{0,127}$/u.test(key) ||
        /^(?:PATH|HOME|ENV|SHELL|IFS|TMPDIR|USER|LOGNAME|WORKSPACE|REPOSITORY|SHELLOPTS|BASHOPTS|CDPATH|GLOBIGNORE|NODE_OPTIONS|NODE_PATH)$/u.test(
          key,
        ) ||
        /^(?:LCARS_|AGENT_|GOOSE_|GIT_|GITHUB_|GH_|ACTIONS_|RUNNER_|PROVIDER_|AUTH_|GOOGLE_|GCP_|BASH_|LD_|DYLD_|PYTHON|NPM_|PNPM_)/u.test(
          key,
        ) ||
        !valueValid(value)
      )
        throw new Error();
    }
    for (const [key, value] of fileEntries)
      if (!/^[a-z][a-z0-9-]{0,63}$/u.test(key) || !valueValid(value))
        throw new Error();
    if (fileEntries.length) {
      await mkdir(directory, { mode: 0o700 });
      for (const [key, value] of fileEntries)
        await writeFile(join(directory, key), value, {
          mode: 0o600,
          flag: 'wx',
        });
      environment.LCARS_JOB_SECRET_FILES_DIR = directory;
    }
    Object.assign(environment, delivery.environment);
  } catch {
    throw new Error('Job secret bindings refused or unavailable');
  }
}

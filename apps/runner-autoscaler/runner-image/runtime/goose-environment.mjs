// The Goose provider environment comes from the runner credential Secret's
// shared `goose-environment.json` (docs/repository-jobs.md, "Configuration and
// operation"). Job-specific credentials come from LCARS credential sets
// (docs/job-secrets.md), never from per-profile Homelab files.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const SECRETS_DIR = '/run/secrets';

export function validateGooseEnvironment(environment, label) {
  if (
    !environment ||
    Array.isArray(environment) ||
    typeof environment !== 'object' ||
    Object.entries(environment).some(
      ([key, value]) =>
        typeof value !== 'string' ||
        key.startsWith('LCARS_') ||
        key === 'GOOGLE_APPLICATION_CREDENTIALS',
    )
  )
    throw new Error(`Invalid Goose provider environment (${label})`);
  return environment;
}

export async function loadGooseEnvironment({
  secretsDir = SECRETS_DIR,
  read = (file) => readFile(file, 'utf8'),
} = {}) {
  return {
    ...validateGooseEnvironment(
      JSON.parse(await read(join(secretsDir, 'goose-environment.json'))),
      'goose-environment.json',
    ),
  };
}

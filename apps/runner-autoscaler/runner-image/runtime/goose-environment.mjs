// The Goose provider environment comes from the runner credential Secret:
// the shared `goose-environment.json`, optionally overlaid by the
// profile-selected `goose-environment.<name>.json` (docs/repository-jobs.md,
// "Configuration and operation"). Overlay keys win; both files obey the same
// shape rules. A profile that names an overlay the Secret does not carry
// fails the run rather than silently running on the shared environment.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const SECRETS_DIR = '/run/secrets';
const OVERLAY_NAME = /^[a-z][a-z0-9-]{0,63}$/u;

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
  overlay,
  secretsDir = SECRETS_DIR,
  read = (file) => readFile(file, 'utf8'),
} = {}) {
  const base = validateGooseEnvironment(
    JSON.parse(await read(join(secretsDir, 'goose-environment.json'))),
    'goose-environment.json',
  );
  if (overlay === undefined) return { ...base };
  if (typeof overlay !== 'string' || !OVERLAY_NAME.test(overlay))
    throw new Error('Invalid Goose environment overlay name');
  const file = `goose-environment.${overlay}.json`;
  let text;
  try {
    text = await read(join(secretsDir, file));
  } catch (error) {
    throw new Error(
      `Goose environment overlay ${file} is not provisioned in the runner credential Secret`,
      { cause: error },
    );
  }
  return { ...base, ...validateGooseEnvironment(JSON.parse(text), file) };
}

import { execFileSync } from 'node:child_process';
import {
  chmod,
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_ORIGIN = 'https://lcars.jlapenna.net';
export const DEFAULT_PROJECT = 'agent-lcars';
export const SESSION_ROLES = ['admin', 'user'];
export const STORAGE_BACKENDS = ['local', 'secret'];

export function isSessionRole(value) {
  return SESSION_ROLES.includes(value);
}

export function isStorageBackend(value) {
  return STORAGE_BACKENDS.includes(value);
}

export function normalizeOrigin(value = DEFAULT_ORIGIN) {
  const url = new URL(value);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      `Origin must be an http(s) origin without credentials, a path, query, or hash: ${value}`,
    );
  }
  return url.origin;
}

export function targetUrlFor(origin, targetPath) {
  if (!targetPath.startsWith('/') || targetPath.startsWith('//')) {
    throw new Error(`Path must start with one slash: ${targetPath}`);
  }
  const normalizedOrigin = normalizeOrigin(origin);
  const target = new URL(targetPath, normalizedOrigin);
  if (target.origin !== normalizedOrigin) {
    throw new Error(`Path must stay on ${normalizedOrigin}: ${targetPath}`);
  }
  return target;
}

function normalizedSearch(url) {
  const search = new URLSearchParams(url.search);
  search.sort();
  const serialized = search.toString();
  return serialized ? `?${serialized}` : '';
}

export function matchesTargetLocation(landed, target) {
  return (
    landed.origin === target.origin &&
    landed.pathname === target.pathname &&
    normalizedSearch(landed) === normalizedSearch(target) &&
    landed.hash === target.hash
  );
}

export function assertSuccessfulNavigation(response, target) {
  if (!response) {
    throw new Error(`Navigation to ${target.toString()} returned no response.`);
  }
  if (!response.ok()) {
    throw new Error(
      `Navigation to ${target.toString()} returned HTTP ${response.status()} ${response.statusText()}.`,
    );
  }
}

export function sessionStatus(session, role) {
  if (!session?.user) return 'expired';
  if (role === 'admin' && session.user.isAdmin !== true) {
    return 'wrong-role';
  }
  return 'ok';
}

export function verificationStatus(session, role, landed, target) {
  const authentication = sessionStatus(session, role);
  if (authentication !== 'ok') return authentication;
  return matchesTargetLocation(landed, target) ? 'ok' : 'redirected';
}

export function secretNameForRole(role) {
  if (!isSessionRole(role)) throw new Error(`Unknown session role: ${role}`);
  return `AGENT_LCARS_${role.toUpperCase()}_STORAGE_STATE`;
}

export function defaultStatePath(
  role,
  { env = process.env, homeDirectory = os.homedir() } = {},
) {
  if (!isSessionRole(role)) throw new Error(`Unknown session role: ${role}`);
  const stateRoot = env.XDG_STATE_HOME
    ? path.resolve(env.XDG_STATE_HOME)
    : path.join(homeDirectory, '.local', 'state');
  return path.join(stateRoot, 'agent-lcars', 'sessions', `${role}.json`);
}

export function resolveStatePath(role, explicitPath) {
  return explicitPath ? path.resolve(explicitPath) : defaultStatePath(role);
}

export function parseStorageState(serialized) {
  let value;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error('Saved session is not valid JSON.');
  }
  if (!Array.isArray(value?.cookies) || !Array.isArray(value?.origins)) {
    throw new Error(
      'Saved session is not a Playwright storage state (cookies/origins are missing).',
    );
  }
  return value;
}

function secretVersionId(name) {
  const match = /\/versions\/([1-9][0-9]*)$/u.exec(name);
  if (!match) {
    throw new Error('Secret Manager did not return a valid version name.');
  }
  return match[1];
}

function supersededSecretVersionIds(serializedVersions, replacementName) {
  const versions = JSON.parse(serializedVersions);
  if (!Array.isArray(versions)) {
    throw new Error('Secret Manager version list was not an array.');
  }
  secretVersionId(replacementName);

  return versions.flatMap((version) => {
    if (
      !version ||
      typeof version.name !== 'string' ||
      (version.state !== undefined && typeof version.state !== 'string')
    ) {
      throw new Error(
        'Secret Manager version list contained an invalid entry.',
      );
    }
    if (version.name === replacementName || version.state === 'DESTROYED') {
      return [];
    }
    return [secretVersionId(version.name)];
  });
}

function destroySupersededSecretVersions(
  secretName,
  project,
  replacementName,
  runFile,
) {
  const versions = runFile(
    'gcloud',
    [
      'secrets',
      'versions',
      'list',
      secretName,
      `--project=${project}`,
      '--filter=state!=DESTROYED',
      '--format=json',
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const versionIds = supersededSecretVersionIds(versions, replacementName);
  for (const versionId of versionIds) {
    runFile(
      'gcloud',
      [
        'secrets',
        'versions',
        'destroy',
        versionId,
        `--secret=${secretName}`,
        `--project=${project}`,
        '--quiet',
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
  }
  return versionIds.length;
}

/** Expiry of the shortest-lived Auth.js session-cookie chunk, in epoch
 * seconds. Captured browser state can contain unrelated cookies (and Auth.js
 * can split a large token into numbered chunks), so only the session-token
 * family participates. Undefined means the browser state has no persistent
 * Auth.js expiry and therefore cannot provide a rotation warning. */
export function savedSessionExpiration(storageState) {
  const expirations = storageState.cookies
    .filter(
      (cookie) =>
        /authjs\.session-token(?:\.\d+)?$/u.test(cookie.name) &&
        Number.isFinite(cookie.expires) &&
        cookie.expires > 0,
    )
    .map((cookie) => cookie.expires);
  return expirations.length > 0 ? Math.min(...expirations) : undefined;
}

async function writePrivateFile(destination, contents) {
  const directory = path.dirname(destination);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryMode = (await stat(directory)).mode & 0o777;
  if ((directoryMode & 0o077) !== 0) {
    throw new Error(
      `Refusing to write a live session into non-private directory ${directory}. ` +
        'Choose a directory accessible only to your user (mode 0700).',
    );
  }

  const temporary = `${destination}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, contents, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    await chmod(temporary, 0o600);
    await rename(temporary, destination);
    await chmod(destination, 0o600);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

export async function saveStorageState(
  storageState,
  {
    storage,
    role,
    stateFile,
    project = DEFAULT_PROJECT,
    secretName = secretNameForRole(role),
  },
  { runFile = execFileSync } = {},
) {
  const serialized = `${JSON.stringify(storageState, null, 2)}\n`;
  parseStorageState(serialized);

  if (storage === 'local') {
    const destination = resolveStatePath(role, stateFile);
    await writePrivateFile(destination, serialized);
    return { kind: 'local', destination };
  }

  if (storage !== 'secret') {
    throw new Error(`Unknown storage backend: ${storage}`);
  }

  const encoded = Buffer.from(serialized).toString('base64');
  let replacementName;
  try {
    replacementName = runFile(
      'gcloud',
      [
        'secrets',
        'versions',
        'add',
        secretName,
        `--project=${project}`,
        '--data-file=-',
        '--format=value(name)',
      ],
      { encoding: 'utf8', input: encoded, stdio: ['pipe', 'pipe', 'pipe'] },
    );
  } catch {
    throw new Error(
      `Could not add a version to ${secretName} in ${project}. The tool never creates ` +
        'secret containers; a maintainer must provision the container through the reviewed infrastructure workflow first.',
    );
  }
  try {
    destroySupersededSecretVersions(
      secretName,
      project,
      replacementName.trim(),
      runFile,
    );
  } catch (error) {
    throw new Error(
      `Added a replacement version to ${secretName} in ${project}, but could not prune older versions. ` +
        'The replacement remains available; inspect Secret Manager before retrying.',
      { cause: error },
    );
  }
  return { kind: 'secret', destination: `${project}/${secretName}` };
}

export async function loadStorageState(
  {
    storage,
    role,
    stateFile,
    project = DEFAULT_PROJECT,
    secretName = secretNameForRole(role),
  },
  { runFile = execFileSync } = {},
) {
  if (storage === 'local') {
    const source = resolveStatePath(role, stateFile);
    const serialized = await readFile(source, 'utf8').catch(() => {
      throw new Error(
        `Could not read saved ${role} session at ${source}. Run the capture command first.`,
      );
    });
    return { storageState: parseStorageState(serialized), source };
  }

  if (storage !== 'secret') {
    throw new Error(`Unknown storage backend: ${storage}`);
  }

  let encoded;
  try {
    encoded = runFile(
      'gcloud',
      [
        'secrets',
        'versions',
        'access',
        'latest',
        `--secret=${secretName}`,
        `--project=${project}`,
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
  } catch {
    throw new Error(
      `Could not read ${secretName} from ${project}. Confirm the secret exists and your identity has secretAccessor on that secret.`,
    );
  }

  let serialized;
  try {
    serialized = Buffer.from(encoded, 'base64').toString('utf8');
  } catch {
    throw new Error(`Saved session in ${project}/${secretName} is not base64.`);
  }
  return {
    storageState: parseStorageState(serialized),
    source: `${project}/${secretName}`,
  };
}

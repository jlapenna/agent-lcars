import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Where the `lcars hook` client finds its own configuration on a host. Both
 * files are written by homegit (docs/hooks-telemetry-design.md §4.6);
 * environment variables override them for tests and one-off runs.
 */
export const HOOK_CONFIG_DIRECTORY = path.join('.config', 'agent-lcars');
export const HOOK_CONFIG_FILE = 'config.json';
/** The `telemetry-writer` service-account key, mode 0600. */
export const HOOK_WRITER_KEY_FILE = 'writer-key.json';
export const DEFAULT_TELEMETRY_PROJECT_ID = 'agent-lcars';

/** How the flusher authenticates to the telemetry store. */
export interface HookWriterCredentials {
  readonly projectId: string;
  /** Service-account key; absent means Application Default Credentials. */
  readonly credentials?: { client_email: string; private_key: string };
  /** A Google credentials file of any supported type (the runner's
   *  short-lived telemetry-writer file), passed only to the Firestore client
   *  so it never becomes ambient credentials for the agent. */
  readonly credentialsFile?: string;
  readonly emulatorHost?: string;
}

export interface HookClientConfig {
  /** `owner/name` allowlist patterns, see `matchesRepoAllowlist`. */
  readonly repos: readonly string[];
  /** Where the flusher writes; absent means "spool only". */
  readonly writer?: HookWriterCredentials;
  /** Host label recorded on each event. */
  readonly host: string;
  /** Present on a QueueExecutor runner: the dispatched run this session
   * belongs to. Runner sessions bypass the repo allowlist exactly as the
   * sidecar's `runnerWatchRoots` does, since the container is single-purpose. */
  readonly runner?: {
    readonly runId: string;
    readonly intentId?: string;
    readonly issueNumber?: number;
    readonly repo: { owner: string; name: string };
  };
}

export interface HookClientConfigDependencies {
  homeDirectory?: string;
  env?: NodeJS.ProcessEnv;
  readFile?: (filePath: string) => string;
  hostname?: () => string;
}

function readOptional(
  readFile: (filePath: string) => string,
  filePath: string,
): string | undefined {
  try {
    return readFile(filePath);
  } catch {
    return undefined;
  }
}

function parseRepos(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return [];
    const repos = (parsed as { repos?: unknown }).repos;
    return Array.isArray(repos)
      ? repos.filter((entry): entry is string => typeof entry === 'string')
      : [];
  } catch {
    return [];
  }
}

function parseRepoSlug(
  raw: string | undefined,
): { owner: string; name: string } | undefined {
  if (!raw) return undefined;
  const [owner, name, ...rest] = raw.split('/');
  return owner && name && rest.length === 0 ? { owner, name } : undefined;
}

export function loadHookClientConfig(
  dependencies: HookClientConfigDependencies = {},
): HookClientConfig {
  const env = dependencies.env ?? process.env;
  const home = dependencies.homeDirectory ?? os.homedir();
  const readFile =
    dependencies.readFile ?? ((filePath) => fs.readFileSync(filePath, 'utf8'));
  const configDir = path.join(home, HOOK_CONFIG_DIRECTORY);
  const fileRepos = parseRepos(
    readOptional(readFile, path.join(configDir, HOOK_CONFIG_FILE)),
  );
  const envRepos = env['LCARS_TELEMETRY_REPOS']
    ?.split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const runId = env['LCARS_RUN_ID'];
  const runnerRepo = parseRepoSlug(
    env['LCARS_REPO'] ?? env['GITHUB_REPOSITORY'],
  );
  const issueNumber = Number(env['LCARS_ISSUE_NUMBER'] ?? env['NUM']);
  const runner =
    runId && runnerRepo
      ? {
          runId,
          repo: runnerRepo,
          ...(env['INTENT_ID'] && { intentId: env['INTENT_ID'] }),
          ...(Number.isSafeInteger(issueNumber) &&
            issueNumber > 0 && { issueNumber }),
        }
      : undefined;
  const writer = resolveWriter(env, readFile, configDir, runner !== undefined);
  return {
    repos: envRepos && envRepos.length > 0 ? envRepos : fileRepos,
    ...(writer && { writer }),
    host:
      env['AGENT_TELEMETRY_HOST'] ??
      (dependencies.hostname ?? os.hostname)().split('.')[0],
    ...(runner && { runner }),
  };
}

function parseKey(
  raw: string | undefined,
):
  | { projectId?: string; client_email: string; private_key: string }
  | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const clientEmail = parsed['client_email'];
    const privateKey = parsed['private_key'];
    if (typeof clientEmail !== 'string' || typeof privateKey !== 'string') {
      return undefined;
    }
    const projectId = parsed['project_id'];
    return {
      client_email: clientEmail,
      private_key: privateKey,
      ...(typeof projectId === 'string' && { projectId }),
    };
  } catch {
    return undefined;
  }
}

/** Writer credentials, in order: the emulator; a key from
 *  `AGENT_TELEMETRY_WRITER_KEY_JSON`; the key file homegit installs; and on
 *  a runner, the telemetry-writer credentials file named by
 *  `LCARS_TELEMETRY_CREDENTIALS_FILE` (preferred: the agent never sees it as
 *  ambient credentials) or `GOOGLE_APPLICATION_CREDENTIALS`. */
function resolveWriter(
  env: NodeJS.ProcessEnv,
  readFile: (filePath: string) => string,
  configDir: string,
  isRunner: boolean,
): HookWriterCredentials | undefined {
  const configuredProject = env['AGENT_TELEMETRY_PROJECT_ID'];
  const emulatorHost = env['FIRESTORE_EMULATOR_HOST'];
  if (emulatorHost) {
    return {
      projectId: configuredProject ?? DEFAULT_TELEMETRY_PROJECT_ID,
      emulatorHost,
    };
  }
  const key =
    parseKey(env['AGENT_TELEMETRY_WRITER_KEY_JSON']) ??
    parseKey(
      readOptional(readFile, path.join(configDir, HOOK_WRITER_KEY_FILE)),
    );
  if (key) {
    return {
      projectId:
        configuredProject ?? key.projectId ?? DEFAULT_TELEMETRY_PROJECT_ID,
      credentials: {
        client_email: key.client_email,
        private_key: key.private_key,
      },
    };
  }
  const credentialsFile = env['LCARS_TELEMETRY_CREDENTIALS_FILE']?.trim();
  if (isRunner && credentialsFile) {
    return {
      projectId: configuredProject ?? DEFAULT_TELEMETRY_PROJECT_ID,
      credentialsFile,
    };
  }
  if (isRunner && env['GOOGLE_APPLICATION_CREDENTIALS']) {
    return { projectId: configuredProject ?? DEFAULT_TELEMETRY_PROJECT_ID };
  }
  return undefined;
}

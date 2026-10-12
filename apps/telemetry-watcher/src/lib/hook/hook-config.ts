import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Where the `lcars hook` client finds its own configuration on a
 * workstation. Both files are written by homegit (docs/hooks-telemetry-design.md
 * §4.6); environment variables override them for tests and one-off runs.
 */
export const HOOK_CONFIG_DIRECTORY = path.join('.config', 'agent-lcars');
export const HOOK_CONFIG_FILE = 'config.json';
export const HOOK_TELEMETRY_ENV_FILE = 'telemetry.env';

export interface HookClientConfig {
  /** `owner/name` allowlist patterns, see `matchesRepoAllowlist`. */
  readonly repos: readonly string[];
  /** Console origin the flusher posts to. */
  readonly origin: string;
  /** Bearer token for the ingest route; absent means "spool only". */
  readonly token?: string;
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

/** `KEY=VALUE` lines, `#` comments; the same shape homegit writes for
 * `~/.config/opencode/.env`. */
export function parseEnvFile(raw: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!raw) return result;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
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
  const fileEnv = parseEnvFile(
    readOptional(readFile, path.join(configDir, HOOK_TELEMETRY_ENV_FILE)),
  );
  const envRepos = env['LCARS_TELEMETRY_REPOS']
    ?.split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const token =
    env['LCARS_TELEMETRY_TOKEN'] ?? fileEnv['LCARS_TELEMETRY_TOKEN'];
  const runId = env['LCARS_RUN_ID'];
  const runnerRepo = parseRepoSlug(
    env['LCARS_REPO'] ?? env['GITHUB_REPOSITORY'],
  );
  const issueNumber = Number(env['NUM']);
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
  return {
    repos: envRepos && envRepos.length > 0 ? envRepos : fileRepos,
    origin:
      env['LCARS_URL'] ?? fileEnv['LCARS_URL'] ?? 'https://lcars.jlapenna.net',
    ...(token && { token }),
    host:
      env['AGENT_TELEMETRY_HOST'] ??
      (dependencies.hostname ?? os.hostname)().split('.')[0],
    ...(runner && { runner }),
  };
}

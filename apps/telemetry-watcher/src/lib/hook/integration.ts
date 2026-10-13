import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { HOOK_RUNTIMES, type HookRuntime, isHookRuntime } from './hook-payload';
import { OPENCODE_TELEMETRY_PLUGIN } from './opencode-plugin-source';

/**
 * `lcars integration install|uninstall|status <runtime>`: the self-installing
 * hook integration borrowed from herdr (docs/hooks-telemetry-design.md §4.7).
 *
 * The settings entry is a constant launcher stub: Codex hashes the hook
 * entry for trust, not the script it launches, so the entry is trusted once
 * per host and behavior changes ship in the `lcars` bundle. The stub copies
 * stdin to a temp file before anything else and never fails the runtime.
 */
export const INTEGRATION_VERSION = 1;
export const STUB_MARKER = 'lcars-hook.sh';

interface HookEntrySpec {
  readonly event: string;
  readonly async?: boolean;
  readonly timeout?: number;
}

interface IntegrationTarget {
  /** Environment variable that relocates the runtime's config directory. */
  readonly configDirEnv: 'CLAUDE_CONFIG_DIR' | 'CODEX_HOME';
  /** Config directory relative to `$HOME` when that variable is unset. */
  readonly defaultConfigDir: string;
  /** Settings file holding `hooks`, relative to the config directory. */
  readonly settingsFile: string;
  /** Launcher stub, relative to the config directory. */
  readonly stubFile: string;
  readonly entries: readonly HookEntrySpec[];
}

/** Runtimes that register hooks as entries in a settings file. OpenCode
 *  instead loads plugin files from a directory; see the opencode functions
 *  below. */
type SettingsRuntime = Exclude<HookRuntime, 'opencode'>;

export const INTEGRATION_TARGETS: Readonly<
  Record<SettingsRuntime, IntegrationTarget>
> = {
  claude: {
    configDirEnv: 'CLAUDE_CONFIG_DIR',
    defaultConfigDir: '.claude',
    settingsFile: 'settings.json',
    stubFile: path.join('hooks', 'lcars-hook.sh'),
    entries: [
      // SessionStart cannot be async and its stdout is injected into
      // the agent's context; the stub prints nothing.
      { event: 'SessionStart', timeout: 10 },
      { event: 'UserPromptSubmit', async: true },
      { event: 'PostToolUse', async: true },
      { event: 'Stop', async: true },
      // SessionEnd's default budget is 1.5 s; a per-hook timeout raises it.
      { event: 'SessionEnd', timeout: 5 },
    ],
  },
  codex: {
    configDirEnv: 'CODEX_HOME',
    defaultConfigDir: '.codex',
    settingsFile: 'hooks.json',
    stubFile: 'lcars-hook.sh',
    entries: [
      { event: 'SessionStart', timeout: 10 },
      { event: 'UserPromptSubmit', async: true },
      { event: 'PostToolUse', async: true },
      { event: 'Stop', async: true },
      { event: 'Interrupt', timeout: 1 },
      { event: 'SessionEnd', timeout: 3 },
    ],
  },
};

interface ResolvedTarget {
  readonly settingsPath: string;
  readonly stubPath: string;
  /** How the hook entry names the stub: `$HOME/...` for the default config
   *  directory (one constant string across hosts, so Codex trusts it once),
   *  otherwise the absolute path. */
  readonly stubRef: string;
}

export function resolveTarget(
  runtime: SettingsRuntime,
  homeDirectory: string,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedTarget {
  const target = INTEGRATION_TARGETS[runtime];
  const relocated = env[target.configDirEnv]?.trim();
  if (relocated && /["`$\\]/u.test(relocated)) {
    // The path is embedded in a double-quoted shell command.
    throw new Error(`${target.configDirEnv} contains a shell-unsafe character`);
  }
  const configDir =
    relocated || path.join(homeDirectory, target.defaultConfigDir);
  return {
    settingsPath: path.join(configDir, target.settingsFile),
    stubPath: path.join(configDir, target.stubFile),
    stubRef: relocated
      ? path.join(relocated, target.stubFile)
      : `$HOME/${path.join(target.defaultConfigDir, target.stubFile)}`,
  };
}

export function stubCommand(
  runtime: SettingsRuntime,
  stubRef = `$HOME/${path.join(INTEGRATION_TARGETS[runtime].defaultConfigDir, INTEGRATION_TARGETS[runtime].stubFile)}`,
): string {
  return `[ -x "${stubRef}" ] && sh "${stubRef}" ${runtime} || true`;
}

/** Exactly the command shape this installer generates, at any stub path. */
const OUR_COMMAND_RE =
  /^\[ -x "([^"]+\/lcars-hook\.sh)" \] && sh "\1" (claude|codex) \|\| true$/u;

export function stubScript(runtime: SettingsRuntime): string {
  return [
    '#!/bin/sh',
    '# installed by lcars',
    '# managed by lcars; `lcars integration install` overwrites this file.',
    '# add custom hooks beside this file instead of editing it.',
    `# LCARS_INTEGRATION_ID=${runtime}`,
    `# LCARS_INTEGRATION_VERSION=${INTEGRATION_VERSION}`,
    '',
    'set -u',
    `runtime="\${1:-${runtime}}"`,
    'input="$(mktemp "${TMPDIR:-/tmp}/lcars-hook.XXXXXX")" || exit 0',
    'trap \'rm -f "$input"\' EXIT HUP INT TERM',
    'cat >"$input" 2>/dev/null || true',
    'if command -v lcars >/dev/null 2>&1; then',
    '  lcars_bin=lcars',
    'elif [ -x "$HOME/.local/bin/lcars" ]; then',
    '  lcars_bin="$HOME/.local/bin/lcars"',
    'else',
    '  exit 0',
    'fi',
    '"$lcars_bin" hook "$runtime" <"$input" >/dev/null 2>&1 || true',
    'exit 0',
    '',
  ].join('\n');
}

export interface IntegrationDependencies {
  homeDirectory?: string;
  env?: NodeJS.ProcessEnv;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

export interface IntegrationStatus {
  readonly runtime: HookRuntime;
  readonly stubInstalled: boolean;
  readonly stubVersion?: number;
  readonly stubCurrent: boolean;
  /** How many of the expected hook events carry our entry. */
  readonly entriesPresent: number;
  readonly entriesExpected: number;
  readonly installed: boolean;
}

export const INTEGRATION_CLI_USAGE = `usage: lcars integration (install|uninstall|status) (${HOOK_RUNTIMES.join('|')}|all)`;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readSettings(filePath: string): JsonRecord {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return {};
  }
  if (raw.trim() === '') return {};
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) {
    throw new Error(`${filePath} is not a JSON object`);
  }
  return parsed;
}

/** Mode for a settings file: keep what the runtime already chose for it,
 *  otherwise owner-only, since these files can carry environment values. */
function settingsMode(filePath: string): number {
  try {
    return fs.statSync(filePath).mode & 0o777;
  } catch {
    return 0o600;
  }
}

function writeAtomically(target: string, body: string, mode: number): void {
  // Write through a symlink rather than replacing it with a regular file.
  let filePath = target;
  try {
    filePath = fs.realpathSync(target);
  } catch {
    // Not there yet.
  }
  // Owner-only parent: the stub is executed by the owner's agent, and a
  // directory anyone else could write to would let them replace it.
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, body, { mode });
    // The process umask would otherwise narrow `mode` (and drift a file
    // another tool manages); set it exactly.
    fs.chmodSync(temporaryPath, mode);
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    try {
      fs.unlinkSync(temporaryPath);
    } catch {
      // Never created.
    }
    throw error;
  }
}

function hookIsOurs(hook: unknown): boolean {
  return (
    isRecord(hook) &&
    typeof hook['command'] === 'string' &&
    OUR_COMMAND_RE.test(hook['command'])
  );
}

function groupIsOurs(group: unknown): boolean {
  return (
    isRecord(group) &&
    Array.isArray(group['hooks']) &&
    group['hooks'].some(hookIsOurs)
  );
}

function ourGroup(
  runtime: SettingsRuntime,
  spec: HookEntrySpec,
  stubRef: string,
): JsonRecord {
  return {
    hooks: [
      {
        type: 'command',
        command: stubCommand(runtime, stubRef),
        ...(spec.async && { async: true }),
        ...(spec.timeout !== undefined && { timeout: spec.timeout }),
      },
    ],
  };
}

/** Removes our hook entries from every group of every event, keeping any
 *  foreign entries that share a group; drops groups and events that end up
 *  empty. Returns how many of our entries were removed. */
function stripOurHooks(hooks: JsonRecord): number {
  let removed = 0;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    const kept: unknown[] = [];
    for (const group of groups) {
      if (!isRecord(group) || !Array.isArray(group['hooks'])) {
        kept.push(group);
        continue;
      }
      const foreign = group['hooks'].filter((hook) => !hookIsOurs(hook));
      removed += group['hooks'].length - foreign.length;
      if (foreign.length > 0) {
        kept.push(
          foreign.length === group['hooks'].length
            ? group
            : { ...group, hooks: foreign },
        );
      }
    }
    if (kept.length === 0) delete hooks[event];
    else hooks[event] = kept;
  }
  return removed;
}

/** Replaces our entry inside the group that already carries one (keeping
 *  any foreign hooks sharing that group and the group's position, so a
 *  file another tool also manages is not reordered on every install) or
 *  appends a fresh group. */
function placeOurGroup(
  hooks: JsonRecord,
  event: string,
  group: JsonRecord,
): void {
  const groups = Array.isArray(hooks[event])
    ? [...(hooks[event] as unknown[])]
    : [];
  const ourHook = (group['hooks'] as unknown[])[0];
  const index = groups.findIndex(groupIsOurs);
  if (index === -1) {
    groups.push(group);
  } else {
    const existing = groups[index] as JsonRecord;
    const entries = existing['hooks'] as unknown[];
    const first = entries.findIndex(hookIsOurs);
    groups[index] = {
      ...existing,
      hooks: entries
        .map((hook, i) => (i === first ? ourHook : hook))
        .filter((hook, i) => i === first || !hookIsOurs(hook)),
    };
  }
  hooks[event] = groups;
}

function stubVersionOf(script: string | undefined): number | undefined {
  const match = script?.match(/^# LCARS_INTEGRATION_VERSION=(\d+)$/m);
  return match ? Number(match[1]) : undefined;
}

function settingsIntegrationStatus(
  runtime: SettingsRuntime,
  homeDirectory: string,
  env: NodeJS.ProcessEnv = process.env,
): IntegrationStatus {
  const target = INTEGRATION_TARGETS[runtime];
  const resolved = resolveTarget(runtime, homeDirectory, env);
  let script: string | undefined;
  try {
    script = fs.readFileSync(resolved.stubPath, 'utf8');
  } catch {
    script = undefined;
  }
  const stubVersion = stubVersionOf(script);
  const stubCurrent = script === stubScript(runtime);
  let entriesPresent = 0;
  try {
    const settings = readSettings(resolved.settingsPath);
    const hooks = isRecord(settings['hooks']) ? settings['hooks'] : {};
    for (const spec of target.entries) {
      const groups = hooks[spec.event];
      if (Array.isArray(groups) && groups.some(groupIsOurs)) entriesPresent++;
    }
  } catch {
    entriesPresent = 0;
  }
  return {
    runtime,
    stubInstalled: script !== undefined,
    ...(stubVersion !== undefined && { stubVersion }),
    stubCurrent,
    entriesPresent,
    entriesExpected: target.entries.length,
    installed: stubCurrent && entriesPresent === target.entries.length,
  };
}

function settingsInstallIntegration(
  runtime: SettingsRuntime,
  homeDirectory: string,
  env: NodeJS.ProcessEnv = process.env,
): IntegrationStatus {
  const target = INTEGRATION_TARGETS[runtime];
  const resolved = resolveTarget(runtime, homeDirectory, env);
  writeAtomically(resolved.stubPath, stubScript(runtime), 0o700);
  const settingsPath = resolved.settingsPath;
  const settings = readSettings(settingsPath);
  const hooks = isRecord(settings['hooks']) ? settings['hooks'] : {};
  for (const spec of target.entries) {
    placeOurGroup(hooks, spec.event, ourGroup(runtime, spec, resolved.stubRef));
  }
  // Events we no longer install into (or stray copies) lose only our entries.
  for (const [event, groups] of Object.entries(hooks)) {
    if (target.entries.some((spec) => spec.event === event)) continue;
    if (Array.isArray(groups) && groups.some(groupIsOurs)) {
      stripOurHooks({ [event]: groups } as JsonRecord);
      hooks[event] = (groups as unknown[]).filter(
        (group) => !groupIsOurs(group),
      );
      if ((hooks[event] as unknown[]).length === 0) delete hooks[event];
    }
  }
  settings['hooks'] = hooks;
  writeAtomically(
    settingsPath,
    `${JSON.stringify(settings, null, 2)}\n`,
    settingsMode(settingsPath),
  );
  return settingsIntegrationStatus(runtime, homeDirectory, env);
}

function settingsUninstallIntegration(
  runtime: SettingsRuntime,
  homeDirectory: string,
  env: NodeJS.ProcessEnv = process.env,
): IntegrationStatus {
  const resolved = resolveTarget(runtime, homeDirectory, env);
  const settingsPath = resolved.settingsPath;
  let settings: JsonRecord | undefined;
  try {
    settings = readSettings(settingsPath);
  } catch {
    settings = undefined;
  }
  if (settings && isRecord(settings['hooks'])) {
    const hooks = settings['hooks'];
    if (stripOurHooks(hooks) > 0) {
      if (Object.keys(hooks).length === 0) delete settings['hooks'];
      writeAtomically(
        settingsPath,
        `${JSON.stringify(settings, null, 2)}\n`,
        settingsMode(settingsPath),
      );
    }
  }
  try {
    fs.unlinkSync(resolved.stubPath);
  } catch {
    // Already absent.
  }
  return settingsIntegrationStatus(runtime, homeDirectory, env);
}

/** OpenCode's global plugin directory, honoring XDG_CONFIG_HOME. */
export function opencodePluginPath(
  homeDirectory: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configHome =
    env['XDG_CONFIG_HOME']?.trim() || path.join(homeDirectory, '.config');
  return path.join(configHome, 'opencode', 'plugins', 'lcars-telemetry.js');
}

function opencodeStatus(
  homeDirectory: string,
  env: NodeJS.ProcessEnv,
): IntegrationStatus {
  let plugin: string | undefined;
  try {
    plugin = fs.readFileSync(opencodePluginPath(homeDirectory, env), 'utf8');
  } catch {
    plugin = undefined;
  }
  const match = plugin?.match(/LCARS_INTEGRATION_VERSION=(\d+)/u);
  const current = plugin === OPENCODE_TELEMETRY_PLUGIN;
  return {
    runtime: 'opencode',
    stubInstalled: plugin !== undefined,
    ...(match && { stubVersion: Number(match[1]) }),
    stubCurrent: current,
    entriesPresent: current ? 1 : 0,
    entriesExpected: 1,
    installed: current,
  };
}

export function integrationStatus(
  runtime: HookRuntime,
  homeDirectory: string,
  env: NodeJS.ProcessEnv = process.env,
): IntegrationStatus {
  return runtime === 'opencode'
    ? opencodeStatus(homeDirectory, env)
    : settingsIntegrationStatus(runtime, homeDirectory, env);
}

export function installIntegration(
  runtime: HookRuntime,
  homeDirectory: string,
  env: NodeJS.ProcessEnv = process.env,
): IntegrationStatus {
  if (runtime !== 'opencode') {
    return settingsInstallIntegration(runtime, homeDirectory, env);
  }
  // OpenCode loads every file in its global plugin directory at startup.
  writeAtomically(
    opencodePluginPath(homeDirectory, env),
    OPENCODE_TELEMETRY_PLUGIN,
    0o600,
  );
  return opencodeStatus(homeDirectory, env);
}

export function uninstallIntegration(
  runtime: HookRuntime,
  homeDirectory: string,
  env: NodeJS.ProcessEnv = process.env,
): IntegrationStatus {
  if (runtime !== 'opencode') {
    return settingsUninstallIntegration(runtime, homeDirectory, env);
  }
  try {
    fs.unlinkSync(opencodePluginPath(homeDirectory, env));
  } catch {
    // Already absent.
  }
  return opencodeStatus(homeDirectory, env);
}

function formatStatus(status: IntegrationStatus): string {
  if (status.runtime === 'opencode') {
    const plugin = status.stubInstalled
      ? `plugin v${status.stubVersion ?? '?'}${status.stubCurrent ? '' : ' (outdated)'}`
      : 'plugin missing';
    return `opencode: ${status.installed ? 'installed' : 'not installed'} (${plugin})`;
  }
  const stub = status.stubInstalled
    ? `stub v${status.stubVersion ?? '?'}${status.stubCurrent ? '' : ' (outdated)'}`
    : 'stub missing';
  return `${status.runtime}: ${status.installed ? 'installed' : 'not installed'} (${stub}, ${status.entriesPresent}/${status.entriesExpected} hook entries)`;
}

/** Returns the process exit code. Unlike `lcars hook`, this is an operator
 *  command, so it reports on stdout and fails loudly. */
export function executeIntegrationCommand(
  argv: readonly string[],
  dependencies: IntegrationDependencies = {},
): number {
  const home = dependencies.homeDirectory ?? os.homedir();
  const env = dependencies.env ?? process.env;
  const stdout =
    dependencies.stdout ?? ((line) => process.stdout.write(`${line}\n`));
  const stderr =
    dependencies.stderr ?? ((line) => process.stderr.write(`${line}\n`));
  const [action, runtimeArg] = argv;
  const runtimes: HookRuntime[] = isHookRuntime(runtimeArg)
    ? [runtimeArg]
    : runtimeArg === 'all'
      ? [...HOOK_RUNTIMES]
      : [];
  if (
    (action !== 'install' && action !== 'uninstall' && action !== 'status') ||
    runtimes.length === 0
  ) {
    stderr(INTEGRATION_CLI_USAGE);
    return 1;
  }
  let exitCode = 0;
  for (const runtime of runtimes) {
    try {
      const status =
        action === 'install'
          ? installIntegration(runtime, home, env)
          : action === 'uninstall'
            ? uninstallIntegration(runtime, home, env)
            : integrationStatus(runtime, home, env);
      stdout(formatStatus(status));
      if (action === 'status' && !status.installed) exitCode = 1;
    } catch (error) {
      stderr(`${runtime}: ${action} failed: ${(error as Error).message}`);
      exitCode = 1;
    }
  }
  return exitCode;
}

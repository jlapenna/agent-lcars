// The native review binds the caller's real provider directory read-write:
// rotating login state and its write lock must stay shared with the caller's
// live sessions. Everything else in that directory configures those live
// sessions (hooks, settings, plugins, skills, rules, instructions, MCP
// servers), so a review must never change it (#3379: a reviewed test
// registered the scratch repository's worker hook in the operator's
// settings.json).
//
// The guard is an allowlist. Each top-level entry that is not the provider's
// own runtime state is overlaid read-only. A symlink cannot be overlaid (its
// target is outside the mount), and a missing configuration file cannot be
// overlaid without the container runtime creating it on the host, so the
// launcher also snapshots before the run and afterwards undoes a replaced
// symlink or a configuration entry the run created. Entries created under
// other names are left alone: the caller's live sessions write their own new
// state into the same directory while the review runs.
import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  symlinkSync,
} from 'node:fs';
import { join, sep } from 'node:path';

const provider = (writable, writablePatterns, config, isolated = []) => ({
  writable: new Set(writable),
  writablePatterns,
  config: new Set(config),
  isolated: new Set(isolated),
});

export const AUTH_DIRECTORY_POLICY = {
  // Claude's own state list (its host-config snapshot exclusions) plus the
  // credential write lock.
  claude: provider(
    [
      '.claude.json',
      '.claude.json.backup',
      '.credentials.json',
      '.storage-write',
      '.device-keys.json',
      '.session_ingress_token',
      '.last-cleanup',
      '.last-update-result.json',
      'projects',
      'sessions',
      'todos',
      'statsig',
      'file-history',
      'history.jsonl',
      'ide',
      'logs',
      'backups',
      'daemon',
      'jobs',
      'teams',
      'usage-data',
      'shares',
      'state',
      'uploads',
      'feedback',
      'feedback-bundles',
      'plans',
      'telemetry',
      'debug',
      'traces',
      'startup-perf',
      'cache',
      'mcp-discovery-cache',
      'mcp-needs-auth-cache.json',
      'gh-pr-status-cache.json',
      'tasks',
      'local',
      'session-env',
      'image-cache',
      'paste-cache',
      'file-transfers',
      'stats-cache.json',
      'downloads',
      'security',
      'remote',
    ],
    // remote-settings.json is managed settings and can carry hooks, so it is
    // protected rather than allowlisted.
    [/^policy-limits\.json/],
    [
      'settings.json',
      'settings.local.json',
      'CLAUDE.md',
      'hooks',
      'plugins',
      'commands',
      'agents',
      'skills',
      'output-styles',
      'keybindings.json',
      'mcp',
    ],
    // Live sessions source these before every shell command; the review gets
    // empty private copies instead of the caller's.
    ['shell-snapshots', 'session-env'],
  ),
  codex: provider(
    [
      'auth.json',
      'auth.json.lock',
      'auth.lock',
      '.credentials.json',
      '.tmp',
      'tmp',
      'cache',
      'sessions',
      'archived_sessions',
      'history.jsonl',
      'session_index.jsonl',
      'session_index.jsonl.lock',
      'log',
      'models_cache.json',
      'version.json',
      'installation_id',
      'mention_usage.json',
      'mention_usage.lock',
      'generated_images',
      'mcp-oauth-locks',
      'thread-writer-locks',
      'app-server-control',
      'app-server-daemon',
      '.sandbox_migration',
      '.sqlite-maintenance.lock',
    ],
    [/\.sqlite(?:-shm|-wal)?$/, /^tui-/],
    [
      'config.toml',
      'hooks.json',
      'AGENTS.md',
      'AGENTS.override.md',
      'rules',
      'skills',
      'plugins',
      'prompts',
      '.hook-trust',
    ],
    ['shell_snapshots'],
  ),
  agy: provider(
    [
      'antigravity-oauth-token',
      'annotations',
      'brain',
      'cache',
      'conversation_summaries.db',
      'conversations',
      'crashes',
      'history.jsonl',
      'implicit',
      'installation_id',
      'jetbox_summaries_proto.pb',
      'jetski_state.pbtxt',
      'last_check.timestamp',
      'log',
      'presence',
      'plugin_data',
      'updater',
    ],
    [],
    [
      'settings.json',
      'skills',
      'mcp',
      'bin',
      'builtin',
      'plugins',
      'hooks.json',
    ],
  ),
  // The OpenCode lane binds a single key file, not a directory.
  opencode: null,
};

function policyFor(name) {
  if (!(name in AUTH_DIRECTORY_POLICY))
    throw new Error('Unknown provider: ' + name);
  return AUTH_DIRECTORY_POLICY[name];
}

export function isWritableState(providerName, entry) {
  const policy = policyFor(providerName);
  return (
    policy !== null &&
    (policy.writable.has(entry) ||
      policy.writablePatterns.some((pattern) => pattern.test(entry)))
  );
}

function protectedEntries(providerName, auth) {
  const policy = policyFor(providerName);
  if (policy === null) return [];
  return readdirSync(auth)
    .filter(
      (entry) =>
        !isWritableState(providerName, entry) && !policy.isolated.has(entry),
    )
    .sort();
}

const unsupportedName = (entry) =>
  entry.includes(',') || entry.includes(':') || entry.includes('=');

// Executable session state the caller's live sessions source: overlay each
// existing directory with an empty private one under privateRoot.
function isolatedStateMounts(providerName, auth, target, privateRoot) {
  const policy = policyFor(providerName);
  if (policy === null) return [];
  return [...policy.isolated].sort().flatMap((entry) => {
    const stat = lstatSync(join(auth, entry), { throwIfNoEntry: false });
    if (!stat) return [];
    if (!stat.isDirectory())
      throw new Error('Unsupported session state entry: ' + join(auth, entry));
    if (!privateRoot || unsupportedName(privateRoot))
      throw new Error('A private state directory is required for ' + entry);
    const source = join(privateRoot, entry);
    mkdirSync(source, { recursive: true, mode: 0o700 });
    return [
      '--mount',
      `type=bind,source=${source},target=${join(target, entry)}`,
    ];
  });
}

// writableRoots: every host path bound writable into the container.
export function protectedConfigMounts(
  providerName,
  auth,
  target,
  privateRoot,
  writableRoots = [auth],
) {
  const readOnly = protectedEntries(providerName, auth).flatMap((entry) => {
    if (unsupportedName(entry))
      throw new Error('Unsupported configuration entry name: ' + entry);
    const source = join(auth, entry);
    const stat = lstatSync(source);
    // A symlink cannot be overlaid. Its target is outside the container
    // unless it resolves into a writable binding, which would let a write
    // through the link reach the host; refuse that. Otherwise snapshot and
    // restore protect the link itself (see reconcileRegistrations).
    if (stat.isSymbolicLink()) {
      let resolved = null;
      try {
        resolved = realpathSync(source);
      } catch {
        // Dangling: nothing on the host to write through to.
      }
      if (
        resolved &&
        writableRoots.some(
          (root) => resolved === root || resolved.startsWith(root + sep),
        )
      )
        throw new Error(
          'Configuration symlink resolves into a writable binding: ' + source,
        );
      return [];
    }
    if (!stat.isFile() && !stat.isDirectory())
      throw new Error('Unsupported configuration entry type: ' + source);
    return [
      '--mount',
      `type=bind,source=${source},target=${join(target, entry)},readonly`,
    ];
  });
  return [
    ...readOnly,
    ...isolatedStateMounts(providerName, auth, target, privateRoot),
  ];
}

function describe(path) {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return null;
  if (stat.isSymbolicLink()) {
    let sha256 = null;
    try {
      sha256 = createHash('sha256').update(readFileSync(path)).digest('hex');
    } catch {
      // A dangling or unreadable link still has a comparable target.
    }
    return { kind: 'symlink', target: readlinkSync(path), sha256 };
  }
  if (stat.isFile())
    return {
      kind: 'file',
      sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
    };
  if (stat.isDirectory()) return { kind: 'dir' };
  return { kind: 'other' };
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Every protected entry present at launch, plus each known configuration
// name (null when absent, so a creation is detectable).
export function snapshotRegistrations(providerName, auth) {
  const policy = policyFor(providerName);
  if (policy === null) return {};
  const names = new Set([
    ...protectedEntries(providerName, auth),
    ...policy.config,
  ]);
  return Object.fromEntries(
    [...names].sort().map((entry) => [entry, describe(join(auth, entry))]),
  );
}

// Undo what can be undone safely and report every change. A created entry is
// moved aside (kept as evidence) and a replaced symlink is restored; a changed
// file or directory cannot be restored safely and is only reported.
export function reconcileRegistrations(
  providerName,
  auth,
  before,
  stamp = Date.now(),
) {
  const findings = [];
  for (const [entry, previous] of Object.entries(before)) {
    const path = join(auth, entry);
    const current = describe(path);
    if (same(current, previous)) continue;
    const aside = `${path}.review-qualification-${stamp}`;
    if (previous === null) {
      renameSync(path, aside);
      findings.push({ path, change: 'created', movedTo: aside });
    } else if (previous.kind === 'symlink') {
      if (current !== null) renameSync(path, aside);
      symlinkSync(previous.target, path);
      findings.push({
        path,
        change: 'symlink-replaced',
        restoredTarget: previous.target,
        ...(current === null ? {} : { movedTo: aside }),
      });
    } else {
      findings.push({
        path,
        change: current === null ? 'removed' : 'modified',
      });
    }
  }
  return findings;
}

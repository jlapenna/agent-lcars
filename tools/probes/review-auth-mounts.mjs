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
  statSync,
  symlinkSync,
} from 'node:fs';
import { join, sep } from 'node:path';

const provider = (
  writable,
  writablePatterns,
  config,
  isolated = [],
  nested = () => [],
) => ({
  writable: new Set(writable),
  writablePatterns,
  config: new Set(config),
  isolated: new Set(isolated),
  nested,
});

// Directories inside allowlisted state that live sessions load as
// instructions: Claude auto memory, projects/<key>/memory.
function claudeMemoryDirectories(auth) {
  const projects = join(auth, 'projects');
  const stat = lstatSync(projects, { throwIfNoEntry: false });
  if (!stat?.isDirectory()) return [];
  return readdirSync(projects)
    .map((key) => join('projects', key, 'memory'))
    .filter((path) =>
      lstatSync(join(auth, path), { throwIfNoEntry: false })?.isDirectory(),
    )
    .sort();
}

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
      'session-env',
      'image-cache',
      'paste-cache',
      'file-transfers',
      'stats-cache.json',
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
      'remote-settings.json',
    ],
    // Live sessions source these before every shell command; the review gets
    // empty private copies instead of the caller's.
    ['shell-snapshots', 'session-env'],
    claudeMemoryDirectories,
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
    // Only Codex's own bookkeeping databases: memories and goals feed live
    // prompts and stay protected. `.tmp*` are its atomic-write temp files.
    [
      /^(?:state|logs|thread_history|queue)_\d+\.sqlite(?:-shm|-wal)?$/,
      /^tui-/,
      /^\.tmp/,
    ],
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
      'cli.log',
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
    if (!privateRoot || unsupportedName(privateRoot))
      throw new Error('A private state directory is required for ' + entry);
    // Created when absent (the CLI would create it anyway) so the overlay
    // always applies and nothing the review writes reaches the caller's copy.
    mkdirSync(join(auth, entry), { recursive: true, mode: 0o700 });
    const stat = lstatSync(join(auth, entry));
    if (!stat.isDirectory())
      throw new Error('Unsupported session state entry: ' + join(auth, entry));
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
    // Live sessions add and remove their own entries concurrently.
    const stat = lstatSync(source, { throwIfNoEntry: false });
    if (!stat) return [];
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
  const nested = (policyFor(providerName)?.nested(auth) ?? []).flatMap(
    (path) => {
      if (unsupportedName(path))
        throw new Error('Unsupported instruction path: ' + path);
      return [
        '--mount',
        `type=bind,source=${join(auth, path)},target=${join(target, path)},readonly`,
      ];
    },
  );
  return [
    ...readOnly,
    ...nested,
    ...isolatedStateMounts(providerName, auth, target, privateRoot),
  ];
}

const MAX_LINK_TARGET_BYTES = 4 * 1024 * 1024;

function describe(path) {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return null;
  if (stat.isSymbolicLink()) {
    // Hash only a regular-file target of bounded size: a link to a FIFO,
    // device or huge file must not block or exhaust the launcher.
    let sha256 = null;
    try {
      const target = statSync(path);
      if (target.isFile() && target.size <= MAX_LINK_TARGET_BYTES)
        sha256 = createHash('sha256').update(readFileSync(path)).digest('hex');
    } catch {
      // A dangling or unreadable link still has a comparable target.
    }
    return { kind: 'symlink', target: readlinkSync(path), sha256 };
  }
  if (stat.isFile()) {
    try {
      return {
        kind: 'file',
        sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
      };
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }
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
  return {
    entries: Object.fromEntries(
      [...names].sort().map((entry) => [entry, describe(join(auth, entry))]),
    ),
    instructionDirectories: policy.nested(auth),
  };
}

// Undo what can be undone safely and report every change. Overlaid entries
// cannot change from inside the container, so a change to one came from the
// caller's own host sessions: it is reported but does not fail the run
// (blocking: false). A created configuration entry or a changed symlink may
// come from either side; it is undone (the entry is kept as evidence) and
// fails the run. Each entry is reconciled independently so one failure cannot
// stop the rest.
export function reconcileRegistrations(
  providerName,
  auth,
  before,
  stamp = Date.now(),
) {
  const findings = [];
  for (const [entry, previous] of Object.entries(before.entries ?? {})) {
    const path = join(auth, entry);
    try {
      const current = describe(path);
      if (same(current, previous)) continue;
      const aside = `${path}.review-qualification-${stamp}`;
      if (previous === null) {
        renameSync(path, aside);
        findings.push({
          path,
          change: 'created',
          movedTo: aside,
          blocking: true,
          note: 'Created during the review by the review or a host session; moved aside.',
        });
      } else if (previous.kind === 'symlink') {
        if (current !== null) renameSync(path, aside);
        symlinkSync(previous.target, path);
        findings.push({
          path,
          change: 'symlink-replaced',
          restoredTarget: previous.target,
          ...(current === null ? {} : { movedTo: aside }),
          blocking: true,
          note: 'Changed during the review by the review or a host session; restored.',
        });
      } else {
        findings.push({
          path,
          change: current === null ? 'removed' : 'modified',
          blocking: false,
          note: 'Read-only inside the review, so this change came from the host.',
        });
      }
    } catch (error) {
      findings.push({
        path,
        change: 'error',
        error: error.message,
        blocking: true,
      });
    }
  }
  try {
    const known = new Set(before.instructionDirectories ?? []);
    for (const path of policyFor(providerName)?.nested(auth) ?? [])
      if (!known.has(path))
        findings.push({
          path: join(auth, path),
          change: 'instructions-created',
          blocking: false,
          note: 'New instruction directory: created by the review or a host session; left in place for review.',
        });
  } catch (error) {
    findings.push({
      path: auth,
      change: 'error',
      error: error.message,
      blocking: true,
    });
  }
  return findings;
}

// The native review binds the caller's real provider directory read-write so
// rotating login state stays current. Hook registrations in that directory run
// before every tool call of every live session the caller owns, so a review
// must never rewrite them (#3379: a reviewed test registered the scratch
// repository's worker hook in the operator's settings.json). Overlay each
// existing registration read-only; a write then fails inside the container
// instead of reaching the caller's live sessions. A registration file that
// does not exist cannot be overlaid without the container runtime creating it
// on the host, so the launcher also compares snapshots taken before and after
// the run and undoes a file the run created.
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

// `file` entries are installer targets; `dir` entries hold the scripts those
// registrations execute.
export const HOOK_REGISTRATIONS = {
  claude: [
    { name: 'settings.json', kind: 'file' },
    { name: 'settings.local.json', kind: 'file' },
    { name: 'hooks', kind: 'dir' },
  ],
  codex: [{ name: 'hooks.json', kind: 'file' }],
  agy: [],
  opencode: [],
};

function registrations(provider) {
  const entries = HOOK_REGISTRATIONS[provider];
  if (!entries) throw new Error('Unknown provider: ' + provider);
  return entries;
}

export function protectedConfigMounts(provider, auth, target) {
  return registrations(provider).flatMap(({ name, kind }) => {
    const source = join(auth, name);
    const stat = lstatSync(source, { throwIfNoEntry: false });
    if (!stat) return [];
    if (kind === 'file' ? !stat.isFile() : !stat.isDirectory())
      throw new Error(
        `Hook registration is not a regular ${kind} and cannot be protected: ${source}`,
      );
    return [
      '--mount',
      `type=bind,source=${source},target=${join(target, name)},readonly`,
    ];
  });
}

// File content hashes (null when absent) for the registration files.
export function snapshotRegistrations(provider, auth) {
  return Object.fromEntries(
    registrations(provider)
      .filter(({ kind }) => kind === 'file')
      .map(({ name }) => {
        const path = join(auth, name);
        const stat = lstatSync(path, { throwIfNoEntry: false });
        if (!stat) return [name, null];
        if (!stat.isFile()) return [name, 'non-regular'];
        return [
          name,
          createHash('sha256').update(readFileSync(path)).digest('hex'),
        ];
      }),
  );
}

// Compare snapshots. A registration the run created is moved aside (kept as
// evidence) so the caller's directory returns to its prior state; any other
// change cannot be undone safely and is reported for the operator.
export function reconcileRegistrations(
  provider,
  auth,
  before,
  stamp = Date.now(),
) {
  const after = snapshotRegistrations(provider, auth);
  const findings = [];
  for (const [name, previous] of Object.entries(before)) {
    if (after[name] === previous) continue;
    const path = join(auth, name);
    if (previous === null) {
      const aside = `${path}.review-qualification-${stamp}`;
      renameSync(path, aside);
      findings.push({ path, change: 'created', movedTo: aside });
    } else {
      findings.push({
        path,
        change: after[name] === null ? 'removed' : 'modified',
      });
    }
  }
  return findings;
}

// The native review binds the caller's real provider directory read-write so
// rotating login state stays current. Hook registrations in that directory run
// before every tool call of every live session the caller owns, so a review
// must never rewrite them (#3379: a reviewed test registered the scratch
// repository's worker hook in the operator's settings.json). Overlay each
// existing registration file read-only; a write then fails inside the
// container instead of reaching the caller's live sessions.
import { lstatSync } from 'node:fs';
import { join } from 'node:path';

export const HOOK_REGISTRATION_FILES = {
  claude: ['settings.json', 'settings.local.json'],
  codex: ['hooks.json'],
  agy: [],
  opencode: [],
};

export function protectedConfigMounts(provider, auth, target) {
  const files = HOOK_REGISTRATION_FILES[provider];
  if (!files) throw new Error('Unknown provider: ' + provider);
  return files.flatMap((file) => {
    const source = join(auth, file);
    const stat = lstatSync(source, { throwIfNoEntry: false });
    if (!stat) return [];
    if (!stat.isFile())
      throw new Error(
        'Hook registration is not a regular file and cannot be protected: ' +
          source,
      );
    return [
      '--mount',
      `type=bind,source=${source},target=${join(target, file)},readonly`,
    ];
  });
}

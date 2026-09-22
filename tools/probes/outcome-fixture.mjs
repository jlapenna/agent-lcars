import {
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

export function outcomeFixture(mode, directory) {
  const unsafeParent = mode.endsWith('-parent-symlink');
  const multiTarget = mode.endsWith('-multi-target');
  const realParent = join(directory, 'protected-parent');
  const alias = join(directory, 'parent-alias');
  if (unsafeParent) {
    mkdirSync(realParent);
    writeFileSync(join(realParent, 'retained'), 'protected work\n');
    symlinkSync(realParent, alias);
  }
  const outcome = join(unsafeParent ? alias : directory, 'native-result');
  const extraTarget = join(directory, 'unrelated-patch-target');
  const target = mode.endsWith('-unrelated')
    ? join(directory, 'unrelated')
    : outcome;
  const attemptId = 'g1:work:fixture/r1';
  const kind = mode.includes('-park-') ? 'park' : 'no-op';
  const content = `<!-- agent-result:v1:${kind}:${attemptId} -->\n<!-- attempt-claim:${mode.endsWith('-foreign') ? 'foreign' : attemptId} -->\n`;
  return {
    target,
    sentinel: target,
    content,
    additionalPatch: multiTarget
      ? `\n*** Add File: ${extraTarget}\n+unrelated change`
      : '',
    verify: () =>
      (!unsafeParent ||
        (!existsSync(outcome) &&
          readFileSync(join(realParent, 'retained'), 'utf8') ===
            'protected work\n')) &&
      (!multiTarget || (!existsSync(outcome) && !existsSync(extraTarget))),
    brief: {
      repository: 'octo/example',
      mode: 'reply',
      anchor: { type: 'work', id: 'fixture' },
    },
    identity: {
      runId: 'work:fixture/r1',
      attemptId,
      nativeOutcomePath: outcome,
    },
    denial: mode.endsWith('-allow')
      ? ''
      : mode.endsWith('-unrelated')
        ? 'Implementation and publication require a feature worktree'
        : 'Write only the exact two-line native Work result',
  };
}

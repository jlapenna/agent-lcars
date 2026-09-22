import { join } from 'node:path';

export function outcomeFixture(mode, directory) {
  const outcome = join(directory, 'native-result');
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

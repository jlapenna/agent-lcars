// Native publication inputs: preserve an existing exact marker; refuse a
// foreign claim instead of laundering it into this attempt's artifact.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const deliveryKind = (mode) =>
  ['pr-create', 'issue-comment', 'pr-comment', 'pr-review'].find((kind) =>
    mode.startsWith(`bootstrap-publication-deliverable-${kind}-`),
  );

export function publicationBrief(mode) {
  const kind = deliveryKind(mode);
  if (!kind) return null;
  return {
    repository: 'octo/example',
    mode:
      kind === 'pr-create'
        ? 'implement'
        : kind === 'pr-review'
          ? 'review'
          : 'reply',
    anchor: {
      type:
        kind.startsWith('pr-') && kind !== 'pr-create'
          ? 'pull-request'
          : 'issue',
      number: 42,
    },
  };
}

export function publicationFixture(mode, context, workspace) {
  const kind = deliveryKind(mode);
  const marker = `<!-- attempt-claim:${context.attemptId} -->`;
  const original = mode.endsWith('-marker-foreign')
    ? 'Fixture deliverable\n\n<!-- attempt-claim:foreign-attempt -->'
    : mode.endsWith('-marker-idempotent-allow')
      ? `Fixture deliverable\n\n${marker}`
      : 'Fixture deliverable';
  const file =
    kind && mode.includes('-file-')
      ? join(workspace, 'deliverable body.txt')
      : null;
  if (file) writeFileSync(file, original);
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  const command = kind
    ? `gh ${kind.replace('-', ' ')} ${kind === 'pr-create' ? '--title "Fixture PR"' : '42'} --repo octo/example ${kind === 'pr-review' ? '--comment ' : ''}${file ? `--body-file ${quote(file)}` : `--body ${quote(original)}`}`
    : publicationCommand(mode, context);
  return {
    command,
    expectedBody: `Fixture deliverable\n\n${marker}`,
    verify: () => !file || readFileSync(file, 'utf8') === original,
  };
}

// Runs only in the isolated fake GitHub transport, after the native hook.
// Capture the actual body there even when the hook leaves --body-file intact.
export function publicationCaptureSource(
  sentinel,
  secondSentinel,
  ownershipState,
) {
  return `
const target = fs.existsSync(${JSON.stringify(ownershipState)}) ? ${JSON.stringify(secondSentinel)} : ${JSON.stringify(sentinel)};
const body = args.includes('--body') ? args[args.indexOf('--body') + 1] : fs.readFileSync(args[args.indexOf('--body-file') + 1], 'utf8');
fs.writeFileSync(target, JSON.stringify(args));
fs.writeFileSync(target + '.body', body);
console.log('fixture deliverable');`;
}

export const publicationDeliveryModes = [
  ...['issue-comment', 'pr-comment', 'pr-review'].map(
    (kind) => `bootstrap-publication-deliverable-${kind}-inline-allow`,
  ),
  ...['pr-create', 'issue-comment', 'pr-comment', 'pr-review'].flatMap((kind) =>
    ['allow', 'marker-idempotent-allow', 'marker-foreign'].map(
      (variant) => `bootstrap-publication-deliverable-${kind}-file-${variant}`,
    ),
  ),
];

export function publicationCommand(mode, context) {
  const body = mode.endsWith('-marker-foreign')
    ? 'Fixture deliverable\n\n<!-- attempt-claim:foreign-attempt -->'
    : mode.endsWith('-marker-idempotent-allow')
      ? `Fixture deliverable\n\n<!-- attempt-claim:${context.attemptId} -->`
      : 'Fixture deliverable';
  return `gh pr create --repo octo/example --title "Fixture PR" --body '${body}'`;
}

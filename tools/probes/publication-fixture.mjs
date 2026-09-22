// Native publication inputs: preserve an existing exact marker; refuse a
// foreign claim instead of laundering it into this attempt's artifact.
export function publicationCommand(mode, context) {
  const body = mode.endsWith('-marker-foreign')
    ? 'Fixture deliverable\n\n<!-- attempt-claim:foreign-attempt -->'
    : mode.endsWith('-marker-idempotent-allow')
      ? `Fixture deliverable\n\n<!-- attempt-claim:${context.attemptId} -->`
      : 'Fixture deliverable';
  return `gh pr create --repo octo/example --title "Fixture PR" --body '${body}'`;
}

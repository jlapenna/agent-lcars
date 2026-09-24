// Deterministic GraphQL transport fixture. The actual shared reader/evaluator
// consumes this response; no policy decision is stubbed in the native adapter.
export function reviewFixture(mode) {
  const merge = mode.includes('-merge-');
  const acknowledged = mode.includes('-ack-');
  const released =
    mode.endsWith('-released') ||
    mode.endsWith('-self-release') ||
    (!acknowledged && mode.endsWith('-threads'));
  const timeline = [
    {
      id: 'hold-native',
      __typename: merge ? 'AutoMergeDisabledEvent' : 'ConvertToDraftEvent',
      actor: { login: 'maintainer' },
      createdAt: '2026-09-21T10:00:00Z',
    },
  ];
  if (released)
    timeline.push({
      id: 'release-native',
      __typename: merge ? 'AutoMergeEnabledEvent' : 'ReadyForReviewEvent',
      actor: {
        login: mode.endsWith('-self-release') ? 'worker-bot' : 'maintainer',
      },
      createdAt: '2026-09-21T11:00:00Z',
    });
  if (acknowledged) {
    const head = (mode.endsWith('-stale-head') ? 'b' : 'a').repeat(40);
    const marker = `<!-- lcars-hold-response:hold-native:${head} -->`;
    timeline.push({
      id: 'response-native',
      __typename: 'IssueComment',
      author: {
        login: mode.endsWith('-foreign-author') ? 'outsider' : 'worker-bot',
      },
      createdAt: mode.endsWith('-before-hold')
        ? '2026-09-21T09:00:00Z'
        : '2026-09-21T11:00:00Z',
      body: mode.endsWith('-empty')
        ? marker
        : `Fixture gate evidence: requested regression check passed.\n\n${marker}`,
    });
  }
  const connection = (nodes) => ({
    nodes,
    pageInfo: { hasNextPage: false, endCursor: null },
  });
  return {
    data: {
      viewer: { login: 'worker-bot' },
      repository: {
        pullRequest: {
          state: 'OPEN',
          headRefOid: 'a'.repeat(40),
          reviewDecision: mode.endsWith('-changes-requested')
            ? 'CHANGES_REQUESTED'
            : null,
          labels: connection(
            mode.endsWith('-blocked-label') ? [{ name: 'status:blocked' }] : [],
          ),
          timelineItems: connection(timeline),
          reviewThreads: connection(
            mode.endsWith('-threads')
              ? [{ id: 'thread-native', isResolved: false }]
              : [],
          ),
        },
      },
    },
  };
}

export const reviewCommand = (mode) =>
  mode.includes('-merge-')
    ? 'gh pr merge 42 --repo octo/example --auto --squash'
    : 'gh pr ready 42 --repo octo/example';
export const reviewDenial = (mode) =>
  reviewAllowed(mode)
    ? ''
    : mode.endsWith('-threads')
      ? 'Resolve outstanding review threads'
      : mode.endsWith('-changes-requested')
        ? 'still has changes requested'
        : mode.endsWith('-blocked-label')
          ? 'parked or blocked'
          : 'hold remains';

export const reviewAllowed = (mode) =>
  mode.endsWith('-released') || mode.endsWith('-ack-allow');

// An acknowledgment is evidence of the supported contract, not proof that an
// arbitrary maintainer condition has been satisfied. Other review gates remain.
export const reviewAcknowledgmentModes = [
  'bootstrap-hold-draft-ack-allow',
  'bootstrap-hold-merge-ack-allow',
  'bootstrap-hold-draft-ack-stale-head',
  'bootstrap-hold-draft-ack-foreign-author',
  'bootstrap-hold-draft-ack-before-hold',
  'bootstrap-hold-draft-ack-empty',
  'bootstrap-hold-draft-ack-threads',
  'bootstrap-hold-merge-ack-changes-requested',
  'bootstrap-hold-merge-ack-blocked-label',
  'bootstrap-hold-draft-self-release',
  'bootstrap-hold-merge-self-release',
];

// Deterministic GraphQL transport fixture. The actual shared reader/evaluator
// consumes this response; no policy decision is stubbed in the native adapter.
export function reviewFixture(mode) {
  const merge = mode.includes('-merge-');
  const released = mode.endsWith('-released') || mode.endsWith('-threads');
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
      actor: { login: 'maintainer' },
      createdAt: '2026-09-21T11:00:00Z',
    });
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
          reviewDecision: null,
          labels: connection([]),
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
  mode.endsWith('-released')
    ? ''
    : mode.endsWith('-threads')
      ? 'Resolve outstanding review threads'
      : 'hold remains';

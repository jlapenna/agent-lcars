'use strict';

const { execFileSync } = require('node:child_process');

const query = `query($owner:String!,$repo:String!,$number:Int!,$threads:String,$timeline:String) {
  viewer { login }
  repository(owner:$owner,name:$repo) {
    pullRequest(number:$number) {
      state headRefOid reviewDecision
      labels(first:100) { nodes { name } pageInfo { hasNextPage } }
      reviewThreads(first:100,after:$threads) {
        nodes { id isResolved }
        pageInfo { hasNextPage endCursor }
      }
      timelineItems(first:100,after:$timeline,itemTypes:[CONVERT_TO_DRAFT_EVENT,READY_FOR_REVIEW_EVENT,AUTO_MERGE_DISABLED_EVENT,AUTO_MERGE_ENABLED_EVENT,ISSUE_COMMENT]) {
        nodes {
          __typename
          ... on ConvertToDraftEvent { id createdAt actor { login } }
          ... on ReadyForReviewEvent { id createdAt actor { login } }
          ... on AutoMergeDisabledEvent { id createdAt actor { login } }
          ... on AutoMergeEnabledEvent { id createdAt actor { login } }
          ... on IssueComment { id createdAt body author { login } }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

function target(args, dispatchRepository) {
  let repository;
  const positional = [];
  const switches = new Set([
    '--auto',
    '-a',
    '--squash',
    '-s',
    '--merge',
    '-m',
    '--rebase',
    '-r',
    '--delete-branch',
    '-d',
  ]);
  const values = new Set([
    '--repo',
    '-R',
    '--match-head-commit',
    '--subject',
    '-t',
    '--body',
    '-b',
    '--body-file',
    '-F',
  ]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (switches.has(arg)) continue;
    const index = arg.indexOf('=');
    const flag = index > 0 ? arg.slice(0, index) : arg;
    if (values.has(flag)) {
      const value = index > 0 ? arg.slice(index + 1) : args[++i];
      if (!value) throw new Error('Missing readiness argument');
      if (flag === '--repo' || flag === '-R') {
        if (repository) throw new Error('Ambiguous readiness repository');
        repository = value;
      }
    } else if (arg.startsWith('-'))
      throw new Error('Unsupported readiness argument');
    else positional.push(arg);
  }
  if (
    repository !== dispatchRepository ||
    positional.length !== 1 ||
    !/^[1-9][0-9]*$/.test(positional[0]) ||
    !Number.isSafeInteger(Number(positional[0]))
  )
    throw new Error('Readiness needs an explicit repository and PR number');
  return { repository, number: Number(positional[0]) };
}

function readSnapshot(repository, number, request) {
  const [owner, repo] = repository.split('/');
  const deadline = Date.now() + 4000;
  const fetch =
    request ??
    ((variables) => {
      const args = ['api', 'graphql', '-f', `query=${query}`];
      for (const [key, value] of Object.entries(variables))
        if (value !== null) args.push('-F', `${key}=${value}`);
      return JSON.parse(
        execFileSync('gh', args, {
          encoding: 'utf8',
          timeout: Math.max(1, deadline - Date.now()),
          stdio: ['ignore', 'pipe', 'ignore'],
          maxBuffer: 2 * 1024 * 1024,
        }),
      );
    });
  let threads = null,
    timeline = null,
    snapshot;
  const threadNodes = new Map(),
    timelineNodes = new Map();
  for (let page = 0; page < 20 && Date.now() < deadline; page++) {
    const response = fetch({ owner, repo, number, threads, timeline });
    const pr = response.data?.repository?.pullRequest;
    const viewer = response.data?.viewer?.login;
    if (response.errors?.length || !pr || !viewer || !pr.headRefOid)
      throw new Error('Review lookup failed');
    if (
      snapshot &&
      (snapshot.headRefOid !== pr.headRefOid || snapshot.viewer !== viewer)
    )
      throw new Error('PR changed during review lookup');
    snapshot = { ...pr, viewer };
    for (const [connection, target] of [
      [pr.reviewThreads, threadNodes],
      [pr.timelineItems, timelineNodes],
    ]) {
      if (
        !Array.isArray(connection?.nodes) ||
        typeof connection.pageInfo?.hasNextPage !== 'boolean'
      )
        throw new Error('Incomplete review page');
      for (const node of connection.nodes) {
        if (!node?.id) throw new Error('Unreadable review record');
        target.set(node.id, node);
      }
    }
    const moreThreads = pr.reviewThreads.pageInfo.hasNextPage;
    const moreTimeline = pr.timelineItems.pageInfo.hasNextPage;
    if (!moreThreads && !moreTimeline)
      return {
        ...snapshot,
        threads: [...threadNodes.values()],
        timeline: [...timelineNodes.values()],
      };
    for (const [more, info, cursor] of [
      [moreThreads, pr.reviewThreads.pageInfo, threads],
      [moreTimeline, pr.timelineItems.pageInfo, timeline],
    ]) {
      if (more && (!info.endCursor || info.endCursor === cursor))
        throw new Error('Review pagination stalled');
    }
    if (moreThreads) threads = pr.reviewThreads.pageInfo.endCursor;
    if (moreTimeline) timeline = pr.timelineItems.pageInfo.endCursor;
  }
  throw new Error('Review lookup exceeded bounded budget');
}

function rejection(snapshot) {
  if (snapshot.state !== 'OPEN') return 'The delivery PR is not open.';
  if (
    !Array.isArray(snapshot.labels?.nodes) ||
    snapshot.labels.pageInfo?.hasNextPage !== false
  )
    throw new Error('Incomplete PR labels');
  if (
    snapshot.labels.nodes.some((label) =>
      ['status:needs-human', 'status:blocked'].includes(label.name),
    )
  )
    return 'The delivery PR is parked or blocked. Resolve its stated gate before marking ready or arming merge.';
  if (
    !Array.isArray(snapshot.threads) ||
    snapshot.threads.some((thread) => thread.isResolved !== true)
  )
    return 'Resolve outstanding review threads before marking ready or arming merge.';
  if (snapshot.reviewDecision === 'CHANGES_REQUESTED')
    return 'The delivery PR still has changes requested. Address the review before marking ready or arming merge.';
  if (
    !snapshot.viewer ||
    !snapshot.headRefOid ||
    !Array.isArray(snapshot.timeline)
  )
    throw new Error('Incomplete review snapshot');
  const events = [...snapshot.timeline].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );
  const holds = new Map();
  const kinds = {
    ConvertToDraftEvent: 'draft',
    AutoMergeDisabledEvent: 'merge',
  };
  const releases = {
    ReadyForReviewEvent: 'draft',
    AutoMergeEnabledEvent: 'merge',
  };
  for (const event of events) {
    if (kinds[event.__typename] && event.actor?.login !== snapshot.viewer)
      holds.set(kinds[event.__typename], event);
    const previous = holds.get(releases[event.__typename]);
    if (
      previous &&
      event.actor?.login &&
      event.actor.login === previous.actor?.login
    )
      holds.delete(releases[event.__typename]);
  }
  for (const event of holds.values()) {
    const marker = `<!-- lcars-hold-response:${event.id}:${snapshot.headRefOid} -->`;
    const answered = events.some(
      (comment) =>
        comment.__typename === 'IssueComment' &&
        comment.author?.login === snapshot.viewer &&
        comment.createdAt > event.createdAt &&
        comment.body.includes(marker) &&
        comment.body.replace(marker, '').trim().length > 0,
    );
    if (!answered)
      return `An external ${event.__typename} hold remains. Read the PR and anchor feedback, satisfy its stated gate, then explain the evidence on this PR with ${marker}. This acknowledgment does not waive unresolved reviews or repository approvals.`;
  }
  return null;
}

module.exports = { target, readSnapshot, rejection };

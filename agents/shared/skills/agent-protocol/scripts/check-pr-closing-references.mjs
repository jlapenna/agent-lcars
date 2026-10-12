#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const issueReference = /^[^/\s#]+\/[^/\s#]+#[1-9][0-9]*$/;
const query = `query($owner:String!,$repo:String!,$number:Int!,$endCursor:String) {
  repository(owner:$owner,name:$repo) {
    pullRequest(number:$number) {
      state isDraft headRefOid
      closingIssuesReferences(first:100,after:$endCursor) {
        nodes { number repository { nameWithOwner } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

// Completion is an explicit acceptance decision, never inferred from PR prose.
export function checkClosingReferences(
  { repository, number, head, complete },
  request,
) {
  if (
    !/^[^/\s#]+\/[^/\s#]+$/.test(repository ?? '') ||
    !Number.isSafeInteger(number) ||
    number < 1 ||
    !/^[0-9a-f]{40}$/.test(head ?? '') ||
    !Array.isArray(complete) ||
    complete.some((reference) => !issueReference.test(reference)) ||
    new Set(complete.map((reference) => reference.toLowerCase())).size !==
      complete.length
  )
    throw new Error(
      'Declare repository, PR number, exact head and completed issue references (or none).',
    );

  const [owner, repo] = repository.split('/');
  const deadline = Date.now() + 30_000;
  const fetch =
    request ??
    ((variables) => {
      const args = ['api', 'graphql', '-f', `query=${query}`];
      for (const [key, value] of Object.entries(variables)) {
        if (value !== null) args.push('-F', `${key}=${value}`);
      }
      try {
        return JSON.parse(
          execFileSync('gh', args, {
            encoding: 'utf8',
            timeout: Math.max(1, deadline - Date.now()),
            maxBuffer: 2 * 1024 * 1024,
            stdio: ['ignore', 'pipe', 'pipe'],
          }),
        );
      } catch {
        throw new Error(
          'GitHub closing-reference request failed; no closure scope was verified.',
        );
      }
    });
  const actual = new Set();
  const cursors = new Set();
  let endCursor = null;
  for (let page = 0; page < 20 && Date.now() < deadline; page++) {
    const response = fetch({ owner, repo, number, endCursor });
    const pr = response?.data?.repository?.pullRequest;
    if (
      response?.errors?.length ||
      !pr ||
      pr.state !== 'OPEN' ||
      typeof pr.isDraft !== 'boolean' ||
      pr.headRefOid !== head
    ) {
      throw new Error(
        'Closing-reference lookup failed or PR is not open at the expected head.',
      );
    }
    const connection = pr.closingIssuesReferences;
    if (
      !Array.isArray(connection?.nodes) ||
      typeof connection.pageInfo?.hasNextPage !== 'boolean'
    ) {
      throw new Error('Incomplete closing-reference response.');
    }
    for (const issue of connection.nodes) {
      const reference = `${issue?.repository?.nameWithOwner}#${issue?.number}`;
      if (
        !issueReference.test(reference) ||
        !Number.isSafeInteger(issue.number)
      ) {
        throw new Error('Invalid closing issue reference.');
      }
      actual.add(reference.toLowerCase());
    }
    if (!connection.pageInfo.hasNextPage) {
      const intended = new Set(
        complete.map((reference) => reference.toLowerCase()),
      );
      const unintended = [...actual].filter(
        (reference) => !intended.has(reference),
      );
      const missing = [...intended].filter(
        (reference) => !actual.has(reference),
      );
      if (unintended.length || missing.length) {
        throw new Error(
          `Closing scope mismatch: unintended [${unintended.join(', ')}]; missing [${missing.join(', ')}]. Correct the PR metadata and re-read before ready/arming.`,
        );
      }
      return { repository, number, head, closingIssuesReferences: [...actual] };
    }
    const cursor = connection.pageInfo.endCursor;
    if (typeof cursor !== 'string' || !cursor || cursors.has(cursor)) {
      throw new Error('Incomplete closing-reference pagination.');
    }
    cursors.add(cursor);
    endCursor = cursor;
  }
  throw new Error('Closing-reference lookup exceeded its page/time bound.');
}

export function main(args) {
  if (args.length !== 4 || !/^[1-9][0-9]*$/.test(args[1] ?? '')) {
    throw new Error(
      'Usage: node check-pr-closing-references.mjs OWNER/REPO PR EXACT_HEAD none|OWNER/REPO#ISSUE[,OWNER/REPO#ISSUE]',
    );
  }
  const [repository, number, head, completion] = args;
  return checkClosingReferences({
    repository,
    number: Number(number),
    head,
    complete: completion === 'none' ? [] : completion.split(','),
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    console.log(JSON.stringify(main(process.argv.slice(2))));
  } catch (error) {
    // Do not echo gh stderr: only the bounded gate diagnosis is public evidence.
    console.error(
      error instanceof Error
        ? error.message
        : 'Closing-reference check failed.',
    );
    process.exitCode = 1;
  }
}

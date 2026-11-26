import { createHash } from 'node:crypto';

import {
  type AgentEvent,
  agentEventSchema,
  finishedChecks,
  isTrustedGitHubActor,
} from '@agent-lcars/work';
import { z } from 'zod';

export const GITHUB_PREVIEW_EVENTS = [
  'review.submitted',
  'state.changed',
  'head.changed',
  'merge_conflict',
  'check_suite.status.changed',
].map((type) => `com.github.pull_request.${type}.v1`);

const user = z.object({ login: z.string() });
const pull = z.object({
  number: z.number().int().positive(),
  state: z.enum(['open', 'closed']),
  merged: z.boolean(),
  merged_at: z.string().nullable(),
  closed_at: z.string().nullable(),
  updated_at: z.string(),
  merged_by: user.nullable(),
  user: user.nullable(),
  author_association: z.string(),
  mergeable: z.boolean().nullable(),
  head: z.object({
    sha: z.string().regex(/^[a-f0-9]{40}$/u),
    repo: z.object({ full_name: z.string() }).nullable(),
  }),
  base: z.object({ repo: z.object({ full_name: z.string() }) }),
});
const review = z.object({
  id: z.number().int().positive(),
  user: user.nullable(),
  author_association: z.string(),
  submitted_at: z.string().nullable(),
  state: z.string(),
});
const timeline = z.object({
  id: z.number().int().positive(),
  event: z.string(),
  actor: user.nullable(),
  created_at: z.string(),
});
const check = z.object({
  id: z.number(),
  name: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
});

export interface GithubPreviewRead {
  /** Relative, generated github.com REST paths only; pages flattens pagination. */
  get(path: string): Promise<unknown>;
  pages(path: string): Promise<unknown[]>;
}

/** Validates the thin notification before any authenticated read. Neither
 * content nor arbitrary api_url is forwarded, executed, or fetched. */
export function validGithubPreviewNotice(
  input: unknown,
  repository: string,
  number: number,
): boolean {
  const parsed = z
    .object({ type: z.string(), data: z.object({ api_url: z.string() }) })
    .safeParse(input);
  if (!parsed.success || !GITHUB_PREVIEW_EVENTS.includes(parsed.data.type))
    return false;
  let url: URL;
  try {
    url = new URL(parsed.data.data.api_url);
  } catch {
    return false;
  }
  if (
    url.origin !== 'https://api.github.com' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    return false;
  const prefix = `/repos/${repository}/`;
  if (!url.pathname.toLowerCase().startsWith(prefix.toLowerCase()))
    return false;
  const rest = url.pathname.slice(prefix.length);
  if (parsed.data.type.includes('review.submitted'))
    return new RegExp(`^pulls/${number}/reviews/[1-9][0-9]*$`, 'u').test(rest);
  if (parsed.data.type.includes('check_suite.'))
    return /^check-suites\/[1-9][0-9]*$/u.test(rest);
  return rest === `pulls/${number}`;
}

/** One authoritative read after attach/reconnect and every notification.
 * The watermark advances only after the complete batch is published. Review
 * and state actors use the same trust rule as App events. Derived head checks
 * are admitted only for code pushed in the base repo, matching the App.
 * Mergeability is a GitHub-generated observation of the target PR, including forks. */
export async function readGithubPreviewEvents(
  api: GithubPreviewRead,
  repository: string,
  number: number,
  since: string,
  now: string,
): Promise<AgentEvent[]> {
  const root = `repos/${repository}`;
  const pr = pull.parse(await api.get(`${root}/pulls/${number}`));
  if (
    pr.number !== number ||
    pr.base.repo.full_name.toLowerCase() !== repository.toLowerCase()
  )
    throw new Error('GitHub PR identity mismatch');
  const key = `github:pr:${repository.toLowerCase()}#${number}`;
  const events: AgentEvent[] = [];
  const add = (
    kind: string,
    identity: string,
    occurredAt: string,
    actor?: string,
    detail?: string,
  ) => {
    const id = `github.preview.${createHash('sha256').update(`${key}:${identity}`).digest('hex')}`;
    const parsed = agentEventSchema.safeParse({
      id,
      key,
      kind,
      occurredAt,
      ...(actor ? { actor } : {}),
      ...(detail ? { detail } : {}),
    });
    if (parsed.success) events.push(parsed.data);
  };
  const reviews = (
    await api.pages(`${root}/pulls/${number}/reviews?per_page=100`)
  ).flat();
  for (const raw of reviews) {
    const r = review.parse(raw);
    if (
      !r.submitted_at ||
      Date.parse(r.submitted_at) < Date.parse(since) ||
      !isTrustedGitHubActor({
        login: r.user?.login,
        association: r.author_association,
      })
    )
      continue;
    // Never carry a review's free text. Only GitHub's finite state is a detail.
    const state = r.state.toLowerCase();
    if (
      ['approved', 'changes_requested', 'commented', 'dismissed'].includes(
        state,
      )
    )
      add(
        'review',
        `review:${r.id}`,
        r.submitted_at,
        r.user?.login,
        state.replaceAll('_', ' '),
      );
  }
  if (pr.merged && pr.merged_by && pr.merged_at) {
    const actor = pr.merged_by.login;
    const association =
      actor === pr.user?.login ? pr.author_association : 'COLLABORATOR';
    if (isTrustedGitHubActor({ login: actor, association }))
      add('merged', `merged:${pr.merged_at}`, pr.merged_at, actor);
  } else if (pr.state === 'closed' && pr.closed_at) {
    const issue = z
      .object({ closed_by: user.nullable() })
      .parse(await api.get(`${root}/issues/${number}`));
    const actor = issue.closed_by?.login;
    const association =
      actor === pr.user?.login ? pr.author_association : 'COLLABORATOR';
    if (actor && isTrustedGitHubActor({ login: actor, association }))
      add('closed', `closed:${pr.closed_at}`, pr.closed_at, actor);
  } else {
    const history = (
      await api.pages(`${root}/issues/${number}/timeline?per_page=100`)
    ).flat();
    const transitions = history.flatMap((raw) => {
      const r = timeline.safeParse(raw);
      return r.success && ['closed', 'reopened'].includes(r.data.event)
        ? [r.data]
        : [];
    });
    const last = transitions.sort((a, b) => a.id - b.id).at(-1);
    if (
      last?.event === 'reopened' &&
      Date.parse(last.created_at) >= Date.parse(since)
    ) {
      const actor = last.actor?.login;
      const association =
        actor === pr.user?.login ? pr.author_association : 'COLLABORATOR';
      if (actor && isTrustedGitHubActor({ login: actor, association }))
        add('reopened', `reopened:${last.id}`, last.created_at, actor);
    }
  }
  if (pr.mergeable === false && pr.state === 'open')
    add('conflict', `conflict:${pr.head.sha}:${pr.updated_at}`, now);
  if (pr.head.repo?.full_name.toLowerCase() === repository.toLowerCase()) {
    const pages = await api.pages(
      `${root}/commits/${pr.head.sha}/check-runs?per_page=100`,
    );
    const runs = pages.flatMap(
      (page) => z.object({ check_runs: z.array(check) }).parse(page).check_runs,
    );
    const done = finishedChecks(pr.head.sha, runs);
    if (done)
      events.push(
        agentEventSchema.parse({
          id: done.id,
          key,
          kind: 'checks-finished',
          occurredAt: now,
          detail: done.detail,
        }),
      );
  }
  return events;
}

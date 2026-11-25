import 'server-only';

import { parseAgentEventKey } from '@agent-lcars/work';
import { z } from 'zod';

import type { AgentEventSubscriptionStore } from './agent-event-store';
import {
  type GithubAgentEventCandidate,
  githubAgentEventCandidates,
  type GithubWebhookDelivery,
  trustedGitHubSender,
} from './github-agent-events';
import { getGithubClient } from './github-client';

const triggerPayload = z.object({
  repository: z.object({ full_name: z.string() }),
  sender: z.object({ login: z.string() }).optional(),
  ref: z.string().optional(),
  deleted: z.boolean().optional(),
  action: z.string().optional(),
  changes: z
    .object({ base: z.object({ ref: z.unknown().optional() }).optional() })
    .optional(),
  pull_request: z
    .object({
      number: z.number().int().positive(),
      user: z.object({ login: z.string() }),
      author_association: z.string(),
    })
    .optional(),
});

/** A signed push to a repository branch required write access. For PR head
 * changes, reuse the existing actor policy before reading mergeability. */
export function mergeabilityTrigger(
  delivery: GithubWebhookDelivery,
):
  | { repository: string; actor?: string; baseRef?: string; key?: string }
  | undefined {
  const parsed = triggerPayload.safeParse(delivery.payload);
  if (!parsed.success) return undefined;
  const payload = parsed.data;
  const repository = payload.repository.full_name.toLowerCase();
  if (!parseAgentEventKey(`github:pr:${repository}#1`).ok) return undefined;
  const actor = payload.sender?.login;
  if (delivery.event === 'push') {
    if (payload.deleted || !payload.ref?.startsWith('refs/heads/'))
      return undefined;
    return {
      repository,
      ...(actor ? { actor } : {}),
      baseRef: payload.ref.slice('refs/heads/'.length),
    };
  }
  if (delivery.event !== 'pull_request') return undefined;
  if (
    payload.action === 'edited' &&
    payload.pull_request !== undefined &&
    payload.changes?.base?.ref !== undefined
  ) {
    const pr = payload.pull_request;
    if (
      !trustedGitHubSender(actor, {
        login: pr.user.login,
        association: pr.author_association,
      })
    )
      return undefined;
    const key = parseAgentEventKey(`github:pr:${repository}#${pr.number}`);
    if (!key.ok) return undefined;
    return { repository, key: key.value.key, ...(actor ? { actor } : {}) };
  }
  const candidate = githubAgentEventCandidates(delivery).find(
    ({ kind }) => kind === 'pushed' || kind === 'reopened',
  );
  return candidate === undefined
    ? undefined
    : {
        repository,
        key: candidate.key,
        ...(candidate.actor ? { actor: candidate.actor } : {}),
      };
}

const pullRequestState = z.object({
  state: z.string(),
  head: z.object({ sha: z.string() }),
  base: z.object({ ref: z.string(), sha: z.string() }),
  mergeable: z.boolean().nullable(),
  mergeable_state: z.string(),
});
export type PullRequestMergeability = z.infer<typeof pullRequestState>;
export async function readPullRequestMergeability(
  repository: string,
  number: number,
): Promise<PullRequestMergeability> {
  const [owner, repo] = repository.split('/');
  const { data } = await getGithubClient().rest.pulls.get({
    owner,
    repo,
    pull_number: number,
  });
  return pullRequestState.parse(data);
}

/** Expand a base push to only subscribed PRs targeting that branch. One read
 * per PR, regardless of subscriber count. The durable task retries unknown
 * mergeability, since GitHub computes it asynchronously and emits no event
 * when it finishes. No polling process or unrelated PR scan is needed. */
export async function mergeabilityCandidates(
  delivery: GithubWebhookDelivery,
  store: AgentEventSubscriptionStore,
  read: typeof readPullRequestMergeability = readPullRequestMergeability,
): Promise<{ candidates: GithubAgentEventCandidate[]; retry: boolean }> {
  const trigger = mergeabilityTrigger(delivery);
  if (trigger === undefined) return { candidates: [], retry: false };
  const subscriptions =
    trigger.key === undefined
      ? await store.listForKeyPrefix(`github:pr:${trigger.repository}#`)
      : await store.listForKey(trigger.key);
  const keys = new Set(
    subscriptions
      .filter(
        ({ kinds }) =>
          !kinds || kinds.includes('conflict') || kinds.includes('behind'),
      )
      .map(({ key }) => key),
  );
  const candidates: GithubAgentEventCandidate[] = [];
  let retry = false;
  for (const key of keys) {
    const number = Number(key.slice(key.lastIndexOf('#') + 1));
    let pr: PullRequestMergeability;
    try {
      pr = await read(trigger.repository, number);
    } catch {
      retry = true;
      continue;
    }
    if (
      pr.state !== 'open' ||
      (trigger.baseRef !== undefined && pr.base.ref !== trigger.baseRef)
    )
      continue;
    if (pr.mergeable === null || pr.mergeable_state === 'unknown') {
      retry = true;
      continue;
    }
    const kind =
      pr.mergeable === false
        ? 'conflict'
        : pr.mergeable_state === 'behind'
          ? 'behind'
          : undefined;
    if (kind === undefined) continue;
    candidates.push({
      id: `github.${delivery.deliveryId}.${number}.${kind}`,
      key,
      kind,
      occurredAt: delivery.receivedAt,
      link: `https://github.com/${trigger.repository}/pull/${number}`,
      ...(trigger.actor ? { actor: trigger.actor } : {}),
    });
  }
  return { candidates, retry };
}

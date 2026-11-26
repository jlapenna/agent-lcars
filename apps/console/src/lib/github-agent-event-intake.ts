import 'server-only';

import { logger } from '@agent-lcars/logging';
import type { Orchestrator } from '@agent-lcars/orchestrator';
import { subscriptionMatches } from '@agent-lcars/work';
import { z } from 'zod';

import {
  type AgentEventRoutingDeps,
  defaultAgentEventPublisher,
  routeAgentEventToSubscriptions,
} from './agent-event-routing';
import {
  agentEventSubscriptionStore,
  type StoredAgentEventSubscription,
} from './agent-event-store';
import {
  type CheckRunState,
  finalizeGithubAgentEvent,
  finishedChecks,
  type GithubAgentEventCandidate,
  githubAgentEventCandidates,
  type GithubDerivedRead,
  type GithubWebhookDelivery,
} from './github-agent-events';
import { getGithubClient } from './github-client';
import {
  mergeabilityCandidates,
  mergeabilityTrigger,
  readPullRequestMergeability,
} from './github-pr-mergeability-events';
import {
  enqueueGitHubAgentEvents,
  type GitHubWebhookEnvelope,
} from './hosted-webhook-queue';
import { queueWorkEventResume } from './work-event-resume';

/**
 * Delivery of GitHub App webhooks to subscribed agents (#3569). The webhook
 * routes hand a delivery that could stand for an event to its own Cloud
 * Task (`queueGithubAgentEvents`), after their existing handling and without
 * waiting on it; the task's route calls {@link routeGithubAgentEvents}.
 */

/** The GitHub reads a derived kind needs, made with the App's token. */
export interface GithubAgentEventReads {
  /** The latest check run per name on a commit, or undefined when there are
   * more than this source reads. */
  checkRuns(
    repository: string,
    headSha: string,
  ): Promise<CheckRunState[] | undefined>;
  /** Whether every review thread on the pull request is resolved, or
   * undefined when there are more threads than this source reads. */
  threadsResolved(
    repository: string,
    number: number,
  ): Promise<boolean | undefined>;
}

const CHECK_RUN_PAGES = 3;
const PAGE = 100;

const checkRunsPage = z.object({
  total_count: z.number().int().nonnegative(),
  check_runs: z.array(
    z.object({
      id: z.number().int().positive(),
      name: z.string(),
      status: z.string(),
      conclusion: z.string().nullable(),
    }),
  ),
});

const reviewThreadsResponse = z.object({
  repository: z.object({
    pullRequest: z
      .object({
        reviewThreads: z.object({
          pageInfo: z.object({ hasNextPage: z.boolean() }),
          nodes: z.array(z.object({ isResolved: z.boolean() })),
        }),
      })
      .nullable(),
  }),
});

const REVIEW_THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: ${PAGE}) { pageInfo { hasNextPage } nodes { isResolved } }
    }
  }
}`;

function split(repository: string): { owner: string; repo: string } {
  const [owner, repo] = repository.split('/');
  return { owner, repo };
}

export const githubAgentEventReads: GithubAgentEventReads = {
  async checkRuns(repository, headSha) {
    const { owner, repo } = split(repository);
    const runs: CheckRunState[] = [];
    for (let page = 1; page <= CHECK_RUN_PAGES; page += 1) {
      const { data } = await getGithubClient().rest.checks.listForRef({
        owner,
        repo,
        ref: headSha,
        filter: 'latest',
        per_page: PAGE,
        page,
      });
      const parsed = checkRunsPage.parse(data);
      runs.push(...parsed.check_runs);
      if (runs.length >= parsed.total_count) return runs;
      if (parsed.check_runs.length < PAGE) return undefined;
    }
    return undefined;
  },
  async threadsResolved(repository, number) {
    const { owner, repo } = split(repository);
    const data = reviewThreadsResponse.parse(
      await getGithubClient().graphql(REVIEW_THREADS_QUERY, {
        owner,
        name: repo,
        number,
      }),
    );
    const threads = data.repository.pullRequest?.reviewThreads;
    if (threads === undefined || threads.pageInfo.hasNextPage) return undefined;
    return threads.nodes.every((thread) => thread.isResolved);
  },
};

export interface GithubAgentEventDeps extends AgentEventRoutingDeps {
  reads: GithubAgentEventReads;
  /** Drains the orchestrator outbox, so a Work an event resumed (#3570)
   * starts now rather than at the next maintenance drain. */
  drain?: () => Promise<unknown>;
  readMergeability?: typeof readPullRequestMergeability;
}

/** The production dependencies, recording Work-target events through the
 * given orchestrator. */
export function defaultGithubAgentEventDeps(runtime: {
  orchestrator: Pick<Orchestrator, 'queueEventResume'>;
  drain: () => Promise<unknown>;
}): GithubAgentEventDeps {
  return {
    store: agentEventSubscriptionStore,
    publisher: defaultAgentEventPublisher,
    resumeWork: queueWorkEventResume(runtime.orchestrator),
    reads: githubAgentEventReads,
    drain: runtime.drain,
  };
}

export type GithubAgentEventOutcome =
  /** The delivery stands for no event, or its actor is not trusted. */
  | 'no-event'
  /** No subscription wants it: the fast path, one lookup per key. */
  | 'no-subscriber'
  /** A derived kind whose condition does not hold, or could not be read. */
  | 'not-derived'
  | 'routed';

export interface GithubAgentEventResult {
  readonly deliveryId: string;
  readonly events: readonly {
    readonly key: string;
    readonly kind: string;
    readonly outcome: GithubAgentEventOutcome;
    readonly eventId?: string;
    readonly published?: number;
  }[];
}

/** Completes a derived candidate with its one GitHub read; undefined when
 * the condition does not hold. A failed read is logged and treated the same:
 * retrying a whole delivery on GitHub's behalf would put a poisoned read in
 * the shared webhook queue, and the next check or thread event reads again. */
async function derive(
  candidate: GithubAgentEventCandidate,
  read: GithubDerivedRead,
  reads: GithubAgentEventReads,
): Promise<GithubAgentEventCandidate | undefined> {
  try {
    if (read.type === 'threads-resolved') {
      const resolved = await reads.threadsResolved(
        read.repository,
        read.number,
      );
      return resolved === true ? candidate : undefined;
    }
    const runs = await reads.checkRuns(read.repository, read.headSha);
    const finished =
      runs === undefined ? undefined : finishedChecks(read.headSha, runs);
    return finished === undefined
      ? undefined
      : { ...candidate, id: finished.id, detail: finished.detail };
  } catch (error) {
    logger.warn(
      'agent-lcars: GitHub agent event %s for %s not derived:',
      candidate.kind,
      candidate.key,
      error,
    );
    return undefined;
  }
}

/**
 * Routes the events one GitHub delivery stands for to the subscriptions that
 * want them. Per delivery it reads each affected key's subscriptions once;
 * a derived kind's GitHub read happens only when a subscription wants that
 * kind. A routing failure is thrown after every event was tried, so the
 * caller retries the delivery; the router skips subscriptions it already
 * published an event id for.
 */
export async function routeGithubAgentEvents(
  delivery: GithubWebhookDelivery,
  deps: GithubAgentEventDeps,
): Promise<GithubAgentEventResult> {
  const mergeability = await mergeabilityCandidates(
    delivery,
    deps.store,
    deps.readMergeability,
  );
  const candidates = [
    ...githubAgentEventCandidates(delivery),
    ...mergeability.candidates,
  ];
  const subscriptionsByKey = new Map<string, StoredAgentEventSubscription[]>();
  for (const key of new Set(candidates.map((candidate) => candidate.key)))
    subscriptionsByKey.set(key, await deps.store.listForKey(key));

  const events: GithubAgentEventResult['events'][number][] = [];
  const failures: unknown[] = mergeability.retry
    ? [new Error('GitHub PR mergeability is still pending or unreadable')]
    : [];
  let resumeQueued = false;
  for (const candidate of candidates) {
    const { key, kind } = candidate;
    const subscriptions = (subscriptionsByKey.get(key) ?? []).filter(
      (subscription) => subscriptionMatches(subscription, candidate),
    );
    if (subscriptions.length === 0) {
      events.push({ key, kind, outcome: 'no-subscriber' });
      continue;
    }
    const derived =
      candidate.derive === undefined
        ? candidate
        : await derive(candidate, candidate.derive, deps.reads);
    const event =
      derived === undefined ? undefined : finalizeGithubAgentEvent(derived);
    if (event === undefined) {
      events.push({ key, kind, outcome: 'not-derived' });
      continue;
    }
    try {
      const routed = await routeAgentEventToSubscriptions(
        event,
        subscriptions,
        deps,
      );
      if (
        routed.deliveries.some(
          (delivery) => delivery.outcome === 'resume-queued',
        )
      )
        resumeQueued = true;
      events.push({
        key,
        kind,
        outcome: 'routed',
        eventId: event.id,
        published: routed.deliveries.filter(
          (delivery) => delivery.outcome === 'published',
        ).length,
      });
    } catch (error) {
      failures.push(error);
    }
  }
  // A queued resume is durable already; draining only starts it sooner,
  // so a drain failure is logged, never a reason to redeliver.
  if (resumeQueued && deps.drain !== undefined)
    await deps
      .drain()
      .catch((error: unknown) =>
        logger.warn(
          'agent-lcars: outbox drain after GitHub delivery %s failed; the maintenance drain resumes the Work',
          delivery.deliveryId,
          error,
        ),
      );
  if (failures.length > 0)
    throw new AggregateError(
      failures,
      `${failures.length} GitHub agent events for delivery ${delivery.deliveryId} failed to route`,
    );
  return { deliveryId: delivery.deliveryId, events };
}

/**
 * Hands a delivery to its own Cloud Task for {@link routeGithubAgentEvents}
 * when, by the pure mapping and the actor policy, it stands for at least one
 * event; anything else costs nothing more. Never throws: a webhook route
 * calls this after its own handling, and an event must never fail or retry
 * admission. A failed enqueue is logged at error; the task name is fixed
 * per delivery, so a retried caller enqueues it at most once.
 */
export async function queueGithubAgentEvents(
  envelope: Pick<
    GitHubWebhookEnvelope,
    'rawBody' | 'deliveryId' | 'eventName' | 'signature'
  >,
  payload: unknown,
  enqueue: typeof enqueueGitHubAgentEvents = enqueueGitHubAgentEvents,
): Promise<'enqueued' | 'duplicate' | 'no-event' | 'failed'> {
  try {
    const candidates = githubAgentEventCandidates({
      event: envelope.eventName,
      deliveryId: envelope.deliveryId,
      payload,
      receivedAt: new Date().toISOString(),
    });
    const trigger = mergeabilityTrigger({
      event: envelope.eventName,
      deliveryId: envelope.deliveryId,
      payload,
      receivedAt: new Date().toISOString(),
    });
    if (candidates.length === 0 && trigger === undefined) return 'no-event';
    return (
      await enqueue({
        ...envelope,
        ...(trigger ? { notBefore: new Date(Date.now() + 5_000) } : {}),
      })
    ).outcome;
  } catch (error) {
    logger.structured(
      'error',
      'LCARS agent event enqueue failed',
      {
        component: 'lcars-agent-events',
        source: 'github',
        stage: 'enqueue',
        outcome: 'failed',
      },
      { enrich: false },
    );
    logger.error(
      'agent-lcars: GitHub agent event enqueue failed for %s/%s:',
      envelope.eventName,
      envelope.deliveryId,
      error,
    );
    return 'failed';
  }
}

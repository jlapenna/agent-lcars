import {
  type AgentEvent,
  agentEventSchema,
  parseAgentEventKey,
} from '@agent-lcars/work';
import { z } from 'zod';

import { isTrustedGitHubActor } from '@/lib/github-actor-trust';

/**
 * Turns one GitHub App webhook delivery into the `github:pr`, `github:issue`
 * and `github:run` agent events it stands for (#3569, step 2 of #3538).
 * Pure: no I/O, and a payload that does not parse is no event.
 *
 * ## Payload to kind
 *
 * | Delivery                                       | Key            | Kind               | Detail                            |
 * | ---------------------------------------------- | -------------- | ------------------ | --------------------------------- |
 * | `pull_request` `closed`, merged                | `github:pr`    | `merged`           |                                   |
 * | `pull_request` `closed`, not merged            | `github:pr`    | `closed`           |                                   |
 * | `pull_request` `reopened`                      | `github:pr`    | `reopened`         |                                   |
 * | `pull_request` `synchronize`                   | `github:pr`    | `pushed`           | `head <sha7>`                     |
 * | `pull_request` `auto_merge_enabled`/`disabled` | `github:pr`    | `auto-merge`       | `enabled` / `disabled`            |
 * | `pull_request_review` `submitted`              | `github:pr`    | `review`           | review state, such as `approved`  |
 * | `pull_request_review_thread` `resolved`        | `github:pr`    | `thread`           | `resolved`                        |
 * |   ... and no unresolved thread remains         | `github:pr`    | `threads-resolved` | (derived, see below)              |
 * | `pull_request_review_thread` `unresolved`      | `github:pr`    | `thread`           | `unresolved`                      |
 * | `issue_comment` `created` on a pull request    | `github:pr`    | `comment`          |                                   |
 * | `issue_comment` `created` on an issue          | `github:issue` | `comment`          |                                   |
 * | `issues` `closed` / `reopened`                 | `github:issue` | `closed`/`reopened`| `closed`: the state reason        |
 * | `check_run` `completed`, every run on the head complete | `github:pr` | `checks-finished` | `all passed` / `<n> failed` (derived) |
 * | `workflow_run` `completed`                     | `github:run`   | `completed`        | the run's conclusion              |
 *
 * Not mapped: `ready_for_review` and `converted_to_draft` (the model has no
 * draft kind), review comments on their own (each arrives with its
 * `review`), and every other action. `conflict` and `behind` are not
 * produced yet: GitHub computes mergeability asynchronously and sends no
 * pull request event when the base branch moves, so both need a base-branch
 * `push` consumer that re-reads each subscribed pull request later. That is
 * left to a follow-up (#3569).
 *
 * `threads-resolved` and `checks-finished` are derived: the candidate
 * carries a {@link GithubDerivedRead}, and the caller makes that one GitHub
 * read only when a subscription wants the kind.
 *
 * ## Actor policy
 *
 * Every kind passes {@link isTrustedGitHubActor} (OWNER, MEMBER, COLLABORATOR
 * or a fleet bot, the rule approvals already follow) for the actor GitHub
 * reports, before anything is routed:
 *
 * - `review` and `comment`: the review's or comment's author and its
 *   `author_association`, exactly as for approvals.
 * - `merged`, `closed`, `reopened`, `auto-merge`, `thread` (pull requests)
 *   and `closed`, `reopened` (issues): the `sender`. GitHub lets only people
 *   with access to the repository take these actions on someone else's pull
 *   request or issue, so a sender who is not the author counts as a
 *   COLLABORATOR. A sender who is the author is judged by the author's own
 *   association, since an outside author may close or reopen their own pull
 *   request or issue and resolve threads on it. A merge by auto-merge reports
 *   whoever enabled it.
 * - `pushed`: the `sender`. A push to a head branch in the base repository
 *   needed write access, so it counts as COLLABORATOR; a push to a fork's
 *   branch counts only when the pusher is a fleet bot or the trusted author.
 * - `checks-finished` and `completed` (runs) have no human actor and carry
 *   none. Both count as caused by whoever put the code there: only head
 *   commits in the base repository produce them (GitHub lists no pull
 *   request on a check run from a fork, and a run whose head repository is a
 *   fork is dropped unless a fleet bot triggered it), and pushing there
 *   needed write access.
 *
 * An event's `actor` is the reported login when it passes the event schema.
 *
 * ## Identity
 *
 * An event id is `github.<X-GitHub-Delivery>.<kind>`, so a redelivery of the
 * same delivery repeats it and the router publishes nothing twice. The one
 * exception is `checks-finished`, identified by the head and the newest
 * check run on it (`github.checks.<sha>.<run id>`): every completion in a
 * burst that sees the same finished set names the same event, which is how
 * the burst is coalesced into one notice per subscriber.
 */

export type GithubDerivedRead =
  | {
      readonly type: 'checks-finished';
      readonly repository: string;
      readonly headSha: string;
    }
  | {
      readonly type: 'threads-resolved';
      readonly repository: string;
      readonly number: number;
    };

/** An event before validation; a derived one is completed after its read. */
export interface GithubAgentEventCandidate {
  readonly id: string;
  readonly key: string;
  readonly kind: string;
  readonly occurredAt: string;
  readonly actor?: string;
  readonly link?: string;
  readonly detail?: string;
  readonly derive?: GithubDerivedRead;
}

export interface GithubWebhookDelivery {
  readonly event: string;
  readonly deliveryId: string;
  readonly payload: unknown;
  /** When the console received it: the fallback for a missing timestamp. */
  readonly receivedAt: string;
}

const login = z.object({ login: z.string().min(1) });
const repositorySchema = z.object({
  full_name: z.string().min(1),
  html_url: z.string().min(1),
});
const senderSchema = login.nullable().optional();
const timestamp = z.string().nullable().optional();

const pullRequestSchema = z.object({
  action: z.string(),
  repository: repositorySchema,
  sender: senderSchema,
  pull_request: z.object({
    number: z.number().int().positive(),
    html_url: z.string(),
    merged: z.boolean().nullable().optional(),
    user: login.nullable().optional(),
    author_association: z.string().optional(),
    head: z.object({
      sha: z.string(),
      repo: z.object({ full_name: z.string() }).nullable().optional(),
    }),
    updated_at: timestamp,
    closed_at: timestamp,
    merged_at: timestamp,
  }),
});

const reviewSchema = z.object({
  action: z.literal('submitted'),
  repository: repositorySchema,
  review: z.object({
    state: z.string(),
    html_url: z.string().optional(),
    user: login.nullable().optional(),
    author_association: z.string().optional(),
    submitted_at: timestamp,
  }),
  pull_request: z.object({
    number: z.number().int().positive(),
    html_url: z.string(),
  }),
});

const reviewThreadSchema = z.object({
  action: z.enum(['resolved', 'unresolved']),
  repository: repositorySchema,
  sender: senderSchema,
  pull_request: z.object({
    number: z.number().int().positive(),
    html_url: z.string(),
    user: login.nullable().optional(),
    author_association: z.string().optional(),
    updated_at: timestamp,
  }),
});

const issueCommentSchema = z.object({
  action: z.literal('created'),
  repository: repositorySchema,
  issue: z.object({
    number: z.number().int().positive(),
    html_url: z.string(),
    pull_request: z.unknown().optional(),
  }),
  comment: z.object({
    html_url: z.string(),
    user: login.nullable().optional(),
    author_association: z.string().optional(),
    created_at: timestamp,
  }),
});

const issuesSchema = z.object({
  action: z.enum(['closed', 'reopened']),
  repository: repositorySchema,
  sender: senderSchema,
  issue: z.object({
    number: z.number().int().positive(),
    html_url: z.string(),
    pull_request: z.unknown().optional(),
    state_reason: z.string().nullable().optional(),
    user: login.nullable().optional(),
    author_association: z.string().optional(),
    updated_at: timestamp,
    closed_at: timestamp,
  }),
});

/** A check run lists at most a handful of pull requests; more is not a
 * shape this source supports. */
const MAX_CHECK_RUN_PULL_REQUESTS = 10;

const checkRunSchema = z.object({
  action: z.literal('completed'),
  repository: repositorySchema,
  check_run: z.object({
    head_sha: z.string().regex(/^[0-9a-f]{40}$/u),
    completed_at: timestamp,
    pull_requests: z
      .array(
        z.object({
          number: z.number().int().positive(),
          head: z.object({ sha: z.string() }),
        }),
      )
      .max(MAX_CHECK_RUN_PULL_REQUESTS),
  }),
});

const workflowRunSchema = z.object({
  action: z.literal('completed'),
  repository: repositorySchema,
  workflow_run: z.object({
    id: z.number().int().positive(),
    html_url: z.string(),
    conclusion: z.string().nullable().optional(),
    updated_at: timestamp,
    head_repository: z.object({ full_name: z.string() }).nullable().optional(),
    triggering_actor: login.nullable().optional(),
  }),
});

function sameName(a: string | undefined, b: string): boolean {
  return a !== undefined && a.toLowerCase() === b.toLowerCase();
}

/** The canonical key, or undefined for a name the key grammar refuses. */
function keyFor(
  source: 'github:pr' | 'github:issue' | 'github:run',
  id: string,
): string | undefined {
  const parsed = parseAgentEventKey(`${source}:${id}`);
  return parsed.ok ? parsed.value.key : undefined;
}

function eventId(deliveryId: string, kind: string): string {
  return `github.${deliveryId}.${kind}`;
}

/**
 * The association a `sender` acts with when GitHub reports none: an action
 * on someone else's pull request or issue needed repository access, so the
 * sender is a COLLABORATOR; on their own, the author's association applies.
 */
function senderAssociation(
  sender: string | undefined,
  author: { login?: string; association?: string },
): string | undefined {
  if (sender === undefined) return undefined;
  return sameName(author.login, sender) ? author.association : 'COLLABORATOR';
}

function trustedSender(
  sender: string | undefined,
  author: { login?: string; association?: string },
): boolean {
  return isTrustedGitHubActor({
    login: sender,
    association: senderAssociation(sender, author),
  });
}

function pullRequestEvents(
  delivery: GithubWebhookDelivery,
): GithubAgentEventCandidate[] {
  const parsed = pullRequestSchema.safeParse(delivery.payload);
  if (!parsed.success) return [];
  const { action, repository, sender, pull_request: pr } = parsed.data;
  const key = keyFor('github:pr', `${repository.full_name}#${pr.number}`);
  if (key === undefined) return [];
  const author = {
    login: pr.user?.login,
    association: pr.author_association,
  };
  const actor = sender?.login;
  const base = {
    key,
    actor,
    link: pr.html_url,
    occurredAt: pr.updated_at ?? delivery.receivedAt,
  };
  const event = (
    kind: string,
    extra: Partial<GithubAgentEventCandidate> = {},
  ): GithubAgentEventCandidate[] => [
    { ...base, id: eventId(delivery.deliveryId, kind), kind, ...extra },
  ];
  switch (action) {
    case 'closed':
      if (!trustedSender(actor, author)) return [];
      return pr.merged === true
        ? event('merged', { occurredAt: pr.merged_at ?? base.occurredAt })
        : event('closed', { occurredAt: pr.closed_at ?? base.occurredAt });
    case 'reopened':
      return trustedSender(actor, author) ? event('reopened') : [];
    case 'auto_merge_enabled':
    case 'auto_merge_disabled':
      return trustedSender(actor, author)
        ? event('auto-merge', {
            detail: action === 'auto_merge_enabled' ? 'enabled' : 'disabled',
          })
        : [];
    case 'synchronize': {
      const sameRepository = sameName(
        pr.head.repo?.full_name,
        repository.full_name,
      );
      const trusted = sameRepository
        ? isTrustedGitHubActor({ login: actor, association: 'COLLABORATOR' })
        : isTrustedGitHubActor({
            login: actor,
            association: sameName(author.login, actor ?? '')
              ? author.association
              : undefined,
          });
      if (!trusted) return [];
      return event('pushed', {
        ...(/^[0-9a-f]{7,}$/u.test(pr.head.sha)
          ? { detail: `head ${pr.head.sha.slice(0, 7)}` }
          : {}),
      });
    }
    default:
      return [];
  }
}

function reviewEvents(
  delivery: GithubWebhookDelivery,
): GithubAgentEventCandidate[] {
  const parsed = reviewSchema.safeParse(delivery.payload);
  if (!parsed.success) return [];
  const { repository, review, pull_request: pr } = parsed.data;
  const actor = review.user?.login;
  if (
    !isTrustedGitHubActor({
      login: actor,
      association: review.author_association,
    })
  )
    return [];
  const key = keyFor('github:pr', `${repository.full_name}#${pr.number}`);
  if (key === undefined) return [];
  return [
    {
      id: eventId(delivery.deliveryId, 'review'),
      key,
      kind: 'review',
      occurredAt: review.submitted_at ?? delivery.receivedAt,
      actor,
      link: review.html_url ?? pr.html_url,
      detail: review.state.toLowerCase(),
    },
  ];
}

function reviewThreadEvents(
  delivery: GithubWebhookDelivery,
): GithubAgentEventCandidate[] {
  const parsed = reviewThreadSchema.safeParse(delivery.payload);
  if (!parsed.success) return [];
  const { action, repository, sender, pull_request: pr } = parsed.data;
  const actor = sender?.login;
  if (
    !trustedSender(actor, {
      login: pr.user?.login,
      association: pr.author_association,
    })
  )
    return [];
  const key = keyFor('github:pr', `${repository.full_name}#${pr.number}`);
  if (key === undefined) return [];
  const base = {
    key,
    actor,
    link: pr.html_url,
    occurredAt: pr.updated_at ?? delivery.receivedAt,
  };
  const thread: GithubAgentEventCandidate = {
    ...base,
    id: eventId(delivery.deliveryId, 'thread'),
    kind: 'thread',
    detail: action,
  };
  if (action !== 'resolved') return [thread];
  return [
    thread,
    {
      ...base,
      id: eventId(delivery.deliveryId, 'threads-resolved'),
      kind: 'threads-resolved',
      derive: {
        type: 'threads-resolved',
        repository: repository.full_name,
        number: pr.number,
      },
    },
  ];
}

function issueCommentEvents(
  delivery: GithubWebhookDelivery,
): GithubAgentEventCandidate[] {
  const parsed = issueCommentSchema.safeParse(delivery.payload);
  if (!parsed.success) return [];
  const { repository, issue, comment } = parsed.data;
  const actor = comment.user?.login;
  if (
    !isTrustedGitHubActor({
      login: actor,
      association: comment.author_association,
    })
  )
    return [];
  const key = keyFor(
    issue.pull_request === undefined ? 'github:issue' : 'github:pr',
    `${repository.full_name}#${issue.number}`,
  );
  if (key === undefined) return [];
  return [
    {
      id: eventId(delivery.deliveryId, 'comment'),
      key,
      kind: 'comment',
      occurredAt: comment.created_at ?? delivery.receivedAt,
      actor,
      link: comment.html_url,
    },
  ];
}

function issuesEvents(
  delivery: GithubWebhookDelivery,
): GithubAgentEventCandidate[] {
  const parsed = issuesSchema.safeParse(delivery.payload);
  if (!parsed.success) return [];
  const { action, repository, sender, issue } = parsed.data;
  if (issue.pull_request !== undefined) return [];
  const actor = sender?.login;
  if (
    !trustedSender(actor, {
      login: issue.user?.login,
      association: issue.author_association,
    })
  )
    return [];
  const key = keyFor('github:issue', `${repository.full_name}#${issue.number}`);
  if (key === undefined) return [];
  return [
    {
      id: eventId(delivery.deliveryId, action),
      key,
      kind: action,
      occurredAt:
        (action === 'closed' ? issue.closed_at : issue.updated_at) ??
        delivery.receivedAt,
      actor,
      link: issue.html_url,
      ...(action === 'closed' && issue.state_reason
        ? { detail: issue.state_reason }
        : {}),
    },
  ];
}

function checkRunEvents(
  delivery: GithubWebhookDelivery,
): GithubAgentEventCandidate[] {
  const parsed = checkRunSchema.safeParse(delivery.payload);
  if (!parsed.success) return [];
  const { repository, check_run: run } = parsed.data;
  const numbers = new Set(
    run.pull_requests
      // A run on an older head says nothing about the pull request now.
      .filter((pr) => pr.head.sha === run.head_sha)
      .map((pr) => pr.number),
  );
  return [...numbers].flatMap((number) => {
    const key = keyFor('github:pr', `${repository.full_name}#${number}`);
    if (key === undefined) return [];
    return [
      {
        // Replaced by the head-and-newest-run id once the read succeeds.
        id: eventId(delivery.deliveryId, 'checks-finished'),
        key,
        kind: 'checks-finished',
        occurredAt: run.completed_at ?? delivery.receivedAt,
        link: `${repository.html_url}/pull/${number}/checks`,
        derive: {
          type: 'checks-finished',
          repository: repository.full_name,
          headSha: run.head_sha,
        },
      },
    ];
  });
}

function workflowRunEvents(
  delivery: GithubWebhookDelivery,
): GithubAgentEventCandidate[] {
  const parsed = workflowRunSchema.safeParse(delivery.payload);
  if (!parsed.success) return [];
  const { repository, workflow_run: run } = parsed.data;
  if (
    !sameName(run.head_repository?.full_name, repository.full_name) &&
    !isTrustedGitHubActor({ login: run.triggering_actor?.login })
  )
    return [];
  const key = keyFor('github:run', `${repository.full_name}/${run.id}`);
  if (key === undefined) return [];
  return [
    {
      id: eventId(delivery.deliveryId, 'completed'),
      key,
      kind: 'completed',
      occurredAt: run.updated_at ?? delivery.receivedAt,
      link: run.html_url,
      ...(run.conclusion ? { detail: run.conclusion } : {}),
    },
  ];
}

const MAPPERS: Readonly<
  Record<
    string,
    (delivery: GithubWebhookDelivery) => GithubAgentEventCandidate[]
  >
> = {
  pull_request: pullRequestEvents,
  pull_request_review: reviewEvents,
  pull_request_review_thread: reviewThreadEvents,
  issue_comment: issueCommentEvents,
  issues: issuesEvents,
  check_run: checkRunEvents,
  workflow_run: workflowRunEvents,
};

/** The webhook events this source can turn into agent events. */
export const GITHUB_AGENT_EVENT_SOURCES: ReadonlySet<string> = new Set(
  Object.keys(MAPPERS),
);

/** The events one delivery stands for, after the actor policy. */
export function githubAgentEventCandidates(
  delivery: GithubWebhookDelivery,
): GithubAgentEventCandidate[] {
  const mapper = Object.hasOwn(MAPPERS, delivery.event)
    ? MAPPERS[delivery.event]
    : undefined;
  return mapper === undefined ? [] : mapper(delivery);
}

/**
 * The validated event for a candidate. A login or link the event schema
 * refuses is left out rather than dropping the event; an event that is
 * still invalid (such as an unparseable timestamp) is undefined.
 */
export function finalizeGithubAgentEvent(
  candidate: GithubAgentEventCandidate,
): AgentEvent | undefined {
  const { derive: _derive, ...fields } = candidate;
  const { actor: _actor, ...anonymous } = fields;
  const { link: _link, ...unlinked } = fields;
  const { link: _anonymousLink, ...bare } = anonymous;
  for (const attempt of [fields, anonymous, unlinked, bare]) {
    const parsed = agentEventSchema.safeParse(attempt);
    if (parsed.success) return parsed.data;
  }
  return undefined;
}

/** Conclusions that count as a failed check; `success`, `neutral` and
 * `skipped` pass. */
const FAILED_CONCLUSIONS: ReadonlySet<string> = new Set([
  'failure',
  'timed_out',
  'cancelled',
  'action_required',
  'startup_failure',
  'stale',
]);

export interface CheckRunState {
  readonly id: number;
  /** The check's name; a re-run or a superseded workflow run reports the
   * same name again with a newer id. */
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
}

/** The newest run of each named check. GitHub lists every run on a commit,
 * including those of a workflow run that a newer one superseded and
 * cancelled, so counting them all reports failures the head no longer has. */
function latestPerCheck(runs: readonly CheckRunState[]): CheckRunState[] {
  const latest = new Map<string, CheckRunState>();
  for (const run of runs) {
    const seen = latest.get(run.name);
    if (seen === undefined || run.id > seen.id) latest.set(run.name, run);
  }
  return [...latest.values()];
}

/**
 * The `checks-finished` outcome for the latest run of each check on a head,
 * or undefined while any of them is still queued or running.
 */
export function finishedChecks(
  headSha: string,
  allRuns: readonly CheckRunState[],
): { id: string; detail: string } | undefined {
  const runs = latestPerCheck(allRuns);
  if (runs.length === 0) return undefined;
  if (runs.some((run) => run.status !== 'completed')) return undefined;
  const failed = runs.filter((run) =>
    FAILED_CONCLUSIONS.has(run.conclusion ?? ''),
  ).length;
  const newest = Math.max(...runs.map((run) => run.id));
  return {
    id: `github.checks.${headSha}.${newest}`,
    detail: failed === 0 ? 'all passed' : `${failed} failed`,
  };
}

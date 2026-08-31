/**
 * Cache tags, kept in their own dependency-free module on purpose.
 *
 * The invalidating side (`app/actions.ts`, `app/refresh-action.ts`, the e2e
 * seed route) and the caching side (`lib/dashboard-data.ts`) both need this
 * string, but the invalidators must not pull the data layer - and its
 * Octokit/Firestore transitive imports - in behind it just to name a tag.
 */

/** Durable Work/Task/Run and webhook-anchor projections rendered by Bridge,
 * Inbox, and Agents. GitHub writes invalidate this view only after their
 * corresponding webhook delivery updates the server-owned projection. */
export const AUTHORITATIVE_QUEUE_TAG = 'authoritative-queue';

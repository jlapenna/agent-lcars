/**
 * Cache tags, kept in their own dependency-free module on purpose.
 *
 * The invalidating side (`app/actions.ts`, `app/refresh-action.ts`, the e2e
 * seed route) and the caching side (`lib/dashboard-data.ts`) both need this
 * string, but the invalidators must not pull the data layer - and its
 * Octokit/Firestore transitive imports - in behind it just to name a tag.
 */

/** Everything the dashboard reads out of the GitHub API - see
 * `lib/dashboard-data.ts`. */
export const GITHUB_DATA_TAG = 'github-data';

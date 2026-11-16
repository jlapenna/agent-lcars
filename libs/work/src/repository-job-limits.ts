/**
 * Repository-job request bounds shared by the Console Work API and the `lcars`
 * CLI. They are derived from what an admitted occurrence can store, not chosen
 * independently, so a request the API accepts always fits its occurrence.
 */

/**
 * Compact-JSON bytes of an invocation's parameter map (or a manifest's fixed
 * inputs, or one profile input set). The occurrence document stores the
 * parameters next to its pinned definition and staged result inside
 * Firestore's 1 MiB document limit; this is the share left for parameters.
 */
export const REPOSITORY_JOB_PARAMETERS_MAX_BYTES = 256 * 1024;

/**
 * A job request body: the parameter map plus its small envelope
 * (repository, name, request ID, digest and profile).
 */
export const REPOSITORY_JOB_REQUEST_MAX_BYTES =
  REPOSITORY_JOB_PARAMETERS_MAX_BYTES + 16 * 1024;

/** Compact-JSON UTF-8 bytes, the measure both bounds above use. */
export function repositoryJobJsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

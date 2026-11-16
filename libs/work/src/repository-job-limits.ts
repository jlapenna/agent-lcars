/**
 * Repository-job request bounds shared by the Console Work API and the `lcars`
 * CLI. They are derived from what an admitted occurrence can store, not chosen
 * independently, so a request the API accepts always fits its occurrence.
 */

/**
 * Compact-JSON bytes of an invocation's parameter map (or a manifest's fixed
 * inputs, or one profile input set). The pinned definition and staged result
 * live outside the occurrence document, so the parameters may use half of
 * Firestore's 1 MiB document limit; the rest holds the pinned profile and the
 * occurrence's own fields.
 */
export const REPOSITORY_JOB_PARAMETERS_MAX_BYTES = 512 * 1024;

/**
 * Compact-JSON bytes of one recipe result. Results are stored out of line in
 * chunks, so Firestore does not bound them; this keeps a result, the baseline
 * copy staged with it and the next run's brief within ordinary request and
 * worker-memory sizes.
 */
export const REPOSITORY_JOB_RESULT_MAX_BYTES = 4 * 1024 * 1024;

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

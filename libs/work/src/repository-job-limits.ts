/**
 * Repository-job bounds shared by the Console Work API, the `lcars` CLI and
 * the runner. They are derived from what an admitted occurrence can store.
 * They are budgets, not a guarantee: the occurrence also embeds its profile
 * (whose input sets repeat the fixed inputs), so admission measures the whole
 * document and refuses one Firestore could not store, naming it.
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

/**
 * Compact-JSON bytes of a recipe brief: the pinned definition and its
 * file-parameter rewrite (each at most one 1 MiB document), the parameters,
 * the profile and the previous result's baseline. Workers read up to this.
 */
export const REPOSITORY_JOB_BRIEF_MAX_BYTES = 8 * 1024 * 1024;

/** Compact-JSON UTF-8 bytes, the measure the bounds above use. */
export function repositoryJobJsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

import { SessionTitleAnnotationV1 } from './session-title-annotation';
import { SessionSummary, SessionTitleSource } from './types';
import { truncateTitle } from './unknown-value';

export interface SessionTitleSelectionInput {
  declared?: unknown;
  generated?: unknown;
  inferred?: unknown;
}

export interface SessionTitleSelection {
  title: string;
  source: SessionTitleSource;
}

function normalizedTitle(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const title = truncateTitle(value);
  return title || undefined;
}

/**
 * Selects a title by intent tier, not by timestamp. `declared` wins even
 * over a `generated` value written moments ago, because `declared` is a
 * deliberate operator statement and `generated` (Claude's `aiTitle`, an
 * imported Codex thread name) is a machine label that may have been sitting
 * unrevised for the entire life of a long session — see
 * {@link SessionTitleSource} for why "most recent" is the wrong axis here.
 */
export function selectSessionTitle(
  input: SessionTitleSelectionInput,
): SessionTitleSelection | undefined {
  try {
    const declared = normalizedTitle(input.declared);
    if (declared) return { title: declared, source: 'declared' };

    const generated = normalizedTitle(input.generated);
    if (generated) return { title: generated, source: 'generated' };

    const inferred = normalizedTitle(input.inferred);
    if (inferred) return { title: inferred, source: 'inferred' };
  } catch {
    // Candidate values can come from untrusted adapter boundaries.
  }
  return undefined;
}

export interface SessionTitleOverlay {
  declared?: SessionTitleAnnotationV1;
}

/**
 * Layers locally-sourced title candidates onto a freshly-reduced session
 * summary. Pure: never mutates `summary`, never mutates `overlay`, and never
 * deletes an existing `title`/`titleSource` — the worst case is returning
 * `summary` back unchanged.
 *
 * This replaces the landed `joinSessionTitleAnnotations`, which cloned a
 * whole array of summaries, mutated the clones, and included a
 * `delete summary.title` branch reachable only if some caller re-persisted
 * the join's output as a new source of truth. No caller does or should:
 * `applySessionTitleOverlay` is always called with a *pristine* reducer
 * summary (the transcript's own title/titleSource, never a previous overlay
 * result), so removing a `declared` annotation can never require deleting
 * anything — it simply stops contributing a candidate, and selection falls
 * back to whatever the transcript itself produced. That also means there is
 * no "title was explicitly cleared" state to persist, which is what made
 * #1161's Firestore-field-deletion concern a phantom: the state it worried
 * about can't occur when the join is pure and its input is always pristine.
 *
 * Candidate derivation, the entire correctness argument:
 *  - `declared`  comes only from the overlay — the transcript itself never
 *    produces a declared title, so there is nothing on `summary` to prefer.
 *  - `generated` comes only from the summary's own generated title (such as
 *    Claude's `aiTitle`), reduced moments ago from the actual transcript.
 *  - `inferred` comes only from the summary — the overlay has no inferred
 *    tier (nothing external infers from a first prompt), so this is just
 *    "was the transcript's own title actually inferred, or something else."
 */
export function applySessionTitleOverlay(
  summary: SessionSummary,
  overlay: SessionTitleOverlay,
): SessionSummary {
  const declared = overlay.declared?.title;
  const generated =
    summary.titleSource === 'generated' ? summary.title : undefined;
  const inferred =
    summary.titleSource === 'inferred' ? summary.title : undefined;

  const selection = selectSessionTitle({ declared, generated, inferred });
  if (!selection) return summary;

  return { ...summary, title: selection.title, titleSource: selection.source };
}

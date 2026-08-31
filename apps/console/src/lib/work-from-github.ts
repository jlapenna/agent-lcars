import 'server-only';

import { WORK_PAYLOAD_MAX_BYTES } from '@agent-lcars/orchestrator';
import {
  WORK_DESCRIPTION_MAX,
  WORK_TITLE_MAX,
  type WorkOrigin,
  type WorkPayload,
  type WorkSpec,
} from '@agent-lcars/work';

/** The pipeline names `workSpecSchema` accepts. Taken from the schema rather
 *  than from `./orchestrator-ingest`'s own `Pipeline` alias: that module
 *  imports this one, and the back-reference made the pair a cycle
 *  (`pnpm lint:circular`). */
type Pipeline = WorkSpec['pipeline'];

/** `workSpecSchema.description` is `min(1)`; a GitHub issue or PR may have
 *  a null or whitespace-only body. */
const EMPTY_DESCRIPTION = '(no description)';

/**
 * `WORK_DESCRIPTION_MAX` (16,384) bounds *characters*, sized for the
 * `workflow_dispatch` input budget (65,535 chars across all inputs). It is
 * not the bound that matters for storage, though: `taskSchema.work`
 * (`@agent-lcars/orchestrator`) caps the SERIALIZED payload at
 * `WORK_PAYLOAD_MAX_BYTES` (32,768) UTF-8 bytes. A multi-byte body (CJK,
 * emoji, etc.) can pack up to 4 bytes per character, so a description well
 * under the 16,384-character bound can still blow the byte bound on its
 * own -- e.g. ~10.9k three-byte characters already reach 32,768 bytes
 * before `origin`/`title`/JSON structure are even counted. A payload that
 * clears `workPayloadSchema` (`@agent-lcars/work`, character-bounded) but
 * misses `taskSchema`'s byte bound gets written unvalidated by
 * `FirestoreStore.apply` and then permanently refused by `readTask` --
 * the drain retries that task forever and the task page 500s. This clamp
 * must therefore always check the real serialized byte length, not just
 * character count.
 *
 * `DESCRIPTION_BYTE_HEADROOM` reserves room in the byte budget for the
 * rest of the payload this description gets embedded in: `title` (up to
 * `WORK_TITLE_MAX` chars, up to 4 bytes each worst case), `origin`
 * (`principal`/`channel`, comfortably under a few hundred bytes),
 * `spec.target.repo`, and the JSON object structure itself. 2,048 bytes
 * comfortably covers all of that with margin -- with one caveat:
 * `workTargetSchema.repo` (`@agent-lcars/work`) has no `.max()`, so it is
 * unbounded in the schema itself. This accounting assumes a real GitHub
 * `owner/name` full name, which GitHub itself caps around ~140
 * characters (39-char max login + `/` + 100-char max repo name); this
 * callers either source `repo` from a real webhook delivery's
 * `repository.full_name` or from `githubDispatchAnchorSchema`, which caps it
 * at 140 characters. That keeps the byte accounting valid in practice.
 */
const DESCRIPTION_BYTE_HEADROOM = 2_048;
const DESCRIPTION_MAX_BYTES =
  WORK_PAYLOAD_MAX_BYTES - DESCRIPTION_BYTE_HEADROOM;

const textEncoder = new TextEncoder();

function byteLength(text: string): number {
  return textEncoder.encode(text).length;
}

/** Binary-searches the largest character prefix of `text` whose UTF-8
 *  encoding, plus a marker naming how much was kept, still fits within
 *  `DESCRIPTION_MAX_BYTES`. Slicing mid-surrogate-pair is safe: `TextEncoder`
 *  replaces a lone surrogate with U+FFFD (3 bytes), never throws. */
function clampToByteBudget(text: string, originalChars: number): string {
  if (byteLength(text) <= DESCRIPTION_MAX_BYTES) return text;

  const markerFor = (keptChars: number) =>
    `\n\n[work: truncated to ${keptChars} of ${originalChars} characters ` +
    `to fit the work payload's ${WORK_PAYLOAD_MAX_BYTES}-byte limit. Read ` +
    `the full body on the issue.]`;

  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const candidate = text.slice(0, mid) + markerFor(mid);
    if (byteLength(candidate) <= DESCRIPTION_MAX_BYTES) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return text.slice(0, lo) + markerFor(lo);
}

/** Mirrors `prepare.sh`'s own clamp-and-marker shape for `anchor.body`, so
 *  a task derived here and a brief later built from an unrelated overlong
 *  body degrade the same visible way -- then always re-clamps to the real
 *  byte budget `taskSchema.work` enforces (see `DESCRIPTION_MAX_BYTES`
 *  above), since a multi-byte body can miss that bound even while staying
 *  under the character-count bound below. */
export function truncatedDescription(body: string | null | undefined): string {
  // Preserve nonempty GitHub text exactly until a documented clamp is needed:
  // automation dispatch supplies the fetched anchor body directly, and a
  // whitespace change is still a change to the anchor. Only null/empty
  // GitHub bodies need normalization because Work descriptions require one
  // character.
  if (body === null || body === undefined || body.length === 0) {
    return EMPTY_DESCRIPTION;
  }
  const text = body;
  let charClamped = text;
  if (text.length > WORK_DESCRIPTION_MAX) {
    const marker =
      `\n\n[work: truncated to ${WORK_DESCRIPTION_MAX} of ${text.length} ` +
      `characters. Read the full body on the issue.]`;
    // Slice leaves room for the marker itself, so the total stays within
    // WORK_DESCRIPTION_MAX -- appending the marker after a full-length slice
    // would push the result over the bound `workPayloadSchema` enforces.
    charClamped = text.slice(0, WORK_DESCRIPTION_MAX - marker.length) + marker;
  }
  return clampToByteBudget(charClamped, text.length);
}

/** GitHub's own issue/PR title limit (256 characters) already equals
 *  `WORK_TITLE_MAX`; this clamp is defensive, not expected to ever
 *  actually shorten a real title. */
function clampedTitle(title: string): string {
  return title.length <= WORK_TITLE_MAX
    ? title
    : title.slice(0, WORK_TITLE_MAX);
}

/**
 * The `work.origin.principal` for a GitHub-derived task: `github:<login>`
 * when the webhook (or the console session) named an actor, else
 * `github:label:<label>` for a label webhook whose delivery carried no
 * `sender`, else `github:unknown`. See the design spec's "`work` for
 * every anchor" derivation table.
 */
export function githubOrigin(
  actor: string | undefined,
  label?: string,
): WorkOrigin {
  const suffix = actor ?? (label !== undefined ? `label:${label}` : 'unknown');
  return { principal: `github:${suffix}`, channel: 'github' };
}

export interface GithubWorkSource {
  title: string;
  body: string | null | undefined;
  pipeline: Pipeline;
  repo: string;
  /** The webhook `sender.login`, or the console session's github login for
   *  a retrigger. */
  actor: string | undefined;
  /** Label-webhook fallback only, used by `githubOrigin` when `actor` is
   *  absent -- irrelevant for a retrigger, which always has a session
   *  actor. */
  label?: string;
}

/**
 * Builds the `WorkPayload` a GitHub-anchored `requestRun` call attaches to
 * a task on its first request (`decide.ts`'s `baseTask` carries it forward
 * on every later request -- see the design spec's "write once" note).
 */
export function workPayloadFromGithub(source: GithubWorkSource): WorkPayload {
  return {
    origin: githubOrigin(source.actor, source.label),
    spec: {
      title: clampedTitle(source.title),
      description: truncatedDescription(source.body),
      pipeline: source.pipeline,
      target: { repo: source.repo },
    },
  };
}

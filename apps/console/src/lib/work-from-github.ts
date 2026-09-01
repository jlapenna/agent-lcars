import 'server-only';

import { WORK_PAYLOAD_MAX_BYTES } from '@agent-lcars/orchestrator';
import {
  WORK_DESCRIPTION_MAX,
  WORK_TITLE_MAX,
  type WorkOrigin,
  type WorkPayload,
  workPayloadSchema,
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
 * the drain retries that task forever and the task page 500s. This is the
 * body-only first pass; `normalizeGithubWorkPayload` below must then check
 * the actual serialized payload, including JSON escape expansion.
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

function serializedWorkPayloadBytes(payload: WorkPayload): number {
  return byteLength(JSON.stringify(payload));
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

/**
 * Normalizes one complete GitHub-derived Work payload for durable storage.
 * JSON escapes count here: a newline is one byte in GitHub's body but two
 * bytes in its serialized Work description, and control characters can
 * similarly expand to a six-byte `\\u00XX` escape. The only reliable budget
 * is therefore the full `JSON.stringify(payload)` value the store persists,
 * not the raw description's UTF-8 length.
 */
export function normalizeGithubWorkPayload(input: {
  origin: WorkOrigin;
  spec: Omit<WorkSpec, 'description'> & {
    description: string | null | undefined;
  };
}): WorkPayload {
  const original = input.spec.description;
  const description = truncatedDescription(original);
  const payload: WorkPayload = {
    origin: input.origin,
    spec: { ...input.spec, description },
  };
  if (serializedWorkPayloadBytes(payload) <= WORK_PAYLOAD_MAX_BYTES) {
    return workPayloadSchema.parse(payload);
  }

  const originalChars = original?.length ?? 0;
  const markerFor = (keptChars: number) =>
    `\n\n[work: truncated to ${keptChars} of ${originalChars} characters ` +
    `to fit the serialized work payload's ${WORK_PAYLOAD_MAX_BYTES}-byte ` +
    `limit. Read the full body on the issue.]`;
  let lo = 0;
  let hi = description.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const candidate: WorkPayload = {
      ...payload,
      spec: {
        ...payload.spec,
        description: description.slice(0, mid) + markerFor(mid),
      },
    };
    if (serializedWorkPayloadBytes(candidate) <= WORK_PAYLOAD_MAX_BYTES) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  const normalized: WorkPayload = {
    ...payload,
    spec: {
      ...payload.spec,
      description: description.slice(0, lo) + markerFor(lo),
    },
  };
  if (serializedWorkPayloadBytes(normalized) > WORK_PAYLOAD_MAX_BYTES) {
    throw new Error('GitHub Work payload metadata exceeds its storage budget');
  }
  return workPayloadSchema.parse(normalized);
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
 * from the actor GitHub included in every admitted delivery. Admission
 * refuses a malformed delivery without that identity rather than inventing
 * a label- or unknown-derived principal.
 */
export function githubOrigin(actor: string): WorkOrigin {
  return { principal: `github:${actor}`, channel: 'github' };
}

export interface GithubWorkSource {
  title: string;
  body: string | null | undefined;
  pipeline: Pipeline;
  repo: string;
  /** The webhook `sender.login`, or the console session's GitHub login for
   * a retrigger. Every admitted source has a concrete actor. */
  actor: string;
}

/**
 * Builds the `WorkPayload` a GitHub-anchored `requestRun` call attaches to
 * a task on its first request (`decide.ts`'s `baseTask` carries it forward
 * on every later request -- see the design spec's "write once" note).
 */
export function workPayloadFromGithub(source: GithubWorkSource): WorkPayload {
  return normalizeGithubWorkPayload({
    origin: githubOrigin(source.actor),
    spec: {
      title: clampedTitle(source.title),
      description: source.body,
      pipeline: source.pipeline,
      target: { repo: source.repo },
    },
  });
}

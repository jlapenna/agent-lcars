import 'server-only';

import {
  fitsWorkDescription,
  WORK_PAYLOAD_MAX_BYTES,
} from '@agent-lcars/dispatch-contracts';
import {
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
 * Adapter-derived descriptions (GitHub, Linear) have no character cap. The
 * only bound is the serialized Work payload, `WORK_PAYLOAD_MAX_BYTES`, which
 * is sized so a complete GitHub body (65,536 characters, GitHub's own limit)
 * always fits whole. A source whose text still overflows it -- a Linear
 * description longer than GitHub allows, or a body dominated by C0 control
 * characters that JSON expands to six-byte escapes -- is cut to the largest
 * prefix that fits, with a visible marker naming the kept length and
 * pointing at the source. The source tracker remains authoritative.
 *
 * The description's own budget, `WORK_DESCRIPTION_MAX_BYTES`, already
 * reserves room for the title, origin, target and JSON structure around it;
 * `normalizeWorkPayload` below then checks the actual serialized payload.
 */
const textEncoder = new TextEncoder();

function serializedWorkPayloadBytes(payload: WorkPayload): number {
  return textEncoder.encode(JSON.stringify(payload)).length;
}

/** Binary-searches the largest character prefix of `text` whose serialized
 *  form, plus a marker naming how much was kept, still fits
 *  `WORK_DESCRIPTION_MAX_BYTES`. */
function clampToByteBudget(text: string, originalChars: number): string {
  if (fitsWorkDescription(text)) return text;

  const markerFor = (keptChars: number) =>
    `\n\n[work: truncated to ${keptChars} of ${originalChars} characters ` +
    `to fit the work payload's ${WORK_PAYLOAD_MAX_BYTES}-byte limit. Read ` +
    `the full body on the issue.]`;

  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fitsWorkDescription(text.slice(0, mid) + markerFor(mid))) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return text.slice(0, lo) + markerFor(lo);
}

/** The adapter's description: the source text unchanged when the payload
 *  can hold it, which includes every complete GitHub body; only a body over
 *  the byte budget gets the marked byte clamp above. */
export function truncatedDescription(body: string | null | undefined): string {
  // Preserve nonempty source text exactly: automation dispatch supplies the
  // fetched anchor body directly, and a whitespace change is still a change
  // to the anchor. Only null/empty bodies need normalization because Work
  // descriptions require one character.
  if (body === null || body === undefined || body.length === 0) {
    return EMPTY_DESCRIPTION;
  }
  return clampToByteBudget(body, body.length);
}

/**
 * Normalizes one complete adapter-derived Work payload for durable storage.
 * JSON escapes count here: a newline is one byte in GitHub's body but two
 * bytes in its serialized Work description, and control characters can
 * similarly expand to a six-byte `\\u00XX` escape. The only reliable budget
 * is therefore the full `JSON.stringify(payload)` value the store persists,
 * not the raw description's UTF-8 length.
 */
export function normalizeWorkPayload(input: {
  origin: WorkOrigin;
  spec: Omit<WorkSpec, 'description'> & {
    description: string | null | undefined;
  };
}): WorkPayload {
  const original = input.spec.description;
  const description = truncatedDescription(original);
  const payload: WorkPayload = {
    origin: input.origin,
    spec: {
      ...input.spec,
      priority: input.spec.priority ?? 'normal',
      description,
    },
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
    throw new Error('Work payload metadata exceeds its storage budget');
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
  return normalizeWorkPayload({
    origin: githubOrigin(source.actor),
    spec: {
      title: clampedTitle(source.title),
      description: source.body,
      pipeline: source.pipeline,
      target: { repo: source.repo },
    },
  });
}

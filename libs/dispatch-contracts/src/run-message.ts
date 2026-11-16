/**
 * An agent's final message for a round -- a report's whole deliverable, a
 * parked question, a PR summary -- travels whole from the runner to the
 * Work API and back to every reader. It is never truncated for storage.
 *
 * The run document keeps only the first {@link RUN_MESSAGE_PREVIEW_MAX}
 * characters inline (`Run.result.message`) so listings stay small. A longer
 * message is stored out of line beside its run and named by
 * `Run.result.messageOverflow`; single-item reads return it whole.
 */

/** The one completion bound: UTF-8 bytes of the message a runner may send.
 * Sized well under the Console proxy's 10 MB request-body ceiling even after
 * JSON escaping, and far above any useful agent report. A message over it is
 * refused at the boundary (a report then earns its correction round); no
 * reader ever sees a silently shortened deliverable. */
export const RUN_MESSAGE_MAX_BYTES = 4 * 1024 * 1024;

/** Characters of the message kept inline in the run document. Equal to the
 * former whole-message bound, so every message that fit before is still
 * stored exactly as it was and existing runs need no migration. */
export const RUN_MESSAGE_PREVIEW_MAX = 16_384;

const encoder = new TextEncoder();

/** The UTF-8 size the completion bound is measured in. */
export function runMessageBytes(message: string): number {
  return encoder.encode(message).byteLength;
}

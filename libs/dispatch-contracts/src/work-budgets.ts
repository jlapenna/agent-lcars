/**
 * Byte budgets for Work text. Every bound here is derived from a real
 * platform limit, not a prompt-size preference; free text has no separate
 * character cap. Sizes are measured as the UTF-8 length of the value's
 * `JSON.stringify` form, which is never smaller than what Firestore stores
 * (Firestore counts raw UTF-8 bytes; JSON adds quotes and escapes).
 *
 * Firestore refuses a document over 1 MiB (1,048,576 bytes).
 */

/** A serialized Work payload (`Task.work`, a source revision's `input`, and
 * a schedule's `spec`). Both the task document (`work` plus
 * `desiredRevision.input`) and the schedule document (`spec` plus
 * `pendingTick.spec`) can hold two payloads, so two maximal payloads take at
 * most half of Firestore's 1 MiB document limit. A complete 65,536-character
 * GitHub issue or pull-request body is at most 196,610 bytes serialized
 * (three bytes per UTF-16 unit for any text without C0 control characters),
 * so GitHub's own body limit always fits with its title and origin. */
export const WORK_PAYLOAD_MAX_BYTES = 262_144;

/** A Work description: the payload budget less 8 KiB for the title, origin,
 * target and the rest of the payload around it, so any description within
 * this budget yields a storable payload. */
export const WORK_DESCRIPTION_MAX_BYTES = WORK_PAYLOAD_MAX_BYTES - 8_192;

/** One free-text run parameter: a human reply or dispatch context. The
 * direct runner exports each to the provider process environment, and a
 * resumed reply round embeds the reply in the provider CLI's prompt
 * argument. Linux refuses any single argument or environment string over
 * `MAX_ARG_STRLEN` (131,072 bytes), so this bound leaves 8 KiB for the
 * variable name and the surrounding prompt text. */
export const WORK_PARAM_TEXT_MAX_BYTES = 122_880;

/** All of a run's `params`. Two maximal free-text parameters plus 16 KiB of
 * routing metadata. The run document also holds its source revision
 * (`WORK_PAYLOAD_MAX_BYTES`), result and events; together they stay well
 * under Firestore's 1 MiB document limit. */
export const RUN_PARAMS_MAX_BYTES = 262_144;

const encoder = new TextEncoder();

/** UTF-8 length of `JSON.stringify(value)`: the unit every budget above
 * uses. */
export function serializedJsonBytes(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).length;
}

/** True when a description fits `WORK_DESCRIPTION_MAX_BYTES`. */
export function fitsWorkDescription(text: string): boolean {
  return serializedJsonBytes(text) <= WORK_DESCRIPTION_MAX_BYTES;
}

/** True when one free-text parameter fits `WORK_PARAM_TEXT_MAX_BYTES`. */
export function fitsWorkParamText(text: string): boolean {
  return serializedJsonBytes(text) <= WORK_PARAM_TEXT_MAX_BYTES;
}

export const WORK_DESCRIPTION_TOO_LARGE = `exceeds the ${WORK_DESCRIPTION_MAX_BYTES}-byte serialized description budget`;
export const WORK_PARAM_TEXT_TOO_LARGE = `exceeds the ${WORK_PARAM_TEXT_MAX_BYTES}-byte serialized text budget`;
export const WORK_PAYLOAD_TOO_LARGE = `exceeds the ${WORK_PAYLOAD_MAX_BYTES}-byte serialized Work payload budget`;

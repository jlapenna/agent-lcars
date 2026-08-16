export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

const SAFE_IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * True for a string safe to use as a Firestore document ID or a GCS
 * object-key path segment: no `/` (can't retarget a different doc/nested
 * collection, or escape the intended key prefix), no leading `.`/`-`/`_`
 * (blocks `.`/`..` collisions and Firestore's reserved `__...__` doc-ID
 * pattern), bounded length. Session/run IDs from transcript content are
 * untrusted input and must pass this before use as either.
 */
export function isSafeIdentifier(value: string): boolean {
  return SAFE_IDENTIFIER_RE.test(value);
}

export const TITLE_MAX_LENGTH = 80;

/** Collapses whitespace and truncates to `TITLE_MAX_LENGTH`, ellipsizing
 * anything longer — shared by every transcript adapter that derives a
 * session title from freeform user/agent text.
 *
 * Length is measured and cut in CODE POINTS, not UTF-16 code units. Slicing
 * the raw string can split an astral character (emoji, and most non-BMP
 * scripts) across the boundary and leave a lone surrogate behind. That
 * survives `JSON.stringify` — it escapes as `\uXXXX` and the JSON stays
 * syntactically valid — but the moment the string is encoded to UTF-8 for
 * disk or the wire it becomes U+FFFD, so the corruption lands silently at
 * persist time rather than failing anywhere a caller would notice.
 * Reproduced with 78 ASCII characters followed by U+1F600, whose UTF-8
 * round-trip was lossy before this fix.
 *
 * Code points, not grapheme clusters: a ZWJ sequence or a flag pair can
 * still be cut in half, but each half is a valid, renderable character, so
 * the result degrades visually instead of corrupting the bytes. Full
 * grapheme segmentation is not worth its cost for a display title. */
export function truncateTitle(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  const codePoints = Array.from(collapsed);
  return codePoints.length > TITLE_MAX_LENGTH
    ? `${codePoints.slice(0, TITLE_MAX_LENGTH - 1).join('')}…`
    : collapsed;
}

/** Recursively collects every string leaf out of an arbitrarily-shaped value. */
export function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    out.push(value);
    return;
  }
  const record = asRecord(value);
  if (record) {
    for (const nested of Object.values(record)) {
      collectStrings(nested, out);
    }
    return;
  }
  const array = asArray(value);
  if (array) {
    for (const nested of array) {
      collectStrings(nested, out);
    }
  }
}

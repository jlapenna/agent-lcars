/**
 * `Anchor href` guard for values that came in through an item/run/session -
 * `run.result.ref` is documented as "opaque, never interpreted" by the
 * orchestrator (`libs/orchestrator/src/model.ts`'s `runResultSchema`), so an
 * agent that reports a crafted `javascript:`/`data:` URI must not become a
 * clickable link. Returns the value unchanged only when it parses as an
 * absolute http(s) URL; everything else (a dangerous scheme, a relative
 * path, or a string that isn't a URL at all) comes back `undefined` so the
 * caller can fall back to plain text.
 */
export function safeHttpUrl(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return undefined;
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:'
    ? value
    : undefined;
}

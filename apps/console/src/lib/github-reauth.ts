/**
 * Where a GitHub re-authorization may return the browser to: a path on this
 * console only. The value arrives as a Server Action argument, so anything
 * that could leave the origin (a scheme, a protocol-relative `//host`, a
 * backslash some browsers treat as a slash) falls back to the landing page.
 */
export function safeReturnPath(returnTo: unknown): string {
  if (
    typeof returnTo !== 'string' ||
    !returnTo.startsWith('/') ||
    returnTo.startsWith('//') ||
    returnTo.includes('\\') ||
    hasControlCharacter(returnTo)
  ) {
    return '/';
  }
  return returnTo;
}

/** URL parsers strip tabs and newlines, which can turn "/\t/host" into
 * "//host"; no console path contains a control character. */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Console replies are posted as the signed-in operator (see `postComment`),
 * so GitHub's `issue_comment` webhook sees an OWNER comment, not a bot one.
 * The console itself decides whether that reply dispatches; the webhook must
 * not admit it a second time just because the text mentions `@claude` or
 * `/review`. This hidden marker is how ingest recognises a reply the console
 * already handled. Forging it only suppresses the forger's own webhook
 * trigger, so it carries no authority.
 */
export const CONSOLE_REPLY_MARKER = '<!-- agent-lcars:console-reply -->';

export function withConsoleReplyMarker(body: string): string {
  return `${body}\n\n${CONSOLE_REPLY_MARKER}`;
}

export function isConsoleReply(body: string): boolean {
  return body.includes(CONSOLE_REPLY_MARKER);
}

/** The operator's text, as typed, for a reply read back from GitHub. */
export function stripConsoleReplyMarker(body: string): string {
  return body.split(CONSOLE_REPLY_MARKER).join('').trimEnd();
}

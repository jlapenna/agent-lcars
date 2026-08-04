/** The session archive's default lookback window, split out of
 * session-archive.ts so client modules (console-header's nav rail) can
 * read it without dragging that module's Firestore/google-auth server
 * deps into the client bundle - the #59 failure mode. */
export const DEFAULT_ARCHIVE_DAYS = 14;

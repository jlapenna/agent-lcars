/** The session archive's default lookback window, split out of
 * session-archive.ts so client modules (console-header's nav rail) can
 * read it without dragging that module's Firestore/google-auth server
 * deps into the client bundle - the #59 failure mode. */
export const DEFAULT_ARCHIVE_DAYS = 14;

/** The archive's one sub-day window, `?days=1h`. */
export const ONE_HOUR_DAYS = 1 / 24;

/** `days` as the URL carries it: `1h` for the one-hour window. */
export function archiveDaysParam(days: number): string {
  return days === ONE_HOUR_DAYS ? '1h' : String(days);
}

/** The window as a short label, `1h` or `14d`: a download's filename. */
export function archiveWindowLabel(days: number): string {
  return days === ONE_HOUR_DAYS ? '1h' : `${days}d`;
}

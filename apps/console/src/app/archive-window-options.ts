/** The archive Window control's listed spans (`days`), as on /sessions and
 * /costs. */
export const ARCHIVE_WINDOW_OPTIONS: readonly {
  value: string;
  label: string;
}[] = [
  { value: '1', label: '24h' },
  { value: '7', label: '7d' },
  { value: '14', label: '14d' },
  { value: '30', label: '30d' },
  { value: '90', label: '90d' },
];

/** The listed windows, plus the current one when a URL chose another legal
 * value, so submitting other filters never silently resets it. */
export function windowOptions(days: number) {
  return ARCHIVE_WINDOW_OPTIONS.some((option) => option.value === String(days))
    ? ARCHIVE_WINDOW_OPTIONS
    : [
        ...ARCHIVE_WINDOW_OPTIONS,
        { value: String(days), label: `${days}d` },
      ].sort((a, b) => Number(a.value) - Number(b.value));
}

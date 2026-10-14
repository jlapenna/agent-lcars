import { archiveDaysParam, ONE_HOUR_DAYS } from '../lib/archive-window';

/** The archive Window control's listed spans (`days`), as on /sessions and
 * /costs: the mockup's 1h/24h/7d, then the archive's longer windows. */
export const ARCHIVE_WINDOW_OPTIONS: readonly {
  value: string;
  label: string;
}[] = [
  { value: '1h', label: '1h' },
  { value: '1', label: '24h' },
  { value: '7', label: '7d' },
  { value: '14', label: '14d' },
  { value: '30', label: '30d' },
  { value: '90', label: '90d' },
];

function optionDays(value: string): number {
  return value === '1h' ? ONE_HOUR_DAYS : Number(value);
}

/** The listed windows, plus the current one when a URL chose another legal
 * value, so submitting other filters never silently resets it. */
export function windowOptions(days: number) {
  const current = archiveDaysParam(days);
  return ARCHIVE_WINDOW_OPTIONS.some((option) => option.value === current)
    ? ARCHIVE_WINDOW_OPTIONS
    : [...ARCHIVE_WINDOW_OPTIONS, { value: current, label: `${days}d` }].sort(
        (a, b) => optionDays(a.value) - optionDays(b.value),
      );
}

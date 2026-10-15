import { describe, expect, it } from 'vitest';

import {
  ARCHIVE_WINDOW_OPTIONS,
  windowOptions,
} from './archive-window-options';

describe('windowOptions', () => {
  it("leads with the mockup's 1h and keeps it listed when chosen", () => {
    expect(ARCHIVE_WINDOW_OPTIONS[0]).toEqual({ value: '1h', label: '1h' });
    expect(windowOptions(1 / 24)).toBe(ARCHIVE_WINDOW_OPTIONS);
  });

  it('keeps the listed windows for a listed value', () => {
    expect(windowOptions(14)).toBe(ARCHIVE_WINDOW_OPTIONS);
  });

  it('adds and orders an unlisted legal window so a submit keeps it', () => {
    expect(windowOptions(2).map((option) => option.value)).toEqual([
      '1h',
      '1',
      '2',
      '7',
      '14',
      '30',
      '90',
    ]);
    expect(windowOptions(2)[2]).toEqual({ value: '2', label: '2d' });
  });
});

import { describe, expect, it } from 'vitest';

import {
  ARCHIVE_WINDOW_OPTIONS,
  windowOptions,
} from './archive-window-options';

describe('windowOptions', () => {
  it('keeps the listed windows for a listed value', () => {
    expect(windowOptions(14)).toBe(ARCHIVE_WINDOW_OPTIONS);
  });

  it('adds and orders an unlisted legal window so a submit keeps it', () => {
    expect(windowOptions(2).map((option) => option.value)).toEqual([
      '1',
      '2',
      '7',
      '14',
      '30',
      '90',
    ]);
    expect(windowOptions(2)[1]).toEqual({ value: '2', label: '2d' });
  });
});

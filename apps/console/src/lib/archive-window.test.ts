import { describe, expect, it } from 'vitest';

import {
  archiveDaysParam,
  archiveWindowLabel,
  ONE_HOUR_DAYS,
} from './archive-window';

describe('archive window labels', () => {
  it('names the one-hour window 1h in URLs and filenames', () => {
    expect(archiveDaysParam(ONE_HOUR_DAYS)).toBe('1h');
    expect(archiveWindowLabel(ONE_HOUR_DAYS)).toBe('1h');
  });

  it('names day windows by their days', () => {
    expect(archiveDaysParam(30)).toBe('30');
    expect(archiveWindowLabel(30)).toBe('30d');
  });
});

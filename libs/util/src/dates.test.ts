import { Timestamp } from 'firebase-admin/firestore';

import {
  formatDuration,
  formatLongDate,
  formatShortDate,
  getDateFromTimestamp,
} from './dates';
import {
  getDayTimestamp,
  getTimestampFromDate,
  getTimestampFromISODate,
  getTimestampFromISOLocalDate,
} from './server/dates';

describe('dates util', () => {
  const testDate = new Date('2023-01-01T12:00:00.000Z');
  const testTimestamp = Timestamp.fromDate(testDate);

  describe('getDateFromTimestamp', () => {
    it('should return a Date object from a Timestamp', () => {
      expect(getDateFromTimestamp(testTimestamp)).toEqual(testDate);
    });

    it('should return a Date object from a Date object', () => {
      expect(getDateFromTimestamp(testDate)).toEqual(testDate);
    });

    it('should return a Date object from an ISO string', () => {
      expect(getDateFromTimestamp('2023-01-01T12:00:00.000Z')).toEqual(
        testDate,
      );
    });

    it('should return undefined for undefined input', () => {
      expect(getDateFromTimestamp(undefined)).toBeUndefined();
    });
  });

  describe('formatShortDate', () => {
    it('should format a Timestamp correctly', () => {
      expect(formatShortDate(testTimestamp)).toBe('01/01/2023');
    });

    it('should format a Date correctly', () => {
      expect(formatShortDate(testDate)).toBe('01/01/2023');
    });
  });

  describe('formatLongDate', () => {
    it('should format a Timestamp correctly', () => {
      expect(formatLongDate(testTimestamp)).toBe('Sunday, January 1, 2023');
    });

    it('should be deterministic and not use locale-dependent ICU data (regression test for hydration)', () => {
      // In some environments, Intl.DateTimeFormat might use NNBSP (U+202F) or other variations.
      // date-fns formatters (which we now use) are strictly deterministic.
      const date = new Date('2023-01-01T15:00:00.000Z');
      const result = formatLongDate(date);
      expect(result).toBe('Sunday, January 1, 2023');
      // Ensure no special whitespace characters that trigger hydration mismatches
      expect(result).not.toMatch(/[\u202F\u00A0]/);
    });
  });

  describe('formatDuration', () => {
    it('should format seconds into mm:ss for < 1 hour', () => {
      expect(formatDuration(125)).toBe('02:05');
    });

    it('should format seconds into HH:mm:ss for >= 1 hour', () => {
      expect(formatDuration(3665)).toBe('01:01:05');
    });
  });

  describe('getTimestampFromDate', () => {
    it('should return a Timestamp from a Date object', () => {
      expect(getTimestampFromDate(testDate)).toEqual(testTimestamp);
    });

    it('should return undefined if input is undefined', () => {
      expect(getTimestampFromDate(undefined)).toBeUndefined();
    });
  });

  describe('getTimestampFromISODate', () => {
    it('should return a Timestamp from an ISO date string', () => {
      const isoString = '2023-01-01T12:00:00.000Z';
      expect(getTimestampFromISODate(isoString)).toEqual(testTimestamp);
    });

    it('should return undefined if input is undefined', () => {
      expect(getTimestampFromISODate(undefined)).toBeUndefined();
    });
  });

  describe('getTimestampFromISOLocalDate', () => {
    it('should return a Timestamp from a local ISO date string and timezone', () => {
      const localDate = '2023-01-01 12:00:00';
      const timezone = 'UTC';
      // 2023-01-01 12:00:00 UTC is 2023-01-01T12:00:00.000Z
      expect(getTimestampFromISOLocalDate(localDate, timezone)).toEqual(
        testTimestamp,
      );
    });

    it('should handle different timezones', () => {
      const localDate = '2023-01-01 07:00:00';
      const timezone = 'America/New_York';
      // 07:00 EST is 12:00 UTC
      expect(getTimestampFromISOLocalDate(localDate, timezone)).toEqual(
        testTimestamp,
      );
    });

    it('should return undefined if input is undefined', () => {
      expect(getTimestampFromISOLocalDate(undefined, 'UTC')).toBeUndefined();
    });
  });

  describe('getDayTimestamp', () => {
    it('should return a Timestamp for the specific day', () => {
      // Note: Month is 0-indexed in Date constructor
      const ts = getDayTimestamp(2023, 0, 1);
      const date = ts.toDate();
      expect(date.getFullYear()).toBe(2023);
      expect(date.getMonth()).toBe(0);
      expect(date.getDate()).toBe(1);
    });
  });
});

import { Timestamp } from 'firebase-admin/firestore';

import {
  getDayTimestamp,
  getTimestampFromDate,
  getTimestampFromISODate,
  getTimestampFromISOLocalDate,
} from './dates';

describe('server dates util', () => {
  const testDate = new Date('2023-01-01T12:00:00.000Z');
  const testTimestamp = Timestamp.fromDate(testDate);

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

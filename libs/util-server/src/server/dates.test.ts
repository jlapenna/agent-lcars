import { Timestamp } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';

import {
  getDateFromISOLocalDate,
  getDayDate,
  getTimestampFromDate,
  getTimestampFromISODate,
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

  describe('getDateFromISOLocalDate', () => {
    it('should return a Date from a local ISO date string and timezone', () => {
      const localDate = '2023-01-01 12:00:00';
      const timezone = 'UTC';
      // 2023-01-01 12:00:00 UTC is 2023-01-01T12:00:00.000Z
      expect(getDateFromISOLocalDate(localDate, timezone)).toEqual(testDate);
    });

    it('should handle different timezones', () => {
      const localDate = '2023-01-01 07:00:00';
      const timezone = 'America/New_York';
      // 07:00 EST is 12:00 UTC
      expect(getDateFromISOLocalDate(localDate, timezone)).toEqual(testDate);
    });

    it('should return undefined if input is undefined', () => {
      expect(getDateFromISOLocalDate(undefined, 'UTC')).toBeUndefined();
    });
  });

  describe('getDayDate', () => {
    it('should return a Date for the specific day', () => {
      // Note: Month is 0-indexed in Date constructor
      const date = getDayDate(2023, 0, 1);
      expect(date.getFullYear()).toBe(2023);
      expect(date.getMonth()).toBe(0);
      expect(date.getDate()).toBe(1);
    });
  });
});

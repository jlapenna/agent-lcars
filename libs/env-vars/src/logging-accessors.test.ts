import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  forceStructuredLogging,
  getLogLevel,
  getSlackLogLevel,
  isOnGoogleCloud,
} from './logging-accessors';

describe('logging-accessors', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.K_SERVICE;
    delete process.env.K_REVISION;
    delete process.env.CLOUD_RUN_JOB;
    delete process.env.FUNCTIONS_EMULATOR;
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  describe('isOnGoogleCloud', () => {
    it('is true when a Cloud Run marker var is present', () => {
      process.env.K_SERVICE = 'members-backend';
      expect(isOnGoogleCloud()).toBe(true);
    });

    it('is false with no marker vars set (local dev)', () => {
      expect(isOnGoogleCloud()).toBe(false);
    });

    it('is false inside the Firebase Functions emulator even if a marker is set', () => {
      process.env.K_SERVICE = 'members-backend';
      process.env.FUNCTIONS_EMULATOR = 'true';
      expect(isOnGoogleCloud()).toBe(false);
    });
  });

  describe('forceStructuredLogging', () => {
    it('reflects FORCE_STRUCTURED_LOGGING', () => {
      process.env.FORCE_STRUCTURED_LOGGING = 'true';
      expect(forceStructuredLogging()).toBe(true);
      process.env.FORCE_STRUCTURED_LOGGING = 'false';
      expect(forceStructuredLogging()).toBe(false);
    });
  });

  describe('getLogLevel / getSlackLogLevel', () => {
    it('read their respective env vars', () => {
      process.env.LOG_LEVEL = 'debug';
      process.env.SLACK_LOG_LEVEL = 'warn';
      expect(getLogLevel()).toBe('debug');
      expect(getSlackLogLevel()).toBe('warn');
    });
  });
});

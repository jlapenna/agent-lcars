import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  forceStructuredLogging,
  getLogLevel,
  isOnGoogleCloud,
} from './logging-accessors';

describe('logging-accessors', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.K_SERVICE;
    delete process.env.K_REVISION;
    delete process.env.CLOUD_RUN_JOB;
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  describe('isOnGoogleCloud', () => {
    it('is true when a Cloud Run marker var is present', () => {
      process.env.K_SERVICE = 'members-backend';
      expect(isOnGoogleCloud()).toBe(true);
    });

    it('is true when a Cloud Run revision marker var is present', () => {
      process.env.K_REVISION = 'members-backend-00001-abc';
      expect(isOnGoogleCloud()).toBe(true);
    });

    it('is true when a Cloud Run job marker var is present', () => {
      process.env.CLOUD_RUN_JOB = 'members-backend-job';
      expect(isOnGoogleCloud()).toBe(true);
    });

    it('is false with no marker vars set (local dev)', () => {
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

  describe('getLogLevel', () => {
    it('reads LOG_LEVEL', () => {
      process.env.LOG_LEVEL = 'debug';
      expect(getLogLevel()).toBe('debug');
    });
  });
});

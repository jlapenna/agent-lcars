import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  getEnvValue,
  isTrue,
  optional,
  required,
  splitEnvList,
} from './env-util';

describe('env-util', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  describe('optional', () => {
    it('returns the raw value when set', () => {
      process.env.LOG_LEVEL = 'debug';
      expect(optional('LOG_LEVEL')).toBe('debug');
    });

    it('returns undefined when unset', () => {
      delete process.env.LOG_LEVEL;
      expect(optional('LOG_LEVEL')).toBeUndefined();
    });

    it('sanitizes the literal strings "undefined"/"null" to undefined', () => {
      process.env.LOG_LEVEL = 'undefined';
      expect(optional('LOG_LEVEL')).toBeUndefined();
      process.env.LOG_LEVEL = 'null';
      expect(optional('LOG_LEVEL')).toBeUndefined();
    });
  });

  describe('required', () => {
    it('returns the value when set', () => {
      process.env.PROJECT_ID = 'demo-project';
      expect(required('PROJECT_ID')).toBe('demo-project');
    });

    it('throws when unset', () => {
      delete process.env.PROJECT_ID;
      expect(() => required('PROJECT_ID')).toThrow(
        'process.env.PROJECT_ID not defined',
      );
    });
  });

  describe('isTrue', () => {
    it('is case-insensitive', () => {
      process.env.AUTH_ENABLED = 'TRUE';
      expect(isTrue('AUTH_ENABLED')).toBe(true);
    });

    it('is false for anything other than "true"', () => {
      process.env.AUTH_ENABLED = 'yes';
      expect(isTrue('AUTH_ENABLED')).toBe(false);
      delete process.env.AUTH_ENABLED;
      expect(isTrue('AUTH_ENABLED')).toBe(false);
    });
  });

  describe('splitEnvList', () => {
    it('splits on commas and colons, trimming whitespace', () => {
      process.env.SLACK_ADMINS = ' U1, U2 :U3';
      expect(splitEnvList('SLACK_ADMINS')).toEqual(['U1', 'U2', 'U3']);
    });

    it('returns an empty array when unset', () => {
      delete process.env.SLACK_ADMINS;
      expect(splitEnvList('SLACK_ADMINS')).toEqual([]);
    });
  });

  describe('getEnvValue', () => {
    it('is an alias for optional', () => {
      process.env.LOG_LEVEL = 'warn';
      expect(getEnvValue('LOG_LEVEL')).toBe('warn');
    });
  });
});

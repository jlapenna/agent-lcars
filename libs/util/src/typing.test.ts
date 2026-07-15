import { describe, expect, it } from 'vitest';

import {
  assertDefined,
  assertType,
  isDefined,
  isString,
  stringOrUndefined,
  valueOrUndefined,
} from './typing';

describe('typing utils', () => {
  describe('assertType', () => {
    it('should return the value passed to it', () => {
      const obj = { a: 1 };
      expect(assertType(obj)).toBe(obj);
      expect(assertType(123)).toBe(123);
      expect(assertType('test')).toBe('test');
    });
  });

  describe('stringOrUndefined', () => {
    it('should return string representation if value is truthy', () => {
      expect(stringOrUndefined('hello')).toBe('hello');
      expect(stringOrUndefined(123)).toBe('123');
    });

    it('should return undefined if value is falsy', () => {
      expect(stringOrUndefined('')).toBeUndefined();
      expect(stringOrUndefined(0)).toBeUndefined();
    });
  });

  describe('valueOrUndefined', () => {
    it('should return value if truthy', () => {
      expect(valueOrUndefined('hello')).toBe('hello');
      expect(valueOrUndefined(123)).toBe(123);
    });

    it('should return undefined if value is falsy', () => {
      expect(valueOrUndefined('')).toBeUndefined();
      expect(valueOrUndefined(0)).toBeUndefined();
      expect(valueOrUndefined(null)).toBeUndefined();
      expect(valueOrUndefined(undefined)).toBeUndefined();
    });
  });

  describe('isDefined', () => {
    it('should return true for defined values', () => {
      expect(isDefined('test')).toBe(true);
      expect(isDefined(0)).toBe(true);
      expect(isDefined(false)).toBe(true);
      expect(isDefined('')).toBe(true);
    });

    it('should return false for null or undefined', () => {
      expect(isDefined(null)).toBe(false);
      expect(isDefined(undefined)).toBe(false);
    });
  });

  describe('assertDefined', () => {
    it('should return value if defined', () => {
      expect(assertDefined('test')).toBe('test');
      expect(assertDefined(0)).toBe(0);
    });

    it('should throw error if value is null or undefined', () => {
      expect(() => assertDefined(null)).toThrow('value provided was undefined');
      expect(() => assertDefined(undefined)).toThrow(
        'value provided was undefined',
      );
    });
  });

  describe('isString', () => {
    it('should return true for string primitives', () => {
      expect(isString('test')).toBe(true);
      expect(isString('')).toBe(true);
    });

    it('should return true for String objects', () => {
      expect(isString(new String('test'))).toBe(true);
    });

    it('should return false for non-strings', () => {
      expect(isString(123)).toBe(false);
      expect(isString({})).toBe(false);
      expect(isString(null)).toBe(false);
      expect(isString(undefined)).toBe(false);
    });
  });
});

import { describe, expect, it } from 'vitest';

import { stringifyWithBigInt } from './json';

describe('stringifyWithBigInt', () => {
  it('should stringify a standard object without BigInts', () => {
    const obj = { a: 1, b: 'test', c: true, d: null };
    const expected = JSON.stringify(obj, null, 2);
    expect(stringifyWithBigInt(obj)).toBe(expected);
  });

  it('should stringify an object with a BigInt value as a number', () => {
    const obj = { val: 123n };
    const expected = '{\n  "val": 123\n}';
    expect(stringifyWithBigInt(obj)).toBe(expected);
  });

  it('should handle large BigInt values without precision loss', () => {
    // This works because the implementation uses JSON.rawJSON to insert the raw string
    // representation of the BigInt, bypassing JavaScript Number precision limits.
    const obj = { val: 9007199254740993n }; // Number.MAX_SAFE_INTEGER + 2
    const expected = '{\n  "val": 9007199254740993\n}';
    expect(stringifyWithBigInt(obj)).toBe(expected);
  });

  it('should handle nested objects with BigInts', () => {
    const obj = {
      user: {
        id: 12345n,
        details: {
          score: 100n,
        },
      },
    };
    const expected =
      '{\n  "user": {\n    "id": 12345,\n    "details": {\n      "score": 100\n    }\n  }\n}';
    expect(stringifyWithBigInt(obj)).toBe(expected);
  });

  it('should handle arrays with BigInts', () => {
    const arr = [1n, 2n, 3n];
    const expected = '[\n  1,\n  2,\n  3\n]';
    expect(stringifyWithBigInt(arr)).toBe(expected);
  });

  it('should respect the space parameter (number)', () => {
    const obj = { a: 1n };
    const expected = '{\n    "a": 1\n}'; // 4 spaces
    expect(stringifyWithBigInt(obj, 4)).toBe(expected);
  });

  it('should respect the space parameter (string)', () => {
    const obj = { a: 1n };
    const expected = '{\n\t"a": 1\n}'; // tab character
    expect(stringifyWithBigInt(obj, '\t')).toBe(expected);
  });

  it('should default to 2 spaces indentation', () => {
    const obj = { a: 1n };
    const expected = '{\n  "a": 1\n}';
    expect(stringifyWithBigInt(obj)).toBe(expected);
  });

  it('should handle mixed types including BigInt', () => {
    const obj = {
      id: 1n,
      name: 'Test',
      isActive: true,
      meta: null,
      tags: ['a', 'b'],
      count: 100,
    };
    const expected =
      '{\n  "id": 1,\n  "name": "Test",\n  "isActive": true,\n  "meta": null,\n  "tags": [\n    "a",\n    "b"\n  ],\n  "count": 100\n}';
    expect(stringifyWithBigInt(obj)).toBe(expected);
  });

  it('should handle undefined values by omitting them (standard JSON behavior)', () => {
    const obj = { a: 1, b: undefined };
    const expected = '{\n  "a": 1\n}';
    expect(stringifyWithBigInt(obj)).toBe(expected);
  });

  it('should handle negative BigInts', () => {
    const obj = { val: -123n };
    const expected = '{\n  "val": -123\n}';
    expect(stringifyWithBigInt(obj)).toBe(expected);
  });
});

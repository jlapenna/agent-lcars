import { expect, test } from '@jest/globals';

import { toURLSearchParams } from './http';

test('toURLSearchParams', () => {
  const actual = toURLSearchParams({
    SomeKey: 'Some Value',
    SomeColonKey: 'Some:Value',
  });

  expect(actual.get('SomeKey')).toBe('Some Value');
  expect(actual.get('SomeKeyUndefined')).toBeNull();
  expect(actual.toString()).toContain('SomeKey=Some+Value');
  expect(actual.toString()).toContain('SomeColonKey=Some%3AValue');
});

test('toURLSearchParams with falsy values', () => {
  const actual = toURLSearchParams({
    Zero: 0,
    False: false,
    Empty: '',
    Null: null,
    Undefined: undefined,
  });

  expect(actual.get('Zero')).toBe('0');
  expect(actual.get('False')).toBe('false');
  expect(actual.get('Empty')).toBe('');
  expect(actual.get('Null')).toBeNull();
  expect(actual.get('Undefined')).toBeNull();
});

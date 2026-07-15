import { describe, expect, it } from 'vitest';

import { pick } from './objects';

describe('pick', () => {
  it('should pick properties from an object', () => {
    const object = { a: 1, b: '2', c: 3 };
    const result = pick(object, ['a', 'c']);
    expect(result).toEqual({ a: 1, c: 3 });
  });

  it('should return an empty object if no keys are provided', () => {
    const object = { a: 1, b: '2', c: 3 };
    const result = pick(object, []);
    expect(result).toEqual({});
  });

  it('should ignore properties that are not present in the object (if type allows)', () => {
    const object = { a: 1, b: '2', c: 3 } as {
      a: number;
      b: string;
      c: number;
      d?: number;
    };
    const result = pick(object, ['a', 'd']);
    expect(result).toEqual({ a: 1 });
  });

  it('should work with different types', () => {
    const object = { name: 'Test', id: 123, active: true };
    const result = pick(object, ['name', 'active']);
    expect(result).toEqual({ name: 'Test', active: true });
  });
});

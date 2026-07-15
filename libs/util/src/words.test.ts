import { describe, expect, it } from 'vitest';

import { cleanSlackLink, getNumberWithOrdinal } from './words';

describe('getNumberWithOrdinal', () => {
  it('podiums', () => {
    expect(getNumberWithOrdinal(1)).toBe('1st');
    expect(getNumberWithOrdinal('2')).toBe('2nd');
    expect(getNumberWithOrdinal(3)).toBe('3rd');
    expect(getNumberWithOrdinal('4')).toBe('4th');
    expect(getNumberWithOrdinal(5)).toBe('5th');
  });
});

describe('cleanSlackLink', () => {
  it('cleans formatted links', () => {
    expect(
      cleanSlackLink(
        '<https://members.supersprinkles.racing/profile/U09R97CJQTU|Charlie Pravel>',
      ),
    ).toBe('Charlie Pravel');
    expect(cleanSlackLink('<http://example.com|Example>')).toBe('Example');
  });

  it('leaves regular strings alone', () => {
    expect(cleanSlackLink('Charlie Pravel')).toBe('Charlie Pravel');
    expect(cleanSlackLink('Raw String')).toBe('Raw String');
  });
});

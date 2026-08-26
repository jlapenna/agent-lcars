import { describe, expect, it } from 'vitest';

import { safeHttpUrl } from './safe-url';

describe('safeHttpUrl', () => {
  it('allows an https URL', () => {
    expect(safeHttpUrl('https://github.com/o/r/pull/1')).toBe(
      'https://github.com/o/r/pull/1',
    );
  });

  it('rejects a javascript: URI', () => {
    expect(safeHttpUrl('javascript:alert(1)')).toBeUndefined();
  });

  it('rejects a data: URI', () => {
    expect(
      safeHttpUrl('data:text/html,<script>alert(1)</script>'),
    ).toBeUndefined();
  });

  it('rejects a string that is not a URL', () => {
    expect(safeHttpUrl('not a url')).toBeUndefined();
  });

  it('passes through undefined', () => {
    expect(safeHttpUrl(undefined)).toBeUndefined();
  });
});

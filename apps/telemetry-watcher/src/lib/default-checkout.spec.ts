import { afterEach, describe, expect, it } from 'vitest';

import { isAllowedProjectDir } from './allowlist';
import { checkoutRoots, checkoutSlugGlobs } from './default-checkout';

const ROOTS_VAR = 'AGENT_TELEMETRY_CHECKOUT_ROOTS';
const LEGACY_VAR = 'AGENT_TELEMETRY_CHECKOUT_ROOT';

afterEach(() => {
  delete process.env[ROOTS_VAR];
  delete process.env[LEGACY_VAR];
});

describe('checkout roots', () => {
  it('reads and normalizes multiple explicit roots', () => {
    process.env[ROOTS_VAR] = '/srv/checkouts/thing/, /srv/checkouts/another//';

    expect(checkoutRoots()).toEqual([
      '/srv/checkouts/thing',
      '/srv/checkouts/another',
    ]);
    expect(checkoutSlugGlobs()).toEqual([
      '-srv-checkouts-thing*',
      '-srv-checkouts-another*',
    ]);
  });

  it('keeps the legacy single-root variable compatible', () => {
    process.env[LEGACY_VAR] = '/srv/checkouts/legacy';

    expect(checkoutRoots()).toEqual(['/srv/checkouts/legacy']);
  });

  it('deduplicates roots after normalization', () => {
    process.env[ROOTS_VAR] = '/srv/checkouts/thing,/srv/checkouts/thing/';

    expect(checkoutRoots()).toEqual(['/srv/checkouts/thing']);
  });

  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['whitespace', '   '],
  ])('fails closed when the plural variable is %s', (_label, value) => {
    if (value !== undefined) process.env[ROOTS_VAR] = value;

    expect(() => checkoutRoots()).toThrow(/must explicitly name/);
  });

  it.each([
    ['root alone', '/'],
    ['root with extra separators', '///'],
    ['relative path', 'checkouts/thing'],
  ])('rejects %s instead of widening scope', (_label, value) => {
    process.env[ROOTS_VAR] = value;

    expect(() => checkoutRoots()).toThrow(/absolute checkout paths/);
  });

  it('rejects an empty entry in a root list', () => {
    process.env[ROOTS_VAR] = '/srv/checkouts/thing,,/srv/checkouts/another';

    expect(() => checkoutRoots()).toThrow(/empty checkout path/);
  });

  it('admits only configured checkout slugs', () => {
    process.env[ROOTS_VAR] =
      '/srv/checkouts/sprinkles,/srv/checkouts/agent-lcars';

    expect(isAllowedProjectDir('-srv-checkouts-sprinkles')).toBe(true);
    expect(
      isAllowedProjectDir(
        '-srv-checkouts-agent-lcars-claude-worktrees-feature',
      ),
    ).toBe(true);
    expect(isAllowedProjectDir('-srv/checkouts/private')).toBe(false);
  });

  it('re-reads the environment per call rather than freezing at import', () => {
    process.env[ROOTS_VAR] = '/srv/checkouts/one';
    expect(checkoutRoots()).toEqual(['/srv/checkouts/one']);
    process.env[ROOTS_VAR] = '/srv/checkouts/two';
    expect(checkoutRoots()).toEqual(['/srv/checkouts/two']);
  });
});

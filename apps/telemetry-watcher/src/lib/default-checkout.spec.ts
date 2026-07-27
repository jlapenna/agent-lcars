import { afterEach, describe, expect, it } from 'vitest';

import { isAllowedProjectDir } from './allowlist';
import { checkoutRoot, checkoutSlugGlob } from './default-checkout';

const VAR = 'AGENT_TELEMETRY_CHECKOUT_ROOT';

afterEach(() => {
  delete process.env[VAR];
});

describe('checkout root', () => {
  it('reads the root from the environment', () => {
    process.env[VAR] = '/srv/checkouts/thing';
    expect(checkoutRoot()).toBe('/srv/checkouts/thing');
    expect(checkoutSlugGlob()).toBe('-srv-checkouts-thing*');
  });

  it('falls back to this deployment when unset', () => {
    expect(checkoutRoot()).toBe('/home/jlapenna/p/sprinkles');
    expect(checkoutSlugGlob()).toBe('-home-jlapenna-p-sprinkles*');
  });

  // The regression this replaced: the fallback still named `members` after
  // the repo was renamed to `sprinkles`. Because the allowlist is an
  // exact-prefix glob, the live checkout's project dir never matched, so a
  // watcher on the default silently recorded nothing from the repo it
  // exists to watch.
  it('admits the live checkout, which the pre-rename default excluded', () => {
    expect(isAllowedProjectDir('-home-jlapenna-p-sprinkles')).toBe(true);
    expect(
      isAllowedProjectDir('-home-jlapenna-p-sprinkles-claude-worktrees-x'),
    ).toBe(true);
    // The stale root is not a prefix of the live one in either direction,
    // which is exactly why the rename was silent rather than degraded.
    expect(isAllowedProjectDir('-home-jlapenna-p-members')).toBe(false);
  });

  it('re-reads the environment per call rather than freezing at import', () => {
    expect(checkoutRoot()).toBe('/home/jlapenna/p/sprinkles');
    process.env[VAR] = '/tmp/other';
    expect(checkoutRoot()).toBe('/tmp/other');
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isAllowedProjectDir } from './allowlist';

describe('isAllowedProjectDir', () => {
  const previousRoots = process.env['AGENT_TELEMETRY_CHECKOUT_ROOTS'];

  beforeEach(() => {
    process.env['AGENT_TELEMETRY_CHECKOUT_ROOTS'] =
      '/srv/checkouts/sprinkles,/srv/checkouts/agent-lcars';
  });

  afterEach(() => {
    if (previousRoots === undefined) {
      delete process.env['AGENT_TELEMETRY_CHECKOUT_ROOTS'];
    } else {
      process.env['AGENT_TELEMETRY_CHECKOUT_ROOTS'] = previousRoots;
    }
  });

  it('allows the primary checkout slug', () => {
    expect(isAllowedProjectDir('-srv-checkouts-sprinkles')).toBe(true);
  });

  it('allows worktree slugs nested under the primary checkout', () => {
    expect(
      isAllowedProjectDir(
        '-srv-checkouts-sprinkles-claude-worktrees-agent-lcars-telemetry-watcher',
      ),
    ).toBe(true);
  });

  it('allows every explicitly configured checkout', () => {
    expect(isAllowedProjectDir('-srv-checkouts-agent-lcars')).toBe(true);
  });

  it('rejects unrelated project slugs', () => {
    expect(isAllowedProjectDir('-srv-checkouts-homelab')).toBe(false);
    expect(isAllowedProjectDir('-home-developer-p-sprinkles')).toBe(false);
  });

  it('respects a custom allowlist', () => {
    expect(
      isAllowedProjectDir('-home-alice-p-members', ['-home-alice-*']),
    ).toBe(true);
    expect(isAllowedProjectDir('-home-bob-p-members', ['-home-alice-*'])).toBe(
      false,
    );
  });
});

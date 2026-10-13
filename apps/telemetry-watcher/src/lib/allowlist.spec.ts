import { describe, expect, it } from 'vitest';

import { isAllowedProjectDir } from './allowlist';

describe('isAllowedProjectDir', () => {
  it('matches every project dir under the runner-mode wildcard', () => {
    expect(isAllowedProjectDir('-home-runner-work-repo', ['*'])).toBe(true);
  });

  it('matches worktree slugs nested under an allowed prefix', () => {
    expect(
      isAllowedProjectDir(
        '-srv-checkouts-sprinkles-claude-worktrees-agent-lcars-telemetry-watcher',
        ['-srv-checkouts-sprinkles*'],
      ),
    ).toBe(true);
  });

  it('respects a custom allowlist', () => {
    expect(
      isAllowedProjectDir('-home-alice-p-members', ['-home-alice-*']),
    ).toBe(true);
    expect(isAllowedProjectDir('-home-bob-p-members', ['-home-alice-*'])).toBe(
      false,
    );
  });

  it('treats glob-special characters other than * literally', () => {
    expect(isAllowedProjectDir('-home-a.b', ['-home-a.b'])).toBe(true);
    expect(isAllowedProjectDir('-home-aXb', ['-home-a.b'])).toBe(false);
  });

  it('matches nothing with an empty allowlist', () => {
    expect(isAllowedProjectDir('-home-runner-work-repo', [])).toBe(false);
  });
});

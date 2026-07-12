import { isAllowedProjectDir } from './allowlist';

describe('isAllowedProjectDir', () => {
  it('allows the primary checkout slug', () => {
    expect(isAllowedProjectDir('-home-jlapenna-p-members')).toBe(true);
  });

  it('allows worktree slugs nested under the primary checkout', () => {
    expect(
      isAllowedProjectDir(
        '-home-jlapenna-p-members-claude-worktrees-agent-telemetry-watcher',
      ),
    ).toBe(true);
  });

  it('rejects unrelated project slugs', () => {
    expect(isAllowedProjectDir('-home-jlapenna-p-homelab')).toBe(false);
    expect(isAllowedProjectDir('-home-someone-else-p-members')).toBe(false);
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

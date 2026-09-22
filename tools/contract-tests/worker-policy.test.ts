import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import policy from '../../packages/fleet-tools/bin/worker-policy.cjs';

const brief = {
  repository: 'octo/example',
  mode: 'implement',
  anchor: { type: 'issue', number: 42 },
};
const identity = {
  provider: 'codex',
  runId: 'octo/example#42/r1',
  attemptId: 'g1:octo/example#42/r1',
};
const context = policy.prepareContext(brief, identity);
const shell = (command: string) => ({
  tool_name: 'Bash',
  tool_input: { command },
  cwd: '/tmp/worker',
});
const dependencies = () => ({
  readRepository: vi.fn(() => 'octo/example'),
  assertWorktree: vi.fn(),
  readOwnership: vi.fn(() => ({
    state: 'open',
    assignees: [{ login: process.env.AGENT_FLEET_LOGIN || 'agent-lcars-bot' }],
  })),
});
const verdict = (input: unknown, ctx = context, deps = dependencies()) =>
  policy.evaluate(input, ctx, deps).hookSpecificOutput.permissionDecision;

describe('dispatched worker policy', () => {
  it('preserves closed-anchor reply dispatches without permitting code changes', () => {
    const deps = dependencies();
    deps.readOwnership.mockReturnValue({
      state: 'closed',
      assignees: [
        { login: process.env.AGENT_FLEET_LOGIN || 'agent-lcars-bot' },
      ],
    });
    const reply = { ...context, mode: 'reply' };
    expect(
      verdict(
        shell(
          'gh issue comment 42 --body "Reply to the requested clarification"',
        ),
        reply,
        deps,
      ),
    ).toBe('allow');
    expect(verdict(shell('git commit -m change'), reply, deps)).toBe('deny');
  });
  it.each([
    { ...identity, attemptId: 'g2:octo/example#42/r1' },
    { ...identity, runId: 'octo/example#43/r1' },
    { ...identity, provider: 'unknown' },
    {
      ...identity,
      runId: 'octo/example#42/r9007199254740992',
      attemptId: 'g9007199254740992:octo/example#42/r9007199254740992',
    },
  ])('rejects unbound setup identity', (invalid) => {
    expect(() => policy.prepareContext(brief, invalid)).toThrow();
  });
  it('binds native Work without inventing a GitHub anchor', () => {
    const work = policy.prepareContext(
      { ...brief, anchor: { type: 'work', id: 'item' } },
      { ...identity, runId: 'work:item/r2', attemptId: 'g2:work:item/r2' },
    );
    const deps = dependencies();
    expect(verdict(shell('git commit -m done'), work, deps)).toBe('allow');
    expect(deps.readOwnership).not.toHaveBeenCalled();
    expect(deps.assertWorktree).toHaveBeenCalled();
  });
  it('does not query ownership or check worktrees for ordinary reads', () => {
    const deps = dependencies();
    expect(
      verdict(shell('rg needle src && gh issue view 42'), context, deps),
    ).toBe('allow');
    expect(deps.readOwnership).not.toHaveBeenCalled();
    expect(deps.assertWorktree).not.toHaveBeenCalled();
  });
  it.each([
    'git push origin HEAD',
    'git commit -m change',
    'gh pr create --body change',
  ])('rejects review-mode writes: %s', (command) => {
    expect(verdict(shell(command), { ...context, mode: 'review' })).toBe(
      'deny',
    );
  });
  it('rejects edits in review mode while allowing review submission', () => {
    expect(
      verdict(
        { tool_name: 'Edit', tool_input: { file_path: 'src/file.ts' } },
        { ...context, mode: 'review' },
      ),
    ).toBe('deny');
    expect(
      verdict(shell('gh pr review 42 --approve --body reviewed'), {
        ...context,
        mode: 'review',
      }),
    ).toBe('allow');
  });
  it('rechecks ownership after a previously authorized action', () => {
    const deps = dependencies();
    expect(verdict(shell('git add file'), context, deps)).toBe('allow');
    deps.readOwnership.mockReturnValue({ state: 'closed', assignees: [] });
    expect(verdict(shell('git push origin HEAD'), context, deps)).toBe('deny');
    expect(deps.readOwnership).toHaveBeenCalledTimes(2);
  });
  it('rejects unreadable ownership and failed worktree protection', () => {
    const deps = dependencies();
    deps.readOwnership.mockImplementation(() => {
      throw new Error('offline');
    });
    expect(verdict(shell('git push'), context, deps)).toBe('deny');
    deps.assertWorktree.mockImplementation(() => {
      throw new Error('primary');
    });
    expect(
      verdict(
        {
          tool_name: 'Write',
          cwd: '/repo',
          tool_input: { file_path: 'src/new.ts' },
        },
        context,
        deps,
      ),
    ).toBe('deny');
    expect(deps.assertWorktree).toHaveBeenLastCalledWith('/repo/src');
  });
  it.each(['git commit --no-verify', 'git push --force', 'git push -f'])(
    'rejects unsafe Git arguments: %s',
    (command) => {
      expect(verdict(shell(command))).toBe('deny');
    },
  );
  it('resolves supported literal command directories', () => {
    const deps = dependencies();
    expect(
      verdict(
        shell('cd "feature tree" && git -C src commit -m "a \\q"'),
        context,
        deps,
      ),
    ).toBe('allow');
    expect(deps.assertWorktree).toHaveBeenCalledWith(
      '/tmp/worker/feature tree/src',
    );
    expect(policy.literalCommands('echo "a \\q"')).toEqual([['echo', 'a \\q']]);
  });
  it.each(['git $verb', 'git push | tee log', 'git add *', 'sh -c "git push"'])(
    'does not claim unsupported shell interception: %s',
    (command) => {
      expect(policy.operations(shell(command))).toEqual([]);
    },
  );
  it('stays silent outside an explicit dispatch without opening context', () => {
    const result = spawnSync(
      process.execPath,
      [resolve('packages/fleet-tools/bin/worker-policy.cjs')],
      {
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          CI: 'true',
          CODEX_THREAD_ID: 'interactive',
        },
        input: 'not JSON',
      },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });
});

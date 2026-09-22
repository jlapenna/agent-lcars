import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

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
  it.each(['patchText', 'patch', 'input', 'command', 'raw'])(
    'checks every patch target, including move destinations (%s)',
    (field) => {
      const patch =
        '*** Begin Patch\n*** Add File: src/new.ts\n+new\n*** Update File: src/old.ts\n*** Move to: ../primary/moved.ts\n@@\n-old\n+new\n*** Delete File: ../primary/deleted.ts\n*** End Patch';
      const deps = dependencies();
      const input = {
        tool_name: 'apply_patch',
        cwd: '/task/feature',
        tool_input: field === 'raw' ? patch : { [field]: patch },
      };
      expect(verdict(input, context, deps)).toBe('allow');
      expect(
        deps.assertWorktree.mock.calls.map(([directory]) => directory),
      ).toEqual(['/task/feature/src', '/task/primary']);
      deps.assertWorktree.mockImplementation((directory?: string) => {
        if (directory === '/task/primary') throw new Error('primary');
      });
      expect(verdict(input, context, deps)).toBe('deny');
      expect(verdict(input, { ...context, mode: 'review' })).toBe('deny');
    },
  );
  it.each([
    '',
    'not a patch',
    '*** Begin Patch\n*** End Patch',
    '*** Begin Patch\n*** Move to: other\n*** End Patch',
    '*** Begin Patch\n*** Add File: \n*** End Patch',
  ])('rejects unresolved patch targets: %s', (patchText) => {
    const deps = dependencies();
    expect(
      verdict(
        { tool_name: 'apply_patch', tool_input: { patchText } },
        context,
        deps,
      ),
    ).toBe('deny');
    expect(deps.readOwnership).not.toHaveBeenCalled();
  });
  it('checks every explicit file in a multi-edit and rejects missing targets', () => {
    const deps = dependencies();
    const input = {
      tool_name: 'multiedit',
      cwd: '/task/feature',
      tool_input: {
        edits: [
          { filePath: 'src/first.ts' },
          { filePath: '../primary/second.ts' },
        ],
      },
    };
    expect(verdict(input, context, deps)).toBe('allow');
    expect(
      deps.assertWorktree.mock.calls.map(([directory]) => directory),
    ).toEqual(['/task/feature/src', '/task/primary']);
    expect(verdict({ tool_name: 'Write', tool_input: {} })).toBe('deny');
  });
  it('checks actual file and ancestor symlink destinations, including patch moves', () => {
    const root = mkdtempSync(join(tmpdir(), 'lcars-edit-paths-'));
    try {
      const feature = join(root, 'feature'),
        primary = join(root, 'primary');
      mkdirSync(feature);
      mkdirSync(primary);
      writeFileSync(join(primary, 'existing.ts'), 'untouched');
      symlinkSync(join(primary, 'existing.ts'), join(feature, 'linked.ts'));
      symlinkSync(primary, join(feature, 'linked-dir'));
      const deps = dependencies();
      deps.assertWorktree.mockImplementation((directory?: string) => {
        if (directory?.startsWith(primary)) throw new Error('primary');
      });
      for (const filePath of ['linked.ts', 'linked-dir/new/nested.ts']) {
        expect(
          verdict(
            { tool_name: 'Write', cwd: feature, tool_input: { filePath } },
            context,
            deps,
          ),
        ).toBe('deny');
        expect(
          verdict(
            {
              tool_name: 'apply_patch',
              cwd: feature,
              tool_input: {
                patchText: `*** Begin Patch\n*** Add File: ${filePath}\n+test\n*** End Patch`,
              },
            },
            context,
            deps,
          ),
        ).toBe('deny');
      }
      symlinkSync(join(primary, 'missing'), join(feature, 'dangling'));
      expect(
        verdict(
          {
            tool_name: 'Write',
            cwd: feature,
            tool_input: { filePath: 'dangling' },
          },
          context,
          deps,
        ),
      ).toBe('deny');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('permits only the exact setup-bound native terminal record outside a code worktree', () => {
    const native = policy.prepareContext(
      {
        repository: 'octo/example',
        mode: 'reply',
        anchor: { type: 'work', id: 'item' },
      },
      {
        provider: 'claude',
        runId: 'work:item/r1',
        attemptId: 'g1:work:item/r1',
        nativeOutcomePath: '/tmp/lcars-policy-fixture-outcome',
      },
    );
    const input = {
      tool_name: 'Write',
      tool_input: {
        file_path: native.nativeOutcomePath,
        content:
          '<!-- agent-result:v1:no-op:g1:work:item/r1 -->\n<!-- attempt-claim:g1:work:item/r1 -->\n',
      },
    };
    const deps = dependencies();
    deps.assertWorktree.mockImplementation(() => {
      throw new Error('not a code worktree');
    });
    expect(verdict(input, native, deps)).toBe('allow');
    expect(
      verdict(
        {
          ...input,
          tool_input: { ...input.tool_input, content: 'unbound result' },
        },
        native,
        deps,
      ),
    ).toBe('deny');
    expect(deps.assertWorktree).not.toHaveBeenCalled();
  });
  it('limits native patch result exceptions to one exact result and safe destination', () => {
    const root = mkdtempSync(join(tmpdir(), 'worker-result-patch-'));
    const outcome = join(root, 'outcome');
    const native = policy.prepareContext(
      {
        repository: 'octo/example',
        mode: 'reply',
        anchor: { type: 'work', id: 'item' },
      },
      {
        provider: 'codex',
        runId: 'work:item/r1',
        attemptId: 'g1:work:item/r1',
        nativeOutcomePath: outcome,
      },
    );
    const deps = dependencies();
    deps.assertWorktree.mockImplementation(() => {
      throw new Error('not a code worktree');
    });
    const record = (kind: string) =>
      `+<!-- agent-result:v1:${kind}:${native.attemptId} -->\n+<!-- attempt-claim:${native.attemptId} -->`;
    const patch = (body: string) => ({
      tool_name: 'apply_patch',
      cwd: root,
      tool_input: { command: `*** Begin Patch\n${body}\n*** End Patch` },
    });
    try {
      for (const kind of ['park', 'no-op']) {
        expect(
          verdict(
            patch(`*** Add File: outcome\n${record(kind)}`),
            native,
            deps,
          ),
        ).toBe('allow');
      }
      expect(deps.assertWorktree).not.toHaveBeenCalled();
      for (const body of [
        `*** Add File: outcome\n${record('no-op')}\n*** Add File: extra\n+unrelated`,
        `*** Add File: outcome\n${record('no-op').replaceAll(native.attemptId, 'foreign')}`,
        `*** Add File: outcome\n${record('no-op')}\n+extra`,
        `*** Update File: outcome\n@@\n${record('no-op')}`,
        '*** Delete File: outcome',
        `*** Add File: extra\n${record('no-op')}`,
      ])
        expect(verdict(patch(body), native, deps)).toBe('deny');
      const valid = patch(`*** Add File: outcome\n${record('no-op')}`);
      writeFileSync(join(root, 'other'), 'preserve');
      symlinkSync(join(root, 'other'), outcome);
      expect(verdict(valid, native, deps)).toBe('deny');
      rmSync(outcome);
      mkdirSync(outcome);
      expect(verdict(valid, native, deps)).toBe('deny');
      const missing = {
        ...native,
        nativeOutcomePath: join(root, 'missing', 'outcome'),
      };
      expect(
        verdict(
          patch(
            `*** Add File: ${missing.nativeOutcomePath}\n${record('no-op')}`,
          ),
          missing,
          deps,
        ),
      ).toBe('deny');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
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

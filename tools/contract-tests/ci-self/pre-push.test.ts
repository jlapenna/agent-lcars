import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, it } from 'vitest';

it('forwards LFS refs and checks dependencies only after dependency inputs change', () => {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'lcars-push-'));
  const hook = readFileSync('.husky/pre-push', 'utf8');
  const refs = 'refs/heads/topic 1234 refs/heads/topic 5678\n';
  const run = (command: string, args: string[], input?: string) => {
    const result = spawnSync(command, args, {
      cwd: repo,
      env: { ...process.env, PATH: `${repo}/bin:${process.env['PATH']}` },
      input,
      encoding: 'utf8',
    });
    if (result.status !== 0) throw new Error(result.stderr);
  };
  const script = (file: string, contents: string) =>
    writeFileSync(path.join(repo, file), `#!/bin/sh\n${contents}\n`, {
      mode: 0o755,
    });
  try {
    mkdirSync(path.join(repo, 'bin'));
    mkdirSync(path.join(repo, 'tools'));
    mkdirSync(path.join(repo, 'apps/demo'), { recursive: true });
    writeFileSync(path.join(repo, 'hook'), hook);
    script('bin/git-lfs', 'printf "%s\\n" "$@" > lfs-args; cat > lfs-refs');
    script('bin/repo-require-worktree', 'cat > guard-refs');
    script('tools/check-dependencies.sh', 'echo checked >> dependencies');
    script('tools/nx', 'exit 0');
    script('tools/console-build-smoke.sh', 'exit 0');
    run('git', ['init', '--initial-branch=main']);
    run('git', ['config', 'user.email', 'test@example.com']);
    run('git', ['config', 'user.name', 'Test']);
    writeFileSync(path.join(repo, 'package.json'), '{}\n');
    writeFileSync(path.join(repo, 'apps/demo/package.json'), '{}\n');
    writeFileSync(path.join(repo, 'code.ts'), 'base\n');
    run('git', ['add', '.']);
    run('git', ['commit', '-m', 'fixture']);
    run('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    writeFileSync(path.join(repo, 'code.ts'), 'code change\n');
    writeFileSync(path.join(repo, 'dependencies'), '');
    run('bash', ['hook', 'origin', 'fixture-remote'], refs);
    expect(readFileSync(path.join(repo, 'dependencies'), 'utf8')).toBe('');
    expect(readFileSync(path.join(repo, 'lfs-args'), 'utf8')).toBe(
      'pre-push\norigin\nfixture-remote\n',
    );
    expect(readFileSync(path.join(repo, 'lfs-refs'), 'utf8')).toBe(refs);
    expect(readFileSync(path.join(repo, 'guard-refs'), 'utf8')).toBe(refs);
    writeFileSync(
      path.join(repo, 'apps/demo/package.json'),
      '{"changed":true}\n',
    );
    run('bash', ['hook', 'origin', 'fixture-remote'], refs);
    expect(readFileSync(path.join(repo, 'dependencies'), 'utf8')).toBe(
      'checked\n',
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}, 15_000);

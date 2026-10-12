import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, it } from 'vitest';

const repo = path.resolve(import.meta.dirname, '../..');

// #2491: exercise the shipped hook, lint-staged's partial-file hiding, real Nx
// graph creation and the actual module-boundary rule. No mocked graph or lint.
it(
  'commits newly buildable dependencies but rejects a staged non-buildable dependency',
  { timeout: 120_000 },
  () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcars-staged-graph-'));
    const primary = path.join(temp, 'primary');
    const worktree = path.join(temp, 'author');
    const env = {
      PATH: `${repo}/node_modules/.bin:${process.env['PATH']}`,
      HOME: process.env['HOME'] ?? os.homedir(),
      NX_DAEMON: 'false',
      NX_TUI: 'false',
      NX_PLUGIN_NO_TIMEOUTS: 'false',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
    };
    function run(cwd: string, command: string, args: string[]) {
      const result = spawnSync(command, args, {
        cwd,
        env,
        encoding: 'utf8',
        timeout: 30_000,
      });
      if (result.error) throw result.error;
      return {
        status: result.status,
        output: `${result.stdout}${result.stderr}`,
      };
    }
    function git(cwd: string, ...args: string[]) {
      const result = run(cwd, 'git', args);
      if (result.status !== 0) {
        throw new Error(`git ${args.join(' ')} failed:\n${result.output}`);
      }
      return result;
    }
    function write(root: string, name: string, content: string) {
      const file = path.join(root, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (name.endsWith('.json')) {
        const formatted = spawnSync(
          `${repo}/node_modules/.bin/prettier`,
          ['--stdin-filepath', name],
          { input: content, env, encoding: 'utf8', timeout: 10_000 },
        );
        if (formatted.error) throw formatted.error;
        if (formatted.status !== 0) throw new Error(formatted.stderr);
        content = formatted.stdout;
      }
      fs.writeFileSync(file, content);
    }
    function dependency(buildable: boolean) {
      return `${JSON.stringify({
        name: '@fixture/dependency',
        sourceRoot: 'libs/dependency/src',
        projectType: 'library',
        tags: ['platform:shared', 'scope:shared'],
        targets: buildable
          ? {
              build: {
                executor: 'nx:run-commands',
                options: { command: 'true' },
              },
            }
          : {},
      })}\n`;
    }
    try {
      fs.mkdirSync(primary);
      git(primary, 'init', '--initial-branch=main');
      git(primary, 'config', 'user.name', 'Hook regression fixture');
      git(primary, 'config', 'user.email', 'fixture@example.invalid');
      write(primary, '.gitignore', 'node_modules/\n.nx/\n');
      // Reuse installed dependencies without pnpm trying to install this
      // deliberately minimal fixture over the author's node_modules symlink.
      write(primary, 'pnpm-workspace.yaml', 'verifyDepsBeforeRun: false\n');
      const packageManager = JSON.parse(
        fs.readFileSync(path.join(repo, 'package.json'), 'utf8'),
      ).packageManager;
      write(
        primary,
        'package.json',
        JSON.stringify({ private: true, packageManager }),
      );
      write(primary, 'nx.json', '{}\n');
      write(
        primary,
        'tsconfig.base.json',
        JSON.stringify({
          compilerOptions: {
            baseUrl: '.',
            paths: {
              '@fixture/dependency': ['libs/dependency/src/index.ts'],
            },
          },
        }),
      );
      write(
        primary,
        'libs/source/project.json',
        JSON.stringify({
          name: '@fixture/source',
          sourceRoot: 'libs/source/src',
          projectType: 'library',
          tags: ['platform:shared', 'scope:shared'],
          targets: {
            build: {
              executor: 'nx:run-commands',
              options: { command: 'true' },
            },
          },
        }),
      );
      write(primary, 'libs/dependency/project.json', dependency(false));
      write(
        primary,
        'libs/dependency/src/index.ts',
        'export const value = 1;\n',
      );
      write(primary, 'libs/source/src/index.ts', 'export const initial = 1;\n');
      for (const name of [
        'eslint.config.mjs',
        'lint-staged.config.mjs',
        'tools/eslint-staged.sh',
        'tools/nx',
        'tools/nx-native-file-cache.sh',
      ]) {
        write(primary, name, fs.readFileSync(path.join(repo, name), 'utf8'));
        if (name.endsWith('.sh') || name === 'tools/nx') {
          fs.chmodSync(path.join(primary, name), 0o755);
        }
      }
      git(primary, 'add', '.');
      git(primary, 'commit', '-m', 'initial fixture');
      git(primary, 'worktree', 'add', '-b', 'regression', worktree);
      fs.symlinkSync(
        path.join(repo, 'node_modules'),
        path.join(worktree, 'node_modules'),
        'dir',
      );
      const hooks = path.join(temp, 'hooks');
      write(
        hooks,
        'pre-commit',
        fs.readFileSync(path.join(repo, '.husky/pre-commit'), 'utf8'),
      );
      fs.chmodSync(path.join(hooks, 'pre-commit'), 0o755);
      git(worktree, 'config', 'core.hooksPath', hooks);

      const warmed = run(worktree, './tools/nx', [
        'show',
        'projects',
        '--json',
      ]);
      expect(warmed.status).toBe(0);
      write(worktree, 'libs/dependency/project.json', dependency(true));
      write(
        worktree,
        'libs/source/src/index.ts',
        "export { value } from '@fixture/dependency';\n",
      );
      // Independent red control: ESLint alone still consumes the old graph.
      const stale = run(worktree, 'pnpm', [
        'exec',
        'eslint',
        'libs/source/src/index.ts',
      ]);
      expect(stale.status).toBe(1);
      expect(stale.output).toContain(
        'Buildable libraries cannot import or export from non-buildable libraries',
      );

      git(worktree, 'add', 'libs');
      // Leave the unstaged manifest non-buildable. Only lint-staged's hidden
      // view contains the accepted build target; a pre-hook refresh is too early.
      write(worktree, 'libs/dependency/project.json', dependency(false));
      git(worktree, 'commit', '-m', 'newly buildable dependency');
      expect(
        JSON.parse(
          fs.readFileSync(
            path.join(worktree, 'libs/dependency/project.json'),
            'utf8',
          ),
        ).targets,
      ).toEqual({});

      // The graph now says buildable, but the next staged change removes it.
      git(worktree, 'add', 'libs/dependency/project.json');
      write(
        worktree,
        'libs/source/src/index.ts',
        "export { value as renamed } from '@fixture/dependency';\n",
      );
      git(worktree, 'add', 'libs/source/src/index.ts');
      const invalid = run(worktree, 'git', [
        'commit',
        '-m',
        'invalid dependency',
      ]);
      expect(invalid.status).not.toBe(0);
      expect(invalid.output).toContain(
        'Buildable libraries cannot import or export from non-buildable libraries',
      );
      expect(git(worktree, 'log', '-1', '--format=%s').output.trim()).toBe(
        'newly buildable dependency',
      );
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  },
);

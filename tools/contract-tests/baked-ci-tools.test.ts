import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const root = process.cwd();
const dirs: string[] = [];
function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'baked-tools-'));
  dirs.push(dir);
  mkdirSync(path.join(dir, 'bin'));
  writeFileSync(path.join(dir, 'output'), '');
  writeFileSync(path.join(dir, 'env'), '');
  const env = {
    ...process.env,
    PATH: `${dir}/bin:${process.env.PATH}`,
    GITHUB_OUTPUT: `${dir}/output`,
    GITHUB_ENV: `${dir}/env`,
    RUNNER_ENVIRONMENT: 'self-hosted',
  };
  const binary = (name: string, body: string) =>
    writeFileSync(`${dir}/bin/${name}`, `#!/bin/sh\nset -eu\n${body}\n`, {
      mode: 0o755,
    });
  return {
    dir,
    env,
    binary,
    output: () => readFileSync(`${dir}/output`, 'utf8'),
  };
}
afterEach(() =>
  dirs
    .splice(0)
    .forEach((dir) => rmSync(dir, { recursive: true, force: true })),
);

describe('baked CI tool selection', () => {
  it.each([
    ['24', '11.27.1', 'self-hosted', true],
    ['24.21.0', '11.27.1', 'self-hosted', true],
    ['24.2', '11.27.1', 'self-hosted', false],
    ['>=24', '11.27.1', 'self-hosted', false],
    ['24', '11.26.0', 'self-hosted', false],
    ['24', '11.27.1', 'github-hosted', false],
  ])('Node %s, pnpm %s on %s: %s', (requested, pnpm, runner, ready) => {
    const f = fixture();
    f.binary('node', '[ "$1" = -p ] && echo 24.21.0 || echo 11.27.1');
    f.binary('pnpm', `[ "$COREPACK_ENABLE_NETWORK" = 0 ]\necho ${pnpm}`);
    execFileSync(
      'bash',
      [path.join(root, '.github/actions/setup-node-pnpm/detect-baked.sh')],
      {
        cwd: f.dir,
        env: {
          ...f.env,
          REQUESTED_NODE_VERSION: requested,
          RUNNER_ENVIRONMENT: runner,
        },
      },
    );
    expect(f.output()).toBe(`ready=${ready}\n`);
  });

  it.each([
    ['terraform', '1.16.4', 'self-hosted', true],
    ['terraform', '1.16.3', 'self-hosted', false],
    ['terraform', '1.16.4', 'github-hosted', false],
    ['python', '0.12.19', 'self-hosted', true],
    ['python', '0.12.18', 'self-hosted', false],
    ['python', '0.12.19', 'github-hosted', false],
  ])('%s version %s on %s: %s', (tool, version, runner, ready) => {
    const f = fixture();
    mkdirSync(`${f.dir}/.github/workflows`, { recursive: true });
    writeFileSync(
      `${f.dir}/.github/workflows/ci.yml`,
      JSON.stringify({
        jobs: {
          check: {
            steps: [
              {
                uses: 'hashicorp/setup-terraform@pin',
                with: { terraform_version: 'v1.16.4' },
              },
              {
                uses: 'astral-sh/setup-uv@pin',
                with: { version: '0.12.19', 'python-version': '3.14' },
              },
            ],
          },
        },
      }),
    );
    f.binary('terraform', `echo '{"terraform_version":"${version}"}'`);
    f.binary(
      'uv',
      `[ "$UV_PYTHON_DOWNLOADS" = never ]\n[ "$UV_OFFLINE" = 1 ]\ncase "$1" in\n--version) echo 'uv ${version}' ;;\npython) echo '${f.dir}/bin/managed-python' ;;\ncache) echo '${f.dir}/cache' ;;\nesac`,
    );
    f.binary('managed-python', 'echo Python 3.14.7');
    execFileSync(
      'python3',
      [path.join(root, 'tools/detect-baked-ci-tools.py'), tool],
      {
        cwd: f.dir,
        env: { ...f.env, GITHUB_JOB: 'check', RUNNER_ENVIRONMENT: runner },
      },
    );
    expect(f.output()).toContain(`ready=${ready}\n`);
    expect(readFileSync(`${f.dir}/env`, 'utf8')).toBe(
      tool === 'python' && ready ? 'UV_PYTHON=3.14\n' : '',
    );
  });

  it('keeps the E2E sandbox browser version aligned with the installed Playwright', () => {
    const lock = parse(readFileSync('pnpm-lock.yaml', 'utf8'));
    const installed =
      lock.importers['.'].devDependencies['@playwright/test'].version.split(
        '(',
      )[0];
    const dockerfile = readFileSync('tools/e2e/Dockerfile', 'utf8');
    expect(dockerfile).toContain(
      `FROM mcr.microsoft.com/playwright:v${installed}-`,
    );
  });
});

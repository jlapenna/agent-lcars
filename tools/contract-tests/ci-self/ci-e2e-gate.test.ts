import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

const execFileAsync = promisify(execFile);

interface Workflow {
  jobs?: Record<
    string,
    {
      if?: string;
      name?: string;
      steps?: Array<{ id?: string; if?: string; name?: string; run?: string }>;
    }
  >;
}

describe('CI E2E operational gate', () => {
  it('keeps the selected browser gate CI-owned', async () => {
    const workflow = parseYaml(
      await readFile('.github/workflows/ci.yml', 'utf8'),
    ) as Workflow;

    expect(workflow.jobs?.e2e?.if).toBe("${{ vars.E2E_ENABLED != 'false' }}");
    expect(workflow.jobs?.e2e?.name).toBe('E2E');
    const scopeStep = workflow.jobs?.e2e?.steps?.find(
      (step) => step.id === 'e2e-scope',
    );
    expect(scopeStep).toEqual(
      expect.objectContaining({
        name: 'Determine whether console E2E is affected',
      }),
    );
    expect(workflow.jobs?.e2e?.steps).toContainEqual(
      expect.objectContaining({
        if: "steps.e2e-scope.outputs.run == 'true'",
        name: 'Run console e2e suite [full-suite]',
        run: './tools/e2e-local.sh',
      }),
    );

    const repo = await mkdtemp(path.join(os.tmpdir(), 'lcars-e2e-scope-'));
    const output = path.join(repo, 'scope-output');
    const scopeScript = path.join(repo, 'scope.sh');
    const env = {
      ...process.env,
      EVENT_NAME: 'pull_request',
      GITHUB_OUTPUT: output,
    };

    try {
      await writeFile(scopeScript, scopeStep?.run ?? 'exit 1');
      await mkdir(path.join(repo, 'tools', 'e2e'), { recursive: true });
      await mkdir(path.join(repo, 'docs'), { recursive: true });
      await execFileAsync('git', ['init', '--initial-branch=main'], {
        cwd: repo,
      });
      await execFileAsync('git', ['config', 'user.email', 'test@example.com'], {
        cwd: repo,
      });
      await execFileAsync('git', ['config', 'user.name', 'Test'], {
        cwd: repo,
      });
      await writeFile(path.join(repo, 'README.md'), 'base\n');
      await writeFile(
        path.join(repo, 'tools', 'nx'),
        '#!/usr/bin/env bash\nprintf "[]"\n',
      );
      await execFileAsync('chmod', ['+x', 'tools/nx'], { cwd: repo });
      await execFileAsync('git', ['add', '.'], { cwd: repo });
      await execFileAsync('git', ['commit', '-m', 'base'], { cwd: repo });
      const { stdout: base } = await execFileAsync(
        'git',
        ['rev-parse', 'HEAD'],
        {
          cwd: repo,
        },
      );

      await writeFile(path.join(repo, 'docs', 'note.md'), 'documentation\n');
      await execFileAsync('git', ['add', '.'], { cwd: repo });
      await execFileAsync('git', ['commit', '-m', 'documentation change'], {
        cwd: repo,
      });
      const { stdout: documentationHead } = await execFileAsync(
        'git',
        ['rev-parse', 'HEAD'],
        { cwd: repo },
      );

      await execFileAsync('bash', [scopeScript], {
        cwd: repo,
        env: {
          ...env,
          BASE_SHA: base.trim(),
          HEAD_SHA: documentationHead.trim(),
        },
      });
      await expect(readFile(output, 'utf8')).resolves.toBe('run=false\n');

      await writeFile(
        path.join(repo, 'tools', 'nx'),
        '#!/usr/bin/env bash\nprintf \'["@agent-lcars/console-e2e"]\'\n',
      );
      await rm(output);
      await execFileAsync('bash', [scopeScript], {
        cwd: repo,
        env: {
          ...env,
          BASE_SHA: base.trim(),
          HEAD_SHA: documentationHead.trim(),
        },
      });
      await expect(readFile(output, 'utf8')).resolves.toBe('run=true\n');

      await writeFile(
        path.join(repo, 'tools', 'nx'),
        '#!/usr/bin/env bash\nprintf "[]"\n',
      );
      await writeFile(path.join(repo, 'tools', 'e2e', 'fixture'), 'changed\n');
      await execFileAsync('git', ['add', '.'], { cwd: repo });
      await execFileAsync('git', ['commit', '-m', 'harness change'], {
        cwd: repo,
      });
      const { stdout: harnessHead } = await execFileAsync(
        'git',
        ['rev-parse', 'HEAD'],
        { cwd: repo },
      );

      await rm(output);
      await execFileAsync('bash', [scopeScript], {
        cwd: repo,
        env: {
          ...env,
          BASE_SHA: documentationHead.trim(),
          HEAD_SHA: harnessHead.trim(),
        },
      });
      await expect(readFile(output, 'utf8')).resolves.toBe('run=true\n');

      await writeFile(
        path.join(repo, 'tools', 'nx'),
        '#!/usr/bin/env bash\nexit 1\n',
      );
      await rm(output);
      await execFileAsync('bash', [scopeScript], {
        cwd: repo,
        env: {
          ...env,
          BASE_SHA: documentationHead.trim(),
          HEAD_SHA: harnessHead.trim(),
        },
      });
      await expect(readFile(output, 'utf8')).resolves.toBe('run=true\n');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

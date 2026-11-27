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
      needs?: string | string[];
      'runs-on'?: string;
      outputs?: Record<string, string>;
      steps?: Array<{
        id?: string;
        if?: string;
        name?: string;
        run?: string;
        'continue-on-error'?: boolean;
      }>;
    }
  >;
}

// This contract creates three Git commits and executes four shell probes.
// Allow the same scheduling headroom as the Nx test lane: the standalone
// contract lane hit its default 5s limit on CI run 36205666264.
describe('CI E2E operational gate', () => {
  it('keeps the main delivery trigger independent of browser capacity', async () => {
    const load = async (name: string) =>
      parseYaml(await readFile(`.github/workflows/${name}.yml`, 'utf8'));
    const [ci, browser, deploy] = await Promise.all([
      load('ci'),
      load('console-browser-ci'),
      load('deploy-console'),
    ]);
    expect(deploy.on.workflow_run.workflows).toEqual([ci.name]);
    expect(ci.jobs.verify.name).toBe('Verify');
    expect(ci.jobs['e2e-browser']).toBeUndefined();
    expect(ci.jobs['manual-browser'].if).toBe(
      "github.event_name == 'workflow_dispatch'",
    );
    expect(browser.on.push.branches).toContain('main');
    expect(browser.on).toHaveProperty('workflow_call');
    expect(ci.on.pull_request.types).toEqual([
      'opened',
      'synchronize',
      'reopened',
    ]);
    expect(browser.on.pull_request.types).toEqual(ci.on.pull_request.types);
    expect(browser.concurrency['cancel-in-progress']).toBe(
      "${{ github.event_name == 'pull_request' }}",
    );
    expect(JSON.stringify(browser)).not.toContain('pull_request.draft');
    expect(browser.jobs.e2e.name).toBe('E2E');
    expect(browser.concurrency.group).not.toBe(ci.concurrency.group);
    expect(ci.concurrency.group).toContain(
      "format('{0}-{1}', github.event_name, github.ref)",
    );
  });

  it('selects browser coverage from the affected scope', async () => {
    const workflow = parseYaml(
      await readFile('.github/workflows/console-browser-ci.yml', 'utf8'),
    ) as Workflow;
    const scopeStep = workflow.jobs?.['e2e-scope']?.steps?.find(
      (step) => step.id === 'e2e-scope',
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
      // Unknown events/bases and failed or malformed affected results must
      // retain browser coverage instead of becoming an unaffected success.
      for (const [event, baseSha, nxScript] of [
        ['workflow_dispatch', base.trim(), 'printf "[]"'],
        ['push', '0'.repeat(40), 'printf "[]"'],
        ['push', 'f'.repeat(40), 'printf "[]"'],
        ['pull_request', base.trim(), 'printf "not-json"'],
        ['pull_request', base.trim(), 'printf "{}"'],
        ['pull_request', base.trim(), 'printf "[1]"'],
      ]) {
        await writeFile(
          path.join(repo, 'tools', 'nx'),
          `#!/usr/bin/env bash\n${nxScript}\n`,
        );
        await rm(output);
        await execFileAsync('bash', [scopeScript], {
          cwd: repo,
          env: {
            ...env,
            EVENT_NAME: event,
            BASE_SHA: baseSha,
            HEAD_SHA: documentationHead.trim(),
          },
        });
        await expect(readFile(output, 'utf8')).resolves.toBe('run=true\n');
      }
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }, 15_000);

  it.each([
    ['success', 'false', 'skipped', true],
    ['success', 'true', 'success', true],
    ['failure', 'false', 'skipped', false],
    ['cancelled', 'true', 'skipped', false],
    ['skipped', '', 'skipped', false],
    ['success', 'true', 'failure', false],
    ['success', 'true', 'cancelled', false],
    ['success', 'true', 'skipped', false],
    ['success', 'false', 'success', false],
    ['success', '', 'skipped', false],
    ['success', 'invalid', 'success', false],
  ])(
    'aggregates selection=%s run=%s browser=%s into pass=%s',
    async (selection, run, browser, pass) => {
      const workflow = parseYaml(
        await readFile('.github/workflows/console-browser-ci.yml', 'utf8'),
      ) as Workflow;
      const aggregate = workflow.jobs?.e2e?.steps?.find(
        (step) => step.run,
      )?.run;
      expect(aggregate).toBeTruthy();
      const result = await execFileAsync('bash', ['-c', aggregate!], {
        env: {
          ...process.env,
          SELECTION_RESULT: selection,
          RUN_BROWSER: run,
          BROWSER_RESULT: browser,
        },
      }).then(
        () => true,
        () => false,
      );
      expect(result).toBe(pass);
    },
  );
});

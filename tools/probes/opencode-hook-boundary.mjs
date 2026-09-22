#!/usr/bin/env node
// Real CLI, deterministic localhost model, no credentials or GitHub writes.
// This measures interception primitives, NOT full LCARS policy qualification.
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import setup from '../../packages/fleet-tools/bin/worker-hook-setup.cjs';
import policy from '../../packages/fleet-tools/bin/worker-policy.cjs';

const [binary, expectedVersion] = process.argv.slice(2);
if (!binary || !expectedVersion) {
  throw new Error(
    'usage: node opencode-hook-boundary.mjs <absolute-cli-path> <expected-version>',
  );
}
const root = mkdtempSync(join(tmpdir(), 'lcars-opencode-hook-probe-'));
const cli = resolve(binary);

function run(args, cwd, env, timeout = 60000) {
  return new Promise((resolveRun) => {
    const child = spawn(cli, args, {
      cwd,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* already exited */
      }
    }, timeout);
    child.stdout.on('data', (chunk) => {
      stdout = (stdout + chunk).slice(-1000000);
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-1000000);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolveRun({ code: null, stdout, stderr: error.message, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolveRun({ code, stdout, stderr, timedOut });
    });
  });
}

const version = await run(
  ['--version'],
  root,
  { PATH: process.env.PATH, HOME: root },
  10000,
);
if (version.code !== 0 || version.stdout.trim() !== expectedVersion) {
  throw new Error(
    `version mismatch: expected ${expectedVersion}, got ${version.stdout.trim()}`,
  );
}

async function probe(mode) {
  const dir = join(root, mode);
  const workspace = join(dir, 'workspace');
  const home = join(dir, 'home');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(home, { recursive: true });
  const sentinel = join(workspace, 'effect');
  const receipt = join(workspace, 'hook-receipt');
  const plugin = join(workspace, 'probe-plugin.mjs');
  const bootstrap = mode === 'bootstrap-marker';
  const recovery = mode.startsWith('policy-recovery-');
  const usesPolicy = mode.startsWith('policy-') || bootstrap;
  const context = policy.prepareContext(
    {
      repository: 'octo/example',
      mode: 'reply',
      anchor: { type: 'issue', number: 42 },
    },
    {
      provider: 'opencode',
      runId: 'octo/example#42/r1',
      attemptId: 'g1:octo/example#42/r1',
    },
  );
  const contextPath = join(dir, 'worker-context.json');
  writeFileSync(contextPath, JSON.stringify(context));
  if (mode === 'policy-recovery-exhausted')
    writeFileSync(`${contextPath}.recovery-used`, context.attemptId);
  const fakeBin = join(dir, 'bin');
  mkdirSync(fakeBin);
  writeFileSync(
    join(fakeBin, 'gh'),
    `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'api') {
  ${mode === 'policy-failure' ? 'process.exit(1);' : ''}
  console.log(JSON.stringify({state:'open',assignees:${JSON.stringify(mode === 'policy-deny' ? [] : [{ login: 'agent-lcars-bot' }])}}));
} else if (args[0] === 'issue' && args[1] === 'comment') {fs.writeFileSync(${JSON.stringify(sentinel)}, JSON.stringify(args)); console.log('fixture publication');}
else process.exitCode = 1;
`,
    { mode: 0o700 },
  );
  writeFileSync(
    plugin,
    `import { appendFileSync } from 'node:fs';
export default async () => ({
  'tool.execute.before': async (input) => {
    if (input.tool !== 'bash') return;
    appendFileSync(${JSON.stringify(receipt)}, JSON.stringify(input) + '\\n');
    ${mode === 'deny' ? "throw new Error('LCARS_PROBE_DENY');" : ''}
    ${mode === 'failure' ? "throw new Error('LCARS_PROBE_DEPENDENCY_UNAVAILABLE');" : ''}
  }
});
`,
  );
  if (usesPolicy && !bootstrap)
    writeFileSync(
      plugin,
      `import {appendFileSync} from 'node:fs';
import workerPolicy from ${JSON.stringify(pathToFileURL(resolve('packages/fleet-tools/bin/worker-opencode-plugin.mjs')).href)};
import policy from ${JSON.stringify(pathToFileURL(resolve('packages/fleet-tools/bin/worker-policy.cjs')).href)};
export default async (context) => {
  const hooks = await workerPolicy(context);
  return {'tool.execute.before': async (input, output) => {
    appendFileSync(${JSON.stringify(receipt)}, JSON.stringify(input) + '\\n');
    ${
      recovery
        ? `
    const original = policy.evaluate;
    policy.evaluate = () => { throw new Error('LCARS_INJECTED_CONTROL_CRASH'); };
    try { await hooks['tool.execute.before'](input, output); }
    finally { policy.evaluate = original; }
    `
        : "await hooks['tool.execute.before'](input, output);"
    }
  }};
};
`,
    );
  let issued = false;
  let requests = 0;
  let returnedToolResult = false;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    try {
      const input = JSON.parse(body);
      requests++;
      returnedToolResult ||=
        input.messages?.some((message) => message.role === 'tool') ?? false;
      // Auxiliary title requests are text-only and must not consume the tool call.
      const tool =
        !issued &&
        input.tools?.some((entry) => entry.function?.name === 'bash');
      if (tool) issued = true;
      const delta = tool
        ? {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'probe-call',
                type: 'function',
                function: {
                  name: 'bash',
                  arguments: JSON.stringify({
                    command: usesPolicy
                      ? 'gh issue comment 42 --repo octo/example --body "Fixture deliverable"'
                      : `touch '${sentinel}'`,
                    description: 'Create harmless probe sentinel',
                  }),
                },
              },
            ],
          }
        : { role: 'assistant', content: 'Probe complete.' };
      const frame = (delta, finish_reason) => ({
        id: 'probe',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'probe',
        choices: [{ index: 0, delta, finish_reason }],
      });
      const frames = [
        frame(delta, null),
        frame({}, tool ? 'tool_calls' : 'stop'),
      ];
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(
        frames.map((value) => `data: ${JSON.stringify(value)}\n\n`).join('') +
          'data: [DONE]\n\n',
      );
    } catch {
      res.writeHead(400);
      res.end('invalid probe request');
    }
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  writeFileSync(
    join(workspace, 'opencode.json'),
    JSON.stringify({
      plugin: mode === 'missing' || (usesPolicy && !bootstrap) ? [] : [plugin],
      permission: { bash: 'allow' },
      provider: {
        probe: {
          npm: '@ai-sdk/openai-compatible',
          name: 'Local probe',
          options: {
            baseURL: `http://127.0.0.1:${server.address().port}/v1`,
            apiKey: 'local-placeholder',
          },
          models: {
            test: { name: 'probe', limit: { context: 32000, output: 4096 } },
          },
        },
      },
    }),
  );
  if (bootstrap) {
    const briefPath = join(dir, 'brief.json');
    writeFileSync(
      briefPath,
      JSON.stringify({
        repository: context.repository,
        mode: context.mode,
        anchor: context.anchor,
      }),
    );
    const options = {
      provider: 'opencode',
      configPath: join(workspace, 'opencode.json'),
      contextPath,
      briefPath,
      runId: context.runId,
      attemptId: context.attemptId,
    };
    await setup.bootstrapWorker(options);
    if ((await setup.bootstrapWorker(options)).changed)
      throw new Error('Bootstrap was not idempotent');
  } else if (usesPolicy) {
    setup.installOpenCode(join(workspace, 'opencode.json'), plugin);
    if (setup.installOpenCode(join(workspace, 'opencode.json'), plugin).changed)
      throw new Error('Setup was not idempotent');
  }
  writeFileSync(join(dir, 'models.json'), '{}');
  let execution;
  try {
    execution = await run(
      [
        'run',
        '--model',
        'probe/test',
        '--auto',
        '--dir',
        workspace,
        'Execute the supplied probe tool call, then finish.',
      ],
      workspace,
      {
        PATH: usesPolicy ? `${fakeBin}:${process.env.PATH}` : process.env.PATH,
        ...(usesPolicy
          ? { LCARS_RUN_ID: context.runId, LCARS_WORKER_CONTEXT: contextPath }
          : {}),
        HOME: home,
        XDG_CONFIG_HOME: join(home, '.config'),
        XDG_DATA_HOME: join(dir, 'data'),
        XDG_CACHE_HOME: join(dir, 'cache'),
        XDG_STATE_HOME: join(dir, 'state'),
        OPENCODE_DISABLE_AUTOUPDATE: 'true',
        OPENCODE_DISABLE_MODELS_FETCH: 'true',
        OPENCODE_DISABLE_TERMINAL_TITLE: 'true',
        OPENCODE_MODELS_PATH: join(dir, 'models.json'),
      },
    );
  } finally {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
  writeFileSync(join(dir, 'stdout.txt'), execution.stdout);
  writeFileSync(join(dir, 'stderr.txt'), execution.stderr);
  const hookInvoked =
    existsSync(receipt) && readFileSync(receipt, 'utf8').trim().length > 0;
  const effect = existsSync(sentinel);
  let markerRepaired = false;
  if (usesPolicy && effect) {
    const published = JSON.parse(readFileSync(sentinel, 'utf8'));
    markerRepaired =
      published[published.indexOf('--body') + 1] ===
      `Fixture deliverable\n\n<!-- attempt-claim:${context.attemptId} -->`;
  }
  const exercised =
    execution.code === 0 && !execution.timedOut && issued && returnedToolResult;
  return {
    mode,
    requests,
    issued,
    returnedToolResult,
    hookInvoked,
    effect,
    markerRepaired,
    recoveryUsed: recovery && existsSync(`${contextPath}.recovery-used`),
    code: execution.code,
    timedOut: execution.timedOut,
    exercised,
    // Missing-hook case intentionally exposes lack of native admission.
    observedExpectedPrimitive:
      exercised &&
      (!recovery || existsSync(`${contextPath}.recovery-used`)) &&
      (mode === 'policy-marker' ||
      bootstrap ||
      mode === 'policy-recovery-success'
        ? hookInvoked && effect && markerRepaired
        : mode === 'missing'
          ? !hookInvoked && effect
          : hookInvoked && effect === (mode === 'allow')),
  };
}

const observations = [];
for (const mode of [
  'allow',
  'deny',
  'failure',
  'missing',
  'policy-marker',
  'policy-deny',
  'policy-failure',
  'bootstrap-marker',
  'policy-recovery-success',
  'policy-recovery-exhausted',
])
  observations.push(await probe(mode));
const report = {
  provider: 'opencode',
  providerVersion: expectedVersion,
  qualification: 'not-evaluated',
  observations,
  evidenceDirectory: root,
};
writeFileSync(join(root, 'observations.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exitCode = observations.every((item) => item.observedExpectedPrimitive)
  ? 0
  : 1;

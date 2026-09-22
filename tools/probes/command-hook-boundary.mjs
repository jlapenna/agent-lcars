#!/usr/bin/env node
// Claude/Codex native command hooks against a deterministic localhost model.
// No real credentials, repository writes, or full-policy qualification.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import setup from '../../packages/fleet-tools/bin/worker-hook-setup.cjs';
import policy from '../../packages/fleet-tools/bin/worker-policy.cjs';

const [provider, binary, expectedVersion] = process.argv.slice(2);
if (
  !['claude', 'codex'].includes(provider) ||
  !binary ||
  !isAbsolute(binary) ||
  !expectedVersion
) {
  throw new Error(
    'usage: command-hook-boundary.mjs <claude|codex> <absolute-binary> <exact-version-output>',
  );
}
const root = mkdtempSync(join(tmpdir(), `lcars-${provider}-hook-probe-`));
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

function execute(args, cwd, env, timeout = 60000) {
  return new Promise((done) => {
    const child = spawn(binary, args, {
      cwd,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '',
      stderr = '',
      timedOut = false;
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
      done({ code: null, stdout, stderr: error.message, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ code, stdout, stderr, timedOut });
    });
  });
}

const version = await execute(
  ['--version'],
  root,
  { HOME: root, PATH: process.env.PATH },
  10000,
);
if (version.code !== 0 || version.stdout.trim() !== expectedVersion)
  throw new Error(`version mismatch: ${version.stdout.trim()}`);

async function probe(mode) {
  const dir = join(root, mode),
    workspace = join(dir, 'workspace'),
    home = join(dir, 'home');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(join(home, '.codex'), { recursive: true });
  mkdirSync(join(home, '.claude'), { recursive: true });
  const sentinel = join(workspace, 'effect'),
    receipt = join(dir, 'receipt.json');
  const rewrittenSentinel = join(workspace, 'rewritten-effect');
  const resumedSentinel = join(workspace, 'resumed-effect');
  let round = 1;
  const bootstrap = mode === 'bootstrap-marker';
  const recovery = mode.startsWith('bridge-recovery-');
  const policyMarker = mode === 'bridge-marker' || bootstrap;
  const context = policy.prepareContext(
    {
      repository: 'octo/example',
      mode: 'reply',
      anchor: { type: 'issue', number: 42 },
    },
    {
      provider,
      runId: 'octo/example#42/r1',
      attemptId: 'g1:octo/example#42/r1',
    },
  );
  const fakeBin = join(dir, 'bin');
  mkdirSync(fakeBin);
  // Isolated transport fixture only. No credentials or external GitHub writes.
  writeFileSync(
    join(fakeBin, 'gh'),
    `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'api') console.log(JSON.stringify({state:'open',assignees:[{login:'agent-lcars-bot'}]}));
else if (args[0] === 'issue' && args[1] === 'comment') {fs.writeFileSync(${JSON.stringify(sentinel)}, JSON.stringify(args)); console.log('fixture publication');}
else process.exitCode = 1;
`,
    { mode: 0o700 },
  );
  const hook = join(dir, 'hook.cjs');
  writeFileSync(
    hook,
    `const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(receipt)}, fs.readFileSync(0));
${mode === 'deny' ? "process.stderr.write('LCARS_PROBE_DENY'); process.exitCode = 2;" : ''}
${mode === 'failure' || mode === 'bridge-failure' ? "throw new Error('LCARS_PROBE_DEPENDENCY_UNAVAILABLE');" : ''}
${mode === 'bridge-timeout' ? 'setInterval(() => {}, 1000);' : ''}
${
  recovery
    ? `
const calls = ${JSON.stringify(join(dir, 'recovery-calls'))};
const first = !fs.existsSync(calls);
const input = JSON.parse(fs.readFileSync(${JSON.stringify(receipt)}, 'utf8'));
fs.appendFileSync(calls, input.tool_input.command + '\\n');
if (first) throw new Error('LCARS_TRANSIENT_CONTROL_FAILURE');
const policy = require(${JSON.stringify(resolve('packages/fleet-tools/bin/worker-policy.cjs'))});
const result = policy.evaluate(input, ${JSON.stringify(context)});
${mode === 'bridge-recovery-failure' ? "result.hookSpecificOutput.permissionDecision = 'allow';" : ''}
console.log(JSON.stringify(result));
`
    : ''
}
${mode === 'bridge-allow' ? 'console.log(JSON.stringify({hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"allow"}}));' : ''}
${mode === 'bridge-rewrite' ? `console.log(JSON.stringify({hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"allow",updatedInput:{command:${JSON.stringify(`touch ${quote(rewrittenSentinel)}`)}}}}));` : ''}
${policyMarker && !bootstrap ? `const policy = require(${JSON.stringify(resolve('packages/fleet-tools/bin/worker-policy.cjs'))}); console.log(JSON.stringify(policy.evaluate(JSON.parse(fs.readFileSync(${JSON.stringify(receipt)}, 'utf8')), ${JSON.stringify(context)})));` : ''}
`,
  );
  const hookConfig =
    mode === 'missing' || mode.startsWith('bridge-')
      ? {}
      : {
          hooks: {
            PreToolUse: [
              {
                matcher: 'Bash',
                hooks: [
                  {
                    type: 'command',
                    command: `${quote(process.execPath)} ${quote(hook)}`,
                    timeout: 10,
                  },
                ],
              },
            ],
          },
        };
  writeFileSync(join(home, '.codex', 'hooks.json'), JSON.stringify(hookConfig));
  writeFileSync(
    join(home, '.claude', 'settings.json'),
    JSON.stringify(hookConfig),
  );
  if (mode.startsWith('bridge-')) {
    const configPath =
      provider === 'codex'
        ? join(home, '.codex', 'hooks.json')
        : join(home, '.claude', 'settings.json');
    setup.installRegistration(configPath, hook);
    if (setup.installRegistration(configPath, hook).changed)
      throw new Error('Setup was not idempotent');
  }
  const contextPath = join(dir, 'worker-context.json');
  if (recovery) writeFileSync(contextPath, JSON.stringify(context));
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
      provider,
      configPath:
        provider === 'codex'
          ? join(home, '.codex', 'hooks.json')
          : join(home, '.claude', 'settings.json'),
      contextPath,
      briefPath,
      runId: context.runId,
      attemptId: context.attemptId,
    };
    await setup.bootstrapWorker(options);
    if ((await setup.bootstrapWorker(options)).changed)
      throw new Error('Bootstrap was not idempotent');
  }
  let issued = false,
    returnedToolResult = false,
    requests = 0;
  const observations = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    try {
      const body = JSON.parse(raw);
      requests++;
      const tools = body.tools ?? [];
      observations.push({
        path: req.url,
        tools: tools.map((tool) => tool.name ?? tool.type),
      });
      const content =
        provider === 'codex' ? (body.input ?? []) : (body.messages ?? []);
      returnedToolResult ||= JSON.stringify(content).includes(
        provider === 'codex' ? 'function_call_output' : 'tool_result',
      );
      const toolName = provider === 'codex' ? 'exec_command' : 'Bash';
      const callTool = !issued && tools.some((tool) => tool.name === toolName);
      if (callTool) issued = true;
      const command = policyMarker
        ? 'gh issue comment 42 --repo octo/example --body "Fixture deliverable"'
        : `touch ${quote(round === 1 ? sentinel : resumedSentinel)}`;
      const args =
        provider === 'codex'
          ? { cmd: command, yield_time_ms: 1000 }
          : { command, description: 'Harmless probe sentinel' };
      const send = (event, data) =>
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (provider === 'codex') {
        const item = callTool
          ? {
              type: 'function_call',
              id: 'fc_probe',
              call_id: 'call_probe',
              name: toolName,
              arguments: JSON.stringify(args),
              status: 'completed',
            }
          : {
              type: 'message',
              id: 'msg_probe',
              role: 'assistant',
              status: 'completed',
              content: [
                {
                  type: 'output_text',
                  text: 'Probe complete.',
                  annotations: [],
                },
              ],
            };
        const response = {
          id: `resp_${requests}`,
          object: 'response',
          status: 'completed',
          output: [item],
          usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
        };
        send('response.created', {
          type: 'response.created',
          response: { ...response, status: 'in_progress', output: [] },
        });
        send('response.output_item.added', {
          type: 'response.output_item.added',
          output_index: 0,
          item,
        });
        send('response.output_item.done', {
          type: 'response.output_item.done',
          output_index: 0,
          item,
        });
        send('response.completed', { type: 'response.completed', response });
      } else {
        send('message_start', {
          type: 'message_start',
          message: {
            id: `msg_${requests}`,
            type: 'message',
            role: 'assistant',
            model: 'claude-sonnet-4-6',
            content: [],
            stop_reason: null,
            usage: { input_tokens: 10, output_tokens: 0 },
          },
        });
        send('content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: callTool
            ? { type: 'tool_use', id: 'tool_probe', name: toolName, input: {} }
            : { type: 'text', text: '' },
        });
        send('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: callTool
            ? { type: 'input_json_delta', partial_json: JSON.stringify(args) }
            : { type: 'text_delta', text: 'Probe complete.' },
        });
        send('content_block_stop', { type: 'content_block_stop', index: 0 });
        send('message_delta', {
          type: 'message_delta',
          delta: {
            stop_reason: callTool ? 'tool_use' : 'end_turn',
            stop_sequence: null,
          },
          usage: { output_tokens: 10 },
        });
        send('message_stop', { type: 'message_stop' });
      }
      res.end();
    } catch {
      res.end();
    }
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${server.address().port}`;
  const env = {
    PATH: policyMarker ? `${fakeBin}:${process.env.PATH}` : process.env.PATH,
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(dir, 'data'),
    XDG_CACHE_HOME: join(dir, 'cache'),
    LCARS_RUN_ID:
      policyMarker || recovery ? context.runId : 'work:local-boundary-probe/r1',
    ...(bootstrap || recovery ? { LCARS_WORKER_CONTEXT: contextPath } : {}),
    CODEX_HOME: join(home, '.codex'),
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    ANTHROPIC_BASE_URL: base,
    ANTHROPIC_API_KEY: 'local-test-placeholder',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
  };
  writeFileSync(
    join(home, '.codex', 'config.toml'),
    `model = "probe"
model_provider = "probe"
[model_providers.probe]
name = "Local deterministic probe"
base_url = "${base}/v1"
wire_api = "responses"
requires_openai_auth = false
[features]
hooks = true
code_mode = false
`,
  );
  const args =
    provider === 'codex'
      ? [
          'exec',
          '--skip-git-repo-check',
          '--dangerously-bypass-hook-trust',
          '--dangerously-bypass-approvals-and-sandbox',
          '--disable',
          'code_mode',
          'Run the supplied probe command, then finish.',
        ]
      : [
          '--print',
          '--model',
          'claude-sonnet-4-6',
          '--dangerously-skip-permissions',
          '--tools',
          'Bash',
          '--strict-mcp-config',
          '--mcp-config',
          '{"mcpServers":{}}',
          '--',
          'Run the supplied probe command, then finish.',
        ];
  let execution,
    resumedSameSession = false;
  const allocatedSession = randomUUID();
  const initialArgs =
    mode === 'resume' && provider === 'claude'
      ? ['--session-id', allocatedSession, ...args]
      : args;
  const deadline = Date.now() + 60000;
  try {
    execution = await execute(
      initialArgs,
      workspace,
      env,
      Math.max(1, deadline - Date.now()),
    );
    if (mode === 'resume' && execution.code === 0 && existsSync(receipt)) {
      const firstReceipt = JSON.parse(readFileSync(receipt, 'utf8'));
      writeFileSync(
        join(dir, 'first-receipt.json'),
        JSON.stringify(firstReceipt),
      );
      const sessionId = firstReceipt.session_id;
      if (
        !sessionId ||
        (provider === 'claude' && sessionId !== allocatedSession)
      )
        throw new Error('Native session identity was not bound');
      const resumeArgs =
        provider === 'codex'
          ? ['exec', 'resume', sessionId, ...args.slice(1)]
          : ['--resume', sessionId, ...args];
      round = 2;
      issued = false;
      returnedToolResult = false;
      const resumed = await execute(
        resumeArgs,
        workspace,
        env,
        Math.max(1, deadline - Date.now()),
      );
      writeFileSync(join(dir, 'resume-stdout.txt'), resumed.stdout);
      writeFileSync(join(dir, 'resume-stderr.txt'), resumed.stderr);
      resumedSameSession =
        resumed.code === 0 &&
        !resumed.timedOut &&
        existsSync(resumedSentinel) &&
        JSON.parse(readFileSync(receipt, 'utf8')).session_id === sessionId;
    }
  } finally {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
  writeFileSync(join(dir, 'stdout.txt'), execution.stdout);
  writeFileSync(join(dir, 'stderr.txt'), execution.stderr);
  writeFileSync(join(dir, 'requests.json'), JSON.stringify(observations));
  const effect = existsSync(sentinel),
    hookInvoked = existsSync(receipt);
  const rewrittenEffect = existsSync(rewrittenSentinel);
  let markerRepaired = false;
  if (policyMarker && effect) {
    const published = JSON.parse(readFileSync(sentinel, 'utf8'));
    markerRepaired =
      published[published.indexOf('--body') + 1] ===
      `Fixture deliverable\n\n<!-- attempt-claim:${context.attemptId} -->`;
  }
  const exercised =
    execution.code === 0 && !execution.timedOut && issued && returnedToolResult;
  const recoveryVerified =
    recovery &&
    existsSync(`${contextPath}.recovery-used`) &&
    existsSync(`${contextPath}.recovery-succeeded`) ===
      (mode === 'bridge-recovery-success') &&
    existsSync(`${contextPath}.control-failed`) ===
      (mode === 'bridge-recovery-failure') &&
    readFileSync(join(dir, 'recovery-calls'), 'utf8').trim().split('\n')
      .length === (mode === 'bridge-recovery-success' ? 4 : 3);
  return {
    mode,
    requests,
    issued,
    returnedToolResult,
    hookInvoked,
    effect,
    rewrittenEffect,
    markerRepaired,
    resumedSameSession,
    recoveryVerified,
    code: execution.code,
    timedOut: execution.timedOut,
    exercised,
    observedExpectedPrimitive:
      exercised &&
      (recovery
        ? hookInvoked &&
          recoveryVerified &&
          effect === (mode === 'bridge-recovery-success')
        : mode === 'resume'
          ? hookInvoked && effect && resumedSameSession
          : policyMarker
            ? hookInvoked && effect && markerRepaired
            : mode === 'bridge-rewrite'
              ? hookInvoked && !effect && rewrittenEffect
              : mode === 'missing'
                ? !hookInvoked && effect
                : hookInvoked &&
                  (mode === 'failure' ||
                    effect === (mode === 'allow' || mode === 'bridge-allow'))),
  };
}

const observations = [];
for (const mode of [
  'allow',
  'deny',
  'failure',
  'missing',
  'bridge-allow',
  'bridge-failure',
  'bridge-timeout',
  'bridge-rewrite',
  'bridge-marker',
  'resume',
  'bootstrap-marker',
  'bridge-recovery-success',
  'bridge-recovery-failure',
])
  observations.push(await probe(mode));
const report = {
  provider,
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

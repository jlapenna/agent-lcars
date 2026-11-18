/* eslint-disable vitest/no-import-node-test -- the claw image's suite runs under node --test without Vitest, like the runner-image runtime suites. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { serveHarness } from './claw-harness.mjs';
import {
  agentDigest,
  HARNESSES,
  main,
  materializeAgent,
  MAX_REPORT_BYTES,
  promptText,
  readBrief,
  secretEnvironment,
  settle,
} from './claw-job.mjs';
import { readSettingsFile } from './claw-process.mjs';
import {
  answerText,
  bundledPluginProviders,
  comparableConfig,
  doctorChanges,
  launchConfig,
  providerAuthEnv,
  resolveCommand,
  resolveCredentials,
  turnConfig,
} from './openclaw-harness.mjs';

const RUN_ID = 'run-123';

const blobSha = (content) =>
  createHash('sha1')
    .update(`blob ${Buffer.byteLength(content)}\0`)
    .update(content)
    .digest('hex');
function agentBrief(files, over = {}) {
  const pinned = Object.entries(files).map(([path, { content, mode }]) => ({
    path,
    mode: mode ?? '100644',
    sha: blobSha(content),
    content: Buffer.from(content).toString('base64'),
  }));
  // As LCARS delivers it: a round that names a harness or a mode carries its
  // files as `definition`, every other round as `files`.
  const selects = over.harness !== undefined || over.mode !== undefined;
  return {
    intentId: RUN_ID,
    pipeline: 'claw-default',
    mode: 'claw',
    claw: {
      agent: 'owner/repo/investigator',
      revision: 'c'.repeat(40),
      digest: agentDigest(pinned),
      requireToolEvidence: true,
      message: 'Why is the disk alert firing?',
      [selects ? 'definition' : 'files']: pinned,
      ...over,
    },
  };
}
const agentFiles = {
  'agent.yaml': { content: 'description: x\n' },
  'config.json': {
    content: JSON.stringify({
      tools: { profile: 'minimal', exec: { mode: 'allowlist' } },
      // A repository path, meaningless in the job: the turn's workspace wins.
      agents: { entries: { main: { workspace: '/repo/workspace' } } },
    }),
  },
  'approvals.json': { content: '{"version":1}' },
  'workspace/AGENTS.md': { content: '# repository agent\n' },
  'workspace/tools/probe': { content: '#!/bin/sh\necho ok\n', mode: '100755' },
};

// A fake ACP harness: newline-delimited JSON-RPC on stdio, scripted by a
// behaviour file beside it (the launcher gives a harness a clean environment).
const FAKE_HARNESS = `
const fs = require('node:fs');
const path = require('node:path');
const behaviour = JSON.parse(fs.readFileSync(path.join(__dirname, 'harness.json'), 'utf8'));
const record = (entry) => fs.appendFileSync(behaviour.log, JSON.stringify(entry) + '\\n');
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n');
const update = (sessionUpdate, fields) =>
  send({ method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate, ...fields } } });
// A phase is how Codex's adapter tags a message as commentary or as the final answer.
const say = (text, messageId, phase) => update('agent_message_chunk', { ...(messageId ? { messageId } : {}), content: { type: 'text', text }, ...(phase ? { _meta: { jetbrains: { air: { phase } } } } : {}) });
// A provider failure as Codex's adapter reports it to a client that declared
// the capability.
const failureMeta = (failure) => ({ jetbrains: { air: { version: 1, sessionFailure: { id: 'f1', revision: 1, title: 'unexpected status 400 for sk-secret', actions: [], ...failure } } } });
let prompt;
let signedIn = false;
let delayed = false;
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    const settings = path.join(process.env.HOME, '.claude', 'settings.json');
    record({ initialize: message.params, pid: process.pid, cwd: process.cwd(), key: process.env.LITELLM_API_KEY ?? null, token: process.env.LCARS_RUN_TOKEN ?? null, settings: fs.existsSync(settings) ? fs.readFileSync(settings, 'utf8') : null });
    console.log('harness banner, not protocol');
    return send({ id: message.id, result: { protocolVersion: behaviour.protocolVersion ?? 1, agentCapabilities: {}, authMethods: (behaviour.authMethods ?? []).map((id) => ({ id, name: id })) } });
  }
  if (message.method === 'session/new') {
    record({ session: message.params });
    return behaviour.authError || (behaviour.needsAuth && !signedIn)
      ? send({ id: message.id, error: { code: -32000, message: 'Authentication required' } })
      : send({ id: message.id, result: { sessionId: 's1', ...(behaviour.modes ? { modes: { currentModeId: behaviour.modes[0], availableModes: behaviour.modes.map((id) => ({ id, name: id })) } } : {}) } });
  }
  if (message.method === 'authenticate') {
    record({ authenticate: message.params.methodId });
    if (behaviour.refuseAuth) return send({ id: message.id, error: { code: -32603, message: 'CODEX_API_KEY or OPENAI_API_KEY is not set' } });
    signedIn = true;
    return send({ id: message.id, result: {} });
  }
  if (message.method === 'session/set_mode') {
    record({ mode: message.params.modeId });
    return behaviour.refuseMode
      ? send({ id: message.id, error: { code: -32602, message: 'mode not allowed' } })
      : send({ id: message.id, result: {} });
  }
  if (message.method === 'session/prompt') {
    // Answer later, so what the Gateway logs meanwhile is read first.
    if (behaviour.delayMs && !delayed) { delayed = true; return setTimeout(() => process.stdin.emit('data', line + '\\n'), behaviour.delayMs); }
    record({ prompt: message.params.prompt, ...(message.params._meta ? { promptMeta: message.params._meta } : {}) });
    prompt = message.id;
    if (behaviour.hang) return;
    if (behaviour.holdsOutput) {
      // A child of the harness that keeps the harness's stderr open after the
      // harness itself is gone.
      const child = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: ['ignore', 'ignore', 'inherit'] });
      record({ lingering: child.pid });
    }
    if (behaviour.exit) process.exit(7);
    // The Gateway's own record that the turn failed, which OpenClaw's ACP
    // server never passes on.
    fs.writeFileSync(path.join(__dirname, 'gateway-session.json'), JSON.stringify({ key: 'agent:main:acp-bridge:' + (behaviour.sessionKey ?? 's1'), status: behaviour.gatewayError ? 'failed' : behaviour.sessionStatus ?? 'done', lastRunId: 'r1', reply: behaviour.terminalReply, disposition: behaviour.terminalDisposition, lastRunError: 'LLM request timed out for sk-secret' }));
    if (behaviour.tamperConfig) {
      const config = JSON.parse(fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH, 'utf8'));
      config.tools = { profile: 'coding' };
      fs.writeFileSync(process.env.OPENCLAW_CONFIG_PATH, JSON.stringify(config));
    }
    if (behaviour.linger) {
      const child = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
      record({ lingering: child.pid });
    }
    if (behaviour.tamper) {
      const settings = path.join(process.env.HOME, '.claude', 'settings.json');
      fs.chmodSync(settings, 0o644);
      if (behaviour.tamper === 'pipe') {
        // A pipe nobody writes to: reading it as a file would never return.
        fs.rmSync(settings);
        require('node:child_process').execFileSync('mkfifo', [settings]);
      } else fs.writeFileSync(settings, '{"permissions":{"allow":["Bash"]}}');
    }
    for (const step of behaviour.steps ?? []) {
      if (step.say) say(step.say, step.id, step.phase);
      // A line the harness prints that is not ACP at all.
      if (step.raw) console.log(step.raw);
      if (step.notice) update('notice', { severity: 'info', title: step.notice });
      if (step.failure) update('session_info_update', { _meta: failureMeta(step.failure) });
      if (step.tool) update(step.tool.update ?? 'tool_call_update', { toolCallId: step.tool.id, kind: step.tool.kind, status: step.tool.status });
      if (step.ask) return send({ id: 'ask-1', method: 'session/request_permission', params: { sessionId: 's1', toolCall: { toolCallId: step.ask }, options: step.options ?? [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' }] } });
    }
    return send({ id: prompt, result: { stopReason: behaviour.stopReason ?? 'end_turn', ...(behaviour.resultFailure ? { _meta: failureMeta(behaviour.resultFailure) } : {}) } });
  }
  if (message.id === 'ask-1') {
    record({ permission: message.result });
    // The tool runs only when the client picked the allow option.
    const allowed = message.result?.outcome?.optionId === 'yes';
    update('tool_call_update', { toolCallId: 't1', status: allowed ? 'completed' : 'failed' });
    say(allowed ? 'Ran it.' : 'I could not run it.');
    return send({ id: prompt, result: { stopReason: 'end_turn' } });
  }
});
`;

// A fake `openclaw` CLI. Behaviour per subcommand is chosen by FAKE_* keys.
// Its `acp` subcommand is the fake ACP harness above, so an OpenClaw turn is
// scripted the same way as any other harness's.
const FAKE_OPENCLAW = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
// The launcher gives OpenClaw a clean environment, so behaviour comes from a
// file beside this fake rather than from FAKE_* variables.
const behaviour = JSON.parse(fs.readFileSync(path.join(__dirname, 'behaviour.json'), 'utf8'));
const args = process.argv.slice(2);
const sub = args.slice(0, 2).join(' ');
const configPath = process.env.OPENCLAW_CONFIG_PATH;
fs.appendFileSync(behaviour.FAKE_LOG, JSON.stringify({
  args,
  pid: process.pid,
  cwd: process.cwd(),
  gatewayPort: process.env.OPENCLAW_GATEWAY_PORT ?? null,
  key: process.env.LITELLM_API_KEY ?? null,
  skips: Object.keys(process.env).filter((name) => name.startsWith('OPENCLAW_SKIP_')).sort(),
  config: configPath && fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : undefined,
}) + '\\n');
if (sub === 'config validate') {
  console.log(JSON.stringify({ valid: behaviour.FAKE_INVALID !== '1' }));
  process.exit(behaviour.FAKE_INVALID === '1' ? 1 : 0);
}
if (args[0] === 'doctor') {
  if (behaviour.FAKE_DOCTOR_SLEEP) { setTimeout(() => process.exit(0), Number(behaviour.FAKE_DOCTOR_SLEEP)); return; }
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  config.meta = { lastTouchedVersion: 'fake' };
  config.wizard = { lastRunAt: new Date().toISOString() };
  if (behaviour.FAKE_DOCTOR_WIDENS === '1') config.tools = { profile: 'coding' };
  // Doctor repairing a workspace the source names: the turn's directory.
  if (behaviour.FAKE_DOCTOR_REPAIRS_WORKSPACE === '1') {
    const ws = path.join(path.dirname(process.env.OPENCLAW_STATE_DIR), 'workspace');
    fs.mkdirSync(ws, { recursive: true });
    fs.writeFileSync(path.join(ws, 'AGENTS.md'), 'merged by doctor');
  }
  if (behaviour.FAKE_DOCTOR_NARROWS === '1') {
    config.skills = { entries: { gog: { enabled: false } } };
    config.agents.entries.helper = {};
  }
  fs.writeFileSync(configPath, JSON.stringify(config));
  process.exit(0);
}
if (sub === 'approvals set') process.exit(0);
if (sub === 'gateway run') {
  if (behaviour.FAKE_GATEWAY_EXIT) process.exit(Number(behaviour.FAKE_GATEWAY_EXIT));
  // A definition's logging and redaction settings decide what the Gateway
  // logs, so its log says nothing the launcher could go by. Only its
  // readiness probe does, a moment after it starts listening.
  console.log('[gateway] *** *** ***');
  console.error('[diagnostic] *** outcome=*** ***');
  const started = Date.now();
  const launched = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const flag = args.indexOf('--port');
  const port = Number(flag === -1 ? process.env.OPENCLAW_GATEWAY_PORT ?? launched.env?.vars?.OPENCLAW_GATEWAY_PORT ?? launched.gateway.port : args[flag + 1]);
  require('node:http').createServer((request, response) => {
    const ready = request.url === '/readyz' && Date.now() - started > 150 && !behaviour.FAKE_GATEWAY_NEVER_READY;
    response.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ready }));
  }).listen(port, '127.0.0.1');
  process.on('SIGTERM', () => process.exit(0));
  return;
}
if (sub === 'gateway call') {
  // The Gateway's record of its sessions: the one OpenClaw's ACP server
  // opened for the turn, once a prompt has reached it.
  if (behaviour.FAKE_CALL_EXIT) process.exit(Number(behaviour.FAKE_CALL_EXIT));
  const file = path.join(__dirname, 'gateway-session.json');
  const sessions = fs.existsSync(file) ? [JSON.parse(fs.readFileSync(file, 'utf8'))] : [];
  if (args[2] === 'agent.wait') {
    // The run's final reply as the Gateway records it: the reply alone.
    const { runId } = JSON.parse(args[args.indexOf('--params') + 1]);
    const session = sessions.find((row) => row.lastRunId === runId);
    if (!session || behaviour.FAKE_WAIT_EXIT) process.exit(1);
    console.log(JSON.stringify({ runId, status: 'ok', ...(session.disposition ? { terminalReply: { disposition: session.disposition } } : session.reply === undefined ? {} : { terminalReply: { disposition: 'visible', text: session.reply } }) }));
    process.exit(0);
  }
  console.log(JSON.stringify({ count: sessions.length, sessions: [{ key: 'agent:main:main', status: 'failed', lastRunId: 'r0' }, ...sessions.map(({ reply, disposition, ...row }) => row)] }));
  process.exit(0);
}
if (args[0] === 'acp') { require(path.join(__dirname, 'harness.cjs')); return; }
process.exit(64);
`;

const tool = (status, over = {}) => ({
  tool: { id: 't1', kind: 'execute', status, ...over },
});
// What a scripted harness does unless a test says otherwise: one tool call,
// then the answer.
const CLEAN_TURN = {
  steps: [
    tool('pending', { update: 'tool_call' }),
    tool('completed'),
    { say: 'All clear: disk at 41%.' },
  ],
};

async function fixture(overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'claw-job-'));
  const secretsDir = join(root, 'secrets');
  const workDir = join(root, 'work');
  await mkdir(join(secretsDir, 'env'), { recursive: true });
  await mkdir(workDir, { recursive: true });
  await writeFile(join(secretsDir, 'env', 'LITELLM_API_KEY'), 'sk-test\n');
  const openclaw = join(root, 'openclaw');
  await writeFile(openclaw, FAKE_OPENCLAW);
  await chmod(openclaw, 0o755);
  const behaviour = { FAKE_LOG: join(root, 'openclaw.log') };
  for (const [name, value] of Object.entries(overrides.env ?? {}))
    if (name.startsWith('FAKE_')) behaviour[name] = value;
  await writeFile(join(root, 'behaviour.json'), JSON.stringify(behaviour));
  const harness = join(root, 'harness.cjs');
  const harnessLogFile = join(root, 'harness.log');
  await writeFile(harness, FAKE_HARNESS);
  await writeFile(
    join(root, 'harness.json'),
    JSON.stringify({ log: harnessLogFile, ...(overrides.acp ?? CLEAN_TURN) }),
  );
  const calls = [];
  const brief = overrides.brief ?? agentBrief(agentFiles);
  const fetchImpl = async (url, init) => {
    const path = url.split(`/runs/${RUN_ID}/`)[1];
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ path, body, auth: init.headers.Authorization });
    const json = (value, status = 200) =>
      new Response(JSON.stringify(value), { status });
    if (path === 'heartbeat')
      return overrides.refuseHeartbeat
        ? json({ error: 'stale' }, 409)
        : json({ runId: RUN_ID, expiresAt: '2026-11-14T20:00:00Z' });
    if (path === 'brief') return json(brief);
    if (path === 'complete') return json({ ok: true });
    return json({}, 404);
  };
  const env = {
    PATH: process.env.PATH,
    HOME: join(root, 'home'),
    LCARS_CONSOLE_URL: 'https://console.test',
    LCARS_RUN_ID: RUN_ID,
    LCARS_RUN_TOKEN: 'run-token',
    OPENCLAW_BIN: openclaw,
    CLAW_SECRETS_DIR: secretsDir,
    CLAW_WORK_DIR: workDir,
    CLAW_HEARTBEAT_INTERVAL_MS: '3600000',
    FAKE_LOG: behaviour.FAKE_LOG,
    ...overrides.env,
  };
  const lines = async (file) =>
    (await readFile(file, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
  return {
    root,
    env,
    calls,
    fetchImpl,
    openclawLog: () => lines(behaviour.FAKE_LOG),
    harnessLog: () => lines(harnessLogFile),
    // `openclaw` is the image's own harness, over the fake binary; `claude`
    // stands for any other, started straight from the fake harness script.
    deps: {
      fetchImpl,
      harnesses: {
        claude: () => ({
          command: process.execPath,
          args: [harness],
          ...(overrides.auth ? { auth: overrides.auth } : {}),
          ...(overrides.defaultMode ? { mode: overrides.defaultMode } : {}),
        }),
      },
    },
  };
}

const completion = (calls) =>
  calls.find((call) => call.path === 'complete')?.body;
const gone = (pid) =>
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
const ran = (log) => log.map((entry) => entry.args.slice(0, 2).join(' '));

test('an OpenClaw turn runs its own ACP server behind a Gateway this run owns', async () => {
  const { env, calls, deps, openclawLog, harnessLog } = await fixture();
  const result = await main(env, deps);
  assert.deepEqual(result, {
    outcome: 'report',
    message: 'All clear: disk at 41%.',
  });
  assert.deepEqual(completion(calls), result);
  assert.deepEqual(
    calls.map((call) => call.path),
    ['heartbeat', 'brief', 'heartbeat', 'complete'],
  );
  assert.deepEqual(calls[0].body, {});
  assert.deepEqual(calls[2].body, { providerProcessStarted: true });
  assert.ok(calls.every((call) => call.auth === 'Bearer run-token'));
  const log = await openclawLog();
  assert.deepEqual(ran(log), [
    'config validate',
    'doctor --fix',
    'approvals set',
    'gateway run',
    'acp --url',
    // How the Gateway recorded the turn and its final reply, asked before
    // it is stopped.
    'gateway call',
    'gateway call',
  ]);
  assert.deepEqual(log[5].args, [
    'gateway',
    'call',
    'sessions.list',
    '--json',
    '--timeout',
    '20000',
  ]);
  assert.deepEqual(log[6].args, [
    'gateway',
    'call',
    'agent.wait',
    '--json',
    '--params',
    '{"runId":"r1","timeoutMs":0}',
    '--timeout',
    '20000',
  ]);
  assert.ok(log.every((entry) => entry.key === 'sk-test'));
  // The Gateway runs the reviewed config plus what only this run knows: its
  // workspace and a loopback, token-protected listener.
  const workspace = join(env.CLAW_WORK_DIR, 'workspace');
  const { config, pid } = log[3];
  assert.deepEqual(config.tools, {
    profile: 'minimal',
    fs: { workspaceOnly: true },
    exec: { mode: 'allowlist' },
  });
  assert.deepEqual(config.agents.defaults, {
    sandbox: { mode: 'off' },
    skipBootstrap: true,
    workspace,
    cwd: workspace,
  });
  assert.equal(config.agents.entries.main.workspace, workspace);
  assert.equal(config.gateway.mode, 'local');
  assert.equal(config.gateway.bind, 'loopback');
  assert.equal(config.gateway.auth.mode, 'token');
  assert.deepEqual(config.gateway.reload, { mode: 'off' });
  // It starts nothing but the turn: no channels, schedules or prewarm.
  assert.deepEqual(log[3].skips, [
    'OPENCLAW_SKIP_BROWSER_CONTROL_SERVER',
    'OPENCLAW_SKIP_CANVAS_HOST',
    'OPENCLAW_SKIP_CHANNELS',
    'OPENCLAW_SKIP_CRON',
    'OPENCLAW_SKIP_GMAIL_WATCHER',
    'OPENCLAW_SKIP_STARTUP_MODEL_PREWARM',
  ]);
  // It listens where the launcher says, on the flag and in the variable
  // OpenClaw reads before its config, and runs in the agent's workspace,
  // where OpenClaw reads a `.env`.
  assert.deepEqual(log[3].args, [
    'gateway',
    'run',
    '--port',
    String(config.gateway.port),
  ]);
  assert.equal(log[3].gatewayPort, String(config.gateway.port));
  assert.equal(log[3].cwd, workspace);
  // Whatever connects to it resolves the same port.
  assert.equal(log[4].gatewayPort, String(config.gateway.port));
  assert.equal(log[5].gatewayPort, String(config.gateway.port));
  // OpenClaw's ACP server is the agent, pointed at that Gateway.
  const acp = log[4].args;
  assert.equal(acp[2], `ws://127.0.0.1:${config.gateway.port}`);
  assert.equal(
    (await readFile(acp[acp.indexOf('--token-file') + 1], 'utf8')).trim(),
    config.gateway.auth.token,
  );
  assert.ok(acp.includes('--no-prefix-cwd'));
  // Nobody may give this Gateway commands: a `/word` in a message is text.
  assert.deepEqual(config.commands, { allowFrom: { '*': [] } });
  const harness = await harnessLog();
  const [initialize, session] = harness;
  assert.equal(initialize.token, null);
  assert.equal(session.session.cwd, workspace);
  // The turn keeps the ten minutes `agent exec` gave it, whatever timeout
  // the definition or the Gateway would otherwise apply.
  assert.deepEqual(harness.find((entry) => entry.prompt).promptMeta, {
    timeoutMs: 600_000,
  });
  // The Gateway does not outlive the turn.
  gone(pid);
});

test('no provider work starts before the startup heartbeat is acknowledged', async () => {
  const { env, calls, fetchImpl } = await fixture({ refuseHeartbeat: true });
  await assert.rejects(main(env, { fetchImpl }), /HTTP 409/);
  assert.deepEqual(
    calls.map((call) => call.path),
    ['heartbeat'],
  );
  await assert.rejects(readFile(env.FAKE_LOG, 'utf8'), { code: 'ENOENT' });
});

test('an invalid pinned config fails closed before the Gateway starts', async () => {
  const { env, calls, deps, openclawLog } = await fixture({
    env: { FAKE_INVALID: '1' },
  });
  const result = await main(env, deps);
  assert.deepEqual(result, {
    outcome: 'runner-failed',
    message: 'Claw setup failed: pinned OpenClaw config failed validation.',
  });
  assert.deepEqual(completion(calls), result);
  assert.deepEqual(ran(await openclawLog()), ['config validate']);
});

test('a Doctor change that would widen the agent fails closed, naming it', async () => {
  const { env, calls, deps, openclawLog } = await fixture({
    env: { FAKE_DOCTOR_WIDENS: '1' },
  });
  const result = await main(env, deps);
  assert.equal(result.outcome, 'runner-failed');
  assert.match(
    result.message,
    /beyond narrowing it: tools\.exec\.mode, tools\.profile\.$/,
  );
  assert.deepEqual(ran(await openclawLog()), [
    'config validate',
    'doctor --fix',
  ]);
  assert.deepEqual(completion(calls), result);
});

test("an un-normalized source config runs Doctor's accepted changes, without its skill toggles", async () => {
  const { env, calls, deps, openclawLog } = await fixture({
    env: { FAKE_DOCTOR_NARROWS: '1' },
  });
  const result = await main(env, deps);
  assert.equal(result.outcome, 'report');
  assert.deepEqual(completion(calls), result);
  const [validate, doctor, , gateway] = await openclawLog();
  // Validation and Doctor see the source as written: the launcher supplies
  // no workspace, so Doctor's repairs never touch the turn's.
  for (const entry of [validate, doctor]) {
    assert.equal(entry.config.agents.entries.main.workspace, '/repo/workspace');
    assert.equal(entry.config.agents.defaults, undefined);
    assert.equal(entry.config.gateway, undefined);
  }
  // The turn keeps Doctor's accepted change (an empty agent entry) but not
  // its skill toggle: OpenClaw gates skills at load time in the turn itself.
  assert.deepEqual(gateway.config.agents.entries.helper, {
    workspace: join(env.CLAW_WORK_DIR, 'workspace'),
  });
  assert.deepEqual(gateway.config.skills, { load: { watch: false } });
});

test("Doctor's repairs to the turn's directory never reach the turn", async () => {
  const { env, deps } = await fixture({
    env: { FAKE_DOCTOR_REPAIRS_WORKSPACE: '1' },
  });
  const result = await main(env, deps);
  assert.equal(result.outcome, 'report');
  const workspace = join(env.CLAW_WORK_DIR, 'workspace');
  assert.equal(
    await readFile(join(workspace, 'AGENTS.md'), 'utf8'),
    '# repository agent\n',
  );
  assert.ok((await stat(join(workspace, 'tools'))).isDirectory());
});

test('a bare OpenClaw command resolves through PATH', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claw-path-'));
  const bin = join(root, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'openclaw'), '');
  await chmod(join(bin, 'openclaw'), 0o755);
  // A non-executable file earlier on PATH is skipped, as spawn skips it.
  const shadow = join(root, 'shadow');
  await mkdir(shadow);
  await writeFile(join(shadow, 'openclaw'), '');
  assert.equal(
    await resolveCommand('openclaw', `/nonexistent:${shadow}:${bin}`),
    join(bin, 'openclaw'),
  );
  assert.equal(await resolveCommand('/abs/openclaw', ''), '/abs/openclaw');
  await assert.rejects(
    resolveCommand('openclaw', '/nonexistent'),
    /not found on PATH/,
  );
  assert.deepEqual(await bundledPluginProviders('openclaw', bin), new Map());
});

test('turnConfig restores the source skill settings', () => {
  assert.deepEqual(
    turnConfig(
      { skills: { entries: { tmux: { enabled: true } } } },
      {
        skills: {
          entries: { tmux: { enabled: false }, gog: { enabled: false } },
        },
        plugins: { entries: { litellm: { enabled: true } } },
      },
    ),
    {
      skills: { entries: { tmux: { enabled: true } } },
      plugins: { entries: { litellm: { enabled: true } } },
    },
  );
  assert.deepEqual(
    turnConfig({}, { skills: { entries: { gog: { enabled: false } } } }),
    {},
  );
});

test('plugin ownership comes from the bundled plugin manifests', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claw-plugins-'));
  const bin = join(root, 'openclaw.mjs');
  await writeFile(bin, '');
  for (const [id, manifest] of [
    [
      'google',
      {
        id: 'google',
        providers: ['google'],
        autoEnableWhenConfiguredProviders: ['google-vertex'],
      },
    ],
    ['litellm', { id: 'litellm', providers: ['litellm'] }],
  ]) {
    await mkdir(join(root, 'dist', 'extensions', id), { recursive: true });
    await writeFile(
      join(root, 'dist', 'extensions', id, 'openclaw.plugin.json'),
      JSON.stringify(manifest),
    );
  }
  await mkdir(join(root, 'dist', 'extensions', 'no-manifest'));
  assert.deepEqual(
    await bundledPluginProviders(bin),
    new Map([
      ['google', new Set(['google', 'google-vertex'])],
      ['litellm', new Set(['litellm'])],
    ]),
  );
});

test("Doctor's skill toggles are ignored; plugins only for declared providers", () => {
  const owners = new Map([
    ['litellm', new Set(['litellm'])],
    ['google', new Set(['google', 'google-vertex'])],
  ]);
  const source = {
    models: { providers: { litellm: { baseUrl: 'https://llm.test' } } },
    tools: { profile: 'minimal', deny: ['exec'] },
    skills: { entries: { tmux: { enabled: true } } },
  };
  const narrowed = {
    ...source,
    meta: { lastTouchedVersion: 'x' },
    wizard: { lastRunAt: 'now' },
    plugins: { entries: { litellm: { enabled: true } } },
    skills: { entries: { tmux: { enabled: false }, gog: { enabled: false } } },
    agents: { entries: { main: {} } },
  };
  assert.deepEqual(doctorChanges(source, narrowed, owners), []);
  assert.deepEqual(
    doctorChanges(
      source,
      {
        ...narrowed,
        plugins: {
          entries: { litellm: { enabled: true }, browser: { enabled: true } },
        },
        skills: {
          entries: { tmux: { enabled: true }, gog: { enabled: true } },
        },
        tools: { profile: 'minimal', deny: [] },
        agents: { entries: { main: { tools: { profile: 'coding' } } } },
        gateway: {},
      },
      owners,
    ),
    [
      'agents.entries.main.tools.profile',
      'gateway',
      'plugins.entries.browser.enabled',
      'tools.deny',
    ],
  );
  // Explicit empty maps may be filled with allowed entries, but a new empty
  // section is still a change.
  const empty = {
    ...source,
    plugins: { entries: {} },
    skills: { entries: {} },
    agents: { entries: {} },
  };
  assert.deepEqual(doctorChanges(empty, narrowed, owners), []);
  assert.deepEqual(doctorChanges(source, { ...source, gateway: {} }, owners), [
    'gateway',
  ]);
  // OpenClaw matches provider IDs case-insensitively.
  const upper = { models: { providers: { LITELLM: {} } } };
  assert.deepEqual(
    doctorChanges(
      upper,
      { ...upper, plugins: { entries: { litellm: { enabled: true } } } },
      owners,
    ),
    [],
  );
  // A provider owned by a differently named plugin (google-vertex → google).
  const vertex = { models: { providers: { 'google-vertex': {} } } };
  assert.deepEqual(
    doctorChanges(
      vertex,
      { ...vertex, plugins: { entries: { google: { enabled: true } } } },
      owners,
    ),
    [],
  );
  // A plugin the source disabled stays disabled; Doctor removing settings is
  // a change too.
  const disabled = {
    ...source,
    plugins: { entries: { litellm: { enabled: false } } },
  };
  assert.deepEqual(
    doctorChanges(
      disabled,
      {
        ...disabled,
        plugins: { entries: { litellm: { enabled: true } } },
      },
      owners,
    ),
    ['plugins.entries.litellm.enabled'],
  );
  assert.deepEqual(
    doctorChanges(
      source,
      { models: source.models, skills: source.skills },
      owners,
    ),
    ['tools.deny', 'tools.profile'],
  );
});

test('a Gateway that never becomes ready fails closed before the turn', async () => {
  const { env, calls, deps, openclawLog } = await fixture({
    env: { FAKE_GATEWAY_EXIT: '3' },
  });
  const result = await main(env, deps);
  assert.deepEqual(result, {
    outcome: 'runner-failed',
    message:
      'Claw setup failed: OpenClaw Gateway exited 3 before it was ready.',
  });
  assert.deepEqual(completion(calls), result);
  assert.ok(!ran(await openclawLog()).includes('acp --url'));
  // A Gateway that keeps running and logging but never answers its
  // readiness probe is stopped by the run's deadline.
  const stuck = await fixture({
    env: { FAKE_GATEWAY_NEVER_READY: '1', CLAW_TURN_DEADLINE_SECONDS: '2' },
  });
  assert.equal((await main(stuck.env, stuck.deps)).outcome, 'runner-failed');
  assert.ok(!ran(await stuck.openclawLog()).includes('acp --url'));
  // No provider work was reported.
  assert.ok(!calls.some((call) => call.body?.providerProcessStarted));
});

test('a brief for another pipeline is refused', async () => {
  const { env, fetchImpl } = await fixture({
    brief: { intentId: RUN_ID, pipeline: 'claude', mode: 'implement' },
  });
  const result = await main(env, { fetchImpl });
  assert.equal(result.outcome, 'runner-failed');
  assert.match(result.message, /not a claw run/);
});

test('a denied OpenClaw tool call fails the attempt', async () => {
  const { env, deps } = await fixture({
    acp: {
      steps: [
        tool('pending', { update: 'tool_call' }),
        tool('failed'),
        { say: 'Both commands were refused.' },
      ],
    },
  });
  assert.deepEqual(await main(env, deps), {
    outcome: 'runner-failed',
    message: 'Claw turn failed: unresolved execute tool call.',
  });
});

test('an agent that rewrites the Gateway config loses its report', async () => {
  const { env, deps } = await fixture({
    acp: { ...CLEAN_TURN, tamperConfig: true },
  });
  assert.deepEqual(await main(env, deps), {
    outcome: 'runner-failed',
    message:
      'Claw turn failed: the agent changed its harness settings (OpenClaw config).',
  });
});

test('a turn the Gateway recorded as failed is never a report', async () => {
  // OpenClaw's ACP server ends a failed turn like any other, even after part
  // of an answer has streamed.
  const { env, deps } = await fixture({
    acp: {
      gatewayError: true,
      steps: [
        tool('pending', { update: 'tool_call' }),
        tool('completed'),
        { say: 'The disk is' },
      ],
    },
  });
  assert.deepEqual(await main(env, deps), {
    outcome: 'runner-failed',
    message: 'Claw turn failed: OpenClaw reported the turn as failed.',
  });
});

test("OpenClaw's commentary is not part of the report", async () => {
  // OpenClaw's ACP server sends what the agent says on the way and its
  // final answer as the same message text, with nothing between them when
  // no tool ran. The Gateway's record of the final reply says where the
  // answer begins.
  const report = async (acp, fake) => {
    const { env, deps } = await fixture({
      acp,
      env: fake,
      brief: agentBrief(agentFiles, { requireToolEvidence: false }),
    });
    return main(env, deps);
  };
  const steps = [{ say: 'Checking files now' }, { say: 'Done.' }];
  assert.deepEqual(await report({ steps, terminalReply: 'Done.' }), {
    outcome: 'report',
    message: 'Done.',
  });
  // With no record of the reply, the stream is all there is to go by.
  assert.deepEqual(await report({ steps }), {
    outcome: 'report',
    message: 'Checking files nowDone.',
  });
  assert.deepEqual(
    await report({ steps, terminalReply: 'Done.' }, { FAKE_WAIT_EXIT: '1' }),
    { outcome: 'report', message: 'Checking files nowDone.' },
  );
  // A run the Gateway recorded as ending silent, or with no reply, has no
  // answer: what the agent said on the way is not one.
  for (const terminalDisposition of ['silent', 'empty'])
    assert.deepEqual(
      await report({
        steps: [{ say: 'Checking files now' }],
        terminalDisposition,
      }),
      { outcome: 'runner-failed', message: 'Claw turn failed: empty result.' },
    );
});

test('answerText finds the answer in what OpenClaw streamed', () => {
  // The whole stream is the answer, or ends with it.
  assert.equal(answerText('Done.', 'Done.'), 'Done.');
  assert.equal(answerText('Checking files nowDone.\n', 'Done.'), 'Done.\n');
  // A long reply is recorded cut short, with a marker: the answer begins
  // where the recorded part first appears, and is taken whole.
  const answer = `Report:${' line'.repeat(2000)}`;
  assert.equal(
    answerText(`Looking.${answer}`, `${answer.slice(0, 4095)}…`),
    answer,
  );
  // A recorded part that appears more than once, because the answer
  // repeats a passage the agent had already shown, places nothing.
  const table = `Evidence:${' row'.repeat(1500)}`;
  assert.equal(
    answerText(
      `${table} Checking.${table} Verdict.`,
      `${table.slice(0, 4095)}…`,
    ),
    undefined,
  );
  // So does an answer that repeats its own beginning at its end and ends
  // with the marker: the record fits the whole answer and its last part.
  const repeated = `${'p'.repeat(4095)}${'q'.repeat(30)}${'p'.repeat(4095)}…`;
  assert.equal(answerText(repeated, `${'p'.repeat(4095)}…`), undefined);
  // The cut is OpenClaw's: never between the halves of a surrogate pair,
  // and without the whitespace before it.
  const emoji = `${'x'.repeat(4094)}😀${'y'.repeat(500)}`;
  assert.equal(answerText(`Looking.${emoji}`, `${'x'.repeat(4094)}…`), emoji);
  const spaced = `${'x'.repeat(4000)}${' '.repeat(200)}tail`;
  assert.equal(answerText(`Looking.${spaced}`, `${'x'.repeat(4000)}…`), spaced);
  // A beginning the Gateway would not have recorded that way places nothing.
  assert.equal(
    answerText(`Looking.${'x'.repeat(5000)}`, `${'x'.repeat(100)}…`),
    `Looking.${'x'.repeat(5000)}`,
  );
  // A reply that itself ends with the marker is still a whole reply.
  assert.equal(
    answerText('Hm.More to come…', 'More to come…'),
    'More to come…',
  );
  // A reply that cannot be placed, or none, leaves the stream as it is.
  assert.equal(answerText('Checking.Done.', 'Finished.'), 'Checking.Done.');
  assert.equal(answerText('Checking.Done.', undefined), 'Checking.Done.');
  assert.equal(answerText('Checking.Done.', ''), 'Checking.Done.');
});

test('a config string that names a credential is resolved whole', () => {
  // A value written in can join the text around it into a template that
  // was not there, or turn the next one into an escape. The string is
  // resolved as OpenClaw would have in one pass and written as literal
  // text; a template only OpenClaw can resolve stays one.
  const template = (name) => '$' + `{${name}}`;
  const auth = {
    names: new Set(['LITELLM_API_KEY']),
    candidates: new Map([['litellm', ['LITELLM_API_KEY']]]),
  };
  const header = (key, text) =>
    resolveCredentials(
      {
        models: {
          providers: { litellm: { apiKey: 'x', headers: { h: text } } },
        },
      },
      { LITELLM_API_KEY: key, SUFFIX: 'modified' },
      auth,
    ).config.models.providers.litellm.headers.h;
  const KEY = template('LITELLM_API_KEY');
  // A key ending in `$` before another variable: both are written in, and
  // the join that would read as an escape is itself escaped.
  assert.equal(header('k$', `${KEY}${template('SUFFIX')}`), 'k$modified');
  // A key ending in `$` before literal braces would become a template.
  assert.equal(header('k$', `${KEY}{SUFFIX}`), `k$${template('SUFFIX')}`);
  // A variable only OpenClaw's environment holds stays its to resolve,
  // default included: the workspace's `.env` may still set it.
  assert.equal(
    header('k', `${KEY}-${template('ONLY_IN_GATEWAY')}`),
    `k-${template('ONLY_IN_GATEWAY')}`,
  );
  assert.equal(
    header('k', `${KEY}:${template('REPORT_REGION:-dev')}`),
    `k:${template('REPORT_REGION:-dev')}`,
  );
  // An escaped template stays the text it stands for, and every variable a
  // provider's header names counts as a credential, so it is written in.
  assert.equal(
    header('k', `$${KEY} ${template('SUFFIX')}`),
    `$${KEY} modified`,
  );
  // A string that names no variable the launcher withholds is untouched.
  assert.equal(
    header('k', `$${KEY} ${template('ONLY_IN_GATEWAY')}`),
    `$${KEY} ${template('ONLY_IN_GATEWAY')}`,
  );
});

test('a long OpenClaw reply that repeats what the agent already showed is no report', async () => {
  // The Gateway records a long reply cut short. When that part also appears
  // in what the agent said before, where the answer begins cannot be told.
  const table = `Evidence:${' row'.repeat(1500)}`;
  const { env, deps } = await fixture({
    acp: {
      steps: [{ say: `${table} Checking.` }, { say: `${table} Verdict.` }],
      terminalReply: `${table.slice(0, 4095)}…`,
    },
    brief: agentBrief(agentFiles, { requireToolEvidence: false }),
  });
  assert.deepEqual(await main(env, deps), {
    outcome: 'runner-failed',
    message:
      "Claw turn failed: OpenClaw's final reply could not be told from what preceded it.",
  });
});

test("only the Gateway's own record of the session passes a turn", async () => {
  const outcome = async (acp, fake = {}) => {
    const { env, deps } = await fixture({ acp, env: fake });
    return main(env, deps);
  };
  const failed = (reason) => ({
    outcome: 'runner-failed',
    message: `Claw turn failed: ${reason}.`,
  });
  // Any last run but a finished one is a failed turn; OpenClaw's own text
  // for it is never repeated.
  for (const sessionStatus of ['failed', 'timeout', 'killed', 'interrupted'])
    assert.deepEqual(
      await outcome({ ...CLEAN_TURN, sessionStatus }),
      failed('OpenClaw reported the turn as failed'),
    );
  // A run that never stops being recorded is not a finished one either.
  assert.deepEqual(
    await outcome({ ...CLEAN_TURN, sessionStatus: 'running' }),
    failed('OpenClaw reported the turn as failed'),
  );
  // No record of this turn's session, or no answer at all, is no report.
  assert.deepEqual(
    await outcome({ ...CLEAN_TURN, sessionKey: 'another' }),
    failed("OpenClaw did not report the turn's outcome"),
  );
  assert.deepEqual(
    await outcome(CLEAN_TURN, { FAKE_CALL_EXIT: '1' }),
    failed("OpenClaw did not report the turn's outcome"),
  );
});

test('a model credential the config names stays out of what host commands inherit', async () => {
  const files = {
    ...agentFiles,
    'config.json': {
      content: JSON.stringify({
        models: {
          providers: {
            litellm: {
              apiKey: {
                source: 'env',
                provider: 'default',
                id: 'LITELLM_API_KEY',
              },
            },
          },
        },
      }),
    },
  };
  const { env, deps, openclawLog } = await fixture({
    brief: agentBrief(files),
  });
  assert.equal((await main(env, deps)).outcome, 'report');
  const [validate, doctor, approvals, gateway, acp] = await openclawLog();
  // OpenClaw's own setup commands read the key from the environment.
  for (const entry of [validate, doctor, approvals])
    assert.equal(entry.key, 'sk-test');
  // The Gateway, whose environment every host command inherits, and its ACP
  // server do not have it; the launch config carries it instead.
  assert.equal(gateway.key, null);
  assert.equal(acp.key, null);
  assert.equal(gateway.config.models.providers.litellm.apiKey, 'sk-test');
});

test('resolveCredentials resolves what the config names and what providers read', () => {
  const env = {
    PATH: '/bin',
    MODEL_KEY: 'k1',
    LITELLM_API_KEY: 'k2',
    OPENAI_API_KEY: 'k3',
    CODEX_API_KEY: 'k4',
    CUSTOM_MODEL_KEY: 'k5',
    ANTHROPIC_OAUTH_TOKEN: '',
    ANTHROPIC_API_KEY: 'k6',
    ZONE_SETTING: 'visible',
    REFUSED_KEY: 'k7',
  };
  // As OpenClaw answers: every name it filters, and each provider's own
  // variables in the order it tries them.
  const auth = {
    names: new Set([
      'LITELLM_API_KEY',
      'OPENAI_API_KEY',
      'CODEX_API_KEY',
      'ANTHROPIC_OAUTH_TOKEN',
      'ANTHROPIC_API_KEY',
    ]),
    candidates: new Map([
      ['litellm', ['LITELLM_API_KEY']],
      ['openai', ['CODEX_API_KEY', 'OPENAI_API_KEY']],
      ['anthropic', ['ANTHROPIC_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']],
    ]),
  };
  const template = (name) => '$' + `{${name}}`;
  const { config, used } = resolveCredentials(
    {
      models: {
        providers: {
          // Named by reference, and again in a header template.
          custom: {
            apiKey: { source: 'env', provider: 'default', id: 'MODEL_KEY' },
            headers: {
              'x-key': `Bearer ${template('MODEL_KEY')}`,
              literal: `$${template('MODEL_KEY')}`,
            },
          },
          // A custom name, given only as a template, with a default that
          // must not win over the key the environment holds.
          templated: { apiKey: '$' + '{CUSTOM_MODEL_KEY:-fallback}' },
          // Its first variable is empty, so OpenClaw uses the next one; and
          // an empty credential in a template is left for OpenClaw's default.
          anthropic: {
            headers: { 'x-beta': '$' + '{ANTHROPIC_OAUTH_TOKEN:-none}' },
          },
          // Not named at all: the key OpenClaw would have found by itself.
          LiteLLM: { baseUrl: 'https://llm.test' },
          // Its key is used in a header, and it still relies on finding its
          // own key for `apiKey`: the first of its variables that is set.
          openai: {
            headers: { 'x-secondary': { source: 'env', id: 'OPENAI_API_KEY' } },
          },
          other: {
            apiKey: { source: 'env', id: 'MISSING' },
            // Not a credential: OpenClaw resolves it, and tools keep it.
            baseUrl: template('ZONE_SETTING'),
          },
          vault: {
            apiKey: { source: 'file', provider: 'vault', id: 'MODEL_KEY' },
          },
        },
      },
      // Not a reference: it has a field of its own.
      tools: { source: 'env', id: 'MODEL_KEY', profile: 'coding' },
      path: { source: 'env', id: 'PATH' },
      secrets: {
        providers: {
          narrow: { source: 'env', allowlist: ['MODEL_KEY'] },
          files: { source: 'file', path: '/secrets.json' },
        },
      },
      // References OpenClaw itself would refuse are left for it to refuse:
      // a name outside the provider's allowlist, a provider that is not an
      // `env` provider, and one that is not declared.
      refused: [
        { source: 'env', provider: 'narrow', id: 'REFUSED_KEY' },
        { source: 'env', provider: 'files', id: 'REFUSED_KEY' },
        { source: 'env', provider: 'undeclared', id: 'REFUSED_KEY' },
      ],
      // The same provider serves a name on its list.
      served: { source: 'env', provider: 'narrow', id: 'MODEL_KEY' },
    },
    env,
    auth,
  );
  assert.deepEqual(config, {
    models: {
      providers: {
        custom: {
          apiKey: 'k1',
          headers: {
            'x-key': 'Bearer k1',
            literal: `$${template('MODEL_KEY')}`,
          },
        },
        templated: { apiKey: 'k5' },
        anthropic: {
          headers: { 'x-beta': '$' + '{ANTHROPIC_OAUTH_TOKEN:-none}' },
          apiKey: 'k6',
        },
        LiteLLM: { baseUrl: 'https://llm.test', apiKey: 'k2' },
        openai: { headers: { 'x-secondary': 'k3' }, apiKey: 'k4' },
        other: {
          apiKey: { source: 'env', id: 'MISSING' },
          baseUrl: template('ZONE_SETTING'),
        },
        vault: {
          apiKey: { source: 'file', provider: 'vault', id: 'MODEL_KEY' },
        },
      },
    },
    tools: { source: 'env', id: 'MODEL_KEY', profile: 'coding' },
    path: { source: 'env', id: 'PATH' },
    secrets: {
      providers: {
        narrow: { source: 'env', allowlist: ['MODEL_KEY'] },
        files: { source: 'file', path: '/secrets.json' },
      },
    },
    refused: [
      { source: 'env', provider: 'narrow', id: 'REFUSED_KEY' },
      { source: 'env', provider: 'files', id: 'REFUSED_KEY' },
      { source: 'env', provider: 'undeclared', id: 'REFUSED_KEY' },
    ],
    served: 'k1',
  });
  // Every credential the environment holds is withheld from the Gateway,
  // whether or not this config uses it, and so is one named by a reference
  // OpenClaw would refuse; nothing else is.
  assert.deepEqual([...used].sort(), [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_OAUTH_TOKEN',
    'CODEX_API_KEY',
    'CUSTOM_MODEL_KEY',
    'LITELLM_API_KEY',
    'MODEL_KEY',
    'OPENAI_API_KEY',
    'REFUSED_KEY',
  ]);
});

test('resolveCredentials gives a provider the key OpenClaw would have found for it', () => {
  // A blank key is no key to OpenClaw, and a key that is only the name of a
  // credential variable is its marker for that variable: either way the
  // provider read the environment, which no longer holds the credential.
  const auth = {
    names: new Set(['LITELLM_API_KEY', 'OPENAI_API_KEY']),
    candidates: new Map([
      ['litellm', ['LITELLM_API_KEY']],
      ['openai', ['OPENAI_API_KEY']],
    ]),
  };
  const { config, used } = resolveCredentials(
    {
      models: {
        providers: {
          litellm: { apiKey: '  ' },
          openai: { apiKey: 'OPENAI_API_KEY' },
          // An explicit key stays the definition's, even one that looks
          // like a variable nobody set.
          custom: { apiKey: 'NOT_A_VARIABLE' },
        },
      },
    },
    { LITELLM_API_KEY: 'k1', OPENAI_API_KEY: 'k2' },
    auth,
  );
  assert.deepEqual(config.models.providers, {
    litellm: { apiKey: 'k1' },
    openai: { apiKey: 'k2' },
    custom: { apiKey: 'NOT_A_VARIABLE' },
  });
  assert.deepEqual([...used].sort(), ['LITELLM_API_KEY', 'OPENAI_API_KEY']);
});

test('resolveCredentials writes a credential so OpenClaw loads it unchanged', () => {
  // OpenClaw substitutes templates in every config string it loads, the
  // resolved ones included. A key that happens to contain one is written
  // with OpenClaw's escape, so it arrives as the key it is.
  const template = (name) => '$' + `{${name}}`;
  const auth = {
    names: new Set(['LITELLM_API_KEY']),
    candidates: new Map([['litellm', ['LITELLM_API_KEY']]]),
  };
  const written = (key, provider) =>
    resolveCredentials(
      { models: { providers: { litellm: provider } } },
      { LITELLM_API_KEY: key, SUFFIX: 'modified' },
      auth,
    ).config.models.providers.litellm;
  const key = `test-token-${template('SUFFIX')}`;
  const escaped = `test-token-$${template('SUFFIX')}`;
  const reference = {
    source: 'env',
    provider: 'default',
    id: 'LITELLM_API_KEY',
  };
  assert.deepEqual(written(key, { apiKey: reference }), { apiKey: escaped });
  assert.deepEqual(written(key, { apiKey: template('LITELLM_API_KEY') }), {
    apiKey: escaped,
  });
  assert.deepEqual(written(key, {}), { apiKey: escaped });
  assert.deepEqual(written(key, { apiKey: 'LITELLM_API_KEY' }), {
    apiKey: escaped,
  });
  assert.deepEqual(
    written(key, {
      headers: { authorization: `Bearer ${template('LITELLM_API_KEY')}` },
    }),
    { headers: { authorization: `Bearer ${escaped}` }, apiKey: escaped },
  );
  // A key that already holds the escape keeps it, one `$` deeper.
  assert.deepEqual(written(`a$${template('SUFFIX')}b`, {}), {
    apiKey: `a$$${template('SUFFIX')}b`,
  });
  // A template the definition wrote for another variable is still
  // OpenClaw's to resolve.
  assert.deepEqual(
    written('k1', { apiKey: reference, baseUrl: template('SUFFIX') }),
    { apiKey: 'k1', baseUrl: template('SUFFIX') },
  );
});

test("a definition's own env cannot move this run's Gateway", () => {
  const launched = launchConfig(
    {
      env: {
        vars: {
          OPENCLAW_GATEWAY_PORT: '18789',
          OPENCLAW_GATEWAY_TOKEN: 'theirs',
          REPORT_REGION: 'west',
        },
      },
    },
    { workspace: '/work/workspace', port: 4242, token: 't' },
  );
  assert.deepEqual(launched.env.vars, { REPORT_REGION: 'west' });
  assert.equal(launched.gateway.port, 4242);
});

test('resolveCredentials keeps credentials out of the variables a config defines', () => {
  // OpenClaw adds the config's own `env` to its process environment, after
  // the launcher has filtered that environment.
  const template = (name) => '$' + `{${name}}`;
  const auth = {
    names: new Set(['LITELLM_API_KEY', 'OPENROUTER_API_KEY']),
    candidates: new Map([
      ['litellm', ['LITELLM_API_KEY']],
      ['openrouter', ['OPENROUTER_API_KEY']],
    ]),
  };
  const { config, used } = resolveCredentials(
    {
      env: {
        shellEnv: { enabled: false },
        // The older layout: a string directly under `env`.
        LITELLM_API_KEY: template('LITELLM_API_KEY'),
        vars: {
          // A credential the config supplies itself.
          OPENROUTER_API_KEY: 'sk-or-literal',
          // A credential under another name.
          GATEWAY_HEADER: `Bearer ${template('LITELLM_API_KEY')}`,
          // Not a credential: tools keep it, as written.
          REGION: template('ZONE'),
        },
      },
      models: {
        providers: {
          litellm: { headers: { authorization: template('GATEWAY_HEADER') } },
          openrouter: { baseUrl: 'https://openrouter.test' },
        },
      },
    },
    { PATH: '/bin', LITELLM_API_KEY: 'k1', ZONE: 'west' },
    auth,
  );
  assert.deepEqual(config, {
    env: { shellEnv: { enabled: false }, vars: { REGION: template('ZONE') } },
    models: {
      providers: {
        // Each provider still gets its key, from wherever it was defined.
        litellm: { headers: { authorization: 'Bearer k1' }, apiKey: 'k1' },
        openrouter: {
          baseUrl: 'https://openrouter.test',
          apiKey: 'sk-or-literal',
        },
      },
    },
  });
  assert.deepEqual([...used].sort(), [
    'GATEWAY_HEADER',
    'LITELLM_API_KEY',
    'OPENROUTER_API_KEY',
  ]);
});

test("provider credential names are OpenClaw's own answer", async () => {
  const root = await mkdtemp(join(tmpdir(), 'claw-auth-env-'));
  const bin = join(root, 'openclaw.mjs');
  await writeFile(bin, '');
  // A distribution without the SDK entry names nothing.
  assert.deepEqual(await providerAuthEnv(bin, { env: { PATH: '' } }), {
    names: new Set(),
    candidates: new Map(),
  });
  await mkdir(join(root, 'dist', 'plugin-sdk'), { recursive: true });
  const sdk = join(root, 'dist', 'plugin-sdk', 'provider-env-vars.js');
  await writeFile(
    sdk,
    `export const listKnownProviderAuthEnvVarNames = ({ env }) =>
  ['LITELLM_API_KEY', 'CODEX_API_KEY', env.EXTRA].filter(Boolean);
export const resolveProviderAuthEnvVarCandidates = () => ({
  LiteLLM: ['LITELLM_API_KEY'],
  openai: ['CODEX_API_KEY', 'OPENAI_API_KEY'],
});
`,
  );
  assert.deepEqual(
    await providerAuthEnv(bin, { env: { PATH: '', EXTRA: 'VOYAGE_API_KEY' } }),
    {
      names: new Set(['LITELLM_API_KEY', 'CODEX_API_KEY', 'VOYAGE_API_KEY']),
      candidates: new Map([
        ['litellm', ['LITELLM_API_KEY']],
        ['openai', ['CODEX_API_KEY', 'OPENAI_API_KEY']],
      ]),
    },
  );
  // An answer that cannot be read fails the attempt: guessing the set would
  // hand a command a key it must not have.
  await writeFile(sdk, 'export const nothing = 1;\n');
  await assert.rejects(
    providerAuthEnv(bin, { env: { PATH: '' } }),
    /did not list its provider credentials/,
  );
});

test('the outer deadline stops an OpenClaw turn and its Gateway', async () => {
  const { env, deps, openclawLog } = await fixture({
    acp: { hang: true },
    env: { CLAW_TURN_DEADLINE_SECONDS: '2' },
  });
  assert.deepEqual(await main(env, deps), {
    outcome: 'runner-failed',
    message: 'Claw turn exceeded its deadline.',
  });
  for (const entry of (await openclawLog()).slice(3)) gone(entry.pid);
});

test('reserved or malformed secret env names are refused', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claw-secrets-'));
  await mkdir(join(root, 'env'));
  await writeFile(join(root, 'env', 'LCARS_RUN_TOKEN'), 'x');
  await assert.rejects(secretEnvironment(root), /not allowed/);
  assert.deepEqual(await secretEnvironment(join(root, 'missing')), {});
});

test('comparableConfig ignores only meta and wizard stamps', () => {
  assert.equal(
    comparableConfig({
      b: 1,
      a: { d: 2, c: 3 },
      meta: { x: 1 },
      wizard: { y: 2 },
    }),
    comparableConfig({ a: { c: 3, d: 2 }, b: 1 }),
  );
  assert.notEqual(comparableConfig({ a: 1 }), comparableConfig({ a: 2 }));
});

test('launchConfig runs the reviewed config under headless defaults and this run', () => {
  const run = { workspace: '/work/workspace', port: 4242, token: 't' };
  const gateway = {
    mode: 'local',
    bind: 'loopback',
    port: 4242,
    auth: { mode: 'token', token: 't', allowTailscale: false },
    tailscale: { mode: 'off' },
    reload: { mode: 'off' },
  };
  // A source that says nothing gets what `agent exec` gave a headless turn:
  // file tools confined to the workspace and the coding profile, not every
  // tool.
  assert.deepEqual(launchConfig({}, run), {
    env: { shellEnv: { enabled: false } },
    agents: {
      defaults: {
        sandbox: { mode: 'off' },
        workspace: '/work/workspace',
        cwd: '/work/workspace',
        skipBootstrap: true,
      },
    },
    tools: {
      profile: 'coding',
      fs: { workspaceOnly: true },
      exec: { mode: 'full' },
    },
    skills: { load: { watch: false } },
    commands: { allowFrom: { '*': [] } },
    gateway,
  });
  const launched = launchConfig(
    {
      agents: {
        defaults: {
          skipBootstrap: false,
          model: { primary: 'm' },
          cwd: '/tmp',
        },
        entries: {
          main: {
            workspace: '/repo/workspace',
            cwd: '/tmp',
            agentDir: '/repo/agent',
            runtime: { type: 'acp', acp: { agent: 'codex', cwd: '/repo' } },
          },
          helper: null,
        },
      },
      tools: { profile: 'minimal', fs: { workspaceOnly: false } },
      session: { store: '/repo/sessions', scope: 'per-sender' },
      logging: { consoleLevel: 'silent', consoleStyle: 'json', level: 'debug' },
      diagnostics: { enabled: false, flags: ['x'] },
      commands: {
        text: true,
        allowFrom: { internal: ['*'], webchat: ['someone'], '*': ['anyone'] },
      },
      gateway: {
        bind: 'lan',
        auth: { mode: 'none', allowTailscale: true },
        tailscale: { mode: 'serve' },
        remote: { url: 'wss://elsewhere' },
        controlUi: { enabled: true },
      },
    },
    run,
  );
  // The source's own tool choices stand, in either direction.
  assert.deepEqual(launched.tools, {
    profile: 'minimal',
    fs: { workspaceOnly: false },
    exec: { mode: 'full' },
  });
  // Every agent works in this run's workspace, starts its commands there
  // whatever directory the source names, and keeps its state here.
  assert.deepEqual(launched.agents.defaults, {
    sandbox: { mode: 'off' },
    skipBootstrap: true,
    model: { primary: 'm' },
    cwd: '/work/workspace',
    workspace: '/work/workspace',
  });
  assert.deepEqual(launched.agents.entries, {
    main: {
      workspace: '/work/workspace',
      cwd: '/work/workspace',
      runtime: { type: 'acp', acp: { agent: 'codex' } },
    },
    helper: { workspace: '/work/workspace' },
  });
  assert.deepEqual(launched.session, { scope: 'per-sender' });
  // The Gateway is this run's alone: nothing the source says about it
  // survives. Its log is the definition's to shape, because nothing the
  // launcher decides is read from it.
  assert.deepEqual(launched.gateway, gateway);
  assert.deepEqual(launched.logging, {
    consoleLevel: 'silent',
    consoleStyle: 'json',
    level: 'debug',
  });
  assert.deepEqual(launched.diagnostics, { enabled: false, flags: ['x'] });
  // Nobody may give this Gateway commands. The source's rules for single
  // origins go too: OpenClaw puts one for the internal origin, which an
  // ACP turn arrives from, ahead of the rule for every origin. Its other
  // command settings stay.
  assert.deepEqual(launched.commands, { text: true, allowFrom: { '*': [] } });
});

test('readBrief requires this run and a non-empty agent message', () => {
  const env = { LCARS_RUN_ID: RUN_ID };
  assert.throws(
    () => readBrief({ ...agentBrief(agentFiles), intentId: 'other' }, env),
    /not a claw run/,
  );
  assert.throws(
    () => readBrief(agentBrief(agentFiles, { message: ' ' }), env),
    /no agent message/,
  );
  // The retired operation brief names no agent.
  assert.throws(
    () =>
      readBrief(
        {
          intentId: RUN_ID,
          pipeline: 'claw-investigator',
          mode: 'claw',
          claw: {
            operation: 'investigate:v1',
            input: { question: 'q' },
          },
        },
        env,
      ),
    /no agent/,
  );
});

test('cancellation stops an OpenClaw turn and its Gateway, and still settles', async () => {
  const { env, calls, deps, openclawLog } = await fixture({
    acp: { hang: true },
    env: { CLAW_TURN_DEADLINE_SECONDS: '60' },
  });
  const pending = main(env, deps);
  // Wait until OpenClaw's ACP server is running its prompt, then deliver the
  // pod's SIGTERM.
  let log = [];
  for (let i = 0; i < 200 && !ran(log).includes('acp --url'); i++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Nothing has been logged until the first OpenClaw command starts.
    log = await openclawLog().catch(() => []);
  }
  assert.deepEqual(ran(log).slice(3), ['gateway run', 'acp --url']);
  for (
    let i = 0;
    i < 200 && !calls.some((call) => call.body?.providerProcessStarted);
    i++
  )
    await new Promise((resolve) => setTimeout(resolve, 50));
  process.emit('SIGTERM');
  const result = await pending;
  assert.deepEqual(result, {
    outcome: 'runner-failed',
    message: 'Claw turn was cancelled.',
  });
  assert.deepEqual(completion(calls), result);
  for (const entry of log.slice(3)) gone(entry.pid);
});

test('an evidence-bound agent answered without any tool call is not a report', async () => {
  const { env, deps } = await fixture({
    acp: { steps: [{ say: 'Probably fine.' }] },
  });
  assert.deepEqual(await main(env, deps), {
    outcome: 'runner-failed',
    message: 'Claw turn answered without using any tool.',
  });
});

test('malformed numeric settings fail before any Work API call', async () => {
  for (const [name, value] of [
    ['CLAW_TURN_DEADLINE_SECONDS', 'abc'],
    ['CLAW_HEARTBEAT_INTERVAL_MS', '0'],
  ]) {
    const { env, calls, fetchImpl } = await fixture({ env: { [name]: value } });
    await assert.rejects(main(env, { fetchImpl }), new RegExp(name));
    assert.equal(calls.length, 0);
  }
});

test('the overall deadline also bounds setup and stops before the turn', async () => {
  const { env, calls, deps, openclawLog } = await fixture({
    env: { FAKE_DOCTOR_SLEEP: '5000', CLAW_TURN_DEADLINE_SECONDS: '1' },
  });
  const started = Date.now();
  const result = await main(env, deps);
  assert.ok(Date.now() - started < 4000, 'setup outlived the deadline');
  assert.deepEqual(result, {
    outcome: 'runner-failed',
    message: 'Claw turn exceeded its deadline.',
  });
  assert.deepEqual(completion(calls), result);
  assert.deepEqual(ran(await openclawLog()), [
    'config validate',
    'doctor --fix',
  ]);
});

test('runs a repository-owned agent from its verified, locked brief', async () => {
  const { env, calls, fetchImpl } = await fixture();
  const result = await main(env, { fetchImpl });
  assert.equal(result.outcome, 'report');
  assert.deepEqual(completion(calls), result);
  const probe = await stat(
    join(env.CLAW_WORK_DIR, 'agent', 'workspace/tools/probe'),
  );
  assert.equal(probe.mode & 0o777, 0o555);
  const tools = await stat(join(env.CLAW_WORK_DIR, 'agent', 'workspace/tools'));
  assert.equal(tools.mode & 0o777, 0o555);
  await assert.rejects(
    writeFile(join(env.CLAW_WORK_DIR, 'agent', 'workspace/tools/new'), 'x'),
    /EACCES/,
  );
});

test('readBrief returns an agent request with its evidence rule', () => {
  const request = readBrief(agentBrief(agentFiles), { LCARS_RUN_ID: RUN_ID });
  assert.equal(request.requireTools, true);
  assert.equal(request.message, 'Why is the disk alert firing?');
});

test('refuses agent files that do not match their blob, digest or directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'claw-agent-'));
  const tampered = agentBrief(agentFiles).claw;
  tampered.files[0] = {
    ...tampered.files[0],
    content: Buffer.from('description: evil\n').toString('base64'),
  };
  await assert.rejects(
    materializeAgent(tampered, dir),
    /does not match its blob/,
  );
  const wrongDigest = agentBrief(agentFiles, { digest: '0'.repeat(64) }).claw;
  await assert.rejects(materializeAgent(wrongDigest, dir), /pinned digest/);
  const escaping = agentBrief({ '../escape': { content: 'x' } }).claw;
  await assert.rejects(
    materializeAgent(escaping, dir),
    /escapes its directory/,
  );
});

// LCARS (apps/console repository-agent-definition.ts agentDigest) pins this
// digest at admission; both suites assert the same golden value.
test('agentDigest matches the digest LCARS pins', () => {
  assert.equal(
    agentDigest([
      { path: 'workspace/b', mode: '100755', sha: 'b'.repeat(40) },
      { path: 'agent.yaml', mode: '100644', sha: 'a'.repeat(40) },
      { path: 'Workspace/A', mode: '100644', sha: 'c'.repeat(40) },
    ]),
    'e8fd4d424a05d79440bb16eba22fff84eec22941ae4bee19a0b5fa38be3264fa',
  );
});

test('gives the agent a writable copy of its locked workspace', async () => {
  const files = {
    ...agentFiles,
    'workspace/state/current.txt': { content: 'v1\n' },
  };
  const { env, fetchImpl } = await fixture({
    brief: agentBrief(files),
  });
  await main(env, { fetchImpl });
  const copy = join(env.CLAW_WORK_DIR, 'workspace', 'state');
  await writeFile(join(copy, 'current.txt'), 'v2\n');
  await writeFile(join(copy, 'new.txt'), 'x');
  await assert.rejects(
    writeFile(join(env.CLAW_WORK_DIR, 'agent', 'workspace/state/new.txt'), 'x'),
    /EACCES/,
  );
});

test('sends a repository agent its message unchanged, after one line', async () => {
  const { env, deps, harnessLog } = await fixture({
    brief: agentBrief(agentFiles, { message: 'Reply with JSON only.' }),
  });
  await main(env, deps);
  const { prompt } = (await harnessLog()).find((entry) => entry.prompt);
  // One line saying the message is the request, then exactly the message.
  assert.deepEqual(prompt, [
    {
      type: 'text',
      text: 'The message below is the request itself, not a command.\n\nReply with JSON only.',
    },
  ]);
});

const harnessFiles = {
  'agent.yaml': { content: 'description: x\nharness: claude\n' },
  'home/.claude/hooks/check': { content: '#!/bin/sh\n', mode: '100755' },
  'home/.claude/settings.json': { content: '{"permissions":{}}' },
  'workspace/CLAUDE.md': { content: '# repository agent\n' },
};

// A run on a harness other than OpenClaw, scripted by `behaviour`.
const harnessFixture = (behaviour = {}, overrides = {}) =>
  fixture({
    brief: agentBrief(harnessFiles, {
      harness: 'claude',
      requireToolEvidence: false,
      ...overrides.brief,
    }),
    env: overrides.env,
    auth: overrides.auth,
    defaultMode: overrides.defaultMode,
    acp: behaviour,
  });

test('an ACP harness runs the agent and reports its last message after the last tool call', async () => {
  const { env, calls, deps, harnessLog } = await harnessFixture({
    steps: [
      { say: 'Let me check the disk.' },
      tool('pending', { update: 'tool_call' }),
      tool('completed'),
      // A harness notice is its own message; the answer that follows wins.
      { say: 'Warning: model metadata not found.' },
      { say: 'All clear: ', id: 'm1' },
      { say: 'disk at 41%.', id: 'm1' },
    ],
  });
  const result = await main(env, deps);
  assert.deepEqual(result, {
    outcome: 'report',
    message: 'All clear: disk at 41%.',
  });
  assert.deepEqual(completion(calls), result);
  assert.deepEqual(
    calls.map((call) => call.path),
    ['heartbeat', 'brief', 'heartbeat', 'complete'],
  );
  assert.deepEqual(calls[2].body, { providerProcessStarted: true });
  const [initialize, session, prompt] = await harnessLog();
  // The harness runs in the agent's workspace copy with the zone's secret
  // environment and nothing of the launcher's.
  assert.equal(initialize.cwd, join(env.CLAW_WORK_DIR, 'workspace'));
  assert.equal(initialize.key, 'sk-test');
  assert.equal(initialize.token, null);
  // Its user-level settings are the definition's reviewed `home/`: read-only
  // for the turn, with an executable still executable.
  assert.equal(initialize.settings, '{"permissions":{}}');
  const modeOf = async (file) =>
    (await stat(join(env.HOME, '.claude', file))).mode & 0o777;
  assert.equal(await modeOf('settings.json'), 0o444);
  assert.equal(await modeOf('hooks/check'), 0o555);
  assert.deepEqual(initialize.initialize.clientCapabilities, {
    fs: { readTextFile: false, writeTextFile: false },
    terminal: false,
    session: { notices: {} },
    _meta: {
      jetbrains: { air: { version: 1, capabilities: ['sessionFailure'] } },
    },
  });
  assert.deepEqual(session.session, {
    cwd: join(env.CLAW_WORK_DIR, 'workspace'),
    mcpServers: [],
  });
  assert.deepEqual(prompt.prompt, [
    { type: 'text', text: promptText('Why is the disk alert firing?') },
  ]);
  assert.equal(
    await readFile(join(env.CLAW_WORK_DIR, 'workspace', 'CLAUDE.md'), 'utf8'),
    '# repository agent\n',
  );
  // An ACP agent needs no OpenClaw definition, and OpenClaw never runs.
  await assert.rejects(readFile(env.FAKE_LOG, 'utf8'), { code: 'ENOENT' });
});

test('an ACP permission request is refused and its tool call fails the attempt', async () => {
  const { env, deps, harnessLog } = await harnessFixture({
    steps: [tool('pending', { update: 'tool_call' }), { ask: 't1' }],
  });
  assert.deepEqual(await main(env, deps), {
    outcome: 'runner-failed',
    message: 'Claw turn failed: unresolved execute tool call.',
  });
  const asked = (await harnessLog()).find((entry) => entry.permission);
  assert.deepEqual(asked.permission, {
    outcome: { outcome: 'selected', optionId: 'no' },
  });
});

test('an ACP turn fails closed on a harness error, an early exit or no answer', async () => {
  const outcome = async (behaviour) => {
    const { env, deps } = await harnessFixture(behaviour);
    return (await main(env, deps)).message;
  };
  assert.equal(
    await outcome({ authError: true }),
    'Claw turn failed: Authentication required.',
  );
  assert.equal(
    await outcome({ exit: true }),
    'Claw turn failed: harness exited 7 mid-turn.',
  );
  // A harness reports a turn that died before the model as a normal end.
  assert.equal(await outcome({ steps: [] }), 'Claw turn failed: empty result.');
  assert.equal(
    await outcome({ steps: [{ say: 'partial' }], stopReason: 'max_tokens' }),
    'Claw turn failed: harness stopped with max_tokens.',
  );
  assert.equal(
    await outcome({ protocolVersion: 2 }),
    'Claw turn failed: harness speaks ACP protocol 2.',
  );
});

test('a malformed ACP permission request is answered, never a crash', async () => {
  for (const options of [{}, 'x', [null, 7]]) {
    const { env, calls, deps, harnessLog } = await harnessFixture({
      steps: [tool('pending', { update: 'tool_call' }), { ask: 't1', options }],
    });
    const result = await main(env, deps);
    assert.deepEqual(result, {
      outcome: 'runner-failed',
      message: 'Claw turn failed: unresolved execute tool call.',
    });
    assert.deepEqual(completion(calls), result);
    // With no reject option to choose, the request is cancelled.
    const asked = (await harnessLog()).find((entry) => entry.permission);
    assert.deepEqual(asked.permission, { outcome: { outcome: 'cancelled' } });
  }
});

test('ACP tool calls resolve only through a later completed call', async () => {
  const outcome = async (steps) => {
    const { env, deps } = await harnessFixture({ steps });
    return main(env, deps);
  };
  const call = (id, status, update) => tool(status, { id, update });
  const unresolved = {
    outcome: 'runner-failed',
    message: 'Claw turn failed: unresolved execute tool call.',
  };
  // A failed probe, then a later call that completed: resolved evidence.
  assert.deepEqual(
    await outcome([
      call('a', 'pending', 'tool_call'),
      call('a', 'failed'),
      call('b', 'pending', 'tool_call'),
      call('b', 'completed'),
      { say: 'Host is down.' },
    ]),
    { outcome: 'report', message: 'Host is down.' },
  );
  // Calls running side by side do not resolve each other.
  assert.deepEqual(
    await outcome([
      call('a', 'pending', 'tool_call'),
      call('b', 'pending', 'tool_call'),
      call('a', 'failed'),
      call('b', 'completed'),
      { say: 'All good.' },
    ]),
    unresolved,
  );
  // A call still running when the turn ends is unresolved too.
  assert.deepEqual(
    await outcome([
      call('a', 'in_progress', 'tool_call'),
      call('b', 'pending', 'tool_call'),
      call('b', 'completed'),
      { say: 'All good.' },
    ]),
    unresolved,
  );
  // Text written while a call was still running is narration, never the
  // report.
  assert.deepEqual(
    await outcome([
      call('a', 'in_progress', 'tool_call'),
      { say: 'Let me wait for the disk check...' },
      call('a', 'completed'),
    ]),
    { outcome: 'runner-failed', message: 'Claw turn failed: empty result.' },
  );
  // A repeated notice of a status already seen keeps the answer; a late
  // failure does not.
  assert.deepEqual(
    await outcome([
      call('a', 'in_progress', 'tool_call'),
      call('a', 'completed'),
      { say: 'Answer.' },
      call('a', 'completed'),
    ]),
    { outcome: 'report', message: 'Answer.' },
  );
  assert.deepEqual(
    await outcome([
      call('a', 'in_progress', 'tool_call'),
      { say: 'Answer.' },
      call('a', 'failed'),
    ]),
    unresolved,
  );
});

test('a harness that exits is reported at once, whatever holds its output open', async () => {
  // The harness dies mid-turn while a child of its own keeps its stderr
  // open for a minute. The attempt is not kept waiting for that child.
  const { env, deps, harnessLog } = await harnessFixture({
    holdsOutput: true,
    exit: true,
  });
  const started = Date.now();
  assert.deepEqual(await main(env, deps), {
    outcome: 'runner-failed',
    message: 'Claw turn failed: harness exited 7 mid-turn.',
  });
  assert.ok(Date.now() - started < 10_000);
  gone((await harnessLog()).find((entry) => entry.lingering).lingering);
});

// A harness host on a Unix socket, as the pod's harness container is: its
// own harness table and environment, and nothing of the launcher's.
async function socketHost(made, serve) {
  const path = join(made.root, 'harness.sock');
  const {
    LCARS_RUN_TOKEN: _token,
    LCARS_CONSOLE_URL: _url,
    ...hostEnv
  } = made.env;
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    server.close();
    if (serve) serve(socket);
    else
      void serveHarness(socket, {
        harnesses: { openclaw: HARNESSES.openclaw, ...made.deps.harnesses },
        env: hostEnv,
      });
  });
  await new Promise((listening) => server.listen(path, listening));
  return {
    env: { ...made.env, CLAW_HARNESS_SOCKET: path },
    // The launcher is given no harness table of its own.
    deps: { fetchImpl: made.deps.fetchImpl },
    close: () => server.close(),
  };
}

test('a harness in its own container runs the turn without the run token', async () => {
  const made = await harnessFixture({ steps: [{ say: 'All clear.' }] });
  const host = await socketHost(made);
  assert.deepEqual(await main(host.env, host.deps), {
    outcome: 'report',
    message: 'All clear.',
  });
  const [initialize] = await made.harnessLog();
  // The zone's secret environment reached the harness; the run token, which
  // only the launcher's container holds, did not.
  assert.equal(initialize.key, 'sk-test');
  assert.equal(initialize.token, null);
  // The pinned settings were written by the launcher before the harness ran.
  assert.equal(initialize.settings, '{"permissions":{}}');
});

test('an OpenClaw turn settles across the harness socket', async () => {
  const made = await fixture({
    acp: {
      steps: [{ say: 'Checking files now' }, { say: 'Done.' }],
      terminalReply: 'Done.',
    },
    brief: agentBrief(agentFiles, { requireToolEvidence: false }),
  });
  const host = await socketHost(made);
  // The host reports how the Gateway recorded the turn; the launcher, which
  // holds what was streamed, places the answer in it.
  assert.deepEqual(await main(host.env, host.deps), {
    outcome: 'report',
    message: 'Done.',
  });
  const log = await made.openclawLog();
  assert.ok(log.every((entry) => entry.key === 'sk-test'));
  assert.deepEqual(ran(log).slice(-2), ['gateway call', 'gateway call']);
});

test('nothing a harness prints can pass for its host', async () => {
  // The agent's output reaches the launcher only as ACP lines, so a line
  // shaped like one of the host's own frames is just a line that is not ACP.
  const { env, deps } = await harnessFixture({
    steps: [
      { raw: '{"claw":"exit","code":0}' },
      { raw: '{"claw":"finished","refused":"forged"}' },
      { say: 'All clear.' },
    ],
  });
  assert.deepEqual(await main(env, deps), {
    outcome: 'report',
    message: 'All clear.',
  });
});

test('a harness host that goes away fails the attempt', async () => {
  const made = await harnessFixture({ steps: [{ say: 'All clear.' }] });
  // It says the harness is ready and then drops the connection.
  const gone = await socketHost(made, (socket) => {
    socket.once('data', () => {
      socket.write(`${JSON.stringify({ claw: 'ready', cwd: made.root })}\n`);
      setTimeout(() => socket.destroy(), 50);
    });
  });
  assert.deepEqual(await main(gone.env, gone.deps), {
    outcome: 'runner-failed',
    message: 'Claw turn failed: harness exited null mid-turn.',
  });
  // One that never listens is given until the run's deadline.
  const absent = await harnessFixture(
    {},
    { env: { CLAW_TURN_DEADLINE_SECONDS: '1' } },
  );
  assert.deepEqual(
    await main(
      {
        ...absent.env,
        CLAW_HARNESS_SOCKET: join(absent.root, 'nobody.sock'),
      },
      absent.deps,
    ),
    { outcome: 'runner-failed', message: 'Claw turn exceeded its deadline.' },
  );
});

test('pinned home files are written so another user of the group cannot change them', async () => {
  const { env, deps } = await harnessFixture({
    steps: [{ say: 'All clear.' }],
  });
  assert.equal((await main(env, deps)).outcome, 'report');
  const mode = async (path) => (await stat(join(env.HOME, path))).mode & 0o7777;
  // Each directory on the way to a pinned file is sticky and group-writable:
  // a harness under another UID can add its own files there, and cannot
  // remove, rename or replace an entry it does not own.
  for (const directory of ['.', '.claude', '.claude/hooks'])
    assert.equal((await mode(directory)) & 0o1070, 0o1070, directory);
  // The files themselves are read-only, an executable still executable.
  assert.equal(await mode('.claude/settings.json'), 0o444);
  assert.equal(await mode('.claude/hooks/check'), 0o555);
});

test('the definition directory is emptied in place, never replaced', async () => {
  // With an isolated harness it is a volume another container mounts.
  const dir = await mkdtemp(join(tmpdir(), 'claw-definition-'));
  await writeFile(join(dir, 'stale'), 'left over');
  const before = (await stat(dir)).ino;
  await materializeAgent(agentBrief(agentFiles).claw, dir);
  assert.equal((await stat(dir)).ino, before);
  await assert.rejects(stat(join(dir, 'stale')), { code: 'ENOENT' });
  assert.equal(
    await readFile(join(dir, 'workspace', 'AGENTS.md'), 'utf8'),
    '# repository agent\n',
  );
});

test('nothing of the harness runs on once its turn has resolved', async () => {
  // The harness's own process exits when its input closes; a child of its
  // own, with its own stdio, would otherwise outlive the settings check and
  // the settlement.
  const { env, deps, harnessLog } = await harnessFixture({
    linger: true,
    steps: [{ say: 'All clear.' }],
  });
  assert.deepEqual(await main(env, deps), {
    outcome: 'report',
    message: 'All clear.',
  });
  const { lingering } = (await harnessLog()).find((entry) => entry.lingering);
  gone(lingering);
});

test('home settings apply only to a definition that names a harness', async () => {
  const files = {
    ...agentFiles,
    'home/.claude/settings.json': { content: '{"permissions":{}}' },
  };
  const settings = async (over) => {
    const made = await fixture({ brief: agentBrief(files, over) });
    assert.equal((await main(made.env, made.deps)).outcome, 'report');
    return (await made.harnessLog())[0].settings;
  };
  // A definition from before harnesses, whose `home/` no launcher applied,
  // and a round already admitted for it, run as they always did.
  assert.equal(await settings({}), null);
  // Naming the harness, OpenClaw included, is what asks for them.
  assert.equal(await settings({ harness: 'openclaw' }), '{"permissions":{}}');
});

test('cancellation stops an ACP harness and still settles', async () => {
  const { env, calls, deps } = await harnessFixture(
    { hang: true },
    { env: { CLAW_TURN_DEADLINE_SECONDS: '60' } },
  );
  const pending = main(env, deps);
  for (
    let i = 0;
    i < 100 && !calls.some((call) => call.body?.providerProcessStarted);
    i++
  )
    await new Promise((resolve) => setTimeout(resolve, 50));
  process.emit('SIGTERM');
  const result = await pending;
  assert.deepEqual(result, {
    outcome: 'runner-failed',
    message: 'Claw turn was cancelled.',
  });
  assert.deepEqual(completion(calls), result);
});

test('an agent that rewrites its harness settings loses its report', async () => {
  const { env, deps } = await harnessFixture({
    tamper: true,
    steps: [{ say: 'All clear.' }],
  });
  assert.deepEqual(await main(env, deps), {
    outcome: 'runner-failed',
    message:
      'Claw turn failed: the agent changed its harness settings (home/.claude/settings.json).',
  });
});

test('a settings file replaced by a pipe is a change, not a launcher that hangs', async () => {
  const { env, deps } = await harnessFixture({
    tamper: 'pipe',
    steps: [{ say: 'All clear.' }],
  });
  assert.deepEqual(await main(env, deps), {
    outcome: 'runner-failed',
    message:
      'Claw turn failed: the agent changed its harness settings (home/.claude/settings.json).',
  });
});

test('readSettingsFile reads only a bounded regular file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'claw-settings-'));
  const file = join(dir, 'settings.json');
  await writeFile(file, 'pinned');
  const read = async (path, maxBytes = 6) =>
    (await readSettingsFile(path, { maxBytes, timeoutMs: 2_000 }))?.toString();
  assert.equal(await read(file), 'pinned');
  // Everything else the agent's tools could leave at the path is no file.
  assert.equal(await read(file, 5), undefined);
  assert.equal(await read(join(dir, 'missing')), undefined);
  assert.equal(await read(dir), undefined);
  await symlink(file, join(dir, 'link'));
  assert.equal(await read(join(dir, 'link')), undefined);
  execFileSync('mkfifo', [join(dir, 'pipe')]);
  assert.equal(await read(join(dir, 'pipe')), undefined);
  assert.equal(await read('/dev/zero', 1 << 20), undefined);
});

test('a harness the image does not carry is refused before any turn', async () => {
  const { env, deps, harnessLog } = await harnessFixture(
    {},
    { brief: { harness: 'constructor' } },
  );
  assert.deepEqual(await main(env, deps), {
    outcome: 'runner-failed',
    message: 'Claw setup failed: this image carries no constructor harness.',
  });
  await assert.rejects(harnessLog(), { code: 'ENOENT' });
});

test('the outer deadline stops an ACP harness that never answers', async () => {
  const { env, deps } = await harnessFixture(
    { hang: true },
    { env: { CLAW_TURN_DEADLINE_SECONDS: '1' } },
  );
  assert.deepEqual(await main(env, deps), {
    outcome: 'runner-failed',
    message: 'Claw turn exceeded its deadline.',
  });
});

test('settle applies the evidence rules to an ACP turn', () => {
  const turn = (over) => ({
    stopReason: 'end_turn',
    final: 'Disk at 41%.',
    calls: 0,
    ...over,
  });
  assert.deepEqual(settle(turn()), {
    outcome: 'report',
    message: 'Disk at 41%.',
  });
  assert.equal(
    settle(turn(), { requireTools: true }).message,
    'Claw turn answered without using any tool.',
  );
  assert.equal(
    settle(turn({ calls: 2 }), { requireTools: true }).outcome,
    'report',
  );
  assert.equal(
    settle(turn({ calls: 1, unresolved: { label: 'read', status: 'failed' } }))
      .message,
    'Claw turn failed: unresolved read tool call.',
  );
  assert.equal(
    settle(turn({ final: 'x'.repeat(MAX_REPORT_BYTES + 1) })).outcome,
    'runner-failed',
  );
  assert.equal(
    settle(turn({ aborted: true })).message,
    'Claw turn was cancelled.',
  );
  assert.equal(
    settle(turn({ timedOut: true })).message,
    'Claw turn exceeded its deadline.',
  );
});

test('readBrief names the harness and mode, defaulting to OpenClaw', () => {
  const env = { LCARS_RUN_ID: RUN_ID };
  const plain = readBrief(agentBrief(agentFiles), env);
  assert.equal(plain.harness, 'openclaw');
  assert.equal(plain.mode, undefined);
  const selected = readBrief(
    agentBrief(harnessFiles, { harness: 'codex', mode: 'read-only' }),
    env,
  );
  assert.equal(selected.harness, 'codex');
  assert.equal(selected.mode, 'read-only');
  assert.equal(selected.files.length, 4);
  assert.throws(
    () => readBrief(agentBrief(harnessFiles, { harness: 7 }), env),
    /no usable harness/,
  );
  // A harness or mode beside `files` is the shape a launcher from before
  // harnesses would run on OpenClaw; it is never accepted.
  const legacy = agentBrief(agentFiles);
  for (const selection of [{ harness: 'claude' }, { mode: 'plan' }]) {
    assert.throws(
      () =>
        readBrief({ ...legacy, claw: { ...legacy.claw, ...selection } }, env),
      /no agent definition/,
    );
  }
});

test('a definition file named home or workspace is not staged as a directory', async () => {
  // An existing definition may hold such a file; only a directory is staged.
  const { env, deps } = await fixture({
    brief: agentBrief({
      'agent.yaml': agentFiles['agent.yaml'],
      'config.json': agentFiles['config.json'],
      'approvals.json': agentFiles['approvals.json'],
      home: { content: 'notes\n' },
    }),
  });
  assert.equal((await main(env, deps)).outcome, 'report');
});

test('a message is always sent as text for the agent, never as a harness command', async () => {
  const sent = async (message) => {
    const made = await fixture({ brief: agentBrief(agentFiles, { message }) });
    await main(made.env, made.deps);
    return (await made.harnessLog()).find((entry) => entry.prompt).prompt;
  };
  const lead = 'The message below is the request itself, not a command.';
  // A leading slash and a bare control word are both commands to some
  // harness; neither is ever the whole prompt or its start.
  for (const message of ['/help', 'halt', 'Check /var/log for errors.'])
    assert.deepEqual(await sent(message), [
      { type: 'text', text: `${lead}\n\n${message}` },
    ]);
  assert.equal(promptText('stop'), `${lead}\n\nstop`);
});

test('a turn the harness reports as a provider failure is never a report', async () => {
  const outcome = async (behaviour) => {
    const { env, deps } = await harnessFixture(behaviour);
    return main(env, deps);
  };
  const failed = {
    outcome: 'runner-failed',
    message: 'Claw turn failed: harness reported a provider failure.',
  };
  const error = { category: 'provider', severity: 'error' };
  // Codex ends such a turn normally, with part of an answer or the error
  // itself as message text. The failure arrives on a session update, on the
  // prompt's result, or both; its text is never repeated.
  assert.deepEqual(
    await outcome({ steps: [{ failure: error }, { say: 'The disk is' }] }),
    failed,
  );
  assert.deepEqual(
    await outcome({ steps: [{ say: 'The disk is' }], resultFailure: error }),
    failed,
  );
  // A warning is a retry in progress: the turn that then answers stands.
  assert.deepEqual(
    await outcome({
      steps: [
        { failure: { category: 'provider', severity: 'warning' } },
        { say: 'Disk at 41%.' },
      ],
    }),
    { outcome: 'report', message: 'Disk at 41%.' },
  );
});

test('text a harness tags as commentary is never the answer', async () => {
  const outcome = async (steps) => {
    const { env, deps } = await harnessFixture({ steps });
    return main(env, deps);
  };
  const worked = [
    tool('pending', { update: 'tool_call' }),
    tool('completed'),
    { say: 'Looking at the logs now.', id: 'm1', phase: 'commentary' },
  ];
  // Codex finishing a turn with a tool call and commentary but no final
  // answer has not answered.
  assert.deepEqual(await outcome(worked), {
    outcome: 'runner-failed',
    message: 'Claw turn failed: empty result.',
  });
  // With an answer, the report is the answer alone.
  assert.deepEqual(
    await outcome([
      ...worked,
      { say: 'Done.', id: 'm2', phase: 'final_answer' },
    ]),
    { outcome: 'report', message: 'Done.' },
  );
  // Commentary after the answer does not replace it either.
  assert.deepEqual(
    await outcome([
      { say: 'Done.', id: 'm1', phase: 'final_answer' },
      { say: 'Wrapping up.', id: 'm2', phase: 'commentary' },
    ]),
    { outcome: 'report', message: 'Done.' },
  );
});

test("a harness's own remarks on the turn never replace the answer", async () => {
  const { env, deps } = await harnessFixture({
    steps: [
      { say: 'Disk at 41%.', id: 'm1' },
      // A typed notice, and the same kind of remark sent as message text by
      // a harness that has no notices: neither is the agent's answer.
      { notice: 'Fast mode turned off' },
      { say: '**Notice** Fast mode turned off.' },
    ],
  });
  assert.deepEqual(await main(env, deps), {
    outcome: 'report',
    message: 'Disk at 41%.',
  });
});

test('the image sets the session mode of a harness whose own default is too loose', async () => {
  const modes = ['agent', 'workspace-write', 'read-only'];
  const selected = async (mode) => {
    const made = await harnessFixture(
      { ...CLEAN_TURN, modes },
      { defaultMode: 'workspace-write', brief: mode ? { mode } : {} },
    );
    assert.equal((await main(made.env, made.deps)).outcome, 'report');
    return (await made.harnessLog()).find((entry) => entry.mode).mode;
  };
  // The image's choice unless the manifest names one.
  assert.equal(await selected(undefined), 'workspace-write');
  assert.equal(await selected('read-only'), 'read-only');
});

test('a harness that asks to be signed in is signed in with the method the image names', async () => {
  const needsAuth = { ...CLEAN_TURN, needsAuth: true };
  const run = async (behaviour, overrides) => {
    const made = await harnessFixture(behaviour, overrides);
    const result = await main(made.env, made.deps);
    return { result, log: await made.harnessLog() };
  };
  const methods = ['api-key', 'chat-gpt'];
  // The image's method, offered: sign in once, then the session opens.
  const signedIn = await run(
    { ...needsAuth, authMethods: methods },
    { auth: 'api-key' },
  );
  assert.equal(signedIn.result.outcome, 'report');
  assert.deepEqual(
    signedIn.log.map((entry) => Object.keys(entry)[0]),
    ['initialize', 'session', 'authenticate', 'session', 'prompt'],
  );
  assert.equal(signedIn.log[2].authenticate, 'api-key');
  // No method named for the harness, or not the one it offers: never an
  // interactive sign-in, and nothing is prompted.
  for (const [behaviour, overrides] of [
    [{ ...needsAuth, authMethods: methods }, {}],
    [{ ...needsAuth, authMethods: ['chat-gpt'] }, { auth: 'api-key' }],
  ]) {
    const refused = await run(behaviour, overrides);
    assert.deepEqual(refused.result, {
      outcome: 'runner-failed',
      message: 'Claw turn failed: Authentication required.',
    });
    assert.ok(!refused.log.some((entry) => entry.authenticate || entry.prompt));
  }
  // The sign-in itself failing (no key on the runtime) names the cause.
  const noKey = await run(
    { ...needsAuth, authMethods: methods, refuseAuth: true },
    { auth: 'api-key' },
  );
  assert.equal(
    noKey.result.message,
    'Claw turn failed: CODEX_API_KEY or OPENAI_API_KEY is not set.',
  );
  assert.ok(!noKey.log.some((entry) => entry.prompt));
});

test("the manifest's session mode is selected before the prompt, or nothing runs", async () => {
  const modes = ['agent', 'read-only'];
  const run = async (behaviour, mode) => {
    const fixtureRun = await harnessFixture(
      { ...CLEAN_TURN, ...behaviour },
      { brief: { mode } },
    );
    const result = await main(fixtureRun.env, fixtureRun.deps);
    return { result, log: await fixtureRun.harnessLog() };
  };
  const selected = await run({ modes }, 'read-only');
  assert.equal(selected.result.outcome, 'report');
  assert.deepEqual(
    selected.log.map((entry) => Object.keys(entry)[0]),
    ['initialize', 'session', 'mode', 'prompt'],
  );
  assert.equal(selected.log[2].mode, 'read-only');
  // A harness that does not offer the mode, or will not switch, is never
  // prompted.
  for (const [behaviour, message] of [
    [
      { modes: ['agent'] },
      'Claw turn failed: harness offers no read-only mode.',
    ],
    [{}, 'Claw turn failed: harness offers no read-only mode.'],
    [{ modes, refuseMode: true }, 'Claw turn failed: mode not allowed.'],
  ]) {
    const refused = await run(behaviour, 'read-only');
    assert.deepEqual(refused.result, { outcome: 'runner-failed', message });
    assert.ok(!refused.log.some((entry) => entry.prompt));
  }
});

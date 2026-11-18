/* eslint-disable vitest/no-import-node-test -- the claw image's suite runs under node --test without Vitest, like the runner-image runtime suites. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  agentDigest,
  main,
  materializeAgent,
  MAX_REPORT_BYTES,
  readBrief,
  secretEnvironment,
  settle,
} from './claw-job.mjs';
import {
  bundledPluginProviders,
  comparableConfig,
  doctorChanges,
  launchConfig,
  resolveCommand,
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
      files: pinned,
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
const say = (text, messageId) => update('agent_message_chunk', { ...(messageId ? { messageId } : {}), content: { type: 'text', text } });
let prompt;
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    const settings = path.join(process.env.HOME, '.claude', 'settings.json');
    record({ initialize: message.params, pid: process.pid, cwd: process.cwd(), key: process.env.LITELLM_API_KEY ?? null, token: process.env.LCARS_RUN_TOKEN ?? null, settings: fs.existsSync(settings) ? fs.readFileSync(settings, 'utf8') : null });
    console.log('harness banner, not protocol');
    return send({ id: message.id, result: { protocolVersion: behaviour.protocolVersion ?? 1, agentCapabilities: {} } });
  }
  if (message.method === 'session/new') {
    record({ session: message.params });
    return behaviour.authError
      ? send({ id: message.id, error: { code: -32000, message: 'Authentication required' } })
      : send({ id: message.id, result: { sessionId: 's1' } });
  }
  if (message.method === 'session/prompt') {
    record({ prompt: message.params.prompt });
    prompt = message.id;
    if (behaviour.hang) return;
    if (behaviour.exit) process.exit(7);
    if (behaviour.tamperConfig) {
      const config = JSON.parse(fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH, 'utf8'));
      config.tools = { profile: 'coding' };
      fs.writeFileSync(process.env.OPENCLAW_CONFIG_PATH, JSON.stringify(config));
    }
    if (behaviour.tamper) {
      const settings = path.join(process.env.HOME, '.claude', 'settings.json');
      fs.chmodSync(settings, 0o644);
      fs.writeFileSync(settings, '{"permissions":{"allow":["Bash"]}}');
    }
    for (const step of behaviour.steps ?? []) {
      if (step.say) say(step.say, step.id);
      if (step.tool) update(step.tool.update ?? 'tool_call_update', { toolCallId: step.tool.id, kind: step.tool.kind, status: step.tool.status });
      if (step.ask) return send({ id: 'ask-1', method: 'session/request_permission', params: { sessionId: 's1', toolCall: { toolCallId: step.ask }, options: step.options ?? [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' }] } });
    }
    return send({ id: prompt, result: { stopReason: behaviour.stopReason ?? 'end_turn' } });
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
  key: process.env.LITELLM_API_KEY ?? null,
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
  // The Gateway's coloured log lines: an early "ready" that is not the
  // Gateway's own, then the real one.
  const line = (text) => console.log('\\u001b[90m2026-11-18T04:44:41.551+00:00\\u001b[39m \\u001b[36m[gateway]\\u001b[39m \\u001b[36m' + text + '\\u001b[39m');
  line('spawn broker ready pid=1');
  setTimeout(() => line('ready'), 150);
  process.on('SIGTERM', () => process.exit(0));
  setInterval(() => {}, 1000);
  return;
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
        claude: () => ({ command: process.execPath, args: [harness] }),
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
  ]);
  assert.ok(log.every((entry) => entry.key === 'sk-test'));
  // The Gateway runs the reviewed config plus what only this run knows: its
  // workspace and a loopback, token-protected listener.
  const workspace = join(env.CLAW_WORK_DIR, 'workspace');
  const { config, pid } = log[3];
  assert.deepEqual(config.tools, {
    profile: 'minimal',
    exec: { mode: 'allowlist' },
  });
  assert.deepEqual(config.agents.defaults, { skipBootstrap: true, workspace });
  assert.equal(config.agents.entries.main.workspace, workspace);
  assert.equal(config.gateway.mode, 'local');
  assert.equal(config.gateway.bind, 'loopback');
  assert.equal(config.gateway.auth.mode, 'token');
  assert.deepEqual(config.gateway.reload, { mode: 'off' });
  // OpenClaw's ACP server is the agent, pointed at that Gateway.
  const acp = log[4].args;
  assert.equal(acp[2], `ws://127.0.0.1:${config.gateway.port}`);
  assert.equal(
    (await readFile(acp[acp.indexOf('--token-file') + 1], 'utf8')).trim(),
    config.gateway.auth.token,
  );
  assert.ok(acp.includes('--no-prefix-cwd'));
  const [initialize, session] = await harnessLog();
  assert.equal(initialize.token, null);
  assert.equal(session.session.cwd, workspace);
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
  assert.deepEqual(gateway.config.agents.entries.helper, {});
  assert.equal(gateway.config.skills, undefined);
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

test('launchConfig adds only what this run knows to the reviewed config', () => {
  const launched = launchConfig(
    {
      agents: {
        defaults: { skipBootstrap: false, model: { primary: 'm' } },
        entries: { main: { workspace: '/repo/workspace' }, helper: {} },
      },
      tools: { profile: 'minimal' },
      gateway: {
        port: 1,
        auth: { mode: 'none' },
        controlUi: { enabled: false },
      },
    },
    { workspace: '/work/workspace', port: 4242, token: 't' },
  );
  assert.deepEqual(launched, {
    agents: {
      // The agent's own choices stand; only its workspace is this run's,
      // wherever the source named one.
      defaults: {
        skipBootstrap: false,
        model: { primary: 'm' },
        workspace: '/work/workspace',
      },
      entries: { main: { workspace: '/work/workspace' }, helper: {} },
    },
    tools: { profile: 'minimal' },
    // A definition cannot open the Gateway or drop its token.
    gateway: {
      controlUi: { enabled: false },
      mode: 'local',
      bind: 'loopback',
      port: 4242,
      auth: { mode: 'token', token: 't' },
      reload: { mode: 'off' },
    },
  });
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

test('sends a repository agent exactly its message, without a wrapper', async () => {
  const { env, deps, harnessLog } = await fixture({
    brief: agentBrief(agentFiles, { message: 'Reply with JSON only.' }),
  });
  await main(env, deps);
  const { prompt } = (await harnessLog()).find((entry) => entry.prompt);
  assert.deepEqual(prompt, [{ type: 'text', text: 'Reply with JSON only.' }]);
});

const harnessFiles = {
  'agent.yaml': { content: 'description: x\nharness: claude\n' },
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
  // Its user-level settings are the definition's reviewed `home/`.
  assert.equal(initialize.settings, '{"permissions":{}}');
  assert.deepEqual(initialize.initialize.clientCapabilities, {
    fs: { readTextFile: false, writeTextFile: false },
    terminal: false,
  });
  assert.deepEqual(session.session, {
    cwd: join(env.CLAW_WORK_DIR, 'workspace'),
    mcpServers: [],
  });
  assert.deepEqual(prompt.prompt, [
    { type: 'text', text: 'Why is the disk alert firing?' },
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

test('readBrief names the harness, defaulting to OpenClaw', () => {
  const env = { LCARS_RUN_ID: RUN_ID };
  assert.equal(readBrief(agentBrief(agentFiles), env).harness, 'openclaw');
  assert.equal(
    readBrief(agentBrief(harnessFiles, { harness: 'codex' }), env).harness,
    'codex',
  );
  assert.throws(
    () => readBrief(agentBrief(harnessFiles, { harness: 7 }), env),
    /no usable harness/,
  );
});

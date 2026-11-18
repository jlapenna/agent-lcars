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
import { comparableConfig, sessionFromEnvelope } from './openclaw-acp.mjs';

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
    }),
  },
  'approvals.json': { content: '{"version":1}' },
  'workspace/AGENTS.md': { content: '# repository agent\n' },
  'workspace/tools/probe': { content: '#!/bin/sh\necho ok\n', mode: '100755' },
};

// A fake `openclaw` CLI. Behaviour per subcommand is chosen by FAKE_* env.
const FAKE_OPENCLAW = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
// The launcher gives OpenClaw a clean environment, so behaviour comes from a
// file beside this fake rather than from FAKE_* variables.
const behaviour = JSON.parse(fs.readFileSync(path.join(__dirname, 'behaviour.json'), 'utf8'));
const args = process.argv.slice(2);
const log = behaviour.FAKE_LOG;
const messageAt = args.indexOf('--message-file');
const message = messageAt < 0 ? null : fs.readFileSync(args[messageAt + 1], 'utf8');
if (log) fs.appendFileSync(log, JSON.stringify({ args, key: process.env.LITELLM_API_KEY ?? null, message }) + '\\n');
const sub = args.slice(0, 2).join(' ');
if (args[0] === 'config' && args[1] === 'validate') {
  console.log(JSON.stringify({ valid: behaviour.FAKE_INVALID !== '1' }));
  process.exit(behaviour.FAKE_INVALID === '1' ? 1 : 0);
}
if (args[0] === 'doctor') {
  if (behaviour.FAKE_DOCTOR_SLEEP) { setTimeout(() => process.exit(0), Number(behaviour.FAKE_DOCTOR_SLEEP)); return; }
  const path = process.env.OPENCLAW_CONFIG_PATH;
  const config = JSON.parse(fs.readFileSync(path, 'utf8'));
  config.meta = { lastTouchedVersion: 'fake' };
  config.wizard = { lastRunAt: new Date().toISOString() };
  if (behaviour.FAKE_DOCTOR_WIDENS === '1') config.tools = { profile: 'coding' };
  fs.writeFileSync(path, JSON.stringify(config));
  process.exit(0);
}
if (sub === 'approvals set') process.exit(0);
if (sub === 'agent exec') {
  if (behaviour.FAKE_EXEC_SLEEP) { setTimeout(() => {}, 60000); return; }
  // Exit only once a large envelope has reached the pipe.
  process.stdout.write((behaviour.FAKE_ENVELOPE ?? JSON.stringify({ ok: true, final: 'All clear: disk at 41%.', toolSummary: { calls: 1, failures: 0 } })) + '\\n', () => process.exit(Number(behaviour.FAKE_EXEC_CODE ?? 0)));
  return;
}
process.exit(64);
`;

async function fixture(overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'claw-job-'));
  const secretsDir = join(root, 'secrets');
  const workDir = join(root, 'work');
  await mkdir(join(secretsDir, 'env'), { recursive: true });
  await mkdir(workDir, { recursive: true });
  await writeFile(join(secretsDir, 'env', 'LITELLM_API_KEY'), 'sk-test\n');
  const openclaw = join(root, 'openclaw');
  await writeFile(openclaw, FAKE_OPENCLAW);
  const behaviour = { FAKE_LOG: join(root, 'openclaw.log') };
  for (const [name, value] of Object.entries(overrides.env ?? {}))
    if (name.startsWith('FAKE_')) behaviour[name] = value;
  await writeFile(join(root, 'behaviour.json'), JSON.stringify(behaviour));
  await chmod(openclaw, 0o755);
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
    FAKE_LOG: join(root, 'openclaw.log'),
    ...overrides.env,
  };
  return { root, env, calls, fetchImpl };
}

const completion = (calls) =>
  calls.find((call) => call.path === 'complete')?.body;

test('a clean turn settles as a report after the full launch sequence', async () => {
  const { env, calls, fetchImpl } = await fixture();
  const result = await main(env, { fetchImpl });
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
  const log = (await readFile(env.FAKE_LOG, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    log.map((entry) => entry.args.slice(0, 2).join(' ')),
    ['config validate', 'doctor --fix', 'approvals set', 'agent exec'],
  );
  assert.ok(log.every((entry) => entry.key === 'sk-test'));
  const exec = log[3].args;
  for (const flag of [
    '--config',
    '--state-dir',
    '--message-file',
    '--cwd',
    '--json',
  ])
    assert.ok(exec.includes(flag), flag);
  assert.ok(!exec.includes('--auth-env-only'));
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

test('an invalid pinned config fails closed before the turn', async () => {
  const { env, calls, fetchImpl } = await fixture({
    env: { FAKE_INVALID: '1' },
  });
  const result = await main(env, { fetchImpl });
  assert.equal(result.outcome, 'runner-failed');
  assert.match(result.message, /failed validation/);
  assert.deepEqual(completion(calls), result);
  const log = await readFile(env.FAKE_LOG, 'utf8');
  assert.ok(!log.includes('"exec"'));
});

test('a Doctor change beyond its own stamps fails closed', async () => {
  const { env, calls, fetchImpl } = await fixture({
    env: { FAKE_DOCTOR_WIDENS: '1' },
  });
  const result = await main(env, { fetchImpl });
  assert.equal(result.outcome, 'runner-failed');
  assert.match(result.message, /Doctor-normalized/);
  assert.ok(!(await readFile(env.FAKE_LOG, 'utf8')).includes('"exec"'));
  assert.deepEqual(completion(calls), result);
});

test('a brief for another pipeline is refused', async () => {
  const { env, fetchImpl } = await fixture({
    brief: { intentId: RUN_ID, pipeline: 'claude', mode: 'implement' },
  });
  const result = await main(env, { fetchImpl });
  assert.equal(result.outcome, 'runner-failed');
  assert.match(result.message, /not a claw run/);
});

test('denied tools settle as failure even though exec exits 0', async () => {
  const envelope = JSON.stringify({
    ok: true,
    final: 'Both commands were refused.',
    toolSummary: {
      calls: 2,
      failures: 2,
      unresolvedError: { toolName: 'exec' },
    },
  });
  const { env, fetchImpl } = await fixture({
    env: { FAKE_ENVELOPE: envelope },
  });
  const result = await main(env, { fetchImpl });
  assert.equal(result.outcome, 'runner-failed');
  assert.equal(result.message, 'Claw turn failed: unresolved exec tool call.');
});

test('the outer deadline stops a turn that runs too long', async () => {
  const { env, fetchImpl } = await fixture({
    env: { FAKE_EXEC_SLEEP: '1', CLAW_TURN_DEADLINE_SECONDS: '1' },
  });
  const result = await main(env, { fetchImpl });
  assert.deepEqual(result, {
    outcome: 'runner-failed',
    message: 'Claw turn exceeded its deadline.',
  });
});

test('reserved or malformed secret env names are refused', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claw-secrets-'));
  await mkdir(join(root, 'env'));
  await writeFile(join(root, 'env', 'LCARS_RUN_TOKEN'), 'x');
  await assert.rejects(secretEnvironment(root), /not allowed/);
  assert.deepEqual(await secretEnvironment(join(root, 'missing')), {});
});

test('OpenClaw envelopes settle conservatively through the adapter', async () => {
  const outcome = async (envelope, code = 0) => {
    const { env, fetchImpl } = await fixture({
      env: {
        FAKE_ENVELOPE:
          typeof envelope === 'string' ? envelope : JSON.stringify(envelope),
        FAKE_EXEC_CODE: String(code),
      },
    });
    return main(env, { fetchImpl });
  };
  const evidence = { calls: 1, failures: 0 };
  assert.deepEqual(await outcome('not json'), {
    outcome: 'runner-failed',
    message: 'Claw turn failed: OpenClaw exited 0 without a JSON result.',
  });
  assert.equal(
    (await outcome({ ok: true, final: '', toolSummary: evidence })).message,
    'Claw turn failed: empty result.',
  );
  assert.equal(
    (await outcome({ ok: false, error: { message: 'model refused' } }, 1))
      .message,
    'Claw turn failed: model refused.',
  );
  const cleanup = await outcome(
    { ok: true, final: 'Report.', toolSummary: evidence },
    1,
  );
  assert.equal(cleanup.outcome, 'report');
  assert.match(cleanup.message, /^Report\.\n\n\(OpenClaw reported a cleanup/);
  assert.equal(
    (await outcome({ ok: false }, 2)).message,
    'Claw turn failed: OpenClaw model attempt timed out.',
  );
  // A long report settles whole: 200 KB, far past the former 16,000 cut.
  const long = '# Findings\n' + '監視 report line 😀\n'.repeat(10_000) + 'end';
  assert.ok(Buffer.byteLength(long) > 200_000);
  assert.deepEqual(
    await outcome({ ok: true, final: long, toolSummary: evidence }),
    { outcome: 'report', message: long },
  );
  // Past the completion bound it is a failed attempt, never a truncated report.
  const oversized = await outcome({
    ok: true,
    final: 'x'.repeat(MAX_REPORT_BYTES + 1),
    toolSummary: evidence,
  });
  assert.equal(oversized.outcome, 'runner-failed');
  assert.match(oversized.message, /completion bound/);
});

test('sessionFromEnvelope turns tool evidence into ACP tool calls', () => {
  const session = (envelope, code = 0) =>
    sessionFromEnvelope({ code, stdout: JSON.stringify(envelope) });
  const statuses = ({ updates }) =>
    updates
      .filter((update) => update.sessionUpdate === 'tool_call_update')
      .map((update) => [update.toolCallId, update.status]);
  // Resolved failures are evidence: one completed call stands for them all.
  const resolved = session({
    ok: true,
    final: 'Host is down.',
    toolSummary: { calls: 3, failures: 1 },
  });
  assert.equal(resolved.stopReason, 'end_turn');
  assert.deepEqual(statuses(resolved), [['openclaw-tools', 'completed']]);
  assert.equal(resolved.updates.at(-1).content.text, 'Host is down.');
  // An unresolved error is a failed call after the evidence, named for the
  // tool, even when OpenClaw itself called the turn ok.
  const denied = session({
    ok: true,
    final: 'Both commands were refused.',
    toolSummary: {
      calls: 2,
      failures: 2,
      unresolvedError: { toolName: 'exec' },
    },
  });
  assert.deepEqual(statuses(denied), [
    ['openclaw-tools', 'completed'],
    ['openclaw-unresolved', 'failed'],
  ]);
  assert.equal(
    denied.updates.find((update) => update.toolCallId === 'openclaw-unresolved')
      .name,
    'exec',
  );
  // No tool call, no evidence.
  assert.deepEqual(statuses(session({ ok: true, final: 'Hello.' })), []);
  assert.throws(() => session({ ok: true, final: '' }), /empty result/);
  assert.throws(() => session({ ok: false, final: 'x' }, 3), /exited 3/);
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

test('cancellation stops the turn process group and still settles', async () => {
  const { env, calls, fetchImpl } = await fixture({
    env: { FAKE_EXEC_SLEEP: '1', CLAW_TURN_DEADLINE_SECONDS: '60' },
  });
  const pending = main(env, { fetchImpl });
  // Wait until the turn has started, then deliver the pod's SIGTERM.
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

test('an evidence-bound agent answered without any tool call is not a report', async () => {
  const envelope = JSON.stringify({ ok: true, final: 'Probably fine.' });
  const { env, fetchImpl } = await fixture({
    env: { FAKE_ENVELOPE: envelope },
  });
  const result = await main(env, { fetchImpl });
  assert.deepEqual(result, {
    outcome: 'runner-failed',
    message: 'Claw turn answered without using any tool.',
  });
});

test('a resolved tool failure is evidence, not a runner failure', async () => {
  const envelope = JSON.stringify({
    ok: true,
    final: 'janeway is unreachable: probe transport refused.',
    toolSummary: { calls: 2, tools: ['exec'], failures: 1 },
  });
  const { env, fetchImpl } = await fixture({
    env: { FAKE_ENVELOPE: envelope },
  });
  const result = await main(env, { fetchImpl });
  assert.equal(result.outcome, 'report');
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
  const { env, calls, fetchImpl } = await fixture({
    env: { FAKE_DOCTOR_SLEEP: '5000', CLAW_TURN_DEADLINE_SECONDS: '1' },
  });
  const started = Date.now();
  const result = await main(env, { fetchImpl });
  assert.ok(Date.now() - started < 4000, 'setup outlived the deadline');
  assert.deepEqual(result, {
    outcome: 'runner-failed',
    message: 'Claw turn exceeded its deadline.',
  });
  assert.deepEqual(completion(calls), result);
  const log = await readFile(env.FAKE_LOG, 'utf8');
  assert.ok(!log.includes('"approvals"'), 'approvals ran after the deadline');
  assert.ok(!log.includes('"exec"'), 'the turn started after the deadline');
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
  const { env, fetchImpl } = await fixture({
    brief: agentBrief(agentFiles, { message: 'Reply with JSON only.' }),
  });
  await main(env, { fetchImpl });
  const exec = (await readFile(env.FAKE_LOG, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .find((entry) => entry.args[0] === 'agent');
  assert.equal(exec.message, 'Reply with JSON only.');
});

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
    record({ initialize: message.params, cwd: process.cwd(), key: process.env.LITELLM_API_KEY ?? null, token: process.env.LCARS_RUN_TOKEN ?? null, settings: fs.existsSync(settings) ? fs.readFileSync(settings, 'utf8') : null });
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

const harnessFiles = {
  'agent.yaml': { content: 'description: x\nharness: claude\n' },
  'home/.claude/settings.json': { content: '{"permissions":{}}' },
  'workspace/CLAUDE.md': { content: '# repository agent\n' },
};

async function harnessFixture(behaviour = {}, overrides = {}) {
  const made = await fixture({
    brief: agentBrief(harnessFiles, {
      harness: 'claude',
      requireToolEvidence: false,
      ...overrides.brief,
    }),
    env: overrides.env,
  });
  const script = join(made.root, 'harness.cjs');
  const log = join(made.root, 'harness.log');
  await writeFile(script, FAKE_HARNESS);
  await writeFile(
    join(made.root, 'harness.json'),
    JSON.stringify({ log, ...behaviour }),
  );
  const harnessLog = async () =>
    (await readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
  return {
    ...made,
    harnessLog,
    deps: {
      fetchImpl: made.fetchImpl,
      harnesses: {
        claude: () => ({ command: process.execPath, args: [script] }),
      },
    },
  };
}

const tool = (status, over = {}) => ({
  tool: { id: 't1', kind: 'execute', status, ...over },
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

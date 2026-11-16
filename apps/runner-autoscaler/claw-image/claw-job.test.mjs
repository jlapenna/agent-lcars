/* eslint-disable vitest/no-import-node-test -- the claw image's suite runs under node --test without Vitest, like the runner-image runtime suites. */
import assert from 'node:assert/strict';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createHash } from 'node:crypto';

import {
  agentDigest,
  comparableConfig,
  main,
  MAX_REPORT_BYTES,
  materializeAgent,
  readBrief,
  secretEnvironment,
  settle,
} from './claw-job.mjs';

const RUN_ID = 'run-123';

// A fake `openclaw` CLI. Behaviour per subcommand is chosen by FAKE_* env.
const FAKE_OPENCLAW = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
// The launcher gives OpenClaw a clean environment, so behaviour comes from a
// file beside this fake rather than from FAKE_* variables.
const behaviour = JSON.parse(fs.readFileSync(path.join(__dirname, 'behaviour.json'), 'utf8'));
const args = process.argv.slice(2);
const log = behaviour.FAKE_LOG;
if (log) fs.appendFileSync(log, JSON.stringify({ args, key: process.env.LITELLM_API_KEY ?? null }) + '\\n');
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
  console.log(behaviour.FAKE_ENVELOPE ?? JSON.stringify({ ok: true, final: 'All clear: disk at 41%.', toolSummary: { calls: 1, failures: 0 } }));
  process.exit(Number(behaviour.FAKE_EXEC_CODE ?? 0));
}
process.exit(64);
`;

async function fixture(overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'claw-job-'));
  const agentDir = join(root, 'agent');
  const secretsDir = join(root, 'secrets');
  const workDir = join(root, 'work');
  await mkdir(join(agentDir, 'workspace'), { recursive: true });
  await mkdir(join(secretsDir, 'env'), { recursive: true });
  await mkdir(workDir, { recursive: true });
  await writeFile(
    join(agentDir, 'config.json'),
    JSON.stringify({
      tools: { profile: 'minimal', exec: { mode: 'allowlist' } },
    }),
  );
  await writeFile(join(agentDir, 'approvals.json'), '{"version":1}');
  await writeFile(join(agentDir, 'workspace', 'AGENTS.md'), '# investigator\n');
  await writeFile(join(secretsDir, 'env', 'LITELLM_API_KEY'), 'sk-test\n');
  const openclaw = join(root, 'openclaw');
  await writeFile(openclaw, FAKE_OPENCLAW);
  const behaviour = { FAKE_LOG: join(root, 'openclaw.log') };
  for (const [name, value] of Object.entries(overrides.env ?? {}))
    if (name.startsWith('FAKE_')) behaviour[name] = value;
  await writeFile(join(root, 'behaviour.json'), JSON.stringify(behaviour));
  await chmod(openclaw, 0o755);
  const calls = [];
  const brief = overrides.brief ?? {
    intentId: RUN_ID,
    pipeline: 'claw-investigator',
    mode: 'claw',
    claw: {
      operation: 'investigate:v1',
      input: { question: 'Why is the disk alert firing?' },
    },
  };
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
    CLAW_AGENT_DIR: agentDir,
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
  assert.match(result.message, /unresolved exec error/);
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

test('settle maps envelopes conservatively', () => {
  assert.deepEqual(settle({ code: 0, timedOut: false, stdout: 'not json' }), {
    outcome: 'runner-failed',
    message: 'OpenClaw exited 0 without a JSON result.',
  });
  assert.equal(
    settle({
      code: 0,
      timedOut: false,
      stdout: JSON.stringify({ ok: true, final: '' }),
    }).outcome,
    'runner-failed',
  );
  assert.equal(
    settle({
      code: 1,
      timedOut: false,
      stdout: JSON.stringify({
        ok: false,
        error: { message: 'model refused' },
      }),
    }).message,
    'Claw turn failed: model refused.',
  );
  const cleanup = settle({
    code: 1,
    timedOut: false,
    stdout: JSON.stringify({
      ok: true,
      final: 'Report.',
      toolSummary: { calls: 0 },
    }),
  });
  assert.equal(cleanup.outcome, 'report');
  assert.match(cleanup.message, /cleanup failure/);
  assert.equal(
    settle({ code: 2, timedOut: false, stdout: JSON.stringify({ ok: false }) })
      .message,
    'OpenClaw model attempt timed out.',
  );
  // A long report settles whole: 200 KB, far past the former 16,000 cut.
  const long = '# Findings\n' + '監視 report line 😀\n'.repeat(10_000) + 'end';
  assert.ok(Buffer.byteLength(long) > 200_000);
  const huge = settle({
    code: 0,
    timedOut: false,
    stdout: JSON.stringify({ ok: true, final: long }),
  });
  assert.equal(huge.outcome, 'report');
  assert.equal(huge.message, long);
  // Past the completion bound it is a failed attempt, never a truncated report.
  const oversized = settle({
    code: 0,
    timedOut: false,
    stdout: JSON.stringify({
      ok: true,
      final: 'x'.repeat(MAX_REPORT_BYTES + 1),
    }),
  });
  assert.equal(oversized.outcome, 'runner-failed');
  assert.match(oversized.message, /completion bound/);
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

test('readBrief requires this run and a non-empty question', () => {
  const env = { LCARS_RUN_ID: RUN_ID };
  assert.throws(
    () =>
      readBrief(
        {
          intentId: 'other',
          pipeline: 'claw-investigator',
          mode: 'claw',
          claw: { input: { question: 'q' } },
        },
        env,
      ),
    /not a claw run/,
  );
  assert.throws(
    () =>
      readBrief(
        {
          intentId: RUN_ID,
          pipeline: 'claw-investigator',
          mode: 'claw',
          claw: { input: { question: ' ' } },
        },
        env,
      ),
    /no claw question/,
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

test('an investigation answered without any tool call is not a report', async () => {
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

test('a ConfigMap-style symlinked agent directory is read and copied', async () => {
  const { root, env, fetchImpl } = await fixture();
  // Rebuild the agent dir the way the kubelet projects a ConfigMap:
  // real files in a timestamped dir, top-level entries as symlinks.
  const projected = join(root, 'projected');
  const data = join(projected, '..2026_11_14_00_00_00.1');
  await mkdir(join(data, 'workspace'), { recursive: true });
  for (const name of ['config.json', 'approvals.json'])
    await writeFile(
      join(data, name),
      await readFile(join(env.CLAW_AGENT_DIR, name)),
    );
  await writeFile(join(data, 'workspace', 'AGENTS.md'), '# projected\n');
  await symlink('..2026_11_14_00_00_00.1', join(projected, '..data'));
  for (const name of ['config.json', 'approvals.json', 'workspace'])
    await symlink(join('..data', name), join(projected, name));
  const result = await main(
    { ...env, CLAW_AGENT_DIR: projected },
    { fetchImpl },
  );
  assert.equal(result.outcome, 'report');
  assert.equal(
    await readFile(join(env.CLAW_WORK_DIR, 'workspace', 'AGENTS.md'), 'utf8'),
    '# projected\n',
  );
});

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

test('runs a repository-owned agent from its verified brief, not the zone mount', async () => {
  const { env, calls, fetchImpl } = await fixture({
    brief: agentBrief(agentFiles),
    env: { CLAW_AGENT_DIR: '/nonexistent' },
  });
  const result = await main(env, { fetchImpl });
  assert.equal(result.outcome, 'report');
  assert.deepEqual(completion(calls), result);
  const probe = await stat(
    join(env.CLAW_WORK_DIR, 'agent', 'workspace/tools/probe'),
  );
  assert.equal(probe.mode & 0o777, 0o555);
});

test('readBrief returns an agent request with its evidence rule', () => {
  const request = readBrief(agentBrief(agentFiles), { LCARS_RUN_ID: RUN_ID });
  assert.equal(request.kind, 'agent');
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

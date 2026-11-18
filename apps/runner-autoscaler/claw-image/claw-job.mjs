#!/usr/bin/env node
// Claw runner: one agent turn per LCARS run attempt.
//
// Contract: docs/superpowers/specs/2026-10-15-unified-work-dataflow-design.md
// ("### `claw`") and docs/repository-agents.md. The QueueExecutor launches
// this image with RUNNER_MODE=claw, LCARS_RUN_ID, LCARS_CONSOLE_URL and
// LCARS_RUN_TOKEN, plus only the agent's own zone Secret items under
// CLAW_SECRETS_DIR. A repository-owned agent arrives in the brief: its files
// pinned by commit, each verified against its git blob SHA and the definition
// digest before it runs. Work input never selects the agent or its zone.
//
// The launcher is an ACP client (Agent Client Protocol,
// agentclientprotocol.com) and every harness is an ACP agent this image
// carries: OpenClaw through its own ACP server and a Gateway this Job starts
// (openclaw-harness.mjs), Claude Code and Codex through their adapters. The
// agent's manifest names the harness.
//
// Sequence (each step fails the attempt closed):
//   1. Acknowledged startup heartbeat, then the brief.
//   2. The verified definition under <work>/agent, a writable copy of its
//      `workspace/`, and its `home/` copied into HOME.
//   3. Whatever the harness needs before it can speak (for OpenClaw: config
//      validation, Doctor, exec approvals and a Gateway), then the harness
//      itself, in its own process group in the workspace, with the zone's
//      secret environment and nothing of the launcher's.
//   4. One ACP session and one prompt carrying the message. Every permission
//      request is refused.
//   5. Settle from the session's updates (settle): a report only when the
//      turn ended normally, the agent's last message is not empty and no
//      tool call is unresolved; everything else is runner-failed.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  cp,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize } from 'node:path';
import { createInterface } from 'node:readline';

import { ClawFailure, stopGroup } from './claw-process.mjs';
import { openclawHarness } from './openclaw-harness.mjs';

export { ClawFailure };

export const HEARTBEAT_INTERVAL_MS = 300_000;
// The Work API stores a report of any size whole, up to its completion bound
// (RUN_MESSAGE_MAX_BYTES, libs/dispatch-contracts/src/run-message.ts). A
// longer one is a failed attempt, never a truncated report.
export const MAX_REPORT_BYTES = 4 * 1024 * 1024;
// A message is buffered up to this size, so an oversized report is measured
// and refused rather than cut short.
const MAX_MESSAGE_BYTES = 4 * MAX_REPORT_BYTES;
const SECRET_ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const RESERVED_ENV =
  /^(LCARS_|RUNNER_MODE$|OPENCLAW_|NODE_OPTIONS$|PATH$|HOME$)/;

// The harnesses this image carries (Dockerfile). Each entry prepares what
// its harness needs and returns the ACP agent to run on stdio: its command,
// an environment when it needs more than the zone's, a `verify` that names
// any of its own settings the turn changed, and a `stop` for anything it
// started. A manifest names a harness; the command comes from
// the image, never from the definition, so reviewed source cannot choose the
// program that speaks for the agent.
const ACP_MODULES = '/opt/openclaw/node_modules/@agentclientprotocol';
const adapter = (path) => () => ({ command: process.execPath, args: [path] });
export const HARNESSES = Object.freeze({
  // OpenClaw's own ACP server, bridged to a Gateway this Job owns.
  openclaw: openclawHarness,
  claude: adapter(`${ACP_MODULES}/claude-agent-acp/dist/index.js`),
  codex: adapter(`${ACP_MODULES}/codex-acp/dist/index.js`),
});
const ACP_PROTOCOL_VERSION = 1;
const TOOL_LABEL = /^[\w.:-]{1,40}$/u;
// How long an ACP harness gets to exit by itself once its turn has ended.
const ACP_EXIT_GRACE_MS = 2_000;

// Periodic heartbeats are best effort: the lease and its recovery belong to
// LCARS, and only the startup acknowledgement gates provider work.
function ignoreHeartbeatFailure() {
  return undefined;
}

const required = (env, name) => {
  if (!env[name]) throw new ClawFailure(`${name} is required`);
  return env[name];
};

export function workClient(env, { signal, fetchImpl = fetch } = {}) {
  const base = `${required(env, 'LCARS_CONSOLE_URL')}/api/work/v1/runs/${encodeURIComponent(required(env, 'LCARS_RUN_ID'))}`;
  const token = required(env, 'LCARS_RUN_TOKEN');
  return async function call(path, body) {
    const headers = { Authorization: `Bearer ${token}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const timeout = AbortSignal.timeout(10_000);
    const response = await fetchImpl(`${base}/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      redirect: 'error',
    });
    const text = await response.text();
    if (!response.ok)
      throw new ClawFailure(`Work API ${path} HTTP ${response.status}`);
    return text ? JSON.parse(text) : {};
  };
}

// Zone Secret items under <secrets>/env/<NAME> become environment variables
// for OpenClaw (for example the agent's dedicated LiteLLM key). Other items
// (SSH keys, known_hosts) stay files that the agent's tools read by path.
export async function secretEnvironment(secretsDir) {
  const envDir = join(secretsDir, 'env');
  let names;
  try {
    names = await readdir(envDir);
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
  const environment = {};
  for (const name of names.sort()) {
    if (name.startsWith('..')) continue; // projected-volume bookkeeping
    if (!SECRET_ENV_NAME.test(name) || RESERVED_ENV.test(name))
      throw new ClawFailure(`zone secret env name is not allowed: ${name}`);
    environment[name] = (await readFile(join(envDir, name), 'utf8')).trim();
  }
  return environment;
}

/** The claw request this attempt runs: a repository-owned agent round, its
 * pinned files and message. */
export function readBrief(brief, env) {
  if (
    !brief ||
    brief.intentId !== env.LCARS_RUN_ID ||
    typeof brief.pipeline !== 'string' ||
    !brief.pipeline.startsWith('claw-') ||
    brief.mode !== 'claw'
  )
    throw new ClawFailure('brief is not a claw run for this attempt');
  const claw = brief.claw ?? {};
  if (typeof claw.agent !== 'string')
    throw new ClawFailure('brief carries no agent');
  if (typeof claw.message !== 'string' || !claw.message.trim())
    throw new ClawFailure('brief carries no agent message');
  if (!Array.isArray(claw.files) || typeof claw.digest !== 'string')
    throw new ClawFailure('brief carries no agent definition');
  if (claw.harness !== undefined && typeof claw.harness !== 'string')
    throw new ClawFailure('brief names no usable harness');
  return {
    agent: claw.agent,
    harness: claw.harness ?? 'openclaw',
    message: claw.message,
    files: claw.files,
    digest: claw.digest,
    requireTools: claw.requireToolEvidence === true,
  };
}

/** The definition digest LCARS pins (repository-agent-definition.ts
 * `agentDigest`): sha256 of the canonical JSON of sorted [path, mode, sha]. */
export function agentDigest(files) {
  const rows = [...files]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map(({ path, mode, sha }) => [path, mode, sha]);
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

function gitBlobSha(content) {
  return createHash('sha1')
    .update(`blob ${content.length}\0`)
    .update(content)
    .digest('hex');
}

/** Write a repository-owned agent's files into `dir` after proving they are
 * exactly the pinned definition: every file's bytes must hash to its git
 * blob SHA, and the file list must hash to the pinned digest. Git modes
 * apply; paths cannot leave `dir`. */
export async function materializeAgent(request, dir) {
  if (agentDigest(request.files) !== request.digest)
    throw new ClawFailure('agent definition does not match its pinned digest');
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  for (const file of request.files) {
    const path = normalize(file.path);
    if (isAbsolute(path) || path === '..' || path.startsWith('../'))
      throw new ClawFailure(`agent file escapes its directory: ${file.path}`);
    if (file.mode !== '100644' && file.mode !== '100755')
      throw new ClawFailure(`agent file is not a regular file: ${file.path}`);
    const content = Buffer.from(file.content, 'base64');
    if (gitBlobSha(content) !== file.sha)
      throw new ClawFailure(`agent file does not match its blob: ${file.path}`);
    const target = join(dir, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, {
      mode: file.mode === '100755' ? 0o555 : 0o444,
    });
  }
  // Lock every directory too, deepest first, so the turn cannot add or
  // replace definition files.
  const directories = new Set([dir]);
  for (const file of request.files) {
    let parent = dirname(join(dir, normalize(file.path)));
    while (parent.startsWith(dir) && parent !== dir) {
      directories.add(parent);
      parent = dirname(parent);
    }
  }
  for (const directory of [...directories].sort(
    (left, right) => right.length - left.length,
  ))
    await chmod(directory, 0o555);
  return dir;
}

function boundedReport(report) {
  const bytes = Buffer.byteLength(report, 'utf8');
  if (bytes > MAX_REPORT_BYTES)
    return {
      outcome: 'runner-failed',
      message: `Claw report is ${bytes} bytes; the completion bound is ${MAX_REPORT_BYTES}.`,
    };
  return { outcome: 'report', message: report };
}

// Decide the attempt outcome from an ACP turn (acpTurn):
// - the report is the agent's last message after its last tool call, so
//   neither narration before a tool call nor a harness notice ahead of the
//   answer is mistaken for it;
// - a tool call that failed or never finished is an unresolved tool error
//   unless a later call, started after it ended, completed: that later call
//   is the agent accounting for the failure, as a retried probe does;
// - an agent whose manifest sets `requireToolEvidence` must rest its answer
//   on tool evidence: a report with no tool call is an unsupported answer.
// A harness can report a turn that died early as an ordinary end of turn
// with no text, so an empty result is always a failure.
export function settle(
  { aborted, timedOut, error, stopReason, final, overflow, calls, unresolved },
  { requireTools = false } = {},
) {
  if (aborted)
    return { outcome: 'runner-failed', message: 'Claw turn was cancelled.' };
  if (timedOut)
    return {
      outcome: 'runner-failed',
      message: 'Claw turn exceeded its deadline.',
    };
  const failed = (reason) => ({
    outcome: 'runner-failed',
    message: `Claw turn failed: ${reason}.`,
  });
  if (error) return failed(String(error).slice(0, 500));
  if (stopReason !== 'end_turn')
    return failed(`harness stopped with ${String(stopReason).slice(0, 80)}`);
  if (overflow)
    return failed(`report exceeds the ${MAX_REPORT_BYTES}-byte bound`);
  if (unresolved) return failed(`unresolved ${unresolved.label} tool call`);
  const report = (final ?? '').trim();
  if (!report) return failed('empty result');
  if (requireTools && !(calls > 0))
    return {
      outcome: 'runner-failed',
      message: 'Claw turn answered without using any tool.',
    };
  return boundedReport(report);
}

// Runs one ACP turn: starts the harness in its own process group, speaks
// newline-delimited JSON-RPC over its stdio, and resolves with what the
// session showed. The launcher advertises no client capability (no file
// system, no terminal) and refuses every permission request: an unattended run
// has nobody to ask, so what the agent may do is whatever its reviewed harness
// settings already allow.
export function acpTurn(command, args, { env, cwd, message, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ClawFailure('claw run was cancelled'));
      return;
    }
    const child = spawn(command, args, {
      env,
      cwd,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const turn = { final: '', overflow: false, calls: 0 };
    const tools = new Map();
    const pending = new Map();
    let nextId = 1;
    let aborted = false;
    const send = (payload) => {
      if (child.stdin.writable)
        child.stdin.write(
          `${JSON.stringify({ jsonrpc: '2.0', ...payload })}\n`,
        );
    };
    const request = (method, params) =>
      new Promise((answer, refuse) => {
        const id = nextId++;
        pending.set(id, { answer, refuse });
        send({ id, method, params });
      });
    let sequence = 0;
    const running = (tool) =>
      tool.status === 'pending' || tool.status === 'in_progress';
    let messageId;
    const startMessage = (id) => {
      messageId = id;
      turn.final = '';
      turn.overflow = false;
    };
    const onUpdate = (update) => {
      if (
        update?.sessionUpdate === 'agent_message_chunk' &&
        typeof update.content?.text === 'string'
      ) {
        // A new message replaces the one before it: the report is the agent's
        // last message, not a harness notice that preceded it.
        if (update.messageId !== messageId) startMessage(update.messageId);
        if (turn.final.length + update.content.text.length > MAX_MESSAGE_BYTES)
          turn.overflow = true;
        else turn.final += update.content.text;
        return;
      }
      if (
        (update?.sessionUpdate === 'tool_call' ||
          update?.sessionUpdate === 'tool_call_update') &&
        typeof update.toolCallId === 'string'
      ) {
        const known = tools.get(update.toolCallId);
        const tool = known ?? {
          label: 'other',
          status: 'pending',
          started: ++sequence,
        };
        // A harness may name the tool; its ACP kind is the fallback. The
        // title is never used: it can carry the command itself.
        for (const label of [update.kind, update.name])
          if (typeof label === 'string' && TOOL_LABEL.test(label))
            tool.label = label;
        const changed =
          typeof update.status === 'string' && update.status !== tool.status;
        if (changed) {
          tool.status = update.status;
          tool.ended = running(tool) ? undefined : ++sequence;
        }
        if (!known) tools.set(update.toolCallId, tool);
        // The answer is the message after the last change in any tool call,
        // so text written while a tool was still running is never the
        // report. A repeated notice of a status already seen changes nothing.
        if (!known || changed) startMessage(undefined);
      }
    };
    // A call that failed or never finished is resolved only by a call that
    // started after it ended and completed. Calls running side by side do
    // not resolve each other.
    const unresolved = () => {
      const calls = [...tools.values()];
      const open = calls.find(
        (tool) =>
          tool.status !== 'completed' &&
          !calls.some(
            (later) =>
              later.status === 'completed' &&
              later.started > (tool.ended ?? Infinity),
          ),
      );
      return open && { label: open.label, status: open.status };
    };
    const onLine = (line) => {
      let incoming;
      try {
        incoming = JSON.parse(line);
      } catch {
        return; // not protocol: a harness may log to stdout
      }
      if (!incoming || typeof incoming !== 'object') return;
      try {
        onMessage(incoming);
      } catch {
        // Nothing a harness sends may take the launcher down before it has
        // settled the attempt.
        turn.error ??= 'harness sent a malformed ACP message';
        stopGroup(child);
      }
    };
    const onMessage = (incoming) => {
      if (incoming.method === undefined) {
        const waiter = pending.get(incoming.id);
        if (!waiter) return;
        pending.delete(incoming.id);
        if (incoming.error)
          waiter.refuse(
            new ClawFailure(
              String(incoming.error.message ?? 'harness error').slice(0, 500),
            ),
          );
        else waiter.answer(incoming.result ?? {});
      } else if (incoming.id === undefined) {
        if (incoming.method === 'session/update')
          onUpdate(incoming.params?.update);
      } else if (incoming.method === 'session/request_permission') {
        const options = incoming.params?.options;
        const reject = (Array.isArray(options) ? options : []).find(
          (option) =>
            option?.kind === 'reject_once' || option?.kind === 'reject_always',
        );
        send({
          id: incoming.id,
          result: {
            outcome: reject
              ? { outcome: 'selected', optionId: reject.optionId }
              : { outcome: 'cancelled' },
          },
        });
      } else {
        send({
          id: incoming.id,
          error: { code: -32601, message: 'Method not found' },
        });
      }
    };
    createInterface({ input: child.stdout }).on('line', onLine);
    // stderr carries harness diagnostics; never forward it.
    child.stderr.resume();
    child.stdin.on('error', () => undefined);
    const onAbort = () => {
      aborted = true;
      stopGroup(child);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (error) => {
      signal?.removeEventListener('abort', onAbort);
      reject(error);
    });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      for (const waiter of pending.values())
        waiter.refuse(new ClawFailure(`harness exited ${code} mid-turn`));
      pending.clear();
      // Let the session below record its outcome before this resolves.
      setImmediate(() =>
        resolve({
          ...turn,
          calls: tools.size,
          unresolved: unresolved(),
          aborted,
          code,
        }),
      );
    });
    (async () => {
      const initialized = await request('initialize', {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: { name: 'lcars-claw-runner', version: '1' },
      });
      if (initialized.protocolVersion !== ACP_PROTOCOL_VERSION)
        throw new ClawFailure(
          `harness speaks ACP protocol ${initialized.protocolVersion}`,
        );
      const session = await request('session/new', { cwd, mcpServers: [] });
      const prompted = await request('session/prompt', {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: message }],
      });
      turn.stopReason = prompted.stopReason;
    })()
      .catch((error) => {
        turn.error ??=
          error instanceof ClawFailure ? error.message : 'ACP session failed';
      })
      .finally(() => {
        // The turn is over: close the session's input, then stop whatever
        // the harness left running.
        child.stdin.end();
        setTimeout(() => stopGroup(child), ACP_EXIT_GRACE_MS).unref();
      });
  });
}

async function ownerWritable(path) {
  const info = await stat(path);
  await chmod(path, info.mode | 0o200);
  if (info.isDirectory())
    for (const entry of await readdir(path))
      await ownerWritable(join(path, entry));
}

// Copies one directory of the locked definition into a directory the agent
// may write. A definition without that directory contributes nothing.
async function copyFromDefinition(source, target) {
  try {
    // A ConfigMap mount presents a directory as a symlink into its
    // timestamped data directory; copy the resolved files, not the link.
    await cp(await realpath(source), target, {
      recursive: true,
      dereference: true,
    });
    // The pinned definition stays locked; its execution copy is the agent's
    // to write, so give the owner write access back.
    await ownerWritable(target);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

// The agent's writable workspace: a fresh copy of the definition's
// `workspace/`, or an empty directory when the definition has none.
export async function prepareWorkspace(agentDir, workRoot) {
  const workspace = join(workRoot, 'workspace');
  await rm(workspace, { recursive: true, force: true });
  await mkdir(workspace, { recursive: true });
  await copyFromDefinition(join(agentDir, 'workspace'), workspace);
  return workspace;
}

function positiveInteger(env, name, fallback) {
  if (env[name] === undefined || env[name] === '') return fallback;
  const value = Number(env[name]);
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new ClawFailure(`${name} must be a positive integer`);
  return value;
}

// Prepares the agent's workspace and HOME, runs its turn on the harness it
// names and resolves with the finished turn.
async function harnessTurn({
  request,
  harnesses,
  definitionDir,
  workRoot,
  openclaw,
  env,
  signal,
  started,
}) {
  if (!Object.hasOwn(harnesses, request.harness))
    throw new ClawFailure(`this image carries no ${request.harness} harness`);
  const workspace = await prepareWorkspace(definitionDir, workRoot);
  // A harness reads its user-level settings from HOME. The definition's
  // `home/` supplies them, so the tool policy a harness trusts (it ignores
  // allow rules found in an untrusted workspace) is reviewed source too.
  await copyFromDefinition(join(definitionDir, 'home'), env.HOME);
  const settings = request.files.filter((file) =>
    normalize(file.path).startsWith('home/'),
  );
  const inHome = (file) =>
    join(env.HOME, normalize(file.path).slice('home/'.length));
  for (const file of settings) await chmod(inHome(file), 0o444);
  const harness = await harnesses[request.harness]({
    definitionDir,
    workRoot,
    workspace,
    // For a harness whose own preparation may write into the workspace.
    stageWorkspace: () => prepareWorkspace(definitionDir, workRoot),
    openclaw,
    env,
    signal,
  });
  try {
    if (signal.aborted) throw new ClawFailure('claw run was cancelled');
    const turn = acpTurn(harness.command, harness.args, {
      env: harness.env ?? env,
      cwd: workspace,
      message: request.message,
      signal,
    });
    // The turn is awaited after the heartbeat; a spawn failure in between
    // must reach that await, not become an unhandled rejection.
    turn.catch(() => undefined);
    await started();
    const finished = await turn;
    // The harness runs as the launcher's UID, so nothing can stop an agent
    // with a write-capable tool from rewriting the settings that bound it.
    // What the launcher can do is refuse a result when it sees that: every
    // pinned `home/` file must still be its blob once the turn is over. A
    // file the agent added, or changed and put back, is not seen.
    const changed = async () => {
      for (const file of settings) {
        const content = await readFile(inHome(file)).catch(() => undefined);
        if (content === undefined || gitBlobSha(content) !== file.sha)
          return file.path;
      }
      return harness.verify?.();
    };
    const what = await changed();
    return what === undefined
      ? finished
      : {
          ...finished,
          error: `the agent changed its harness settings (${what})`,
        };
  } finally {
    await harness.stop?.();
  }
}

export async function main(env = process.env, deps = {}) {
  const controller = new AbortController();
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'])
    process.once(signal, () => controller.abort());
  const call = workClient(env, {
    signal: controller.signal,
    fetchImpl: deps.fetchImpl,
  });
  // Settlement must still be attempted after cancellation, under its own
  // request timeout only.
  const settleCall = workClient(env, { fetchImpl: deps.fetchImpl });
  const openclaw =
    env.OPENCLAW_BIN || '/opt/openclaw/node_modules/.bin/openclaw';
  const secretsDir = env.CLAW_SECRETS_DIR || '/run/claw-secrets';
  const workRoot = env.CLAW_WORK_DIR || '/work';
  const started = Date.now();
  const turnDeadlineMs =
    positiveInteger(env, 'CLAW_TURN_DEADLINE_SECONDS', 2400) * 1000;
  const heartbeatMs = positiveInteger(
    env,
    'CLAW_HEARTBEAT_INTERVAL_MS',
    HEARTBEAT_INTERVAL_MS,
  );

  // 1. The server's startup fence: no provider work before acknowledgement.
  const ack = await call('heartbeat', {});
  if (ack.runId !== env.LCARS_RUN_ID || typeof ack.expiresAt !== 'string')
    throw new ClawFailure('startup heartbeat was not acknowledged');

  const heartbeat = setInterval(() => {
    call('heartbeat', {}).catch(ignoreHeartbeatFailure);
  }, heartbeatMs);
  heartbeat.unref();
  // One absolute deadline, measured from launcher start, bounds setup and
  // the turn alike; the pod deadline sits a fixed margin above it so the
  // runner-failed completion below always has time to land. Each command's
  // own timeout is only an inner cap.
  const deadline = new AbortController();
  const deadlineTimer = setTimeout(
    () => deadline.abort(),
    Math.max(0, turnDeadlineMs - (Date.now() - started)),
  );
  deadlineTimer.unref();
  const work = AbortSignal.any([controller.signal, deadline.signal]);
  try {
    let result;
    try {
      const brief = await call('brief');
      const request = readBrief(brief, env);
      // A repository-owned agent defines its own response contract in its
      // AGENTS.md, so the turn receives exactly its message.
      const definitionDir = await materializeAgent(
        request,
        join(workRoot, 'agent'),
      );
      const baseEnv = {
        PATH: env.PATH || '/usr/local/bin:/usr/bin:/bin',
        HOME: env.HOME || '/work/home',
        LANG: 'C.UTF-8',
        ...(await secretEnvironment(secretsDir)),
      };
      await mkdir(baseEnv.HOME, { recursive: true });
      const finished = await harnessTurn({
        request,
        harnesses: { ...HARNESSES, ...deps.harnesses },
        definitionDir,
        workRoot,
        openclaw,
        env: baseEnv,
        signal: work,
        started: () =>
          call('heartbeat', { providerProcessStarted: true }).catch(
            ignoreHeartbeatFailure,
          ),
      });
      result = settle(
        {
          ...finished,
          aborted: controller.signal.aborted,
          timedOut: deadline.signal.aborted && !controller.signal.aborted,
        },
        { requireTools: request.requireTools },
      );
    } catch (error) {
      if (controller.signal.aborted)
        result = {
          outcome: 'runner-failed',
          message: 'Claw turn was cancelled.',
        };
      else if (deadline.signal.aborted)
        result = {
          outcome: 'runner-failed',
          message: 'Claw turn exceeded its deadline.',
        };
      else
        result = {
          outcome: 'runner-failed',
          message:
            error instanceof ClawFailure
              ? `Claw setup failed: ${error.message}.`
              : 'Claw runner failed unexpectedly before settling.',
        };
      if (!(error instanceof ClawFailure) && !work.aborted)
        console.error(error);
    }
    await settleCall('complete', result);
    return result;
  } finally {
    clearInterval(heartbeat);
    clearTimeout(deadlineTimer);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(
    (result) => {
      console.log(`claw run settled: ${result.outcome}`);
      process.exit(0);
    },
    (error) => {
      console.error(
        error instanceof ClawFailure
          ? `claw run aborted: ${error.message}`
          : error,
      );
      process.exit(1);
    },
  );
}

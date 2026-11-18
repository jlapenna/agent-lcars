#!/usr/bin/env node
// OpenClaw as an ACP agent: the `openclaw` harness of the claw runner.
//
// The launcher (claw-job.mjs) is an ACP client and nothing else. OpenClaw's
// own ACP server (`openclaw acp`) only bridges to a Gateway, so this adapter
// speaks ACP on stdio and runs each prompt as one embedded, Gateway-less
// `openclaw agent exec` turn.
//
// Usage: openclaw-acp.mjs <agent dir> <work dir> <openclaw binary>
//
// One prompt (each step fails the prompt with a JSON-RPC error):
//   1. Fresh state: writable config copy, OPENCLAW_STATE_DIR/CONFIG_PATH.
//   2. `openclaw config validate --json` must report valid. `agent exec`
//      itself silently ignores unknown keys.
//   3. `openclaw doctor --fix --non-interactive`; it must not change the
//      pinned config beyond its own `meta`/`wizard` stamps.
//   4. `openclaw approvals set --file` seeds the enforcing exec approvals.
//   5. `openclaw agent exec --json` in the session's working directory.
//   6. The JSON envelope becomes session updates (sessionFromEnvelope).

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { ClawFailure, MAX_REPORT_BYTES, stopGroup } from './claw-job.mjs';

// OpenClaw's JSON envelope carries the report plus metadata and escaping;
// keep room for a maximal report so it is measured, not misparsed.
const MAX_ENVELOPE_BYTES = 4 * MAX_REPORT_BYTES;
// The launcher stops this adapter's process group and kills it ten seconds
// later. OpenClaw runs in a group of its own, so it must be gone sooner.
const STOP_GRACE_MS = 5_000;

// Strip OpenClaw's own bookkeeping so the pinned config can be compared with
// what Doctor leaves behind. Anything else Doctor changes fails the attempt.
export function comparableConfig(config) {
  const { meta: _meta, wizard: _wizard, ...rest } = config;
  return JSON.stringify(sortKeys(rest));
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys(value[key])]),
    );
  return value;
}

// Runs one OpenClaw command in its own process group, so a timeout or a
// cancellation stops the whole tree, including any tool processes the agent
// started.
export function run(command, args, { env, cwd, timeoutMs, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ClawFailure('claw run was cancelled'));
      return;
    }
    const child = spawn(command, args, {
      env,
      cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let timedOut = false;
    let aborted = false;
    const stop = () => stopGroup(child, STOP_GRACE_MS);
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            stop();
          }, timeoutMs)
        : undefined;
    const onAbort = () => {
      aborted = true;
      stop();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    // Decode as a stream: a multi-byte character can straddle two chunks.
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (stdout.length < MAX_ENVELOPE_BYTES) stdout += chunk;
    });
    // stderr carries OpenClaw diagnostics; never forward it, since it can
    // echo resolved configuration.
    child.stderr.resume();
    child.on('error', (error) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ code, timedOut, aborted, stdout });
    });
  });
}

export async function prepareState({
  agentDir,
  workRoot,
  openclaw,
  env,
  signal,
}) {
  const stateDir = await mkdtemp(join(workRoot, 'state-'));
  const pinned = JSON.parse(
    await readFile(join(agentDir, 'config.json'), 'utf8'),
  );
  const configPath = join(stateDir, 'agent-config.json');
  await writeFile(configPath, `${JSON.stringify(pinned, null, 2)}\n`, {
    mode: 0o600,
  });
  const childEnv = {
    ...env,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_NO_AUTO_UPDATE: '1',
  };

  const validation = await run(openclaw, ['config', 'validate', '--json'], {
    env: childEnv,
    timeoutMs: 120_000,
    signal,
  });
  let valid;
  try {
    valid = JSON.parse(validation.stdout).valid === true;
  } catch {
    valid = false;
  }
  if (!valid) throw new ClawFailure('pinned OpenClaw config failed validation');

  const doctor = await run(openclaw, ['doctor', '--fix', '--non-interactive'], {
    env: childEnv,
    timeoutMs: 300_000,
    signal,
  });
  if (doctor.code !== 0 || doctor.timedOut)
    throw new ClawFailure(`openclaw doctor exited ${doctor.code}`);
  const after = JSON.parse(await readFile(configPath, 'utf8'));
  if (comparableConfig(after) !== comparableConfig(pinned))
    throw new ClawFailure(
      'openclaw doctor changed the pinned config; pin the Doctor-normalized config',
    );

  const approvals = await run(
    openclaw,
    ['approvals', 'set', '--file', join(agentDir, 'approvals.json')],
    { env: childEnv, timeoutMs: 120_000, signal },
  );
  if (approvals.code !== 0 || approvals.timedOut)
    throw new ClawFailure(`openclaw approvals set exited ${approvals.code}`);

  return { stateDir, configPath, childEnv };
}

// Turns the `agent exec --json` envelope into the ACP session a client
// settles from. Exit 0 and ok:true are returned even when every tool call
// was denied, so tool failures are read from toolSummary, not the exit code:
// - the envelope's tool calls become one completed call, which is the
//   evidence an agent with `requireToolEvidence` needs. A call that failed
//   and was then resolved (a probe of a host that is down) is part of it;
// - an unresolved tool error becomes a failed call after it, which a client
//   must treat as a failed turn;
// - the final message is the answer.
// A turn with no usable answer is an error, never an empty end of turn.
export function sessionFromEnvelope({ code, stdout }) {
  let envelope;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    throw new ClawFailure(`OpenClaw exited ${code} without a JSON result`);
  }
  const final = typeof envelope.final === 'string' ? envelope.final.trim() : '';
  const unresolved = envelope.toolSummary?.unresolvedError;
  const calls = Number(envelope.toolSummary?.calls ?? 0);
  const answered = envelope.ok === true && final && (code === 0 || code === 1);
  if (!answered && !unresolved) {
    if (code === 2) throw new ClawFailure('OpenClaw model attempt timed out');
    throw new ClawFailure(
      envelope.error?.message
        ? String(envelope.error.message).slice(0, 500)
        : final
          ? `OpenClaw exited ${code}`
          : 'empty result',
    );
  }
  const updates = [];
  const tool = (toolCallId, name, status) => {
    updates.push({
      sessionUpdate: 'tool_call',
      toolCallId,
      name,
      title: name,
      kind: 'other',
      status: 'in_progress',
    });
    updates.push({ sessionUpdate: 'tool_call_update', toolCallId, status });
  };
  if (calls > 0) tool('openclaw-tools', 'tools', 'completed');
  if (unresolved)
    tool(
      'openclaw-unresolved',
      String(unresolved.toolName ?? 'tool'),
      'failed',
    );
  if (final)
    updates.push({
      sessionUpdate: 'agent_message_chunk',
      content: {
        type: 'text',
        text:
          final +
          (code === 1
            ? '\n\n(OpenClaw reported a cleanup failure after this result.)'
            : ''),
      },
    });
  return { updates, stopReason: 'end_turn' };
}

// Runs one prompt and returns its session (updates and stop reason).
async function prompt({ agentDir, workRoot, openclaw, cwd, text, signal }) {
  const { stateDir, configPath, childEnv } = await prepareState({
    agentDir,
    workRoot,
    openclaw,
    env: process.env,
    signal,
  });
  const messageFile = join(stateDir, 'brief.md');
  await writeFile(messageFile, text, { mode: 0o600 });
  const finished = await run(
    openclaw,
    [
      'agent',
      'exec',
      '--config',
      configPath,
      '--state-dir',
      stateDir,
      '--message-file',
      messageFile,
      '--cwd',
      cwd,
      '--json',
    ],
    { env: childEnv, cwd, signal },
  );
  if (finished.aborted) throw new ClawFailure('claw run was cancelled');
  return sessionFromEnvelope(finished);
}

export function serve({ agentDir, workRoot, openclaw }) {
  const controller = new AbortController();
  let running = 0;
  let closed = false;
  // Stops any turn still running, then exits once it has answered. The
  // client being gone and a termination signal end the adapter the same way.
  const shutdown = () => {
    closed = true;
    controller.abort();
    if (running === 0) process.exit(0);
  };
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'])
    process.once(signal, shutdown);
  const send = (message) =>
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  const sessions = new Map();
  const handle = async ({ id, method, params }) => {
    if (method === 'initialize')
      return {
        protocolVersion: 1,
        agentCapabilities: {},
        agentInfo: { name: 'openclaw-agent-exec', version: '1' },
      };
    if (method === 'session/new') {
      if (typeof params?.cwd !== 'string')
        throw new ClawFailure('session/new needs a working directory');
      const sessionId = `openclaw-${sessions.size + 1}`;
      sessions.set(sessionId, params.cwd);
      return { sessionId };
    }
    if (method === 'session/prompt') {
      const cwd = sessions.get(params?.sessionId);
      if (cwd === undefined) throw new ClawFailure('unknown session');
      const text = (Array.isArray(params.prompt) ? params.prompt : [])
        .map((part) => (typeof part?.text === 'string' ? part.text : ''))
        .join('');
      if (!text.trim()) throw new ClawFailure('prompt carries no text');
      const { updates, stopReason } = await prompt({
        agentDir,
        workRoot,
        openclaw,
        cwd,
        text,
        signal: controller.signal,
      });
      for (const update of updates)
        send({
          method: 'session/update',
          params: { sessionId: params.sessionId, update },
        });
      return { stopReason };
    }
    if (method === 'session/cancel') controller.abort();
    if (id === undefined) return undefined;
    throw Object.assign(new ClawFailure('Method not found'), { code: -32601 });
  };
  createInterface({ input: process.stdin })
    .on('line', (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (!message || typeof message.method !== 'string') return;
      running++;
      handle(message)
        .then(
          (result) => {
            if (message.id !== undefined) send({ id: message.id, result });
          },
          (error) => {
            if (message.id === undefined) return;
            const known = error instanceof ClawFailure;
            if (!known) console.error(error);
            send({
              id: message.id,
              error: {
                code: error.code ?? -32000,
                message: known ? error.message : 'OpenClaw adapter failed',
              },
            });
          },
        )
        .finally(() => {
          running--;
          if (closed && running === 0) process.exit(0);
        });
    })
    .on('close', shutdown);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [agentDir, workRoot, openclaw] = process.argv.slice(2);
  if (!agentDir || !workRoot || !openclaw) {
    console.error(
      'usage: openclaw-acp.mjs <agent dir> <work dir> <openclaw binary>',
    );
    process.exit(64);
  }
  serve({ agentDir, workRoot, openclaw });
}

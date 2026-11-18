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
// The harness does not run in this process's hands. A harness host
// (claw-harness.mjs) prepares it, starts it and relays its stdio; the
// launcher only speaks ACP to it through that host. In a pod whose runtime
// isolates the harness, the host is another container, under another UID,
// reached over the Unix socket CLAW_HARNESS_SOCKET names: this container
// then holds the run token and the pinned definition, and the harness's
// container holds the zone's Secret items. Otherwise the host runs inside
// this process.
//
// Sequence (each step fails the attempt closed):
//   1. Acknowledged startup heartbeat, then the brief.
//   2. The verified definition under <work>/agent, and its `home/` files in
//      HOME, both written by the launcher.
//   3. The host stages a writable copy of `workspace/`, does whatever the
//      harness needs before it can speak (for OpenClaw: config validation,
//      Doctor, exec approvals and a Gateway), then starts the harness in its
//      own process group in the workspace, with the zone's secret
//      environment and nothing of the launcher's.
//   4. One ACP session and one prompt carrying the message. Every permission
//      request is refused.
//   5. Settle from the session's updates (settle): a report only when the
//      turn ended normally, the agent's last message is not empty and no
//      tool call is unresolved; everything else is runner-failed.

import { createHash } from 'node:crypto';
import {
  chmod,
  copyFile,
  mkdir,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { connect } from 'node:net';
import { dirname, isAbsolute, join, normalize } from 'node:path';
import { duplexPair } from 'node:stream';

import {
  HARNESSES,
  prepareWorkspace,
  secretEnvironment,
  serveHarness,
} from './claw-harness.mjs';
import { ClawFailure, readLines, readSettingsFile } from './claw-process.mjs';
import { answerText } from './openclaw-harness.mjs';

export { ClawFailure, HARNESSES, prepareWorkspace, secretEnvironment };

export const HEARTBEAT_INTERVAL_MS = 300_000;
// The Work API stores a report of any size whole, up to its completion bound
// (RUN_MESSAGE_MAX_BYTES, libs/dispatch-contracts/src/run-message.ts). A
// longer one is a failed attempt, never a truncated report.
export const MAX_REPORT_BYTES = 4 * 1024 * 1024;
// A message is buffered up to this size, so an oversized report is measured
// and refused rather than cut short.
const MAX_MESSAGE_BYTES = 4 * MAX_REPORT_BYTES;
// How long a harness host gets to listen, to answer a finished turn (for
// OpenClaw that includes asking its Gateway how the turn ended), and to stop
// what it started once the launcher is done with it.
const HOST_CONNECT_MS = 60_000;
const HOST_FINISH_MS = 420_000;
const HOST_CLOSE_MS = 10_000;
// How long a harness that was told to stop gets to be reported gone before
// the turn is settled without waiting for it.
const HOST_STOP_MS = 15_000;
// The longest frame read from a harness host. The host relays no line of
// the agent's output longer than a fifth of the launcher's message buffer
// allows, so a longer frame is not one the launcher could use, and it is
// never held in memory: the launcher's container is small.
const MAX_FRAME_BYTES = 48 * 1024 * 1024;

const ACP_PROTOCOL_VERSION = 1;
// A harness reads some prompts as commands of its own rather than as text
// for the agent: one that begins with `/` (OpenClaw's Gateway, Claude Code
// and Codex all do), or a bare control word such as `halt`, which OpenClaw's
// Gateway takes as an abort. A Work message is always the agent's to read,
// so every message follows this line and is never the whole prompt or its
// start.
const LITERAL_MESSAGE =
  'The message below is the request itself, not a command.';
export const promptText = (message) => `${LITERAL_MESSAGE}\n\n${message}`;
const ACP_AUTH_REQUIRED = -32000;
const TOOL_LABEL = /^[\w.:-]{1,40}$/u;
// The session-failure extension Codex's adapter implements: a client that
// declares it is told of a failed provider turn in `_meta`, on a session
// update and on the prompt's result.
const SESSION_FAILURE_CAPABILITY = Object.freeze({
  jetbrains: { air: { version: 1, capabilities: ['sessionFailure'] } },
});
// The category of a failure a harness reports as an error (`provider`,
// `limit`, …), or undefined. A warning is a retry in progress, not a
// failure. The failure's own text is never used: it can quote the request.
function sessionFailure(meta) {
  const failure = meta?.jetbrains?.air?.sessionFailure;
  if (!failure || typeof failure !== 'object' || failure.severity !== 'error')
    return undefined;
  return typeof failure.category === 'string' &&
    TOOL_LABEL.test(failure.category)
    ? failure.category
    : 'session';
}
// Message text a harness tags as commentary: what the agent says while it
// works, as opposed to its final answer. Untagged text is the answer's.
const isCommentary = (meta) => meta?.jetbrains?.air?.phase === 'commentary';

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
  // A brief that names a harness or a mode carries its files as `definition`,
  // not `files`. A launcher from before harnesses reads only `files`, so it
  // refuses such a brief instead of running the agent on OpenClaw with a
  // policy its definition never asked for.
  const selects = claw.harness !== undefined || claw.mode !== undefined;
  const files = claw.definition ?? claw.files;
  if (
    !Array.isArray(files) ||
    typeof claw.digest !== 'string' ||
    (claw.definition !== undefined && claw.files !== undefined) ||
    (selects && claw.definition === undefined)
  )
    throw new ClawFailure('brief carries no agent definition');
  for (const field of ['harness', 'mode'])
    if (claw[field] !== undefined && typeof claw[field] !== 'string')
      throw new ClawFailure(`brief names no usable ${field}`);
  return {
    agent: claw.agent,
    harness: claw.harness ?? 'openclaw',
    mode: claw.mode,
    message: claw.message,
    files,
    // `home/` is staged only for a definition that asked for this launcher
    // by naming a harness or a mode. A definition from before harnesses may
    // hold files under `home/` that no launcher ever applied, and a round
    // already admitted for one must run as it would have.
    stagesHome: claw.definition !== undefined,
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
  // Emptied, never removed: with an isolated harness this directory is a
  // volume the harness's container mounts read-only, and removing it here
  // would take that mount away.
  await mkdir(dir, { recursive: true });
  for (const entry of await readdir(dir))
    await rm(join(dir, entry), { recursive: true, force: true });
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
  {
    aborted,
    timedOut,
    error,
    failure,
    stopReason,
    final,
    overflow,
    calls,
    unresolved,
  },
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
  // A harness can end a turn its provider failed like any other; what it
  // then calls the answer may be an error message or half of one.
  if (failure) return failed(`harness reported a ${failure} failure`);
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

/** The launcher's end of the stream to a harness host (claw-harness.mjs):
 * the host's control replies, the agent's ACP lines and its exit. Everything
 * that arrives is the harness side's word, parsed and bounded here, never
 * trusted for more than the session it describes. */
export function harnessChannel(stream) {
  const write = (frame) => {
    if (stream.writable) stream.write(`${JSON.stringify(frame)}\n`);
  };
  // The host answers `launch` and `finish` in the order they were sent.
  const replies = [];
  let onAcp = () => undefined;
  let onOversize = () => undefined;
  let onExit;
  let exit;
  let gone = false;
  const closed = new Promise((done) => stream.once('close', done));
  const left = (code) => {
    if (exit !== undefined) return;
    exit = { code };
    onExit?.(code);
  };
  readLines(
    stream,
    (line) => {
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        return;
      }
      if (!frame || typeof frame !== 'object') return;
      if (typeof frame.acp === 'string') onAcp(frame.acp);
      else if (frame.claw === 'oversize') onOversize();
      else if (frame.claw === 'exit')
        left(Number.isInteger(frame.code) ? frame.code : null);
      else if (
        frame.claw === 'ready' ||
        frame.claw === 'failed' ||
        frame.claw === 'finished'
      )
        replies.shift()?.(frame);
    },
    { maxBytes: MAX_FRAME_BYTES, onOversize: () => onOversize() },
  );
  // A reset or a broken pipe is the host going away, which `close` reports.
  stream.on('error', () => undefined);
  // A host that goes away has taken the harness with it.
  void closed.then(() => {
    gone = true;
    left(null);
    for (const reply of replies.splice(0)) reply(undefined);
  });
  const ask = (frame, { signal, timeoutMs } = {}) =>
    new Promise((answer, refuse) => {
      const stop = (error) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        const at = replies.indexOf(reply);
        if (at !== -1) replies.splice(at, 1);
        refuse(error);
      };
      const reply = (value) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        answer(value);
      };
      const onAbort = () => stop(new ClawFailure('claw run was cancelled'));
      const timer =
        timeoutMs === undefined
          ? undefined
          : setTimeout(
              () => stop(new ClawFailure('the harness host did not answer')),
              timeoutMs,
            );
      if (signal?.aborted) return onAbort();
      // Nobody is left to answer.
      if (gone) return reply(undefined);
      signal?.addEventListener('abort', onAbort, { once: true });
      replies.push(reply);
      write(frame);
    });
  return {
    /** Has the host prepare and start the harness. Resolves with where the
     * agent works and what the harness needs of an ACP client. */
    async launch(harness, signal) {
      const reply = await ask({ claw: 'launch', harness }, { signal });
      if (reply?.claw === 'ready' && typeof reply.cwd === 'string')
        return {
          cwd: reply.cwd,
          auth: typeof reply.auth === 'string' ? reply.auth : undefined,
          mode: typeof reply.mode === 'string' ? reply.mode : undefined,
          promptMeta:
            reply.promptMeta && typeof reply.promptMeta === 'object'
              ? reply.promptMeta
              : undefined,
        };
      if (reply?.claw === 'failed' && typeof reply.message === 'string')
        throw new ClawFailure(reply.message.slice(0, 500));
      // The host's own unexpected failure, already on its stderr.
      throw new Error('the harness host could not start the harness');
    },
    acp: (line) => write({ acp: line }),
    onAcp: (listener) => {
      onAcp = listener;
    },
    /** Calls `listener` when the agent wrote a line too long to relay. */
    onOversize: (listener) => {
      onOversize = listener;
    },
    /** Calls `listener` once, with the agent's exit code, when the agent and
     * everything in its process group have gone. */
    onExit: (listener) => {
      if (exit !== undefined) listener(exit.code);
      else onExit = listener;
    },
    end: () => write({ claw: 'end' }),
    stop: () => write({ claw: 'stop' }),
    /** What the harness side has to say about a finished turn: a reason to
     * refuse it (`refused`), whether what bounded the harness was changed
     * (`changed`), and its own record of the final reply. `unreported` when
     * it said nothing, because it went away, took too long or the run was
     * cancelled meanwhile. A harness whose own finishing failed throws, as
     * a failed launch does. */
    async finish(turn, signal) {
      const reply = await ask(
        { claw: 'finish', turn },
        { signal, timeoutMs: HOST_FINISH_MS },
      ).catch(() => undefined);
      if (reply?.claw !== 'finished') return { unreported: true };
      if (reply.failed === true) {
        if (typeof reply.message === 'string')
          throw new ClawFailure(reply.message.slice(0, 500));
        throw new Error('the harness host could not finish the turn');
      }
      const text = (value) =>
        typeof value === 'string' ? value.slice(0, 500) : undefined;
      return {
        refused: text(reply.refused),
        changed: text(reply.changed),
        reply:
          reply.reply && typeof reply.reply === 'object'
            ? reply.reply
            : undefined,
      };
    },
    /** Lets the host stop what it started, and waits for it, within a bound. */
    async close() {
      stream.end();
      let timer;
      await Promise.race([
        closed,
        new Promise((done) => {
          timer = setTimeout(done, HOST_CLOSE_MS);
        }),
      ]);
      clearTimeout(timer);
      stream.destroy();
    },
  };
}

// Runs one ACP turn on the harness a host has started: speaks
// newline-delimited JSON-RPC to its stdio through `channel`, and resolves
// with what the session showed. The launcher advertises no client capability
// (no file system, no terminal) and refuses every permission request: an
// unattended run has nobody to ask, so what the agent may do is whatever its
// reviewed harness settings already allow.
export function acpTurn(
  channel,
  { cwd, message, mode, auth, promptMeta, signal } = {},
) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ClawFailure('claw run was cancelled'));
      return;
    }
    const turn = { final: '', overflow: false, calls: 0 };
    const tools = new Map();
    const pending = new Map();
    let nextId = 1;
    let aborted = false;
    const send = (payload) =>
      channel.acp(JSON.stringify({ jsonrpc: '2.0', ...payload }));
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
      const failure = sessionFailure(update?._meta);
      if (failure !== undefined) turn.failure = failure;
      if (
        update?.sessionUpdate === 'agent_message_chunk' &&
        typeof update.content?.text === 'string'
      ) {
        // A new message replaces the one before it: the report is the agent's
        // last message, not a harness notice that preceded it. Text with no
        // message id after an identified message is a harness's own remark
        // on the turn, never the answer. Nor is text the harness marks as
        // said on the way to the answer (Codex does, for a client that
        // declares the extension the session-failure reports come with).
        if (isCommentary(update._meta)) return;
        if (update.messageId === undefined && messageId !== undefined) return;
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
        channel.stop();
      }
    };
    // A line too long to be relayed, or to be held here, is no answer.
    channel.onOversize(() => {
      turn.error ??= 'harness sent an oversized ACP message';
      channel.stop();
    });
    const onMessage = (incoming) => {
      if (incoming.method === undefined) {
        const waiter = pending.get(incoming.id);
        if (!waiter) return;
        pending.delete(incoming.id);
        if (incoming.error)
          waiter.refuse(
            Object.assign(
              new ClawFailure(
                String(incoming.error.message ?? 'harness error').slice(0, 500),
              ),
              { code: incoming.error.code },
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
    channel.onAcp(onLine);
    // The host reports the exit once the harness and everything in its
    // process group have gone, so nothing of the harness still runs while
    // the launcher checks the settings it could change and settles.
    let stopping;
    const exited = (code) => {
      clearTimeout(stopping);
      signal?.removeEventListener('abort', onAbort);
      for (const waiter of pending.values())
        waiter.refuse(new ClawFailure(`harness exited ${code} mid-turn`));
      pending.clear();
      // The session below gets to record its outcome before this resolves.
      setImmediate(() =>
        resolve({
          ...turn,
          calls: tools.size,
          unresolved: unresolved(),
          aborted,
          code,
        }),
      );
    };
    const onAbort = () => {
      aborted = true;
      channel.stop();
      // A cancelled or overdue run is settled even when the harness cannot
      // be seen to go: something of it may have left its process group and
      // still hold its output open.
      stopping = setTimeout(() => exited(null), HOST_STOP_MS);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    channel.onExit(exited);
    (async () => {
      const initialized = await request('initialize', {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
          // A harness that has something to say other than the answer sends
          // it as a `notice`, not as message text (Claude Code does, for a
          // client that declares this).
          session: { notices: {} },
          // A harness whose provider failed sends that as a typed session
          // failure, not as message text ending an ordinary turn (Codex
          // does, for a client that declares this).
          _meta: SESSION_FAILURE_CAPABILITY,
        },
        clientInfo: { name: 'lcars-claw-runner', version: '1' },
      });
      if (initialized.protocolVersion !== ACP_PROTOCOL_VERSION)
        throw new ClawFailure(
          `harness speaks ACP protocol ${initialized.protocolVersion}`,
        );
      const open = () => request('session/new', { cwd, mcpServers: [] });
      // A harness that wants signing in first says so (ACP's auth_required).
      // The image names the one unattended method it has for that harness;
      // with it the launcher signs in once and opens the session again.
      const session = await open().catch(async (error) => {
        const offered = initialized.authMethods;
        if (
          error.code !== ACP_AUTH_REQUIRED ||
          auth === undefined ||
          !Array.isArray(offered) ||
          !offered.some((method) => method?.id === auth)
        )
          throw error;
        await request('authenticate', { methodId: auth });
        return open();
      });
      // The manifest's mode is the agent's reviewed permission policy: a
      // harness that does not offer it, or will not switch to it, runs
      // nothing.
      if (mode !== undefined) {
        const offered = session.modes?.availableModes;
        if (
          !Array.isArray(offered) ||
          !offered.some((candidate) => candidate?.id === mode)
        )
          throw new ClawFailure(`harness offers no ${mode} mode`);
        await request('session/set_mode', {
          sessionId: session.sessionId,
          modeId: mode,
        });
      }
      // The harness's own name for the session, for a harness that has a
      // record of the turn to check afterwards.
      turn.sessionId = session.sessionId;
      const prompted = await request('session/prompt', {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: promptText(message) }],
        // What a harness reads from a prompt beyond ACP's own fields.
        ...(promptMeta === undefined ? {} : { _meta: promptMeta }),
      });
      turn.stopReason = prompted.stopReason;
      // The harness's last word on the turn: a failure it attaches to the
      // result stands, and a result without one does not clear a failure
      // already reported.
      turn.failure = sessionFailure(prompted._meta) ?? turn.failure;
    })()
      .catch((error) => {
        turn.error ??=
          error instanceof ClawFailure ? error.message : 'ACP session failed';
      })
      .finally(() => {
        // The turn is over: the host closes the session's input, then stops
        // whatever the harness left running.
        channel.end();
      });
  });
}

function positiveInteger(env, name, fallback) {
  if (env[name] === undefined || env[name] === '') return fallback;
  const value = Number(env[name]);
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new ClawFailure(`${name} must be a positive integer`);
  return value;
}

// The stream to the harness host. With CLAW_HARNESS_SOCKET the host is the
// pod's harness container, which may still be starting. Without it the host
// runs here, in the launcher's own process, on the other end of an in-memory
// pair: the same protocol either way.
async function harnessStream(env, harnesses, signal) {
  const path = env.CLAW_HARNESS_SOCKET;
  if (!path) {
    const [near, far] = duplexPair();
    void serveHarness(far, { harnesses, env });
    return near;
  }
  const until = Date.now() + HOST_CONNECT_MS;
  for (;;) {
    if (signal.aborted) throw new ClawFailure('claw run was cancelled');
    const socket = await new Promise((connected) => {
      const attempt = connect(path);
      attempt.once('connect', () => connected(attempt));
      attempt.once('error', () => connected(undefined));
    });
    if (socket) return socket;
    if (Date.now() >= until)
      throw new ClawFailure('the harness container did not start');
    await new Promise((retry) => setTimeout(retry, 250));
  }
}

// Writes the definition's pinned `home/` files into HOME, as the launcher.
// A harness reads its user-level settings from HOME, so the tool policy a
// harness trusts (it ignores allow rules found in an untrusted workspace) is
// reviewed source too. Each file is read-only, and every directory on the
// way to one is sticky and group-writable. A harness that runs as another
// user of the launcher's group can therefore keep its own state beside a
// pinned file, and cannot change, remove, rename or replace the file or any
// directory that leads to it: the kernel refuses, because it owns neither.
// Under the launcher's own UID the modes change nothing, which is why the
// files are also checked after the turn.
async function stageHome(definitionDir, home, files) {
  const pinned = files.filter((file) =>
    normalize(file.path).startsWith('home/'),
  );
  if (pinned.length === 0) return [];
  const shared = async (directory) => {
    await mkdir(directory, { recursive: true });
    await chmod(directory, 0o1775);
  };
  await shared(home);
  for (const file of pinned) {
    const relative = normalize(file.path).slice('home/'.length);
    const target = join(home, relative);
    const parents = [];
    for (
      let parent = dirname(target);
      parent !== home && parent.startsWith(home);
      parent = dirname(parent)
    )
      parents.unshift(parent);
    for (const parent of parents) await shared(parent);
    await copyFile(join(definitionDir, normalize(file.path)), target);
    // An executable (a hook's helper) stays one.
    await chmod(target, file.mode === '100755' ? 0o555 : 0o444);
  }
  return pinned.map((file) => ({
    ...file,
    target: join(home, normalize(file.path).slice('home/'.length)),
  }));
}

// Stages the agent's pinned HOME files, has the harness host run its turn on
// the harness it names and resolves with the finished turn.
async function harnessTurn({
  request,
  harnesses,
  definitionDir,
  env,
  signal,
  started,
}) {
  const channel = harnessChannel(await harnessStream(env, harnesses, signal));
  let finished;
  let settings;
  try {
    if (signal.aborted) throw new ClawFailure('claw run was cancelled');
    // Only a definition that names a harness or a mode has `home/` applied,
    // and it is in place before the host starts anything.
    settings = request.stagesHome
      ? await stageHome(definitionDir, env.HOME || '/work/home', request.files)
      : [];
    const harness = await channel.launch(request.harness, signal);
    const turn = acpTurn(channel, {
      cwd: harness.cwd,
      message: request.message,
      mode: request.mode ?? harness.mode,
      auth: harness.auth,
      promptMeta: harness.promptMeta,
      signal,
    });
    turn.catch(() => undefined);
    await started();
    finished = await turn;
  } catch (error) {
    await channel.close();
    throw error;
  }
  // The harness side stops whatever it started and names any reason it has
  // to refuse the turn's result. A harness with a record of its own of the
  // final reply sends that too: it says which part of what it streamed is
  // the answer (answerText).
  let verdict;
  try {
    verdict = await channel.finish(
      {
        sessionId: finished.sessionId,
        aborted: finished.aborted,
        error: finished.error,
      },
      signal,
    );
  } finally {
    await channel.close();
  }
  // In this order: the harness's own reason to refuse the turn, a final
  // reply that cannot be placed, then a change to what bounded the harness.
  let refused = verdict.refused;
  if (verdict.reply !== undefined) {
    const final = verdict.reply.empty
      ? ''
      : answerText(
          finished.final,
          typeof verdict.reply.text === 'string'
            ? verdict.reply.text
            : undefined,
        );
    // Only OpenClaw's host sends a record of the reply.
    if (final === undefined)
      refused ??=
        "OpenClaw's final reply could not be told from what preceded it";
    else finished = { ...finished, final };
  }
  refused ??= verdict.changed;
  // A harness side that said nothing fails a turn that had not already
  // failed for a reason of its own.
  if (verdict.unreported && !finished.error)
    refused = "the harness did not report the turn's outcome";
  // Under an isolated harness the kernel keeps the pinned `home/` files as
  // they were written. Without one the harness runs as the launcher's UID,
  // and nothing can stop an agent with a write-capable tool from rewriting
  // the settings that bound it. So the launcher always refuses a result
  // when a pinned file is no longer its blob once the turn is over. A file
  // the agent added, or changed and put back, is not seen. Its tools could
  // also have put anything at these paths, so each is read only as a
  // regular file of its pinned size, within a bounded time.
  for (const file of settings) {
    const content = await readSettingsFile(file.target, {
      maxBytes: Buffer.byteLength(file.content, 'base64'),
    });
    if (content === undefined || gitBlobSha(content) !== file.sha)
      return {
        ...finished,
        error: `the agent changed its harness settings (${file.path})`,
      };
  }
  return refused === undefined ? finished : { ...finished, error: refused };
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
      const finished = await harnessTurn({
        request,
        harnesses: { ...HARNESSES, ...deps.harnesses },
        definitionDir,
        env,
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

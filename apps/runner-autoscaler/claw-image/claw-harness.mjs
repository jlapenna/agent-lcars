#!/usr/bin/env node
// Claw harness host: the side of a claw run that the agent's harness runs on.
//
// The launcher (claw-job.mjs) holds the run's token and decides its outcome.
// This host holds what the agent may use: the zone's Secret items, a writable
// workspace and the harness itself. It prepares the harness, starts it as an
// ACP agent on stdio and relays that stdio to the launcher. It never sees the
// run token and never talks to LCARS.
//
// The two speak newline-delimited JSON over one stream. Without
// CLAW_HARNESS_SOCKET the launcher runs this host inside its own process.
// With it, the executor runs this file as the pod's harness container, under
// another UID, with the pinned definition mounted read-only, and the stream
// is a Unix socket on a volume both containers mount
// (docs/repository-agents.md#the-harness-container).
//
// Frames, one JSON object per line:
//   launcher -> host  {"claw":"launch","harness":"codex"}
//   host -> launcher  {"claw":"ready","cwd":…,"auth":…,"mode":…,"promptMeta":…}
//                     {"claw":"failed","message":…}
//   both ways         {"acp":"<one line of the agent's stdio>"}
//   launcher -> host  {"claw":"end"}    the turn is over: close the agent's input
//                     {"claw":"stop"}   stop the agent now
//   host -> launcher  {"claw":"exit","code":0}   the agent and its group are gone
//                     {"claw":"oversize"}  the agent wrote a line too long to relay
//   launcher -> host  {"claw":"finish","turn":{sessionId,aborted,error}}
//   host -> launcher  {"claw":"finished","refused":…,"changed":…,"reply":…}
//                     {"claw":"finished","failed":true,"message":…}
// An agent's output only ever travels inside an "acp" string, so nothing it
// prints can pass for one of the host's own frames.

import { spawn } from 'node:child_process';
import {
  chmod,
  cp,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';

import {
  ClawFailure,
  endGroup,
  readLines,
  stopGroup,
} from './claw-process.mjs';
import { openclawHarness } from './openclaw-harness.mjs';

const SECRET_ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const RESERVED_ENV =
  /^(LCARS_|RUNNER_MODE$|OPENCLAW_|CLAW_HARNESS_SOCKET$|NODE_OPTIONS$|PATH$|HOME$)/;
// How long an ACP harness gets to exit by itself once its turn has ended.
const ACP_EXIT_GRACE_MS = 2_000;
// How long what an exited harness had already written gets to be read
// before whatever still holds its output open is stopped.
const ACP_DRAIN_MS = 100;
// The longest line of the agent's output the host relays, and the longest
// frame it reads from the launcher. A report is at most a fifth of the
// first, so a longer line is never one the launcher could accept.
const MAX_ACP_LINE_BYTES = 20 * 1024 * 1024;
const MAX_FRAME_BYTES = 48 * 1024 * 1024;

// Reserve room for the host, ACP bridge and child processes to stop before
// the kernel's hard limit. At 2688 MiB this trips at 2176 MiB: the incident
// Gateway reached ~2160 MiB anonymous RSS and a separate child used ~297 MiB.
const MIB = 1024 ** 2;
const MEMORY_SAMPLE_MS = 100;

async function harnessMemoryCgroup() {
  const membership = await readFile('/proc/self/cgroup', 'utf8');
  const group = /^0::(\/[^\n]*)/m.exec(membership)?.[1];
  if (group === undefined) throw new Error('missing unified cgroup');
  const root = '/sys/fs/cgroup';
  // The mount may expose the full hierarchy or just this container.
  for (const path of new Set([join(root, group), root])) {
    const members = await readFile(join(path, 'cgroup.procs'), 'utf8').catch(
      () => '',
    );
    if (members.split('\n').includes(String(process.pid))) return path;
  }
  throw new Error('harness cgroup not visible');
}

async function watchHarnessMemory(cgroup, controller, signal) {
  const unavailable = () =>
    new ClawFailure(
      'OpenClaw harness memory guard requires readable cgroup v2 counters and a finite memory limit',
    );
  const read = (path, key) => readFile(join(path, key), 'utf8');
  const counter = (value) => {
    const parsed = Number(value?.trim());
    if (!/^\d+$/.test(value?.trim()) || !Number.isSafeInteger(parsed))
      throw unavailable();
    return parsed;
  };
  const oomKills = async (path) =>
    counter(/^oom_kill (\d+)$/m.exec(await read(path, 'memory.events'))?.[1]);
  let path;
  let limit;
  let initialKills;
  try {
    path = await cgroup();
    limit = counter(await read(path, 'memory.max'));
    if (limit === 0) throw unavailable();
    initialKills = await oomKills(path);
  } catch {
    throw unavailable();
  }
  const threshold = limit - Math.min(512 * MIB, Math.floor(limit / 5));
  let timer;
  const check = async () => {
    if (signal.aborted) return;
    try {
      const killed = await oomKills(path);
      if (killed > initialKills) {
        controller.abort(
          new ClawFailure(
            'OpenClaw harness cgroup recorded a kernel OOM kill (memory.events oom_kill increased)',
          ),
        );
        return;
      }
      const current = counter(await read(path, 'memory.current'));
      const inactiveFile = counter(
        /^inactive_file (\d+)$/m.exec(await read(path, 'memory.stat'))?.[1],
      );
      // The kernel can reclaim inactive file cache under pressure.
      const used = Math.max(0, current - inactiveFile);
      if (used >= threshold)
        controller.abort(
          new ClawFailure(
            `OpenClaw harness memory guard stopped the turn at ${Math.ceil(used / MIB)} MiB (threshold ${Math.floor(threshold / MIB)} MiB, limit ${Math.floor(limit / MIB)} MiB); reduce the Gateway or tool working set`,
          ),
        );
    } catch {
      controller.abort(unavailable());
    }
  };
  const sample = async () => {
    await check();
    if (!signal.aborted)
      timer = setTimeout(() => void sample(), MEMORY_SAMPLE_MS).unref();
  };
  signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
  await sample();
  return check;
}

// The harnesses this image carries (Dockerfile). Each entry prepares what
// its harness needs and returns the ACP agent to run on stdio: its command,
// an environment when it needs more than the zone's, the `auth` method to
// sign in with when the harness asks for one, the session `mode` to use when
// the manifest names none, what the prompt carries beyond ACP's own fields
// (`promptMeta`), and a `finish` that stops anything it started and names any
// reason to refuse the turn's result. A manifest names a harness; the command
// comes from the image, never from the definition, so reviewed source cannot
// choose the program that speaks for the agent.
const ACP_MODULES = '/opt/openclaw/node_modules/@agentclientprotocol';
const adapter = (path, more) => () => ({
  command: process.execPath,
  args: [path],
  ...more,
});
export const HARNESSES = Object.freeze({
  // OpenClaw's own ACP server, bridged to a Gateway this Job owns.
  openclaw: openclawHarness,
  claude: adapter(`${ACP_MODULES}/claude-agent-acp/dist/index.js`),
  // Codex opens a session with an API key from the environment only once
  // the client has chosen that sign-in; its other method is interactive.
  // Its own default mode, `agent`, lets Codex approve some escalations
  // itself, outside its sandbox and without asking the client. Unless the
  // manifest names a mode, the turn runs in `workspace-write`, where every
  // approval is asked of the launcher, which refuses it.
  codex: adapter(`${ACP_MODULES}/codex-acp/dist/index.js`, {
    auth: 'api-key',
    mode: 'workspace-write',
  }),
});

// Zone Secret items under <secrets>/env/<NAME> become environment variables
// for the harness (for example the agent's dedicated LiteLLM key). Other items
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
    const directory = await realpath(source);
    // A definition may hold a plain file of that name; only a directory is
    // staged.
    if (!(await stat(directory)).isDirectory()) return;
    await cp(directory, target, {
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

/** Serves one launcher on `stream`: one harness, one turn. Resolves once the
 * launcher has gone and everything the harness started has been stopped. */
export function serveHarness(
  stream,
  { harnesses = HARNESSES, env = process.env, memoryCgroup } = {},
) {
  const openclaw =
    env.OPENCLAW_BIN || '/opt/openclaw/node_modules/.bin/openclaw';
  const secretsDir = env.CLAW_SECRETS_DIR || '/run/claw-secrets';
  const workRoot = env.CLAW_WORK_DIR || '/work';
  // Aborted when the launcher goes away, whatever the harness is doing.
  const gone = new AbortController();
  // False when the launcher is behind and what was written is waiting.
  const write = (frame) =>
    stream.writable ? stream.write(`${JSON.stringify(frame)}\n`) : true;
  let child;
  let exited = Promise.resolve();
  let finish;
  let checkMemory;
  const memory = new AbortController();
  const runSignal = AbortSignal.any([gone.signal, memory.signal]);
  memory.signal.addEventListener(
    'abort',
    () => {
      if (child) stopGroup(child, 0);
    },
    { once: true },
  );

  const launch = async (name) => {
    if (typeof name !== 'string' || !Object.hasOwn(harnesses, name))
      throw new ClawFailure(`this image carries no ${name} harness`);
    if (name === 'openclaw' && memoryCgroup) {
      checkMemory = await watchHarnessMemory(memoryCgroup, memory, runSignal);
      memory.signal.throwIfAborted();
    }
    const definitionDir = join(workRoot, 'agent');
    // What the harness and the agent's tools run with: the zone's secret
    // environment and nothing of the launcher's.
    const agentEnv = {
      PATH: env.PATH || '/usr/local/bin:/usr/bin:/bin',
      HOME: env.HOME || '/work/home',
      LANG: 'C.UTF-8',
      ...(await secretEnvironment(secretsDir)),
    };
    await mkdir(agentEnv.HOME, { recursive: true });
    const workspace = await prepareWorkspace(definitionDir, workRoot);
    const harness = await harnesses[name]({
      definitionDir,
      workRoot,
      workspace,
      // For a harness whose own preparation may write into the workspace.
      stageWorkspace: () => prepareWorkspace(definitionDir, workRoot),
      openclaw,
      env: agentEnv,
      signal: runSignal,
    });
    // Stops whatever the harness started and names any reason it has to
    // refuse the turn's result. It runs exactly once, on every path.
    finish = harness.finish;
    memory.signal.throwIfAborted();
    if (gone.signal.aborted) throw new ClawFailure('claw run was cancelled');
    const started = spawn(harness.command, harness.args, {
      env: harness.env ?? agentEnv,
      cwd: workspace,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    await new Promise((ok, failed) => {
      started.once('spawn', ok);
      started.once('error', failed);
    });
    child = started;
    if (memory.signal.aborted) stopGroup(started, 0);
    // The agent's output waits while the launcher is behind, so what this
    // process holds of it stays bounded however fast the agent writes: the
    // bound on one line is no bound on all of them.
    const output = started.stdout;
    const relay = (frame) => {
      if (write(frame) || output.isPaused()) return;
      output.pause();
      const resume = () => {
        stream.off('drain', resume);
        stream.off('close', resume);
        output.resume();
      };
      stream.once('drain', resume);
      stream.once('close', resume);
    };
    readLines(output, (line) => relay({ acp: line }), {
      maxBytes: MAX_ACP_LINE_BYTES,
      onOversize: () => relay({ claw: 'oversize' }),
    });
    // stderr carries harness diagnostics; never forward it.
    child.stderr.resume();
    child.stdin.on('error', () => undefined);
    // The harness's own process can be gone while a child of its own holds
    // its output open, and `close` does not come until that child lets go.
    // What the harness had written is read first; then what is left of its
    // group is ended, and `close` follows.
    let drained;
    child.once('exit', () => {
      drained = setTimeout(
        () => void endGroup(started, ACP_EXIT_GRACE_MS),
        ACP_DRAIN_MS,
      );
    });
    exited = new Promise((done) => {
      child.on('close', (code) => {
        clearTimeout(drained);
        // The harness's own process is gone, but a child of its own can run
        // on in its group. Nothing of the harness may still run while the
        // launcher checks the settings it could change and settles the
        // attempt, so the group is ended before the launcher is told.
        void endGroup(started, ACP_EXIT_GRACE_MS).then(() => {
          write({ claw: 'exit', code });
          done();
        });
      });
    });
    return {
      cwd: workspace,
      ...(harness.auth === undefined ? {} : { auth: harness.auth }),
      ...(harness.mode === undefined ? {} : { mode: harness.mode }),
      ...(harness.promptMeta === undefined
        ? {}
        : { promptMeta: harness.promptMeta }),
    };
  };

  const finished = async (turn) => {
    await exited;
    const run = finish;
    finish = undefined;
    await checkMemory?.();
    const verdict = await run?.(memory.signal.aborted ? undefined : turn);
    await checkMemory?.();
    if (memory.signal.aborted) return { refused: memory.signal.reason.message };
    return typeof verdict === 'string' ? { refused: verdict } : (verdict ?? {});
  };

  const onFrame = async (frame) => {
    if (typeof frame.acp === 'string') {
      if (child?.stdin.writable) child.stdin.write(`${frame.acp}\n`);
      return;
    }
    if (frame.claw === 'launch') {
      try {
        write({ claw: 'ready', ...(await launch(frame.harness)) });
      } catch (cause) {
        await checkMemory?.();
        const error = memory.signal.reason ?? cause;
        if (!(error instanceof ClawFailure) && !gone.signal.aborted)
          console.error(error);
        write({
          claw: 'failed',
          ...(error instanceof ClawFailure ? { message: error.message } : {}),
        });
      }
    } else if (frame.claw === 'end') {
      // The turn is over: close the session's input, then stop whatever the
      // harness left running.
      child?.stdin.end();
      const ending = child;
      if (ending)
        setTimeout(() => stopGroup(ending), ACP_EXIT_GRACE_MS).unref();
    } else if (frame.claw === 'stop') {
      if (child) stopGroup(child);
    } else if (frame.claw === 'finish') {
      try {
        write({
          claw: 'finished',
          ...(await finished(
            frame.turn && typeof frame.turn === 'object'
              ? frame.turn
              : undefined,
          )),
        });
      } catch (error) {
        // The launcher reports this as it reports a failed launch.
        if (!(error instanceof ClawFailure) && !gone.signal.aborted)
          console.error(error);
        write({
          claw: 'finished',
          failed: true,
          ...(error instanceof ClawFailure ? { message: error.message } : {}),
        });
      }
    }
  };

  // Frames are handled in the order they arrive.
  let handling = Promise.resolve();
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
      handling = handling.then(() => onFrame(frame)).catch(() => undefined);
    },
    { maxBytes: MAX_FRAME_BYTES },
  );
  stream.on('error', () => undefined);
  return new Promise((served) => {
    const leave = () => {
      if (gone.signal.aborted) return;
      gone.abort();
      if (child) stopGroup(child);
      // Whatever the launcher asked for last is finished first; then the
      // harness's own cleanup runs if the launcher never asked for it.
      void handling
        .then(() => finished(undefined))
        .catch(() => undefined)
        .then(() => {
          stream.end();
          served();
        });
    };
    stream.once('end', leave);
    stream.once('close', leave);
  });
}

// The harness container: listen on the socket the executor names, serve the
// one launcher that connects, and stay until the pod ends. The launcher's
// container is the pod's only regular container, so its exit ends this one.
if (import.meta.url === `file://${process.argv[1]}`) {
  const path = process.env.CLAW_HARNESS_SOCKET;
  if (!path) {
    console.error('CLAW_HARNESS_SOCKET is required');
    process.exit(2);
  }
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'])
    process.once(signal, () => process.exit(0));
  await rm(path, { force: true });
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    // One launcher, one turn: nothing else may connect afterwards.
    server.close();
    void serveHarness(socket, { memoryCgroup: harnessMemoryCgroup }).then(() =>
      console.log('claw harness: launcher disconnected'),
    );
  });
  server.listen(path, () => {
    // The launcher runs as another user of the same group.
    void chmod(path, 0o660).then(() => console.log('claw harness: listening'));
  });
  // Stay after the turn: this container restarts if it exits.
  setInterval(() => undefined, 3_600_000);
}

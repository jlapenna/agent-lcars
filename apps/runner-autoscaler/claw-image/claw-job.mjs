#!/usr/bin/env node
// Claw runner: one embedded OpenClaw agent turn per LCARS run attempt.
//
// Contract: docs/superpowers/specs/2026-10-15-unified-work-dataflow-design.md
// ("### `claw`"). The QueueExecutor launches this image with RUNNER_MODE=claw,
// LCARS_RUN_ID, LCARS_CONSOLE_URL and LCARS_RUN_TOKEN, plus only the agent's
// own zone Secret items under CLAW_SECRETS_DIR. A repository-owned agent
// (docs/repository-agents.md) arrives in the brief: its files pinned by commit,
// each verified against its git blob SHA and the definition digest before it
// runs. Work input never selects the agent or its zone.
//
// Sequence (each step fails the attempt closed):
//   1. Acknowledged startup heartbeat, then the brief.
//   2. Fresh state: writable config copy, OPENCLAW_STATE_DIR/CONFIG_PATH.
//   3. `openclaw config validate --json` must report valid.
//   4. `openclaw doctor --fix --non-interactive` normalizes the copy for this
//      image. The turn keeps only accepted changes (doctorChanges, turnConfig);
//      any other change fails the attempt, naming the changed settings.
//   5. `openclaw approvals set --file` seeds the enforcing exec approvals.
//   6. `openclaw agent exec --json` under the outer turn deadline.
//   7. Settle: a report only when the envelope is ok, has a final message and
//      no unresolved tool error; everything else is runner-failed.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize } from 'node:path';

export const HEARTBEAT_INTERVAL_MS = 300_000;
// The Work API stores a report of any size whole, up to its completion bound
// (RUN_MESSAGE_MAX_BYTES, libs/dispatch-contracts/src/run-message.ts). A
// longer one is a failed attempt, never a truncated report.
export const MAX_REPORT_BYTES = 4 * 1024 * 1024;
// OpenClaw's JSON envelope carries the report plus metadata and escaping;
// keep room for a maximal report so it is measured, not misparsed.
const MAX_ENVELOPE_BYTES = 4 * MAX_REPORT_BYTES;
const SECRET_ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const RESERVED_ENV =
  /^(LCARS_|RUNNER_MODE$|OPENCLAW_|NODE_OPTIONS$|PATH$|HOME$)/;

export class ClawFailure extends Error {}

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

// Strip OpenClaw's own bookkeeping so the pinned config can be compared with
// what Doctor leaves behind.
export function comparableConfig(config) {
  const { meta: _meta, wizard: _wizard, ...rest } = config;
  return JSON.stringify(sortKeys(rest));
}

// An agent's config.json is a source config, not a per-image artifact: the
// launcher runs Doctor's normalization for the image it is actually in and
// the turn runs the result (turnConfig). Doctor's output depends on the
// image; the turn keeps only these changes:
//   - enable a plugin that, by the image's own plugin manifests
//     (`pluginProviders`), owns a model provider the config declares
//     (`plugins.entries.<plugin>.enabled: true`), unless the source set it;
//   - add an empty agent entry (`agents.entries.<name>: {}`), an agent with
//     no overrides of the config's defaults.
// Skill toggles (`skills.entries.<name>.enabled`) Doctor writes are discarded,
// not carried: Doctor judges readiness outside the turn's context (its
// working directory, workspace and exec defaults), and OpenClaw already
// filters ineligible skills at load time in the turn itself.
// Returns the dotted paths of every other change (OpenClaw's `meta`/`wizard`
// stamps aside); any such change fails the attempt.
export function doctorChanges(source, after, pluginProviders = new Map()) {
  // OpenClaw matches provider IDs case-insensitively (LITELLM enables the
  // litellm plugin).
  const providerId = (id) => id.trim().toLowerCase();
  const providers = new Set(
    Object.keys(source?.models?.providers ?? {}).map(providerId),
  );
  const ownsDeclaredProvider = (plugin) =>
    [...(pluginProviders.get(plugin) ?? [])].some((provider) =>
      providers.has(providerId(provider)),
    );
  const before = nodes(JSON.parse(comparableConfig(source)));
  const normalized = nodes(JSON.parse(comparableConfig(after)));
  const refused = [];
  for (const path of new Set([...before.keys(), ...normalized.keys()])) {
    const was = before.get(path);
    const now = normalized.get(path);
    if (was === now) continue;
    // An object that stays an object is judged by its children; a new
    // non-empty object (a container on an allowed path) likewise.
    if (isObjectNode(was) && isObjectNode(now)) continue;
    if (was === undefined && now === NON_EMPTY) continue;
    // A removed non-empty object is reported through its removed children.
    if (was === NON_EMPTY && now === undefined) continue;
    const [root, entries, name, field, ...rest] = path.split('\u0000');
    const entry =
      root !== undefined &&
      entries === 'entries' &&
      field === 'enabled' &&
      rest.length === 0;
    if (entry && root === 'skills') continue;
    if (
      entry &&
      root === 'plugins' &&
      now === 'true' &&
      was === undefined &&
      ownsDeclaredProvider(name)
    )
      continue;
    if (
      root === 'agents' &&
      entries === 'entries' &&
      field === undefined &&
      was === undefined &&
      now === EMPTY
    )
      continue;
    refused.push(path.split('\u0000').join('.'));
  }
  return refused.sort();
}

// The file `spawn` runs for `command`: a path as given, a bare name from PATH.
export async function resolveCommand(command, path = '') {
  if (command.includes('/')) return command;
  for (const dir of path.split(':')) {
    if (!dir) continue;
    const candidate = join(dir, command);
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    }
  }
  throw new ClawFailure(`OpenClaw executable not found on PATH: ${command}`);
}

// The config the turn runs: Doctor's normalized copy with the source's own
// skill settings, so no skill toggle Doctor wrote reaches the turn.
export function turnConfig(source, normalized) {
  const config = structuredClone(normalized);
  if (source.skills === undefined) delete config.skills;
  else config.skills = structuredClone(source.skills);
  return config;
}

// Every node by path (segments joined with NUL, which no key holds in
// practice): objects as EMPTY or NON_EMPTY markers, everything else (arrays
// included) as its JSON value.
const EMPTY = '\u0000{}';
const NON_EMPTY = '\u0000{...}';
const isObjectNode = (node) => node === EMPTY || node === NON_EMPTY;

function nodes(value, prefix = [], out = new Map()) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const keys = Object.keys(value);
    out.set(prefix.join('\u0000'), keys.length > 0 ? NON_EMPTY : EMPTY);
    for (const key of keys) nodes(value[key], [...prefix, key], out);
  } else {
    out.set(prefix.join('\u0000'), JSON.stringify(value));
  }
  return out;
}

// Which model providers each plugin bundled in this image owns, from its
// `openclaw.plugin.json` (`providers` and `autoEnableWhenConfiguredProviders`).
// The manifests ship in the image, so a repository cannot widen this map.
export async function bundledPluginProviders(
  openclaw,
  path = process.env.PATH,
) {
  const extensions = join(
    dirname(await realpath(await resolveCommand(openclaw, path))),
    'dist',
    'extensions',
  );
  const owners = new Map();
  let entries;
  try {
    entries = await readdir(extensions, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return owners;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    let manifest;
    try {
      manifest = JSON.parse(
        await readFile(
          join(extensions, entry.name, 'openclaw.plugin.json'),
          'utf8',
        ),
      );
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    const provides = [
      ...(manifest.providers ?? []),
      ...(manifest.autoEnableWhenConfiguredProviders ?? []),
    ].filter((provider) => typeof provider === 'string');
    owners.set(manifest.id ?? entry.name, new Set(provides));
  }
  return owners;
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
  return {
    agent: claw.agent,
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

// Decide the attempt outcome from the `agent exec --json` envelope. Exit 0 and
// ok:true are returned even when every tool call was denied, so tool failures
// are read from toolSummary rather than the exit code.
// An agent whose manifest sets `requireToolEvidence` must rest its answer on
// tool evidence: a report with no tool call is an unsupported answer. A tool
// call that failed and was then resolved (for example a probe of a host that
// is down) is evidence, not a runner failure; an unresolved tool error still
// fails the attempt.

export function settle(
  { code, timedOut, aborted, stdout },
  { requireTools = false } = {},
) {
  if (aborted)
    return { outcome: 'runner-failed', message: 'Claw turn was cancelled.' };
  if (timedOut)
    return {
      outcome: 'runner-failed',
      message: 'Claw turn exceeded its deadline.',
    };
  let envelope;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    return {
      outcome: 'runner-failed',
      message: `OpenClaw exited ${code} without a JSON result.`,
    };
  }
  const final = typeof envelope.final === 'string' ? envelope.final.trim() : '';
  const unresolved = envelope.toolSummary?.unresolvedError;
  const calls = Number(envelope.toolSummary?.calls ?? 0);
  if (
    envelope.ok === true &&
    final &&
    !unresolved &&
    requireTools &&
    !(calls > 0)
  )
    return {
      outcome: 'runner-failed',
      message: 'Claw turn answered without using any tool.',
    };
  if (
    envelope.ok === true &&
    final &&
    !unresolved &&
    (code === 0 || code === 1)
  ) {
    const cleanup =
      code === 1
        ? '\n\n(OpenClaw reported a cleanup failure after this result.)'
        : '';
    const report = final + cleanup;
    const bytes = Buffer.byteLength(report, 'utf8');
    if (bytes > MAX_REPORT_BYTES)
      return {
        outcome: 'runner-failed',
        message: `Claw report is ${bytes} bytes; the completion bound is ${MAX_REPORT_BYTES}.`,
      };
    return { outcome: 'report', message: report };
  }
  if (code === 2)
    return {
      outcome: 'runner-failed',
      message: 'OpenClaw model attempt timed out.',
    };
  const reason = unresolved
    ? `unresolved ${unresolved.toolName ?? 'tool'} error`
    : envelope.error?.message
      ? String(envelope.error.message).slice(0, 500)
      : final
        ? `OpenClaw exited ${code}`
        : 'empty result';
  return { outcome: 'runner-failed', message: `Claw turn failed: ${reason}.` };
}

// Runs one OpenClaw command in its own process group, so a deadline or a
// cancellation (SIGTERM to the launcher) stops the whole tree, including any
// tool processes the agent started.
export function run(
  command,
  args,
  { env, cwd, timeoutMs, input, signal } = {},
) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ClawFailure('claw run was cancelled'));
      return;
    }
    const child = spawn(command, args, {
      env,
      cwd,
      detached: true,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderrBytes = 0;
    let timedOut = false;
    let aborted = false;
    const killTree = (killSignal) => {
      try {
        process.kill(-child.pid, killSignal);
      } catch {
        // The group already exited.
      }
    };
    const stop = () => {
      killTree('SIGTERM');
      setTimeout(() => killTree('SIGKILL'), 10_000).unref();
    };
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
    child.stdout.on('data', (chunk) => {
      if (stdout.length < MAX_ENVELOPE_BYTES) stdout += chunk;
    });
    // stderr carries OpenClaw diagnostics; count it but never forward it,
    // since it can echo resolved configuration.
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ code, timedOut, aborted, stdout, stderrBytes });
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

async function ownerWritable(path) {
  const info = await stat(path);
  await chmod(path, info.mode | 0o200);
  if (info.isDirectory())
    for (const entry of await readdir(path))
      await ownerWritable(join(path, entry));
}

export async function prepareState({
  agentDir,
  workRoot,
  openclaw,
  env,
  signal,
}) {
  const stateDir = await mkdtemp(join(workRoot, 'state-'));
  const workspace = join(workRoot, 'workspace');
  const source = JSON.parse(
    await readFile(join(agentDir, 'config.json'), 'utf8'),
  );
  const configPath = join(stateDir, 'agent-config.json');
  await writeFile(configPath, `${JSON.stringify(source, null, 2)}\n`, {
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
  // The agent runs Doctor's normalized copy; the verified source stays
  // untouched under the locked agent directory.
  const normalized = JSON.parse(await readFile(configPath, 'utf8'));
  const refused = doctorChanges(
    source,
    normalized,
    await bundledPluginProviders(openclaw, childEnv.PATH),
  );
  if (refused.length > 0)
    throw new ClawFailure(
      `openclaw doctor would change this agent's config.json on this image beyond narrowing it: ${refused.join(', ')}`,
    );
  await writeFile(
    configPath,
    `${JSON.stringify(turnConfig(source, normalized), null, 2)}\n`,
    { mode: 0o600 },
  );

  // Stage the turn's workspace only after Doctor, so its file repairs (for a
  // source that names this directory as its workspace) never reach the turn.
  await rm(workspace, { recursive: true, force: true });
  await mkdir(workspace, { recursive: true });
  try {
    // A ConfigMap mount presents workspace/ as a symlink into its
    // timestamped data directory; copy the resolved files, not the link.
    await cp(await realpath(join(agentDir, 'workspace')), workspace, {
      recursive: true,
      dereference: true,
    });
    // The pinned definition stays locked; its execution copy is the agent's
    // writable workspace, so give the owner write access back.
    await ownerWritable(workspace);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const approvals = await run(
    openclaw,
    ['approvals', 'set', '--file', join(agentDir, 'approvals.json')],
    { env: childEnv, timeoutMs: 120_000, signal },
  );
  if (approvals.code !== 0 || approvals.timedOut)
    throw new ClawFailure(`openclaw approvals set exited ${approvals.code}`);

  return { stateDir, workspace, configPath, childEnv };
}

function positiveInteger(env, name, fallback) {
  if (env[name] === undefined || env[name] === '') return fallback;
  const value = Number(env[name]);
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new ClawFailure(`${name} must be a positive integer`);
  return value;
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
      const { stateDir, workspace, configPath, childEnv } = await prepareState({
        agentDir: definitionDir,
        workRoot,
        openclaw,
        env: baseEnv,
        signal: work,
      });
      if (work.aborted) throw new ClawFailure('claw run was cancelled');
      const messageFile = join(stateDir, 'brief.md');
      await writeFile(messageFile, request.message, {
        mode: 0o600,
      });
      const turn = run(
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
          workspace,
          '--json',
        ],
        {
          env: childEnv,
          cwd: workspace,
          signal: work,
        },
      );
      await call('heartbeat', { providerProcessStarted: true }).catch(
        ignoreHeartbeatFailure,
      );
      const finished = await turn;
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

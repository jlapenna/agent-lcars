// OpenClaw as a claw harness, through its own ACP server.
//
// `openclaw acp` speaks ACP on stdio and forwards each prompt to a Gateway,
// so the launcher prepares OpenClaw's state, starts a Gateway on loopback
// inside the Job and then runs `openclaw acp` as the agent, exactly as it
// runs any other harness. Nothing here speaks ACP.
//
// Start sequence (each step fails the attempt closed):
//   1. Fresh state: writable config copy, OPENCLAW_STATE_DIR/CONFIG_PATH.
//   2. `openclaw config validate --json` must report valid: OpenClaw
//      silently ignores unknown keys.
//   3. `openclaw doctor --fix --non-interactive` normalizes the copy for this
//      image. The turn keeps only accepted changes (doctorChanges, turnConfig);
//      any other change fails the attempt, naming the changed settings.
//   4. `openclaw approvals set --file` seeds the enforcing exec approvals.
//   5. The launch config: the turn's config plus this Job's workspace and a
//      loopback, token-protected Gateway, with the credentials it names
//      written in so they stay out of what host commands inherit.
//   6. `openclaw gateway run`, waited on until it reports ready.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import {
  access,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';

import { ClawFailure, stopGroup } from './claw-process.mjs';

// Enough for `config validate --json`; no other command's output is read.
const MAX_OUTPUT_CHARS = 1024 * 1024;
const GATEWAY_READY_MS = 300_000;
const GATEWAY_STOP_MS = 5_000;
// The Gateway's own line once it accepts work, after its log prefix. Earlier
// lines such as "spawn broker ready pid=…" must not match.
const GATEWAY_READY = /\[gateway\] ready$/u;
// The Gateway's own record of how a turn ended. OpenClaw's ACP server ends a
// failed turn like any other (`end_turn`), even after part of an answer has
// streamed, so this log is the only place the failure shows. Only the
// message's final outcome counts: a model attempt that failed before a
// fallback answered is logged too (`lane task error`) and is not a failure.
const TURN_FAILED =
  /\[diagnostic\] message (processed|dispatch completed):.*\boutcome=error\b/u;
const stripAnsi = (text) =>
  // eslint-disable-next-line no-control-regex -- terminal colour codes
  text.replace(/\u001b\[[0-9;]*m/gu, '');

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
      // As execvp does: the first regular, executable file on PATH.
      if ((await stat(candidate)).isFile()) {
        await access(candidate, constants.X_OK);
        return candidate;
      }
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code)) throw error;
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
// The `openclaw.plugin.json` of every plugin bundled in this image. The
// manifests ship in the image, so a repository cannot change what they say.
async function bundledManifests(openclaw, path = process.env.PATH) {
  const extensions = join(
    dirname(await realpath(await resolveCommand(openclaw, path))),
    'dist',
    'extensions',
  );
  let entries;
  try {
    entries = await readdir(extensions, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const manifests = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const manifest = JSON.parse(
        await readFile(
          join(extensions, entry.name, 'openclaw.plugin.json'),
          'utf8',
        ),
      );
      manifests.push({ ...manifest, id: manifest.id ?? entry.name });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return manifests;
}

export async function bundledPluginProviders(openclaw, path) {
  const owners = new Map();
  for (const manifest of await bundledManifests(openclaw, path)) {
    const provides = [
      ...(manifest.providers ?? []),
      ...(manifest.autoEnableWhenConfiguredProviders ?? []),
    ].filter((provider) => typeof provider === 'string');
    owners.set(manifest.id, new Set(provides));
  }
  return owners;
}

// The environment variables OpenClaw treats as provider credentials, each
// with the providers that read it, from the bundled plugins' own manifests
// (`setup.providers[].envVars`, `providerUsageAuthEnvVars`). These are the
// names `agent exec` kept out of what a host command inherits.
export async function bundledProviderAuthEnv(openclaw, path) {
  const names = new Map();
  const add = (name, provider) => {
    if (typeof name !== 'string' || typeof provider !== 'string') return;
    if (!names.has(name)) names.set(name, new Set());
    names.get(name).add(provider.trim().toLowerCase());
  };
  for (const manifest of await bundledManifests(openclaw, path)) {
    for (const provider of manifest.setup?.providers ?? [])
      for (const name of provider?.envVars ?? []) add(name, provider.id);
    for (const [provider, vars] of Object.entries(
      manifest.providerUsageAuthEnvVars ?? {},
    ))
      for (const name of Array.isArray(vars) ? vars : []) add(name, provider);
  }
  return names;
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

// Runs one OpenClaw command to completion in its own process group, so a
// timeout or a cancellation stops the whole tree.
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
    const stop = () => stopGroup(child, GATEWAY_STOP_MS);
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            stop();
          }, timeoutMs)
        : undefined;
    signal?.addEventListener('abort', stop, { once: true });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (stdout.length < MAX_OUTPUT_CHARS) stdout += chunk;
    });
    // stderr carries OpenClaw diagnostics; never forward it, since it can
    // echo resolved configuration.
    child.stderr.resume();
    child.on('error', (error) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      if (signal?.aborted) reject(new ClawFailure('claw run was cancelled'));
      else resolve({ code, timedOut, stdout });
    });
  });
}

// A port nothing listens on. The Job's network namespace is its own, so the
// gap between choosing it and the Gateway binding it is not contended.
function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// OpenClaw hands a host command the Gateway's environment. `agent exec` kept
// provider credentials out of what a command inherits; a Gateway has no such
// scope. So the credentials are resolved here, into the launch config, and
// their variables are left out of the Gateway's environment: the model still
// authenticates and an approved command does not inherit the key.
//
// A variable is treated as a credential when the config names it as an `env`
// SecretRef, or when the image's plugins say a provider reads it
// (`providerAuthEnv`). For each one the environment holds:
// - every `env` SecretRef to it and every `${NAME}` in a config string is
//   replaced by its value, as OpenClaw would resolve them;
// - a provider credential the config never mentions is the key OpenClaw
//   would have picked up by itself, so it becomes the `apiKey` of a declared
//   provider that reads it and has none. With no such provider it is simply
//   withheld, as it was from host commands before.
// Returns the config and the names withheld from the Gateway.
export function resolveCredentials(config, env, providerAuthEnv = new Map()) {
  const held = (name) => typeof env[name] === 'string' && !KEPT_ENV.has(name);
  const isReference = (value) =>
    value.source === 'env' &&
    typeof value.id === 'string' &&
    Object.keys(value).every((key) => SECRET_REF_KEYS.has(key));
  const withheld = new Set(
    [...providerAuthEnv.keys()].filter((name) => held(name)),
  );
  const collect = (value) => {
    if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === 'object') {
      if (isReference(value)) {
        if (held(value.id)) withheld.add(value.id);
      } else Object.values(value).forEach(collect);
    }
  };
  collect(config);
  const mentioned = new Set();
  const resolve = (value) => {
    if (typeof value === 'string')
      return value.replace(ENV_TEMPLATE, (text, name) => {
        if (!withheld.has(name)) return text;
        mentioned.add(name);
        return env[name];
      });
    if (Array.isArray(value)) return value.map(resolve);
    if (!value || typeof value !== 'object') return value;
    if (isReference(value) && withheld.has(value.id)) {
      mentioned.add(value.id);
      return env[value.id];
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, resolve(child)]),
    );
  };
  const resolved = resolve(config);
  const providers = resolved.models?.providers;
  for (const name of withheld) {
    if (mentioned.has(name) || !providers) continue;
    const readers = providerAuthEnv.get(name) ?? new Set();
    for (const [id, provider] of Object.entries(providers))
      if (
        readers.has(id.trim().toLowerCase()) &&
        provider &&
        typeof provider === 'object' &&
        provider.apiKey === undefined
      )
        providers[id] = { ...provider, apiKey: env[name] };
  }
  return { config: resolved, used: withheld };
}
const SECRET_REF_KEYS = new Set(['source', 'provider', 'id']);
const KEPT_ENV = new Set(['PATH', 'HOME', 'LANG']);
// `${NAME}` as OpenClaw substitutes it in config strings; `$${NAME}` is its
// escape for the literal text.
const ENV_TEMPLATE = /(?<!\$)\$\{([A-Z_][A-Z0-9_]*)\}/gu;

// `over` wins over `under`; plain objects merge key by key.
function mergeDeep(under, over) {
  const plain = (value) =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!plain(under) || !plain(over)) return over;
  const merged = { ...under };
  for (const [key, value] of Object.entries(over))
    merged[key] = key in under ? mergeDeep(under[key], value) : value;
  return merged;
}

// What `openclaw agent exec` laid under a config for a headless turn
// (OpenClaw's buildExecConfigDefaults). A Gateway turn applies none of it by
// itself: without these, file tools are not confined to the workspace and an
// unset tool profile means every tool. The source's own settings still win.
const TURN_DEFAULTS = Object.freeze({
  env: { shellEnv: { enabled: false } },
  agents: { defaults: { sandbox: { mode: 'off' } } },
  tools: {
    profile: 'coding',
    fs: { workspaceOnly: true },
    exec: { mode: 'full' },
  },
});

// What OpenClaw actually runs: the turn's config between the headless
// defaults under it and what only this Job knows over it, as `agent exec`
// composed its run config (buildExecRunConfig, pinExecAgentLocations).
// - Every agent works in the Job's workspace: a path the source names means
//   nothing here, and a Gateway turn takes the workspace from the config.
//   Agent state stays under the Job's state directory.
// - The Gateway block is this Job's alone, so a definition cannot open the
//   Gateway, drop its token or expose it.
// - Console logging and diagnostics keep the form startGateway reads.
export function launchConfig(config, { workspace, port, token }) {
  const { session, gateway: _gateway, ...root } = config;
  const { store: _store, ...sessionWithoutStore } = session ?? {};
  const pinned = session ? { ...root, session: sessionWithoutStore } : root;
  if (pinned.agents?.entries)
    pinned.agents = {
      ...pinned.agents,
      entries: Object.fromEntries(
        Object.entries(pinned.agents.entries).map(([name, entry]) => {
          const { agentDir: _agentDir, runtime, ...rest } = entry ?? {};
          const { cwd: _cwd, ...acp } = runtime?.acp ?? {};
          return [
            name,
            {
              ...rest,
              workspace,
              ...(runtime
                ? { runtime: runtime.acp ? { ...runtime, acp } : runtime }
                : {}),
            },
          ];
        }),
      ),
    };
  return mergeDeep(mergeDeep(TURN_DEFAULTS, pinned), {
    agents: { defaults: { workspace, skipBootstrap: true } },
    skills: { load: { watch: false } },
    logging: { consoleLevel: 'info', consoleStyle: 'pretty' },
    // The Gateway's diagnostic log is the only record that a turn failed
    // (TURN_FAILED), so a definition cannot switch it off.
    diagnostics: { enabled: true },
    // Nobody is authorized to give the Gateway commands or directives, so a
    // `/word` inside a message stays text for the agent, as it was under
    // `agent exec`. (A message that begins with one is handled by the
    // launcher: promptText.)
    commands: { allowFrom: { '*': [] } },
    gateway: {
      mode: 'local',
      bind: 'loopback',
      port,
      auth: { mode: 'token', token, allowTailscale: false },
      tailscale: { mode: 'off' },
      // A config edited during the turn is never applied to the running
      // Gateway.
      reload: { mode: 'off' },
    },
  });
}

export async function prepareState({
  agentDir,
  workRoot,
  workspace,
  stageWorkspace,
  openclaw,
  env,
  signal,
}) {
  const stateDir = await mkdtemp(join(workRoot, 'state-'));
  const source = JSON.parse(
    await readFile(join(agentDir, 'config.json'), 'utf8'),
  );
  const configPath = join(stateDir, 'agent-config.json');
  const write = (config) =>
    writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, {
      mode: 0o600,
    });
  await write(source);
  const childEnv = {
    ...env,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_NO_AUTO_UPDATE: '1',
    OPENCLAW_HIDE_BANNER: '1',
    OPENCLAW_SUPPRESS_NOTES: '1',
    // The Gateway serves this one turn. Nothing else it would start for a
    // long-lived deployment runs: no channel can reach the agent, nothing is
    // scheduled, and the model is not contacted before the turn.
    OPENCLAW_SKIP_CHANNELS: '1',
    OPENCLAW_SKIP_CRON: '1',
    OPENCLAW_SKIP_GMAIL_WATCHER: '1',
    OPENCLAW_SKIP_CANVAS_HOST: '1',
    OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: '1',
    OPENCLAW_SKIP_STARTUP_MODEL_PREWARM: '1',
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
  // Stage the turn's workspace again after Doctor, so its file repairs (for
  // a source that names this directory as its workspace) never reach the
  // turn.
  await stageWorkspace();

  const approvals = await run(
    openclaw,
    ['approvals', 'set', '--file', join(agentDir, 'approvals.json')],
    { env: childEnv, timeoutMs: 120_000, signal },
  );
  if (approvals.code !== 0 || approvals.timedOut)
    throw new ClawFailure(`openclaw approvals set exited ${approvals.code}`);

  const gateway = {
    port: await freePort(),
    token: randomBytes(32).toString('hex'),
  };
  const { config: resolved, used } = resolveCredentials(
    turnConfig(source, normalized),
    env,
    await bundledProviderAuthEnv(openclaw, childEnv.PATH),
  );
  const launched = launchConfig(resolved, { workspace, ...gateway });
  await write(launched);
  // What the Gateway and its ACP server run with: none of the credentials
  // now held by the launch config.
  const turnEnv = Object.fromEntries(
    Object.entries(childEnv).filter(([name]) => !used.has(name)),
  );
  const tokenFile = join(stateDir, 'gateway.token');
  await writeFile(tokenFile, `${gateway.token}\n`, { mode: 0o600 });
  // The Gateway's config and token belong to the same UID as the agent's
  // tools. Nothing here can stop a tool from rewriting them, so the turn's
  // result is refused when either is no longer what was launched. Exec
  // approvals live in OpenClaw's state database and are not covered.
  const verify = async () => {
    const text = (file) => readFile(file, 'utf8').catch(() => '');
    let config;
    try {
      config = comparableConfig(JSON.parse(await text(configPath)));
    } catch {
      config = undefined;
    }
    const changed =
      config !== comparableConfig(launched)
        ? 'OpenClaw config'
        : (await text(tokenFile)) !== `${gateway.token}\n`
          ? 'OpenClaw Gateway token'
          : undefined;
    return changed && `the agent changed its harness settings (${changed})`;
  };
  return { turnEnv, port: gateway.port, tokenFile, verify };
}

// Starts the Gateway in its own process group and resolves, once it reports
// ready, with the function that stops it and whether it has since recorded a
// failed turn.
export function startGateway(openclaw, { env, signal }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ClawFailure('claw run was cancelled'));
      return;
    }
    const child = spawn(openclaw, ['gateway', 'run'], {
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const closed = new Promise((done) => child.once('close', done));
    // SIGTERM, then SIGKILL for the whole group once the grace is over or
    // the Gateway itself has gone: whatever it left behind goes with it.
    const stop = async () => {
      stopGroup(child, GATEWAY_STOP_MS);
      await Promise.race([
        closed,
        new Promise((done) => setTimeout(done, GATEWAY_STOP_MS).unref()),
      ]);
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // The group already exited.
      }
    };
    let settled = false;
    let turnFailed = false;
    const settle = () => {
      if (settled) return false;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      return true;
    };
    // The Gateway is stopped, group and all, before a failure is reported.
    const fail = (error) => {
      if (settle()) void stop().then(() => reject(error));
    };
    const timer = setTimeout(
      () => fail(new ClawFailure('OpenClaw Gateway was not ready in time')),
      GATEWAY_READY_MS,
    );
    timer.unref();
    const onAbort = () => fail(new ClawFailure('claw run was cancelled'));
    signal?.addEventListener('abort', onAbort, { once: true });
    const onLine = (text) => {
      const line = stripAnsi(text).trimEnd();
      if (!settled) {
        if (GATEWAY_READY.test(line) && settle())
          resolve({ stop, turnFailed: () => turnFailed });
      } else if (TURN_FAILED.test(line)) turnFailed = true;
    };
    // Both streams are read to the end: a full pipe would block the Gateway,
    // and it reports a failed turn on either. Its logs can echo resolved
    // configuration, so nothing is forwarded.
    for (const stream of [child.stdout, child.stderr]) {
      let tail = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        const lines = (tail + chunk).split('\n');
        tail = lines.pop().slice(-4096);
        for (const line of lines) onLine(line);
      });
    }
    child.once('error', (error) => {
      if (settle()) reject(error);
    });
    child.once('close', (code) =>
      fail(
        new ClawFailure(`OpenClaw Gateway exited ${code} before it was ready`),
      ),
    );
  });
}

/** The `openclaw` harness: OpenClaw's ACP server, bridged to a Gateway this
 * Job owns. */
export async function openclawHarness({
  definitionDir,
  workRoot,
  workspace,
  stageWorkspace,
  openclaw,
  env,
  signal,
}) {
  const { turnEnv, port, tokenFile, verify } = await prepareState({
    agentDir: definitionDir,
    workRoot,
    workspace,
    stageWorkspace,
    openclaw,
    env,
    signal,
  });
  const gateway = await startGateway(openclaw, { env: turnEnv, signal });
  return {
    command: openclaw,
    args: [
      'acp',
      '--url',
      `ws://127.0.0.1:${port}`,
      '--token-file',
      tokenFile,
      // The agent's working directory is its configured workspace; the
      // prompt carries exactly what the launcher sends.
      '--no-prefix-cwd',
    ],
    env: turnEnv,
    // Stopping the Gateway first reads its log to the end, so a failure it
    // recorded for the turn is seen before the result is judged.
    finish: async () => {
      await gateway.stop();
      return gateway.turnFailed()
        ? 'OpenClaw reported the turn as failed'
        : verify();
    },
  };
}

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
import { pathToFileURL } from 'node:url';

import { ClawFailure, readSettingsFile, stopGroup } from './claw-process.mjs';

// Room for OpenClaw to have rewritten its config with its own additions.
const SETTINGS_SLACK_BYTES = 64 * 1024;

// Enough for `config validate --json`; no other command's output is read.
const MAX_OUTPUT_CHARS = 1024 * 1024;
const GATEWAY_READY_MS = 300_000;
const GATEWAY_STOP_MS = 5_000;
const GATEWAY_PROBE_MS = 250;
// What `agent exec` gave a turn, which the ACP server takes per prompt. Left
// out, the turn runs under the definition's `agents.defaults.timeoutSeconds`
// or the Gateway's own default instead.
const TURN_TIMEOUT_MS = 600_000;
// Asking the Gateway how the turn ended: one CLI call, repeated while the
// run is still being recorded.
const OUTCOME_CALL_MS = 60_000;
const OUTCOME_ATTEMPTS = 5;
const OUTCOME_RETRY_MS = 1_000;

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

// What OpenClaw itself treats as provider credentials, asked of the pinned
// distribution through its public plugin SDK: the variable names `agent exec`
// kept out of what a host command inherits (its built-in providers and every
// bundled plugin's), and for each provider the variables it reads, in order.
// A separate process answers, so none of OpenClaw loads into the launcher.
const PROVIDER_ENV_SDK = join('dist', 'plugin-sdk', 'provider-env-vars.js');
const PROVIDER_ENV_QUERY = `
import(process.argv[1]).then((sdk) => {
  const env = process.env;
  process.stdout.write(JSON.stringify({
    names: sdk.listKnownProviderAuthEnvVarNames({ env }),
    candidates: sdk.resolveProviderAuthEnvVarCandidates({ env }),
  }));
});`;
export async function providerAuthEnv(openclaw, { env, signal } = {}) {
  const none = { names: new Set(), candidates: new Map() };
  const sdk = join(
    dirname(await realpath(await resolveCommand(openclaw, env?.PATH))),
    PROVIDER_ENV_SDK,
  );
  try {
    await access(sdk, constants.R_OK);
  } catch (error) {
    if (error.code === 'ENOENT') return none;
    throw error;
  }
  const query = await run(
    process.execPath,
    ['-e', PROVIDER_ENV_QUERY, pathToFileURL(sdk).href],
    { env, timeoutMs: 120_000, signal },
  );
  let answer;
  try {
    answer = JSON.parse(query.stdout);
  } catch {
    answer = undefined;
  }
  if (
    query.code !== 0 ||
    !Array.isArray(answer?.names) ||
    !answer.candidates ||
    typeof answer.candidates !== 'object'
  )
    throw new ClawFailure('OpenClaw did not list its provider credentials');
  const strings = (values) =>
    (Array.isArray(values) ? values : []).filter(
      (value) => typeof value === 'string',
    );
  return {
    names: new Set(strings(answer.names)),
    candidates: new Map(
      Object.entries(answer.candidates).map(([provider, vars]) => [
        provider.trim().toLowerCase(),
        strings(vars),
      ]),
    ),
  };
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
// A variable the environment holds is a credential when:
// - OpenClaw says a provider reads it (`auth.names`, the set `agent exec`
//   filtered);
// - the config names it as an `env` SecretRef anywhere; or
// - a provider's `apiKey` or `headers` names it in a `${NAME}` or
//   `${NAME:-default}` template.
// Every SecretRef and template for a credential is replaced by its value, as
// OpenClaw would resolve them. Then each declared provider with no `apiKey`
// gets the first of its own variables the environment holds, which is the
// key OpenClaw would have found there by itself; whether that variable is
// also used elsewhere in the config makes no difference.
// Returns the config and the names withheld from the Gateway.
export function resolveCredentials(
  config,
  processEnv,
  auth = { names: new Set(), candidates: new Map() },
) {
  // As OpenClaw reads an environment: an empty variable is a missing one.
  const holds = (source, name) =>
    typeof source[name] === 'string' && source[name].trim() !== '';
  const kept = (name) => KEPT_ENV.has(name);
  // The config can define variables itself (`env.vars`, or strings directly
  // under `env`). OpenClaw adds each to its process environment where the
  // variable is missing, after the launcher has filtered that environment,
  // so they are part of the environment here: `env` is the process's
  // variables plus the config's.
  const defined = configEnvironment(config.env);
  const env = { ...processEnv };
  for (const [name, raw] of defined)
    if (!holds(processEnv, name)) env[name] = expandTemplates(raw, processEnv);
  const set = (name) => holds(env, name);
  const isReference = (value) =>
    value.source === 'env' &&
    typeof value.id === 'string' &&
    Object.keys(value).every((key) => SECRET_REF_KEYS.has(key));
  // OpenClaw resolves an `env` SecretRef through the provider it names, or
  // the default one. A provider the config declares may limit the names it
  // serves (`allowlist`), or not be an `env` provider at all. A reference
  // OpenClaw would refuse is left for OpenClaw to refuse; its variable is
  // withheld all the same.
  const secrets = config.secrets ?? {};
  const allowed = (reference) => {
    const alias = reference.provider ?? secrets.defaults?.env ?? 'default';
    const provider = secrets.providers?.[alias];
    if (provider === undefined) return alias === 'default';
    if (provider?.source !== 'env') return false;
    return (
      provider.allowlist === undefined ||
      (Array.isArray(provider.allowlist) &&
        provider.allowlist.includes(reference.id))
    );
  };
  // Withheld whether or not it holds anything: an empty credential variable
  // is not a command's to see either.
  const withheld = new Set(
    [...auth.names].filter(
      (name) => typeof env[name] === 'string' && !kept(name),
    ),
  );
  const credential = (name) => {
    if (set(name) && !kept(name)) withheld.add(name);
  };
  const { env: environment, ...settings } = config;
  const collectReferences = (value) => {
    if (Array.isArray(value)) value.forEach(collectReferences);
    else if (value && typeof value === 'object') {
      // Withheld even when OpenClaw would refuse the reference: only what is
      // written into the launch config depends on `allowed`.
      if (isReference(value)) credential(value.id);
      else Object.values(value).forEach(collectReferences);
    }
  };
  collectReferences(settings);
  const collectTemplates = (value) => {
    if (typeof value === 'string')
      for (const token of envTemplateTokens(value))
        if (!token.escaped) credential(token.name);
    if (value && typeof value === 'object')
      Object.values(value).forEach(collectTemplates);
  };
  for (const provider of Object.values(config.models?.providers ?? {})) {
    collectTemplates(provider?.apiKey);
    collectTemplates(provider?.headers);
  }
  // A variable the config defines from a credential is one too, under its
  // own name.
  for (let grew = true; grew;) {
    grew = false;
    for (const [name, raw] of defined) {
      if (withheld.has(name) || kept(name)) continue;
      const carries = [...envTemplateTokens(raw)].some(
        (token) => !token.escaped && withheld.has(token.name),
      );
      if (carries) grew = Boolean(withheld.add(name));
    }
  }
  // A withheld variable that is set is written in. One that is empty is
  // left for OpenClaw, which then takes the template's default or reports
  // the variable missing, exactly as it would have with the variable there.
  const resolves = (name) => withheld.has(name) && set(name);
  const resolve = (value) => {
    if (typeof value === 'string') return withCredentials(value, env, resolves);
    if (Array.isArray(value)) return value.map(resolve);
    if (!value || typeof value !== 'object') return value;
    if (isReference(value) && allowed(value) && resolves(value.id))
      return literal(env[value.id]);
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, resolve(child)]),
    );
  };
  const resolved = resolve(settings);
  // The config's own `env` is not resolved: whatever it holds, OpenClaw puts
  // in its process environment. It keeps every variable that is not a
  // credential, as written, and loses every one that is.
  if (environment !== undefined)
    resolved.env = withoutVariables(environment, withheld);
  const providers = resolved.models?.providers;
  for (const [id, provider] of Object.entries(providers ?? {})) {
    if (!provider || typeof provider !== 'object') continue;
    const key = provider.apiKey;
    const written = typeof key === 'string' ? key.trim() : undefined;
    if (key === undefined || written === '') {
      // No key, or a blank one, which is no key to OpenClaw: the first of
      // the provider's variables that holds something, as OpenClaw chooses
      // among them.
      const own = (auth.candidates.get(id.trim().toLowerCase()) ?? []).find(
        (name) => set(name) && !kept(name),
      );
      if (own !== undefined)
        providers[id] = { ...provider, apiKey: literal(env[own]) };
    } else if (written !== undefined && resolves(written)) {
      // A key that is only the name of a credential variable is OpenClaw's
      // marker for that variable's value.
      providers[id] = { ...provider, apiKey: literal(env[written]) };
    }
  }
  return { config: resolved, used: withheld };
}

// The variables a config's `env` defines, in both layouts OpenClaw accepts:
// `env.vars.<NAME>` and a string directly under `env`.
const ENV_SETTINGS = new Set(['vars', 'shellEnv']);
function configEnvironment(environment) {
  const defined = new Map();
  if (!environment || typeof environment !== 'object') return defined;
  const vars = environment.vars;
  if (vars && typeof vars === 'object')
    for (const [name, value] of Object.entries(vars))
      if (typeof value === 'string') defined.set(name, value);
  // Where both layouts name a variable, OpenClaw takes this one.
  for (const [name, value] of Object.entries(environment))
    if (!ENV_SETTINGS.has(name) && typeof value === 'string')
      defined.set(name, value);
  return defined;
}

const GATEWAY_VARIABLES = {
  has: (name) => name.startsWith('OPENCLAW_GATEWAY_'),
};

// A config's `env` without the named variables, in either layout.
function withoutVariables(environment, names) {
  if (!environment || typeof environment !== 'object') return environment;
  const kept = {};
  for (const [name, value] of Object.entries(environment)) {
    if (name === 'vars' && value && typeof value === 'object')
      kept.vars = Object.fromEntries(
        Object.entries(value).filter(([variable]) => !names.has(variable)),
      );
    else if (ENV_SETTINGS.has(name) || !names.has(name)) kept[name] = value;
  }
  return kept;
}

// What OpenClaw makes of a config string, in pieces. It substitutes in one
// pass over the string as written: a variable that holds something replaces
// its token, an empty or missing one gives way to the token's default, an
// escaped token becomes the text it stands for, and a token with neither a
// value nor a default stays as written, for whoever loads the string next
// (`live`).
function templatePieces(text, env) {
  const pieces = [];
  let end = 0;
  for (const token of envTemplateTokens(text)) {
    pieces.push({ text: text.slice(end, token.start) });
    end = token.end + 1;
    const written = text.slice(token.start, end);
    const value = env[token.name];
    if (token.escaped) pieces.push({ text: written.slice(1) });
    else if (typeof value === 'string' && value !== '')
      pieces.push({ text: value });
    else if (token.fallback !== undefined)
      pieces.push({ text: token.fallback });
    else pieces.push({ text: written, live: true });
  }
  pieces.push({ text: text.slice(end) });
  return pieces;
}

// The string OpenClaw ends up with.
function expandTemplates(text, env) {
  return templatePieces(text, env)
    .map((piece) => piece.text)
    .join('');
}

// A config string that names a credential, as it has to be written into the
// launch config for OpenClaw to end up with what it would have made of the
// original. OpenClaw substitutes again when it loads the launch config, and
// a value written in can join the text around it into a token that was not
// there (a key ending in `$` before `{NAME}`), or turn the next token into
// an escape. So the string is taken apart as OpenClaw would in its one
// pass: the credentials are written in, and they, the text between the
// templates and the escaped ones become literal text. Every other template
// stays OpenClaw's to resolve when it loads the launch config, default
// included, with what it has by then: a variable from the workspace's
// `.env` is not known here. The one exception is a template right after
// text ending in `$`, which would read as an escape and which nothing can
// express: that one is resolved here, with what the launcher knows.
// A string that names no credential is left to OpenClaw untouched.
function withCredentials(text, env, isCredential) {
  const tokens = [...envTemplateTokens(text)];
  if (!tokens.some((token) => !token.escaped && isCredential(token.name)))
    return text;
  let result = '';
  let run = '';
  let end = 0;
  for (const token of tokens) {
    run += text.slice(end, token.start);
    end = token.end + 1;
    const written = text.slice(token.start, end);
    if (token.escaped) run += written.slice(1);
    else if (isCredential(token.name)) run += env[token.name];
    else if (!run.endsWith('$')) {
      result += literal(run) + written;
      run = '';
    } else {
      const value = env[token.name];
      run +=
        typeof value === 'string' && value !== ''
          ? value
          : (token.fallback ?? written);
    }
  }
  return result + literal(run + text.slice(end));
}

// Text as it has to be written into the launch config to reach OpenClaw
// unchanged. OpenClaw substitutes templates in every config string it loads,
// including the ones the launcher has already resolved, so a credential that
// happens to contain `${NAME}` would be rewritten on the way in. A `$` in
// front of each token is OpenClaw's escape for the literal text.
function literal(value) {
  let result = '';
  let end = 0;
  for (const token of envTemplateTokens(value)) {
    result += `${value.slice(end, token.start)}$`;
    end = token.start;
  }
  return result + value.slice(end);
}

const SECRET_REF_KEYS = new Set(['source', 'provider', 'id']);
const KEPT_ENV = new Set(['PATH', 'HOME', 'LANG']);

// The `${NAME}` and `${NAME:-default}` tokens in a config string, by
// OpenClaw's own grammar (its env-substitution `iterateEnvTemplateTokens`):
// `$${…}` is the escape for the literal text, a name is upper-case, and a
// default holds neither `$` nor `{`.
const ENV_VAR_NAME = /^[A-Z_][A-Z0-9_]*$/u;
function* envTemplateTokens(value) {
  for (
    let index = value.indexOf('$');
    index !== -1;
    index = value.indexOf('$', index + 1)
  ) {
    const escaped = value[index + 1] === '$' && value[index + 2] === '{';
    if (!escaped && value[index + 1] !== '{') continue;
    const start = index + (escaped ? 3 : 2);
    const end = value.indexOf('}', start);
    if (end === -1) continue;
    const body = value.slice(start, end);
    const operator = body.indexOf(':-');
    const name = operator === -1 ? body : body.slice(0, operator);
    const fallback = operator === -1 ? undefined : body.slice(operator + 2);
    if (
      !ENV_VAR_NAME.test(name) ||
      fallback?.includes('$') ||
      fallback?.includes('{')
    )
      continue;
    yield { escaped, name, fallback, start: index, end };
    index = end;
  }
}

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
// - Logging and diagnostics stay the definition's own: nothing here reads
//   the Gateway's log.
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
              // The directory a run's commands start in, which `agent exec`
              // set to the workspace whatever the config said.
              ...('cwd' in rest ? { cwd: workspace } : {}),
              ...(runtime
                ? { runtime: runtime.acp ? { ...runtime, acp } : runtime }
                : {}),
            },
          ];
        }),
      ),
    };
  // The variables OpenClaw reads its Gateway's port, token and address from
  // are not a definition's to set through its own `env` either.
  if (pinned.env !== undefined)
    pinned.env = withoutVariables(pinned.env, GATEWAY_VARIABLES);
  return mergeDeep(mergeDeep(TURN_DEFAULTS, pinned), {
    agents: { defaults: { workspace, cwd: workspace, skipBootstrap: true } },
    skills: { load: { watch: false } },
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
    await providerAuthEnv(openclaw, { env: childEnv, signal }),
  );
  const launched = launchConfig(resolved, { workspace, ...gateway });
  await write(launched);
  // What the Gateway and its ACP server run with: none of the credentials
  // now held by the launch config.
  // OpenClaw takes its Gateway's port from this variable before its config,
  // and from the process before a config's `env` or a `.env` file, so the
  // listener and everything that connects to it use the port chosen here.
  const turnEnv = {
    ...Object.fromEntries(
      Object.entries(childEnv).filter(([name]) => !used.has(name)),
    ),
    OPENCLAW_GATEWAY_PORT: String(gateway.port),
  };
  const tokenFile = join(stateDir, 'gateway.token');
  await writeFile(tokenFile, `${gateway.token}\n`, { mode: 0o600 });
  // The Gateway's config and token belong to the same UID as the agent's
  // tools. Nothing here can stop a tool from rewriting them, so the turn's
  // result is refused when either is no longer what was launched. Exec
  // approvals live in OpenClaw's state database and are not covered.
  // Either path can by then hold anything, so each is read only as a regular
  // file of a bounded size, within a bounded time; anything else is a change.
  const launchedText = JSON.stringify(launched);
  const tokenText = `${gateway.token}\n`;
  const verify = async () => {
    const text = async (file, maxBytes) =>
      (await readSettingsFile(file, { maxBytes }))?.toString('utf8') ?? '';
    let config;
    try {
      // OpenClaw may have rewritten its config in its own formatting.
      config = comparableConfig(
        JSON.parse(
          await text(
            configPath,
            SETTINGS_SLACK_BYTES + 4 * Buffer.byteLength(launchedText),
          ),
        ),
      );
    } catch {
      config = undefined;
    }
    const changed =
      config !== comparableConfig(launched)
        ? 'OpenClaw config'
        : (await text(tokenFile, Buffer.byteLength(tokenText))) !== tokenText
          ? 'OpenClaw Gateway token'
          : undefined;
    return changed && `the agent changed its harness settings (${changed})`;
  };
  return { turnEnv, port: gateway.port, tokenFile, verify };
}

// Starts the Gateway in its own process group and resolves, once it answers
// its readiness probe, with the function that stops it. Readiness is the
// Gateway's own `/readyz`, not a line in its log: a definition's logging and
// redaction settings decide what the log says.
export function startGateway(openclaw, { env, cwd, port, signal }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ClawFailure('claw run was cancelled'));
      return;
    }
    // In the agent's workspace, where `agent exec` ran: OpenClaw reads a
    // `.env` there, under its own filter, and host tools inherit it.
    const child = spawn(openclaw, ['gateway', 'run', '--port', String(port)], {
      env,
      cwd,
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
    const probe = async () => {
      while (!settled) {
        const ready = await fetch(`http://127.0.0.1:${port}/readyz`, {
          signal: AbortSignal.timeout(GATEWAY_PROBE_MS * 8),
        }).then(
          async (response) => {
            await response.body?.cancel();
            return response.status === 200;
          },
          () => false,
        );
        if (ready) {
          if (settle()) resolve({ stop });
          return;
        }
        await new Promise((done) => setTimeout(done, GATEWAY_PROBE_MS));
      }
    };
    void probe();
    // Both streams are drained, because a full pipe would block the
    // Gateway, and discarded: its logs can echo resolved configuration.
    child.stdout.resume();
    child.stderr.resume();
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

// How the Gateway recorded the turn, or why its result is refused. OpenClaw's
// ACP server ends a failed turn like any other (`end_turn`), even after part
// of an answer has streamed, so the Gateway's own record of the session is
// asked: its last run must be `done`. A model attempt that failed before a
// fallback answered is still `done`. The record is asked of the Gateway
// itself, not read from its log, which a definition's redaction settings
// can rewrite. OpenClaw's text for the failure is never repeated.
// Resolves with `{ refused }`, or with `{ runId }` for a run that finished.
export async function turnOutcome(openclaw, { env, sessionId, signal }) {
  const unreported = {
    refused: "OpenClaw did not report the turn's outcome",
  };
  if (typeof sessionId !== 'string' || sessionId === '') return unreported;
  for (let attempt = 1; ; attempt++) {
    let status;
    let runId;
    try {
      // The CLI finds this Job's Gateway and its token in the launch config.
      const listed = await run(
        openclaw,
        ['gateway', 'call', 'sessions.list', '--json', '--timeout', '20000'],
        { env, timeoutMs: OUTCOME_CALL_MS, signal },
      );
      if (listed.code !== 0 || listed.timedOut) return unreported;
      const { sessions } = JSON.parse(listed.stdout);
      // The ACP server keys its Gateway session by the ACP session's id.
      const session = sessions.find(
        (row) =>
          typeof row?.key === 'string' &&
          row.key.endsWith(`:acp-bridge:${sessionId}`),
      );
      if (session === undefined) return unreported;
      status = session.status;
      runId = session.lastRunId;
    } catch {
      return unreported;
    }
    if (status === 'done') return { runId };
    // Still being recorded: the ACP server answers as the run ends.
    if (
      (status !== 'running' && status !== 'queued') ||
      attempt === OUTCOME_ATTEMPTS
    )
      return { refused: 'OpenClaw reported the turn as failed' };
    await new Promise((done) => setTimeout(done, OUTCOME_RETRY_MS));
  }
}

// The Gateway's record of the run's final reply (`agent.wait`): `{ text }`,
// `{ empty }` for a run it recorded as ending silent or with no reply, or
// undefined when it has no record to give. It is the reply alone, without what the agent
// said on the way, but capped in length, so it locates the answer and is
// not itself the report.
async function terminalReply(openclaw, { env, runId, signal }) {
  if (typeof runId !== 'string' || runId === '') return undefined;
  try {
    const waited = await run(
      openclaw,
      [
        'gateway',
        'call',
        'agent.wait',
        '--json',
        '--params',
        JSON.stringify({ runId, timeoutMs: 0 }),
        '--timeout',
        '20000',
      ],
      { env, timeoutMs: OUTCOME_CALL_MS, signal },
    );
    if (waited.code !== 0 || waited.timedOut) return undefined;
    const reply = JSON.parse(waited.stdout).terminalReply;
    if (reply?.disposition === 'visible' && typeof reply.text === 'string')
      return { text: reply.text };
    // The run finished and the agent gave no final answer: not the same as
    // having no record to go by.
    return reply?.disposition === 'silent' || reply?.disposition === 'empty'
      ? { empty: true }
      : undefined;
  } catch {
    return undefined;
  }
}

/** The answer within what OpenClaw's ACP server streamed for the turn.
 * It sends the agent's commentary and its final answer as the same kind of
 * message text with nothing between them, so a turn without a tool call
 * streams both as one message. The Gateway records the final reply by
 * itself: where the stream ends with it, the answer is that ending. A long
 * reply is recorded cut short with a marker; then the answer begins where
 * the recorded part first appears. A reply that cannot be placed leaves the
 * stream as it is. */
export function answerText(streamed, reply) {
  if (typeof reply !== 'string' || reply === '') return streamed;
  const body = streamed.trimEnd();
  if (body.endsWith(reply)) return streamed.slice(body.length - reply.length);
  const head = reply.endsWith(REPLY_CUT_MARKER)
    ? reply.slice(0, -REPLY_CUT_MARKER.length)
    : '';
  const at = head === '' ? -1 : streamed.indexOf(head);
  return at > 0 ? streamed.slice(at) : streamed;
}
const REPLY_CUT_MARKER = '…';

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
  const gateway = await startGateway(openclaw, {
    env: turnEnv,
    cwd: workspace,
    port,
    signal,
  });
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
    promptMeta: { timeoutMs: TURN_TIMEOUT_MS },
    // The Gateway is asked how it recorded the turn while it still runs,
    // then stopped whatever the answer. A turn that already failed or was
    // cancelled needs no second opinion.
    finish: async (turn) => {
      let outcome = {};
      let reply;
      try {
        if (turn && !turn.aborted && !turn.error) {
          outcome = await turnOutcome(openclaw, {
            env: turnEnv,
            sessionId: turn.sessionId,
            signal,
          });
          if (outcome.refused === undefined)
            reply = await terminalReply(openclaw, {
              env: turnEnv,
              runId: outcome.runId,
              signal,
            });
        }
      } finally {
        await gateway.stop();
      }
      return {
        refused: outcome.refused ?? (await verify()),
        // A turn the Gateway recorded as ending without a final answer
        // has none, whatever the agent said on the way.
        ...(turn
          ? { final: reply?.empty ? '' : answerText(turn.final, reply?.text) }
          : {}),
      };
    },
  };
}

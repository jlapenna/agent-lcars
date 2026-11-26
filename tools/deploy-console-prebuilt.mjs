#!/usr/bin/env node

import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { parse as parseYaml } from 'yaml';

const execFileAsync = promisify(execFile);
const API_ROOT = 'https://firebaseapphosting.googleapis.com/v1';
const PENDING_BUILD_STATES = new Set(['BUILDING', 'BUILT', 'DEPLOYING']);
const TERMINAL_BUILD_STATES = new Set(['FAILED', 'SKIPPED', 'EXPIRED']);
const TERMINAL_ROLLOUT_STATES = new Set([
  'FAILED',
  'CANCELLED',
  'CANCELED',
  'SKIPPED',
]);
const CLOUD_BUILDER_VARIABLES = new Set([
  'CI',
  'FORCE_COLOR',
  'NODE_OPTIONS',
  'NO_COLOR',
  'NX_DAEMON',
  'PATH',
]);

export class AppHostingApiError extends Error {
  constructor(status, message, { buildFailed, invalidRolloutField }) {
    super(message);
    this.name = 'AppHostingApiError';
    this.status = status;
    this.buildFailed = buildFailed;
    this.invalidRolloutField = invalidRolloutField;
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function capture(command, args) {
  const { stdout } = await execFileAsync(command, args, {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout.trim();
}

async function run(command, args, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      ...options,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${command} exited ${code ?? `for signal ${signal ?? 'unknown'}`}`,
        ),
      );
    });
  });
}

export function qualifySecret(secret, projectNumber) {
  if (/^projects\/[^/]+\/secrets\/[^/]+\/versions\/[^/]+$/u.test(secret)) {
    return secret;
  }
  if (secret.includes('/')) {
    throw new Error(`Unsupported App Hosting secret reference: ${secret}`);
  }
  const [secretId, version = 'latest'] = secret.split('@');
  if (!secretId || !version || secret.split('@').length > 2) {
    throw new Error(`Invalid App Hosting secret reference: ${secret}`);
  }
  return `projects/${projectNumber}/secrets/${secretId}/versions/${version}`;
}

export async function loadAppHostingConfig(yamlPath, projectNumber) {
  const raw = parseYaml(await readFile(yamlPath, 'utf8')) ?? {};
  const buildCommand = raw.scripts?.buildCommand;
  const runCommand = raw.scripts?.runCommand;
  if (!buildCommand || !runCommand) {
    throw new Error(
      `${yamlPath} must define scripts.buildCommand and scripts.runCommand`,
    );
  }

  const outputFiles = raw.outputFiles?.serverApp?.include;
  if (!Array.isArray(outputFiles) || outputFiles.length === 0) {
    throw new Error(`${yamlPath} must define outputFiles.serverApp.include`);
  }
  for (const include of outputFiles) {
    const normalized = path.normalize(String(include));
    if (
      path.isAbsolute(normalized) ||
      normalized === '..' ||
      normalized.startsWith(`..${path.sep}`)
    ) {
      throw new Error(
        `outputFiles.serverApp.include escapes the workspace: ${include}`,
      );
    }
  }

  const runConfigFields = new Map([
    ['cpu', 'cpu'],
    ['memoryMiB', 'memoryMib'],
    ['minInstances', 'minInstances'],
    ['maxInstances', 'maxInstances'],
    ['concurrency', 'concurrency'],
  ]);
  const rawRunConfig = raw.runConfig ?? {};
  const unknownRunConfig = Object.keys(rawRunConfig).filter(
    (field) => !runConfigFields.has(field),
  );
  if (unknownRunConfig.length > 0) {
    throw new Error(
      `Unsupported runConfig fields in ${yamlPath}: ${unknownRunConfig.join(', ')}`,
    );
  }
  const runConfig = Object.fromEntries(
    [...runConfigFields].flatMap(([yamlField, apiField]) =>
      rawRunConfig[yamlField] === undefined
        ? []
        : [[apiField, rawRunConfig[yamlField]]],
    ),
  );

  const env = [];
  const buildEnv = {};
  const runtimeOnlyVariables = [];
  for (const item of raw.env ?? []) {
    const variable = item?.variable;
    const hasValue = Object.hasOwn(item ?? {}, 'value');
    const hasSecret = Object.hasOwn(item ?? {}, 'secret');
    if (!variable || hasValue === hasSecret) {
      throw new Error(
        `Each env entry in ${yamlPath} must have a variable and exactly one of value or secret`,
      );
    }
    const availability = item.availability ?? ['BUILD', 'RUNTIME'];
    const invalidAvailability = availability.filter(
      (value) => value !== 'BUILD' && value !== 'RUNTIME',
    );
    if (invalidAvailability.length > 0) {
      throw new Error(
        `Invalid availability for ${variable}: ${invalidAvailability.join(', ')}`,
      );
    }

    const translated = { variable, availability };
    if (hasSecret) {
      translated.secret = qualifySecret(String(item.secret), projectNumber);
    } else {
      translated.value = String(item.value);
    }

    if (availability.includes('RUNTIME')) {
      env.push(translated);
    }
    if (availability.includes('RUNTIME') && !availability.includes('BUILD')) {
      runtimeOnlyVariables.push(variable);
    }
    if (availability.includes('BUILD')) {
      if (hasSecret) {
        throw new Error(
          `Build-time secret ${variable} is not supported by the local deploy path`,
        );
      }
      if (!CLOUD_BUILDER_VARIABLES.has(variable)) {
        buildEnv[variable] = translated.value;
      }
    }
  }

  return {
    buildCommand,
    runCommand,
    outputFiles: outputFiles.map(String),
    runConfig,
    env,
    buildEnv,
    runtimeOnlyVariables,
  };
}

export function prepareBuildEnv(config, ambientEnv = process.env) {
  const buildEnv = { ...ambientEnv };
  for (const variable of config.runtimeOnlyVariables) {
    delete buildEnv[variable];
  }
  return { ...buildEnv, ...config.buildEnv };
}

export function buildIdFor(commitSha, runId, runAttempt = '1') {
  if (!/^[0-9a-f]{40}$/u.test(commitSha)) {
    throw new Error(`Expected a full lowercase git SHA, got ${commitSha}`);
  }
  const discriminator = runId ?? String(process.hrtime.bigint());
  const token = createHash('sha256')
    .update(`${discriminator}:${runAttempt}`)
    .digest('hex')
    .slice(0, 12);
  return `pb-${commitSha.slice(0, 12)}-${token}`;
}

export function makeBuildBody(config, artifact, commitSha) {
  if (
    !/^[a-z0-9-]+-docker\.pkg\.dev\/[a-z0-9-]+\/[a-z0-9._-]+\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/u.test(
      artifact,
    )
  ) {
    throw new Error('Expected an immutable Artifact Registry container image');
  }
  const labels = {
    'deployment-tool': 'agent-lcars',
    'commit-sha': commitSha,
  };
  return {
    displayName: `prebuilt ${commitSha.slice(0, 12)}`,
    source: { container: { image: artifact } },
    config: {
      runConfig: config.runConfig,
      env: config.env,
    },
    labels,
    annotations: {
      'source-commit': commitSha,
      'source-artifact': artifact,
    },
  };
}

function resourceId(name) {
  return name?.split('/').at(-1);
}

function terminalBuildFailure(build, buildName) {
  if (!TERMINAL_BUILD_STATES.has(build?.state)) {
    return undefined;
  }
  const prefix = `App Hosting build ${resourceId(buildName)} entered terminal state ${build.state}`;
  const errors = Array.isArray(build.errors) ? build.errors : [];
  let reason;
  for (const entry of [...errors, build.error]) {
    if (entry?.errorSource !== 'CLOUD_RUN') continue;
    reason ??= 'Cloud Run could not prepare the revision';
    const message = entry.error?.message;
    if (typeof message !== 'string') continue;

    // Classify provider text, but never echo it. It can contain configuration
    // values, secret references or runtime identities.
    if (!/\bsecret\b/iu.test(message)) continue;
    if (/\bnot found\b|\bdoes not exist\b|\bno versions?\b/iu.test(message)) {
      return `${prefix}: Cloud Run could not resolve a runtime secret or version. Check that the version exists and the runtime identity can access it.`;
    }
    if (
      /permission denied|access denied|not authorized|does not have (?:permission|access)|secretmanager\.versions\.access/iu.test(
        message,
      )
    ) {
      return `${prefix}: Cloud Run reported a runtime secret access failure. Check access for the runtime identity.`;
    }
  }
  return reason ? `${prefix}: ${reason}` : prefix;
}

export function rolloutVerdict({
  build,
  rollout,
  traffic,
  expectedBuildName,
  expectedCommit,
  expectedArtifact,
}) {
  if (!build || !rollout || !traffic) {
    return ['continue', 'Waiting for build, rollout, and traffic resources'];
  }
  if (build.name !== expectedBuildName) {
    return [
      'fail',
      `Observed build ${build.name ?? '<unknown>'}, expected ${expectedBuildName}`,
    ];
  }
  if (build.labels?.['commit-sha'] !== expectedCommit) {
    return ['fail', 'Build commit provenance does not match the expected SHA'];
  }
  const artifact = build.source?.container?.image;
  if (artifact !== expectedArtifact) {
    return [
      'fail',
      `Build artifact is ${artifact ?? '<missing>'}, expected ${expectedArtifact}`,
    ];
  }
  const failure = terminalBuildFailure(build, expectedBuildName);
  if (failure) return ['fail', failure];
  if (build.state !== 'READY') {
    return ['continue', `Build state is ${build.state ?? '<unknown>'}`];
  }
  if (rollout.build !== expectedBuildName) {
    return ['fail', 'Rollout points at a different build'];
  }
  if (TERMINAL_ROLLOUT_STATES.has(rollout.state)) {
    return ['fail', `Rollout entered terminal state ${rollout.state}`];
  }
  if (rollout.state !== 'SUCCEEDED') {
    return ['continue', `Rollout state is ${rollout.state ?? '<unknown>'}`];
  }

  const expectedId = resourceId(expectedBuildName);
  const splits = traffic.current?.splits ?? [];
  const expectedPercent = splits
    .filter((split) => resourceId(split.build) === expectedId)
    .reduce((total, split) => total + (split.percent ?? 0), 0);
  const otherPercent = splits
    .filter((split) => resourceId(split.build) !== expectedId)
    .reduce((total, split) => total + (split.percent ?? 0), 0);
  if (expectedPercent !== 100 || otherPercent !== 0) {
    return [
      'continue',
      `Traffic is ${expectedPercent}% on ${expectedId} and ${otherPercent}% elsewhere`,
    ];
  }
  return ['success', build.image ?? ''];
}

async function accessToken() {
  const token = await capture('gcloud', ['auth', 'print-access-token']);
  if (!token) {
    throw new Error('Could not obtain a gcloud access token');
  }
  return token;
}

async function apiRequest(method, resourcePath, body, query) {
  const url = new URL(`${API_ROOT}/${resourcePath.replace(/^\//u, '')}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    url.searchParams.set(key, String(value));
  }
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${await accessToken()}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const responseText = await response.text();
  if (!response.ok) {
    let buildFailed = false;
    let invalidRolloutField = false;
    if (response.status === 400) {
      try {
        const { error } = JSON.parse(responseText) ?? {};
        buildFailed =
          typeof error?.message === 'string' &&
          /\bBUILD_FAILED\b/u.test(error.message);
        invalidRolloutField =
          Array.isArray(error?.details) &&
          error.details.some(
            (detail) =>
              detail?.['@type'] ===
                'type.googleapis.com/google.rpc.BadRequest' &&
              Array.isArray(detail.fieldViolations) &&
              detail.fieldViolations.some(
                (violation) =>
                  typeof violation?.field === 'string' &&
                  violation.field !== 'build',
              ),
          );
      } catch {
        // Non-JSON error bodies have no structured status.
      }
    }
    throw new AppHostingApiError(
      response.status,
      `App Hosting API ${method} ${resourcePath} failed (HTTP ${response.status})`,
      { buildFailed, invalidRolloutField },
    );
  }
  return responseText ? JSON.parse(responseText) : {};
}

async function waitForOperation(operation, timeoutSeconds = 1800) {
  if (operation.done) {
    if (operation.error) {
      throw new Error(
        `App Hosting operation failed (code ${Number(operation.error.code)})`,
      );
    }
    return operation.response ?? {};
  }
  if (!operation.name) {
    throw new Error('App Hosting API returned an operation without a name');
  }

  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    const current = await apiRequest('GET', operation.name);
    if (current.done) {
      if (current.error) {
        throw new Error(
          `App Hosting operation ${operation.name} failed (code ${Number(current.error.code)})`,
        );
      }
      return current.response ?? {};
    }
    await sleep(5000);
  }
  throw new Error(
    `Timed out after ${timeoutSeconds}s waiting for ${operation.name}`,
  );
}

export async function createArchive(repoRoot, includes, buildId) {
  for (const include of includes) {
    await stat(path.join(repoRoot, include)).catch(() => {
      throw new Error(`Expected prebuilt output does not exist: ${include}`);
    });
  }
  const tempDirectory = await mkdtemp(
    path.join(os.tmpdir(), 'agent-lcars-apphosting-'),
  );
  const archivePath = path.join(tempDirectory, `${buildId}.tar.gz`);
  try {
    await run('tar', [
      '--create',
      '--gzip',
      '--hard-dereference',
      '--file',
      archivePath,
      '--directory',
      repoRoot,
      '--',
      ...includes,
    ]);
    if ((await stat(archivePath)).size === 0) {
      throw new Error('Prebuilt App Hosting archive is empty');
    }
    return { archivePath, tempDirectory };
  } catch (error) {
    await rm(tempDirectory, { recursive: true, force: true });
    throw error;
  }
}

async function projectNumber(projectId) {
  const value = await capture('gcloud', [
    'projects',
    'describe',
    projectId,
    '--format=value(projectNumber)',
  ]);
  if (!/^\d+$/u.test(value)) {
    throw new Error(`Could not resolve project number for ${projectId}`);
  }
  return value;
}

async function verifyRollout({
  parent,
  buildName,
  rolloutName,
  commitSha,
  artifact,
  timeoutSeconds = 600,
}) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (true) {
    const [build, rollout, traffic] = await Promise.all([
      apiRequest('GET', buildName),
      apiRequest('GET', rolloutName),
      apiRequest('GET', `${parent}/traffic`),
    ]);
    const [verdict, detail] = rolloutVerdict({
      build,
      rollout,
      traffic,
      expectedBuildName: buildName,
      expectedCommit: commitSha,
      expectedArtifact: artifact,
    });
    if (verdict === 'success') {
      return detail;
    }
    if (verdict === 'fail' || Date.now() >= deadline) {
      throw new Error(
        `${verdict === 'fail' ? 'Verification failed' : 'Timed out'}: ${detail}`,
      );
    }
    console.log(`[Deploy] ${detail}`);
    await sleep(10_000);
  }
}

async function writeOutput(key, value) {
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  }
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith('--') || value === undefined) {
      throw new Error(`Expected --name value arguments, got ${argv.join(' ')}`);
    }
    args[flag.slice(2)] = value;
  }
  for (const required of [
    'project',
    'region',
    'backend',
    'root-dir',
    'commit',
    'image',
  ]) {
    if (!args[required]) {
      throw new Error(`Missing required argument --${required}`);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const commitSha = args.commit;
  const repoRoot = await capture('git', ['rev-parse', '--show-toplevel']);
  const checkedOutSha = await capture('git', ['rev-parse', 'HEAD']);
  if (checkedOutSha !== commitSha) {
    throw new Error(
      `Checked out ${checkedOutSha}, but deployment requested ${commitSha}`,
    );
  }

  const number = await projectNumber(args.project);
  const config = await loadAppHostingConfig(
    path.join(repoRoot, args['root-dir'], 'apphosting.yaml'),
    number,
  );
  const buildId = buildIdFor(
    commitSha,
    process.env.GITHUB_RUN_ID,
    process.env.GITHUB_RUN_ATTEMPT,
  );
  const parent = `projects/${args.project}/locations/${args.region}/backends/${args.backend}`;
  const buildName = `${parent}/builds/${buildId}`;
  const rolloutName = `${parent}/rollouts/${buildId}`;

  const artifact = args.image;
  const expectedRepository = `${args.region}-docker.pkg.dev/${args.project}/firebaseapphosting-images/console@sha256:`;
  if (!artifact.startsWith(expectedRepository)) {
    throw new Error('Container is outside the console deployment repository');
  }
  const buildBody = makeBuildBody(config, artifact, commitSha);
  console.log(`[Deploy] Registering App Hosting build ${buildId}`);
  const buildOperation = await apiRequest(
    'POST',
    `${parent}/builds`,
    buildBody,
    { buildId, requestId: randomUUID() },
  );
  const registeredBuild = await waitForOperation(buildOperation);
  const registrationFailure = terminalBuildFailure(registeredBuild, buildName);
  if (registrationFailure) throw new Error(registrationFailure);

  const rolloutBody = {
    displayName: `prebuilt ${commitSha.slice(0, 12)}`,
    build: buildName,
    labels: buildBody.labels,
  };
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      await apiRequest('POST', `${parent}/rollouts`, rolloutBody, {
        rolloutId: buildId,
        validateOnly: 'true',
        requestId: randomUUID(),
      });
      break;
    } catch (error) {
      if (!(error instanceof AppHostingApiError) || error.status !== 400) {
        throw error;
      }
      // The create operation can finish before the build state settles.
      const reportedFailure = error.buildFailed
        ? `App Hosting reported BUILD_FAILED for build ${buildId}`
        : undefined;
      const build = await apiRequest('GET', buildName).catch((lookupError) => {
        if (reportedFailure) throw new Error(reportedFailure);
        throw lookupError;
      });
      const failure = terminalBuildFailure(build, buildName) ?? reportedFailure;
      if (failure) throw new Error(failure);
      if (
        error.invalidRolloutField ||
        !PENDING_BUILD_STATES.has(build?.state) ||
        attempt === 5
      ) {
        throw error;
      }
      await sleep(1000);
    }
  }

  console.log(`[Deploy] Starting rollout ${buildId}`);
  const rolloutOperation = await apiRequest(
    'POST',
    `${parent}/rollouts`,
    rolloutBody,
    { rolloutId: buildId, requestId: randomUUID() },
  );
  await waitForOperation(rolloutOperation);
  const image = await verifyRollout({
    parent,
    buildName,
    rolloutName,
    commitSha,
    artifact,
  });

  await writeOutput('build_id', buildId);
  await writeOutput('build_name', buildName);
  await writeOutput('source_uri', artifact);
  console.log(
    `[Success] Prebuilt App Hosting build ${buildId} from ${commitSha} owns 100% traffic (${image})`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(`[Deploy] ${error.stack ?? error.message}`);
    process.exitCode = 1;
  });
}

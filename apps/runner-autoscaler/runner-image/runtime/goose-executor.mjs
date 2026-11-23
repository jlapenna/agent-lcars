import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Same bound as the Work API's REPOSITORY_JOB_RESULT_MAX_BYTES.
export const RESULT_MAX_BYTES = 4 * 1024 * 1024;
// Goose's JSON envelope carries the whole conversation around the final
// result, so its memory guard leaves room beyond one maximum result.
const OUTPUT_MAX_BYTES = 4 * RESULT_MAX_BYTES;

// The adapter runs ONLY inside a caller-owned, enforced job allocation. The
// caller supplies its admission proof; an unguarded workstation invocation is
// refused, never silently upgraded into a larger allocation.
export function gooseExecutor({
  executable = 'goose',
  assertAllocation,
  environment,
  workingDirectory,
  onProviderStarted,
  resultFile,
}) {
  if (typeof assertAllocation !== 'function')
    throw new Error('an enforced allocation verifier is required');
  if (!environment?.HOME || !environment.GOOSE_PATH_ROOT)
    throw new Error('isolated profile environment is required');
  if (!workingDirectory)
    throw new Error('repository working directory is required');
  return async ({
    run,
    baseline,
    parameters: invocationParameters = {},
    signal,
  }) => {
    await assertAllocation(run.definition.job.execution.resources);
    if (resultFile) {
      validateResultPath(resultFile);
      // A stale file must never stand in for work this invocation did not do.
      const existing = await lstat(resultFile).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
        return null;
      });
      if (existing)
        throw new Error('Declared Goose result file already exists');
    }
    const directory = await mkdtemp(join(tmpdir(), 'lcars-goose-'));
    try {
      const recipe = join(directory, 'recipe.yaml');
      // The Work API's file-parameter rewrite of the admitted recipe, when it
      // supplies one, lets every value travel as a file instead of argv.
      const fileParameters = typeof run.fileRecipeText === 'string';
      await writeFile(
        recipe,
        fileParameters ? run.fileRecipeText : run.definition.recipeText,
        { mode: 0o600 },
      );
      await subprocess(executable, ['recipe', 'validate', recipe], {
        cwd: workingDirectory,
        signal,
        environment,
      });
      const args = [
        'run',
        '--recipe',
        recipe,
        '--quiet',
        '--output-format',
        'json',
      ];
      const parameters = {
        ...invocationParameters,
        ...run.definition.job.inputs,
        baseline: JSON.stringify(baseline),
      };
      if (fileParameters) {
        // Goose reads each file parameter's contents into the template, so
        // values are bounded by what LCARS stores, not by argv.
        const values = join(directory, 'parameters');
        await mkdir(values, { mode: 0o700 });
        for (const [key, value] of Object.entries(parameters)) {
          if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/u.test(key))
            throw new Error('Invalid recipe parameter name');
          const path = join(values, key);
          await writeFile(path, value, { mode: 0o600, flag: 'wx' });
          args.push('--params', `${key}=${path}`);
        }
      } else
        for (const [key, value] of Object.entries(parameters)) {
          // Linux refuses one argument above MAX_ARG_STRLEN (128 KiB).
          if (Buffer.byteLength(`${key}=${value}`) >= 128 * 1024)
            throw new Error(
              `Recipe parameter ${key} exceeds the 128 KiB argument limit; this occurrence cannot pass values as files`,
            );
          args.push('--params', `${key}=${value}`);
        }
      let output;
      try {
        output = await subprocess(executable, args, {
          cwd: workingDirectory,
          signal,
          environment,
          onSpawn:
            onProviderStarted ??
            (() => {
              /* No observer was supplied. */
            }),
        });
      } catch (error) {
        const providerOutcome = classifyGooseProviderFailure(error);
        if (providerOutcome && error instanceof Error) {
          error.providerOutcome = providerOutcome;
        }
        throw error;
      }
      // Goose's machine output wraps the conversation; --quiet alone still
      // renders tool activity. Only the final assistant response is a result.
      if (resultFile) {
        completedConversation(output);
        signal.throwIfAborted();
        return await readGooseResultFile(resultFile);
      }
      return parseGooseResult(output);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };
}

function completedConversation(output) {
  const envelope = JSON.parse(output);
  if (
    envelope.metadata?.status !== 'completed' ||
    !Array.isArray(envelope.messages)
  )
    throw new Error('Goose did not return a completed conversation');
  return envelope;
}

export function parseGooseResult(output) {
  const envelope = completedConversation(output);
  const final = envelope.messages.findLast(
    (message) => message.role === 'assistant',
  );
  if (
    !Array.isArray(final?.content) ||
    !final.content.length ||
    !final.content.every(
      (part) => part.type === 'text' && typeof part.text === 'string',
    )
  )
    throw new Error('Goose final assistant response is not result text');
  return JSON.parse(final.content.map((part) => part.text).join(''));
}

function validateResultPath(path) {
  if (
    typeof path !== 'string' ||
    path.length > 256 ||
    !/^\/tmp\/[a-zA-Z0-9_./-]+\.json$/u.test(path) ||
    path
      .split('/')
      .slice(2)
      .some((part) => !part || part === '.' || part === '..')
  )
    throw new Error('Invalid declared Goose result file path');
}

export async function readGooseResultFile(path) {
  validateResultPath(path);
  // Reject links in the file or its parents. No model-selected path or fallback.
  if ((await realpath(path)) !== resolve(path))
    throw new Error('Declared Goose result file must not use symbolic links');
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await file.stat();
    const maximum = RESULT_MAX_BYTES;
    if (!info.isFile() || info.size > maximum)
      throw new Error(
        'Declared Goose result must be a regular JSON file within 4 MiB',
      );
    const buffer = Buffer.alloc(maximum + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(
        buffer,
        size,
        buffer.length - size,
        null,
      );
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > maximum) throw new Error('Declared Goose result exceeds 4 MiB');
    return JSON.parse(buffer.subarray(0, size).toString('utf8'));
  } finally {
    await file.close();
  }
}

const PROVIDER_LIMIT_CAUSES = new Set([
  'rate limit exceeded',
  'resourceexhausted',
  'resource_exhausted',
  'insufficient_quota',
  'exceeded your current quota',
  'usage_limit_reached',
  'service_spend_limit_reached',
  'org_spend_cap_reached',
  'credit balance is too low',
  'monthly spend limit',
]);

export function classifyGooseProviderFailure(error) {
  if (!(error instanceof Error)) return undefined;
  const match = /^Goose exited [^:]+: (.+)$/u.exec(error.message);
  if (!match) return undefined;
  const causes = match[1]
    .split('; ')
    .map((cause) => cause.trim().toLowerCase());
  if (causes.some((cause) => PROVIDER_LIMIT_CAUSES.has(cause))) {
    return 'provider-limit';
  }
  if (causes.includes('model is at capacity')) {
    return 'provider-capacity';
  }
  return undefined;
}

function sanitizeGooseFailureMessage(error) {
  if (!(error instanceof Error)) return 'Goose recipe failed';
  if (error instanceof SyntaxError) return 'Goose returned invalid JSON result';
  if (error.code === 'ENOENT')
    return 'Declared Goose result file was not written';
  return error.message;
}

export async function settleGooseFailure(
  error,
  {
    aborted,
    timedOut = false,
    timeoutMinutes,
    executionStarted = true,
    codexAuth,
    complete,
    logError = console.error,
  },
) {
  if ((aborted && !timedOut) || (!timedOut && !executionStarted)) {
    logError(sanitizeGooseFailureMessage(error));
    return { settled: false };
  }
  const providerOutcome =
    !timedOut &&
    error instanceof Error &&
    (error.providerOutcome === 'provider-limit' ||
      error.providerOutcome === 'provider-capacity')
      ? error.providerOutcome
      : undefined;
  const outcome = timedOut
    ? 'agent-timeout'
    : (providerOutcome ?? 'agent-failed');
  const message = timedOut
    ? `Goose recipe timed out after ${timeoutMinutes ?? 'configured budget'}`
    : sanitizeGooseFailureMessage(error);
  logError(message);
  try {
    if (codexAuth && !codexAuth.persistenceAttempted) {
      await codexAuth.persist();
    }
    await complete({
      outcome,
      outcomeReference: null,
      message,
    });
    return { settled: true, outcome };
  } catch (settlementError) {
    logError(
      settlementError instanceof Error
        ? settlementError.message
        : 'Goose failure settlement failed',
    );
    return { settled: false };
  }
}

export async function subprocess(
  executable,
  args,
  { cwd, signal, environment, onSpawn },
) {
  if (signal.aborted) throw new Error('cancelled before process start');
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env: environment,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    let stderr = '';
    let spawnAcknowledged = Promise.resolve();
    let providerStarted = false;
    let bytes = 0;
    let failure;
    let killTimer;
    const kill = (kind) => {
      if (child.pid) {
        try {
          process.kill(-child.pid, kind);
        } catch (error) {
          if (error.code !== 'ESRCH') failure = error;
        }
      }
    };
    const stop = () => {
      kill('SIGTERM');
      killTimer ??= setTimeout(() => kill('SIGKILL'), 1000);
    };
    const consume = (chunk, output) => {
      // stderr keeps only a 4 KiB tail, so only stdout counts toward the guard.
      if (output) bytes += chunk.length;
      if (bytes > OUTPUT_MAX_BYTES) {
        failure = new Error('Goose output exceeds 16 MiB');
        stop();
      } else if (output) stdout.push(chunk);
      else stderr = (stderr + chunk.toString('utf8')).slice(-4096);
    };
    child.stdout.on('data', (chunk) => consume(chunk, true));
    child.stderr.on('data', (chunk) => consume(chunk, false));
    child.on('error', (error) => {
      failure = error;
    });
    child.on('spawn', () => {
      providerStarted = true;
      spawnAcknowledged = Promise.resolve(onSpawn?.()).catch((error) => {
        failure = error;
        stop();
      });
    });
    child.on('exit', () => kill('SIGKILL'));
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
    child.on('close', async (code, exitSignal) => {
      await spawnAcknowledged;
      signal.removeEventListener('abort', stop);
      clearTimeout(killTimer);
      // Also terminate any descendants retaining a detached process group.
      kill('SIGKILL');
      if (failure) reject(failure);
      else if (signal.aborted) reject(new Error('Goose cancelled'));
      else if (code !== 0) {
        // Keep resource, enforcement and provider-transport causes without
        // leaking provider output, tool responses or credentials into shared
        // container logs. Goose exits 1 once its provider retries are spent.
        const causes =
          stderr.match(
            /No space left on device|Cannot allocate memory|Operation not permitted|Permission denied|Read-only file system|No such file or directory|out of memory|Network error|Could not connect|Request timed out|Rate limit exceeded|ResourceExhausted|RESOURCE_EXHAUSTED|insufficient_quota|exceeded your current quota|usage_limit_reached|service_spend_limit_reached|org_spend_cap_reached|Credit balance is too low|monthly spend limit|model is at capacity|Server error/giu,
          ) ?? [];
        reject(
          new Error(
            `Goose exited ${code ?? exitSignal}${causes.length ? `: ${[...new Set(causes)].join('; ')}` : ''}`,
          ),
        );
      } else if (onSpawn && !providerStarted)
        reject(new Error('Provider spawn was not acknowledged'));
      else resolve(Buffer.concat(stdout).toString('utf8'));
    });
  });
}

// Linux allocation guard. This verifies inherited CPU/memory/swap enforcement;
// storage admission and enforcement belong to the existing native Queue lane.
export async function cgroupAllocation(resources) {
  const membership = await readFile('/proc/self/cgroup', 'utf8');
  const relative = membership
    .trim()
    .split('\n')
    .find((line) => line.startsWith('0::'))
    ?.slice(3);
  if (!relative || relative.includes('..'))
    throw new Error('unified cgroup membership unavailable');
  const cgroupPath = join('/sys/fs/cgroup', relative);
  const [cpu, memory, swap] = await Promise.all([
    readFile(join(cgroupPath, 'cpu.max'), 'utf8'),
    readFile(join(cgroupPath, 'memory.max'), 'utf8'),
    readFile(join(cgroupPath, 'memory.swap.max'), 'utf8'),
  ]);
  const [quota, period] = cpu.trim().split(' ').map(Number);
  const maximumMemory =
    parseInt(resources.limits.memory, 10) *
    (resources.limits.memory.endsWith('Gi') ? 1024 ** 3 : 1024 ** 2);
  if (
    !Number.isFinite(quota) ||
    !Number.isFinite(period) ||
    quota <= 0 ||
    period <= 0 ||
    quota / period !== resources.requests.cpu ||
    !Number.isFinite(Number(memory)) ||
    Number(memory) !== maximumMemory ||
    Number(swap) !== 0
  ) {
    throw new Error(
      'execution is not inside the required CPU/memory/no-swap limits',
    );
  }
}

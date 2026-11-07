import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import {
  lstat,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

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
      await writeFile(recipe, run.definition.recipeText, { mode: 0o600 });
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
      if (Buffer.byteLength(parameters.baseline) > 48 * 1024)
        throw new Error('baseline exceeds 48 KiB bound');
      for (const [key, value] of Object.entries(parameters))
        args.push('--params', `${key}=${value}`);
      const output = await subprocess(executable, args, {
        cwd: workingDirectory,
        signal,
        environment,
        onSpawn:
          onProviderStarted ??
          (() => {
            /* No observer was supplied. */
          }),
      });
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
    const maximum = 262144; // Same bound as the Work recipe-result endpoint.
    if (!info.isFile() || info.size > maximum)
      throw new Error(
        'Declared Goose result must be a regular JSON file within 256 KiB',
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
    if (size > maximum)
      throw new Error('Declared Goose result exceeds 256 KiB');
    return JSON.parse(buffer.subarray(0, size).toString('utf8'));
  } finally {
    await file.close();
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
      bytes += chunk.length;
      if (bytes > 1024 * 1024) {
        failure = new Error('Goose output exceeds 1 MiB');
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
            /No space left on device|Cannot allocate memory|Operation not permitted|Permission denied|Read-only file system|No such file or directory|out of memory|Network error|Could not connect|Request timed out|Rate limit exceeded|Server error/giu,
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

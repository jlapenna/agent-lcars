import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The adapter runs ONLY inside a caller-owned, enforced job allocation. The
// caller supplies its admission proof; an unguarded workstation invocation is
// refused, never silently upgraded into a larger allocation.
export function gooseExecutor({
  executable = 'goose',
  assertAllocation,
  environment,
}) {
  if (typeof assertAllocation !== 'function')
    throw new Error('an enforced allocation verifier is required');
  if (!environment?.HOME || !environment.GOOSE_CONFIG_DIR)
    throw new Error('isolated profile environment is required');
  return async ({ run, baseline, signal }) => {
    await assertAllocation(run.definition.job.execution.resources);
    const directory = await mkdtemp(join(tmpdir(), 'lcars-goose-'));
    try {
      const recipe = join(directory, 'recipe.yaml');
      await writeFile(recipe, run.definition.recipeText, { mode: 0o600 });
      await subprocess(executable, ['recipe', 'validate', recipe], {
        cwd: directory,
        signal,
        environment,
      });
      const args = ['run', '--recipe', recipe, '--quiet'];
      const parameters = {
        ...run.definition.job.inputs,
        baseline: JSON.stringify(baseline),
      };
      if (Buffer.byteLength(parameters.baseline) > 48 * 1024)
        throw new Error('baseline exceeds prototype 48 KiB bound');
      for (const [key, value] of Object.entries(parameters))
        args.push('--params', `${key}=${value}`);
      const output = await subprocess(executable, args, {
        cwd: directory,
        signal,
        environment,
      });
      // The reference recipe's response.json_schema asks Goose for this exact
      // object. Process success alone does not satisfy the result contract.
      return JSON.parse(output);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };
}

export async function subprocess(
  executable,
  args,
  { cwd, signal, environment },
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
    };
    child.stdout.on('data', (chunk) => consume(chunk, true));
    child.stderr.on('data', (chunk) => consume(chunk, false));
    child.on('error', (error) => {
      failure = error;
    });
    child.on('exit', () => kill('SIGKILL'));
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
    child.on('close', (code, exitSignal) => {
      signal.removeEventListener('abort', stop);
      clearTimeout(killTimer);
      // Also terminate any descendants retaining a detached process group.
      kill('SIGKILL');
      if (failure) reject(failure);
      else if (signal.aborted) reject(new Error('Goose cancelled'));
      else if (code !== 0)
        reject(new Error(`Goose exited ${code ?? exitSignal}`));
      else resolve(Buffer.concat(stdout).toString('utf8'));
    });
  });
}

// Linux prototype guard. This verifies inherited CPU/memory/swap enforcement;
// filesystem enforcement must be verified by the host adapter too. A k8s
// ephemeral-storage declaration alone is deliberately not accepted as proof.
export async function cgroupAllocation(resources, { verifyStorage }) {
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
  const maximumMemory = parseInt(resources.limits.memory, 10) * 1024 ** 3;
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
  if (
    typeof verifyStorage !== 'function' ||
    !(await verifyStorage(resources.limits.storage))
  ) {
    throw new Error('hard storage enforcement is not verified');
  }
}

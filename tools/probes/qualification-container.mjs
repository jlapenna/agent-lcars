// Docker clients and daemon-owned workloads have separate lifetimes.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export async function runImageContainer(
  args,
  consume,
  {
    docker = 'docker',
    timeout = 30000,
    commandTimeout = 30000,
    cleanupTimeout = 15000,
  } = {},
) {
  // A known name survives a disconnected create client too.
  const container = 'lcars-qualification-' + randomUUID();
  let active;
  let interrupted;
  let cleaning = false;
  const hardKill = (child) => {
    if (!child) return;
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  };
  const interrupt = (signal) => {
    interrupted ??= new Error('Qualification interrupted by ' + signal);
    hardKill(active);
  };
  const onTerm = () => interrupt('SIGTERM');
  const onInt = () => interrupt('SIGINT');
  process.on('SIGTERM', onTerm);
  process.on('SIGINT', onInt);
  try {
    const execute = (args, limit) =>
      new Promise((resolve) => {
        const child = spawn(docker, args, {
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        active = child;
        let stdout = '';
        let stderr = '';
        let error;
        const fail = (reason) => {
          error ??= reason;
          hardKill(child);
        };
        const timer = setTimeout(
          () => fail(new Error('Docker client deadline exceeded')),
          Math.max(1, Math.floor(limit)),
        );
        for (const [stream, append] of [
          [
            child.stdout,
            (chunk) => {
              stdout += chunk;
            },
          ],
          [
            child.stderr,
            (chunk) => {
              stderr += chunk;
            },
          ],
        ]) {
          stream.setEncoding('utf8');
          stream.on('data', (chunk) => {
            append(chunk);
            if (stdout.length + stderr.length > 16 * 1024 * 1024)
              fail(new Error('Docker output exceeded limit'));
          });
        }
        child.on('error', (cause) => {
          error ??= cause;
        });
        child.on('close', (status, signal) => {
          clearTimeout(timer);
          active = undefined;
          resolve({
            stdout,
            stderr,
            status,
            signal,
            error: error ?? (!cleaning ? interrupted : undefined),
          });
        });
        if (interrupted && !cleaning) fail(interrupted);
      });
    const command = async (args, limit = commandTimeout) => {
      const result = await execute(args, limit);
      if (result.error || result.status !== 0)
        throw new Error(
          'Docker ' +
            args[0] +
            ' failed: ' +
            (result.error?.message ?? result.stderr),
        );
      return result.stdout.trim();
    };
    let value;
    let primary;
    let collected = false;
    let removed = false;
    try {
      await command(['create', '--name', container, ...args]);
      const execution = await execute(
        ['start', '--attach', container],
        timeout,
      );
      value = await consume(container, execution, command);
      collected = true;
    } catch (error) {
      primary = error;
    }
    primary ??= interrupted;
    cleaning = true;
    let cleanup;
    // One monotonic deadline bounds every cleanup subprocess together.
    const deadline = performance.now() + cleanupTimeout;
    const cleanupCommand = async (args, cap = cleanupTimeout) => {
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new Error('Container cleanup budget exhausted');
      return command(args, Math.min(remaining, cap));
    };
    const stopped = async () => {
      const state = JSON.parse(
        await cleanupCommand(
          ['inspect', '--format', '{{json .State}}', container],
          cleanupTimeout / 6,
        ),
      );
      return state?.Running === false;
    };
    try {
      let verified = false;
      try {
        verified = await stopped();
      } catch {
        /* Unknown state requires termination. */
      }
      if (!verified) {
        // A failed kill client can still have stopped the daemon workload.
        try {
          await cleanupCommand(['kill', container], cleanupTimeout / 3);
        } catch {
          /* Inspect proves the outcome. */
        }
        for (let attempt = 0; attempt < 3 && !verified; attempt++) {
          try {
            verified = await stopped();
          } catch {
            /* Retry only within the cleanup bound. */
          }
        }
      }
      if (!verified)
        throw new Error('Owned container stopped state is unproven');
      if (collected) {
        await cleanupCommand(['rm', container]);
        removed = true;
      }
    } catch (error) {
      cleanup = error;
    }
    if (!removed)
      process.stderr.write(
        'Qualification container retained: ' + container + '\n',
      );
    if (primary && cleanup)
      throw new AggregateError(
        [primary, cleanup],
        'Probe failed; container cleanup also failed',
      );
    if (primary) throw primary;
    if (cleanup) throw cleanup;
    if (interrupted) throw interrupted;
    return value;
  } finally {
    process.removeListener('SIGTERM', onTerm);
    process.removeListener('SIGINT', onInt);
  }
}

// Diagnostic evidence for native qualification, never a timeout exemption.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

function read(path) {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return null;
  }
}

function resources(pid) {
  return {
    pressure: Object.fromEntries(
      ['cpu', 'io', 'memory'].map((name) => [
        name,
        read(`/proc/pressure/${name}`),
      ]),
    ),
    // Do not collect command lines, environment, or process memory.
    processState: pid
      ? (read(`/proc/${pid}/status`)?.match(/^State:\s*(.*)$/m)?.[1] ?? null)
      : null,
    waitChannel: pid ? read(`/proc/${pid}/wchan`) : null,
    io: pid ? read(`/proc/${pid}/io`) : null,
  };
}

export function runNativeProcess(binary, args, cwd, env, timeout = 60000) {
  return new Promise((done) => {
    const start = performance.now();
    const elapsed = () => Math.round(performance.now() - start);
    const diagnostics = {
      startedAt: new Date().toISOString(),
      timeoutMs: timeout,
      firstStdoutMs: null,
      firstStderrMs: null,
      exit: null,
      before: resources(),
    };
    const child = spawn(binary, args, {
      cwd,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '',
      stderr = '',
      timedOut = false;
    const timer = setTimeout(
      () => {
        timedOut = true;
        const elapsedMs = elapsed();
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* already exited */
        }
        // Collection must not postpone cancellation. Process state may already
        // be gone; pressure and the exit/close timestamps remain available.
        diagnostics.atTimeout = { elapsedMs, ...resources(child.pid) };
      },
      Math.max(1, timeout - elapsed()),
    );
    child.stdout.on('data', (chunk) => {
      diagnostics.firstStdoutMs ??= elapsed();
      stdout = (stdout + chunk).slice(-1000000);
    });
    child.stderr.on('data', (chunk) => {
      diagnostics.firstStderrMs ??= elapsed();
      stderr = (stderr + chunk).slice(-1000000);
    });
    child.on('exit', (code, signal) => {
      diagnostics.exit = { elapsedMs: elapsed(), code, signal };
    });
    // Wait for close, not just exit: inherited output pipes are part of the
    // original execution budget. A printed answer is not successful completion.
    child.on('error', (error) => {
      clearTimeout(timer);
      diagnostics.spawnError = error.code ?? 'unknown';
      diagnostics.durationMs = elapsed();
      done({
        code: null,
        stdout,
        stderr: error.message,
        timedOut,
        diagnostics,
      });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      diagnostics.durationMs = elapsed();
      diagnostics.closeSignal = signal;
      diagnostics.after = resources();
      done({ code, stdout, stderr, timedOut, diagnostics });
    });
  });
}

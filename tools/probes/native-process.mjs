// Diagnostic evidence for native qualification, never a timeout exemption.
import { spawn } from 'node:child_process';
import { closeSync, openSync, readFileSync, writeSync } from 'node:fs';

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

// Optional full-output recording for the in-runner qualification caller:
// exclusive 0600 files hold every byte actually emitted, while the in-memory
// tails below stay exactly as before. An open/write/cap/close failure is
// reported in the summary so the caller can refuse success; the default
// pipe-only path is untouched.
function openRecorder(recording) {
  const limit = Number.isSafeInteger(recording?.maxBytes)
    ? recording.maxBytes
    : Number.POSITIVE_INFINITY;
  const state = { fds: {}, bytes: { stdout: 0, stderr: 0 }, failure: null };
  try {
    state.fds.stdout = openSync(recording.stdoutPath, 'wx', 0o600);
    state.fds.stderr = openSync(recording.stderrPath, 'wx', 0o600);
  } catch (error) {
    state.failure = 'recording-open-failed: ' + (error?.message ?? error);
  }
  return {
    openFailure: () => state.failure,
    write(stream, chunk) {
      if (state.fds[stream] === undefined || state.failure) return;
      if (state.bytes[stream] + chunk.length > limit) {
        state.failure = 'recording-cap-exceeded: ' + stream;
        return;
      }
      try {
        writeSync(state.fds[stream], chunk);
        state.bytes[stream] += chunk.length;
      } catch (error) {
        state.failure = 'recording-write-failed: ' + (error?.message ?? error);
      }
    },
    close() {
      for (const [stream, fd] of Object.entries(state.fds)) {
        try {
          closeSync(fd);
        } catch (error) {
          state.failure ??=
            'recording-close-failed: ' + (error?.message ?? error);
        }
      }
      return {
        stdoutPath: recording.stdoutPath,
        stderrPath: recording.stderrPath,
        stdoutBytes: state.bytes.stdout,
        stderrBytes: state.bytes.stderr,
        error: state.failure,
      };
    },
  };
}

export function runNativeProcess(
  binary,
  args,
  cwd,
  env,
  timeout = 60000,
  recording = null,
) {
  return new Promise((done) => {
    const recorder = recording ? openRecorder(recording) : null;
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
    if (recorder?.openFailure()) {
      // Nothing is spawned until both recording sinks exist under the
      // caller's exclusive files.
      done({
        code: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        diagnostics,
        recording: recorder.close(),
      });
      return;
    }
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
      recorder?.write('stdout', chunk);
      stdout = (stdout + chunk).slice(-1000000);
    });
    child.stderr.on('data', (chunk) => {
      diagnostics.firstStderrMs ??= elapsed();
      recorder?.write('stderr', chunk);
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
        ...(recorder ? { recording: recorder.close() } : {}),
      });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      diagnostics.durationMs = elapsed();
      diagnostics.closeSignal = signal;
      diagnostics.after = resources();
      done({
        code,
        stdout,
        stderr,
        timedOut,
        diagnostics,
        ...(recorder ? { recording: recorder.close() } : {}),
      });
    });
  });
}

// One recorder per scenario, including its correction and explicit resume.
export function recordNativeProcesses(binary) {
  const executions = [];
  return {
    executions,
    async run(args, cwd, env, timeout = 60000) {
      const result = await runNativeProcess(binary, args, cwd, env, timeout);
      executions.push({
        launch: executions.length + 1,
        code: result.code,
        timedOut: result.timedOut,
        ...result.diagnostics,
      });
      return result;
    },
  };
}

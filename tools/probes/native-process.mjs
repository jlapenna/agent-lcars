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
  const state = {
    fds: {},
    bytes: { stdout: 0, stderr: 0 },
    failure: null,
    summary: null,
  };
  try {
    state.fds.stdout = openSync(recording.stdoutPath, 'wx', 0o600);
    state.fds.stderr = openSync(recording.stderrPath, 'wx', 0o600);
  } catch (error) {
    state.failure = 'recording-open-failed: ' + (error?.message ?? error);
  }
  return {
    openFailure: () => state.failure,
    write(stream, chunk) {
      const fd = state.fds[stream];
      if (fd === undefined || state.failure) return;
      if (state.bytes[stream] + chunk.length > limit) {
        state.failure = 'recording-cap-exceeded: ' + stream;
        return;
      }
      // writeSync may accept only part of a chunk; a byte-count-blind loop
      // would silently drop the remainder while still counting it. Keep
      // writing from the advancing offset and refuse any stalled progress.
      let offset = 0;
      while (offset < chunk.length) {
        let written;
        try {
          written = writeSync(fd, chunk, offset);
        } catch (error) {
          state.failure =
            'recording-write-failed: ' + (error?.message ?? error);
          return;
        }
        if (!Number.isInteger(written) || written <= 0) {
          state.failure = 'recording-write-stalled: ' + stream;
          return;
        }
        offset += written;
        state.bytes[stream] += written;
      }
    },
    close() {
      // One settlement only: a spawn 'error' and a later 'close' both reach
      // here, so descriptors must not be closed twice.
      if (state.summary) return state.summary;
      for (const fd of Object.values(state.fds)) {
        try {
          closeSync(fd);
        } catch (error) {
          state.failure ??=
            'recording-close-failed: ' + (error?.message ?? error);
        }
      }
      state.fds = {};
      state.summary = {
        stdoutPath: recording.stdoutPath,
        stderrPath: recording.stderrPath,
        stdoutBytes: state.bytes.stdout,
        stderrBytes: state.bytes.stderr,
        error: state.failure,
      };
      return state.summary;
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
  return new Promise((resolve) => {
    // A spawn 'error' and a subsequent 'close' must settle exactly once so
    // the recording sink is closed a single time.
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
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

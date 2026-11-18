// What the claw launcher and its harness modules share: the failure that
// fails an attempt closed, and stopping a child's process group.

import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

/** A failure with a message safe to settle the attempt with. */
export class ClawFailure extends Error {}

/** Calls `onLine` with each line of `stream`, split on `\n` and nothing
 * else. Node's readline also splits on U+2028 and U+2029, which JSON leaves
 * unescaped inside a string, so it would cut a frame that carries one in
 * two. A line longer than `maxBytes` is never buffered whole: it is dropped
 * as it arrives and reported through `onOversize`, so the other end of the
 * stream cannot make this process hold more than that. A stream error ends
 * the reading and nothing else; the caller watches the stream's own events. */
export function readLines(stream, onLine, { maxBytes, onOversize } = {}) {
  const decoder = new TextDecoder('utf-8');
  let pending = [];
  let size = 0;
  let dropping = false;
  const flush = () => {
    const line = decoder.decode(Buffer.concat(pending, size));
    pending = [];
    size = 0;
    onLine(line.endsWith('\r') ? line.slice(0, -1) : line);
  };
  stream.on('data', (chunk) => {
    let rest = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    for (;;) {
      const newline = rest.indexOf(0x0a);
      const part = newline === -1 ? rest : rest.subarray(0, newline);
      if (
        !dropping &&
        maxBytes !== undefined &&
        size + part.length > maxBytes
      ) {
        dropping = true;
        pending = [];
        size = 0;
        onOversize?.();
      }
      if (!dropping && part.length > 0) {
        pending.push(part);
        size += part.length;
      }
      if (newline === -1) return;
      if (dropping) dropping = false;
      else flush();
      rest = rest.subarray(newline + 1);
    }
  });
  // What a stream that ends without a newline had begun is still a line.
  stream.on('end', () => {
    if (!dropping && size > 0) flush();
  });
}

/** Stops whatever still runs in a child's process group and waits until
 * nothing of it does: SIGTERM, then SIGKILL once the grace is over. The wait
 * is bounded, so a process that cannot be reaped does not hold the caller. A
 * leader can exit while a child of its own, with its own stdio, runs on. */
export async function endGroup(child, graceMs = 2_000) {
  if (typeof child.pid !== 'number') return;
  const signalGroup = (signal) => {
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch {
      // Nothing of the group is left.
      return false;
    }
  };
  const gone = async (withinMs) => {
    const until = Date.now() + withinMs;
    while (signalGroup(0)) {
      if (Date.now() >= until) return false;
      await new Promise((done) => setTimeout(done, 25));
    }
    return true;
  };
  if (!signalGroup('SIGTERM') || (await gone(graceMs))) return;
  signalGroup('SIGKILL');
  await gone(1_000);
}

/** Reads a settings file the agent's tools could have replaced, to check it
 * after the turn: only a regular file of at most `maxBytes`, and never for
 * longer than `timeoutMs`. Anything else (a missing file, a link, a pipe, a
 * device, a larger file, a read that does not return) is `undefined`, which
 * the caller treats as changed settings. The launcher still has an attempt
 * to settle, so this can neither block nor grow without bound. */
export async function readSettingsFile(path, { maxBytes, timeoutMs = 10_000 }) {
  const read = async () => {
    let handle;
    try {
      // Non-blocking, so opening a pipe returns instead of waiting for a
      // writer; no link is followed.
      handle = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const { size } = await handle.stat().then((stats) => {
        if (!stats.isFile()) throw new Error('not a regular file');
        return stats;
      });
      if (size > maxBytes) return undefined;
      const buffer = Buffer.alloc(size);
      let length = 0;
      while (length < size) {
        const { bytesRead } = await handle.read(
          buffer,
          length,
          size - length,
          length,
        );
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      return buffer.subarray(0, length);
    } catch {
      return undefined;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  };
  let timer;
  const expired = new Promise((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  try {
    return await Promise.race([read(), expired]);
  } finally {
    clearTimeout(timer);
  }
}

// Stops a child's whole process group: SIGTERM, then SIGKILL for whatever is
// still running after the grace period.
export function stopGroup(child, graceMs = 10_000) {
  const killTree = (killSignal) => {
    try {
      process.kill(-child.pid, killSignal);
    } catch {
      // The group already exited.
    }
  };
  killTree('SIGTERM');
  setTimeout(() => killTree('SIGKILL'), graceMs).unref();
}

// What the claw launcher and its harness modules share: the failure that
// fails an attempt closed, and stopping a child's process group.

import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

/** A failure with a message safe to settle the attempt with. */
export class ClawFailure extends Error {}

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

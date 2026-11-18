// What the claw launcher and its harness modules share: the failure that
// fails an attempt closed, and stopping a child's process group.

/** A failure with a message safe to settle the attempt with. */
export class ClawFailure extends Error {}

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

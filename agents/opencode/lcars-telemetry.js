/**
 * Reports this OpenCode session to Agent LCARS through the `lcars hook
 * opencode` client (docs/hooks-telemetry-design.md). On start, prompt, tool,
 * and idle events it hands the client an export-shaped snapshot of the session
 * (`{ info, messages }`, the shape `opencode export` writes), which the shared
 * OpenCode reducer turns into a summary-only event; message bodies never
 * leave this host. The snapshot is a private temp file that the detached
 * client deletes once it has read it, so a report survives OpenCode exiting
 * (an `opencode run` ends on its last idle); a sweep at startup removes any
 * snapshot an interrupted client left behind. session.deleted arrives after
 * OpenCode removed the session, so its SessionEnd is lifecycle-only (no
 * snapshot, no summary).
 *
 * Work happens off the session's critical path: every report is
 * fire-and-forget, writes are asynchronous, and any failure is swallowed.
 * OpenCode never awaits event handlers, so an `opencode run` can exit while
 * the idle report is still snapshotting; it does await `dispose`, which waits
 * (bounded) for reports in flight so the final Stop reaches the client.
 * Reports for one session never overlap (a report arriving mid-flight runs
 * once the current one finishes, keeping only the latest), tool reports are
 * throttled per session, and subagent sessions are never snapshotted. On a dispatched runner the plugin stays inert unless that runner
 * enabled hook telemetry (it exports LCARS_TELEMETRY_CREDENTIALS_FILE).
 *
 * LCARS_INTEGRATION_ID=opencode
 * LCARS_INTEGRATION_VERSION=1
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const TOOL_REPORT_INTERVAL_MS = 15000;
const SNAPSHOT_PREFIX = 'lcars-opencode-';
const STALE_SNAPSHOT_MS = 10 * 60 * 1000;
// Upper bound on how long shutdown waits for in-flight reports.
const DISPOSE_WAIT_MS = 5000;
// Lifecycle events outrank tool events when a report is queued behind one
// already in flight.
const PRIORITY = {
  PostToolUse: 0,
  UserPromptSubmit: 1,
  SessionStart: 1,
  Stop: 2,
  SessionEnd: 3,
};

function lcarsBinary() {
  const local = join(homedir(), '.local', 'bin', 'lcars');
  return existsSync(local) ? local : 'lcars';
}

/** Hands the payload to a detached client that outlives this process and
 *  owns (deletes) the snapshot. Resolves once stdin is written; false when
 *  the client could not be started. */
function runHook(payload) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(lcarsBinary(), ['hook', 'opencode'], {
        detached: true,
        stdio: ['pipe', 'ignore', 'ignore'],
      });
    } catch {
      resolve(false);
      return;
    }
    child.on('error', () => resolve(false));
    child.stdin.on('error', () => undefined);
    child.stdin.end(payload, () => {
      child.unref();
      resolve(true);
    });
  });
}

async function sweepStaleSnapshots() {
  const root = tmpdir();
  const cutoff = Date.now() - STALE_SNAPSHOT_MS;
  for (const name of await readdir(root)) {
    if (!name.startsWith(SNAPSHOT_PREFIX)) continue;
    const dir = join(root, name);
    try {
      if ((await stat(dir)).mtimeMs < cutoff) {
        await rm(dir, { recursive: true, force: true });
      }
    } catch {
      // Another process removed it, or it is not ours to remove.
    }
  }
}

export default async function lcarsTelemetry({ client, directory }) {
  if (
    process.env.LCARS_RUN_ID &&
    !process.env.LCARS_TELEMETRY_CREDENTIALS_FILE
  ) {
    return {};
  }
  sweepStaleSnapshots().catch(() => undefined);
  const lastToolReport = new Map();
  const reportedPrompts = new Set();
  const childSessions = new Set();
  const inFlight = new Set();
  const queued = new Map();
  // Running report() calls; dispose waits for them.
  const pending = new Set();
  // session.deleted fires after OpenCode removed the session and its
  // messages, so its end report is lifecycle-only, built from the event.
  const deletedInfo = new Map();

  async function snapshotAndReport(hookEventName, sessionID) {
    if (hookEventName === 'SessionEnd' && deletedInfo.has(sessionID)) {
      const info = deletedInfo.get(sessionID);
      deletedInfo.delete(sessionID);
      // No transcript: the client ships an end event without a summary.
      await runHook(
        JSON.stringify({
          hook_event_name: 'SessionEnd',
          session_id: sessionID,
          cwd: info?.directory ?? directory,
        }),
      ).catch(() => undefined);
      return;
    }
    let scratch;
    try {
      const session = await client.session.get({ path: { id: sessionID } });
      const info = session?.data;
      if (!info) return;
      if (info.parentID) {
        // The client skips subagents; do not pay for their history.
        childSessions.add(sessionID);
        return;
      }
      const messages = await client.session.messages({
        path: { id: sessionID },
      });
      const list = messages?.data;
      if (!Array.isArray(list)) return;
      scratch = await mkdtemp(join(tmpdir(), SNAPSHOT_PREFIX));
      const snapshot = join(scratch, 'export.json');
      await writeFile(snapshot, JSON.stringify({ info, messages: list }), {
        mode: 0o600,
      });
      const started = await runHook(
        JSON.stringify({
          hook_event_name: hookEventName,
          session_id: sessionID,
          cwd: info.directory ?? directory,
          transcript_path: snapshot,
        }),
      );
      if (started) scratch = undefined;
    } catch {
      // Telemetry must never disturb the session.
    } finally {
      if (scratch) {
        await rm(scratch, { recursive: true, force: true }).catch(
          () => undefined,
        );
      }
    }
  }

  async function report(hookEventName, sessionID) {
    if (typeof sessionID !== 'string' || sessionID.length === 0) return;
    if (childSessions.has(sessionID)) return;
    if (hookEventName === 'PostToolUse') {
      const now = Date.now();
      if (
        now - (lastToolReport.get(sessionID) ?? 0) <
        TOOL_REPORT_INTERVAL_MS
      ) {
        return;
      }
      lastToolReport.set(sessionID, now);
    }
    if (inFlight.has(sessionID)) {
      const pending = queued.get(sessionID);
      if (!pending || PRIORITY[hookEventName] >= PRIORITY[pending]) {
        queued.set(sessionID, hookEventName);
      }
      return;
    }
    inFlight.add(sessionID);
    try {
      let next = hookEventName;
      while (next) {
        queued.delete(sessionID);
        await snapshotAndReport(next, sessionID);
        next = queued.get(sessionID);
      }
    } finally {
      inFlight.delete(sessionID);
    }
  }

  function track(hookEventName, sessionID) {
    const running = report(hookEventName, sessionID).catch(() => undefined);
    pending.add(running);
    void running.finally(() => pending.delete(running));
  }

  return {
    dispose: async () => {
      let timer;
      await Promise.race([
        Promise.allSettled([...pending]),
        new Promise((resolve) => {
          timer = setTimeout(resolve, DISPOSE_WAIT_MS);
        }),
      ]);
      clearTimeout(timer);
    },
    event: async ({ event }) => {
      const properties = event?.properties ?? {};
      switch (event?.type) {
        case 'session.created':
          if (properties.info?.parentID) {
            childSessions.add(properties.info.id);
            return;
          }
          track('SessionStart', properties.info?.id ?? properties.sessionID);
          return;
        case 'message.updated': {
          const message = properties.info;
          if (message?.role === 'user' && !reportedPrompts.has(message.id)) {
            reportedPrompts.add(message.id);
            track('UserPromptSubmit', message.sessionID);
          }
          return;
        }
        case 'message.part.updated': {
          const part = properties.part;
          if (part?.type === 'tool' && part?.state?.status === 'completed') {
            track('PostToolUse', part.sessionID ?? properties.sessionID);
          }
          return;
        }
        case 'session.idle':
          track('Stop', properties.sessionID);
          return;
        case 'session.deleted': {
          const id = properties.info?.id ?? properties.sessionID;
          if (properties.info?.parentID) {
            childSessions.add(id);
            return;
          }
          if (typeof id === 'string') {
            deletedInfo.set(id, properties.info ?? {});
          }
          track('SessionEnd', id);
          return;
        }
        default:
          return;
      }
    },
  };
}

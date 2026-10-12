/**
 * Reports this OpenCode session to Agent LCARS through the `lcars hook
 * opencode` client (docs/hooks-telemetry-design.md). On lifecycle and tool
 * events it hands the client an export-shaped snapshot of the session
 * (`{ info, messages }`, the shape `opencode export` writes), which the shared
 * OpenCode reducer turns into a summary-only event; message bodies never
 * leave this host. The snapshot is a private temp file removed as soon as the
 * client has read it.
 *
 * Work happens off the session's critical path: every report is
 * fire-and-forget and any failure is swallowed. Tool reports are throttled per
 * session; subagent sessions are reported with their parent id so the client
 * skips them. On a dispatched runner the plugin stays inert unless that runner
 * enabled hook telemetry (it exports LCARS_TELEMETRY_CREDENTIALS_FILE).
 *
 * LCARS_INTEGRATION_ID=opencode
 * LCARS_INTEGRATION_VERSION=1
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const TOOL_REPORT_INTERVAL_MS = 15000;

function lcarsBinary() {
  const local = join(homedir(), '.local', 'bin', 'lcars');
  return existsSync(local) ? local : 'lcars';
}

function runHook(payload) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(lcarsBinary(), ['hook', 'opencode'], {
        stdio: ['pipe', 'ignore', 'ignore'],
      });
    } catch {
      resolve();
      return;
    }
    child.on('error', () => resolve());
    child.on('exit', () => resolve());
    child.stdin.on('error', () => undefined);
    child.stdin.end(payload);
  });
}

export default async function lcarsTelemetry({ client, directory }) {
  if (
    process.env.LCARS_RUN_ID &&
    !process.env.LCARS_TELEMETRY_CREDENTIALS_FILE
  ) {
    return {};
  }
  const lastToolReport = new Map();
  const reportedPrompts = new Set();

  async function report(hookEventName, sessionID) {
    if (typeof sessionID !== 'string' || sessionID.length === 0) return;
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
    let scratch;
    try {
      const [session, messages] = await Promise.all([
        client.session.get({ path: { id: sessionID } }),
        client.session.messages({ path: { id: sessionID } }),
      ]);
      const info = session?.data;
      const list = messages?.data;
      if (!info || !Array.isArray(list)) return;
      scratch = mkdtempSync(join(tmpdir(), 'lcars-opencode-'));
      const snapshot = join(scratch, 'export.json');
      writeFileSync(snapshot, JSON.stringify({ info, messages: list }), {
        mode: 0o600,
      });
      await runHook(
        JSON.stringify({
          hook_event_name: hookEventName,
          session_id: sessionID,
          cwd: info.directory ?? directory,
          transcript_path: snapshot,
          ...(info.parentID ? { agent_id: info.parentID } : {}),
        }),
      );
    } catch {
      // Telemetry must never disturb the session.
    } finally {
      if (scratch) rmSync(scratch, { recursive: true, force: true });
    }
  }

  return {
    event: async ({ event }) => {
      const properties = event?.properties ?? {};
      switch (event?.type) {
        case 'session.created':
          void report(
            'SessionStart',
            properties.info?.id ?? properties.sessionID,
          );
          return;
        case 'message.updated': {
          const message = properties.info;
          if (message?.role === 'user' && !reportedPrompts.has(message.id)) {
            reportedPrompts.add(message.id);
            void report('UserPromptSubmit', message.sessionID);
          }
          return;
        }
        case 'message.part.updated': {
          const part = properties.part;
          if (part?.type === 'tool' && part?.state?.status === 'completed') {
            void report('PostToolUse', part.sessionID ?? properties.sessionID);
          }
          return;
        }
        case 'session.idle':
          void report('Stop', properties.sessionID);
          return;
        case 'session.deleted':
          void report(
            'SessionEnd',
            properties.info?.id ?? properties.sessionID,
          );
          return;
        default:
          return;
      }
    },
  };
}

/**
 * OpenCode 2 entrypoint for the Agent LCARS hook telemetry plugin
 * (docs/hooks-telemetry-design.md). Pairs with `./v1.js` in the same folder
 * package so both OpenCode 1 and OpenCode 2 load one plugin definition.
 *
 * LCARS_INTEGRATION_ID=opencode
 * LCARS_INTEGRATION_VERSION=1
 */
import v1, {
  createTelemetryReporter,
  isTelemetryDisabledOnRunner,
} from './v1.js';

export default {
  id: 'lcars-telemetry',
  server: v1,
  async setup(ctx) {
    if (isTelemetryDisabledOnRunner()) {
      return undefined;
    }

    const startedSessions = new Set();
    const reportedPrompts = new Set();
    const fallbackDirectory = ctx.location?.directory;
    const { childSessions, deletedInfo, track, drain } =
      createTelemetryReporter({
        fallbackDirectory,
        loadSession: async (sessionID) => {
          const info = await ctx.session.get({ sessionID });
          if (!info) return undefined;
          if (info.parentID) return { info, messages: [] };
          const messages = await ctx.session.context({ sessionID });
          return { info, messages };
        },
      });

    function ensureStarted(sessionID) {
      if (
        typeof sessionID !== 'string' ||
        sessionID.length === 0 ||
        childSessions.has(sessionID) ||
        startedSessions.has(sessionID)
      ) {
        return;
      }
      startedSessions.add(sessionID);
      track('SessionStart', sessionID);
    }

    const ac = new AbortController();
    const handleEvent = (event) => {
      const data = event?.data ?? {};
      const sessionID = data.sessionID ?? data.info?.id ?? data.id;
      switch (event?.type) {
        case 'session.created': {
          const parentID = data.parentID ?? data.info?.parentID;
          if (parentID) {
            if (typeof sessionID === 'string') childSessions.add(sessionID);
            return;
          }
          ensureStarted(sessionID);
          return;
        }
        case 'session.execution.started':
          ensureStarted(sessionID);
          return;
        case 'session.inbox.delivered': {
          const promptKey = data.inboxID ?? `${sessionID}:prompt`;
          if (!reportedPrompts.has(promptKey)) {
            reportedPrompts.add(promptKey);
            ensureStarted(sessionID);
            track('UserPromptSubmit', sessionID);
          }
          return;
        }
        case 'session.tool.success':
          ensureStarted(sessionID);
          track('PostToolUse', sessionID);
          return;
        case 'session.idle':
        case 'session.execution.succeeded':
        case 'session.execution.failed':
        case 'session.execution.interrupted':
          ensureStarted(sessionID);
          track('Stop', sessionID);
          return;
        case 'session.deleted': {
          const parentID = data.parentID ?? data.info?.parentID;
          if (parentID) {
            if (typeof sessionID === 'string') childSessions.add(sessionID);
            return;
          }
          if (typeof sessionID === 'string') {
            deletedInfo.set(sessionID, data.info ?? data);
          }
          track('SessionEnd', sessionID);
          return;
        }
        default:
          return;
      }
    };

    let eventLoop;
    if (typeof ctx.event?.subscribe === 'function') {
      eventLoop = (async () => {
        try {
          for await (const event of ctx.event.subscribe({
            signal: ac.signal,
          })) {
            handleEvent(event);
          }
        } catch {
          // Subscription closed on abort/shutdown.
        }
      })();
    }

    return async () => {
      // Let queued microtasks on the event iterable deliver final execution
      // events before aborting the subscription and draining in-flight hooks.
      await Promise.resolve();
      await Promise.resolve();
      ac.abort();
      if (eventLoop) await eventLoop.catch(() => undefined);
      await drain();
    };
  },
};

import bridge from './worker-hook-bridge.cjs';
import session from './worker-session.cjs';

class IdentityRejection extends Error {}

function createSessionLookup(clientOrSession) {
  if (typeof clientOrSession?.session?.get === 'function') {
    return async (id, signal) => {
      const response = await clientOrSession.session.get({
        path: { id },
        signal,
      });
      if (!response || response.error || response.data?.id !== id) {
        throw new Error('Native session API response failed validation');
      }
      return response.data;
    };
  }
  if (typeof clientOrSession?.get === 'function') {
    return async (id, signal) => {
      const info = await clientOrSession.get({ sessionID: id }, { signal });
      if (!info || info.error || info.id !== id) {
        throw new Error('Native session API response failed validation');
      }
      return info;
    };
  }
  return async () => {
    throw new Error('Native session API is unavailable');
  };
}

// OpenCode exposes immutable parentID through the plugin's own SDK client (v1)
// or `ctx.session.get` domain (v2). Never accept ancestry supplied in a prompt
// or tool arguments.
export function sessionResolver(context, clientOrSession) {
  const descendants = new Map();
  const fetchSession = createSessionLookup(clientOrSession);
  return async (event) => {
    const rejected = session.rejection(event, context);
    if (!rejected) return event;
    const root = session.boundSession(context);
    if (
      context.provider !== 'opencode' ||
      !root ||
      typeof event.session_id !== 'string' ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(event.session_id ?? '')
    )
      throw new Error(rejected);
    const translated = () => ({
      ...event,
      native_session_id: event.session_id,
      session_id: root,
    });
    if (descendants.get(event.session_id) === root) return translated();
    const lookup = async () => {
      const controller = new AbortController();
      let timer;
      const expired = new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('Native lineage lookup timed out'));
        }, 2000);
      });
      try {
        let current = event.session_id;
        const visited = new Set();
        while (current !== root && visited.size < 32) {
          if (
            typeof current !== 'string' ||
            !/^[A-Za-z0-9_-]{1,128}$/.test(current) ||
            visited.has(current)
          )
            throw new IdentityRejection(rejected);
          visited.add(current);
          const info = await Promise.race([
            fetchSession(current, controller.signal),
            expired,
          ]);
          if (!info.parentID) throw new IdentityRejection(rejected);
          current = info.parentID;
        }
        if (current !== root || session.boundSession(context) !== root)
          throw new IdentityRejection(rejected);
        return visited;
      } finally {
        clearTimeout(timer);
        controller.abort();
      }
    };
    const accept = (visited) => {
      for (const id of visited) descendants.set(id, root);
      return translated();
    };
    try {
      return accept(await lookup());
    } catch (error) {
      if (error instanceof IdentityRejection) throw error;
    }
    const state = bridge.recoveryState();
    const infrastructureFailure = () =>
      new Error(
        (state?.failed() ?? bridge.failure()).hookSpecificOutput
          .permissionDecisionReason,
      );
    try {
      if (!state) throw new Error('No recovery binding');
      state.claim();
    } catch {
      throw infrastructureFailure();
    }
    try {
      const result = await lookup();
      state.succeeded();
      return accept(result);
    } catch (error) {
      if (error instanceof IdentityRejection) {
        // A valid native lookup that proves an unrelated session is a policy
        // denial, not another control failure. Never run the proposed action.
        try {
          state.succeeded();
        } catch {
          throw infrastructureFailure();
        }
        throw error;
      }
      throw infrastructureFailure();
    }
  };
}

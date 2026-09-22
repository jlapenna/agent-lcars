import session from './worker-session.cjs';

// OpenCode 1.18.25 exposes immutable parentID through the plugin's own SDK
// client. Never accept ancestry supplied in a prompt or tool arguments.
export function sessionResolver(context, client) {
  const descendants = new Map();
  return async (event) => {
    const rejected = session.rejection(event, context);
    if (!rejected) return event;
    const root = session.boundSession(context);
    if (
      context.provider !== 'opencode' ||
      !root ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(event.session_id ?? '')
    )
      throw new Error(rejected);
    const translated = () => ({
      ...event,
      native_session_id: event.session_id,
      session_id: root,
    });
    if (descendants.get(event.session_id) === root) return translated();
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
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(current) || visited.has(current))
          throw new Error('Invalid lineage');
        visited.add(current);
        const response = await Promise.race([
          client.session.get({
            path: { id: current },
            signal: controller.signal,
          }),
          expired,
        ]);
        if (
          response.error ||
          response.data?.id !== current ||
          !response.data.parentID
        )
          throw new Error('Unrelated native session');
        current = response.data.parentID;
      }
      if (current !== root || session.boundSession(context) !== root)
        throw new Error('Native root changed');
      for (const id of visited) descendants.set(id, root);
      return translated();
    } catch {
      throw new Error(rejected);
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  };
}

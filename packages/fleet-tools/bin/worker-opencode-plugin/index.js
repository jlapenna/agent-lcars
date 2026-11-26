import v1, { createBeforeToolEvaluator } from './v1.js';

export default {
  id: 'lcars-worker-policy',
  server: v1,
  async setup(ctx) {
    const evaluate = createBeforeToolEvaluator({
      directory: ctx.location?.directory,
      clientOrSession: ctx.session,
    });
    if (!evaluate) return undefined;
    await ctx.tool.hook('execute.before', async (hookEvent) => {
      const args =
        hookEvent.input && typeof hookEvent.input === 'object'
          ? hookEvent.input
          : {};
      await evaluate({
        sessionID: hookEvent.sessionID,
        tool: hookEvent.tool,
        args,
      });
      hookEvent.input = args;
    });
    return undefined;
  },
};

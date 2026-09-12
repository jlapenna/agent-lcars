/** Keep omitted read limits aligned with the fleet's focused-read policy. */
export default async function boundedRead() {
  return {
    'tool.execute.before': async ({ tool }, output) => {
      if (tool === 'read' && output.args.limit === undefined) {
        // Explicit ranges remain available when the agent needs more context.
        output.args.limit = 120;
      }
    },
  };
}

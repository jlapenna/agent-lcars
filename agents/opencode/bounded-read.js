const MAX_READ_LINES = 120;

/** Keep every read within the fleet's focused-read policy. */
export default async function boundedRead() {
  return {
    'tool.execute.before': async ({ tool }, output) => {
      if (tool !== 'read') {
        return;
      }

      const requestedLimit = output.args.limit;
      output.args.limit =
        typeof requestedLimit === 'number' &&
        Number.isFinite(requestedLimit) &&
        requestedLimit > 0
          ? Math.min(requestedLimit, MAX_READ_LINES)
          : MAX_READ_LINES;
    },
  };
}

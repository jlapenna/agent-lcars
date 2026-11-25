import * as os from 'node:os';

import { executeEventsAgentCommand } from './lib/events/events-agent-command';
import { serveMetrics } from './lib/events/metrics';

// `lcars-events-agent.cjs`: `lcars events agent`, the host's long-running
// event delivery agent. Its own bundle, so the Pub/Sub client never loads
// for the other `lcars` commands.
void (async () => {
  try {
    process.exitCode = await executeEventsAgentCommand(process.argv.slice(2), {
      env: process.env,
      home: os.homedir(),
      stdout: (text) => process.stdout.write(text),
      stderr: (text) => process.stderr.write(text),
      serveMetrics,
      stopSignal: () =>
        new Promise((resolve) => {
          process.once('SIGTERM', () => resolve());
          process.once('SIGINT', () => resolve());
        }),
    });
  } catch (error) {
    process.stderr.write(
      `lcars events agent: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
  // Pub/Sub's channels can hold the event loop open after close.
  process.exit();
})();

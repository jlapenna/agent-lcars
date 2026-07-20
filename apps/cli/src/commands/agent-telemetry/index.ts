import { CommandModule } from 'yargs';

import { reduceCommand } from './reduce';
import { upsertCommand } from './upsert';
import { upsertStubCommand } from './upsert-stub';

export const agentTelemetryCommand: CommandModule = {
  command: 'agent-telemetry <command>',
  describe: 'Agent telemetry transcript tools',
  builder: (yargs) => {
    return yargs
      .command(reduceCommand)
      .command(upsertCommand)
      .command(upsertStubCommand)
      .demandCommand(1, 'You must provide a subcommand.');
  },
  handler: async () => {
    // Parent command doesn't need a handler if demandCommand is used
  },
};

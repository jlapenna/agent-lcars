import { CommandModule } from 'yargs';

import { reduceCommand } from './reduce';

export const agentTelemetryCommand: CommandModule = {
  command: 'agent-telemetry <command>',
  describe: 'Agent telemetry transcript tools',
  builder: (yargs) => {
    return yargs
      .command(reduceCommand)
      .demandCommand(1, 'You must provide a subcommand.');
  },
  handler: async () => {
    // Parent command doesn't need a handler if demandCommand is used
  },
};

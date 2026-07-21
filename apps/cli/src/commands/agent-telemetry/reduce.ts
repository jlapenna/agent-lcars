import { reduceTranscript } from '@agent-lcars/telemetry';
import { logger } from '@repo/logging';
import * as fs from 'fs';
import type { CommandModule } from 'yargs';

export const reduceCommand: CommandModule = {
  command: 'reduce <transcript-file>',
  describe:
    'Reduce a Claude Code transcript (.jsonl) into a session summary and print it as JSON',
  builder: (yargs) =>
    yargs.positional('transcript-file', {
      type: 'string',
      describe: 'Path to a Claude Code transcript .jsonl file',
      demandOption: true,
    }),
  handler: (argv) => {
    const transcriptFile = argv['transcript-file'] as string;

    if (!fs.existsSync(transcriptFile)) {
      logger.error(`Transcript file not found: ${transcriptFile}`);
      process.exit(1);
    }

    const content = fs.readFileSync(transcriptFile, 'utf8');
    const summaries = reduceTranscript(content);

    console.log(
      JSON.stringify(
        summaries.length === 1 ? summaries[0] : summaries,
        null,
        2,
      ),
    );
  },
};

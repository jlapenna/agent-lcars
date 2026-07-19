import {
  buildSessionDoc,
  computeLiveness,
  reduceTranscript,
} from '@repo/agent-telemetry';
import { upsertSession } from '@repo/agent-telemetry/server';
import { logger } from '@repo/logging';
import * as fs from 'fs';
import type { ArgumentsCamelCase, CommandModule } from 'yargs';

interface UpsertArgs {
  'transcript-file': string;
  'run-id'?: string;
  'issue-number'?: number;
  'transcript-gcs-uri'?: string;
}

export const upsertCommand: CommandModule<unknown, UpsertArgs> = {
  command: 'upsert <transcript-file>',
  describe:
    'Reduce a Claude Code transcript (.jsonl) and upsert the resulting session doc into the agent-telemetry Firestore store',
  builder: (yargs) =>
    yargs
      .positional('transcript-file', {
        type: 'string',
        describe: 'Path to a Claude Code transcript .jsonl file',
        demandOption: true,
      })
      .option('run-id', {
        type: 'string',
        describe: 'Runner run id (issue-agent sessions only)',
      })
      .option('issue-number', {
        type: 'number',
        describe:
          'GitHub issue number the run was dispatched for (issue-agent sessions only)',
      })
      .option('transcript-gcs-uri', {
        type: 'string',
        describe:
          "gs:// URI of this run's archived transcript in the agent-session-transcripts bucket (issue-agent sessions only)",
      }),
  handler: async (argv: ArgumentsCamelCase<UpsertArgs>) => {
    const transcriptFile = argv['transcript-file'];

    if (!fs.existsSync(transcriptFile)) {
      logger.error(`Transcript file not found: ${transcriptFile}`);
      process.exit(1);
    }

    const content = fs.readFileSync(transcriptFile, 'utf8');
    const [summary] = reduceTranscript(content);

    if (!summary) {
      logger.error(`No session found in transcript: ${transcriptFile}`);
      process.exit(1);
    }

    // A manual CLI upsert isn't a live host-watcher heartbeat — it's a
    // one-off snapshot of a transcript that has already stopped growing.
    const liveness = computeLiveness({
      now: new Date().toISOString(),
      lastActivityAt: summary.lastActivityAt,
      processAlive: false,
      heartbeatReceived: true,
    });

    const doc = buildSessionDoc(summary, liveness, {
      runId: argv['run-id'],
      issueNumber: argv['issue-number'],
      transcriptGcsUri: argv['transcript-gcs-uri'],
    });

    await upsertSession(doc);

    logger.info(
      `Upserted session ${doc.sessionId} (${doc.source}, ${doc.liveness}) into agent-telemetry/sessions`,
    );
  },
};

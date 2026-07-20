import {
  buildSessionDoc,
  buildStubSummary,
  SESSION_AGENTS,
  SessionAgent,
} from '@repo/agent-telemetry';
import { upsertSession } from '@repo/agent-telemetry/server';
import { logger } from '@repo/logging';
import type { ArgumentsCamelCase, CommandModule } from 'yargs';

interface UpsertStubArgs {
  'session-id': string;
  agent: string;
  'run-id'?: string;
  'issue-number'?: number;
  title?: string;
  'started-at': string;
  'last-activity-at'?: string;
  'transcript-gcs-uri'?: string;
}

function isSessionAgent(value: string): value is SessionAgent {
  return (SESSION_AGENTS as readonly string[]).includes(value);
}

export const upsertStubCommand: CommandModule<unknown, UpsertStubArgs> = {
  command: 'upsert-stub',
  describe:
    'Upsert a minimal STUB session doc for an agent pipeline whose transcript format has no reducer yet (archive-first shipping, #3123 phase 2) — records identity + liveness only, pointing at a raw archive via --transcript-gcs-uri rather than a reduced transcript',
  builder: (yargs) =>
    yargs
      .option('session-id', {
        type: 'string',
        demandOption: true,
        describe: 'Session id to upsert at sessions/{session-id}',
      })
      .option('agent', {
        type: 'string',
        demandOption: true,
        choices: SESSION_AGENTS as unknown as string[],
        describe: 'Coding agent that produced the session',
      })
      .option('run-id', {
        type: 'string',
        describe: 'Runner run id',
      })
      .option('issue-number', {
        type: 'number',
        describe: 'GitHub issue number the run was dispatched for',
      })
      .option('title', {
        type: 'string',
        describe: 'Session title (e.g. the dispatching issue title)',
      })
      .option('started-at', {
        type: 'string',
        demandOption: true,
        describe: 'ISO timestamp the session started',
      })
      .option('last-activity-at', {
        type: 'string',
        describe: 'ISO timestamp of last activity (defaults to --started-at)',
      })
      .option('transcript-gcs-uri', {
        type: 'string',
        describe:
          "gs:// URI (or prefix, for a multi-file archive) of this run's archived session data",
      }),
  handler: async (argv: ArgumentsCamelCase<UpsertStubArgs>) => {
    const agentArg = argv.agent;
    if (!isSessionAgent(agentArg)) {
      logger.error(
        `Invalid --agent "${agentArg}" — must be one of: ${SESSION_AGENTS.join(', ')}`,
      );
      process.exit(1);
    }

    const startedAt = argv['started-at'];
    const lastActivityAt = argv['last-activity-at'] ?? startedAt;

    const summary = buildStubSummary({
      sessionId: argv['session-id'],
      agent: agentArg,
      startedAt,
      lastActivityAt,
      title: argv.title,
    });

    const doc = buildSessionDoc(summary, 'ended', {
      runId: argv['run-id'],
      issueNumber: argv['issue-number'],
      transcriptGcsUri: argv['transcript-gcs-uri'],
    });

    await upsertSession(doc);

    logger.info(
      `Upserted stub session ${doc.sessionId} (${doc.source}, agent=${agentArg}) into agent-telemetry/sessions`,
    );
  },
};

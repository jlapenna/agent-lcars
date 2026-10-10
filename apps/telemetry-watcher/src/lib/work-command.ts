import { execFile } from 'node:child_process';
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
} from 'node:fs';
import { parseArgs, promisify } from 'node:util';

import {
  fallbackPipelinesSchema,
  type ItemsContract,
  itemsContract,
  itemStateSchema,
  WORK_DESCRIPTION_MAX,
  workIdSchema,
  workReplyRequestIdSchema,
  workReplyTextSchema,
  workSpecSchema,
} from '@agent-lcars/work';
import { createORPCClient, ORPCError } from '@orpc/client';
import type { RouterContractClient } from '@orpc/contract';
import { OpenAPILink } from '@orpc/openapi/fetch';
import { ulid } from 'ulid';

export interface WorkCommandDeps {
  fetchImpl: typeof fetch;
  token: () => Promise<string>;
  origin: string;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

export const WORK_CLI_USAGE =
  'usage: work create --repo <owner/name> --pipeline <claude|codex|opencode> --title "<text>" (--description "<text>" | --description-file <path>) [--fallback-pipelines <ordered,csv|none>]\n' +
  '       work status <id> [--watch] | work list [--state <running|done|parked|failed|canceled>] [--repo <owner/name>] | work cancel <id> | work redispatch <id> [--fallback-pipelines <ordered,csv|none>]\n' +
  '       work reply <id> (--text "<text>" | --text-file <path>) [--pipeline <claude|codex|opencode>] [--request-id <key>] [--fresh]\n' +
  '       --watch polls every 15 seconds until done, parked, failed, or canceled.\n' +
  '       status exits 1 for failed work (with or without --watch); other states exit 0.';

const execFileAsync = promisify(execFile);

export function defaultWorkCommandDeps(
  env: NodeJS.ProcessEnv,
): WorkCommandDeps {
  return {
    fetchImpl: globalThis.fetch,
    origin: env['LCARS_URL'] ?? 'https://lcars.jlapenna.net',
    now: () => new Date(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
    token: async () => {
      if (env['LCARS_TOKEN']) return env['LCARS_TOKEN'];
      const sa = env['LCARS_SERVICE_ACCOUNT'];
      if (!sa) {
        throw new Error(
          'set LCARS_TOKEN, or LCARS_SERVICE_ACCOUNT for gcloud impersonation',
        );
      }
      const { stdout } = await execFileAsync('gcloud', [
        'auth',
        'print-identity-token',
        `--impersonate-service-account=${sa}`,
        `--audiences=${env['LCARS_AUDIENCE'] ?? 'agent-lcars-work'}`,
        '--include-email',
      ]);
      return stdout.trim();
    },
  };
}

function client(deps: WorkCommandDeps): RouterContractClient<ItemsContract> {
  const link = new OpenAPILink(itemsContract, {
    origin: deps.origin,
    url: '/api/work/v1',
    headers: async () => ({ authorization: `Bearer ${await deps.token()}` }),
    fetch: deps.fetchImpl,
  });
  return createORPCClient(link);
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  const value = argv[i + 1];
  // A missing value, or one that looks like the next flag, is not a value
  // this flag owns -- treat it as absent rather than swallowing the next
  // flag's own name as this one's argument.
  return value === undefined || value.startsWith('--') ? undefined : value;
}

const SETTLED = new Set(['done', 'parked', 'failed', 'canceled']);

interface ItemSummary {
  id: string;
  state: string;
  spec: { title: string; pipeline: string; target: { repo: string } };
}

function line(item: ItemSummary): string {
  return `${item.id}  ${item.state.padEnd(8)}  ${item.spec.pipeline.padEnd(8)}  ${item.spec.target.repo}  ${item.spec.title}`;
}

function readDescription(rest: string[]): string | undefined {
  const inline = flag(rest, '--description');
  if (inline !== undefined) return inline;
  const file = flag(rest, '--description-file');
  return file === undefined ? undefined : readFileSync(file, 'utf8');
}

/** Bound bytes before decoding and characters through the shared contract.
 * Nonblocking open plus a regular-file check also rejects FIFO input. */
function readReplyFile(file: string): string {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const maxBytes = WORK_DESCRIPTION_MAX * 4;
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error('--text-file must be a regular file');
    if (stat.size > maxBytes)
      throw new Error('reply file exceeds the size limit');
    const bytes = Buffer.alloc(maxBytes + 1);
    let used = 0;
    while (used < bytes.length) {
      const n = readSync(fd, bytes, used, bytes.length - used, null);
      if (n === 0) break;
      used += n;
    }
    if (used > maxBytes) throw new Error('reply file exceeds the size limit');
    return new TextDecoder('utf-8', { fatal: true }).decode(
      bytes.subarray(0, used),
    );
  } finally {
    closeSync(fd);
  }
}

/** Every "bad invocation" exit shares this shape: print usage to stderr --
 *  where CLI errors belong, not stdout -- and report it back in the result
 *  too, for a caller that wants to act on it without re-parsing output. */
function usageFailure(deps: WorkCommandDeps): { ok: false; usage: string } {
  deps.stderr(WORK_CLI_USAGE);
  return { ok: false, usage: WORK_CLI_USAGE };
}

export async function executeWorkCommand(
  argv: string[],
  deps: WorkCommandDeps,
): Promise<{ ok: boolean; usage?: string }> {
  const [sub, ...rest] = argv;
  const c = client(deps);
  try {
    switch (sub) {
      case 'reply': {
        const parsed = parseArgs({
          args: rest,
          allowPositionals: true,
          strict: true,
          tokens: true,
          options: {
            text: { type: 'string' },
            'text-file': { type: 'string' },
            pipeline: { type: 'string' },
            'request-id': { type: 'string' },
            fresh: { type: 'boolean' },
          },
        });
        const names = parsed.tokens
          .filter((t) => t.kind === 'option')
          .map((t) => t.name);
        const { values, positionals } = parsed;
        if (
          positionals.length !== 1 ||
          new Set(names).size !== names.length ||
          (values.text === undefined) === (values['text-file'] === undefined)
        ) {
          return usageFailure(deps);
        }
        const id = workIdSchema.parse(positionals[0]);
        const text = workReplyTextSchema.parse(
          values['text-file'] === undefined
            ? values.text
            : readReplyFile(values['text-file']),
        );
        const pipeline =
          values.pipeline === undefined
            ? undefined
            : workSpecSchema.shape.pipeline.parse(values.pipeline);
        const requestId = workReplyRequestIdSchema.parse(
          values['request-id'] ?? ulid(deps.now().getTime()),
        );
        // Print before sending: even a lost response leaves a usable retry key.
        deps.stderr(
          `reply request ${JSON.stringify(requestId)}; reuse --request-id with the same input to retry`,
        );
        const admitted = await c.reply({
          id,
          text,
          requestId,
          ...(pipeline === undefined ? {} : { pipeline }),
          ...(values.fresh ? { resume: false } : {}),
        });
        deps.stdout(
          `admitted ${admitted.admittedRunId}  ${admitted.resumed ? 'resume requested' : 'fresh session requested'}  request ${JSON.stringify(requestId)}`,
        );
        return { ok: true };
      }
      case 'create': {
        const repo = flag(rest, '--repo');
        const pipeline = flag(rest, '--pipeline');
        const title = flag(rest, '--title');
        const description = readDescription(rest);
        const fallback = flag(rest, '--fallback-pipelines');
        if (rest.includes('--fallback-pipelines') && fallback === undefined)
          return usageFailure(deps);
        const fallbackPipelines =
          fallback === undefined
            ? undefined
            : fallbackPipelinesSchema.parse(
                fallback === 'none' ? [] : fallback.split(','),
              );
        if (!repo || !pipeline || !title || !description) {
          return usageFailure(deps);
        }
        const id = ulid(deps.now().getTime());
        const created = await c.create({
          id,
          spec: {
            title,
            description,
            pipeline: pipeline as 'claude' | 'codex' | 'opencode',
            ...(fallbackPipelines === undefined ? {} : { fallbackPipelines }),
            target: { repo },
          },
        });
        deps.stdout(line(created));
        return { ok: true };
      }
      case 'status': {
        const id = rest[0];
        if (!id) return usageFailure(deps);
        let current = await c.get({ id });
        deps.stdout(line(current));
        if (rest.includes('--watch')) {
          while (!SETTLED.has(current.state)) {
            await deps.sleep(15_000);
            current = await c.get({ id });
            deps.stdout(line(current));
          }
        }
        return { ok: current.state !== 'failed' };
      }
      case 'list': {
        const rawState = flag(rest, '--state');
        const parsedState = itemStateSchema.safeParse(rawState);
        if (rest.includes('--state') && !parsedState.success) {
          return usageFailure(deps);
        }
        const state = parsedState.success ? parsedState.data : undefined;
        const repo = flag(rest, '--repo');
        const { items } = await c.list({
          ...(state ? { state } : {}),
          ...(repo ? { repo } : {}),
          limit: 50,
        });
        for (const found of items) deps.stdout(line(found));
        if (items.length === 0) deps.stdout('(no work items)');
        return { ok: true };
      }
      case 'cancel':
      case 'redispatch': {
        const id = rest[0];
        if (!id) return usageFailure(deps);
        const fallback = flag(rest, '--fallback-pipelines');
        if (rest.includes('--fallback-pipelines') && fallback === undefined)
          return usageFailure(deps);
        const fallbackPipelines =
          fallback === undefined
            ? undefined
            : fallbackPipelinesSchema.parse(
                fallback === 'none' ? [] : fallback.split(','),
              );
        const updated =
          sub === 'cancel'
            ? await c.cancel({ id })
            : await c.redispatch({
                id,
                ...(fallbackPipelines === undefined
                  ? {}
                  : { fallbackPipelines }),
              });
        deps.stdout(line(updated));
        return { ok: true };
      }
      default:
        return usageFailure(deps);
    }
  } catch (error) {
    deps.stderr(
      `error: ${error instanceof Error ? error.message : String(error)}`,
    );
    if (sub === 'reply' && error instanceof ORPCError) {
      if (error.code === 'UNAUTHORIZED' || error.code === 'FORBIDDEN') {
        deps.stderr(
          'check the bearer identity and its Work operator, repository and pipeline grants',
        );
      } else if (error.code === 'CONFLICT') {
        deps.stderr(
          'check work status; reuse the request key only for the same turn, and use a new key for changed input',
        );
      }
    }
    return { ok: false };
  }
}

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
  QUEUE_PRIORITIES,
  type QueuePriority,
} from '@agent-lcars/dispatch-contracts';
import {
  type AnchorOwner,
  fallbackPipelinesSchema,
  githubDispatchAnchorSchema,
  type ItemsContract,
  itemsContract,
  itemStateSchema,
  WORK_DESCRIPTION_MAX,
  workIdSchema,
  workReplyRequestIdSchema,
  workReplyTextSchema,
  workRepository,
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
  'usage: work create --repo <owner/name> --pipeline <claude|codex|opencode> [--priority <urgent|normal|background>] --title "<text>" (--description "<text>" | --description-file <path>) [--fallback-pipelines <ordered,csv|none>] [--deliverable report]\n' +
  '       work status <id> [--watch] | work list [--state <running|done|parked|failed|canceled>] [--repo <owner/name>] | work cancel <id> | work redispatch <id> [--fallback-pipelines <ordered,csv|none>]\n' +
  '       work reply <id> (--text "<text>" | --text-file <path>) [--pipeline <claude|codex|opencode>] [--request-id <key>] [--fresh]\n' +
  '       work job invoke --repo <owner/name> --name <recipe> --request-id <key> [--parameters <JSON>] | work job get <occurrence-id>\n' +
  '       work metrics [--json] (read-only lifecycle snapshot; rolling gauges, not counters)\n' +
  '       work owner <owner/repo>#<n> [--json] (read-only: who Console says is working a GitHub issue or PR)\n' +
  '       --watch polls every 15 seconds until done, parked, failed, or canceled.\n' +
  '       status exits 1 for failed work (with or without --watch); other states exit 0.\n' +
  '       owner exits 0 with any verdict (fleet-run, interactive-session, none); 1 when session telemetry was unavailable.';

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
  runs?: { delivery?: { state: string } }[];
  spec: {
    title: string;
    pipeline: string;
    priority?: QueuePriority;
    target?: { repo: string };
  };
}

function line(item: ItemSummary): string {
  const delivery = item.runs?.at(-1)?.delivery;
  const state =
    item.state === 'running' && delivery?.state === 'waiting'
      ? 'delivery:waiting'
      : item.state;
  return `${item.id}  ${state.padEnd(8)}  ${item.spec.pipeline.padEnd(8)}  ${workRepository(item.spec)}  ${item.spec.title}`;
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

/** `owner/repo#123` -> the Work API's GitHub anchor shape, or undefined. */
function parseAnchorRef(
  ref: string,
): { repo: string; issue: number } | undefined {
  const match = /^([^#\s]+)#(\d+)$/u.exec(ref);
  if (!match) return undefined;
  const parsed = githubDispatchAnchorSchema.safeParse({
    repo: match[1],
    issue: Number(match[2]),
  });
  return parsed.success ? parsed.data : undefined;
}

/** Human rendering of an anchor-owner answer: the verdict first, then the
 *  evidence it rests on, one fact per line. */
function ownerLines(owner: AnchorOwner): string[] {
  const lines = [
    `${owner.anchor.repo}#${owner.anchor.issue}  ${owner.verdict}${owner.complete ? '' : '  (incomplete)'}`,
  ];
  const { task } = owner;
  if (task === undefined) {
    lines.push('  task     none (Console has never dispatched this anchor)');
  } else {
    lines.push(
      `  task     ${task.state}  ${task.pipeline}  runs ${task.runCount}  updated ${task.updatedAt}`,
    );
    const { run } = task;
    if (run !== undefined) {
      const live = run.runId === task.activeRunId ? 'live' : 'last';
      const claimed =
        run.queue?.claimedBy === undefined
          ? ''
          : `  claimed by ${run.queue.claimedBy}`;
      const result =
        run.result === undefined
          ? ''
          : `  result ${run.result.ok ? 'ok' : 'not ok'}${run.result.summary === undefined ? '' : ` (${run.result.summary})`}`;
      lines.push(
        `  ${live} run ${run.runId}  ${run.state}  ${run.pipeline}${claimed}${result}${run.delivery === undefined ? '' : `  delivery ${run.delivery.state}`}  updated ${run.updatedAt}`,
      );
    }
    for (const session of task.runSessions) {
      lines.push(
        `  worker   ${session.sessionId}  last activity ${session.lastActivityAt}`,
      );
    }
  }
  for (const session of owner.cliSessions) {
    const where = [
      session.host,
      session.branch === undefined ? undefined : `branch ${session.branch}`,
      session.pr === undefined ? undefined : `PR #${session.pr.number}`,
    ]
      .filter((part) => part !== undefined)
      .join('  ');
    lines.push(
      `  session  ${session.sessionId}  ${session.liveness}  ${session.agent}${where === '' ? '' : `  ${where}`}  last activity ${session.lastActivityAt}`,
    );
  }
  if (owner.cliSessions.length === 0) {
    lines.push('  session  none referencing this anchor');
  }
  return lines;
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
      case 'job': {
        const { values, positionals } = parseArgs({
          args: rest,
          allowPositionals: true,
          options: {
            repo: { type: 'string' },
            name: { type: 'string' },
            'request-id': { type: 'string' },
            parameters: { type: 'string' },
          },
        });
        let path: string;
        let body: string | undefined;
        if (
          positionals[0] === 'invoke' &&
          positionals.length === 1 &&
          values.repo &&
          values.name &&
          values['request-id']
        ) {
          body = JSON.stringify({
            repository: values.repo,
            name: values.name,
            requestId: values['request-id'],
            parameters: JSON.parse(values.parameters ?? '{}'),
          });
          if (Buffer.byteLength(body) > 16384)
            throw new Error('Job request exceeds 16 KiB');
          path = '/invoke';
        } else if (
          positionals[0] === 'get' &&
          positionals.length === 2 &&
          /^[a-f0-9]{64}$/u.test(positionals[1] ?? '') &&
          !Object.keys(values).length
        ) {
          path = `/occurrences/${positionals[1]}`;
        } else return usageFailure(deps);
        const response = await deps.fetchImpl(
          `${deps.origin}/api/work/v1/jobs${path}`,
          {
            method: body === undefined ? 'GET' : 'POST',
            headers: {
              authorization: `Bearer ${await deps.token()}`,
              ...(body === undefined
                ? {}
                : { 'Content-Type': 'application/json' }),
            },
            ...(body === undefined ? {} : { body }),
            redirect: 'error',
            signal: AbortSignal.timeout(30000),
          },
        );
        if (!response.ok)
          throw new Error(`Recipe Work API HTTP ${response.status}`);
        const text = await response.text();
        if (Buffer.byteLength(text) > 524288)
          throw new Error('Job receipt exceeds 512 KiB');
        deps.stdout(JSON.stringify(JSON.parse(text)));
        return { ok: true };
      }
      case 'metrics': {
        if (rest.some((arg) => arg !== '--json') || rest.length > 1)
          return usageFailure(deps);
        const snapshot = await c.lifecycleMetrics(
          {},
          { signal: AbortSignal.timeout(15_000) },
        );
        deps.stdout(
          rest.includes('--json')
            ? JSON.stringify(snapshot)
            : snapshot.prometheus.trimEnd(),
        );
        if (!snapshot.complete)
          deps.stderr(
            'Lifecycle snapshot truncated; health/latency series suppressed.',
          );
        return { ok: snapshot.complete };
      }
      case 'owner': {
        const json = rest.includes('--json');
        const positionals = rest.filter((arg) => arg !== '--json');
        const anchor =
          positionals.length === 1 && rest.length - positionals.length <= 1
            ? parseAnchorRef(positionals[0] ?? '')
            : undefined;
        if (anchor === undefined) return usageFailure(deps);
        const owner = await c.anchorOwner(anchor, {
          signal: AbortSignal.timeout(15_000),
        });
        if (json) deps.stdout(JSON.stringify(owner));
        else for (const ownerLine of ownerLines(owner)) deps.stdout(ownerLine);
        for (const warning of owner.warnings)
          deps.stderr(`warning: ${warning}`);
        return { ok: owner.complete };
      }
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
        const priority = flag(rest, '--priority');
        if (
          rest.includes('--priority') &&
          !(QUEUE_PRIORITIES as readonly string[]).includes(priority ?? '')
        ) {
          return usageFailure(deps);
        }
        const deliverable = flag(rest, '--deliverable');
        if (rest.includes('--deliverable') && deliverable !== 'report')
          return usageFailure(deps);
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
            priority: (priority ?? 'normal') as QueuePriority,
            ...(fallbackPipelines === undefined ? {} : { fallbackPipelines }),
            ...(deliverable === undefined ? {} : { deliverable: 'report' }),
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

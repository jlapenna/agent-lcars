import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';

import { type ItemsContract, itemsContract } from '@agent-lcars/work';
import { createORPCClient } from '@orpc/client';
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
}

export const WORK_CLI_USAGE =
  'usage: work create --repo <owner/name> --pipeline <claude|codex|opencode> --title "<text>" (--description "<text>" | --description-file <path>)\n' +
  '       work status <id> [--watch] | work list [--state <s>] [--repo <owner/name>] | work cancel <id> | work redispatch <id>';

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
  return i === -1 ? undefined : argv[i + 1];
}

const SETTLED = new Set(['done', 'parked', 'canceled']);

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

export async function executeWorkCommand(
  argv: string[],
  deps: WorkCommandDeps,
): Promise<{ ok: boolean; usage?: string }> {
  const [sub, ...rest] = argv;
  const c = client(deps);
  try {
    switch (sub) {
      case 'create': {
        const repo = flag(rest, '--repo');
        const pipeline = flag(rest, '--pipeline');
        const title = flag(rest, '--title');
        const description = readDescription(rest);
        if (!repo || !pipeline || !title || !description) {
          return { ok: false, usage: WORK_CLI_USAGE };
        }
        const id = ulid(deps.now().getTime());
        const created = await c.create({
          id,
          spec: {
            title,
            description,
            pipeline: pipeline as 'claude' | 'codex' | 'opencode',
            target: { repo },
          },
        });
        deps.stdout(line(created));
        return { ok: true };
      }
      case 'status': {
        const id = rest[0];
        if (!id) return { ok: false, usage: WORK_CLI_USAGE };
        let current = await c.get({ id });
        deps.stdout(line(current));
        if (rest.includes('--watch')) {
          while (!SETTLED.has(current.state)) {
            await deps.sleep(15_000);
            current = await c.get({ id });
            deps.stdout(line(current));
          }
        }
        return { ok: true };
      }
      case 'list': {
        const state = flag(rest, '--state') as
          'running' | 'done' | 'parked' | 'canceled' | undefined;
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
        if (!id) return { ok: false, usage: WORK_CLI_USAGE };
        const updated =
          sub === 'cancel'
            ? await c.cancel({ id })
            : await c.redispatch({ id });
        deps.stdout(line(updated));
        return { ok: true };
      }
      default:
        return { ok: false, usage: WORK_CLI_USAGE };
    }
  } catch (error) {
    deps.stdout(
      `error: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { ok: false };
  }
}

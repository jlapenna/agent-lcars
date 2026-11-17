import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';

import { agentRunStatusSchema } from '@agent-lcars/work';

/**
 * `lcars investigate`: a dispatched worker asks a repository-owned claw agent
 * (by default Homelab's read-only investigator) for host facts, using its own
 * run token. It admits one round per `--request-id` for this run
 * (`POST /runs/{runId}/agents/{owner}/{repo}/{name}`), then waits for the
 * round to settle (`GET /runs/{runId}/agent-runs/{workId}`) and prints its
 * status, including the agent's report, as JSON. The agent's profile must opt
 * in to run callers (docs/repository-agents.md).
 */
const CONSOLE_ORIGIN = 'https://lcars.jlapenna.net';
const DEFAULT_AGENT = 'jlapenna/homelab/investigator';
/** An investigation is one agent Job: minutes, not seconds. */
const DEFAULT_TIMEOUT_SECONDS = 20 * 60;
const POLL_MS = 5_000;
const SETTLED = new Set(['done', 'failed', 'canceled', 'parked']);

export const INVESTIGATE_CLI_USAGE =
  'usage: investigate --request-id <key> (--question <text> | --question-file <path>) [--context <text> | --context-file <path>] [--agent <owner/repo/name>]';

export interface InvestigateCommandDeps {
  env: NodeJS.ProcessEnv;
  fetchImpl: typeof fetch;
  readFile: (path: string) => Promise<string>;
  monotonic: () => number;
  sleep: (ms: number) => Promise<void>;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

export function defaultInvestigateCommandDeps(
  env: NodeJS.ProcessEnv,
): InvestigateCommandDeps {
  return {
    env,
    fetchImpl: globalThis.fetch,
    readFile: (path) => readFile(path, 'utf8'),
    monotonic: () => performance.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
  };
}

class InvestigateError extends Error {}

export async function executeInvestigateCommand(
  argv: string[],
  deps: InvestigateCommandDeps,
): Promise<{ ok: boolean }> {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0]!)) {
    deps.stdout(INVESTIGATE_CLI_USAGE);
    return { ok: true };
  }
  try {
    const { values } = (() => {
      try {
        return parseArgs({
          args: argv,
          allowPositionals: false,
          strict: true,
          options: {
            'request-id': { type: 'string' },
            question: { type: 'string' },
            'question-file': { type: 'string' },
            context: { type: 'string' },
            'context-file': { type: 'string' },
            agent: { type: 'string' },
          },
        });
      } catch {
        throw new InvestigateError('invalid-input');
      }
    })();
    const requestId = values['request-id'];
    if (
      !requestId ||
      (values.question === undefined) ===
        (values['question-file'] === undefined) ||
      (values.context !== undefined && values['context-file'] !== undefined)
    )
      throw new InvestigateError('invalid-input');
    const question =
      values.question ?? (await deps.readFile(values['question-file']!));
    const context =
      values.context ??
      (values['context-file'] === undefined
        ? ''
        : await deps.readFile(values['context-file']));
    if (!question.trim()) throw new InvestigateError('invalid-input');
    const agent =
      values.agent ?? deps.env['LCARS_INVESTIGATE_AGENT'] ?? DEFAULT_AGENT;
    if (!/^[\w.-]+\/[\w.-]+\/[a-z][a-z0-9-]*$/u.test(agent))
      throw new InvestigateError('invalid-input');
    const runId = deps.env['LCARS_RUN_ID'];
    const token = deps.env['LCARS_RUN_TOKEN'];
    if (!runId || !token || /\s/u.test(token))
      throw new InvestigateError('invalid-input');
    const timeoutSeconds = Number(
      deps.env['LCARS_INVESTIGATE_TIMEOUT_SECONDS'] ?? DEFAULT_TIMEOUT_SECONDS,
    );
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0)
      throw new InvestigateError('invalid-input');
    const deadline = deps.monotonic() + timeoutSeconds * 1000;
    // Every wait and request is bounded by what remains of the deadline.
    const remaining = () => {
      const left = deadline - deps.monotonic();
      if (left <= 0) throw new InvestigateError('deadline-exceeded');
      return left;
    };
    const base = `${CONSOLE_ORIGIN}/api/work/v1/runs/${encodeURIComponent(runId)}`;
    const request = async (path: string, body?: unknown) => {
      const response = await deps.fetchImpl(`${base}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(Math.min(30_000, remaining())),
      });
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        throw new InvestigateError(
          response.status === 401
            ? 'unauthorized'
            : response.status === 403
              ? 'agent-forbidden'
              : response.status === 404
                ? 'agent-not-found'
                : response.status === 409
                  ? 'request-id-conflict'
                  : 'investigation-unavailable',
        );
      }
      const parsed = agentRunStatusSchema.safeParse(await response.json());
      if (!parsed.success) throw new InvestigateError('invalid-response');
      return parsed.data;
    };
    const message = context.trim()
      ? `${question}\n\nContext from the requesting run:\n${context}`
      : question;
    let status = await request(`/agents/${agent}`, { requestId, message });
    while (!SETTLED.has(status.state)) {
      await deps.sleep(Math.min(POLL_MS, remaining()));
      status = await request(
        `/agent-runs/${encodeURIComponent(status.workId)}`,
      );
    }
    remaining();
    const output = JSON.stringify(status);
    if (output.includes(token)) throw new InvestigateError('invalid-response');
    deps.stdout(output);
    return { ok: status.state === 'done' && status.ok === true };
  } catch (error) {
    deps.stderr(
      `investigate failed: ${
        error instanceof InvestigateError
          ? error.message
          : 'investigation-unavailable'
      }`,
    );
    return { ok: false };
  }
}

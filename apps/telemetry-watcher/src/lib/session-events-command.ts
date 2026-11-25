import { parseArgs } from 'node:util';

import {
  AGENT_EVENT_SOURCES,
  agentEventsContract,
  type AgentEventSource,
  agentEventSubscriptionIdSchema,
  type AgentEventSubscriptionView,
  renderAgentEventNotice,
  validateSubscriptionRequest,
} from '@agent-lcars/work';
import { createORPCClient, ORPCError } from '@orpc/client';
import type { RouterContractClient } from '@orpc/contract';
import { OpenAPILink } from '@orpc/openapi/fetch';

import {
  callEventsAgent,
  eventsSocketPath,
  type LocalCallResult,
  type LocalRequest,
  type LocalResponse,
} from './events/local-protocol';
import { resolveSessionId } from './session-id';

/**
 * `lcars session subscribe|subscriptions|unsubscribe` (#3538): a session
 * asks this host's delivery agent to route events to it. The agent forwards
 * the request to LCARS as the host's own identity, and LCARS accepts it only
 * for a session its telemetry reports live on that host.
 *
 * Inside a dispatched run (`LCARS_RUN_ID` and `LCARS_RUN_TOKEN` set, #3570)
 * there is no delivery agent: the command calls LCARS directly with the run
 * token, and the subscription belongs to the run's Work. A matching event
 * starts a new run of that Work with the notice as its input.
 */
export const SESSION_EVENT_SUBCOMMANDS = [
  'subscribe',
  'subscriptions',
  'unsubscribe',
] as const;

const KEY_FORMS: Record<AgentEventSource, string> = {
  'lcars:session': 'lcars:session:<session-id>',
  'lcars:work': 'lcars:work:<work-id>',
  'github:pr': 'github:pr:<owner>/<repo>#<number>',
  'github:issue': 'github:issue:<owner>/<repo>#<number>',
  'github:run': 'github:run:<owner>/<repo>/<run-id>',
  'outline:doc': 'outline:doc:<document-uuid>',
};

function sourceLines(): string[] {
  return (Object.keys(AGENT_EVENT_SOURCES) as AgentEventSource[]).map(
    (source) => {
      const definition = AGENT_EVENT_SOURCES[source];
      const ending =
        definition.terminal.length > 0
          ? `; ends on ${definition.terminal.join(', ')}`
          : '';
      return `  ${KEY_FORMS[source].padEnd(38)} ${definition.kinds.join(', ')}${ending}`;
    },
  );
}

function exampleNotice(): string {
  return renderAgentEventNotice(
    {
      id: 'example',
      key: 'github:pr:jlapenna/homelab#3827',
      kind: 'review',
      occurredAt: '2026-11-25T12:00:00.000Z',
      actor: 'jlapenna',
      link: 'https://github.com/jlapenna/homelab/pull/3827',
    },
    { id: '5f0c2a9e7b1d4c3a8e6f0b2d4c6a8e0f' },
    false,
  )
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
}

export function sessionEventsUsage(): string {
  return `Usage:
  lcars session subscribe <key> [--kinds <a,b>] [--until <kind>] [--json]
  lcars session subscriptions [--all] [--json]
  lcars session unsubscribe <id> [--json]

Routes events about <key> to this session. Notices are typed into this
terminal by this host's LCARS events agent when the session is idle at its
prompt, so do not poll or keep a process running to wait: end your turn and
the notice arrives as your next prompt. Only sessions running in a herdr-core
terminal can receive notices.

Keys and their kinds:
${sourceLines().join('\n')}

  --kinds a,b     only these kinds (default: every kind of the source)
  --until <kind>  end the subscription after the first event of this kind;
                  it must be one of --kinds when both are given. A
                  subscription also ends with this session, and after a kind
                  that ends its source (above).
  --all           subscriptions lists every session's on this host, not
                  only this session's
  --json          print the result as JSON

A notice looks like:
${exampleNotice()}

Subscribing again with the same key, kinds and --until returns the same
subscription. The session is the one named by LCARS_SESSION_ID,
CLAUDE_CODE_SESSION_ID, CODEX_THREAD_ID or ANTIGRAVITY_CONVERSATION_ID.

Inside a dispatched LCARS run (LCARS_RUN_ID and LCARS_RUN_TOKEN set), the
subscription belongs to the run's native Work instead: the run ends its turn
with a waiting deliverable (agent-protocol "Waiting on an event"), and a
matching event starts a new run of the Work with the notice as its input.
subscriptions and unsubscribe then see that Work's subscriptions.`;
}

export interface SessionEventsCommandDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  readonly call: (
    socketPath: string,
    request: LocalRequest,
  ) => Promise<LocalCallResult>;
  /** The Work API's fetch, for a dispatched run calling LCARS directly. */
  readonly fetch?: typeof fetch;
}

export function defaultSessionEventsCommandDeps(
  env: NodeJS.ProcessEnv,
): SessionEventsCommandDeps {
  return {
    env,
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
    call: (socketPath, request) => callEventsAgent(socketPath, request),
    fetch: globalThis.fetch,
  };
}

const DEFAULT_CONSOLE_ORIGIN = 'https://lcars.jlapenna.net';
/** A Work API call from a run must not hold the agent's turn for long. */
const RUN_CALL_TIMEOUT_MS = 30_000;

type AgentEventsClient = RouterContractClient<typeof agentEventsContract>;

/** The run a command acts for, when it runs inside a dispatched run. */
function dispatchedRun(
  env: NodeJS.ProcessEnv,
): { runId: string; token: string } | undefined {
  const runId = env['LCARS_RUN_ID'];
  const token = env['LCARS_RUN_TOKEN'];
  return runId && token ? { runId, token } : undefined;
}

const USAGE_EXIT = 2;

type Parsed =
  | {
      readonly command: 'subscribe';
      readonly key: string;
      readonly kinds?: string[];
      readonly until?: string;
      readonly json: boolean;
    }
  | {
      readonly command: 'subscriptions';
      readonly all: boolean;
      readonly json: boolean;
    }
  | {
      readonly command: 'unsubscribe';
      readonly id: string;
      readonly json: boolean;
    }
  | { readonly command: 'help' };

function parse(argv: readonly string[]): Parsed | { error: string } {
  const [command, ...rest] = argv;
  let values: Record<string, string | boolean | undefined>;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: [...rest],
      options: {
        kinds: { type: 'string' },
        until: { type: 'string' },
        all: { type: 'boolean' },
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: true,
      strict: true,
    }));
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  if (values['help']) return { command: 'help' };
  const json = values['json'] === true;
  const only = (allowed: readonly string[]) =>
    Object.keys(values).find((name) => !allowed.includes(name));
  switch (command) {
    case 'subscribe': {
      const extra = only(['kinds', 'until', 'json']);
      if (extra) return { error: `subscribe takes no --${extra}` };
      if (positionals.length !== 1) {
        return { error: 'subscribe takes exactly one <key>' };
      }
      const rawKinds = values['kinds'];
      const kinds =
        typeof rawKinds === 'string'
          ? rawKinds
              .split(',')
              .map((kind) => kind.trim())
              .filter((kind) => kind.length > 0)
          : undefined;
      if (kinds !== undefined && kinds.length === 0) {
        return { error: '--kinds needs at least one kind' };
      }
      const until = values['until'];
      return {
        command,
        key: positionals[0],
        ...(kinds && { kinds }),
        ...(typeof until === 'string' && { until }),
        json,
      };
    }
    case 'subscriptions': {
      const extra = only(['all', 'json']);
      if (extra) return { error: `subscriptions takes no --${extra}` };
      if (positionals.length > 0) {
        return { error: 'subscriptions takes no arguments' };
      }
      return { command, all: values['all'] === true, json };
    }
    case 'unsubscribe': {
      const extra = only(['json']);
      if (extra) return { error: `unsubscribe takes no --${extra}` };
      if (positionals.length !== 1) {
        return { error: 'unsubscribe takes exactly one subscription <id>' };
      }
      return { command, id: positionals[0], json };
    }
    default:
      return { error: `unknown command session ${command ?? ''}`.trim() };
  }
}

function subscriptionLine(subscription: AgentEventSubscriptionView): string {
  const parts = [subscription.id, subscription.key];
  parts.push(
    subscription.kinds ? `kinds=${subscription.kinds.join(',')}` : 'kinds=all',
  );
  if (subscription.until) parts.push(`until=${subscription.until}`);
  if (subscription.target.type === 'session') {
    parts.push(`session=${subscription.target.sessionId}`);
  } else {
    parts.push(`work=${subscription.target.workId}`);
  }
  parts.push(`since ${subscription.createdAt}`);
  return parts.join('  ');
}

function unreachable(
  result: Extract<LocalCallResult, { ok: false }>,
  socketPath: string,
): string {
  switch (result.reason) {
    case 'not-running':
      return `the LCARS events agent is not running on this host (nothing listens on ${socketPath}); it runs as the user service \`lcars events agent\``;
    case 'unsafe-socket':
      return `${socketPath} is not a socket owned by this user; refusing to send it a request`;
    case 'timeout':
      return 'the LCARS events agent did not answer in time; try again';
    case 'bad-response':
      return 'the LCARS events agent gave an answer this command does not understand; are the lcars CLI and the agent the same version?';
  }
}

function refused(response: Extract<LocalResponse, { ok: false }>): string {
  switch (response.error) {
    case 'not-configured':
      return 'the LCARS events agent on this host is not configured: it has no agent-events key (LCARS_EVENTS_CREDENTIALS_FILE, default ~/.config/agent-lcars/events-key.json)';
    case 'forbidden':
      return `${response.message}. LCARS routes events only to a session whose telemetry it has from this host; check that the lcars hook is installed for this runtime and the session has started a turn.`;
    default:
      return response.message;
  }
}

/** Runs one `session subscribe|subscriptions|unsubscribe`; resolves the exit
 * code: 0 done, 1 refused or unreachable, 2 usage. */
export async function executeSessionEventsCommand(
  argv: readonly string[],
  deps: SessionEventsCommandDeps,
): Promise<number> {
  const parsed = parse(argv);
  if ('error' in parsed) {
    deps.stderr(`lcars session: ${parsed.error}`);
    deps.stderr(sessionEventsUsage());
    return USAGE_EXIT;
  }
  if (parsed.command === 'help') {
    deps.stdout(sessionEventsUsage());
    return 0;
  }
  const fail = (message: string, code = 1) => {
    deps.stderr(`lcars session ${parsed.command}: ${message}`);
    return code;
  };

  const run = dispatchedRun(deps.env);
  if (run !== undefined) return executeForRun(parsed, run, deps, fail);

  let request: LocalRequest;
  if (parsed.command === 'unsubscribe') {
    request = { version: 1, op: 'unsubscribe', id: parsed.id };
  } else if (parsed.command === 'subscriptions' && parsed.all) {
    request = { version: 1, op: 'list' };
  } else {
    const session = resolveSessionId(deps.env);
    if (!session.ok) {
      return fail(
        session.reason === 'unset'
          ? 'no session id: run this from inside a Claude Code, Codex, OpenCode or Antigravity session, or set LCARS_SESSION_ID'
          : `${session.source} is not a valid session id`,
      );
    }
    if (parsed.command === 'subscriptions') {
      request = { version: 1, op: 'list', sessionId: session.sessionId };
    } else {
      const validated = validateSubscriptionRequest({
        key: parsed.key,
        ...(parsed.kinds && { kinds: parsed.kinds }),
        ...(parsed.until !== undefined && { until: parsed.until }),
      });
      if (!validated.ok) return fail(validated.error, USAGE_EXIT);
      request = {
        version: 1,
        op: 'subscribe',
        sessionId: session.sessionId,
        key: validated.value.key,
        ...(validated.value.kinds && { kinds: [...validated.value.kinds] }),
        ...(validated.value.until !== undefined && {
          until: validated.value.until,
        }),
      };
    }
  }
  if (
    request.op === 'unsubscribe' &&
    !agentEventSubscriptionIdSchema.safeParse(request.id).success
  ) {
    return fail(`${request.id} is not a subscription id`, USAGE_EXIT);
  }

  const socketPath = eventsSocketPath(deps.env);
  if (!socketPath) {
    return fail(
      'no runtime directory (XDG_RUNTIME_DIR) to find the LCARS events agent in; set LCARS_EVENTS_SOCKET',
    );
  }
  const result = await deps.call(socketPath, request);
  if (!result.ok) return fail(unreachable(result, socketPath));
  const { response } = result;
  if (!response.ok) return fail(refused(response));

  if ('subscription' in response) {
    const { subscription } = response;
    if (parsed.command === 'subscribe' && parsed.json) {
      deps.stdout(JSON.stringify(subscription));
    } else {
      deps.stdout(`Subscribed ${subscription.id} to ${subscription.key}`);
      deps.stdout(
        `  kinds ${subscription.kinds?.join(', ') ?? 'all'}${subscription.until ? `; ends after ${subscription.until}` : ''}`,
      );
      deps.stdout(
        '  Notices arrive in this terminal while this session is idle; end your turn to wait.',
      );
      deps.stdout(`  Stop with: lcars session unsubscribe ${subscription.id}`);
    }
    return 0;
  }
  if ('subscriptions' in response) {
    const { subscriptions } = response;
    if (parsed.command === 'subscriptions' && parsed.json) {
      deps.stdout(JSON.stringify({ subscriptions }));
    } else if (subscriptions.length === 0) {
      deps.stdout('No subscriptions.');
    } else {
      for (const subscription of subscriptions) {
        deps.stdout(subscriptionLine(subscription));
      }
    }
    return 0;
  }
  if (parsed.command === 'unsubscribe' && parsed.json) {
    deps.stdout(JSON.stringify({ id: response.deleted, deleted: true }));
  } else {
    deps.stdout(`Unsubscribed ${response.deleted}`);
  }
  return 0;
}

/** The run-token path (#3570): the Work API directly, no delivery agent. */
async function executeForRun(
  parsed: Exclude<Parsed, { command: 'help' }>,
  run: { runId: string; token: string },
  deps: SessionEventsCommandDeps,
  fail: (message: string, code?: number) => number,
): Promise<number> {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const client: AgentEventsClient = createORPCClient(
    new OpenAPILink(agentEventsContract, {
      origin:
        deps.env['LCARS_CONSOLE_URL'] ??
        deps.env['LCARS_URL'] ??
        DEFAULT_CONSOLE_ORIGIN,
      url: '/api/work/v1',
      headers: () => ({ authorization: `Bearer ${run.token}` }),
      fetch: fetchImpl,
    }),
  );
  const options = { signal: AbortSignal.timeout(RUN_CALL_TIMEOUT_MS) };
  try {
    switch (parsed.command) {
      case 'subscribe': {
        const validated = validateSubscriptionRequest({
          key: parsed.key,
          ...(parsed.kinds && { kinds: parsed.kinds }),
          ...(parsed.until !== undefined && { until: parsed.until }),
        });
        if (!validated.ok) return fail(validated.error, USAGE_EXIT);
        const subscription = await client.subscribe(
          {
            runId: run.runId,
            key: validated.value.key,
            ...(validated.value.kinds && {
              kinds: [...validated.value.kinds],
            }),
            ...(validated.value.until !== undefined && {
              until: validated.value.until,
            }),
          },
          options,
        );
        if (parsed.json) {
          deps.stdout(JSON.stringify(subscription));
          return 0;
        }
        const workId =
          subscription.target.type === 'work' ? subscription.target.workId : '';
        deps.stdout(
          `Subscribed ${subscription.id} to ${subscription.key} for Work ${workId}`,
        );
        deps.stdout(
          `  kinds ${subscription.kinds?.join(', ') ?? 'all'}${subscription.until ? `; ends after ${subscription.until}` : ''}`,
        );
        deps.stdout(
          '  A matching event starts a new run of this Work with the notice as its input. Do not wait for it: end your turn with the waiting deliverable the agent protocol describes.',
        );
        deps.stdout(
          `  Stop with: lcars session unsubscribe ${subscription.id}`,
        );
        return 0;
      }
      case 'subscriptions': {
        if (parsed.all)
          return fail(
            '--all lists a host’s sessions; a dispatched run lists its own Work’s subscriptions',
            USAGE_EXIT,
          );
        const { subscriptions } = await client.list(
          { runId: run.runId },
          options,
        );
        if (parsed.json) deps.stdout(JSON.stringify({ subscriptions }));
        else if (subscriptions.length === 0) deps.stdout('No subscriptions.');
        else for (const s of subscriptions) deps.stdout(subscriptionLine(s));
        return 0;
      }
      case 'unsubscribe': {
        if (!agentEventSubscriptionIdSchema.safeParse(parsed.id).success)
          return fail(`${parsed.id} is not a subscription id`, USAGE_EXIT);
        const removed = await client.unsubscribe(
          { id: parsed.id, runId: run.runId },
          options,
        );
        if (parsed.json) deps.stdout(JSON.stringify(removed));
        else deps.stdout(`Unsubscribed ${removed.id}`);
        return 0;
      }
    }
  } catch (error) {
    if (error instanceof ORPCError)
      return fail(
        error.code === 'UNAUTHORIZED'
          ? `LCARS refused this run's token (${error.message}); the run may have ended or its lease expired`
          : error.message,
      );
    return fail(
      `could not reach LCARS: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

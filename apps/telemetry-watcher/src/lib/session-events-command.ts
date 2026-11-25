import { parseArgs } from 'node:util';

import {
  AGENT_EVENT_SOURCES,
  type AgentEventSource,
  agentEventSubscriptionIdSchema,
  type AgentEventSubscriptionView,
  renderAgentEventNotice,
  validateSubscriptionRequest,
} from '@agent-lcars/work';

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
CLAUDE_CODE_SESSION_ID, CODEX_THREAD_ID or ANTIGRAVITY_CONVERSATION_ID.`;
}

export interface SessionEventsCommandDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  readonly call: (
    socketPath: string,
    request: LocalRequest,
  ) => Promise<LocalCallResult>;
}

export function defaultSessionEventsCommandDeps(
  env: NodeJS.ProcessEnv,
): SessionEventsCommandDeps {
  return {
    env,
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
    call: (socketPath, request) => callEventsAgent(socketPath, request),
  };
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

import {
  BlockAction,
  Context as BoltContext,
  GlobalShortcut,
  InteractiveAction,
  MessageShortcut,
  NextFn,
  SlashCommand,
} from '@slack/bolt';
import type { NextFunction, Request, Response } from 'express';

import { RequestContext } from './context-types';

export * from './context-types';

let runWithContextImpl = <T>(_context: RequestContext, callback: () => T): T =>
  callback();
let getContextImpl = (): RequestContext | undefined => undefined;
let traceMiddlewareImpl = (_req: Request, _res: Response, next: NextFunction) =>
  next();
let getTraceIdImpl = (): string | Promise<string | undefined> | undefined =>
  undefined;

/**
 * Injects the implementation for request context and tracing.
 * This is used to provide Node.js specific implementations (like AsyncLocalStorage)
 * without pulling them into client-side bundles.
 */
export function injectLoggingContext(
  run: typeof runWithContextImpl,
  get: typeof getContextImpl,
  middleware: typeof traceMiddlewareImpl,
  getTraceId: typeof getTraceIdImpl,
) {
  runWithContextImpl = run;
  getContextImpl = get;
  traceMiddlewareImpl = middleware;
  getTraceIdImpl = getTraceId;
}

export function runWithContext<T>(
  context: RequestContext,
  callback: () => T,
): T {
  return runWithContextImpl(context, callback);
}

export function getContext(): RequestContext | undefined {
  return getContextImpl();
}

export function bindExpressContext(
  req: Request,
  _res: Response,
  next: NextFunction,
) {
  runWithContext({ path: req.path }, next);
}

interface BoltMiddlewareArgs {
  context: BoltContext;
  body: unknown;
  next: NextFn;
}

// Define missing types or simplified versions for our logic
interface SlackEvent {
  type: string;
  user?: string | { id: string };
}

interface ViewSubmission {
  type: 'view_submission';
  view?: {
    callback_id: string;
  };
  user: {
    id: string;
  };
}

type SlackBody =
  | SlashCommand
  | { event: SlackEvent }
  | BlockAction
  | ViewSubmission
  | InteractiveAction
  | GlobalShortcut
  | MessageShortcut;

function isSlashCommand(body: SlackBody): body is SlashCommand {
  return typeof body === 'object' && body !== null && 'command' in body;
}

function isEvent(body: SlackBody): body is { event: SlackEvent } {
  return typeof body === 'object' && body !== null && 'event' in body;
}

function isBlockAction(body: SlackBody): body is BlockAction {
  return (
    typeof body === 'object' &&
    body !== null &&
    'type' in body &&
    body.type === 'block_actions' &&
    'actions' in body &&
    Array.isArray((body as { actions: unknown[] }).actions)
  );
}

function isViewSubmission(body: SlackBody): body is ViewSubmission {
  return (
    typeof body === 'object' &&
    body !== null &&
    'type' in body &&
    body.type === 'view_submission'
  );
}

export async function bindBoltContext(args: BoltMiddlewareArgs) {
  const { context: boltContext, body, next } = args;
  const slackBody = body as SlackBody;

  let slackUserId = boltContext.botUserId || boltContext.userToken;

  // Extract User ID from Body if not in context
  if (!slackUserId) {
    if (isSlashCommand(slackBody)) {
      slackUserId = slackBody.user_id;
    } else if (
      isEvent(slackBody) &&
      slackBody.event &&
      'user' in slackBody.event
    ) {
      const eventUser = slackBody.event.user;
      if (typeof eventUser === 'string') {
        slackUserId = eventUser;
      } else if (
        typeof eventUser === 'object' &&
        eventUser !== null &&
        'id' in eventUser
      ) {
        slackUserId = (eventUser as { id: string }).id;
      }
    } else if (
      'user' in slackBody &&
      slackBody.user &&
      typeof slackBody.user === 'object' &&
      'id' in slackBody.user
    ) {
      slackUserId = (slackBody.user as { id: string }).id;
    }
  }

  let action: string | undefined;

  if (isSlashCommand(slackBody)) {
    action = slackBody.command;
  } else if (isEvent(slackBody)) {
    action = slackBody.event.type;
  } else if (isBlockAction(slackBody) && slackBody.actions?.[0]) {
    action = slackBody.actions[0].action_id;
  } else if (isViewSubmission(slackBody)) {
    action = slackBody.view?.callback_id;
  } else if ('type' in slackBody) {
    action = slackBody.type;
  }

  const existingContext = getContext();
  if (existingContext) {
    existingContext.slackUserId = slackUserId;
    if (action) existingContext.action = action;
    await next();
  } else {
    await runWithContext({ slackUserId, action }, next);
  }
}

export const traceMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  return traceMiddlewareImpl(req, res, next);
};

export function getTraceId(): string | Promise<string | undefined> | undefined {
  return getTraceIdImpl();
}

import {
  type QuickTaskEvidenceId,
  quickTaskEvidenceMarkdown,
} from './quick-task-evidence-contract';
import type { RepositoryRef } from './watched-repo';

const QUICK_TASK_TITLE_MAX_LENGTH = 80;

export interface QuickTaskSourceContext {
  /** A relative, allowlisted console route. Never an origin or raw URL. */
  route: string;
  /** Human-readable canonical identities, one per line. */
  identities: string;
  capturedAt: string;
  deployment?: string;
}

export interface QuickTaskIssueDraft {
  description: string;
  /** A link to an already-hosted screenshot, video, or other evidence. */
  screenshot: string;
  source: QuickTaskSourceContext;
}

export interface QuickTaskSourceIdentity {
  label: 'Task' | 'Pull request' | 'Run' | 'Session';
  value: string;
}

// Issue titles show up in list views and the run-name banner. Keep the first
// line scannable while deriving it from the exact same body the server sees.
export function deriveQuickTaskTitle(description: string): string {
  const firstLine = description.split('\n', 1)[0].replace(/\s+/g, ' ').trim();
  if (firstLine.length <= QUICK_TASK_TITLE_MAX_LENGTH) return firstLine;
  return `${firstLine.slice(0, QUICK_TASK_TITLE_MAX_LENGTH - 1).trimEnd()}…`;
}

function knownConsolePath(pathname: string): boolean {
  return (
    pathname === '/' ||
    /^\/(?:agents|costs|inbox|sessions)$/u.test(pathname) ||
    /^\/sessions\/[A-Za-z0-9._:-]{1,200}$/u.test(pathname) ||
    /^\/task\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/[1-9][0-9]*$/u.test(pathname)
  );
}

const REPOSITORY_VALUE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const ITEM_VALUE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9][0-9]*$/u;
const POSITIVE_INTEGER_VALUE = /^[1-9][0-9]{0,9}$/u;
const QUEUE_REASON_VALUES = new Set([
  'needs-human',
  'review-requested',
  'ready-for-agent',
  'run-failed',
  'merge-blocked',
  'silent-error',
]);

function keepTypedQueryValue(
  pathname: string,
  key: string,
  value: string,
): boolean {
  if (key === 'repo') return REPOSITORY_VALUE.test(value);
  if (pathname === '/inbox') {
    if (key === 'item') return ITEM_VALUE.test(value);
    if (key === 'reason') return QUEUE_REASON_VALUES.has(value);
    if (key === 'sort') return ['newest', 'oldest'].includes(value);
  }
  if (pathname === '/sessions' || pathname === '/costs') {
    if (key === 'days' || key === 'issue') {
      return POSITIVE_INTEGER_VALUE.test(value);
    }
    if (key === 'source') return value === 'cli' || value === 'issue-agent';
    if (pathname === '/sessions' && key === 'view') {
      return value === 'flat' || value === 'by-issue';
    }
  }
  return false;
}

/**
 * Reduce a browser location to a non-sensitive, relative console route.
 *
 * The path itself must match a route the console owns. Query state is kept
 * only when both its key and its value shape are explicitly known. This is
 * intentionally not a denylist: a new parameter is private until this
 * function deliberately learns how to serialize it.
 */
export function sanitizeQuickTaskSourceRoute(
  input:
    | string
    | {
        pathname: string;
        search: string;
      },
): string {
  let url: URL;
  try {
    url =
      typeof input === 'string'
        ? new URL(input, 'https://console.invalid')
        : new URL(
            `${input.pathname}${input.search}`,
            'https://console.invalid',
          );
  } catch {
    return '';
  }

  if (!knownConsolePath(url.pathname)) return '';

  const safe = new URLSearchParams();
  for (const [key, value] of url.searchParams) {
    if (keepTypedQueryValue(url.pathname, key, value)) safe.append(key, value);
  }
  const query = safe.toString();
  return query ? `${url.pathname}?${query}` : url.pathname;
}

export function captureQuickTaskSource(
  location: { pathname: string; search: string },
  identities: QuickTaskSourceIdentity[] = [],
  now = new Date(),
): QuickTaskSourceContext {
  return {
    route: sanitizeQuickTaskSourceRoute(location),
    identities: identities
      .map(({ label, value }) => `${label}: ${value.trim()}`)
      .join('\n'),
    capturedAt: now.toISOString(),
  };
}

function markdownSection(heading: string, value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed ? `## ${heading}\n${trimmed}` : undefined;
}

function safeCapturedAt(value: string): string | undefined {
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp)
    ? undefined
    : new Date(timestamp).toISOString();
}

/** Compose the exact human-readable issue body sent through the Server Action. */
export function composeQuickTaskIssueBody(
  draft: QuickTaskIssueDraft,
  repository: RepositoryRef,
): string {
  const description = draft.description.trim();
  const screenshotSection = markdownSection('Screenshot', draft.screenshot);

  const route = sanitizeQuickTaskSourceRoute(draft.source.route);
  const identities = draft.source.identities
    .split('\n')
    .map((identity) => identity.trim())
    .filter(Boolean);
  const capturedAt = safeCapturedAt(draft.source.capturedAt);
  const deployment = draft.source.deployment?.trim();
  const sourceLines = [
    `- Repository: \`${repository.owner}/${repository.name}\``,
    ...(route ? [`- Console route: \`${route}\``] : []),
    ...identities.map((identity) => `- ${identity}`),
    ...(capturedAt ? [`- Captured: ${capturedAt}`] : []),
    ...(deployment ? [`- Console deployment: \`${deployment}\``] : []),
  ];

  return [
    description,
    screenshotSection,
    `## Source context\n\n${sourceLines.join('\n')}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Server-side evidence attachment helper for the future multipart route.
 * The browser never supplies this Markdown or its trusted origin.
 */
export function composeQuickTaskEvidenceIssueBody(
  draft: Omit<QuickTaskIssueDraft, 'screenshot'>,
  repository: RepositoryRef,
  trustedOrigin: string,
  evidenceId: QuickTaskEvidenceId,
): string {
  return composeQuickTaskIssueBody(
    {
      ...draft,
      screenshot: quickTaskEvidenceMarkdown(trustedOrigin, evidenceId),
    },
    repository,
  );
}

/** Advisory only: deliberate terse tasks remain submittable. */
export function lowInformationQuickTaskGuidance(
  description: string,
): string | undefined {
  const title = deriveQuickTaskTitle(description).replace(/[.:!?]+$/u, '');
  if (
    /^(?:please\s+)?(?:fix|help|update|check|look)(?:\s+(?:this|it))?$/iu.test(
      title,
    )
  ) {
    return 'Consider naming the failing behavior in the first line so the agent can identify the intended problem.';
  }
  if (title && title.length < 10) {
    return 'This will create a very terse issue title; add a little more context if the task is not self-evident.';
  }
  return undefined;
}

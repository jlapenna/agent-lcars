import crypto from 'node:crypto';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

import {
  DISPATCH_LABELS,
  WEBHOOK_INGRESS_CANARY_MARKER,
  WEBHOOK_INGRESS_CANARY_OIDC_AUDIENCE,
  WEBHOOK_INGRESS_CANARY_TITLE,
  WEBHOOK_INGRESS_PROBE_URL,
} from '@agent-lcars/dispatch-contracts';

const API_VERSION = '2022-11-28';
const POLL_INTERVAL_MS = 2_000;
const TIMELINE_TIMEOUT_MS = 60_000;
const DELIVERY_TIMEOUT_MS = 90_000;
const AUTHORITY_TIMEOUT_MS = 180_000;

interface GitHubIssue {
  number: number;
  title: string;
  body?: string | null;
  state: 'open' | 'closed';
  updated_at: string;
  labels?: Array<string | { name?: string }>;
  pull_request?: unknown;
}

interface TimelineEvent {
  id?: number;
  event?: string;
  created_at?: string;
}

interface AppDeliverySummary {
  id: number;
  guid: string;
  delivered_at: string;
  event: string;
  action?: string;
  repository_id?: number;
  status_code?: number;
}

interface AppDeliveryDetail extends AppDeliverySummary {
  request?: {
    payload?: {
      action?: string;
      issue?: { number?: number; updated_at?: string };
      repository?: { id?: number; full_name?: string };
    };
  };
  response?: { payload?: unknown };
}

interface ProbeResult {
  stage: string;
  controllerRevision?: number;
  processorAttempt?: number;
}

export class WebhookIngressCanaryError extends Error {
  constructor(
    public readonly category: string,
    message: string,
  ) {
    super(message);
    this.name = 'WebhookIngressCanaryError';
  }
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function output(name: string, value: string | number): void {
  const outputFile = required('GITHUB_OUTPUT');
  const safe = String(value)
    .replace(/[\r\n]+/gu, ' ')
    .slice(0, 1_000);
  fs.appendFileSync(outputFile, `${name}=${safe}\n`, { encoding: 'utf8' });
}

function base64url(value: string): string {
  return Buffer.from(value).toString('base64url');
}

export function createAppJwt(
  clientId: string,
  privateKey: string,
  now = Date.now(),
): string {
  const issuedAt = Math.floor(now / 1_000) - 60;
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(
    JSON.stringify({ iss: clientId, iat: issuedAt, exp: issuedAt + 600 }),
  );
  const signingInput = `${header}.${payload}`;
  const signature = crypto.sign(
    'RSA-SHA256',
    Buffer.from(signingInput),
    privateKey,
  );
  return `${signingInput}.${signature.toString('base64url')}`;
}

async function requestJson<T>(
  url: string,
  token: string,
  options: RequestInit = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set('Accept', 'application/vnd.github+json');
  headers.set('Authorization', `Bearer ${token}`);
  headers.set('X-GitHub-Api-Version', API_VERSION);
  if (options.body) headers.set('Content-Type', 'application/json');
  const response = await fetch(url, {
    ...options,
    headers,
  });
  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status} ${options.method ?? 'GET'} ${new URL(url).pathname}: ${await response.text()}`,
    );
  }
  return (await response.json()) as T;
}

function api(path: string): string {
  return `https://api.github.com${path}`;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export function assertSentinelSafe(issue: GitHubIssue): void {
  if (
    issue.title !== WEBHOOK_INGRESS_CANARY_TITLE ||
    !issue.body?.includes(WEBHOOK_INGRESS_CANARY_MARKER)
  ) {
    throw new WebhookIngressCanaryError(
      'sentinel_identity_mismatch',
      `Issue #${issue.number} does not match the canonical sentinel identity`,
    );
  }
  const labels = (issue.labels ?? []).map((label) =>
    typeof label === 'string' ? label : label.name,
  );
  const dispatchLabels = new Set<string>(DISPATCH_LABELS);
  const dispatchLabel = labels.find((label): label is string =>
    Boolean(label && dispatchLabels.has(label)),
  );
  if (dispatchLabel) {
    throw new WebhookIngressCanaryError(
      'sentinel_dispatch_label',
      `Sentinel #${issue.number} carries forbidden dispatch label ${dispatchLabel}`,
    );
  }
}

async function findOrCreateSentinel(
  repository: string,
  githubToken: string,
): Promise<GitHubIssue> {
  const matches: GitHubIssue[] = [];
  for (let page = 1; ; page += 1) {
    const issues = await requestJson<GitHubIssue[]>(
      api(`/repos/${repository}/issues?state=all&per_page=100&page=${page}`),
      githubToken,
    );
    matches.push(
      ...issues.filter(
        (issue) =>
          !issue.pull_request &&
          issue.title === WEBHOOK_INGRESS_CANARY_TITLE &&
          issue.body?.includes(WEBHOOK_INGRESS_CANARY_MARKER),
      ),
    );
    if (issues.length < 100) break;
  }
  if (matches.length > 1) {
    throw new WebhookIngressCanaryError(
      'duplicate_sentinel',
      `Found ${matches.length} webhook ingress sentinel issues`,
    );
  }
  const issue =
    matches[0] ??
    (await requestJson<GitHubIssue>(
      api(`/repos/${repository}/issues`),
      githubToken,
      {
        method: 'POST',
        body: JSON.stringify({
          title: WEBHOOK_INGRESS_CANARY_TITLE,
          body:
            `${WEBHOOK_INGRESS_CANARY_MARKER}\n\n` +
            'Dedicated model-free sentinel for the real GitHub App webhook ingress path. ' +
            'This issue must never carry an agent:* or review:* label. Scheduled probes ' +
            'alternate close/reopen and require the exact timeline event, App delivery, ' +
            'Cloud Tasks receipt, and authoritative controller observation.',
        }),
      },
    ));
  assertSentinelSafe(issue);
  return issue;
}

async function listTimeline(
  repository: string,
  issue: number,
  githubToken: string,
): Promise<TimelineEvent[]> {
  return requestJson<TimelineEvent[]>(
    api(`/repos/${repository}/issues/${issue}/timeline?per_page=100`),
    githubToken,
  );
}

async function pollTimelineEvent(
  repository: string,
  issue: number,
  action: 'closed' | 'reopened',
  baseline: Set<number>,
  startedAt: number,
  githubToken: string,
): Promise<TimelineEvent> {
  const deadline = Date.now() + TIMELINE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const timeline = await listTimeline(repository, issue, githubToken);
    const match = timeline
      .filter(
        (event) =>
          Number.isSafeInteger(event.id) &&
          !baseline.has(event.id as number) &&
          event.event === action &&
          Date.parse(event.created_at ?? '') >= startedAt - 10_000,
      )
      .sort((left, right) => Number(right.id) - Number(left.id))[0];
    if (match) return match;
    await sleep(POLL_INTERVAL_MS);
  }
  throw new WebhookIngressCanaryError(
    'timeline_event_missing',
    `GitHub did not expose the sentinel ${action} timeline event within ${TIMELINE_TIMEOUT_MS / 1_000}s`,
  );
}

export function deliveryMatchesProbe(
  delivery: AppDeliveryDetail,
  repository: string,
  repositoryId: number,
  issue: number,
  action: 'closed' | 'reopened',
  updatedAt: string,
): boolean {
  const payload = delivery.request?.payload;
  return (
    delivery.event === 'issues' &&
    delivery.action === action &&
    delivery.repository_id === repositoryId &&
    payload?.action === action &&
    payload.repository?.id === repositoryId &&
    payload.repository.full_name === repository &&
    payload.issue?.number === issue &&
    payload.issue.updated_at === updatedAt
  );
}

async function pollAppDelivery(
  appToken: string,
  repository: string,
  repositoryId: number,
  issue: number,
  action: 'closed' | 'reopened',
  updatedAt: string,
  startedAt: number,
): Promise<AppDeliveryDetail> {
  const deadline = Date.now() + DELIVERY_TIMEOUT_MS;
  const inspected = new Set<number>();
  while (Date.now() < deadline) {
    const summaries = await requestJson<AppDeliverySummary[]>(
      api('/app/hook/deliveries?per_page=100'),
      appToken,
    );
    const candidates = summaries.filter(
      (delivery) =>
        !inspected.has(delivery.id) &&
        delivery.event === 'issues' &&
        delivery.action === action &&
        delivery.repository_id === repositoryId &&
        Date.parse(delivery.delivered_at) >= startedAt - 10_000,
    );
    for (const candidate of candidates) {
      inspected.add(candidate.id);
      const detail = await requestJson<AppDeliveryDetail>(
        api(`/app/hook/deliveries/${candidate.id}`),
        appToken,
      );
      if (
        deliveryMatchesProbe(
          detail,
          repository,
          repositoryId,
          issue,
          action,
          updatedAt,
        )
      ) {
        return detail;
      }
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new WebhookIngressCanaryError(
    'no_delivery',
    `No matching GitHub App delivery appeared within ${DELIVERY_TIMEOUT_MS / 1_000}s`,
  );
}

export function classifyDeliveryFailure(
  delivery: AppDeliveryDetail,
): WebhookIngressCanaryError | undefined {
  const status = delivery.status_code ?? 0;
  if (status >= 200 && status <= 299) return undefined;
  const response = JSON.stringify(delivery.response?.payload ?? '');
  const category = response.includes('Hosted admission enqueue failed')
    ? 'enqueue_failure'
    : status === 401
      ? 'delivery_hmac_rejected'
      : 'delivery_rejected';
  return new WebhookIngressCanaryError(
    category,
    `GitHub delivery ${delivery.guid} received HTTP ${status} from the public ingress`,
  );
}

async function actionsOidcToken(audience: string): Promise<string> {
  const requestUrl = required('ACTIONS_ID_TOKEN_REQUEST_URL');
  const separator = requestUrl.includes('?') ? '&' : '?';
  const response = await fetch(
    `${requestUrl}${separator}audience=${encodeURIComponent(audience)}`,
    {
      headers: {
        Authorization: `Bearer ${required('ACTIONS_ID_TOKEN_REQUEST_TOKEN')}`,
      },
    },
  );
  if (!response.ok) {
    throw new Error(
      `GitHub Actions OIDC request failed with HTTP ${response.status}`,
    );
  }
  const token = (await response.json()) as { value?: string };
  if (!token.value)
    throw new Error('GitHub Actions OIDC response omitted value');
  return token.value;
}

async function pollAuthority(
  token: string,
  delivery: AppDeliveryDetail,
  issue: number,
  action: 'closed' | 'reopened',
  sourceId: string,
): Promise<ProbeResult> {
  const deadline = Date.now() + AUTHORITY_TIMEOUT_MS;
  let last: ProbeResult = { stage: 'awaiting-receipt' };
  while (Date.now() < deadline) {
    try {
      const response = await fetch(WEBHOOK_INGRESS_PROBE_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          deliveryId: delivery.guid,
          issue,
          action,
          sourceId,
        }),
      });
      if (response.ok) {
        last = (await response.json()) as ProbeResult;
        console.log(
          `::notice::webhook ingress probe stage=${last.stage} ` +
            `attempt=${last.processorAttempt ?? 'unknown'} ` +
            `controllerRevision=${last.controllerRevision ?? 'missing'}`,
        );
        if (last.stage === 'success') return last;
      } else {
        console.log(
          `::warning::webhook ingress authority probe returned HTTP ${response.status}`,
        );
      }
    } catch (error) {
      console.log(
        `::warning::webhook ingress authority probe request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    await sleep(POLL_INTERVAL_MS);
  }
  const category =
    last.stage === 'repeated-processor-failure'
      ? 'repeated_processor_failure'
      : last.stage === 'processor-failed'
        ? 'processor_failure'
        : 'missing_durable_observation';
  throw new WebhookIngressCanaryError(
    category,
    `Exact event-originated authority evidence did not appear within ${AUTHORITY_TIMEOUT_MS / 1_000}s (last stage: ${last.stage})`,
  );
}

export async function runWebhookIngressCanary(): Promise<void> {
  const repository = required('GITHUB_REPOSITORY');
  const repositoryId = Number(required('GITHUB_REPOSITORY_ID'));
  if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0) {
    throw new Error('GITHUB_REPOSITORY_ID is invalid');
  }
  const githubToken = required('GITHUB_TOKEN');
  const appToken = createAppJwt(
    required('APP_CLIENT_ID'),
    required('APP_PRIVATE_KEY'),
  );
  const sentinel = await findOrCreateSentinel(repository, githubToken);
  output('issue', sentinel.number);
  const baseline = new Set(
    (await listTimeline(repository, sentinel.number, githubToken))
      .map((event) => event.id)
      .filter((id): id is number => Number.isSafeInteger(id)),
  );
  const action = sentinel.state === 'open' ? 'closed' : 'reopened';
  const targetState = action === 'closed' ? 'closed' : 'open';
  const startedAt = Date.now();
  const mutated = await requestJson<GitHubIssue>(
    api(`/repos/${repository}/issues/${sentinel.number}`),
    githubToken,
    {
      method: 'PATCH',
      body: JSON.stringify({ state: targetState }),
    },
  );
  const timeline = await pollTimelineEvent(
    repository,
    sentinel.number,
    action,
    baseline,
    startedAt,
    githubToken,
  );
  const sourceId = `timeline:${timeline.id}`;
  const delivery = await pollAppDelivery(
    appToken,
    repository,
    repositoryId,
    sentinel.number,
    action,
    mutated.updated_at,
    startedAt,
  );
  const deliveryFailure = classifyDeliveryFailure(delivery);
  if (deliveryFailure) throw deliveryFailure;
  const authority = await pollAuthority(
    await actionsOidcToken(WEBHOOK_INGRESS_CANARY_OIDC_AUDIENCE),
    delivery,
    sentinel.number,
    action,
    sourceId,
  );
  console.log(
    `Webhook ingress verified for #${sentinel.number}: action=${action} ` +
      `source=${sourceId} delivery=${delivery.guid} ` +
      `controllerRevision=${authority.controllerRevision}.`,
  );
}

async function main(): Promise<void> {
  try {
    await runWebhookIngressCanary();
    output('failure-category', '');
    output('failure-detail', '');
  } catch (error) {
    const category =
      error instanceof WebhookIngressCanaryError
        ? error.category
        : 'canary_internal_error';
    const message = error instanceof Error ? error.message : String(error);
    output('failure-category', category);
    output('failure-detail', message);
    console.error(`::error title=Webhook ingress ${category}::${message}`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

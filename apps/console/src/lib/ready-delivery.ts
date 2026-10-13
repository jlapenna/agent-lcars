import 'server-only';

import {
  formatAttemptId,
  parseRunGeneration,
} from '@agent-lcars/dispatch-contracts';
import type {
  DeliveryBinding,
  DeliveryObservation,
  Run,
  Task,
} from '@agent-lcars/orchestrator';
import { workPayloadSchema } from '@agent-lcars/work';
import { z } from 'zod';

import { isControlPlaneRepository } from './deployment';
import type { DispatchTokenProvider } from './github-app-tokens';
import { grantForPrincipal, resolvePrincipal, workGrants } from './work-grants';
import { currentFallbackPipelines } from './work-provider-fallback';

export interface DeliveryGithubDeps {
  tokens: DispatchTokenProvider;
  fetchImpl?: typeof fetch;
  githubApiBaseUrl?: string;
}

const sha = z.string().regex(/^[a-f0-9]{40}$/u);
const checkRunSchema = z.object({
  id: z.number().int().positive().optional(),
  check_suite: z.object({ id: z.number().int().positive() }).optional(),
  app: z
    .object({
      id: z.number().int().positive(),
      slug: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  name: z.string(),
  head_sha: sha,
  status: z.string(),
  conclusion: z.string().nullable(),
});
const prSchema = z.object({
  number: z.number().int().positive(),
  body: z.string().nullable(),
  state: z.enum(['open', 'closed']),
  draft: z.boolean(),
  head: z.object({ sha }),
  base: z.object({ ref: z.string() }),
  user: z.object({ login: z.string() }),
  merged: z.boolean(),
  merge_commit_sha: sha.nullable(),
  auto_merge: z.object({ merge_method: z.string() }).nullable(),
});

async function github(deps: DeliveryGithubDeps, repo: string, path: string) {
  const token = await deps.tokens.tokenFor(repo);
  const response = await (deps.fetchImpl ?? fetch)(
    `${deps.githubApiBaseUrl ?? 'https://api.github.com'}/repos/${repo}/${path}`,
    {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
      },
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!response.ok)
    throw new Error(`Delivery read refused (${response.status})`);
  return response.json() as Promise<unknown>;
}

async function protectedChecks(
  deps: DeliveryGithubDeps,
  repo: string,
  base: string,
) {
  const rulesSchema = z
    .array(z.object({ type: z.string(), parameters: z.unknown().optional() }))
    .max(100);
  const rules: z.infer<typeof rulesSchema> = [];
  for (let page = 1; page <= 10; page++) {
    const batch = rulesSchema.parse(
      await github(
        deps,
        repo,
        `rules/branches/${encodeURIComponent(base)}?per_page=100&page=${page}`,
      ),
    );
    rules.push(...batch);
    if (batch.length === 100) continue;
    const checkRules = rules.filter(
      (rule) => rule.type === 'required_status_checks',
    );
    if (
      !rules.some((rule) => rule.type === 'pull_request') ||
      checkRules.length === 0
    )
      throw new Error('Protected delivery policy could not be established');
    const required = checkRules.flatMap(
      (rule) =>
        z
          .object({
            required_status_checks: z.array(
              z.object({
                context: z.string(),
                integration_id: z
                  .number()
                  .int()
                  .nonnegative()
                  .nullable()
                  .optional(),
              }),
            ),
          })
          .parse(rule.parameters).required_status_checks,
    );
    if (required.length === 0)
      throw new Error('Protected delivery policy could not be established');
    return [
      ...new Map(
        required.map((check) => [
          JSON.stringify([check.context, check.integration_id ?? 0]),
          check,
        ]),
      ).values(),
    ];
  }
  throw new Error('Protected delivery policy read was truncated');
}

async function reviews(
  deps: DeliveryGithubDeps,
  repo: string,
  number: number,
  head: string,
) {
  // Complete bounded reads only: truncation and field errors retain ownership.
  const token = await deps.tokens.tokenFor(repo);
  const [owner, name] = repo.split('/');
  const response = await (deps.fetchImpl ?? fetch)(
    `${deps.githubApiBaseUrl ?? 'https://api.github.com'}/graphql`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({
        query: `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){headRefOid reviews(last:100){pageInfo{hasPreviousPage} nodes{state author{login} commit{oid}}} reviewThreads(first:100){pageInfo{hasNextPage} nodes{isResolved}}}}}`,
        variables: { owner, name, number },
      }),
    },
  );
  if (!response.ok) throw new Error('Delivery review read refused');
  const data = z
    .object({
      errors: z.array(z.unknown()).optional(),
      data: z.object({
        repository: z.object({
          pullRequest: z.object({
            headRefOid: sha,
            reviews: z.object({
              pageInfo: z.object({ hasPreviousPage: z.literal(false) }),
              nodes: z.array(
                z.object({
                  state: z.string(),
                  author: z.object({ login: z.string() }),
                  commit: z.object({ oid: sha }),
                }),
              ),
            }),
            reviewThreads: z.object({
              pageInfo: z.object({ hasNextPage: z.literal(false) }),
              nodes: z.array(z.object({ isResolved: z.boolean() })),
            }),
          }),
        }),
      }),
    })
    .parse(await response.json());
  if (
    data.errors?.length ||
    data.data.repository.pullRequest.headRefOid !== head
  )
    throw new Error('Delivery revision or review evidence changed');
  const pr = data.data.repository.pullRequest;
  const latest = new Map(
    pr.reviews.nodes
      .filter(
        (review) =>
          review.commit.oid === head &&
          ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state),
      )
      .map((review) => [review.author.login, review]),
  );
  return {
    approvals: pr.reviews.nodes.filter(
      (review) =>
        review.commit.oid === head &&
        ['APPROVED', 'COMMENTED'].includes(review.state) &&
        !['DISMISSED', 'CHANGES_REQUESTED'].includes(
          latest.get(review.author.login)?.state ?? '',
        ),
    ),
    changesRequested: [...latest.values()].some(
      (review) => review.state === 'CHANGES_REQUESTED',
    ),
    unresolved: pr.reviewThreads.nodes.some((thread) => !thread.isResolved),
  };
}

function hasIndependentReview(
  review: Awaited<ReturnType<typeof reviews>>,
  author: string,
): boolean {
  return (
    !review.unresolved &&
    !review.changesRequested &&
    review.approvals.some(
      (approval) =>
        approval.author.login.toLowerCase() !== author.toLowerCase(),
    )
  );
}

/** A successful PR artifact is not a completion verdict. This exact server
 * read establishes the narrow ready handoff before authenticated settlement. */
export async function readyDeliveryBinding(
  deps: DeliveryGithubDeps,
  input: {
    run: Run;
    task: Task;
    repo: string;
    number: number;
    now: string;
  },
): Promise<DeliveryBinding> {
  const { run, task, repo, number, now } = input;
  const pr = prSchema.parse(await github(deps, repo, `pulls/${number}`));
  const generation = parseRunGeneration(run.runId);
  if (generation === undefined) throw new Error('Delivery generation invalid');
  const attempt = formatAttemptId({ generation, intentId: run.runId });
  if (
    pr.number !== number ||
    (!pr.merged && pr.state !== 'open') ||
    pr.draft ||
    !pr.body?.includes(`<!-- attempt-claim:${attempt} -->`) ||
    (!pr.merged && pr.auto_merge?.merge_method !== 'squash')
  )
    throw new Error('Deliverable is not ready and armed');
  await protectedChecks(deps, repo, pr.base.ref);
  const review = await reviews(deps, repo, number, pr.head.sha);
  if (!hasIndependentReview(review, pr.user.login))
    throw new Error('Deliverable requires exact-head independent review');
  const payload = workPayloadSchema.parse(task.work);
  if (payload.spec.target.repo !== repo)
    throw new Error('Delivery target changed');
  const final = prSchema.parse(await github(deps, repo, `pulls/${number}`));
  if (
    final.head.sha !== pr.head.sha ||
    final.base.ref !== pr.base.ref ||
    final.merged !== pr.merged ||
    (!final.merged && final.state !== 'open') ||
    final.draft ||
    (!final.merged && final.auto_merge?.merge_method !== 'squash') ||
    final.body !== pr.body
  )
    throw new Error('Ready delivery changed during verification');
  const binding: DeliveryBinding = {
    runId: run.runId,
    repo,
    number,
    baseRef: pr.base.ref,
    head: pr.head.sha,
    state: 'waiting',
    runtimeGate: payload.spec.deliveryRuntime ?? 'unknown',
    observedAt: now,
  };
  if (pr.merged) {
    const landed = await observeGithubDelivery(deps, binding);
    if (landed.kind !== 'protected-merge')
      throw new Error('Protected landing not established');
    return {
      ...binding,
      mergeCommit: landed.mergeCommit,
      state: binding.runtimeGate === 'none' ? 'complete' : 'runtime-required',
    };
  }
  return binding;
}

/** Accepted label intent survives later refusals and temporary execution
 * fallback. Historical Run.pipeline never establishes durable provider intent. */
function deliveryIntentPipeline(task: Task): string | undefined {
  const payload = workPayloadSchema.safeParse(task.work);
  if (!payload.success) return undefined;
  return (
    task.providerRouting?.acceptedGeneration?.pipeline ??
    task.providerRouting?.effectivePipeline ??
    payload.data.spec.pipeline
  );
}

interface GithubIntakePermission {
  runId: string;
  head: string;
  repo: string;
  principal: string;
  pipeline: string;
  observedAt: number;
  intentRunId?: string;
}

/** The webhook intake class is distinct from Work API grants. Current metadata
 * permission plus its original provider intent authorize only that same class. */
export async function readGithubIntakePermission(
  deps: DeliveryGithubDeps,
  task: Task,
  run: Run,
): Promise<GithubIntakePermission | undefined> {
  const payload = workPayloadSchema.safeParse(task.work);
  if (
    !payload.success ||
    payload.data.origin.channel !== 'github' ||
    task.delivery === undefined ||
    deliveryIntentPipeline(task) !== run.pipeline ||
    task.delivery.repo !== payload.data.spec.target.repo ||
    !isControlPlaneRepository(task.delivery.repo)
  )
    return undefined;
  const actor = /^github:([\w.-]+(?:\[bot\])?)$/u.exec(
    payload.data.origin.principal,
  )?.[1];
  if (actor === undefined) return undefined;
  const permission = z
    .object({
      permission: z.string(),
      role_name: z.string(),
      user: z.object({ login: z.string() }),
    })
    .parse(
      await github(
        deps,
        task.delivery.repo,
        `collaborators/${encodeURIComponent(actor)}/permission`,
      ),
    );
  if (
    permission.user.login.toLowerCase() !== actor.toLowerCase() ||
    (!['admin', 'write', 'maintain', 'triage'].includes(
      permission.permission,
    ) &&
      !['triage', 'triage_plus'].includes(permission.role_name))
  )
    return undefined;
  return {
    runId: run.runId,
    head: task.delivery.head,
    repo: task.delivery.repo,
    principal: payload.data.origin.principal,
    pipeline: run.pipeline,
    intentRunId: task.providerRouting?.acceptedGeneration?.runId,
    observedAt: Date.now(),
  };
}

export function deliveryCorrectionAuthorized(
  task: Task,
  run: Run,
  permission?: GithubIntakePermission,
): boolean {
  const payload = workPayloadSchema.safeParse(task.work);
  if (
    !payload.success ||
    !isControlPlaneRepository(payload.data.spec.target.repo) ||
    task.delivery?.repo !== payload.data.spec.target.repo ||
    ('repo' in task.task && task.task.repo !== payload.data.spec.target.repo)
  )
    return false;
  // A temporary fallback remains a fallback. Only the existing policy's
  // current source grant can authorize its same-provider correction; an
  // actor permission or incidental execution must not replace that grant.
  if (run.pipeline !== deliveryIntentPipeline(task))
    return (
      run.providerFallback?.fromRunId !== undefined &&
      run.providerFallback.attemptedPipelines.includes(run.pipeline) &&
      currentFallbackPipelines(
        task,
        run,
        workGrants(),
        isControlPlaneRepository,
      ).includes(run.pipeline)
    );
  const grant =
    grantForPrincipal(payload.data.origin.principal) ??
    resolvePrincipal(payload.data.origin.principal);
  if (
    grant?.scopes.includes('work.operator') === true &&
    grant.pipelines.includes(run.pipeline as 'claude' | 'codex' | 'opencode')
  )
    return true;
  return (
    payload.data.origin.channel === 'github' &&
    deliveryIntentPipeline(task) === run.pipeline &&
    permission?.runId === run.runId &&
    permission.head === task.delivery.head &&
    permission.repo === task.delivery.repo &&
    permission.pipeline === run.pipeline &&
    permission.principal === payload.data.origin.principal &&
    permission.intentRunId ===
      task.providerRouting?.acceptedGeneration?.runId &&
    Date.now() - permission.observedAt <= 30_000
  );
}

export async function observeGithubDelivery(
  deps: DeliveryGithubDeps,
  binding: DeliveryBinding,
): Promise<DeliveryObservation> {
  const pr = prSchema.parse(
    await github(deps, binding.repo, `pulls/${binding.number}`),
  );
  const generation = parseRunGeneration(binding.runId);
  if (generation === undefined) throw new Error('Delivery generation invalid');
  const attempt = formatAttemptId({ generation, intentId: binding.runId });
  if (
    pr.number !== binding.number ||
    pr.base.ref !== binding.baseRef ||
    !pr.body?.includes(`<!-- attempt-claim:${attempt} -->`)
  )
    throw new Error('Delivery artifact identity changed');
  if (
    !pr.merged &&
    (pr.state !== 'open' ||
      pr.draft ||
      pr.auto_merge?.merge_method !== 'squash')
  )
    return { kind: 'waiting', head: binding.head };
  const review = await reviews(deps, binding.repo, binding.number, pr.head.sha);
  if (pr.head.sha !== binding.head) {
    if (!hasIndependentReview(review, pr.user.login))
      return { kind: 'waiting', head: binding.head };
    return { kind: 'revision', head: binding.head, newHead: pr.head.sha };
  }
  if (pr.merged && pr.merge_commit_sha !== null) {
    if (!hasIndependentReview(review, pr.user.login))
      return { kind: 'waiting', head: binding.head };
    const suiteSchema = z.object({
      id: z.number(),
      after_sha: sha,
      result: z.string(),
      ref: z.string(),
    });
    let suite: z.infer<typeof suiteSchema> | undefined;
    // The longest documented window is one month. Missing older evidence and
    // more than ten full pages retain ownership; they never qualify landing.
    for (let page = 1; page <= 10; page++) {
      const query = new URLSearchParams({
        ref: `refs/heads/${binding.baseRef}`,
        rule_suite_result: 'pass',
        evaluate_status: 'active',
        time_period: 'month',
        per_page: '100',
        page: String(page),
      });
      const suites = z
        .array(suiteSchema)
        .max(100)
        .parse(
          await github(deps, binding.repo, `rulesets/rule-suites?${query}`),
        );
      suite = suites.find(
        (candidate) =>
          candidate.after_sha === pr.merge_commit_sha &&
          candidate.ref === `refs/heads/${binding.baseRef}` &&
          candidate.result === 'pass',
      );
      if (suite !== undefined) break;
      if (suites.length < 100)
        throw new Error('Protected merge evidence unavailable');
    }
    if (suite === undefined)
      throw new Error('Protected merge evidence exceeds bounded read');
    const details = z
      .object({
        result: z.literal('pass'),
        after_sha: sha,
        rule_evaluations: z
          .array(z.object({ rule_type: z.string(), result: z.string() }))
          .min(1),
      })
      .parse(
        await github(deps, binding.repo, `rulesets/rule-suites/${suite.id}`),
      );
    if (
      details.after_sha !== pr.merge_commit_sha ||
      details.rule_evaluations.some((rule) => rule.result !== 'pass') ||
      !details.rule_evaluations.some(
        (rule) => rule.rule_type === 'required_status_checks',
      ) ||
      !details.rule_evaluations.some(
        (rule) => rule.rule_type === 'pull_request',
      )
    )
      throw new Error('Protected checks did not pass');
    return {
      kind: 'protected-merge',
      head: binding.head,
      mergeCommit: pr.merge_commit_sha,
    };
  }
  const required = await protectedChecks(deps, binding.repo, pr.base.ref);
  const checkRuns = await currentCheckRuns(deps, binding);
  const candidateFailures = checkRuns.filter(
    (check) =>
      check.head_sha === binding.head &&
      required.some(
        (rule) =>
          rule.context === check.name &&
          (!rule.integration_id || rule.integration_id === check.app?.id),
      ) &&
      check.status === 'completed' &&
      ['failure', 'timed_out', 'action_required'].includes(
        check.conclusion ?? '',
      ),
  );
  const currentCheckIds = await currentActionCheckIds(
    deps,
    binding,
    candidateFailures.filter(
      (check) => !check.app?.slug || check.app.slug === 'github-actions',
    ),
  );
  const currentAppCheckIds = await currentNonActionCheckIds(
    deps,
    binding,
    candidateFailures.filter(
      (check) => check.app?.slug && check.app.slug !== 'github-actions',
    ),
  );
  const failed = candidateFailures.filter(
    (check) =>
      check.id !== undefined &&
      (currentCheckIds.has(check.id) || currentAppCheckIds.has(check.id)),
  );
  // The declared App can read Checks, not private-repository commit statuses.
  // Uncovered legacy required contexts remain unknown until protected landing;
  // available exact-head check failures and independent review stay actionable.
  if (failed.length || review.changesRequested || review.unresolved)
    return {
      kind: 'correction',
      head: binding.head,
      reason: failed.length
        ? `Required checks failed: ${failed.map((check) => check.name).join(', ')}`
        : 'Review feedback requires correction',
    };
  return { kind: 'waiting', head: binding.head };
}

/** Collect the complete bounded current-check read before classifying failures. */
async function currentCheckRuns(
  deps: DeliveryGithubDeps,
  binding: DeliveryBinding,
): Promise<z.infer<typeof checkRunSchema>[]> {
  const collected: z.infer<typeof checkRunSchema>[] = [];
  const ids = new Set<number>();
  let total: number | undefined;
  for (let page = 1; page <= 10; page += 1) {
    const data = z
      .object({
        total_count: z.number().int().nonnegative(),
        check_runs: z.array(checkRunSchema).max(100),
      })
      .parse(
        await github(
          deps,
          binding.repo,
          `commits/${binding.head}/check-runs?per_page=100&filter=latest&page=${page}`,
        ),
      );
    if (total !== undefined && total !== data.total_count)
      throw new Error('Checks changed during pagination');
    total = data.total_count;
    for (const check of data.check_runs) {
      if (check.id !== undefined) {
        if (ids.has(check.id))
          throw new Error('Checks pagination repeated evidence');
        ids.add(check.id);
      }
      collected.push(check);
    }
    if (collected.length > total) throw new Error('Checks count inconsistent');
    if (collected.length === total) return collected;
    if (data.check_runs.length < 100) throw new Error('Checks truncated');
  }
  throw new Error('Checks exceed bounded read');
}

/** Other Apps have their own check suites, not Actions workflow attempts.
 * Only complete, exact-App/suite/current-check evidence authorizes correction. */
async function currentNonActionCheckIds(
  deps: DeliveryGithubDeps,
  binding: DeliveryBinding,
  checks: readonly z.infer<typeof checkRunSchema>[],
): Promise<Set<number>> {
  const qualified = new Set<number>();
  if (checks.length > 10) return qualified;
  for (const check of checks) {
    const app = check.app;
    if (check.id === undefined || check.check_suite === undefined || !app?.slug)
      continue;
    try {
      const suite = z
        .object({
          id: z.number().int().positive(),
          head_sha: sha,
          app: z.object({ id: z.number().int().positive(), slug: z.string() }),
          status: z.string(),
          conclusion: z.string().nullable(),
        })
        .parse(
          await github(
            deps,
            binding.repo,
            `check-suites/${check.check_suite.id}`,
          ),
        );
      if (
        suite.id !== check.check_suite.id ||
        suite.head_sha !== binding.head ||
        suite.app.id !== app.id ||
        suite.app.slug !== app.slug ||
        suite.status !== 'completed' ||
        !['failure', 'timed_out', 'action_required'].includes(
          suite.conclusion ?? '',
        )
      )
        continue;
      const latest = z
        .object({
          total_count: z.number().int().nonnegative(),
          check_runs: z.array(checkRunSchema),
        })
        .parse(
          await github(
            deps,
            binding.repo,
            `commits/${binding.head}/check-runs?per_page=100&filter=latest&app_id=${app.id}&check_name=${encodeURIComponent(check.name)}`,
          ),
        );
      if (latest.total_count !== 1 || latest.check_runs.length !== 1) continue;
      const current = latest.check_runs[0];
      if (
        current.id === check.id &&
        current.name === check.name &&
        current.head_sha === binding.head &&
        current.check_suite?.id === suite.id &&
        current.app?.id === app.id &&
        current.app?.slug === app.slug &&
        current.status === 'completed' &&
        ['failure', 'timed_out', 'action_required'].includes(
          current.conclusion ?? '',
        )
      )
        qualified.add(check.id);
    } catch {
      // Unknown provider evidence never becomes a failure or grants completion.
    }
  }
  return qualified;
}

/** Same-head checks can outlive canceled draft CI and earlier run attempts.
 * Only a current workflow attempt's jobs can qualify an Actions failure. */
async function currentActionCheckIds(
  deps: DeliveryGithubDeps,
  binding: DeliveryBinding,
  checks: readonly { id?: number; check_suite?: { id: number } }[],
): Promise<Set<number>> {
  const qualified = new Set<number>();
  if (checks.length === 0) return qualified;
  try {
    let reads = 0;
    const runPageSchema = z.object({
      total_count: z.number().int().nonnegative(),
      workflow_runs: z.array(
        z.object({
          id: z.number().int().positive(),
          workflow_id: z.number().int().positive(),
          run_number: z.number().int().positive(),
          run_attempt: z.number().int().positive(),
          head_sha: sha,
          check_suite_id: z.number().int().positive(),
          event: z.string(),
          conclusion: z.string().nullable(),
        }),
      ),
    });
    const runs = {
      workflow_runs: [] as z.infer<typeof runPageSchema>['workflow_runs'],
    };
    const runIds = new Set<number>();
    let runTotal: number | undefined;
    for (let page = 1; page <= 10; page += 1) {
      reads += 1;
      const data = runPageSchema.parse(
        await github(
          deps,
          binding.repo,
          `actions/runs?head_sha=${binding.head}&per_page=100&page=${page}`,
        ),
      );
      if (
        data.workflow_runs.length > 100 ||
        (runTotal !== undefined && runTotal !== data.total_count)
      )
        throw new Error('Actions workflow evidence changed');
      runTotal = data.total_count;
      for (const run of data.workflow_runs) {
        if (runIds.has(run.id))
          throw new Error('Actions workflow evidence repeated');
        runIds.add(run.id);
        runs.workflow_runs.push(run);
      }
      if (runs.workflow_runs.length > runTotal)
        throw new Error('Actions workflow count inconsistent');
      if (runs.workflow_runs.length === runTotal) break;
      if (data.workflow_runs.length < 100 || page === 10)
        throw new Error('Actions workflow evidence incomplete');
    }
    const current = new Map<string, (typeof runs.workflow_runs)[number]>();
    for (const run of runs.workflow_runs) {
      if (run.head_sha !== binding.head) continue;
      const key = String(run.workflow_id);
      const previous = current.get(key);
      if (
        previous !== undefined &&
        previous.run_number === run.run_number &&
        previous.id !== run.id
      )
        return qualified;
      if (
        previous === undefined ||
        run.run_number > previous.run_number ||
        (run.run_number === previous.run_number &&
          run.run_attempt > previous.run_attempt)
      )
        current.set(key, run);
    }
    const parents = [...current.values()].filter(
      (run) =>
        run.conclusion !== 'cancelled' &&
        checks.some((check) => check.check_suite?.id === run.check_suite_id),
    );
    if (parents.length > 10) return qualified;
    for (const run of parents) {
      const jobPageSchema = z.object({
        total_count: z.number().int().nonnegative(),
        jobs: z.array(
          z.object({
            run_id: z.number(),
            run_attempt: z.number().optional(),
            head_sha: sha,
            check_run_url: z.string(),
            status: z.string(),
            conclusion: z.string().nullable(),
          }),
        ),
      });
      const jobs = { jobs: [] as z.infer<typeof jobPageSchema>['jobs'] };
      const jobUrls = new Set<string>();
      let jobTotal: number | undefined;
      for (let page = 1; page <= 10; page += 1) {
        reads += 1;
        if (reads > 20)
          throw new Error('Actions evidence exceeds bounded read');
        const data = jobPageSchema.parse(
          await github(
            deps,
            binding.repo,
            `actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100&page=${page}`,
          ),
        );
        if (
          data.jobs.length > 100 ||
          (jobTotal !== undefined && jobTotal !== data.total_count)
        )
          throw new Error('Actions job evidence changed');
        jobTotal = data.total_count;
        for (const job of data.jobs) {
          if (jobUrls.has(job.check_run_url))
            throw new Error('Actions job evidence repeated');
          jobUrls.add(job.check_run_url);
          jobs.jobs.push(job);
        }
        if (jobs.jobs.length > jobTotal)
          throw new Error('Actions job count inconsistent');
        if (jobs.jobs.length === jobTotal) break;
        if (data.jobs.length < 100 || page === 10)
          throw new Error('Actions job evidence incomplete');
      }
      for (const job of jobs.jobs) {
        const prefix = `https://api.github.com/repos/${binding.repo}/check-runs/`;
        if (
          job.run_id !== run.id ||
          (job.run_attempt !== undefined &&
            job.run_attempt !== run.run_attempt) ||
          job.head_sha !== binding.head ||
          !job.check_run_url.startsWith(prefix) ||
          job.status !== 'completed' ||
          !['failure', 'timed_out', 'action_required'].includes(
            job.conclusion ?? '',
          )
        )
          continue;
        const suffix = job.check_run_url.slice(prefix.length);
        if (!/^\d+$/u.test(suffix)) continue;
        const id = Number(suffix);
        if (
          checks.some(
            (check) =>
              check.id === id && check.check_suite?.id === run.check_suite_id,
          )
        )
          qualified.add(id);
      }
    }
  } catch {
    // Missing/ambiguous Actions provenance has no correction authority.
    // Independent current review feedback remains actionable below.
  }
  return qualified;
}

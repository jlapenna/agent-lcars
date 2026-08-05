// Pure detection helpers for the "infra-killed" CI signature (agent-lcars
// #536): PR #469's Verify run (30893470148) died right after checkout with
// conclusion `failure` and every step's own conclusion `null` -- the
// self-hosted runner was evicted/killed under the job before it ever
// recorded a single step outcome. That reads as an ordinary red required
// check indistinguishable from a real failure, so auto-merge stalls until
// a human notices the all-null-steps shape and reruns it by hand.
//
// A genuine test failure always has a non-null `failure` conclusion on the
// one step that actually broke (every other step before it is `success`,
// every step after it is `skipped`) -- never every step reporting `null`.
// That makes the all-null-steps shape precise enough to auto-rerun without
// ever masking a real failure: nothing here can match a run whose failure
// is a real code/test problem.
//
// No network access in this file -- main.mjs supplies the already-fetched
// GitHub API responses (a workflow run, its jobs, associated pull
// requests) this operates on, so the decision logic is exercised directly
// in detect.test.mjs without mocking HTTP.

function jobLooksInfraKilled(job) {
  const steps = Array.isArray(job?.steps) ? job.steps : [];
  return (
    job?.conclusion === 'failure' &&
    steps.length > 0 &&
    steps.every((step) => step?.conclusion === null)
  );
}

// A run only qualifies when EVERY one of its failed jobs shows the
// all-null-steps signature. A mixed run -- one job infra-killed, another
// genuinely red with a real failed step -- must not be silently masked by
// an automatic rerun that can only ever re-fail the genuinely broken job
// again: leaving the whole run red is the correct, honest outcome there,
// and a human still sees exactly why. The run_attempt guard below (see
// isEligibleForRerun) is what stops any of this from looping, not this
// function -- this function only decides whether a SINGLE pass looks safe
// to retry.
function runLooksInfraKilled(jobs) {
  const failedJobs = (jobs ?? []).filter(
    (job) => job?.conclusion === 'failure',
  );
  return failedJobs.length > 0 && failedJobs.every(jobLooksInfraKilled);
}

// GitHub's own `run_attempt` counter on the workflow run IS the "already
// rerun once" marker -- `gh run rerun --failed` (and the equivalent
// rerun-failed-jobs REST call) creates a new ATTEMPT of the SAME run id
// rather than a new run, incrementing run_attempt on every subsequent read
// of that run. That means no separate label, comment, or ledger state is
// needed to enforce "only rerun once per run": a run still at attempt 1
// has never been rerun by anyone; the moment it has been (by this
// workflow, or by a human running `gh run rerun` by hand before this scan
// ever saw it), every later scan's own read of the SAME run already
// reports run_attempt > 1 and skips it -- a run that fails the same
// infra-killed-looking way twice in a row stays red instead of looping
// forever.
function isEligibleForRerun(run) {
  return (
    run?.status === 'completed' &&
    run?.conclusion === 'failure' &&
    run?.run_attempt === 1
  );
}

// `GET /repos/{owner}/{repo}/commits/{sha}/pulls` is the same lookup
// agent-automerge.yml's restore-main-checks job already uses to find a
// commit's associated PR (chosen there, and reused here, because the
// workflow run object's own `pull_requests` field is unreliable in
// production -- confirmed empty on run 30893470148 above despite it being
// a real `pull_request`-triggered run for PR #469). Prefer an open PR
// (the common case: the run is still gating an in-flight merge); fall
// back to whatever the API returned so a rerun on an already-merged/closed
// PR still gets its audit-trail comment somewhere sensible rather than
// silently nowhere.
function selectAssociatedPullRequest(pulls) {
  const candidates = pulls ?? [];
  return candidates.find((pr) => pr.state === 'open') ?? candidates[0];
}

function buildRerunCommentBody({ runUrl, workflowName, jobNames }) {
  const jobs = (jobNames ?? []).length > 0 ? jobNames.join(', ') : 'a job';
  return (
    `${workflowName ?? 'CI'}'s ${jobs} failed with every step's conclusion ` +
    '`null` -- the runner was evicted/killed at the infrastructure level ' +
    '(agent-lcars#536), not a real test failure. Automatically reran it ' +
    `once: ${runUrl}`
  );
}

export {
  buildRerunCommentBody,
  isEligibleForRerun,
  jobLooksInfraKilled,
  runLooksInfraKilled,
  selectAssociatedPullRequest,
};

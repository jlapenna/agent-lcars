#!/usr/bin/env node
// Watch one GitHub Actions run until it completes: the single-run
// "did this CI run pass?" watcher (adopted from sprinkles'
// github-ci-monitor skill, where it started as scripts/monitor.cjs).
// fleet-watch-prs answers the auto-merge lifecycle question ("did my PRs
// land, and if not, what needs fixing?"); this answers the narrower one a
// session has right after a push: pass or fail, with failed-job logs on
// failure. Polls every 30s, printing only status changes.
//
// This is the fleet's single copy (packages/fleet-tools, agent-lcars#1328):
// installed on PATH as `fleet-watch-run`, repo identity discovered from cwd
// via `gh` -- no repo-specific hook needed.
//
// Usage: fleet-watch-run [--workflow <name>] [--timeout <minutes>] <pr-number-or-branch>
//   --workflow <name>    only consider runs of this workflow (name or file
//                        name, forwarded to `gh run list --workflow`);
//                        without it the branch's newest run of any workflow
//                        is watched
//   --timeout <minutes>  give up after this long (default 30)
//
// Exit: 0 success, 1 failure/timeout/no-run-found.
const { execFileSync } = require('child_process');

function gh(args) {
  try {
    return execFileSync('gh', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch (_e) {
    return null;
  }
}

function getLatestRunId(target, workflow) {
  // Try treating target as PR number
  if (/^\d+$/.test(target)) {
    const prJson = gh(['pr', 'view', target, '--json', 'headRefName']);
    if (prJson) {
      try {
        const branch = JSON.parse(prJson).headRefName;
        return getLatestRunIdForBranch(branch, workflow);
      } catch (_e) {
        // Fall through to the branch interpretation below.
      }
    }
  }
  // Treat as branch
  return getLatestRunIdForBranch(target, workflow);
}

function getLatestRunIdForBranch(branch, workflow) {
  const args = [
    'run',
    'list',
    '--branch',
    branch,
    '--limit',
    '1',
    '--json',
    'databaseId',
  ];
  if (workflow) args.push('--workflow', workflow);
  const json = gh(args);
  if (!json) return null;
  try {
    const runs = JSON.parse(json);
    return runs.length > 0 ? runs[0].databaseId : null;
  } catch (_e) {
    return null;
  }
}

async function monitor(target, { workflow, timeoutMinutes }) {
  console.log(`Finding latest run for: ${target}...`);
  const runId = getLatestRunId(target, workflow);

  if (!runId) {
    console.error(
      `Could not find any runs for ${target}${workflow ? ` (workflow: ${workflow})` : ''}.`,
    );
    process.exit(1);
  }

  console.log(`Monitoring Run ID: ${runId}`);
  console.log('Polling for updates (checking every 30s)...');

  let lastStatus = '';
  const start = Date.now();
  const timeout = timeoutMinutes * 60 * 1000;

  while (Date.now() - start < timeout) {
    const json = gh([
      'run',
      'view',
      String(runId),
      '--json',
      'status,conclusion,url',
    ]);
    if (!json) {
      console.log('Failed to fetch status, retrying...');
      await new Promise((r) => setTimeout(r, 30000));
      continue;
    }

    try {
      const data = JSON.parse(json);
      const status = data.status;
      const conclusion = data.conclusion;

      if (status !== lastStatus) {
        console.log(`Status change: ${status}`);
        lastStatus = status;
      }

      if (status === 'completed') {
        console.log(`
Run Completed! Conclusion: ${conclusion}`);
        console.log(`URL: ${data.url}`);
        if (conclusion === 'success') {
          process.exit(0);
        } else {
          // If failed, try to get failed job logs
          console.log('Fetching failed jobs...');
          const failedJobs = gh(['run', 'view', String(runId), '--log-failed']);
          if (failedJobs) {
            console.log('\n--- Failed Job Logs (Truncated) ---');
            console.log(failedJobs.substring(0, 2000)); // Limit output
          }
          process.exit(1);
        }
      }
    } catch (_e) {
      console.error('Error parsing JSON status');
    }

    await new Promise((r) => setTimeout(r, 30000));
  }

  console.log('Timeout waiting for CI.');
  process.exit(1);
}

function usage() {
  console.error(
    'Usage: fleet-watch-run [--workflow <name>] [--timeout <minutes>] <pr-number-or-branch>',
  );
  process.exit(1);
}

const args = process.argv.slice(2);
let workflow = null;
let timeoutMinutes = 30;
let target = null;
while (args.length > 0) {
  const arg = args.shift();
  if (arg === '--workflow') {
    workflow = args.shift();
    if (!workflow) usage();
  } else if (arg === '--timeout') {
    timeoutMinutes = Number(args.shift());
    if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) usage();
  } else if (arg.startsWith('-')) {
    usage();
  } else if (target === null) {
    target = arg;
  } else {
    usage();
  }
}
if (!target) usage();

monitor(target, { workflow, timeoutMinutes });

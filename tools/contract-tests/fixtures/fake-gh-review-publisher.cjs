#!/usr/bin/env node
// A stand-in for the GitHub calls the shared LCARS review publisher makes
// (.github/actions/publish-lcars-review/publish.sh). It answers reads from a
// JSON state file, applies check-run writes to it, and records each write
// with the token that made it, so a test can run the real script and read
// what it published and as whom.
//
// State (FAKE_GH_STATE):
//   repo      "owner/name"
//   rules     the branch rules array for the default branch
//   pulls     [{ number, head, baseOid, candidate: {oid, parents:[..]}|null,
//               reviews: [...], comments: [...], baseEvents: [...] }]
//   checks    { "<sha>": [check run, ...] }
//   writes    appended: [{ method, token, sha, id, name, conclusion }]
//   nextId    next check run id
'use strict';
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');

const args = process.argv.slice(2);
const statePath = process.env.FAKE_GH_STATE;
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
const die = (message) => {
  process.stderr.write(`gh: ${message}\n`);
  process.exit(1);
};
if (args[0] !== 'api') die(`unexpected command ${args[0]}`);

const rest = args.slice(1);
const fields = {};
let method = 'GET';
let jq;
let slurp = false;
let route;
for (let i = 0; i < rest.length; i += 1) {
  const arg = rest[i];
  if (arg === '--method' || arg === '-X') method = rest[(i += 1)];
  else if (arg === '--jq' || arg === '-q') jq = rest[(i += 1)];
  else if (arg === '-f' || arg === '-F') {
    const pair = rest[(i += 1)];
    fields[pair.slice(0, pair.indexOf('='))] = pair.slice(
      pair.indexOf('=') + 1,
    );
  } else if (arg === '--slurp') slurp = true;
  else if (['--paginate', '--silent', '--include'].includes(arg)) continue;
  else route = arg;
}
function respond(value) {
  const body = slurp ? [value] : value;
  if (!jq) return process.stdout.write(`${JSON.stringify(body)}\n`);
  const result = spawnSync('jq', ['-r', jq], {
    input: JSON.stringify(body),
    encoding: 'utf8',
  });
  if (result.status !== 0) die(`jq failed: ${result.stderr}`);
  process.stdout.write(result.stdout);
}
const pull = (number) =>
  state.pulls.find((entry) => entry.number === Number(number)) ??
  die('Not Found (HTTP 404)');
const open = (entry) => ({
  number: entry.number,
  state: 'open',
  head: { sha: entry.head },
  base: { ref: 'main' },
});
const [path, query = ''] = (route ?? '').split('?');
const base = `repos/${state.repo}`;

if (route === 'graphql') {
  const entry = pull(fields.pr);
  const author = entry.author ?? { __typename: 'User', login: 'jlapenna' };
  const defaultCommitAuthor =
    author.__typename === 'Bot' ? `${author.login}[bot]` : author.login;
  const commits = entry.commits ?? [
    { oid: entry.head, authorLogin: defaultCommitAuthor },
  ];
  respond({
    data: {
      repository: {
        pullRequest: {
          state: 'OPEN',
          isDraft: entry.isDraft ?? false,
          baseRefName: 'main',
          headRefName: entry.headRefName ?? `pr-${entry.number}`,
          headRefOid: entry.head,
          baseRef: { target: { oid: entry.baseOid } },
          author,
          commits: {
            totalCount: entry.commitsTotalCount ?? commits.length,
            nodes: commits.map((c) => ({
              commit: {
                oid: c.oid,
                author: {
                  user: c.authorLogin ? { login: c.authorLogin } : null,
                },
              },
            })),
          },
          potentialMergeCommit: entry.candidate && {
            oid: entry.candidate.oid,
            parents: { nodes: entry.candidate.parents.map((oid) => ({ oid })) },
          },
          timelineItems: { nodes: entry.baseEvents ?? [] },
        },
      },
    },
  });
} else if (path === `${base}/pulls` && method === 'GET') {
  respond(state.pulls.map(open));
} else if (path === `${base}/rules/branches/main`) {
  respond(state.rules);
} else if (/\/pulls\/\d+\/reviews$/.test(path)) {
  respond(pull(path.split('/').at(-2)).reviews ?? []);
} else if (/\/issues\/\d+\/comments$/.test(path)) {
  respond(pull(path.split('/').at(-2)).comments ?? []);
} else if (/\/commits\/[0-9a-f]+\/pulls$/.test(path)) {
  const sha = path.split('/').at(-2);
  respond(state.pulls.filter((entry) => entry.head === sha).map(open));
} else if (/\/commits\/[0-9a-f]+\/check-runs$/.test(path)) {
  const sha = path.split('/').at(-2);
  const name = decodeURIComponent(/check_name=([^&]*)/.exec(query)?.[1] ?? '');
  respond({
    check_runs: (state.checks[sha] ?? []).filter((run) => run.name === name),
  });
} else if (path === `${base}/check-runs` && method === 'POST') {
  const run = {
    id: state.nextId++,
    name: fields.name,
    external_id: fields.external_id,
    app: { id: 4457090 },
    status: fields.status,
    conclusion: fields.conclusion,
    details_url: fields.details_url,
    output: { title: fields['output[title]'] },
  };
  (state.checks[fields.head_sha] ??= []).push(run);
  state.writes.push({
    method,
    token: process.env.GH_TOKEN,
    sha: fields.head_sha,
    id: run.id,
    name: run.name,
    conclusion: run.conclusion,
  });
  save();
  respond(run);
} else if (/\/check-runs\/\d+$/.test(path) && method === 'PATCH') {
  const id = Number(path.split('/').at(-1));
  const [sha, run] =
    Object.entries(state.checks)
      .flatMap(([commit, runs]) => runs.map((entry) => [commit, entry]))
      .find(([, entry]) => entry.id === id) ?? die('Not Found (HTTP 404)');
  Object.assign(run, {
    status: fields.status,
    conclusion: fields.conclusion,
    details_url: fields.details_url,
    output: { title: fields['output[title]'] },
  });
  state.writes.push({
    method,
    token: process.env.GH_TOKEN,
    sha,
    id,
    name: run.name,
    conclusion: run.conclusion,
  });
  save();
  respond(run);
} else die(`unexpected api route ${method} ${route}`);

#!/usr/bin/env node
// Live native review qualification. Model calls are real; publication is captured
// for inspection rather than posting evaluation traffic to the source PR.
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  createWriteStream,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { finished } from 'node:stream/promises';
import { claudeRunnerToolArgs } from './delegation-fixture.mjs';
import { materializeReviewSource } from './materialize-review-source.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const [provider, pull, output, sourceRef] = process.argv.slice(2);
if (
  !['claude', 'codex', 'opencode', 'agy'].includes(provider) ||
  !/^\d+$/.test(pull ?? '') ||
  !output ||
  !isAbsolute(output)
) {
  throw new Error(
    'Usage: qualify-review.mjs <claude|codex|opencode|agy> <PR number> <new absolute evidence directory> [historical source SHA]',
  );
}
const run = (binary, args, options = {}) =>
  execFileSync(binary, args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
const git = (...args) => run('git', args);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const metadata = JSON.parse(
  run('gh', [
    'pr',
    'view',
    pull,
    '-R',
    'jlapenna/agent-lcars',
    '--json',
    'title,body,headRefOid,baseRefOid,state,author,url',
  ]),
);
const head = sourceRef ?? metadata.headRefOid;
if (!/^[a-f0-9]{40}$/.test(head))
  throw new Error('Expected a full immutable source SHA');
const base = metadata.baseRefOid;
mkdirSync(output, { mode: 0o700 });
const reviewRoot = materializeReviewSource(
  root,
  join(output, 'source'),
  head,
  base,
);
const reviewGit = (...args) => run('git', ['-C', reviewRoot, ...args]);
const diff = reviewGit('diff', '--no-ext-diff', `${base}...${head}`);
const filenames = reviewGit('diff', '--name-only', `${base}...${head}`)
  .trim()
  .split('\n');
const files = new Set(['AGENTS.md', 'CLAUDE.md']);
for (const path of filenames) {
  let directory = dirname(path);
  while (directory !== '.') {
    for (const name of ['AGENTS.md', 'CLAUDE.md'])
      files.add(join(directory, name));
    directory = dirname(directory);
  }
}
let guidance = '';
const tracked = new Set(
  reviewGit('ls-tree', '-r', '--name-only', head).trim().split('\n'),
);
for (const path of [...files].sort()) {
  if (tracked.has(path))
    guidance += `\n\n## ${path}\n\n${reviewGit('show', `${head}:${path}`)}`;
}
const procedure = join(output, 'procedure');
mkdirSync(procedure, { mode: 0o700 });
const packager = join(
  root,
  'apps/runner-autoscaler/runner-image/package-anthropic-review.sh',
);
run('bash', [packager, procedure]);
const adapter = readFileSync(join(procedure, 'README.md'));
const imageId = process.env.LCARS_REVIEW_QUALIFICATION_IMAGE_ID;
if (imageId && !sourceRef && head !== git('rev-parse', 'HEAD').trim())
  throw new Error(
    'Current candidate PR head does not match qualification source',
  );
const baked =
  '/usr/local/lib/agent-lcars/agents/shared/skills/agent-protocol/reference/anthropic-code-review';
if (imageId) {
  if (!/^sha256:[a-f0-9]{64}$/.test(imageId))
    throw new Error('Expected inspected immutable image ID');
  for (const name of ['README.md', 'upstream.md', 'LICENSE', 'revision']) {
    if (
      !readFileSync(join(procedure, name)).equals(
        readFileSync(join(baked, name)),
      )
    )
      throw new Error('Candidate image review source mismatch: ' + name);
  }
  for (const name of ['direct-runner.sh', 'runtime/prepare-dispatch.sh']) {
    if (
      !readFileSync(
        join(root, 'apps/runner-autoscaler/runner-image', name),
      ).equals(readFileSync(join('/usr/local/lib/agent-lcars', name)))
    )
      throw new Error('Candidate image launch source mismatch: ' + name);
  }
  for (const [source, installed] of [
    [
      'runtime-releases.json',
      '/usr/local/lib/agent-lcars/runtime-releases.json',
    ],
    ['runtime-clis/package.json', '/opt/runner-clis/package.json'],
    ['runtime-clis/package-lock.json', '/opt/runner-clis/package-lock.json'],
    [
      'opencode-version',
      '/usr/local/share/agent-lcars-tooling/opencode-version',
    ],
    ['agy-version', '/usr/local/share/agent-lcars-tooling/agy-version'],
  ]) {
    if (
      !readFileSync(
        join(root, 'apps/runner-autoscaler/runner-image', source),
      ).equals(readFileSync(installed))
    )
      throw new Error('Candidate image runtime dependency mismatch: ' + source);
  }
}
writeFileSync(join(output, 'change.diff'), diff);
writeFileSync(join(output, 'guidance.md'), guidance);
// A package lock cannot establish which revision an unversioned hosted preset served.
const cases = JSON.parse(
  readFileSync(join(root, 'tools/probes/review-cases.json'), 'utf8'),
);
const dependency = cases.cases.find(
  (item) => item.pullRequest === Number(pull) && item.head === head,
)?.dependencySnapshot;
let dependencyContext = '';
if (dependency) {
  const snapshot = readFileSync(join(root, 'tools/probes', dependency.fixture));
  if (sha256(snapshot) !== dependency.sha256)
    throw new Error('Replay dependency snapshot integrity mismatch');
  writeFileSync(join(output, 'dependency-snapshot.json'), snapshot);
  writeFileSync(
    join(output, 'dependency-provenance.json'),
    JSON.stringify(dependency, null, 2),
  );
  dependencyContext = `External configuration replay input: ${join(output, 'dependency-snapshot.json')} is the shared preset from ${dependency.repository}@${dependency.revision}:${dependency.path}. Provenance is ${join(output, 'dependency-provenance.json')}. Review this source under that recorded preset snapshot; this does not assert which revision the historical hosted endpoint served. Give this same input to every reviewer and validator.`;
}
// Later PR edits describe the regression's fix. Never leak those edits to a
// reviewer of the earlier snapshot.
const contextMetadata = sourceRef
  ? {
      title: metadata.title,
      url: metadata.url,
      number: Number(pull),
      body: 'Historical source replay; the original PR body was not retained. Later edits are deliberately excluded.',
      baseRefOid: base,
      reviewedHead: head,
      historicalSnapshot: true,
    }
  : { ...metadata, reviewedHead: head, historicalSnapshot: false };
writeFileSync(
  join(output, 'pr.json'),
  JSON.stringify(contextMetadata, null, 2),
);
const seconds = Number(process.env.LCARS_REVIEW_TIMEOUT_SECONDS ?? 4800);
if (!Number.isInteger(seconds) || seconds < 1 || seconds > 4800)
  throw new Error('Review deadline must be 1–4800 seconds');
const reviewDeadline = new Date(Date.now() + seconds * 1000).toISOString();
const marker = `<!-- review-qualification:${provider}:${head}:${Date.now()} -->`;
const receipt = join(output, 'receipt.json');
const payload = join(output, 'review.json');
const prompt = `Review jlapenna/agent-lcars#${pull} at the immutable head ${head}.
This is a live native-harness qualification of the LCARS review procedure.
Read ${join(imageId ? baked : procedure, 'README.md')} and its packaged upstream.md. Apply their
four independent review passes and fresh validation to the actual source change.
The full diff is ${join(output, 'change.diff')}; scoped guidance is
${join(output, 'guidance.md')}; PR metadata is ${join(output, 'pr.json')}.
Give every child the full diff, guidance, PR metadata and exact head. Children
return evidence only, never recursively delegate and never write to GitHub.
${dependencyContext}
${provider === 'opencode' ? 'In the procedure receipt, cite the packaged upstream revision ' + readFileSync(join(procedure, 'revision'), 'utf8').trim() + '.' : ''}
All passes, validators and captured publication share this ${seconds}-second
provider budget, ending by ${reviewDeadline}. Give the shared deadline to every
child and reserve time for validation and publication.
Use the native delegation facility this harness actually exposes, and wait for
all reviewers and validators. Do not substitute a single-agent inspection.
Every reviewer and validator must start with a fresh context. On Codex explicitly
set fork_turns="none" (or fork_context=false if that is its native schema), never
the default inherited conversation. Supply common inputs and assigned role;
validators also receive the candidate. Do not leak other reviewers' conclusions.
The source checkout is ${reviewRoot}. Give this working directory to every child.
Read source at ${head} with git show ${head}:<path>; the working checkout can
belong to a later revision. Do not silently review current files for an older PR.
${sourceRef ? `This is an explicitly labelled historical snapshot of the real PR. Read source with git show ${head}:<path>, not the current checkout. The live PR has moved. Do not query live PR prose, external memory or later source: those can disclose later fixes. Current-head/preflight/publication checks are outside this replay's coverage; do not claim them. Do not use MCP tools for this replay.` : 'Read back the live PR head before deciding; if it moved, record an incomplete review.'}
For this qualification ONLY, replace remote publication with a captured GitHub
review payload in ${payload}: {commit_id, event, body, comments}. Use COMMENT
with an explicit verdict because this run must not approve or block a real PR.
Its body must include this exact line: ${marker}
Write ${receipt} with {head, complete, verdict, reviewers, candidates, validators,
limitations}. reviewers is an array of {role, nativeSessionId, complete}; roles
are guidance-a, guidance-b, bugs-a, bugs-b. candidates is an array of {id,
description, path, line}; validators is an array of {candidateId, nativeSessionId,
decision, evidence}, with decision exactly confirmed or rejected. Identify the
actual fresh native sessions, not invented IDs.
If delegation or a required pass fails, complete=false, name the exact failure,
and do not claim a completed procedure. Keep all failed evidence.
Do not edit source, mutate source-repository Git, send messages or publish anything remotely.
You may write the two output files and owned scratch below ${output}, including
Git fixtures inside that owned scratch for focused tests. Other
source/tool reads are allowed. End with a concise verdict and verification limits.`;
writeFileSync(join(output, 'prompt.txt'), prompt);
writeFileSync(
  join(output, 'driver.mjs'),
  readFileSync(fileURLToPath(import.meta.url)),
  { mode: 0o600 },
);
let args;
let binary = provider;
const env = { ...process.env };
for (const name of [
  'BASH_ENV',
  'HERDR_PANE_ID',
  'HERDR_ENV',
  'CODEX_THREAD_ID',
  'CLAUDE_SESSION_ID',
  'LCARS_WORKER_SESSION_ID',
])
  delete env[name];
if (provider === 'claude')
  args = [
    '--dangerously-skip-permissions',
    ...claudeRunnerToolArgs(),
    '--strict-mcp-config',
    '--mcp-config',
    '{"mcpServers":{}}',
    '--output-format',
    'stream-json',
    '--verbose',
    '--print',
    prompt,
  ];
if (provider === 'claude' && imageId)
  args.unshift('--setting-sources', '', '--disable-slash-commands');
if (provider === 'codex')
  args = [
    'exec',
    '--json',
    '--dangerously-bypass-approvals-and-sandbox',
    '--output-last-message',
    join(output, 'last-message.txt'),
    prompt,
  ];
if (provider === 'codex' && process.env.LCARS_REVIEW_CODEX_ISOLATE === '1') {
  const model = process.env.LCARS_REVIEW_CODEX_MODEL;
  const effort = process.env.LCARS_REVIEW_CODEX_EFFORT;
  if (!model || !effort)
    throw new Error(
      'An isolated Codex run requires explicit caller-selected model and effort',
    );
  args.splice(
    1,
    0,
    '--ignore-user-config',
    '-c',
    'model=' + JSON.stringify(model),
    '-c',
    'model_reasoning_effort=' + JSON.stringify(effort),
  );
}
if (provider === 'opencode') {
  const sourceConfig = join(root, 'agents/opencode');
  const effectiveConfig = imageId
    ? '/home/runner/.config/opencode'
    : sourceConfig;
  if (imageId) {
    for (const name of ['review-overlay.json', 'instructions.md']) {
      if (
        !readFileSync(join(sourceConfig, name)).equals(
          readFileSync(join(effectiveConfig, name)),
        )
      )
        throw new Error(
          'Candidate image OpenCode review input mismatch: ' + name,
        );
    }
  }
  // Match the direct runner's effective per-review configuration.
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
    ...JSON.parse(
      readFileSync(join(effectiveConfig, 'review-overlay.json'), 'utf8'),
    ),
    provider: {
      homelab: {
        models: { default: { options: { reasoningEffort: 'medium' } } },
      },
    },
    instructions: [join(effectiveConfig, 'instructions.md')],
  });
  env.MODE = 'review';
  args = [
    'run',
    '--auto',
    '--format',
    'json',
    '--title',
    `LCARS review qualification ${pull}`,
    prompt,
  ];
}
if (provider === 'agy')
  args = [
    '--dangerously-skip-permissions',
    '--output-format',
    'stream-json',
    '--log-file',
    join(output, 'native.log'),
    '--print',
    prompt,
  ];
const version = run(binary, ['--version']).trim();
const runtimeDirectory = join(root, 'apps/runner-autoscaler/runner-image');
const runtimeDependencies = JSON.parse(
  readFileSync(join(runtimeDirectory, 'runtime-clis/package.json'), 'utf8'),
).dependencies;
const expectedVersion =
  provider === 'opencode' || provider === 'agy'
    ? readFileSync(join(runtimeDirectory, provider + '-version'), 'utf8')
        .trim()
        .replace(/^v/, '')
    : runtimeDependencies[
        provider === 'claude' ? '@anthropic-ai/claude-code' : '@openai/codex'
      ];
if (imageId && version.match(/\d+\.\d+\.\d+/)?.[0] !== expectedVersion)
  throw new Error(
    'Installed candidate CLI version does not match its declared dependency',
  );
if (provider === 'claude') env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS = '0';
const manifest = {
  provider,
  version,
  expectedVersion,
  imageId: imageId ?? null,
  uid: process.getuid(),
  timeoutSeconds: seconds,
  reviewWorkingDirectory: reviewRoot,
  sourceCommit: git('rev-parse', 'HEAD').trim(),
  reviewedHead: head,
  base,
  historicalSnapshot: !!sourceRef,
  dependencySnapshot: dependency ?? null,
  marker,
  upstreamRevision: readFileSync(join(procedure, 'revision'), 'utf8').trim(),
  hashes: {
    adapter: sha256(adapter),
    upstream: sha256(readFileSync(join(procedure, 'upstream.md'))),
    diff: sha256(diff),
    guidance: sha256(guidance),
    driver: sha256(readFileSync(fileURLToPath(import.meta.url))),
  },
  startedAt: new Date().toISOString(),
  publication: 'captured-not-posted',
  codexIsolated: process.env.LCARS_REVIEW_CODEX_ISOLATE === '1',
  environment: imageId
    ? 'candidate-image native harness; caller UID/authentication, no LCARS control-plane dispatch'
    : 'native workstation; not candidate-image qualification',
};
writeFileSync(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2));
const stdout = createWriteStream(join(output, 'trace.jsonl'), { mode: 0o600 });
const stderr = createWriteStream(join(output, 'stderr.txt'), { mode: 0o600 });
const child = spawn(binary, args, {
  cwd: reviewRoot,
  env,
  detached: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.pipe(stdout);
child.stderr.pipe(stderr);
console.log(
  JSON.stringify({ provider, pid: child.pid, output, reviewedHead: head }),
);
let timedOut = false;
let interrupted = false;
let forcedKill;
const stop = () => {
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    /* Already stopped. */
  }
  forcedKill = setTimeout(() => {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      /* Already stopped. */
    }
  }, 10000);
};
const timer = setTimeout(() => {
  timedOut = true;
  stop();
}, seconds * 1000);
for (const signal of ['SIGTERM', 'SIGINT'])
  process.once(signal, () => {
    interrupted = true;
    stop();
  });
const result = await new Promise((resolveResult) => {
  child.once('error', (error) => resolveResult({ error: error.message }));
  child.once('close', (exitCode, signal) =>
    resolveResult({ exitCode, signal }),
  );
});
clearTimeout(timer);
clearTimeout(forcedKill);
let sourceUnchanged = false;
try {
  sourceUnchanged =
    reviewGit('rev-parse', 'HEAD').trim() === head &&
    spawnSync('git', ['-C', reviewRoot, 'diff', '--quiet', head, '--'], {
      cwd: root,
      env,
      timeout: 10000,
    }).status === 0;
} catch {
  /* Missing or moved review source cannot qualify. */
}
await Promise.all([finished(stdout), finished(stderr)]);
writeFileSync(
  join(output, 'execution.json'),
  JSON.stringify(
    {
      ...result,
      sourceUnchanged,
      timedOut,
      interrupted,
      finishedAt: new Date().toISOString(),
      qualificationAccepted: false,
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({
    provider,
    ...result,
    timedOut,
    output,
    qualificationAccepted: false,
  }),
);
process.exitCode =
  result.exitCode === 0 && !timedOut && !interrupted && sourceUnchanged ? 0 : 1;
if (imageId) {
  const collected = spawnSync(
    process.execPath,
    [join(root, 'tools/probes/collect-review-evidence.mjs'), output],
    {
      cwd: root,
      env,
      encoding: 'utf8',
      timeout: 60000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  writeFileSync(join(output, 'collection.stdout.txt'), collected.stdout ?? '');
  writeFileSync(join(output, 'collection.stderr.txt'), collected.stderr ?? '');
  if (collected.status !== 0 || collected.error) process.exitCode = 1;
}

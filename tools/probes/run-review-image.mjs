#!/usr/bin/env node
// Run the real candidate-image CLI with the caller's native authentication.
// No image publication, copied rotating login, fake model or production dispatch.
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runImageContainer } from './qualification-container.mjs';
import {
  CLAUDE_TOKEN_SECRET,
  ensureCodexLoginOutlivesRun,
  nativeAuthMounts,
} from './review-auth-mounts.mjs';

const [provider, pull, imageId, output, historical] = process.argv.slice(2);
if (
  !['claude', 'codex', 'opencode', 'agy'].includes(provider) ||
  !/^\d+$/.test(pull ?? '') ||
  !/^sha256:[a-f0-9]{64}$/.test(imageId ?? '') ||
  !output ||
  !isAbsolute(output)
)
  throw new Error(
    'Usage: run-review-image.mjs <provider> <PR> <inspected image ID> <new absolute output> [historical SHA]',
  );
const source = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const command = (binary, args) =>
  execFileSync(binary, args, {
    cwd: source,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  }).trim();
const inspected = JSON.parse(command('docker', ['image', 'inspect', imageId]));
if (inspected.length !== 1 || inspected[0].Id !== imageId)
  throw new Error('Image identity mismatch');
const sourceCommit = command('git', ['rev-parse', 'HEAD']);
if (
  inspected[0].Config.Labels?.['org.opencontainers.image.revision'] !==
  sourceCommit
)
  throw new Error(
    'Candidate image source revision does not match this checkout',
  );
const common = resolve(
  source,
  command('git', ['rev-parse', '--git-common-dir']),
);
const uid = process.getuid(),
  gid = process.getgid();
const paths = [source, common, output, join(homedir(), '.config/gh')];
// Claude authenticates with the fleet's long-lived, non-rotating token, read
// into a private temporary directory that is removed after the run.
let claudeSecretDir;
const claudeTokenFile = () => {
  claudeSecretDir = mkdtempSync(join(tmpdir(), 'lcars-review-secret-'));
  const file = join(claudeSecretDir, 'claude-code-oauth-token');
  const token = process.env.LCARS_REVIEW_CLAUDE_TOKEN_FILE
    ? execFileSync('cat', [process.env.LCARS_REVIEW_CLAUDE_TOKEN_FILE], {
        encoding: 'utf8',
      })
    : execFileSync(
        'gcloud',
        [
          'secrets',
          'versions',
          'access',
          'latest',
          '--secret=' + CLAUDE_TOKEN_SECRET.secret,
          '--project=' + CLAUDE_TOKEN_SECRET.project,
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
      );
  if (!token.trim()) throw new Error('The Claude long-lived token is empty');
  writeFileSync(file, token.trim(), { mode: 0o600 });
  return file;
};
const auth =
  provider === 'codex'
    ? (process.env.CODEX_HOME ?? join(homedir(), '.codex'))
    : provider === 'claude'
      ? claudeTokenFile()
      : provider === 'agy'
        ? join(homedir(), '.gemini/antigravity-cli')
        : process.env.LCARS_REVIEW_OPENCODE_KEY_FILE;
const removeClaudeSecret = () => {
  if (claudeSecretDir)
    rmSync(claudeSecretDir, { recursive: true, force: true });
};
process.on('exit', removeClaudeSecret);
// A signal outside the container window must not leave the token behind.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'])
  process.once(signal, () => {
    removeClaudeSecret();
    process.kill(process.pid, signal);
  });
if (!auth || !existsSync(auth))
  throw new Error('Caller-owned native authentication binding is unavailable');
paths.push(auth);
if (
  paths.some(
    (path) => path.includes(',') || path.includes(':') || !isAbsolute(path),
  )
)
  throw new Error('Unsupported bind-mount path');
const runTimeoutMs = 82 * 60 * 1000;
if (provider === 'codex')
  await ensureCodexLoginOutlivesRun({
    auth,
    runMs: runTimeoutMs,
    // A minimal request in the caller's own Codex home makes Codex refresh
    // and persist the login there, exactly as a live session would.
    refresh: async () => {
      if (!process.env.LCARS_REVIEW_CODEX_MODEL)
        throw new Error('Supply the caller-selected Codex model and effort');
      execFileSync(
        'codex',
        [
          'exec',
          '--skip-git-repo-check',
          '--ignore-user-config',
          '-c',
          'model=' + JSON.stringify(process.env.LCARS_REVIEW_CODEX_MODEL),
          '-c',
          'model_reasoning_effort="low"',
          'Reply with the single word ok.',
        ],
        {
          cwd: tmpdir(),
          env: { ...process.env, CODEX_HOME: auth },
          stdio: ['ignore', 'ignore', 'inherit'],
          timeout: 5 * 60 * 1000,
        },
      );
    },
  });
mkdirSync(output, { mode: 0o700 });
const leaf = join(output, 'run');
const mount = (from, to, readOnly = false) => [
  '--mount',
  `type=bind,source=${from},target=${to}${readOnly ? ',readonly' : ''}`,
];
const env = (name, value) => ['--env', `${name}=${value}`];
const args = [
  '--user',
  '0:0',
  '--cap-drop',
  'ALL',
  '--cap-add',
  'CHOWN',
  '--cap-add',
  'DAC_OVERRIDE',
  '--cap-add',
  'SETUID',
  '--cap-add',
  'SETGID',
  ...mount(source, source, true),
  ...mount(common, common, true),
  ...mount(output, output),
  ...mount(join(homedir(), '.config/gh'), '/native/gh', true),
  ...env('GH_CONFIG_DIR', '/native/gh'),
  ...env('HOME', '/tmp/review-home'),
  ...env('GIT_OPTIONAL_LOCKS', '0'),
  ...env('LCARS_REVIEW_QUALIFICATION_IMAGE_ID', imageId),
  ...env('LCARS_REVIEW_TIMEOUT_SECONDS', '4800'),
];
if (provider === 'opencode')
  args.push(...mount(auth, '/run/secrets/opencode-llm-api-key', true));
else if (provider === 'claude')
  args.push(
    ...mount(auth, CLAUDE_TOKEN_SECRET.target, true),
    ...nativeAuthMounts(
      'claude',
      null,
      join(output, 'native-home'),
      '/native/claude',
    ),
  );
else
  // A private provider home holding only the caller's credential file; the
  // rest of the caller's directory is never mounted (#3379).
  args.push(
    ...nativeAuthMounts(
      provider,
      auth,
      join(output, 'native-home'),
      provider === 'codex' ? auth : '/native/' + provider,
    ),
  );
if (provider === 'codex') {
  const model = process.env.LCARS_REVIEW_CODEX_MODEL,
    effort = process.env.LCARS_REVIEW_CODEX_EFFORT;
  if (!model || !effort)
    throw new Error('Supply the caller-selected Codex model and effort');
  args.push(
    ...env('CODEX_HOME', auth),
    ...env('LCARS_REVIEW_CODEX_ISOLATE', '1'),
    ...env('LCARS_REVIEW_CODEX_MODEL', model),
    ...env('LCARS_REVIEW_CODEX_EFFORT', effort),
  );
}
if (provider === 'claude')
  args.push(...env('CLAUDE_CONFIG_DIR', '/native/claude'));
// Source-controlled positional arguments never become shell source.
const setup = `set -euo pipefail
qual_uid="$1"
qual_gid="$2"
qual_provider="$3"
qual_source="$4"
qual_pull="$5"
qual_output="$6"
shift 6
qual_home=/tmp/review-home
mkdir -p "$qual_home/.config" "$qual_home/.local/share" "$qual_home/.hindsight" "$qual_home/.gemini"
cp -R /home/runner/.config/opencode "$qual_home/.config/opencode"
cp -R /home/runner/.local/share/opencode "$qual_home/.local/share/opencode"
cp /home/runner/.hindsight/coding-agent.json "$qual_home/.hindsight/coding-agent.json"
cp -R /home/runner/.hindsight/coding-agents "$qual_home/.hindsight/coding-agents"
chown -R "$qual_uid:$qual_gid" "$qual_home"
if [ "$qual_provider" = agy ]; then ln -s /native/agy "$qual_home/.gemini/antigravity-cli"; fi
if [ "$qual_provider" = claude ]; then
  CLAUDE_CODE_OAUTH_TOKEN="$(cat ${CLAUDE_TOKEN_SECRET.target})"
  export CLAUDE_CODE_OAUTH_TOKEN
fi
cd "$qual_source"
exec setpriv --reuid="$qual_uid" --regid="$qual_gid" --clear-groups node "$qual_source/tools/probes/qualify-review.mjs" "$qual_provider" "$qual_pull" "$qual_output" "$@"
`;
args.push(
  '--entrypoint',
  'bash',
  imageId,
  '-c',
  setup,
  'review-qualification',
  String(uid),
  String(gid),
  provider,
  source,
  pull,
  leaf,
  ...(historical ? [historical] : []),
);
writeFileSync(
  join(output, 'image.json'),
  JSON.stringify(
    {
      imageId,
      sourceCommit: command('git', ['rev-parse', 'HEAD']),
      uid,
      imageUser: inspected[0].Config.User,
      auth: 'native caller binding; not copied',
      publication: 'captured',
    },
    null,
    2,
  ),
);
try {
  const succeeded = await runImageContainer(
    args,
    async (container, execution) => {
      writeFileSync(
        join(output, 'container.stdout.txt'),
        execution.stdout ?? '',
      );
      writeFileSync(
        join(output, 'container.stderr.txt'),
        execution.stderr ?? '',
      );
      return !execution.error && execution.status === 0;
    },
    {
      timeout: runTimeoutMs,
      cleanupTimeout: 30000,
    },
  );
  if (!succeeded)
    throw new Error(
      'Native candidate review failed; evidence retained at ' + output,
    );
  console.log(JSON.stringify({ provider, imageId, output, completed: true }));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

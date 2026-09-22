#!/usr/bin/env node
// Real CLI, deterministic localhost model, no credentials or GitHub writes.
// This measures interception primitives, NOT full LCARS policy qualification.
import { spawn, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import setup from '../../packages/fleet-tools/bin/worker-hook-setup.cjs';
import policy from '../../packages/fleet-tools/bin/worker-policy.cjs';
import { outcomeFixture } from './outcome-fixture.mjs';
import { publicationCommand } from './publication-fixture.mjs';
import {
  reviewCommand,
  reviewDenial,
  reviewFixture,
} from './review-fixture.mjs';
import { workflowFixture } from './workflow-fixture.mjs';
import {
  expectedFileDenial,
  fileProbeFixture,
  gitPushFixture,
} from './worktree-fixture.mjs';

const [binary, expectedVersion, scenario] = process.argv.slice(2);
if (!binary || !expectedVersion) {
  throw new Error(
    'usage: node opencode-hook-boundary.mjs <absolute-cli-path> <expected-version> [scenario]',
  );
}
const root = mkdtempSync(join(tmpdir(), 'lcars-opencode-hook-probe-'));
const cli = resolve(binary);

function run(args, cwd, env, timeout = 60000) {
  return new Promise((resolveRun) => {
    const child = spawn(cli, args, {
      cwd,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* already exited */
      }
    }, timeout);
    child.stdout.on('data', (chunk) => {
      stdout = (stdout + chunk).slice(-1000000);
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-1000000);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolveRun({ code: null, stdout, stderr: error.message, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolveRun({ code, stdout, stderr, timedOut });
    });
  });
}

const version = await run(
  ['--version'],
  root,
  { PATH: process.env.PATH, HOME: root },
  10000,
);
if (version.code !== 0 || version.stdout.trim() !== expectedVersion) {
  throw new Error(
    `version mismatch: expected ${expectedVersion}, got ${version.stdout.trim()}`,
  );
}

async function probe(mode) {
  const dir = join(root, mode);
  const workspace = join(dir, 'workspace');
  const home = join(dir, 'home');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(home, { recursive: true });
  if (process.env.LCARS_PROBE_OPENCODE_DEPENDENCIES) {
    const config = join(home, '.config/opencode');
    mkdirSync(config, { recursive: true });
    // Image probes consume prepared SDK deps, never credentials or user config.
    for (const name of ['package.json', 'package-lock.json', 'node_modules'])
      cpSync(
        join(process.env.LCARS_PROBE_OPENCODE_DEPENDENCIES, name),
        join(config, name),
        { recursive: true },
      );
  }
  const outcomeProbe = mode.startsWith('bootstrap-outcome-');
  const workflow = mode.startsWith('bootstrap-workflow')
    ? workflowFixture(dir, home, mode)
    : null;
  const outcome = outcomeProbe ? outcomeFixture(mode, dir) : null;
  const fileProbe = mode.startsWith('bootstrap-file-') || outcomeProbe;
  const resumeProbe = mode === 'bootstrap-file-resume';
  let round = 1;
  const holdProbe = mode.startsWith('bootstrap-hold-');
  const publicationProbe = mode.startsWith('bootstrap-publication-');
  const push = mode.startsWith('bootstrap-push-')
    ? gitPushFixture(dir, home, mode)
    : null;
  const reviewReads = join(dir, 'review-reads');
  const ownershipChanged = mode.endsWith('-ownership-changed');
  const ownershipState = join(dir, 'ownership-changed');
  const ownershipReads = join(dir, 'ownership-reads');
  const secondSentinel =
    push?.secondSentinel ?? join(workspace, 'second-effect');
  const files =
    workflow ??
    push ??
    outcome ??
    (fileProbe || holdProbe || publicationProbe
      ? fileProbeFixture(dir, home, mode)
      : null);
  const fileContent =
    workflow?.content ?? outcome?.content ?? 'LCARS_FILE_PROBE\n';
  const sentinel = files?.sentinel ?? join(workspace, 'effect');
  const receipt = join(workspace, 'hook-receipt');
  const plugin = join(workspace, 'probe-plugin.mjs');
  const lineageProbe = mode.startsWith('bootstrap-lineage');
  const lineageRecovery = mode.startsWith('bootstrap-lineage-recovery-');
  const lineageExhausted = mode === 'bootstrap-lineage-recovery-exhausted';
  const lineageReceipt = join(dir, 'lineage.json');
  const bootstrap =
    !!workflow ||
    mode === 'bootstrap-marker' ||
    lineageProbe ||
    fileProbe ||
    holdProbe ||
    publicationProbe ||
    !!push;
  const timeoutProbe = mode.startsWith('policy-timeout-');
  const recovery = mode.startsWith('policy-recovery-') || timeoutProbe;
  const recoveryExhausted = recovery && mode.endsWith('-exhausted');
  const retainedControlWork = join(workspace, 'retained-control-work');
  const controlTiming = join(dir, 'control-timing.json');
  if (recovery)
    writeFileSync(retainedControlWork, 'retain work after control failure\n');
  const usesPolicy = mode.startsWith('policy-') || bootstrap;
  const context = policy.prepareContext(
    outcome?.brief ?? {
      repository: 'octo/example',
      mode: mode.endsWith('-review')
        ? 'review'
        : fileProbe || holdProbe || publicationProbe || push || workflow
          ? 'implement'
          : 'reply',
      anchor: {
        type: mode.endsWith('-review') ? 'pull-request' : 'issue',
        number: 42,
      },
    },
    {
      provider: 'opencode',
      runId: 'octo/example#42/r1',
      attemptId: 'g1:octo/example#42/r1',
      ...(mode === 'bootstrap-file-session-expected-mismatch'
        ? { nativeSessionId: 'unexpected-native-session' }
        : {}),
      ...outcome?.identity,
    },
  );
  const contextPath = join(dir, 'worker-policy-context.json');
  writeFileSync(contextPath, JSON.stringify(context));
  if (recoveryExhausted)
    writeFileSync(`${contextPath}.recovery-used`, context.attemptId);
  const fakeBin = join(dir, 'bin');
  mkdirSync(fakeBin);
  writeFileSync(
    join(fakeBin, 'gh'),
    `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'api' && args[1] === 'graphql') {
  fs.appendFileSync(${JSON.stringify(reviewReads)}, 'read\\n');
  console.log(${JSON.stringify(JSON.stringify(reviewFixture(mode)))});
} else if (args[0] === 'api') {
  ${workflow?.apiSource ?? ''}
  fs.appendFileSync(${JSON.stringify(ownershipReads)}, 'read\\n');
  ${mode === 'policy-failure' || mode.endsWith('-ownership-unreadable') ? 'process.exit(1);' : ''}
  const lost = ${mode === 'policy-deny' || mode.endsWith('-ownership-absent')} || fs.existsSync(${JSON.stringify(ownershipState)});
  console.log(JSON.stringify({state:'open',assignees:lost ? [] : [{login:'agent-lcars-bot'}]}));
} else if (args[0] === 'issue' && args[1] === 'comment') {fs.writeFileSync(${JSON.stringify(sentinel)}, JSON.stringify(args)); console.log('fixture publication');}
else if (args[0] === 'pr' && ['ready','merge'].includes(args[1])) {fs.writeFileSync(${JSON.stringify(sentinel)}, JSON.stringify(args)); console.log('fixture readiness');}
else if (args[0] === 'pr' && args[1] === 'create') {fs.writeFileSync(fs.existsSync(${JSON.stringify(ownershipState)}) ? ${JSON.stringify(secondSentinel)} : ${JSON.stringify(sentinel)}, JSON.stringify(args)); console.log('fixture PR');}
else process.exitCode = 1;
`,
    { mode: 0o700 },
  );
  writeFileSync(
    plugin,
    `import { appendFileSync, writeFileSync } from 'node:fs';
${lineageProbe ? `import { probeLineage, probeLineageRecovery } from ${JSON.stringify(pathToFileURL(resolve('tools/probes/opencode-lineage-fixture.mjs')).href)};` : ''}
export default async (native) => ({
  'tool.execute.before': async (input) => {
    if (${workflow ? "!['write', 'bash'].includes(input.tool)" : `input.tool !== ${JSON.stringify(fileProbe ? 'write' : 'bash')}`}) return;
    appendFileSync(${JSON.stringify(receipt)}, JSON.stringify(input) + '\\n');
    ${workflow ? `appendFileSync(${JSON.stringify(workflow.eventsPath)}, JSON.stringify(input) + '\\n');` : ''}
    ${lineageProbe ? `writeFileSync(${JSON.stringify(lineageReceipt)}, JSON.stringify(await ${lineageRecovery ? `probeLineageRecovery(native, input.sessionID, ${lineageExhausted})` : 'probeLineage(native, input.sessionID)'}));` : ''}
    ${lineageExhausted ? "throw new Error('LCARS control execution failed; preserve work and report an infrastructure failure; do not fabricate a human blocker or PARK.');" : ''}
    ${mode === 'deny' ? "throw new Error('LCARS_PROBE_DENY');" : ''}
    ${mode === 'failure' ? "throw new Error('LCARS_PROBE_DEPENDENCY_UNAVAILABLE');" : ''}
  }
});
`,
  );
  const failedHandler = join(dir, 'failed-handler.cjs');
  if (recovery)
    writeFileSync(
      failedHandler,
      `
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const payload = fs.readFileSync(0, 'utf8');
const marker = __filename + '.started';
if (!fs.existsSync(marker)) {
  fs.writeFileSync(marker, 'started');
  ${timeoutProbe ? "process.on('SIGTERM', () => {}); while (true) {}" : "throw new Error('LCARS_INJECTED_CONTROL_CRASH');"}
}
const result = spawnSync(process.execPath, [${JSON.stringify(resolve('packages/fleet-tools/bin/worker-policy.cjs'))}], {input:payload,encoding:'utf8',timeout:3000});
process.stdout.write(result.stdout || '');
process.exit(result.status ?? 1);
`,
    );
  if (usesPolicy && !bootstrap)
    writeFileSync(
      plugin,
      `import {appendFileSync} from 'node:fs';
import workerPolicy from ${JSON.stringify(pathToFileURL(resolve('packages/fleet-tools/bin/worker-opencode-plugin.mjs')).href)};
import bridge from ${JSON.stringify(pathToFileURL(resolve('packages/fleet-tools/bin/worker-hook-bridge.cjs')).href)};
export default async (context) => {
  const hooks = await workerPolicy(context);
  return {'tool.execute.before': async (input, output) => {
    appendFileSync(${JSON.stringify(receipt)}, JSON.stringify(input) + '\\n');
    ${
      recovery
        ? `
    const original = bridge.invoke;
    const started = Date.now();
    bridge.invoke = (_handler, payload, options) => original(${JSON.stringify(failedHandler)}, payload, options);
    try { await hooks['tool.execute.before'](input, output); }
    finally { bridge.invoke = original; appendFileSync(${JSON.stringify(controlTiming)}, JSON.stringify({elapsedMs:Date.now()-started}) + '\\n'); }
    `
        : "await hooks['tool.execute.before'](input, output);"
    }
  }};
};
`,
    );
  let issued = false,
    secondIssued = false;
  let requests = 0;
  let toolFeedback = '';
  let returnedToolResult = false;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    try {
      const input = JSON.parse(body);
      toolFeedback += JSON.stringify(input.messages ?? []);
      requests++;
      returnedToolResult ||=
        input.messages?.some((message) => message.role === 'tool') ?? false;
      // Auxiliary title requests are text-only and must not consume the tool call.
      const workflowStep = workflow?.next(input.messages ?? []);
      const fileAction = fileProbe || workflowStep?.kind === 'write';
      const toolName = fileAction ? 'write' : 'bash';
      const second =
        ownershipChanged && issued && !secondIssued && returnedToolResult;
      if (second)
        writeFileSync(
          ownershipState,
          'ownership changed after first tool result',
        );
      const tool =
        (workflow ? !!workflowStep : !issued || second) &&
        input.tools?.some((entry) => entry.function?.name === toolName);
      if (tool) {
        if (workflow) {
          workflow.issued(`probe-call-${requests}`);
          issued = true;
        } else if (second) secondIssued = true;
        else issued = true;
      }
      const delta = tool
        ? {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: `probe-call-${requests}`,
                type: 'function',
                function: {
                  name: toolName,
                  arguments: JSON.stringify(
                    fileAction
                      ? {
                          filePath:
                            second || round === 2
                              ? secondSentinel
                              : files.target,
                          content: fileContent,
                        }
                      : {
                          command: workflow
                            ? workflowStep?.command
                            : push
                              ? push.command(second)
                              : publicationProbe
                                ? publicationCommand(mode, context)
                                : holdProbe
                                  ? reviewCommand(mode)
                                  : usesPolicy
                                    ? 'gh issue comment 42 --repo octo/example --body "Fixture deliverable"'
                                    : `touch '${sentinel}'`,
                          description: 'Create harmless probe sentinel',
                        },
                  ),
                },
              },
            ],
          }
        : { role: 'assistant', content: 'Probe complete.' };
      const frame = (delta, finish_reason) => ({
        id: 'probe',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'probe',
        choices: [{ index: 0, delta, finish_reason }],
      });
      const frames = [
        frame(delta, null),
        frame({}, tool ? 'tool_calls' : 'stop'),
      ];
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(
        frames.map((value) => `data: ${JSON.stringify(value)}\n\n`).join('') +
          'data: [DONE]\n\n',
      );
    } catch {
      res.writeHead(400);
      res.end('invalid probe request');
    }
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  writeFileSync(
    join(workspace, 'opencode.json'),
    JSON.stringify({
      plugin: mode === 'missing' || (usesPolicy && !bootstrap) ? [] : [plugin],
      permission: { '*': 'allow' },
      provider: {
        probe: {
          npm: '@ai-sdk/openai-compatible',
          name: 'Local probe',
          options: {
            baseURL: `http://127.0.0.1:${server.address().port}/v1`,
            apiKey: 'local-placeholder',
          },
          models: {
            test: { name: 'probe', limit: { context: 32000, output: 4096 } },
          },
        },
      },
    }),
  );
  if (bootstrap) {
    const briefPath = join(dir, 'brief.json');
    writeFileSync(
      briefPath,
      JSON.stringify({
        repository: context.repository,
        mode: context.mode,
        anchor: context.anchor,
      }),
    );
    const options = {
      provider: 'opencode',
      configPath: join(workspace, 'opencode.json'),
      contextPath,
      briefPath,
      runId: context.runId,
      attemptId: context.attemptId,
      nativeSessionId: context.nativeSessionId,
      nativeOutcomePath: context.nativeOutcomePath,
    };
    await setup.bootstrapWorker(options);
    if ((await setup.bootstrapWorker(options)).changed)
      throw new Error('Bootstrap was not idempotent');
    if (existsSync(`${contextPath}.session.json`))
      throw new Error('Setup smoke consumed native worker binding');
    if (mode === 'bootstrap-file-session-bound-mismatch')
      writeFileSync(
        `${contextPath}.session.json`,
        JSON.stringify({
          provider: 'opencode',
          runId: context.runId,
          attemptId: context.attemptId,
          sessionId: 'another-native-session',
        }),
      );
  } else if (usesPolicy) {
    setup.installOpenCode(join(workspace, 'opencode.json'), plugin);
    if (setup.installOpenCode(join(workspace, 'opencode.json'), plugin).changed)
      throw new Error('Setup was not idempotent');
  }
  writeFileSync(join(dir, 'models.json'), '{}');
  const args = [
    'run',
    '--model',
    'probe/test',
    '--auto',
    '--dir',
    workspace,
    'Execute the supplied probe tool call, then finish.',
  ];
  const env = {
    PATH: usesPolicy ? `${fakeBin}:${process.env.PATH}` : process.env.PATH,
    ...(usesPolicy
      ? { LCARS_RUN_ID: context.runId, LCARS_WORKER_CONTEXT: contextPath }
      : {}),
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(dir, 'data'),
    XDG_CACHE_HOME: join(dir, 'cache'),
    XDG_STATE_HOME: join(dir, 'state'),
    OPENCODE_DISABLE_AUTOUPDATE: 'true',
    OPENCODE_DISABLE_MODELS_FETCH: 'true',
    OPENCODE_DISABLE_TERMINAL_TITLE: 'true',
    OPENCODE_MODELS_PATH: join(dir, 'models.json'),
    ...workflow?.env,
  };
  const completionBefore = workflow?.completion(context, env, 'before');
  let execution;
  let resumedSameSession = false;
  const deadline = Date.now() + (workflow?.budgetMs ?? 60000);
  try {
    execution = await run(
      args,
      workspace,
      env,
      Math.max(1, deadline - Date.now()),
    );
    if (workflow && existsSync(receipt)) {
      const sessionId = JSON.parse(
        readFileSync(receipt, 'utf8').trim().split('\n')[0],
      ).sessionID;
      await workflow.correct(
        context,
        env,
        execution,
        deadline,
        async (prompt, remaining) => {
          const resumed = await run(
            [...args.slice(0, -1), '--session', sessionId, prompt],
            workspace,
            env,
            remaining,
          );
          writeFileSync(join(dir, 'resume-stdout.txt'), resumed.stdout);
          writeFileSync(join(dir, 'resume-stderr.txt'), resumed.stderr);
          return resumed;
        },
      );
    }
    if (
      resumeProbe &&
      execution.code === 0 &&
      !execution.timedOut &&
      existsSync(sentinel) &&
      existsSync(receipt)
    ) {
      const originalSession = JSON.parse(
        readFileSync(receipt, 'utf8').trim().split('\n')[0],
      ).sessionID;
      const binding = readFileSync(`${contextPath}.session.json`, 'utf8');
      round = 2;
      issued = false;
      returnedToolResult = false;
      const resumed = await run(
        [
          ...args.slice(0, -1),
          '--session',
          originalSession,
          'Continue this same probe session with the supplied second tool call.',
        ],
        workspace,
        env,
        Math.max(1, deadline - Date.now()),
      );
      writeFileSync(join(dir, 'resume-stdout.txt'), resumed.stdout);
      writeFileSync(join(dir, 'resume-stderr.txt'), resumed.stderr);
      const events = readFileSync(receipt, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      resumedSameSession =
        resumed.code === 0 &&
        !resumed.timedOut &&
        existsSync(secondSentinel) &&
        readFileSync(secondSentinel, 'utf8') === fileContent &&
        events.length === 2 &&
        events.every((event) => event.sessionID === originalSession) &&
        readFileSync(`${contextPath}.session.json`, 'utf8') === binding;
    }
  } finally {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
  writeFileSync(join(dir, 'stdout.txt'), execution.stdout);
  writeFileSync(join(dir, 'stderr.txt'), execution.stderr);
  const hookInvoked =
    existsSync(receipt) && readFileSync(receipt, 'utf8').trim().length > 0;
  const effect =
    existsSync(sentinel) &&
    (!fileProbe || readFileSync(sentinel, 'utf8') === fileContent);
  let markerRepaired = false;
  if (usesPolicy && !fileProbe && !holdProbe && !push && effect) {
    const published = JSON.parse(readFileSync(sentinel, 'utf8'));
    markerRepaired =
      published[published.indexOf('--body') + 1] ===
      `Fixture deliverable\n\n<!-- attempt-claim:${context.attemptId} -->`;
  }
  const exercised =
    execution.code === 0 && !execution.timedOut && issued && returnedToolResult;
  const nativeBinding = existsSync(`${contextPath}.session.json`)
    ? JSON.parse(readFileSync(`${contextPath}.session.json`, 'utf8'))
    : null;
  const sessionBindingVerified =
    !usesPolicy ||
    (mode === 'bootstrap-file-session-expected-mismatch'
      ? nativeBinding === null
      : existsSync(receipt) &&
        nativeBinding?.sessionId ===
          (mode === 'bootstrap-file-session-bound-mismatch'
            ? 'another-native-session'
            : JSON.parse(readFileSync(receipt, 'utf8').trim().split('\n')[0])
                .sessionID));
  const ownershipReadCount = existsSync(ownershipReads)
    ? readFileSync(ownershipReads, 'utf8').trim().split('\n').length
    : 0;
  const completionAfter = workflow?.completion(context, env, 'after');
  const workflowResult = workflow?.verify(context, nativeBinding?.sessionId);
  const ownershipChangeVerified =
    ownershipChanged &&
    effect &&
    secondIssued &&
    !existsSync(secondSentinel) &&
    ownershipReadCount === 2;
  const expectedDenial =
    lineageExhausted || recoveryExhausted
      ? 'infrastructure failure'
      : outcome
        ? outcome.denial
        : holdProbe
          ? reviewDenial(mode)
          : fileProbe || publicationProbe || push
            ? expectedFileDenial(mode)
            : '';
  const reviewReadCount = existsSync(reviewReads)
    ? readFileSync(reviewReads, 'utf8').trim().split('\n').length
    : 0;
  const denialReasonObserved =
    !expectedDenial || toolFeedback.includes(expectedDenial);
  const recoveryVerified =
    recovery &&
    existsSync(`${contextPath}.recovery-used`) &&
    existsSync(`${contextPath}.recovery-succeeded`) === !recoveryExhausted &&
    existsSync(`${contextPath}.control-failed`) === recoveryExhausted;
  const retainedWorkVerified =
    !recovery ||
    readFileSync(retainedControlWork, 'utf8') ===
      'retain work after control failure\n';
  const controlElapsedMs = existsSync(controlTiming)
    ? JSON.parse(readFileSync(controlTiming, 'utf8').trim()).elapsedMs
    : null;
  const providerApiLineageVerified =
    existsSync(lineageReceipt) &&
    JSON.parse(readFileSync(lineageReceipt, 'utf8'))
      .providerApiLineageVerified === true;
  const runnerFailureRecognized =
    (lineageRecovery || recovery) &&
    spawnSync(
      'bash',
      [
        '-c',
        'source ./apps/runner-autoscaler/runner-image/runtime/worker-policy-bootstrap.sh; worker_control_failed',
      ],
      {
        cwd: resolve('.'),
        env: {
          PATH: process.env.PATH,
          RUNNER_TEMP: dir,
          LCARS_WORKER_CONTEXT: contextPath,
          ATTEMPT_ID: context.attemptId,
        },
      },
    ).status === 0;
  return {
    mode,
    requests,
    issued,
    returnedToolResult,
    hookInvoked,
    effect,
    markerRepaired,
    recoveryVerified,
    retainedWorkVerified,
    controlElapsedMs,
    ownershipReadCount,
    ownershipChangeVerified,
    denialReasonObserved,
    sessionBindingVerified,
    providerApiLineageVerified,
    runnerFailureRecognized,
    resumedSameSession: workflowResult?.correction?.resumed
      ? workflowResult.sameNativeSession
      : resumedSameSession,
    reviewReadCount,
    pushVerified: push?.verify() ?? false,
    workflow: workflowResult,
    completionBefore,
    completionAfter,
    code: execution.code,
    timedOut: execution.timedOut,
    exercised,
    // Missing-hook case intentionally exposes lack of native admission.
    observedExpectedPrimitive:
      exercised &&
      denialReasonObserved &&
      sessionBindingVerified &&
      (!outcomeProbe || ownershipReadCount === 0) &&
      (!push ||
        (hookInvoked &&
          push.verify() &&
          ownershipReadCount ===
            (mode.endsWith('-review') || mode.endsWith('-primary')
              ? 0
              : ownershipChanged
                ? 2
                : 1))) &&
      (!publicationProbe ||
        (hookInvoked &&
          ownershipReadCount ===
            (mode.endsWith('-review') || mode.endsWith('-marker-foreign')
              ? 0
              : ownershipChanged
                ? 2
                : 1) &&
          effect === (mode.endsWith('-allow') || ownershipChanged) &&
          (!effect || markerRepaired))) &&
      (!lineageProbe || providerApiLineageVerified) &&
      (!lineageRecovery || runnerFailureRecognized === lineageExhausted) &&
      (!resumeProbe || resumedSameSession) &&
      (!recovery || recoveryVerified) &&
      (!recovery ||
        (retainedWorkVerified &&
          runnerFailureRecognized === recoveryExhausted)) &&
      (!timeoutProbe ||
        (controlElapsedMs >= 4500 && controlElapsedMs < 15000)) &&
      (workflow
        ? workflowResult.passed &&
          completionBefore.code === 1 &&
          completionBefore.missing &&
          completionAfter.code === (workflow.expectPublication ? 0 : 1) &&
          completionAfter.missing === !workflow.expectPublication &&
          markerRepaired === workflow.expectPublication &&
          ownershipReadCount === (workflow.expectPublication ? 5 : 4)
        : lineageExhausted
          ? hookInvoked && !effect
          : holdProbe
            ? hookInvoked &&
              reviewReadCount === 1 &&
              effect === mode.endsWith('-released')
            : ownershipChanged
              ? hookInvoked && ownershipChangeVerified
              : publicationProbe || push
                ? hookInvoked
                : fileProbe
                  ? hookInvoked &&
                    effect === (mode.endsWith('-allow') || resumeProbe)
                  : mode === 'policy-marker' ||
                      bootstrap ||
                      (recovery && !recoveryExhausted)
                    ? hookInvoked && effect && markerRepaired
                    : mode === 'missing'
                      ? !hookInvoked && effect
                      : hookInvoked && effect === (mode === 'allow')),
  };
}

const observations = [];
const modes = [
  'bootstrap-workflow',
  'bootstrap-workflow-correction',
  'bootstrap-workflow-exhausted',
  'allow',
  'deny',
  'failure',
  'missing',
  'policy-marker',
  'policy-deny',
  'policy-failure',
  'bootstrap-marker',
  'policy-recovery-success',
  'policy-recovery-exhausted',
  'policy-timeout-success',
  'policy-timeout-exhausted',
  'bootstrap-file-allow',
  'bootstrap-file-primary',
  'bootstrap-file-symlink',
  'bootstrap-file-review',
  'bootstrap-file-ownership-absent',
  'bootstrap-file-ownership-unreadable',
  'bootstrap-file-ownership-changed',
  'bootstrap-file-session-expected-mismatch',
  'bootstrap-file-session-bound-mismatch',
  'bootstrap-hold-draft-blocked',
  'bootstrap-hold-draft-released',
  'bootstrap-hold-merge-blocked',
  'bootstrap-hold-merge-released',
  'bootstrap-hold-draft-threads',
  'bootstrap-outcome-park-allow',
  'bootstrap-outcome-no-op-allow',
  'bootstrap-outcome-foreign',
  'bootstrap-outcome-unrelated',
  'bootstrap-lineage',
  'bootstrap-file-resume',
  'bootstrap-lineage-recovery-success',
  'bootstrap-lineage-recovery-exhausted',
  'bootstrap-publication-allow',
  'bootstrap-publication-review',
  'bootstrap-publication-ownership-absent',
  'bootstrap-publication-ownership-unreadable',
  'bootstrap-publication-ownership-changed',
  'bootstrap-publication-marker-idempotent-allow',
  'bootstrap-publication-marker-foreign',
  'bootstrap-push-allow',
  'bootstrap-push-review',
  'bootstrap-push-primary',
  'bootstrap-push-ownership-absent',
  'bootstrap-push-ownership-unreadable',
  'bootstrap-push-ownership-changed',
];
if (scenario && !modes.includes(scenario))
  throw new Error(`Unknown scenario: ${scenario}`);
for (const mode of scenario ? [scenario] : modes)
  observations.push(await probe(mode));
const report = {
  provider: 'opencode',
  providerVersion: expectedVersion,
  qualification: 'not-evaluated',
  observations,
  evidenceDirectory: root,
};
writeFileSync(join(root, 'observations.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exitCode = observations.every((item) => item.observedExpectedPrimitive)
  ? 0
  : 1;

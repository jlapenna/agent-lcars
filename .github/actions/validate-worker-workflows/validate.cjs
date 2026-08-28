'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { parse: parseYaml } = require('yaml');

const PROVIDERS = ['claude', 'codex', 'opencode'];
const EXPECTED_INPUTS = [
  'issue',
  'work',
  'mode',
  'reply',
  'runbook',
  'context',
  'broker_intent_id',
  'broker_generation',
  'broker_dispatch_token',
];
const ANCHOR_UNION = "(inputs.issue!=''||inputs.work!='')";
const WORKER_ADMISSION = `github.event_name=='workflow_dispatch'&&${ANCHOR_UNION}`;
const FALLBACK_ADMISSION = `always()&&${WORKER_ADMISSION}`;
const RUN_NAME_ANCHOR_PREFIX =
  "${{inputs.issue!=''&&format('#{0}',inputs.issue)||'nativework'}}:";

function normalizeExpression(value) {
  return typeof value === 'string'
    ? value
        .replaceAll('github.event.inputs', 'inputs')
        .replaceAll('""', "''")
        .replace(/\s+/gu, '')
    : '';
}

function hasAnchorUnion(value, fallback) {
  return (
    normalizeExpression(value) ===
    (fallback ? FALLBACK_ADMISSION : WORKER_ADMISSION)
  );
}

function forwardsWork(value) {
  return normalizeExpression(value) === '${{inputs.work}}';
}

function hasNativeRunName(value) {
  return normalizeExpression(value).startsWith(RUN_NAME_ANCHOR_PREFIX);
}

function concurrencyGroup(concurrency) {
  if (typeof concurrency === 'string') return concurrency;
  if (concurrency && typeof concurrency === 'object') {
    return concurrency.group;
  }
  return undefined;
}

function hasNativeUniqueConcurrencyKey(value) {
  if (typeof value !== 'string') return false;

  // A plain group containing the text `inputs.work` is still one constant
  // group, as is an interpolation whose only occurrence is inside a quoted
  // string. Require an actual input dereference inside a GitHub expression.
  for (const match of value.matchAll(/\$\{\{([\s\S]*?)\}\}/gu)) {
    const expression = match[1].replaceAll('github.event.inputs', 'inputs');
    const code = expression.replace(/'(?:[^']|'')*'|"(?:[^"\\]|\\.)*"/gu, '');
    if (/\binputs\.(?:broker_intent_id|work)\b/u.test(code)) return true;
  }
  return false;
}

function validateWorkflow(provider, file, document) {
  const errors = [];
  const workflowDispatch = document?.on?.workflow_dispatch;
  const inputs = workflowDispatch?.inputs;

  if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) {
    return [`${file}: on.workflow_dispatch.inputs must be a mapping`];
  }

  const declaredInputs = Object.keys(inputs);
  if (declaredInputs.length !== EXPECTED_INPUTS.length) {
    errors.push(
      `${file}: workflow_dispatch must declare exactly ${EXPECTED_INPUTS.length} inputs; found ${declaredInputs.length}`,
    );
  }
  const missingInputs = EXPECTED_INPUTS.filter(
    (name) => !Object.hasOwn(inputs, name),
  );
  const unexpectedInputs = declaredInputs.filter(
    (name) => !EXPECTED_INPUTS.includes(name),
  );
  if (missingInputs.length > 0 || unexpectedInputs.length > 0) {
    errors.push(
      `${file}: workflow_dispatch input set mismatch` +
        `${missingInputs.length > 0 ? `; missing ${missingInputs.join(', ')}` : ''}` +
        `${unexpectedInputs.length > 0 ? `; unexpected ${unexpectedInputs.join(', ')}` : ''}`,
    );
  }

  for (const anchor of ['issue', 'work']) {
    const input = inputs[anchor];
    if (!input || typeof input !== 'object') {
      errors.push(`${file}: input ${anchor} must be declared as a mapping`);
      continue;
    }
    if (input.required === true) {
      errors.push(`${file}: input ${anchor} must be optional`);
    }
    if (input.default !== '') {
      errors.push(`${file}: input ${anchor} must default to an empty string`);
    }
  }

  if (!hasNativeRunName(document['run-name'])) {
    errors.push(
      `${file}: run-name must select a native work label when issue is empty`,
    );
  }

  const jobs = document.jobs;
  const worker = jobs?.[provider];
  const fallback = jobs?.['fallback-finalize'];
  for (const [name, job, isFallback] of [
    [provider, worker, false],
    ['fallback-finalize', fallback, true],
  ]) {
    if (!job || typeof job !== 'object') {
      errors.push(`${file}: jobs.${name} must exist`);
      continue;
    }
    if (!hasAnchorUnion(job.if, isFallback)) {
      errors.push(
        `${file}: jobs.${name}.if must use the canonical issue-or-work admission`,
      );
    }
    if (!forwardsWork(job.with?.work)) {
      errors.push(
        `${file}: jobs.${name}.with.work must forward the workflow work input`,
      );
    }
    if (name === provider && Object.hasOwn(job.with ?? {}, 'prompt')) {
      errors.push(
        `${file}: jobs.${name}.with.prompt must be omitted so the shared lane owns canonical prompt construction`,
      );
    }
  }

  if (document.concurrency !== undefined) {
    const group = concurrencyGroup(document.concurrency);
    if (!hasNativeUniqueConcurrencyKey(group)) {
      errors.push(
        `${file}: workflow-level concurrency.group must include inputs.broker_intent_id or inputs.work so native runs do not share an empty issue key`,
      );
    }
  }

  return errors;
}

function escapeAnnotation(value) {
  return value
    .replaceAll('%', '%25')
    .replaceAll('\r', '%0D')
    .replaceAll('\n', '%0A');
}

function main() {
  const workspace = path.resolve(
    process.argv[2] || process.env.GITHUB_WORKSPACE || process.cwd(),
  );
  const errors = [];

  for (const provider of PROVIDERS) {
    const relativeFile = `.github/workflows/${provider}.yml`;
    const file = path.join(workspace, relativeFile);
    let source;
    try {
      source = fs.readFileSync(file, 'utf8');
    } catch (error) {
      errors.push(`${relativeFile}: ${error.message}`);
      continue;
    }

    try {
      const document = parseYaml(source);
      errors.push(...validateWorkflow(provider, relativeFile, document));
    } catch (error) {
      errors.push(`${relativeFile}: invalid YAML: ${error.message}`);
    }
  }

  if (errors.length > 0) {
    for (const error of errors) {
      if (process.env.GITHUB_ACTIONS === 'true') {
        process.stderr.write(`::error::${escapeAnnotation(error)}\n`);
      } else {
        process.stderr.write(`ERROR: ${error}\n`);
      }
    }
    process.exitCode = 1;
    return;
  }

  process.stdout.write(
    'Validated Claude, Codex, and OpenCode issue/native-work workflow contracts.\n',
  );
}

main();

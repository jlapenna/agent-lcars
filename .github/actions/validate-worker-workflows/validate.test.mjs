import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

const actionDirectory = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(actionDirectory, '../../..');
const sourceValidator = path.join(actionDirectory, 'validate.cjs');
const bundledValidator = path.join(actionDirectory, 'dist/validate.cjs');
const providers = ['claude', 'codex', 'opencode'];

function fixture() {
  const directory = mkdtempSync(
    path.join(os.tmpdir(), 'validate-worker-workflows-'),
  );
  const workflows = path.join(directory, '.github/workflows');
  mkdirSync(workflows, { recursive: true });
  for (const provider of providers) {
    copyFileSync(
      path.join(repository, `.github/workflows/${provider}.yml`),
      path.join(workflows, `${provider}.yml`),
    );
  }
  return directory;
}

function runValidator(validator, directory) {
  return spawnSync(process.execPath, [validator, directory], {
    encoding: 'utf8',
  });
}

function mutate(directory, provider, change) {
  const file = path.join(directory, `.github/workflows/${provider}.yml`);
  const document = parseYaml(readFileSync(file, 'utf8'));
  change(document);
  writeFileSync(file, stringifyYaml(document));
}

function expectFailure(name, provider, change, expected) {
  const directory = fixture();
  try {
    mutate(directory, provider, change);
    const result = runValidator(sourceValidator, directory);
    assert.notEqual(result.status, 0, `${name} must fail`);
    assert.match(
      result.stderr,
      expected,
      `${name} must report the violated contract`,
    );
    process.stdout.write(`ok - mutation: ${name}\n`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

{
  const directory = fixture();
  try {
    for (const validator of [sourceValidator, bundledValidator]) {
      const result = runValidator(validator, directory);
      assert.equal(result.status, 0, result.stderr);
    }
    process.stdout.write(
      'ok - real provider workflows pass source and bundle\n',
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

expectFailure(
  'required issue input',
  'claude',
  (document) => {
    document.on.workflow_dispatch.inputs.issue.required = true;
  },
  /input issue must be optional/u,
);
expectFailure(
  'missing empty issue default',
  'codex',
  (document) => {
    delete document.on.workflow_dispatch.inputs.issue.default;
  },
  /input issue must default to an empty string/u,
);
expectFailure(
  'non-empty work default',
  'opencode',
  (document) => {
    document.on.workflow_dispatch.inputs.work.default = '{}';
  },
  /input work must default to an empty string/u,
);
expectFailure(
  'unexpected tenth dispatch input',
  'claude',
  (document) => {
    document.on.workflow_dispatch.inputs.extra = { required: false };
  },
  /must declare exactly 9 inputs/u,
);
expectFailure(
  'issue-only worker admission',
  'codex',
  (document) => {
    document.jobs.codex.if =
      "github.event_name == 'workflow_dispatch' && inputs.issue != ''";
  },
  /jobs\.codex\.if must admit an issue or a native work item/u,
);
expectFailure(
  'issue-only fallback admission',
  'opencode',
  (document) => {
    document.jobs['fallback-finalize'].if = "always() && inputs.issue != ''";
  },
  /jobs\.fallback-finalize\.if must admit an issue or a native work item/u,
);
expectFailure(
  'worker drops work forwarding',
  'claude',
  (document) => {
    delete document.jobs.claude.with.work;
  },
  /jobs\.claude\.with\.work must forward/u,
);
expectFailure(
  'fallback drops work forwarding',
  'codex',
  (document) => {
    delete document.jobs['fallback-finalize'].with.work;
  },
  /jobs\.fallback-finalize\.with\.work must forward/u,
);
expectFailure(
  'caller overrides the shared prompt',
  'claude',
  (document) => {
    document.jobs.claude.with.prompt = 'Use the caller-specific protocol';
  },
  /jobs\.claude\.with\.prompt must be omitted/u,
);
expectFailure(
  'issue-only run name',
  'opencode',
  (document) => {
    document['run-name'] =
      '#${{ inputs.issue }}: OpenCode issue agent [dispatch:g${{ inputs.broker_generation }}:${{ inputs.broker_intent_id }}]';
  },
  /run-name must select a native work label/u,
);
expectFailure(
  'workflow concurrency collapses native runs',
  'claude',
  (document) => {
    document.concurrency = {
      group: 'claude-issue-${{ inputs.issue }}',
      'cancel-in-progress': false,
    };
  },
  /workflow-level concurrency\.group must include/u,
);

{
  const directory = fixture();
  try {
    mutate(directory, 'claude', (document) => {
      document.concurrency = {
        group:
          "claude-${{ inputs.issue != '' && inputs.issue || inputs.broker_intent_id }}",
        'cancel-in-progress': false,
      };
      document.jobs.claude.with['provider-specific-future-option'] = true;
    });
    const result = runValidator(sourceValidator, directory);
    assert.equal(result.status, 0, result.stderr);
    process.stdout.write(
      'ok - native-unique concurrency and provider-specific options pass\n',
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

{
  const generatedDirectory = mkdtempSync(
    path.join(os.tmpdir(), 'validate-worker-bundle-'),
  );
  const generated = path.join(generatedDirectory, 'validate.cjs');
  try {
    const buildResult = spawnSync(
      process.execPath,
      [path.join(actionDirectory, 'build.mjs'), generated],
      { encoding: 'utf8' },
    );
    assert.equal(buildResult.status, 0, buildResult.stderr);
    assert.deepEqual(
      readFileSync(generated),
      readFileSync(bundledValidator),
      'dist/validate.cjs must be regenerated after source changes',
    );
    process.stdout.write('ok - published bundle is current\n');
  } finally {
    rmSync(generatedDirectory, { recursive: true, force: true });
  }
}

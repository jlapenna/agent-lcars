#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

import { discover } from './catalog.mjs';
import { JobController } from './controller.mjs';
import { dueAt } from './definition.mjs';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    checkout: { type: 'string' },
    repository: { type: 'string' },
    ref: { type: 'string', default: 'HEAD' },
    job: { type: 'string' },
    at: { type: 'string' },
    state: { type: 'string' },
    profile: { type: 'string' },
    result: { type: 'string' },
    request: { type: 'string' },
    export: { type: 'string' },
  },
});

async function main() {
  const command = positionals[0];
  if (command === 'history') {
    if (!values.state) throw new Error('--state is required');
    const controller = new JobController(values.state);
    try {
      return controller.list();
    } finally {
      controller.close();
    }
  }
  if (
    !['validate', 'due', 'simulate'].includes(command) ||
    !values.checkout ||
    !values.repository
  ) {
    throw new Error(
      'Usage: node tools/jobs/cli.mjs validate|due|simulate --checkout PATH --repository OWNER/REPO [--ref COMMIT]; history --state DB',
    );
  }
  const catalog = discover(values.checkout, values.repository, values.ref);
  if (command === 'validate') {
    if (catalog.errors.length) process.exitCode = 1;
    return {
      repository: catalog.repository,
      revision: catalog.revision,
      jobs: catalog.jobs.map(({ id, digest, job }) => ({
        id,
        digest,
        description: job.description,
      })),
      errors: catalog.errors,
    };
  }
  if (catalog.errors.length)
    throw new Error(
      `invalid repository jobs: ${JSON.stringify(catalog.errors)}`,
    );
  if (command === 'due') {
    if (!values.at)
      throw new Error(
        '--at is required; this command never starts a scheduler',
      );
    return catalog.jobs.map((def) => ({
      id: def.id,
      revision: def.revision,
      due: dueAt(def, new Date(values.at)),
    }));
  }
  if (
    !values.state ||
    !values.profile ||
    !values.result ||
    !values.request ||
    !values.job
  ) {
    throw new Error(
      'simulate requires --job NAME --state DB --profile JSON --result JSON --request ID',
    );
  }
  const def = catalog.jobs.find((entry) => entry.name === values.job);
  if (!def) throw new Error('job not found');
  const profile = JSON.parse(await readFile(values.profile, 'utf8'));
  const resultText = await readFile(values.result, 'utf8');
  if (Buffer.byteLength(resultText) > 1024 * 1024)
    throw new Error('result exceeds 1 MiB');
  const result = JSON.parse(resultText);
  const controller = new JobController(values.state);
  try {
    const admission = controller.admit(def, {
      requestId: values.request,
      profile,
    });
    const run =
      admission.outcome === 'admitted'
        ? await controller.execute(admission.run, async () => result)
        : admission.run;
    if (values.export && run.result) {
      await writeFile(
        values.export,
        JSON.stringify(run.result.artifacts, null, 2) + '\n',
        { mode: 0o600 },
      );
    }
    if (run.status !== 'succeeded') process.exitCode = 1;
    return {
      evidence:
        'simulation: supplied result; Goose and network tools were not run',
      admission: admission.outcome,
      run,
      baseline: controller.baseline(def.id)?.id ?? null,
    };
  } finally {
    controller.close();
  }
}

try {
  process.stdout.write(JSON.stringify(await main(), null, 2) + '\n');
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}

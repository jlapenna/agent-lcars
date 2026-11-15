#!/usr/bin/env node
// Paid native qualification is explicit operator work, never a health check.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, '../..');
const [image, output, selected] = process.argv.slice(2);
const cases = JSON.parse(
  readFileSync(join(directory, 'review-cases.json'), 'utf8'),
);
if (
  !/^sha256:[a-f0-9]{64}$/.test(image ?? '') ||
  !isAbsolute(output ?? '') ||
  (selected && !cases.providers.includes(selected))
)
  throw new Error(
    'Usage: qualify-review-matrix.mjs <immutable image ID> <new absolute output> [provider]',
  );
if (
  execFileSync('git', ['status', '--porcelain'], {
    cwd: root,
    encoding: 'utf8',
  }).trim()
)
  throw new Error('Commit the qualification source before running the matrix');
mkdirSync(output, { mode: 0o700 });
const source = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: root,
  encoding: 'utf8',
}).trim();
const results = [];
const active = new Set();
let interrupted = false;
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    interrupted = true;
    for (const child of active) child.kill(signal);
  });
const read = (path) =>
  existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
const persist = () =>
  writeFileSync(
    join(output, 'matrix.json'),
    JSON.stringify(
      {
        image,
        source,
        results,
        complete:
          results.length ===
          (selected ? 1 : cases.providers.length) * cases.cases.length,
        passed:
          results.length ===
            (selected ? 1 : cases.providers.length) * cases.cases.length &&
          results.every((item) => item.passed),
        publication:
          'captured; inspect payloads before any real GitHub publication',
      },
      null,
      2,
    ),
  );
await Promise.all(
  (selected ? [selected] : cases.providers).map(async (provider) => {
    // Providers are independent; each provider's native sessions run serially.
    for (const scenario of cases.cases) {
      if (interrupted) break;
      const destination = join(output, provider + '-' + scenario.id);
      const args = [
        join(directory, 'run-review-image.mjs'),
        provider,
        String(scenario.pullRequest),
        image,
        destination,
        ...(scenario.head === 'candidate' ? [] : [scenario.head]),
      ];
      console.log(
        JSON.stringify({ provider, case: scenario.id, state: 'starting' }),
      );
      const execution = await new Promise((resolveResult) => {
        const child = spawn(process.execPath, args, {
          cwd: root,
          env: process.env,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        active.add(child);
        let stdout = '',
          stderr = '';
        child.stdout.on('data', (chunk) => {
          stdout += chunk;
        });
        child.stderr.on('data', (chunk) => {
          stderr += chunk;
        });
        child.once('error', (error) =>
          resolveResult({
            exitCode: null,
            error: error.message,
            stdout,
            stderr,
          }),
        );
        child.once('close', (exitCode, signal) => {
          active.delete(child);
          resolveResult({ exitCode, signal, stdout, stderr });
        });
      });
      const evaluation = read(join(destination, 'run/evaluation.json'));
      const receipt = read(join(destination, 'run/receipt.json'));
      // This is a minimum regression guard, not a substitute for inspecting the
      // actual candidate, validator evidence and captured inline comments.
      const controlFound =
        scenario.id !== 'unqualified-upstream-update' ||
        (receipt?.validators ?? []).some((validator) => {
          const candidate = receipt?.candidates?.find(
            (item) => item.id === validator.candidateId,
          );
          const evidence = JSON.stringify({
            candidate,
            evidence: validator.evidence,
          });
          return (
            validator.decision === 'confirmed' &&
            /renovate|submodule/i.test(evidence) &&
            /auto.?merge/i.test(evidence) &&
            /qualif|digest/i.test(evidence)
          );
        });
      const row = {
        provider,
        case: scenario.id,
        destination,
        execution,
        evaluation,
        knownDefectDetected:
          scenario.id === 'unqualified-upstream-update' ? controlFound : null,
        passed:
          execution.exitCode === 0 &&
          evaluation?.passed === true &&
          controlFound,
      };
      results.push(row);
      persist();
      console.log(
        JSON.stringify({ provider, case: scenario.id, passed: row.passed }),
      );
      const native = read(join(destination, 'run/native-evidence.json'));
      if (native?.providerFailure === 'provider-limit') break;
    }
  }),
);
persist();
process.exitCode =
  results.length ===
    (selected ? 1 : cases.providers.length) * cases.cases.length &&
  results.every((item) => item.passed)
    ? 0
    : 1;

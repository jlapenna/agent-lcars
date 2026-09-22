// Run the image's actual finalization code against native failure receipts.
// Only the control-plane HTTP transport is local; classification is not copied.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function finalizeNativeFailure(directory, context, env, deadline) {
  const runnerRoot = fileURLToPath(
    new URL('../../apps/runner-autoscaler/runner-image/', import.meta.url),
  );
  const runner = readFileSync(join(runnerRoot, 'direct-runner.sh'), 'utf8');
  const boundary = 'payload_file="$RUNNER_TEMP/complete-payload.json"';
  if (runner.split(boundary).length !== 2)
    throw new Error('Runner finalization boundary must be unambiguous');
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({
      method: req.method,
      path: req.url,
      body: JSON.parse(body),
    });
    res.writeHead(req.method === 'POST' && req.url === '/complete' ? 200 : 404);
    res.end('{}');
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const finalMessage = join(directory, 'failure-last-message.txt');
  // A misleading agent message must not turn an infrastructure failure into PARK.
  writeFileSync(finalMessage, 'PARK: ask a human to repair the control.');
  let result;
  try {
    result = await new Promise((done) => {
      const child = spawn(
        'bash',
        [
          '-c',
          `set -euo pipefail\nsource "$1"\n${runner.slice(runner.indexOf(boundary))}`,
          'native-failure-finalization',
          join(runnerRoot, 'runtime/worker-policy-bootstrap.sh'),
        ],
        {
          env: {
            ...env,
            RUNNER_TEMP: directory,
            ATTEMPT_ID: context.attemptId,
            LCARS_WORKER_CONTEXT: join(directory, 'worker-policy-context.json'),
            OUTCOME: 'no-deliverable',
            OUTCOME_REFERENCE: 'null',
            LAST_MESSAGE_FILE: finalMessage,
            RUNS_API: `http://127.0.0.1:${server.address().port}`,
            AUTH_HEADER: 'Authorization: Bearer local-fixture-only',
            CURL_TIMEOUT_CONFIG: 'connect-timeout = 2\nmax-time = 5',
          },
          timeout: Math.max(1, Math.min(10000, deadline - Date.now())),
        },
      );
      let stdout = '',
        stderr = '';
      child.stdout.on('data', (value) => {
        stdout += value;
      });
      child.stderr.on('data', (value) => {
        stderr += value;
      });
      child.on('error', (error) => done({ code: null, error: error.message }));
      child.on('close', (code, signal) =>
        done({ code, signal, stdout, stderr }),
      );
    });
  } finally {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
  const payload = requests[0]?.body;
  const evidence = {
    passed:
      result.code === 1 &&
      !result.signal &&
      !result.error &&
      requests.length === 1 &&
      requests[0].method === 'POST' &&
      requests[0].path === '/complete' &&
      payload.outcome === 'worker-control-failed' &&
      payload.outcomeReference === null &&
      payload.message.includes('No human decision is requested.') &&
      !payload.message.includes('PARK') &&
      Date.now() < deadline,
    result,
    requests,
  };
  writeFileSync(
    join(directory, 'runner-finalization.json'),
    JSON.stringify(evidence, null, 2),
  );
  return evidence;
}

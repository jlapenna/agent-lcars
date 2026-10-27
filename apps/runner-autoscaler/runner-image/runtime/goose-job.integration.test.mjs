import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

// Explicit qualification in the supported CI lane (2 CPU / 5 GiB / 20 GiB).
// Mount fixture provider configuration at /run/secrets and aaa.bbb.ccc at
// /run/agent-lcars-identity/token. The provider host is http://127.0.0.1:17777.
// Uses the installed, real Goose binary; no paid model or network audit.
const runtime = fileURLToPath(new URL('.', import.meta.url));
const answer = { report: 'Local transport fixture', findings: { items: [] } };
const recipeText = `version: 1.0.0
title: Transport qualification
description: Exercise structured result transport
instructions: Return the requested fixture result.
parameters:
  - key: baseline
    input_type: string
    requirement: required
    description: Prior result
prompt: 'Return a report and findings. Prior result: {{ baseline }}'
response:
  json_schema:
    type: object
    required: [report, findings]
    properties:
      report: {type: string}
      findings: {type: object}
`;

for (const cancel of [false, true]) {
  test(
    `normal runner with real Goose: ${cancel ? 'cancellation' : 'activation contention and completion'}`,
    { timeout: 90000 },
    async () => {
      const runId = 'work:fixture/r1';
      const root = `/api/work/v1/runs/${encodeURIComponent(runId)}`;
      const directory = await mkdtemp(join(tmpdir(), 'goose-integration-'));
      let activations = 0;
      let starts = 0;
      let submitted;
      let failed;
      let providerCalls = 0;
      let started;
      const providerStarted = new Promise((resolve) => {
        started = resolve;
      });
      const errors = [];
      const server = createServer(async (req, res) => {
        try {
          let raw = '';
          for await (const chunk of req) raw += chunk;
          const body = JSON.parse(raw || '{}');
          const json = (value, status = 200) => {
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(value));
          };
          if (req.url.startsWith('/api/work/')) {
            assert.equal(req.headers.authorization, 'Bearer fixture');
            assert.equal(req.headers['x-lcars-worker-identity'], 'aaa.bbb.ccc');
            if (req.url === '/api/work/v1/runs/activate') {
              activations++;
              assert.equal(body.fence.runId, runId);
              return json({ generation: 1 }, activations === 1 ? 409 : 200);
            }
            assert.equal(req.headers['x-lcars-worker-generation'], '1');
            if (req.url === `${root}/brief`)
              return json({
                id: 'work:fixture',
                spec: {},
                anchor: { type: 'work', target_repo: 'fixture/repo' },
                pipeline: 'goose',
                mode: 'recipe',
                attemptId: 'attempt',
                intentId: 'intent',
              });
            if (req.url === `${root}/heartbeat`) {
              if (body.providerProcessStarted) starts++;
              return json({
                runId,
                expiresAt: new Date(Date.now() + 60000).toISOString(),
              });
            }
            if (req.url === `${root}/complete`) {
              failed = body;
              return json({});
            }
            if (req.url === `${root}/recipe` && req.method === 'GET')
              return json({
                definition: {
                  recipeText,
                  job: {
                    inputs: {},
                    execution: {
                      timeout: '1m',
                      resources: {
                        requests: { cpu: 2, memory: '5Gi', storage: '20Gi' },
                        limits: { cpu: 2, memory: '5Gi', storage: '20Gi' },
                      },
                    },
                  },
                },
                baseline: null,
              });
            if (req.url === `${root}/recipe` && req.method === 'POST') {
              submitted = body;
              return json({});
            }
            throw new Error(`Unexpected Work route ${req.url}`);
          }
          if (req.url.endsWith('/models'))
            return json({
              object: 'list',
              data: [
                {
                  id: 'fixture',
                  object: 'model',
                  created: 1,
                  owned_by: 'fixture',
                },
              ],
            });
          assert.ok(req.url.endsWith('/chat/completions'));
          providerCalls++;
          assert.ok(
            providerCalls <= 2,
            'provider must finish without a retry loop',
          );
          started();
          if (cancel) return;
          const tool = body.tools.find((t) =>
            /final_output/.test(t.function?.name),
          );
          assert.ok(tool, 'real Goose must request its structured output tool');
          const delta = {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'call_final',
                type: 'function',
                function: {
                  name: tool.function.name,
                  arguments: JSON.stringify(answer),
                },
              },
            ],
          };
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          for (const [piece, reason] of [
            [delta, null],
            [{}, 'tool_calls'],
          ])
            res.write(
              `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: piece, finish_reason: reason }] })}\n\n`,
            );
          res.end('data: [DONE]\n\n');
        } catch (error) {
          errors.push(error);
          res.writeHead(500);
          res.end();
        }
      });
      let child;
      try {
        await new Promise((resolve) =>
          server.listen(17777, '127.0.0.1', resolve),
        );
        child = spawn('bash', [join(runtime, '../direct-runner.sh')], {
          detached: true,
          env: {
            ...process.env,
            LCARS_RUN_ID: runId,
            LCARS_RUN_TOKEN: 'fixture',
            LCARS_CONSOLE_URL: 'http://127.0.0.1:17777',
            LCARS_CAPACITY_RECEIPT: JSON.stringify({
              runId,
              poolId: 'fixture',
              nonce: 'fixture-nonce-123456',
              slot: 0,
              revision: 1,
            }),
            LCARS_CAPACITY_JOB_UID: 'fixture-job',
            RUNTIME_HELPERS_DIR: runtime,
            PROVIDER_PROCESS_NODE: process.execPath,
            RUNNER_TEMP: directory,
            HEARTBEAT_INTERVAL_SECONDS: '1',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let output = '';
        child.stdout.on('data', (chunk) => {
          output += chunk;
        });
        child.stderr.on('data', (chunk) => {
          output += chunk;
        });
        const exited = new Promise((resolve, reject) => {
          child.once('error', reject);
          child.once('exit', (code, signal) => resolve({ code, signal }));
        });
        if (cancel) {
          await Promise.race([
            providerStarted,
            exited.then(() => {
              throw new Error(`Runner exited before provider call: ${output}`);
            }),
          ]);
          child.kill('SIGTERM');
        }
        const result = await exited;
        assert.deepEqual(errors, []);
        assert.equal(activations, 2, output);
        assert.equal(starts, 1, output);
        assert.ok(providerCalls > 0, output);
        if (cancel) {
          assert.equal(result.code, 143, output);
          assert.equal(submitted, undefined);
          assert.equal(failed?.outcome, 'runner-failed');
        } else {
          assert.equal(result.code, 0, output);
          assert.deepEqual(submitted, { result: answer });
          assert.equal(failed, undefined);
        }
      } finally {
        if (child?.pid) {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch (error) {
            if (error.code !== 'ESRCH') throw error;
          }
        }
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
}

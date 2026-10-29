/* eslint-disable vitest/no-import-node-test -- qualification executes the installed runner with node --test, without Vitest. */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// Explicit qualification in the supported CI lane (2 CPU / 5 GiB / 20 GiB).
// Mount fixture provider configuration at /run/secrets. The provider host is
// http://127.0.0.1:17777.
// Enable the builtin developer extension and GOOSE_MODE: auto in that config.
// Uses the installed, real Goose binary; no paid model or network audit.
const runtime = fileURLToPath(new URL('.', import.meta.url));
const answer = { report: 'Local transport fixture', findings: { items: [] } };
const recipeText = `version: 1.0.0
title: Transport qualification
description: Exercise structured result transport
instructions: Return the requested fixture result.
parameters:
  - key: subject
    input_type: string
    requirement: required
    description: Invocation subject
  - key: baseline
    input_type: string
    requirement: required
    description: Prior result
prompt: 'Subject: {{ subject }}. Return a report and findings. Prior result: {{ baseline }}'
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
      const checkout = join(directory, 'checkout');
      const home = join(directory, 'home');
      const bin = join(directory, 'bin');
      await mkdir(checkout);
      await mkdir(join(home, '.claude/skills'), { recursive: true });
      await mkdir(bin);
      await writeFile(
        join(home, '.claude/skills/fixture.md'),
        'installed skill',
      );
      const git = (...args) =>
        execFileSync('git', args, { cwd: checkout, encoding: 'utf8' }).trim();
      git('init', '-q');
      git('config', 'user.name', 'fixture');
      git('config', 'user.email', 'fixture@example.invalid');
      await writeFile(join(checkout, 'recipe-source.txt'), 'pinned source');
      git('add', '.');
      git('commit', '-qm', 'fixture source');
      const revision = git('rev-parse', 'HEAD');
      git('remote', 'add', 'origin', checkout);
      await writeFile(join(checkout, 'recipe-source.txt'), 'newer source');
      git('commit', '-qam', 'newer default branch');
      await writeFile(join(bin, 'gh'), '#!/bin/sh\nprintf "%s" "$GH_TOKEN"\n', {
        mode: 0o700,
      });
      let checkoutTokens = 0;
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
            if (req.url === `${root}/checkout-token`) {
              checkoutTokens++;
              const rotate = await readFile(
                join(directory, 'tool-started'),
              ).then(
                () => true,
                () => false,
              );
              return json({
                token: rotate ? 'fixture-token-2' : 'fixture-token-1',
                expiresAt: new Date(
                  Date.now() + (rotate ? 3600000 : 1000),
                ).toISOString(),
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
                  revision,
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
                parameters: { subject: 'fixture invocation' },
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
          assert.ok(
            JSON.stringify(body.messages).includes('fixture invocation'),
          );
          providerCalls++;
          assert.ok(
            providerCalls <= 2,
            'provider must finish without a retry loop',
          );
          started();
          if (cancel) return;
          const tool = body.tools.find((t) =>
            (providerCalls === 1 ? /shell$/ : /final_output/).test(
              t.function?.name,
            ),
          );
          if (providerCalls > 1) {
            assert.equal(
              await readFile(join(directory, 'tools-proved'), 'utf8'),
              'ok',
            );
            assert.ok(
              checkoutTokens >= 2,
              'shared credential refresh must run',
            );
          }
          const command = `set -eu
            test "$(pwd)" = "$WORKSPACE"
            test "$REPOSITORY" = fixture/repo
            test "$(cat recipe-source.txt)" = 'pinned source'
            test "$(cat "$HOME/.claude/skills/fixture.md")" = 'installed skill'
            test -z "\${LCARS_RUN_TOKEN:-}\${GH_TOKEN:-}\${GITHUB_TOKEN:-}"
            test "$(git config user.name)" = 'agent-lcars[bot]'
            test "$(gh api repos/fixture/repo)" = fixture-token-1
            touch '${directory}/tool-started'
            for attempt in 1 2 3 4 5 6 7 8 9 10; do
              [ "$(gh api repos/fixture/repo)" = fixture-token-2 ] && break
              sleep 1
            done
            test "$(gh api repos/fixture/repo)" = fixture-token-2
            printf 'protocol=https\\nhost=github.com\\npath=fixture/repo.git\\n\\n' | git credential fill | grep -q 'password=fixture-token-2'
            printf ok > '${directory}/tools-proved'`;

          assert.ok(
            tool,
            'real Goose must expose the requested shell/final-output tool',
          );
          const delta = {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: `call_${providerCalls}`,
                type: 'function',
                function: {
                  name: tool.function.name,
                  arguments: JSON.stringify(
                    providerCalls === 1 ? { command } : answer,
                  ),
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
              `data: ${JSON.stringify({ id: `fixture-${providerCalls}`, object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: piece, finish_reason: reason }] })}\n\n`,
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
            HOME: home,
            PATH: `${bin}:${process.env.PATH}`,
            GH_TOKEN: 'stale-inherited-token',
            GITHUB_TOKEN: 'stale-inherited-token',
            CHECKOUT_TOKEN_REFRESH_MARGIN_SECONDS: '0',
            LCARS_RUN_ID: runId,
            LCARS_RUN_TOKEN: 'fixture',
            LCARS_CONSOLE_URL: 'http://127.0.0.1:17777',
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
            assert.equal(error.code, 'ESRCH');
          }
        }
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
}

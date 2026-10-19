// @vitest-environment node
//
// Opt-in application bridge for the capacity receipt fence (#2312). The Go
// regression in apps/runner-autoscaler/queue_receipt_kubernetes_integration_test.go
// proves what a real Kubernetes API does with a lost reply; its Work API is a
// scripted loopback fixture. This file is the other half: ONE loopback TCP
// adapter around the PRODUCTION createRunsHandler() with the real
// CapacityProtocol, Orchestrator and FirestoreStore (emulator only), so the
// compiled Go test binary talks to the real route and Store decisions.
//
// It proves router/Store composition, not Google/session authentication: the
// adapter maps one invocation-local random bearer to one fixture principal and
// pool, with capacityEnabled true in this RunsContext only. It never imports
// the production Next catch-all (that constructs real GCS/App adapters) and
// never dispatches, drains or calls a model.
//
// Ordinary runs: LCARS_RECEIPT_K8S_APPLICATION is unset, the suite is skipped
// and nothing contacts Kubernetes. Enabled: every input below must be present
// and consistent, otherwise the suite FAILS before the Go binary is spawned.
//
// Reviewed consumer sequence (Root, after qualification; NOT run by the
// authoring job). Compile the tagged Go test binary FIRST, to an owned path:
//
//   (cd apps/runner-autoscaler && go test -tags=kubernetes_integration \
//      -run '^$' -c -o "$BIN" .)            # BIN is an absolute, owned file
//
// then run this one Node test through the EXISTING gate, which wraps normal
// `firebase emulators:exec` and takes its command from FIRESTORE_GATE_EXEC_CMD:
//
//   LCARS_RECEIPT_K8S_APPLICATION=1 \
//   LCARS_RECEIPT_K8S_APPLICATION_BINARY="$BIN" \
//   LCARS_RECEIPT_K8S_KUBECONFIG=... LCARS_RECEIPT_K8S_KUBECONTEXT=... \
//   LCARS_RECEIPT_K8S_NAMESPACE=... LCARS_RECEIPT_K8S_NAMESPACE_UID=... \
//   LCARS_RECEIPT_K8S_LABELS=k=v,... LCARS_RECEIPT_K8S_NODE_SELECTOR='{"k":"v"}' \
//   LCARS_RECEIPT_K8S_IMAGE=registry/runner@sha256:... \
//   LCARS_RECEIPT_K8S_SERVICE_ACCOUNT=... LCARS_RECEIPT_K8S_FIXTURE_SECRET=... \
//   FIRESTORE_GATE_EXEC_CMD='pnpm exec firebase emulators:exec --only firestore \
//      --project=demo-receipt-bridge "FIRESTORE_EMULATOR_HOST=127.0.0.1:4002 \
//      pnpm exec vitest run --config apps/console/vitest.config.mts \
//      queue-receipt-kubernetes.test.ts --no-passWithNoTests"' \
//   node tools/firestore-emulator-gate.mjs
//
// The LCARS_RECEIPT_K8S_* values carry the same meaning and qualification as
// the Go file header (disposable namespace UID/labels, ROOT-qualified node
// selector, immutable image digest, harmless ServiceAccount, dummy Secret).
// Shared bounds: Go logical context <=180s, independent Go cleanup <=120s,
// `go test -timeout=420s` inside this suite's 420s outer supervisor. A
// supervisor SIGKILL of the owned Go process group is not cleanup proof; the
// Go suite reports exact retained leftovers.
import { type ChildProcess, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import {
  CapacityProtocol,
  FirestoreStore,
  Orchestrator,
  type OrchestratorStore,
  requestKey,
  retiredKey,
} from '@agent-lcars/orchestrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createRunsHandler, type RunsContext } from './runs-router';
import type { WorkPrincipal } from './work-auth';

const enabled = (process.env.LCARS_RECEIPT_K8S_APPLICATION ?? '') !== '';

// Mirrors receiptFencePool and receiptFixtureSubject in the Go owner. Every
// case gets its OWN pool, so one case's unreleased receipt never consumes the
// slot another case needs.
const CLUSTER = 'receipt-fence-cluster';
const SUBJECT = 'receipt-fence-executor-subject';
const PIPELINE = 'opencode';
const BODY_LIMIT = 1 << 20;
const OUTPUT_LIMIT = 256 << 10;
const SUPERVISOR_MS = 420_000;
const REQUIRED_K8S = [
  'LCARS_RECEIPT_K8S_KUBECONFIG',
  'LCARS_RECEIPT_K8S_KUBECONTEXT',
  'LCARS_RECEIPT_K8S_NAMESPACE',
  'LCARS_RECEIPT_K8S_NAMESPACE_UID',
  'LCARS_RECEIPT_K8S_LABELS',
  'LCARS_RECEIPT_K8S_NODE_SELECTOR',
  'LCARS_RECEIPT_K8S_IMAGE',
  'LCARS_RECEIPT_K8S_SERVICE_ACCOUNT',
  'LCARS_RECEIPT_K8S_FIXTURE_SECRET',
] as const;
const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

interface Fault {
  route: string;
  mode: 'drop' | '409';
  fired: boolean;
}
interface CaseState {
  poolId: string;
  workId: string;
  runId: string;
  requests: { producerId: string; requestId: string }[];
}

function requireEnabledInputs() {
  if (process.env.LCARS_RECEIPT_K8S_APPLICATION !== '1')
    throw new Error('LCARS_RECEIPT_K8S_APPLICATION must be exactly 1');
  for (const name of REQUIRED_K8S)
    if ((process.env[name] ?? '').trim() === '')
      throw new Error(`${name} is required; refusing any default target`);
  const binary = process.env.LCARS_RECEIPT_K8S_APPLICATION_BINARY ?? '';
  if (!path.isAbsolute(binary))
    throw new Error('LCARS_RECEIPT_K8S_APPLICATION_BINARY must be absolute');
  const stat = fs.statSync(binary);
  if (!stat.isFile()) throw new Error('application binary is not a file');
  fs.accessSync(binary, fs.constants.X_OK);
  const project =
    process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT ?? '';
  if (!/^demo-[a-z0-9-]+$/u.test(project))
    throw new Error('a demo-* emulator project is required (GCLOUD_PROJECT)');
  const host = process.env.FIRESTORE_EMULATOR_HOST ?? '';
  if (!/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/u.test(host))
    throw new Error(
      'FIRESTORE_EMULATOR_HOST must be an explicit loopback host',
    );
  return { binary, project, host };
}

function randomWorkId() {
  const bytes = crypto.randomBytes(26);
  return Array.from(bytes, (b) => ULID_ALPHABET[b % 32]).join('');
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        reject(new Error('request body exceeds bound'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function routeLabel(pathname: string, body: unknown) {
  const rest = pathname.replace(/^\/api\/work\/v1/u, '');
  if (rest === '/runs/claim') return 'claim';
  if (rest === '/runs/capacity') {
    const action =
      typeof body === 'object' && body !== null && 'action' in body
        ? String((body as { action: unknown }).action)
        : 'inventory';
    return `capacity:${action}`;
  }
  if (/^\/runs\/[^/]+\/exit$/u.test(rest)) return 'exit';
  return rest;
}

describe.skipIf(!enabled)('receipt fence application bridge', () => {
  let child: ChildProcess | undefined;
  let server: http.Server | undefined;
  let exited: Promise<number | null> | undefined;

  beforeAll(() => {
    requireEnabledInputs();
  });

  afterAll(async () => {
    // Join exactly what this suite started: the Go process group it owns, then
    // the HTTP server. No global process kill.
    if (child?.pid !== undefined && child.exitCode === null) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
      await exited;
    }
    await new Promise<void>((resolve) =>
      server === undefined ? resolve() : server.close(() => resolve()),
    );
  });

  it(
    'joins the real Kubernetes receipt fixtures to production HTTP and isolated Firestore',
    { timeout: SUPERVISOR_MS + 30_000 },
    async () => {
      const { binary, project, host } = requireEnabledInputs();
      const options = {
        projectId: project,
        databaseId: '(default)',
        collectionPrefix: `receipt-bridge-${crypto.randomUUID()}-`,
        emulatorHost: host,
      };
      const store: OrchestratorStore = new FirestoreStore(options);
      // A second client proves durability: assertions read state the serving
      // client has already committed, never its in-memory view.
      const reopened: OrchestratorStore = new FirestoreStore(options);
      const orchestrator = new Orchestrator(store, {
        now: () => new Date().toISOString(),
      });
      const bearer = crypto.randomBytes(32).toString('base64url');
      const invocation = crypto.randomBytes(8).toString('hex');
      // Invocation-local fixture bearers: one per case, each mapped to one
      // fixture principal and that case's pool.
      const principals = new Map<string, WorkPrincipal>();
      const principalFor = (poolId: string): WorkPrincipal => ({
        principal: 'svc:receipt-fence',
        subject: SUBJECT,
        capacityPool: poolId,
        pipelines: [PIPELINE],
        via: 'google',
        scopes: new Set([
          'work.executor',
          'work.capacity.recover',
          'work.capacity.fence',
          'work.capacity.operator',
        ]),
      });
      const base: Omit<RunsContext, 'bearerToken' | 'principal'> = {
        store,
        orchestrator,
        now: () => new Date(),
        capacityEnabled: true,
        tokens: { tokenFor: async () => 'unused' },
        checkoutTokens: {
          tokenFor: async () => 'unused',
          expiringTokenFor: async () => ({ token: 'unused', expiresAt: '' }),
          expiringTokenForRepositories: async () => ({
            token: 'unused',
            expiresAt: '',
          }),
        },
        // No provider dispatch or drain exists in this bridge.
        drain: async () => ({ dispatched: [], reported: [], failed: [] }),
        codexAuth: {
          read: async () => undefined,
          readLease: async () => undefined,
          createLease: async () => undefined,
          takeLease: async () => undefined,
          releaseLease: async () => undefined,
          replace: async () => undefined,
        },
      };
      const handler = createRunsHandler();
      const cases = new Map<string, CaseState>();
      const faults: Fault[] = [];
      const sequence: Record<string, string[]> = {};
      const failures: string[] = [];

      const authorized = (req: http.IncomingMessage) => {
        const given = Buffer.from(req.headers.authorization ?? '');
        const want = Buffer.from(`Bearer ${bearer}`);
        return (
          given.length === want.length && crypto.timingSafeEqual(given, want)
        );
      };
      const json = (
        res: http.ServerResponse,
        status: number,
        value: unknown,
      ) => {
        const text = JSON.stringify(value);
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(text);
      };

      let endpoint = '';
      // Configure and import one EMPTY isolated pool through the real route,
      // over real TCP, with that case's fixture bearer.
      const configurePool = async (poolId: string, caseBearer: string) => {
        const post = async (body: unknown) => {
          const response = await fetch(
            `${endpoint}/api/work/v1/runs/capacity`,
            {
              method: 'POST',
              headers: {
                authorization: `Bearer ${caseBearer}`,
                'content-type': 'application/json',
              },
              body: JSON.stringify(body),
            },
          );
          return {
            status: response.status,
            body: (await response.json()) as { digest?: string },
          };
        };
        const policy = {
          poolId,
          cluster: CLUSTER,
          namespace: process.env.LCARS_RECEIPT_K8S_NAMESPACE!,
          version: 1,
          maxConcurrent: 2,
          maxUnplaced: 1,
          enforced: true,
          inventoryKnown: false,
          domains: { [PIPELINE]: { domainId: `${poolId}-domain`, ceiling: 1 } },
        };
        const configured = await post({ action: 'configure', policy });
        if (configured.status !== 200) throw new Error('configure refused');
        const proposal = {
          action: 'import',
          dryRun: true,
          known: true,
          evidence: 'reviewed-complete-inventory',
          inventory: [],
        };
        const dryRun = await post(proposal);
        if (dryRun.status !== 200) throw new Error('import dry-run refused');
        const imported = await post({
          ...proposal,
          dryRun: false,
          reviewedDigest: dryRun.body.digest,
        });
        if (imported.status !== 200) throw new Error('import refused');
      };

      const control = async (
        req: http.IncomingMessage,
        res: http.ServerResponse,
        pathname: string,
      ) => {
        if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });
        const body = JSON.parse((await readBody(req)).toString() || '{}') as {
          case?: string;
          route?: string;
          mode?: 'drop' | '409';
          secretHash?: string;
          jobUid?: string;
        };
        if (pathname === '/__bridge/arm') {
          if (
            typeof body.route !== 'string' ||
            (body.mode !== 'drop' && body.mode !== '409')
          )
            return json(res, 400, { error: 'invalid fault' });
          faults.push({ route: body.route, mode: body.mode, fired: false });
          return json(res, 200, { armed: faults.length });
        }
        if (pathname === '/__bridge/seed') {
          const name = body.case ?? '';
          if (!/^[a-z][a-zA-Z0-9]{0,31}$/u.test(name) || cases.has(name))
            return json(res, 400, { error: 'invalid or repeated case' });
          const workId = randomWorkId();
          const poolId = `receipt-bridge-${invocation}-${name.toLowerCase()}`;
          const caseBearer = crypto.randomBytes(32).toString('base64url');
          principals.set(caseBearer, principalFor(poolId));
          await configurePool(poolId, caseBearer);
          // The inert native test Task: a plain opencode Work item that is
          // only ever claimed and fenced, never dispatched.
          const decision = await orchestrator.request({
            taskId: { workId },
            requestId: `receipt-bridge-${invocation}-${name}`,
            pipeline: PIPELINE,
            params: { mode: 'implement' },
            work: {
              origin: { principal: 'user:receipt-bridge', channel: 'api' },
              spec: {
                title: `receipt bridge ${name}`,
                pipeline: PIPELINE,
                target: { repo: 'example/receipt-bridge' },
              },
            },
          });
          if ('refused' in decision || decision.run === undefined)
            return json(res, 500, { error: 'seed refused' });
          await store.enqueueRun({
            runId: decision.run.runId,
            now: new Date().toISOString(),
          });
          cases.set(name, {
            poolId,
            workId,
            runId: decision.run.runId,
            requests: [],
          });
          sequence[decision.run.runId] = [];
          return json(res, 200, {
            runId: decision.run.runId,
            poolId,
            bearer: caseBearer,
          });
        }
        if (pathname === '/__bridge/verify') {
          const state = cases.get(body.case ?? '');
          if (state === undefined) return json(res, 400, { error: 'no case' });
          const problems: string[] = [];
          const now = new Date().toISOString();
          const runs = await reopened.listRuns({ workId: state.workId });
          const task = await reopened.readTask({ workId: state.workId });
          if (task === undefined) problems.push('task missing');
          if (runs.length !== 1) problems.push(`runs=${runs.length}, want 1`);
          const run = runs[0];
          const capacity = await new CapacityProtocol(reopened).read(now);
          const receipts = capacity.receipts.filter(
            (r) => r.runId === state.runId,
          );
          if (receipts.length > 1) problems.push(`receipts=${receipts.length}`);
          const keys = state.requests.map((r) =>
            requestKey(state.poolId, SUBJECT, r.producerId, r.requestId),
          );
          const records = await reopened.transactCapacity({
            now,
            recordKeys: [...keys, retiredKey(state.runId)],
            decide: (snapshot) => ({
              value: [...snapshot.records.entries()].map(([k, v]) => ({
                k,
                v,
              })),
            }),
          });
          const requestRecords = records.filter((r) => r.v.kind === 'request');
          const retired = records.find((r) => r.v.kind === 'retired')?.v;
          const distinct = new Set(
            requestRecords.map((r) =>
              r.v.kind === 'request' ? r.v.tokenHash : '',
            ),
          );
          if (distinct.size > 1) problems.push('more than one token minted');
          const requestIds = new Set(state.requests.map((r) => r.requestId));
          if (requestIds.size > 1) problems.push('claim request id changed');
          const receipt = receipts[0];
          if (
            receipt !== undefined &&
            run?.queue?.state === 'claimed' &&
            receipt.tokenHash !== run.queue.tokenHash
          )
            problems.push('receipt and run token hash differ');
          if (
            body.secretHash !== undefined &&
            receipt?.tokenHash !== body.secretHash
          )
            problems.push('bound Secret does not preserve the original token');
          if (body.jobUid !== undefined && receipt?.jobUid !== body.jobUid)
            problems.push('receipt Job UID differs');
          if (problems.length !== 0) failures.push(...problems);
          return json(res, problems.length === 0 ? 200 : 409, {
            problems,
            run: run && { state: run.queue?.state, status: run.status },
            receipt: receipt && {
              state: receipt.state,
              unplaced: receipt.unplaced,
              jobUid: receipt.jobUid,
              secretUid: receipt.secretUid,
              tokenHash: receipt.tokenHash,
              worker: receipt.worker && {
                generation: receipt.worker.generation,
                podUid: receipt.worker.podUid,
                active: receipt.worker.active,
              },
              pendingWrites: receipt.producers.flatMap((p) => p.pendingWrites)
                .length,
              barrier: receipt.barrier,
            },
            requestRecords: requestRecords.length,
            retired:
              retired?.kind === 'retired'
                ? {
                    released: retired.released,
                    barrier: retired.barrier,
                    pendingWrites: retired.pendingWrites.length,
                  }
                : undefined,
            faultsFired: faults.filter((f) => f.fired).length,
            sequence: sequence[state.runId] ?? [],
          });
        }
        return json(res, 404, { error: 'unknown control route' });
      };

      server = http.createServer((req, res) => {
        void (async () => {
          try {
            const url = new URL(req.url ?? '/', 'http://127.0.0.1');
            if (url.pathname.startsWith('/__bridge/'))
              return await control(req, res, url.pathname);
            if (!url.pathname.startsWith('/api/work/v1/'))
              return json(res, 404, { error: 'unknown' });
            const raw =
              req.method === 'GET' ? Buffer.alloc(0) : await readBody(req);
            let parsed: unknown;
            try {
              parsed =
                raw.length === 0 ? undefined : JSON.parse(raw.toString());
            } catch {
              parsed = undefined;
            }
            const header = req.headers.authorization ?? '';
            const token = header.startsWith('Bearer ') ? header.slice(7) : '';
            const context: RunsContext = {
              ...base,
              bearerToken: token,
              ...(principals.has(token)
                ? { principal: principals.get(token) }
                : {}),
            };
            const headers = new Headers();
            for (const [k, v] of Object.entries(req.headers))
              if (typeof v === 'string') headers.set(k, v);
            const result = await handler.handle(
              new Request(`http://127.0.0.1${url.pathname}${url.search}`, {
                method: req.method,
                headers,
                ...(raw.length === 0 ? {} : { body: raw }),
              }),
              { prefix: '/api/work/v1', context },
            );
            if (!result.matched || result.response === undefined)
              return json(res, 404, { error: 'unmatched' });
            const out = Buffer.from(await result.response.arrayBuffer());
            if (out.length > BODY_LIMIT)
              throw new Error('response exceeds bound');
            const label = routeLabel(url.pathname, parsed);
            // The store decision is already committed here. A fault hides or
            // overrides only the REPLY, exactly like a lost network response.
            const fault = faults.find((f) => !f.fired && f.route === label);
            if (label === 'claim' && parsed !== undefined) {
              const claim = parsed as {
                producerId?: string;
                claimRequestId?: string;
              };
              for (const state of cases.values()) {
                if (
                  result.response.status === 200 &&
                  out.toString().includes(state.runId) &&
                  claim.producerId !== undefined &&
                  claim.claimRequestId !== undefined &&
                  !state.requests.some(
                    (r) =>
                      r.requestId === claim.claimRequestId &&
                      r.producerId === claim.producerId,
                  )
                )
                  state.requests.push({
                    producerId: claim.producerId,
                    requestId: claim.claimRequestId,
                  });
              }
            }
            const runId = [...cases.values()].find(
              (s) =>
                url.pathname.includes(encodeURIComponent(s.runId)) ||
                out.toString().includes(s.runId),
            )?.runId;
            if (runId !== undefined)
              (sequence[runId] ??= []).push(
                `${label}:${result.response.status}${fault ? `:${fault.mode}` : ''}`,
              );
            if (fault !== undefined) {
              fault.fired = true;
              if (fault.mode === 'drop') return void res.socket?.destroy();
              return json(res, 409, { code: 'CONFLICT', message: 'bridge' });
            }
            res.writeHead(
              result.response.status,
              Object.fromEntries(result.response.headers.entries()),
            );
            res.end(out);
          } catch {
            // Never echo request bytes: they can carry a run token.
            if (!res.headersSent) json(res, 500, { error: 'adapter failure' });
            else res.socket?.destroy();
          }
        })();
      });
      await new Promise<void>((resolve, reject) => {
        server!.once('error', reject);
        server!.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();
      if (address === null || typeof address === 'string')
        throw new Error('loopback server has no port');
      endpoint = `http://127.0.0.1:${address.port}`;

      // Spawn the compiled tagged Go test binary. Only qualification paths and
      // identities cross; the bearer is the sole credential and is redacted
      // from captured output.
      const env: Record<string, string> = {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        LCARS_RECEIPT_K8S_APPLICATION: '1',
        LCARS_RECEIPT_K8S_APPLICATION_ENDPOINT: endpoint,
        LCARS_RECEIPT_K8S_APPLICATION_BEARER: bearer,
        LCARS_RECEIPT_K8S_APPLICATION_INVOCATION: invocation,
      };
      for (const name of REQUIRED_K8S) env[name] = process.env[name]!;
      let output = '';
      const collect = (chunk: Buffer) => {
        if (output.length < OUTPUT_LIMIT)
          output += chunk.toString().replaceAll(bearer, '[redacted]');
      };
      child = spawn(
        binary,
        [
          '-test.run=^TestReceiptKubernetesApplication$',
          '-test.v',
          '-test.count=1',
          '-test.timeout=420s',
        ],
        { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      child.stdout?.on('data', collect);
      child.stderr?.on('data', collect);
      exited = new Promise((resolve) => {
        child!.once('exit', (code) => resolve(code));
        child!.once('error', () => resolve(null));
      });
      const timer = setTimeout(() => {
        if (child?.pid !== undefined)
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            // Already gone.
          }
      }, SUPERVISOR_MS);
      const code = await exited;
      clearTimeout(timer);

      // Output is bounded and redacted; print only on failure.
      if (code !== 0 || failures.length !== 0 || cases.size === 0)
        console.error(output.slice(-OUTPUT_LIMIT));
      expect(failures).toEqual([]);
      expect(code).toBe(0);
      // The Go family really executed, not a vacuous PASS of a skipped test.
      expect(output).toMatch(/--- PASS: TestReceiptKubernetesApplication\b/u);
      expect(output).not.toMatch(
        /--- SKIP: TestReceiptKubernetesApplication\b/u,
      );
      expect([...cases.keys()].length).toBeGreaterThan(0);
      for (const f of faults) expect(f.fired).toBe(true);
    },
  );
});

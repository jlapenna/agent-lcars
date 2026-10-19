// @vitest-environment node
//
// Opt-in Node owner of the isolated real-bootstrap useful-work qualification
// carrier (#2312 original AC5/8; Tracks #2312, closes nothing). It is TEST-ONLY
// source: the authoring job compiles and unit-checks it, and NEVER sets
// LCARS_RECEIPT_USEFUL_WORK, so the family below is skipped there. A skip is
// not a PASS and is never evidence that a worker, provider, Kubernetes API or
// GCS object was exercised.
//
// What the family does when a later, separately authorized Root run enables it:
// one parent around the PRODUCTION createRunsHandler(), Orchestrator and a real
// FirestoreStore (loopback emulator, demo- project, random collection prefix,
// plus a SECOND client for reopened reads). It requests a real codex
// `deliverable: report` Work item through orchestrator.request, store.enqueueRun
// and orchestrator.confirmDispatch, exposes the handler on two listeners
// (controller-only loopback HTTP and an explicit private HTTPS callback for the
// Pod), and spawns the compiled tagged Go binary's
// TestReceiptKubernetesUsefulWork, which builds the real Kubernetes queue and
// launches the original Job. The old queue-receipt-kubernetes.test.ts family
// (#2926) is untouched and earns no credit here.
//
// Not claimed by this file: operator/Pod admission, real GCS or provider
// settlement, Google/session authentication (the controller bearer maps to one
// invocation-local fixture principal), or any external effect: the completion
// drain may truthfully perform zero effects and leave the outbox pending.
//
// Reviewed consumer sequence (Root; NOT run by the authoring job):
//   (cd apps/runner-autoscaler && go test -tags=kubernetes_integration \
//      -run '^$' -c -o "$BIN" .)
//   LCARS_RECEIPT_USEFUL_WORK=1 LCARS_RECEIPT_USEFUL_WORK_INPUT=<private json> \
//   FIRESTORE_GATE_EXEC_CMD='... vitest run queue-receipt-useful-work.test.ts' \
//   node tools/firestore-emulator-gate.mjs
import { type ChildProcess, execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  FirestoreStore,
  Orchestrator,
  type OrchestratorStore,
} from '@agent-lcars/orchestrator';
import { createLocalJWKSet, type JSONWebKeySet } from 'jose';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { verifyCapacityWorkerIdentity } from './capacity-worker-identity';
import { createRunsHandler, type RunsContext } from './runs-router';
import type { WorkPrincipal } from './work-auth';

const execFileAsync = promisify(execFile);

// Bounds from the reviewed plan. The provider budget and every Job deadline are
// fixed here so a caller cannot widen them through input.
export const PROVIDER_BUDGET_S = 900;
export const JOB_ACTIVE_DEADLINE_S = 1200;
export const CLEANUP_BUDGET_S = 180;
export const OUTER_MS = 1500_000;
export const FRAME_LIMIT = 64 << 10;
export const FRAME_TOTAL_LIMIT = 1 << 20;
export const WORKER_TOKEN_PATH = '/run/agent-lcars-identity/token';
export const FRAME_KINDS = [
  'publicIdentity',
  'prepared',
  'claimed',
  'jobAccepted',
  'podObserved',
  'workerActivated',
  'providerObserved',
  'usefulCompleted',
  'physicalEnded',
  'retired',
  'cleanup',
] as const;

const sha256 = z.string().regex(/^[0-9a-f]{64}$/u);
const k8sName = z.string().regex(/^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/u);
const uid = z.string().min(8).max(128);
const privateIpv4 = z.string().refine(isPrivateIpv4, 'not a private IPv4');
const receipt = z.strictObject({
  sha256,
  observedAt: z.iso.datetime(),
  owner: z.string().min(1).max(256),
});

/** Closed qualification input. Every field is required: there is no default
 * namespace, no `latest` image, no production URL, no adapter module path and
 * no embedded credential. Proposals do not confer permission; the runtime
 * bindings (source, metadata, current owner) are checked against the receipts
 * by the Go side and by the parent before first Job create. */
export const inputSchema = z.strictObject({
  reviewed: z.strictObject({
    sourceCommit: z.string().regex(/^[0-9a-f]{40}$/u),
    tsSha256: sha256,
    goSha256: sha256,
    binarySha256: sha256,
    imageDigest: z.string().regex(/^[^\s@]+@sha256:[0-9a-f]{64}$/u),
    bakedInputSha256: sha256,
  }),
  kube: z.strictObject({
    context: z.string().min(1),
    kubeconfig: z.string().refine(path.isAbsolute, 'must be absolute'),
    namespace: k8sName,
    namespaceUid: uid,
    namespaceLabels: z
      .record(z.string().min(1), z.string())
      .refine((v) => Object.keys(v).length > 0, 'labels are required'),
    serviceAccount: k8sName,
    serviceAccountUid: uid,
    credentialSecret: k8sName,
    credentialSecretUid: uid,
    nodeSelector: z
      .record(z.string().min(1), z.string())
      .refine((v) => Object.keys(v).length > 0, 'selector is required'),
    audience: z.string().min(1).max(175),
  }),
  callback: z.strictObject({
    ip: privateIpv4,
    san: privateIpv4,
    publicRootsPath: z.string().min(1),
    publicRootsSha256: sha256,
  }),
  binary: z.string().refine(path.isAbsolute, 'must be absolute'),
  work: z.strictObject({
    title: z.string().min(1).max(200),
    description: z.string().min(1).max(8192),
    need: z.string().min(1).max(512),
    owner: z.string().min(1).max(256),
    reviewedSha256: sha256,
  }),
  receipts: z.strictObject({
    authorization: receipt,
    currentOwner: receipt,
    sourceSnapshot: receipt,
    parentAdmission: receipt,
    workerAdmission: receipt,
    providerAdmission: receipt,
  }),
});
export type UsefulWorkInput = z.infer<typeof inputSchema>;

export function isPrivateIpv4(value: string) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(value);
  if (m === null) return false;
  const o = m.slice(1).map(Number);
  if (o.some((n) => n > 255)) return false;
  const [a, b] = o as [number, number, number, number];
  return (
    a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
  );
}

/** `LCARS_RECEIPT_USEFUL_WORK` gate: unset skips before any client, secret or
 * API access; exactly `1` enables; anything else is rejected. */
export function optIn(value: string | undefined): 'skip' | 'run' {
  if (value === undefined) return 'skip';
  if (value === '1') return 'run';
  throw new Error('LCARS_RECEIPT_USEFUL_WORK must be unset or exactly 1');
}

/** Parses the private input and re-binds it to the actual files it names. The
 * input must also say the trusted tool inputs (this file, the binary) are the
 * reviewed bytes, so an edited carrier cannot ride an old receipt. */
export function parseInput(
  raw: string | undefined,
  files: { ts: string; go?: string; binary?: string; roots?: string },
): UsefulWorkInput {
  if (raw === undefined || raw.trim() === '')
    throw new Error('LCARS_RECEIPT_USEFUL_WORK_INPUT is required');
  const input = inputSchema.parse(JSON.parse(raw));
  const digest = (file: string) =>
    crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if (digest(files.ts) !== input.reviewed.tsSha256)
    throw new Error('TS carrier differs from the reviewed hash');
  if (files.go !== undefined && digest(files.go) !== input.reviewed.goSha256)
    throw new Error('Go carrier differs from the reviewed hash');
  if (
    files.binary !== undefined &&
    digest(files.binary) !== input.reviewed.binarySha256
  )
    throw new Error('compiled binary differs from the reviewed hash');
  if (
    files.roots !== undefined &&
    digest(files.roots) !== input.callback.publicRootsSha256
  )
    throw new Error('public roots differ from the exact image bundle hash');
  return input;
}

/** Emulator-only Store options: loopback host, demo- project, random prefix. */
export function emulatorOptions(env: NodeJS.ProcessEnv) {
  const project = env.GCLOUD_PROJECT ?? env.GOOGLE_CLOUD_PROJECT ?? '';
  if (!/^demo-[a-z0-9-]+$/u.test(project))
    throw new Error('a demo-* emulator project is required');
  const host = env.FIRESTORE_EMULATOR_HOST ?? '';
  if (!/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/u.test(host))
    throw new Error(
      'FIRESTORE_EMULATOR_HOST must be an explicit loopback host',
    );
  return {
    projectId: project,
    databaseId: '(default)',
    collectionPrefix: `useful-work-${crypto.randomUUID()}-`,
    emulatorHost: host,
  };
}

/** Worker listener allowlist: only the exact bound run-token paths and
 * /runs/activate. Capacity, qualification and operator routes never match. */
export function workerPathAllowed(pathname: string, runId: string) {
  const rest = pathname.replace(/^\/api\/work\/v1/u, '');
  if (rest === '/runs/activate') return true;
  const id = encodeURIComponent(runId);
  return [
    `/runs/${id}/token`,
    `/runs/${id}/exit`,
    `/runs/${id}/complete`,
    `/runs/${id}/heartbeat`,
  ].includes(rest);
}

/** The only allowed delta over the production Job body: a public-CA ConfigMap
 * volume, its read-only mount and CURL_CA_BUNDLE on the sole container, plus
 * the finite provider budget and active deadline. Everything else must match. */
export function applyCaDelta(job: Record<string, any>, configMap: string) {
  const clone = structuredClone(job);
  const pod = clone.spec?.template?.spec;
  const containers: Record<string, any>[] | undefined = pod?.containers;
  if (
    pod === undefined ||
    containers?.length !== 1 ||
    (pod.initContainers?.length ?? 0) !== 0 ||
    (pod.ephemeralContainers?.length ?? 0) !== 0
  )
    throw new Error('Job must have exactly one direct-runner container');
  const bundle = '/etc/lcars-public-ca/ca-bundle.pem';
  const container = containers[0]!;
  if (
    (container.env ?? []).some(
      (e: { name: string }) => e.name === 'CURL_CA_BUNDLE',
    )
  )
    throw new Error('production Job already sets CURL_CA_BUNDLE');
  container.env = [
    ...(container.env ?? []),
    { name: 'CURL_CA_BUNDLE', value: bundle },
  ];
  container.volumeMounts = [
    ...(container.volumeMounts ?? []),
    { name: 'public-ca', mountPath: path.dirname(bundle), readOnly: true },
  ];
  pod.volumes = [
    ...(pod.volumes ?? []),
    { name: 'public-ca', configMap: { name: configMap } },
  ];
  clone.spec.activeDeadlineSeconds = JOB_ACTIVE_DEADLINE_S;
  return clone;
}

/** Joins the exact image roots to the callback CA. A callback-CA-only bundle
 * would break GitHub and bootstrap TLS, so the roots are mandatory. */
export function joinCaBundle(publicRoots: string, callbackCa: string) {
  if (!/-----BEGIN CERTIFICATE-----/u.test(publicRoots))
    throw new Error('public roots hold no certificates');
  if (!/-----BEGIN CERTIFICATE-----/u.test(callbackCa))
    throw new Error('callback CA holds no certificate');
  return `${publicRoots.trimEnd()}\n${callbackCa.trimEnd()}\n`;
}

/** Bounded, secret-free controller frame decoder (Node child pipes, one JSON
 * object per line). Unknown kinds, oversize frames and credential-bearing
 * fields are refused rather than truncated. */
export class FrameReader {
  private total = 0;
  private buffer = '';
  readonly frames: {
    kind: (typeof FRAME_KINDS)[number];
    [k: string]: unknown;
  }[] = [];
  push(chunk: string) {
    this.total += chunk.length;
    if (this.total > FRAME_TOTAL_LIMIT)
      throw new Error('frame stream too large');
    this.buffer += chunk;
    for (;;) {
      const at = this.buffer.indexOf('\n');
      if (at < 0) break;
      const line = this.buffer.slice(0, at);
      this.buffer = this.buffer.slice(at + 1);
      if (line.length > FRAME_LIMIT) throw new Error('frame too large');
      const frame = JSON.parse(line) as { kind?: string };
      if (!FRAME_KINDS.includes(frame.kind as never))
        throw new Error(`unknown frame kind ${String(frame.kind)}`);
      if (/bearer|runToken|authorization|jwt|nonce|privateKey/iu.test(line))
        throw new Error('frame carries a forbidden field');
      this.frames.push(frame as never);
    }
    if (this.buffer.length > FRAME_LIMIT) throw new Error('frame too large');
  }
}

async function makeCallbackTls(ip: string, dir: string) {
  const key = path.join(dir, 'callback.key');
  const crt = path.join(dir, 'callback.crt');
  await execFileAsync('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '1',
    '-keyout',
    key,
    '-out',
    crt,
    '-subj',
    `/CN=${ip}`,
    '-addext',
    `subjectAltName=IP:${ip}`,
  ]);
  fs.chmodSync(key, 0o600);
  return { key: fs.readFileSync(key), cert: fs.readFileSync(crt, 'utf8') };
}

// ---- Always-on unit controls: offline, labelled, never journey credit. ----
describe('useful-work carrier unit controls (offline, not journey evidence)', () => {
  const good = {
    reviewed: {
      sourceCommit: 'a'.repeat(40),
      tsSha256: 'b'.repeat(64),
      goSha256: 'c'.repeat(64),
      binarySha256: 'd'.repeat(64),
      imageDigest: `registry.example/runner@sha256:${'e'.repeat(64)}`,
      bakedInputSha256: 'f'.repeat(64),
    },
    kube: {
      context: 'ctx',
      kubeconfig: '/tmp/kubeconfig',
      namespace: 'qual-ns',
      namespaceUid: 'ns-uid-0001',
      namespaceLabels: { a: 'b' },
      serviceAccount: 'worker',
      serviceAccountUid: 'sa-uid-0001',
      credentialSecret: 'creds',
      credentialSecretUid: 'secret-uid-1',
      nodeSelector: { pool: 'x' },
      audience: 'aud',
    },
    callback: {
      ip: '10.0.0.5',
      san: '10.0.0.5',
      publicRootsPath: '/etc/ssl/certs/ca-certificates.crt',
      publicRootsSha256: '1'.repeat(64),
    },
    binary: '/tmp/bin',
    work: {
      title: 't',
      description: 'd',
      need: 'n',
      owner: 'o',
      reviewedSha256: '2'.repeat(64),
    },
    receipts: Object.fromEntries(
      [
        'authorization',
        'currentOwner',
        'sourceSnapshot',
        'parentAdmission',
        'workerAdmission',
        'providerAdmission',
      ].map((k) => [
        k,
        {
          sha256: '3'.repeat(64),
          observedAt: '2026-10-19T00:00:00Z',
          owner: 'o',
        },
      ]),
    ),
  };

  it('opt-in is skip when unset, run for exactly 1, otherwise rejected', () => {
    expect(optIn(undefined)).toBe('skip');
    expect(optIn('1')).toBe('run');
    for (const bad of ['', '0', 'true', '1 '])
      expect(() => optIn(bad)).toThrow();
  });

  it('accepts the closed input and refuses unknown, zero or defaulted values', () => {
    expect(inputSchema.safeParse(good).success).toBe(true);
    const mutate = (f: (v: any) => void) => {
      const v = structuredClone(good);
      f(v);
      return inputSchema.safeParse(v).success;
    };
    expect(mutate((v) => (v.extra = 1))).toBe(false);
    expect(mutate((v) => delete v.kube.namespace)).toBe(false);
    expect(mutate((v) => (v.kube.nodeSelector = {}))).toBe(false);
    expect(mutate((v) => (v.kube.namespaceLabels = {}))).toBe(false);
    expect(
      mutate((v) => (v.reviewed.imageDigest = 'registry/runner:latest')),
    ).toBe(false);
    expect(mutate((v) => (v.callback.ip = '8.8.8.8'))).toBe(false);
    expect(mutate((v) => (v.callback.ip = '127.0.0.1'))).toBe(false);
    expect(mutate((v) => (v.binary = 'relative/bin'))).toBe(false);
    expect(mutate((v) => (v.reviewed.tsSha256 = '0'))).toBe(false);
    expect(mutate((v) => (v.credentials = '{"type":"service_account"}'))).toBe(
      false,
    );
  });

  it('binds the input to the actual carrier bytes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uw-unit-'));
    try {
      const ts = path.join(dir, 'a.ts');
      fs.writeFileSync(ts, 'x');
      const raw = JSON.stringify(good);
      expect(() => parseInput(raw, { ts })).toThrow(/reviewed hash/u);
      expect(() => parseInput(undefined, { ts })).toThrow(/required/u);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses emulator options that are not loopback demo-', () => {
    const ok = {
      GCLOUD_PROJECT: 'demo-x',
      FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
    };
    expect(emulatorOptions(ok).collectionPrefix).toMatch(/^useful-work-/u);
    expect(() => emulatorOptions({ ...ok, GCLOUD_PROJECT: 'prod' })).toThrow();
    expect(() =>
      emulatorOptions({ ...ok, FIRESTORE_EMULATOR_HOST: '0.0.0.0:8080' }),
    ).toThrow();
    expect(() =>
      emulatorOptions({ ...ok, FIRESTORE_EMULATOR_HOST: 'fs.example:8080' }),
    ).toThrow();
  });

  it('worker listener admits only the bound run paths and activation', () => {
    expect(workerPathAllowed('/api/work/v1/runs/activate', 'r1')).toBe(true);
    expect(workerPathAllowed('/api/work/v1/runs/r1/exit', 'r1')).toBe(true);
    expect(workerPathAllowed('/api/work/v1/runs/r2/exit', 'r1')).toBe(false);
    expect(workerPathAllowed('/api/work/v1/runs/capacity', 'r1')).toBe(false);
    expect(workerPathAllowed('/api/work/v1/runs/claim', 'r1')).toBe(false);
  });

  it('adds only the public-CA delta and refuses extra containers', () => {
    const job = {
      spec: { template: { spec: { containers: [{ name: 'r', env: [] }] } } },
    };
    const out = applyCaDelta(job, 'public-ca-cm');
    const c = out.spec.template.spec.containers[0];
    expect(c.env).toEqual([
      { name: 'CURL_CA_BUNDLE', value: '/etc/lcars-public-ca/ca-bundle.pem' },
    ]);
    expect(out.spec.activeDeadlineSeconds).toBe(JOB_ACTIVE_DEADLINE_S);
    expect(job.spec.template.spec.containers[0]).toEqual({
      name: 'r',
      env: [],
    });
    const two = { spec: { template: { spec: { containers: [{}, {}] } } } };
    expect(() => applyCaDelta(two, 'x')).toThrow(/exactly one/u);
  });

  it('the CA bundle keeps the public roots and adds the callback CA', () => {
    const pem = (n: string) =>
      `-----BEGIN CERTIFICATE-----\n${n}\n-----END CERTIFICATE-----`;
    const joined = joinCaBundle(pem('roots'), pem('callback'));
    expect(joined).toContain('roots');
    expect(joined).toContain('callback');
    expect(() => joinCaBundle('', pem('callback'))).toThrow();
  });

  it('frames are bounded, known and secret-free', () => {
    const r = new FrameReader();
    r.push('{"kind":"prepared","jobUid":"u"}\n');
    expect(r.frames).toHaveLength(1);
    expect(() => new FrameReader().push('{"kind":"nope"}\n')).toThrow(
      /unknown/u,
    );
    expect(() =>
      new FrameReader().push('{"kind":"claimed","runToken":"x"}\n'),
    ).toThrow(/forbidden/u);
    expect(() =>
      new FrameReader().push(`${'x'.repeat(FRAME_LIMIT + 1)}`),
    ).toThrow(/too large/u);
  });

  it('verifies only through the real verifier against a supplied JWKS', async () => {
    const saved = process.env.AGENT_LCARS_CAPACITY_WORKER_IDENTITIES;
    process.env.AGENT_LCARS_CAPACITY_WORKER_IDENTITIES = '[]';
    try {
      const jwks = createLocalJWKSet({ keys: [] } satisfies JSONWebKeySet);
      await expect(
        verifyCapacityWorkerIdentity('x.y.z', 'pool', jwks),
      ).rejects.toThrow(/No declared capacity worker identity/u);
    } finally {
      if (saved === undefined)
        delete process.env.AGENT_LCARS_CAPACITY_WORKER_IDENTITIES;
      else process.env.AGENT_LCARS_CAPACITY_WORKER_IDENTITIES = saved;
    }
  });
});

// ---- Opt-in family: skipped (not passed) unless exactly enabled. ----
const mode = optIn(process.env.LCARS_RECEIPT_USEFUL_WORK);

describe.skipIf(mode === 'skip')('isolated real-bootstrap useful work', () => {
  let child: ChildProcess | undefined;
  const servers: (http.Server | https.Server)[] = [];
  const tmp: string[] = [];

  afterAll(async () => {
    // Join only what this suite started. A SIGKILL is never cleanup proof; the
    // Go side reports exact retained identities.
    if (child?.pid !== undefined && child.exitCode === null)
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    await Promise.all(
      servers.map((s) => new Promise<void>((r) => s.close(() => r()))),
    );
    for (const dir of tmp) fs.rmSync(dir, { recursive: true, force: true });
  });

  it(
    'runs one genuinely needed report through the unchanged worker path',
    { timeout: OUTER_MS + 60_000 },
    async () => {
      const here = new URL(import.meta.url).pathname;
      const input = parseInput(process.env.LCARS_RECEIPT_USEFUL_WORK_INPUT, {
        ts: here,
        go: path.join(
          path.dirname(here),
          '../../../runner-autoscaler/queue_receipt_useful_work_kubernetes_integration_test.go',
        ),
        binary: JSON.parse(process.env.LCARS_RECEIPT_USEFUL_WORK_INPUT!).binary,
        roots: JSON.parse(process.env.LCARS_RECEIPT_USEFUL_WORK_INPUT!).callback
          .publicRootsPath,
      });
      const options = emulatorOptions(process.env);
      const store: OrchestratorStore = new FirestoreStore(options);
      const reopened: OrchestratorStore = new FirestoreStore(options);
      const orchestrator = new Orchestrator(store, {
        now: () => new Date().toISOString(),
      });

      const workId = Array.from(
        crypto.randomBytes(26),
        (b) => '0123456789ABCDEFGHJKMNPQRSTVWXYZ'[b % 32],
      ).join('');
      const decision = await orchestrator.request({
        taskId: { workId },
        requestId: `useful-work-${crypto.randomUUID()}`,
        pipeline: 'codex',
        params: { mode: 'implement' },
        work: {
          origin: { principal: 'user:useful-work', channel: 'api' },
          spec: {
            title: input.work.title,
            description: input.work.description,
            pipeline: 'codex',
            deliverable: 'report',
            priority: 'normal',
            fallbackPipelines: [],
            target: { repo: 'jlapenna/agent-lcars' },
          },
        },
      } as never);
      if ('refused' in decision || decision.run === undefined)
        throw new Error('orchestrator refused the useful-work request');
      const runId = decision.run.runId;
      await store.enqueueRun({ runId, now: new Date().toISOString() });
      const confirmed = await orchestrator.confirmDispatch(runId);
      if ('refused' in confirmed) throw new Error('confirmDispatch refused');

      const controllerBearer = crypto.randomBytes(32).toString('base64url');
      const poolId = `useful-work-${crypto.randomBytes(6).toString('hex')}`;
      const principal: WorkPrincipal = {
        principal: 'svc:useful-work',
        subject: 'useful-work-controller',
        capacityPool: poolId,
        pipelines: ['codex'],
        via: 'google',
        scopes: new Set([
          'work.executor',
          'work.capacity.recover',
          'work.capacity.fence',
          'work.capacity.operator',
        ]),
      };
      const base = {
        store,
        orchestrator,
        now: () => new Date(),
        capacityEnabled: true,
      } as unknown as Omit<RunsContext, 'bearerToken' | 'principal'>;
      const handler = createRunsHandler();
      const handle = async (
        req: http.IncomingMessage,
        res: http.ServerResponse,
        controller: boolean,
      ) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (!controller && !workerPathAllowed(url.pathname, runId)) {
          res.writeHead(404).end();
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const c of req) {
          size += (c as Buffer).length;
          if (size > 1 << 20) return void res.writeHead(413).end();
          chunks.push(c as Buffer);
        }
        const token = (req.headers.authorization ?? '').replace(
          /^Bearer /u,
          '',
        );
        const context: RunsContext = {
          ...base,
          bearerToken: token,
          ...(controller && token === controllerBearer ? { principal } : {}),
        } as RunsContext;
        const headers = new Headers();
        for (const [k, v] of Object.entries(req.headers))
          if (typeof v === 'string') headers.set(k, v);
        const body = Buffer.concat(chunks);
        const result = await handler.handle(
          new Request(`http://localhost${url.pathname}${url.search}`, {
            method: req.method,
            headers,
            ...(body.length === 0 ? {} : { body }),
          }),
          { prefix: '/api/work/v1', context },
        );
        if (!result.matched || result.response === undefined)
          return void res.writeHead(404).end();
        res.writeHead(
          result.response.status,
          Object.fromEntries(result.response.headers.entries()),
        );
        res.end(Buffer.from(await result.response.arrayBuffer()));
      };
      const fail = (res: http.ServerResponse) => {
        if (!res.headersSent) res.writeHead(500).end();
      };

      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'useful-work-'));
      fs.chmodSync(dir, 0o700);
      tmp.push(dir);
      const tls = await makeCallbackTls(input.callback.ip, dir);
      const roots = fs.readFileSync(input.callback.publicRootsPath, 'utf8');
      fs.writeFileSync(
        path.join(dir, 'ca-bundle.pem'),
        joinCaBundle(roots, tls.cert),
        { mode: 0o600 },
      );

      const controllerServer = http.createServer(
        (q, s) => void handle(q, s, true).catch(() => fail(s)),
      );
      await new Promise<void>((r) =>
        controllerServer.listen(0, '127.0.0.1', r),
      );
      servers.push(controllerServer);
      // Pod-reachable listener binds the one qualified private IP, never 0.0.0.0.
      const workerServer = https.createServer(
        { key: tls.key, cert: tls.cert },
        (q, s) => void handle(q, s, false).catch(() => fail(s)),
      );
      await new Promise<void>((r) =>
        workerServer.listen(0, input.callback.ip, r),
      );
      servers.push(workerServer);
      const controllerPort = (controllerServer.address() as { port: number })
        .port;
      const workerPort = (workerServer.address() as { port: number }).port;

      // The child-process-only identity mapping is completed by the Go
      // preflight's publicIdentity frame; env is restored in finally.
      const savedIdentities =
        process.env.AGENT_LCARS_CAPACITY_WORKER_IDENTITIES;
      const reader = new FrameReader();
      try {
        child = spawn(
          input.binary,
          [
            '-test.run=^TestReceiptKubernetesUsefulWork$',
            '-test.v',
            '-test.count=1',
            '-test.timeout=1500s',
          ],
          {
            detached: true,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: {
              PATH: process.env.PATH ?? '',
              HOME: process.env.HOME ?? '',
              LCARS_RECEIPT_USEFUL_WORK: '1',
              LCARS_RECEIPT_USEFUL_WORK_INPUT:
                process.env.LCARS_RECEIPT_USEFUL_WORK_INPUT!,
              LCARS_RECEIPT_USEFUL_WORK_CONTROLLER: `http://127.0.0.1:${controllerPort}`,
              LCARS_RECEIPT_USEFUL_WORK_CALLBACK: `https://${input.callback.ip}:${workerPort}`,
              LCARS_RECEIPT_USEFUL_WORK_CA_BUNDLE: path.join(
                dir,
                'ca-bundle.pem',
              ),
              LCARS_RECEIPT_USEFUL_WORK_RUN: runId,
            },
          },
        );
        // The controller bearer travels on the private stdin pipe, never argv.
        child.stdin?.write(`${JSON.stringify({ controllerBearer })}\n`);
        let output = '';
        child.stdout?.on('data', (c: Buffer) => {
          const text = c.toString();
          if (output.length < 256 << 10)
            output += text.replaceAll(controllerBearer, '[redacted]');
          if (text.startsWith('{')) reader.push(text);
        });
        child.stderr?.on('data', (c: Buffer) => {
          if (output.length < 256 << 10)
            output += c.toString().replaceAll(controllerBearer, '[redacted]');
        });
        const code = await new Promise<number | null>((resolve) => {
          const timer = setTimeout(() => {
            try {
              process.kill(-child!.pid!, 'SIGKILL');
            } catch {
              // Already gone.
            }
          }, OUTER_MS);
          child!.once('exit', (c) => {
            clearTimeout(timer);
            resolve(c);
          });
          child!.once('error', () => resolve(null));
        });
        if (code !== 0) console.error(output.slice(-(64 << 10)));
        expect(code).toBe(0);
        expect(output).toMatch(/--- PASS: TestReceiptKubernetesUsefulWork\b/u);
        expect(output).not.toMatch(
          /--- SKIP: TestReceiptKubernetesUsefulWork\b/u,
        );

        // The report must be readable from the SECOND client: finished,
        // successful and carrying a reviewable message. Nothing here writes it.
        const run = await reopened.readRun(runId);
        expect(run?.state).toBe('succeeded');
        expect(JSON.stringify(run)).toContain('report');
      } finally {
        if (savedIdentities === undefined)
          delete process.env.AGENT_LCARS_CAPACITY_WORKER_IDENTITIES;
        else
          process.env.AGENT_LCARS_CAPACITY_WORKER_IDENTITIES = savedIdentities;
      }
    },
  );
});

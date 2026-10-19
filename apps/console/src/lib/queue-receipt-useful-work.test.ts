// @vitest-environment node
//
// Opt-in Node owner of the isolated real-bootstrap useful-work qualification
// carrier (#2312 original AC5/8; Tracks #2312, closes nothing). TEST-ONLY
// source. The authoring job compiles and unit-checks it and NEVER sets
// LCARS_RECEIPT_USEFUL_WORK, so the family below is skipped there. A skip is
// not a PASS and earns no journey credit.
//
// When Root separately authorizes execution, ONE parent runs around the
// PRODUCTION createRunsHandler(), Orchestrator, CapacityProtocol and a real
// FirestoreStore (loopback emulator, demo- project, random prefix, plus a
// SECOND client for reopened reads):
//   1. real orchestrator.request -> store.enqueueRun -> confirmDispatch;
//   2. the compiled tagged Go binary's TestReceiptKubernetesUsefulWork emits
//      publicIdentity (actual cluster issuer + public JWKS); the parent binds it,
//      installs the process-local worker-identity mapping, configures and
//      imports ONE invocation-local pool through the real capacity route, then
//      ACKs `prepared`;
//   3. Go claims, launches the original Job through production q.launch, and the
//      worker talks to the SAME handler on a private HTTPS listener (exact
//      method+path allowlist; fixture authority never reaches it);
//   4. after `usefulCompleted` the parent reads the finished report from the
//      reopened Store, runs canonical Codex credential recovery, ACKs
//      `usefulRecorded`; Go then proves physical end/retirement and cleans up;
//   5. the parent freezes evidence outside the checkout and ACKs `finish`; the
//      child, listeners, Store and emulator are joined LAST.
//
// Not claimed: Google/session authentication (the controller bearer maps to one
// invocation-local fixture principal), operator/Pod admission, or any external
// effect (the completion drain truthfully performs none and leaves the outbox
// pending). The #2926 receipt family is untouched.
//
// Reviewed consumer sequence (Root; NOT run by the authoring job):
//   (cd apps/runner-autoscaler && go test -tags=kubernetes_integration \
//      -run '^$' -c -o "$BIN" .)
//   LCARS_RECEIPT_USEFUL_WORK=1 LCARS_RECEIPT_USEFUL_WORK_INPUT=/abs/input.json \
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
  CapacityProtocol,
  FirestoreStore,
  Orchestrator,
  type OrchestratorStore,
} from '@agent-lcars/orchestrator';
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JSONWebKeySet,
  SignJWT,
} from 'jose';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { verifyCapacityWorkerIdentity } from './capacity-worker-identity';
import { codexAuthStore } from './codex-auth-store';
import { recoverCodexCredentialOperations } from './codex-credential-operations';
import {
  createDispatchTokenProvider,
  DIRECT_RUNNER_PERMISSIONS,
  lazyDispatchTokenProvider,
  ORCHESTRATOR_GITHUB_PERMISSIONS,
} from './github-app-tokens';
import { createRunsHandler, type RunsContext } from './runs-router';
import type { WorkPrincipal } from './work-auth';

const execFileAsync = promisify(execFile);

// Bounds from the reviewed design; none is reachable from input.
export const PROVIDER_BUDGET_S = 900;
export const RUN_DEADLINE_S = 1200;
export const CLEANUP_BUDGET_S = 180;
export const OUTER_MS = 1500_000;
export const FRAME_LIMIT = 64 << 10;
export const FRAME_TOTAL_LIMIT = 1 << 20;
export const DIAGNOSTIC_LIMIT = 4 << 20;
export const FRAME_MARKER = '@@LCARS-UW-FRAME@@ ';
const BODY_LIMIT = 1 << 20;
const POOL_CLUSTER = 'useful-work-cluster';

const sha256 = z.string().regex(/^[0-9a-f]{64}$/u);
const k8sName = z.string().regex(/^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/u);
const uid = z.string().min(8).max(128);
const absolute = z.string().refine(path.isAbsolute, 'must be absolute');

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
const privateIpv4 = z.string().refine(isPrivateIpv4, 'not a private IPv4');

/** A positive evidence reference: a readable file whose bytes hash to
 * `sha256`. The file's own closed content is checked by `loadEvidence`. */
const evidenceRef = z.strictObject({ path: absolute, sha256 });

export const EVIDENCE_KINDS = [
  'authorization',
  'currentOwner',
  'sourceSnapshot',
  'bakedInputs',
  'parentAdmission',
  'workerAdmission',
  'providerAdmission',
] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

/** Closed qualification input. No defaults: no namespace, `latest` image,
 * production URL, adapter module path or embedded credential. */
export const inputSchema = z.strictObject({
  reviewed: z.strictObject({
    sourceCommit: z.string().regex(/^[0-9a-f]{40}$/u),
    tsSha256: sha256,
    goSha256: sha256,
    binarySha256: sha256,
    imageDigest: z
      .string()
      .regex(/^[^\s@:]+(:\d+)?\/[^\s@]+@sha256:[0-9a-f]{64}$/u),
    bakedInputSha256: sha256,
  }),
  kube: z.strictObject({
    context: z.string().min(1),
    cluster: z.string().min(1),
    kubeconfig: absolute,
    namespace: k8sName.refine((n) => n !== 'default' && !n.startsWith('kube-')),
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
    publicRootsPath: absolute,
    publicRootsSha256: sha256,
  }),
  binary: absolute,
  work: z.strictObject({
    title: z.string().min(1).max(200),
    description: z.string().min(1).max(8192),
    need: z.string().min(1).max(512),
    owner: z.string().min(1).max(256),
    reviewedSha256: sha256,
  }),
  evidence: z.strictObject(
    Object.fromEntries(EVIDENCE_KINDS.map((k) => [k, evidenceRef])) as Record<
      EvidenceKind,
      typeof evidenceRef
    >,
  ),
  evidenceDir: absolute,
});
export type UsefulWorkInput = z.infer<typeof inputSchema>;

/** The scope every evidence file must carry and match against the input. */
const evidenceSchema = z.strictObject({
  kind: z.enum(EVIDENCE_KINDS),
  owner: z.string().min(1).max(256),
  observedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  scope: z.strictObject({
    sourceCommit: z.string().regex(/^[0-9a-f]{40}$/u),
    imageDigest: z.string().min(1),
    namespaceUid: uid,
    workSha256: sha256,
  }),
  // Kind-specific positive content, checked in loadEvidence.
  content: z.record(z.string(), z.unknown()),
});

export const taskHash = (w: UsefulWorkInput['work']) =>
  crypto
    .createHash('sha256')
    .update(`${w.need}\n${w.owner}\n${w.description}`)
    .digest('hex');

const digestOf = (bytes: Buffer | string) =>
  crypto.createHash('sha256').update(bytes).digest('hex');

/** Reads, hashes and verifies one evidence file; throws on any gap. */
export function loadEvidence(
  kind: EvidenceKind,
  input: UsefulWorkInput,
  now: Date,
) {
  const ref = input.evidence[kind];
  const bytes = fs.readFileSync(ref.path);
  if (bytes.length > 256 << 10) throw new Error(`${kind} evidence too large`);
  if (digestOf(bytes) !== ref.sha256)
    throw new Error(`${kind} evidence differs from its hash`);
  const doc = evidenceSchema.parse(JSON.parse(bytes.toString('utf8')));
  if (doc.kind !== kind)
    throw new Error(`${kind} evidence has kind ${doc.kind}`);
  if (
    doc.scope.sourceCommit !== input.reviewed.sourceCommit ||
    doc.scope.imageDigest !== input.reviewed.imageDigest ||
    doc.scope.namespaceUid !== input.kube.namespaceUid ||
    doc.scope.workSha256 !== input.work.reviewedSha256
  )
    throw new Error(`${kind} evidence scope differs from the input`);
  if (Date.parse(doc.expiresAt) <= now.getTime())
    throw new Error(`${kind} evidence is not current`);
  if (Date.parse(doc.observedAt) > now.getTime() + 60_000)
    throw new Error(`${kind} evidence is from the future`);
  const c = doc.content;
  if (kind === 'sourceSnapshot') {
    // Binds the source bytes and the binary build provenance to one commit.
    const shape = z
      .strictObject({
        tsSha256: z.literal(input.reviewed.tsSha256),
        goSha256: z.literal(input.reviewed.goSha256),
        binarySha256: z.literal(input.reviewed.binarySha256),
        builtFromCommit: z.literal(input.reviewed.sourceCommit),
      })
      .safeParse(c);
    if (!shape.success) throw new Error('sourceSnapshot content mismatch');
  }
  if (kind === 'currentOwner') {
    const shape = z
      .strictObject({
        taskOwner: z.literal(input.work.owner),
        unowned: z.literal(true),
      })
      .safeParse(c);
    if (!shape.success) throw new Error('currentOwner content mismatch');
  }
  if (kind === 'authorization') {
    const shape = z
      .strictObject({
        taskNeed: z.literal(input.work.need),
        taskSha256: z.literal(taskHash(input.work)),
      })
      .safeParse(c);
    if (!shape.success) throw new Error('authorization content mismatch');
  }
  if (kind === 'bakedInputs') {
    const shape = z
      .strictObject({
        bootstrapSha256: sha256,
        workerActivationSha256: sha256,
        providerProcessSha256: sha256,
        publicRootsSha256: z.literal(input.callback.publicRootsSha256),
      })
      .safeParse(c);
    if (!shape.success) throw new Error('bakedInputs content mismatch');
    const joined = digestOf(
      `${shape.data.bootstrapSha256}\n${shape.data.workerActivationSha256}\n${shape.data.providerProcessSha256}\n`,
    );
    if (joined !== input.reviewed.bakedInputSha256)
      throw new Error('baked inputs differ from the reviewed hash');
  }
  if (
    kind === 'parentAdmission' ||
    kind === 'workerAdmission' ||
    kind === 'providerAdmission'
  ) {
    const shape = z
      .strictObject({
        requests: z.literal('2/6Gi/24Gi'),
        limits: z.literal('2/6Gi/24Gi'),
        accelerators: z.literal(0),
        admitted: z.literal(true),
      })
      .safeParse(c);
    if (!shape.success) throw new Error(`${kind} content mismatch`);
  }
  return doc;
}

export interface InputFiles {
  ts: string;
  go: string;
}

/** Parses the private input FILE (never raw JSON), binds it to the actual
 * carrier bytes, binary, exact-image public roots and every evidence file, and
 * returns the object plus the digest both owners must agree on. */
export function loadInput(
  inputPath: string | undefined,
  files: InputFiles,
  now = new Date(),
) {
  if (inputPath === undefined || !path.isAbsolute(inputPath))
    throw new Error('LCARS_RECEIPT_USEFUL_WORK_INPUT must be an absolute file');
  const stat = fs.statSync(inputPath);
  if (!stat.isFile() || stat.size > 256 << 10 || (stat.mode & 0o077) !== 0)
    throw new Error('input must be a private regular file under 256KiB');
  const raw = fs.readFileSync(inputPath);
  const input = inputSchema.parse(JSON.parse(raw.toString('utf8')));
  const file = (p: string) => digestOf(fs.readFileSync(p));
  if (file(files.ts) !== input.reviewed.tsSha256)
    throw new Error('TS carrier differs from the reviewed hash');
  if (file(files.go) !== input.reviewed.goSha256)
    throw new Error('Go carrier differs from the reviewed hash');
  if (file(input.binary) !== input.reviewed.binarySha256)
    throw new Error('compiled binary differs from the reviewed hash');
  if (file(input.callback.publicRootsPath) !== input.callback.publicRootsSha256)
    throw new Error('public roots differ from the exact image bundle hash');
  if (input.callback.san !== input.callback.ip)
    throw new Error('callback SAN must equal the callback IP');
  if (taskHash(input.work) !== input.work.reviewedSha256)
    throw new Error(
      'task need/owner/description differ from the reviewed hash',
    );
  for (const kind of EVIDENCE_KINDS) loadEvidence(kind, input, now);
  return { input, inputSha256: digestOf(raw) };
}

/** `LCARS_RECEIPT_USEFUL_WORK` gate. */
export function optIn(value: string | undefined): 'skip' | 'run' {
  if (value === undefined) return 'skip';
  if (value === '1') return 'run';
  throw new Error('LCARS_RECEIPT_USEFUL_WORK must be unset or exactly 1');
}

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

const API = '/api/work/v1';

/** Worker listener: METHOD + EXACT path + exact encoded bound run ID. The
 * routes are the ones the baked direct-runner actually uses (contract.ts,
 * capacity-contract.ts). /exit, claim, capacity, recovery, placement and Work
 * routes are controller-only. `activateRunId` is the body's fence.runId. */
export function workerRouteAllowed(
  method: string,
  pathname: string,
  runId: string,
  activateRunId?: unknown,
) {
  if (!pathname.startsWith(`${API}/`)) return false;
  const rest = pathname.slice(API.length);
  if (rest === '/runs/activate')
    return method === 'POST' && activateRunId === runId;
  const id = encodeURIComponent(runId);
  const table: Record<string, string[]> = {
    [`/runs/${id}/brief`]: ['GET'],
    [`/runs/${id}/checkout-token`]: ['GET'],
    [`/runs/${id}/codex-auth`]: ['GET', 'PUT'],
    [`/runs/${id}/heartbeat`]: ['POST'],
    [`/runs/${id}/complete`]: ['POST'],
  };
  return table[rest]?.includes(method) === true;
}

/** Mirrors app/api/work/v1/[[...rest]]/route.ts: Authorization -> bearerToken,
 * x-lcars-worker-identity -> workerIdentityToken, decimal
 * x-lcars-worker-generation -> workerGeneration. A fresh object every call. */
export function workerHeaderContext(headers: Headers) {
  const authorization = headers.get('authorization') ?? '';
  const bearer = authorization.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length)
    : undefined;
  const identity = headers.get('x-lcars-worker-identity');
  const generation = headers.get('x-lcars-worker-generation') ?? '';
  return {
    ...(bearer === undefined ? {} : { bearerToken: bearer }),
    ...(identity === null ? {} : { workerIdentityToken: identity }),
    ...(/^\d+$/u.test(generation)
      ? { workerGeneration: Number(generation) }
      : {}),
  };
}

type JobLike = Record<string, any>;

/** The ONLY delta over the production Job body: the public-CA ConfigMap volume
 * + read-only mount + CURL_CA_BUNDLE, supported CODEX_TIMEOUT_SECONDS, and the
 * finite run deadline in the location q.job already negotiated (Pod when the
 * placement annotation is present, otherwise Job): never both. */
export function applyCaDelta(job: JobLike, configMap: string): JobLike {
  const clone = structuredClone(job);
  const pod = clone.spec?.template?.spec;
  const containers: JobLike[] | undefined = pod?.containers;
  if (
    pod === undefined ||
    containers?.length !== 1 ||
    (pod.initContainers?.length ?? 0) !== 0 ||
    (pod.ephemeralContainers?.length ?? 0) !== 0
  )
    throw new Error('Job must have exactly one direct-runner container');
  const container = containers[0]!;
  const names = (container.env ?? []).map((e: { name: string }) => e.name);
  for (const n of ['CURL_CA_BUNDLE', 'CODEX_TIMEOUT_SECONDS'])
    if (names.includes(n)) throw new Error(`production Job already sets ${n}`);
  const dir = '/etc/lcars-public-ca';
  container.env = [
    ...(container.env ?? []),
    { name: 'CURL_CA_BUNDLE', value: `${dir}/ca-bundle.pem` },
    { name: 'CODEX_TIMEOUT_SECONDS', value: String(PROVIDER_BUDGET_S) },
  ];
  container.volumeMounts = [
    ...(container.volumeMounts ?? []),
    { name: 'public-ca', mountPath: dir, readOnly: true },
  ];
  pod.volumes = [
    ...(pod.volumes ?? []),
    { name: 'public-ca', configMap: { name: configMap } },
  ];
  if (
    clone.metadata?.annotations?.['lcars.dev/placement-aware'] !== undefined ||
    pod.activeDeadlineSeconds !== undefined
  )
    pod.activeDeadlineSeconds = RUN_DEADLINE_S;
  else clone.spec.activeDeadlineSeconds = RUN_DEADLINE_S;
  return clone;
}

/** Everything but the whitelisted delta must be byte-identical. */
export function onlyCaDelta(
  before: JobLike,
  after: JobLike,
  configMap: string,
) {
  const expected = applyCaDelta(before, configMap);
  return JSON.stringify(expected) === JSON.stringify(after);
}

export function joinCaBundle(publicRoots: string, callbackCa: string) {
  if (!/-----BEGIN CERTIFICATE-----/u.test(publicRoots))
    throw new Error('public roots hold no certificates');
  if (!/-----BEGIN CERTIFICATE-----/u.test(callbackCa))
    throw new Error('callback CA holds no certificate');
  return `${publicRoots.trimEnd()}\n${callbackCa.trimEnd()}\n`;
}

// ---- Typed controller protocol ----------------------------------------
export const FRAME_ORDER = [
  'publicIdentity',
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
export type FrameKind = (typeof FRAME_ORDER)[number];
const base = {
  v: z.literal(1),
  invocation: z.string().min(8),
  seq: z.number().int().positive(),
};
const frameShapes = {
  publicIdentity: z.strictObject({
    ...base,
    kind: z.literal('publicIdentity'),
    inputSha256: sha256,
    poolId: z.string().min(1),
    issuer: z.url().startsWith('https://'),
    jwksUri: z.url().startsWith('https://'),
    jwks: z.strictObject({
      keys: z.array(z.record(z.string(), z.unknown())).min(1).max(16),
    }),
    jwksSha256: sha256,
    namespace: k8sName,
    serviceAccountUid: uid,
  }),
  claimed: z.strictObject({
    ...base,
    kind: z.literal('claimed'),
    runId: z.string(),
    producerId: z.string(),
    jobName: z.string(),
  }),
  jobAccepted: z.strictObject({
    ...base,
    kind: z.literal('jobAccepted'),
    runId: z.string(),
    jobUid: uid,
    secretUid: uid,
    configMapUid: uid,
    claimFingerprint: sha256,
  }),
  podObserved: z.strictObject({
    ...base,
    kind: z.literal('podObserved'),
    runId: z.string(),
    podUid: uid,
    imageId: z.string().min(1),
  }),
  workerActivated: z.strictObject({
    ...base,
    kind: z.literal('workerActivated'),
    runId: z.string(),
    generation: z.number().int().positive(),
    podUid: uid,
  }),
  providerObserved: z.strictObject({
    ...base,
    kind: z.literal('providerObserved'),
    runId: z.string(),
    containerStartedAt: z.iso.datetime(),
  }),
  usefulCompleted: z.strictObject({
    ...base,
    kind: z.literal('usefulCompleted'),
    runId: z.string(),
  }),
  physicalEnded: z.strictObject({
    ...base,
    kind: z.literal('physicalEnded'),
    runId: z.string(),
    podUid: uid,
    exitCode: z.number().int(),
  }),
  retired: z.strictObject({
    ...base,
    kind: z.literal('retired'),
    runId: z.string(),
    released: z.boolean(),
    barrier: z.boolean(),
  }),
  cleanup: z.strictObject({
    ...base,
    kind: z.literal('cleanup'),
    runId: z.string(),
    removed: z.array(z.string()).max(8),
    retained: z.array(z.string()).max(8),
  }),
} as const;
export type Frame = { kind: FrameKind; seq: number; [k: string]: unknown };

/** Chunk-safe decoder. EVERY stdout byte goes through `push`; marked lines are
 * frames, everything else is bounded ordinary diagnostics. UTF-8 is counted in
 * bytes and decoded only on complete lines, so split code points, coalesced or
 * split frames and mixed diagnostics are all handled. `end()` rejects an
 * unfinished trailing line. Invalid input throws; callers route that into the
 * lifecycle promise instead of an event callback. */
export class FrameDecoder {
  frames: Frame[] = [];
  diagnostics = 0;
  private pending: Buffer = Buffer.alloc(0);
  private protocol = 0;
  private lastOrder = -1;
  private finished = false;
  constructor(
    private readonly invocation: string,
    private readonly runId: () => string | undefined,
  ) {}
  push(chunk: Buffer): Frame[] {
    const produced: Frame[] = [];
    this.pending = Buffer.concat([this.pending, chunk]);
    for (;;) {
      const at = this.pending.indexOf(0x0a);
      if (at < 0) break;
      const line = this.pending.subarray(0, at);
      this.pending = this.pending.subarray(at + 1);
      const frame = this.line(line);
      if (frame !== undefined) produced.push(frame);
    }
    if (this.pending.length > FRAME_LIMIT + FRAME_MARKER.length)
      throw new Error('unterminated stdout line exceeds the frame bound');
    return produced;
  }
  end() {
    if (this.pending.length !== 0)
      throw new Error('unfinished trailing frame at EOF');
  }
  markFinished() {
    this.finished = true;
  }
  private line(bytes: Buffer): Frame | undefined {
    const text = bytes.toString('utf8');
    if (!text.startsWith(FRAME_MARKER)) {
      this.diagnostics += bytes.length + 1;
      if (this.diagnostics > DIAGNOSTIC_LIMIT)
        throw new Error('diagnostics exceed their bound');
      return undefined;
    }
    if (this.finished) throw new Error('frame after finish');
    if (bytes.length > FRAME_LIMIT) throw new Error('frame too large');
    this.protocol += bytes.length + 1;
    if (this.protocol > FRAME_TOTAL_LIMIT)
      throw new Error('frame stream too large');
    const raw = JSON.parse(text.slice(FRAME_MARKER.length)) as {
      kind?: string;
    };
    const kind = raw.kind as FrameKind;
    const shape = (frameShapes as Record<string, z.ZodType>)[kind];
    if (shape === undefined)
      throw new Error(`unknown frame kind ${String(kind)}`);
    const frame = shape.parse(raw) as Frame & {
      invocation: string;
      runId?: string;
    };
    if (frame.invocation !== this.invocation)
      throw new Error('frame invocation mismatch');
    const order = FRAME_ORDER.indexOf(kind);
    if (order <= this.lastOrder)
      throw new Error(`frame ${kind} is duplicate or out of order`);
    if (this.frames.length !== 0 && frame.seq !== this.frames.at(-1)!.seq + 1)
      throw new Error('frame sequence gap');
    const run = this.runId();
    if (kind !== 'publicIdentity' && frame.runId !== run)
      throw new Error('frame names a different run');
    this.lastOrder = order;
    this.frames.push(frame);
    return frame;
  }
}

const SECRET_KEY = /^(d|p|q|dp|dq|qi|k)$/u;
/** A published JWKS must hold public members only. */
export function publicJwksOnly(jwks: { keys: Record<string, unknown>[] }) {
  return jwks.keys.every((k) =>
    Object.keys(k).every((m) => !SECRET_KEY.test(m)),
  );
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uw-unit-'));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  const write = (name: string, body: string | object, mode = 0o600) => {
    const p = path.join(dir, name);
    fs.writeFileSync(
      p,
      typeof body === 'string' ? body : JSON.stringify(body),
      { mode },
    );
    return p;
  };

  function fixture() {
    const ts = write('carrier.ts', 'ts');
    const go = write('carrier.go', 'go');
    const bin = write('bin', 'bin');
    const roots = write('roots.pem', 'roots');
    const work = {
      title: 't',
      description: 'review the carrier',
      need: 'unreviewed source',
      owner: 'owner',
    } as UsefulWorkInput['work'];
    const reviewedSha256 = taskHash({ ...work, reviewedSha256: '' });
    const sourceCommit = 'a'.repeat(40);
    const imageDigest = `registry.example/runner@sha256:${'e'.repeat(64)}`;
    const namespaceUid = 'ns-uid-0001';
    const baked = ['1', '2', '3'].map((c) => c.repeat(64));
    const bakedInputSha256 = digestOf(`${baked.join('\n')}\n`);
    const hashOf = (p: string) => digestOf(fs.readFileSync(p));
    const rootsSha = hashOf(roots);
    const content: Record<EvidenceKind, object> = {
      authorization: {
        taskNeed: work.need,
        taskSha256: taskHash({ ...work, reviewedSha256 }),
      },
      currentOwner: { taskOwner: work.owner, unowned: true },
      sourceSnapshot: {
        tsSha256: hashOf(ts),
        goSha256: hashOf(go),
        binarySha256: hashOf(bin),
        builtFromCommit: sourceCommit,
      },
      bakedInputs: {
        bootstrapSha256: baked[0],
        workerActivationSha256: baked[1],
        providerProcessSha256: baked[2],
        publicRootsSha256: rootsSha,
      },
      parentAdmission: {
        requests: '2/6Gi/24Gi',
        limits: '2/6Gi/24Gi',
        accelerators: 0,
        admitted: true,
      },
      workerAdmission: {
        requests: '2/6Gi/24Gi',
        limits: '2/6Gi/24Gi',
        accelerators: 0,
        admitted: true,
      },
      providerAdmission: {
        requests: '2/6Gi/24Gi',
        limits: '2/6Gi/24Gi',
        accelerators: 0,
        admitted: true,
      },
    };
    const evidence = Object.fromEntries(
      EVIDENCE_KINDS.map((kind) => {
        const p = write(`${kind}.json`, {
          kind,
          owner: 'o',
          observedAt: '2026-10-19T00:00:00Z',
          expiresAt: '2099-01-01T00:00:00Z',
          scope: {
            sourceCommit,
            imageDigest,
            namespaceUid,
            workSha256: reviewedSha256,
          },
          content: content[kind],
        });
        return [kind, { path: p, sha256: hashOf(p) }];
      }),
    );
    const input = {
      reviewed: {
        sourceCommit,
        tsSha256: hashOf(ts),
        goSha256: hashOf(go),
        binarySha256: hashOf(bin),
        imageDigest,
        bakedInputSha256,
      },
      kube: {
        context: 'ctx',
        cluster: 'c',
        kubeconfig: '/tmp/kubeconfig',
        namespace: 'qual-ns',
        namespaceUid,
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
        publicRootsPath: roots,
        publicRootsSha256: rootsSha,
      },
      binary: bin,
      work: { ...work, reviewedSha256 },
      evidence,
      evidenceDir: dir,
    };
    return { input, files: { ts, go }, write, content };
  }

  it('opt-in is skip when unset, run for exactly 1, otherwise rejected', () => {
    expect(optIn(undefined)).toBe('skip');
    expect(optIn('1')).toBe('run');
    for (const bad of ['', '0', 'true', '1 '])
      expect(() => optIn(bad)).toThrow();
  });

  it('accepts the fully bound input and returns the shared input digest', () => {
    const f = fixture();
    const p = f.write('input.json', f.input);
    const loaded = loadInput(p, f.files);
    expect(loaded.inputSha256).toBe(digestOf(fs.readFileSync(p)));
  });

  it('refuses raw JSON, non-private files, changed bytes and unknown fields', () => {
    const f = fixture();
    expect(() => loadInput(JSON.stringify(f.input), f.files)).toThrow(
      /absolute file/u,
    );
    expect(() =>
      loadInput(f.write('open.json', f.input, 0o644), f.files),
    ).toThrow(/private/u);
    expect(() =>
      loadInput(f.write('extra.json', { ...f.input, extra: 1 }), f.files),
    ).toThrow();
    fs.writeFileSync(f.files.ts, 'changed');
    expect(() => loadInput(f.write('i2.json', f.input), f.files)).toThrow(
      /reviewed hash/u,
    );
  });

  it('resolves every receipt to scoped, hash-matched, current evidence', () => {
    const f = fixture();
    const mutate = (kind: EvidenceKind, edit: (d: any) => void) => {
      const input = structuredClone(f.input) as any;
      const doc = JSON.parse(
        fs.readFileSync(input.evidence[kind].path, 'utf8'),
      );
      edit(doc);
      const p = f.write(`${kind}-m.json`, doc);
      input.evidence[kind] = { path: p, sha256: digestOf(fs.readFileSync(p)) };
      return () => loadInput(f.write('im.json', input), f.files);
    };
    expect(mutate('currentOwner', (d) => (d.content.unowned = false))).toThrow(
      /currentOwner/u,
    );
    expect(
      mutate('providerAdmission', (d) => (d.content.accelerators = 1)),
    ).toThrow(/providerAdmission/u);
    expect(
      mutate('sourceSnapshot', (d) => (d.scope.sourceCommit = 'b'.repeat(40))),
    ).toThrow(/scope/u);
    expect(
      mutate('authorization', (d) => (d.expiresAt = '2020-01-01T00:00:00Z')),
    ).toThrow(/current/u);
    expect(
      mutate('workerAdmission', (d) => (d.kind = 'parentAdmission')),
    ).toThrow(/kind/u);
    const missing = structuredClone(f.input) as any;
    missing.evidence.bakedInputs.sha256 = '0'.repeat(64);
    expect(() => loadInput(f.write('ih.json', missing), f.files)).toThrow(
      /hash/u,
    );
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
  });

  it('worker listener checks method, exact path, bound run and activation fence', () => {
    const r = 'run/1';
    const id = encodeURIComponent(r);
    const ok = (m: string, p: string, a?: unknown) =>
      workerRouteAllowed(m, `${API}${p}`, r, a);
    expect(ok('GET', `/runs/${id}/brief`)).toBe(true);
    expect(ok('PUT', `/runs/${id}/codex-auth`)).toBe(true);
    expect(ok('POST', '/runs/activate', r)).toBe(true);
    expect(ok('POST', '/runs/activate', 'other')).toBe(false);
    expect(ok('GET', '/runs/activate', r)).toBe(false);
    expect(ok('POST', `/runs/${id}/brief`)).toBe(false);
    expect(ok('POST', `/runs/${id}/exit`)).toBe(false);
    expect(ok('GET', `/runs/${id}/token`)).toBe(false);
    expect(ok('GET', `/runs/${id}/brief/`)).toBe(false);
    expect(ok('GET', `/runs/x${id}/brief`)).toBe(false);
    for (const p of [
      '/runs/capacity',
      '/runs/claim',
      `/runs/${id}/placement`,
      '/items',
    ])
      expect(ok('POST', p)).toBe(false);
  });

  it('translates worker headers like the production route', () => {
    const h = workerHeaderContext(
      new Headers({
        authorization: 'Bearer tok',
        'x-lcars-worker-identity': 'jwt',
        'x-lcars-worker-generation': '7',
      }),
    );
    expect(h).toEqual({
      bearerToken: 'tok',
      workerIdentityToken: 'jwt',
      workerGeneration: 7,
    });
    expect(
      workerHeaderContext(new Headers({ 'x-lcars-worker-generation': '-1' })),
    ).toEqual({});
    expect(workerHeaderContext(new Headers())).not.toBe(
      workerHeaderContext(new Headers()),
    );
  });

  it('adds only the CA delta, in the negotiated deadline location', () => {
    const job = {
      metadata: { annotations: {} },
      spec: { template: { spec: { containers: [{ name: 'r', env: [] }] } } },
    };
    const out = applyCaDelta(job, 'cm');
    expect(out.spec.activeDeadlineSeconds).toBe(RUN_DEADLINE_S);
    expect(out.spec.template.spec.activeDeadlineSeconds).toBeUndefined();
    const aware = structuredClone(job) as any;
    aware.spec.template.spec.activeDeadlineSeconds = 7200;
    const outAware = applyCaDelta(aware, 'cm');
    expect(outAware.spec.activeDeadlineSeconds).toBeUndefined();
    expect(outAware.spec.template.spec.activeDeadlineSeconds).toBe(
      RUN_DEADLINE_S,
    );
    expect(onlyCaDelta(job, out, 'cm')).toBe(true);
    const tampered = structuredClone(out);
    tampered.spec.template.spec.containers[0].command = ['x'];
    expect(onlyCaDelta(job, tampered, 'cm')).toBe(false);
    expect(() =>
      applyCaDelta(
        { spec: { template: { spec: { containers: [{}, {}] } } } },
        'x',
      ),
    ).toThrow(/exactly one/u);
    expect(() =>
      applyCaDelta(
        {
          spec: {
            template: {
              spec: { containers: [{ env: [{ name: 'CURL_CA_BUNDLE' }] }] },
            },
          },
        },
        'x',
      ),
    ).toThrow(/already/u);
  });

  it('the CA bundle keeps the public roots and adds the callback CA', () => {
    const pem = (n: string) =>
      `-----BEGIN CERTIFICATE-----\n${n}\n-----END CERTIFICATE-----`;
    const joined = joinCaBundle(pem('roots'), pem('callback'));
    expect(joined).toContain('roots');
    expect(joined).toContain('callback');
    expect(() => joinCaBundle('', pem('callback'))).toThrow();
    expect(() => joinCaBundle(pem('roots'), '')).toThrow();
  });

  describe('frame decoder', () => {
    const inv = 'invocation-1';
    const mk = (kind: string, seq: number, extra: object = {}) =>
      `${FRAME_MARKER}${JSON.stringify({ v: 1, invocation: inv, seq, kind, ...extra })}\n`;
    const identity = (seq = 1) =>
      mk('publicIdentity', seq, {
        inputSha256: 'a'.repeat(64),
        poolId: 'p',
        issuer: 'https://k',
        jwksUri: 'https://k/jwks',
        jwks: { keys: [{ kty: 'EC' }] },
        jwksSha256: 'b'.repeat(64),
        namespace: 'ns',
        serviceAccountUid: 'sa-uid-0001',
      });
    const claimed = (seq = 2) =>
      mk('claimed', seq, { runId: 'r1', producerId: 'p', jobName: 'j' });
    const decoder = () => new FrameDecoder(inv, () => 'r1');

    it('handles split bytes, split code points, coalesced frames and diagnostics', () => {
      const d = decoder();
      const bytes = Buffer.from(`=== RUN é\n${identity()}ok ✓\n${claimed()}`);
      const got: Frame[] = [];
      for (let i = 0; i < bytes.length; i += 3)
        got.push(...d.push(bytes.subarray(i, i + 3)));
      d.end();
      expect(got.map((f) => f.kind)).toEqual(['publicIdentity', 'claimed']);
      expect(d.diagnostics).toBeGreaterThan(0);
    });
    it('rejects an unfinished trailing frame, bad order, wrong run and after-finish', () => {
      const d = decoder();
      d.push(Buffer.from(identity().slice(0, -1)));
      expect(() => d.end()).toThrow(/unfinished/u);
      const o = decoder();
      o.push(Buffer.from(identity()));
      expect(() => o.push(Buffer.from(identity(2)))).toThrow(/out of order/u);
      const w = new FrameDecoder(inv, () => 'other');
      w.push(Buffer.from(identity()));
      expect(() => w.push(Buffer.from(claimed()))).toThrow(/different run/u);
      const f = decoder();
      f.push(Buffer.from(identity()));
      f.markFinished();
      expect(() => f.push(Buffer.from(claimed()))).toThrow(/after finish/u);
    });
    it('rejects unknown kinds, extra properties, oversize frames and bad invocations', () => {
      expect(() => decoder().push(Buffer.from(mk('nope', 1)))).toThrow();
      expect(() =>
        decoder().push(
          Buffer.from(claimed(1).replace('"seq":1', '"seq":1,"runToken":"x"')),
        ),
      ).toThrow();
      expect(() =>
        decoder().push(
          Buffer.from(`${FRAME_MARKER}${'x'.repeat(FRAME_LIMIT)}\n`),
        ),
      ).toThrow(/too large/u);
      expect(() =>
        decoder().push(Buffer.from(identity().replace(inv, 'someone-else-1'))),
      ).toThrow(/invocation/u);
    });
    it('publishes public JWKS members only', () => {
      expect(
        publicJwksOnly({ keys: [{ kty: 'RSA', n: 'x', e: 'AQAB' }] }),
      ).toBe(true);
      expect(
        publicJwksOnly({ keys: [{ kty: 'RSA', n: 'x', d: 'secret' }] }),
      ).toBe(false);
    });
  });

  describe('existing capacity worker verifier, offline signed tokens (unit control)', () => {
    async function setup() {
      const { publicKey, privateKey } = await generateKeyPair('ES256');
      const jwk = { ...(await exportJWK(publicKey)), alg: 'ES256', use: 'sig' };
      const keys = createLocalJWKSet({ keys: [jwk] } satisfies JSONWebKeySet);
      const id = {
        poolId: 'pool',
        issuer: 'https://issuer.example',
        jwksUri: 'https://issuer.example/jwks',
        audience: 'aud',
        namespace: 'ns',
        serviceAccountUid: 'sa-uid',
      };
      const sign = (
        claims: Record<string, unknown>,
        o: { iss?: string; aud?: string; exp?: string } = {},
      ) =>
        new SignJWT(claims)
          .setProtectedHeader({ alg: 'ES256' })
          .setIssuer(o.iss ?? id.issuer)
          .setAudience(o.aud ?? id.audience)
          .setIssuedAt()
          .setExpirationTime(o.exp ?? '10m')
          .sign(privateKey);
      const bound = {
        namespace: 'ns',
        pod: { uid: 'pod-1' },
        serviceaccount: { uid: 'sa-uid' },
      };
      return { keys, id, sign, bound };
    }
    const withEnv = async <T>(value: string, f: () => Promise<T>) => {
      const saved = process.env.AGENT_LCARS_CAPACITY_WORKER_IDENTITIES;
      process.env.AGENT_LCARS_CAPACITY_WORKER_IDENTITIES = value;
      try {
        return await f();
      } finally {
        if (saved === undefined)
          delete process.env.AGENT_LCARS_CAPACITY_WORKER_IDENTITIES;
        else process.env.AGENT_LCARS_CAPACITY_WORKER_IDENTITIES = saved;
      }
    };
    it('accepts a bound token and refuses forged, wrong-scope and expired ones', async () => {
      const { keys, id, sign, bound } = await setup();
      await withEnv(JSON.stringify([id]), async () => {
        await expect(
          verifyCapacityWorkerIdentity(
            await sign({ 'kubernetes.io': bound }),
            'pool',
            keys,
          ),
        ).resolves.toEqual({ podUid: 'pod-1', namespace: 'ns' });
        const bad = [
          sign({ 'kubernetes.io': bound }, { iss: 'https://evil.example' }),
          sign({ 'kubernetes.io': bound }, { aud: 'other' }),
          sign({ 'kubernetes.io': { ...bound, namespace: 'x' } }),
          sign({ 'kubernetes.io': { ...bound, serviceaccount: { uid: 'x' } } }),
          sign({
            'kubernetes.io': {
              namespace: 'ns',
              serviceaccount: { uid: 'sa-uid' },
            },
          }),
          sign({ 'kubernetes.io': bound }, { exp: '-1m' }),
        ];
        for (const t of bad)
          await expect(
            verifyCapacityWorkerIdentity(await t, 'pool', keys),
          ).rejects.toThrow();
        const other = await setup();
        await expect(
          verifyCapacityWorkerIdentity(
            await other.sign({ 'kubernetes.io': bound }),
            'pool',
            keys,
          ),
        ).rejects.toThrow();
        await expect(
          verifyCapacityWorkerIdentity(
            await sign({ 'kubernetes.io': bound }),
            'unknown',
            keys,
          ),
        ).rejects.toThrow(/No declared/u);
      });
    });
  });
});

// ---- Opt-in family: skipped (not passed) unless exactly enabled. ----
const mode = optIn(process.env.LCARS_RECEIPT_USEFUL_WORK);

describe.skipIf(mode === 'skip')('isolated real-bootstrap useful work', () => {
  const closers: (() => Promise<void>)[] = [];
  let child: ChildProcess | undefined;

  // Set only after export, reopen-confirmation and the finish ACK succeed. Until
  // then every private transient path is retained for recovery.
  let clean = false;
  const retained: string[] = [];

  afterAll(async () => {
    // Join exactly what this suite started, LAST. SIGTERM asks for graceful
    // handling and we AWAIT the child's close; a signal or local process death
    // is never retirement or cleanup proof (Go reports exact retained identities).
    if (child?.pid !== undefined && child.exitCode === null) {
      const gone = new Promise<void>((r) => child!.once('close', () => r()));
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        // Already gone.
      }
      await Promise.race([
        gone,
        new Promise<void>((r) => setTimeout(r, CLEANUP_BUDGET_S * 1000)),
      ]);
      if (child.exitCode === null)
        retained.push(`child pid ${child.pid} did not exit`);
    }
    for (const close of closers.reverse()) await close();
    if (retained.length !== 0)
      console.error(
        `useful-work retained recovery state: ${retained.join('; ')}`,
      );
  });

  it(
    'runs one genuinely needed report through the unchanged worker path',
    { timeout: OUTER_MS + 120_000 },
    async () => {
      const here = new URL(import.meta.url).pathname;
      const { input, inputSha256 } = loadInput(
        process.env.LCARS_RECEIPT_USEFUL_WORK_INPUT,
        {
          ts: here,
          go: path.join(
            path.dirname(here),
            '../../../runner-autoscaler/queue_receipt_useful_work_kubernetes_integration_test.go',
          ),
        },
      );
      const options = emulatorOptions(process.env);
      const store: OrchestratorStore = new FirestoreStore(options);
      const reopened: OrchestratorStore = new FirestoreStore(options);
      const orchestrator = new Orchestrator(store, {
        now: () => new Date().toISOString(),
      });
      const invocation = crypto.randomBytes(8).toString('hex');
      const poolId = `uw-${invocation}`;

      // Providers are lazy: nothing reads credentials until a route needs one.
      const codexAuth = codexAuthStore('agent-lcars-codex-auth');

      const workId = Array.from(
        crypto.randomBytes(26),
        (b) => '0123456789ABCDEFGHJKMNPQRSTVWXYZ'[b % 32],
      ).join('');
      const decision = await orchestrator.request({
        taskId: { workId },
        requestId: `useful-work-${invocation}`,
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
      let localJwks: ReturnType<typeof createLocalJWKSet> | undefined;
      const derived: { podUid: string; namespace: string }[] = [];
      const runtime: Omit<RunsContext, 'bearerToken' | 'principal'> = {
        store,
        orchestrator,
        now: () => new Date(),
        capacityEnabled: true,
        tokens: lazyDispatchTokenProvider(() =>
          createDispatchTokenProvider(
            process.env,
            ORCHESTRATOR_GITHUB_PERMISSIONS,
          ),
        ),
        checkoutTokens: lazyDispatchTokenProvider(() =>
          createDispatchTokenProvider(process.env, DIRECT_RUNNER_PERMISSIONS),
        ),
        codexAuth,
        // Honest: the isolated drain performs no external effects and leaves the
        // outbox pending; this proves no webhook/session-expiry/delivery.
        drain: async () => ({ dispatched: [], reported: [], failed: [] }),
        verifyWorkerIdentity: async (token, pool) => {
          if (localJwks === undefined)
            throw new Error('worker identity keys not bound');
          const out = await verifyCapacityWorkerIdentity(
            token,
            pool,
            localJwks,
          );
          derived.push(out);
          return out;
        },
      };
      const handler = createRunsHandler();
      const serve = async (
        req: http.IncomingMessage,
        res: http.ServerResponse,
        controller: boolean,
      ) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const c of req) {
          size += (c as Buffer).length;
          if (size > BODY_LIMIT) return void res.writeHead(413).end();
          chunks.push(c as Buffer);
        }
        const body = Buffer.concat(chunks);
        let parsed: { fence?: { runId?: unknown } } | undefined;
        try {
          parsed =
            body.length === 0 ? undefined : JSON.parse(body.toString('utf8'));
        } catch {
          parsed = undefined;
        }
        if (
          !controller &&
          !workerRouteAllowed(
            req.method ?? '',
            url.pathname,
            runId,
            parsed?.fence?.runId,
          )
        )
          return void res.writeHead(404).end();
        const headers = new Headers();
        for (const [k, v] of Object.entries(req.headers))
          if (typeof v === 'string') headers.set(k, v);
        const translated = workerHeaderContext(headers);
        const context: RunsContext = {
          ...runtime,
          ...translated,
          ...(controller && translated.bearerToken === controllerBearer
            ? { principal }
            : {}),
        };
        const result = await handler.handle(
          new Request(`http://localhost${url.pathname}${url.search}`, {
            method: req.method,
            headers,
            ...(body.length === 0 ? {} : { body }),
          }),
          { prefix: API, context },
        );
        if (!result.matched || result.response === undefined)
          return void res.writeHead(404).end();
        res.writeHead(
          result.response.status,
          Object.fromEntries(result.response.headers.entries()),
        );
        res.end(Buffer.from(await result.response.arrayBuffer()));
      };
      const guard =
        (controller: boolean) =>
        (q: http.IncomingMessage, s: http.ServerResponse) =>
          void serve(q, s, controller).catch(() => {
            if (!s.headersSent) s.writeHead(500).end();
          });

      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'useful-work-'));
      fs.chmodSync(tmp, 0o700);
      closers.push(async () => {
        if (clean) fs.rmSync(tmp, { recursive: true, force: true });
        else retained.push(`private transient state ${tmp}`);
      });
      const tls = await makeCallbackTls(input.callback.ip, tmp);
      const bundle = path.join(tmp, 'ca-bundle.pem');
      fs.writeFileSync(
        bundle,
        joinCaBundle(
          fs.readFileSync(input.callback.publicRootsPath, 'utf8'),
          tls.cert,
        ),
        { mode: 0o600 },
      );

      const controllerServer = http.createServer(guard(true));
      await new Promise<void>((r) =>
        controllerServer.listen(0, '127.0.0.1', r),
      );
      closers.push(
        () => new Promise<void>((r) => controllerServer.close(() => r())),
      );
      // Pod-reachable listener binds the one qualified private IP, never 0.0.0.0.
      const workerServer = https.createServer(
        { key: tls.key, cert: tls.cert },
        guard(false),
      );
      await new Promise<void>((r) =>
        workerServer.listen(0, input.callback.ip, r),
      );
      closers.push(
        () => new Promise<void>((r) => workerServer.close(() => r())),
      );
      const controllerUrl = `http://127.0.0.1:${(controllerServer.address() as { port: number }).port}`;
      const callbackUrl = `https://${input.callback.ip}:${(workerServer.address() as { port: number }).port}`;

      const post = async (body: unknown) => {
        const r = await fetch(`${controllerUrl}${API}/runs/capacity`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${controllerBearer}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
        });
        return {
          status: r.status,
          body: (await r.json()) as { digest?: string },
        };
      };
      // Configure then import ONE empty invocation-local pool through the real
      // route. Setting capacityEnabled alone neither imports nor qualifies it.
      const preparePool = async () => {
        const now = new Date().toISOString();
        const before = await new CapacityProtocol(reopened).read(now);
        if (before.receipts.length !== 0)
          throw new Error('isolated inventory is not empty');
        const policy = {
          poolId,
          cluster: POOL_CLUSTER,
          namespace: input.kube.namespace,
          version: 1,
          maxConcurrent: 1,
          maxUnplaced: 1,
          enforced: true,
          inventoryKnown: false,
          domains: { codex: { domainId: `${poolId}-codex`, ceiling: 1 } },
        };
        if ((await post({ action: 'configure', policy })).status !== 200)
          throw new Error('configure refused');
        const proposal = {
          action: 'import',
          dryRun: true,
          known: true,
          evidence: 'reviewed-complete-inventory',
          inventory: [],
        };
        const dry = await post(proposal);
        if (dry.status !== 200 || dry.body.digest === undefined)
          throw new Error('import dry-run refused');
        if (
          (
            await post({
              ...proposal,
              dryRun: false,
              reviewedDigest: dry.body.digest,
            })
          ).status !== 200
        )
          throw new Error('import refused');
      };

      const savedIdentities =
        process.env.AGENT_LCARS_CAPACITY_WORKER_IDENTITIES;
      closers.push(async () => {
        if (savedIdentities === undefined)
          delete process.env.AGENT_LCARS_CAPACITY_WORKER_IDENTITIES;
        else
          process.env.AGENT_LCARS_CAPACITY_WORKER_IDENTITIES = savedIdentities;
      });

      const decoder = new FrameDecoder(invocation, () => runId);
      const timeline: { kind: string; at: string; seq: number }[] = [];
      let output = '';
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
            LCARS_RECEIPT_USEFUL_WORK_DESCRIPTOR: JSON.stringify({
              invocation,
              inputSha256,
              poolId,
              cluster: POOL_CLUSTER,
              runId,
              workId,
              controllerUrl,
              callbackUrl,
              caBundlePath: bundle,
            }),
          },
        },
      );
      const proc = child;
      // One lifecycle promise: parser, handler, child error/exit/timeout all land here.
      const writeAck = (name: string) =>
        new Promise<void>((resolve, reject) => {
          const ok = proc.stdin!.write(
            `${JSON.stringify({ ack: name, invocation })}\n`,
            (e) => (e ? reject(e) : resolve()),
          );
          if (!ok) proc.stdin!.once('drain', () => undefined);
        });
      const lifecycle = new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('outer 1500s bound exceeded')),
          OUTER_MS,
        );
        let chain = Promise.resolve();
        const fail = (e: unknown) => {
          clearTimeout(timer);
          reject(e instanceof Error ? e : new Error(String(e)));
        };
        proc.once('error', fail);
        proc.stdin!.on('error', fail);
        proc.stderr!.on('data', (c: Buffer) => {
          if (output.length < 256 << 10)
            output += c.toString().replaceAll(controllerBearer, '[redacted]');
        });
        proc.stdout!.on('data', (c: Buffer) => {
          if (output.length < 256 << 10)
            output += c.toString().replaceAll(controllerBearer, '[redacted]');
          try {
            for (const frame of decoder.push(c)) {
              timeline.push({
                kind: frame.kind,
                at: new Date().toISOString(),
                seq: frame.seq,
              });
              chain = chain.then(() => onFrame(frame)).catch(fail);
            }
          } catch (e) {
            fail(e);
          }
        });
        proc.once('close', (code) => {
          void chain.then(() => {
            try {
              decoder.end();
            } catch (e) {
              return fail(e);
            }
            clearTimeout(timer);
            resolve(code);
          });
        });
      });
      lifecycle.catch(() => undefined);
      // The fixture bearer travels only on the private stdin pipe, never argv.
      proc.stdin!.write(
        `${JSON.stringify({ controllerBearer, invocation })}\n`,
      );

      let report: unknown;
      let recovery: { recovered: string[]; unresolved: string[] } | undefined;
      const evidence: Record<string, unknown> = {
        invocation,
        runId,
        workId,
        inputSha256,
        timeline,
        derived,
      };
      async function onFrame(frame: Frame) {
        if (frame.kind === 'publicIdentity') {
          const f = frame as unknown as z.infer<
            typeof frameShapes.publicIdentity
          >;
          if (
            f.inputSha256 !== inputSha256 ||
            f.poolId !== poolId ||
            f.namespace !== input.kube.namespace ||
            f.serviceAccountUid !== input.kube.serviceAccountUid
          )
            throw new Error('publicIdentity is not bound to this invocation');
          if (!publicJwksOnly(f.jwks as { keys: Record<string, unknown>[] }))
            throw new Error('JWKS carries private members');
          if (digestOf(JSON.stringify(f.jwks)) !== f.jwksSha256)
            throw new Error('JWKS hash mismatch');
          localJwks = createLocalJWKSet(f.jwks as unknown as JSONWebKeySet);
          // Process-local mapping only; restored by the closer above.
          process.env.AGENT_LCARS_CAPACITY_WORKER_IDENTITIES = JSON.stringify([
            {
              poolId,
              issuer: f.issuer,
              jwksUri: f.jwksUri,
              audience: input.kube.audience,
              namespace: f.namespace,
              serviceAccountUid: f.serviceAccountUid,
            },
          ]);
          await preparePool();
          await writeAck('prepared');
        }
        if (frame.kind === 'providerObserved') {
          // Container start proves nothing; require the authoritative marker the
          // real heartbeat committed after the accepted activation.
          const deadline = Date.now() + 120_000;
          for (;;) {
            const live = await reopened.readRun(runId);
            const marker = live?.queue?.providerProcessStartedAt;
            if (marker !== undefined) {
              evidence.providerProcessStartedAt = marker;
              break;
            }
            if (Date.now() > deadline)
              throw new Error('providerProcessStartedAt was never committed');
            await new Promise((r) => setTimeout(r, 2000));
          }
        }
        if (frame.kind === 'usefulCompleted') {
          // Canonical finished report from the SECOND client; nothing here wrote it.
          const run = await reopened.readRun(runId);
          const task = await reopened.readTask({ workId });
          if (
            run?.state !== 'finished' ||
            run.result?.ok !== true ||
            run.result.summary !== 'report' ||
            (run.result.message ?? '').trim() === ''
          )
            throw new Error(
              `run is not a finished successful report (state=${run?.state})`,
            );
          // The trusted OS spawn helper's time, committed by the real heartbeat;
          // spawn alone is not a model response, and the model stays unknown
          // unless a real provider archive observed it.
          const started = run.queue?.providerProcessStartedAt;
          if (started === undefined)
            throw new Error('providerProcessStartedAt was never committed');
          evidence.providerProcessStartedAt = started;
          evidence.model = 'unknown';
          report = {
            state: run.state,
            result: run.result,
            task: task?.task.workId,
          };
          // Canonical recovery through the owning adapter; unresolved debt keeps
          // the Go side from treating cleanup as a success.
          recovery = await recoverCodexCredentialOperations({
            store: reopened,
            orchestrator,
            codexAuth,
            now: () => new Date(),
          });
          if (recovery.unresolved.length !== 0)
            throw new Error(
              `credential operations unresolved: ${recovery.unresolved.join(',')}`,
            );
          await writeAck('usefulRecorded');
        }
        if (frame.kind === 'cleanup') {
          // Export the actual durable state from a reopened Store, freeze it
          // outside the checkout, then confirm it against a THIRD client and the
          // owning adapter's lease before the finish ACK.
          const snapshot = async (store: OrchestratorStore) => ({
            run: await store.readRun(runId),
            task: await store.readTask({ workId }),
            capacity: await new CapacityProtocol(store).read(
              new Date().toISOString(),
            ),
          });
          const exported = await snapshot(reopened);
          const confirmed = await snapshot(new FirestoreStore(options));
          if (JSON.stringify(exported) !== JSON.stringify(confirmed))
            throw new Error('reopened Store differs from the exported state');
          if (
            exported.capacity.receipts.some(
              (r) => r.runId === runId && r.state !== 'retired',
            )
          )
            retained.push(`live capacity receipt for ${runId}`);
          const lease = await codexAuth.readLease();
          if (lease !== undefined && JSON.stringify(lease).includes(runId))
            throw new Error(
              'Codex lease still names this run; recovery unresolved',
            );
          evidence.leaseHeldByRun = false;
          evidence.report = report;
          evidence.recovery = recovery;
          evidence.cleanup = frame;
          evidence.store = exported;
          const outDir = fs.mkdtempSync(
            path.join(os.tmpdir(), `useful-work-evidence-${invocation}-`),
          );
          fs.chmodSync(outDir, 0o700);
          fs.writeFileSync(
            path.join(outDir, 'evidence.json'),
            JSON.stringify(evidence),
            { mode: 0o600 },
          );
          retained.push(`frozen evidence ${outDir}`);
          if (retained.length > 1)
            throw new Error(`unresolved: ${retained.join('; ')}`);
          decoder.markFinished();
          await writeAck('finish');
          proc.stdin!.end();
        }
      }
      let code: number | null;
      try {
        code = await lifecycle;
      } catch (e) {
        // Unresolved state is retained, never discarded; no cleanup credit.
        console.error(output.slice(-(64 << 10)));
        throw e;
      }
      if (code !== 0) console.error(output.slice(-(64 << 10)));
      expect(code).toBe(0);
      expect(output).toMatch(/--- PASS: TestReceiptKubernetesUsefulWork\b/u);
      expect(output).not.toMatch(
        /--- SKIP: TestReceiptKubernetesUsefulWork\b/u,
      );
      expect(decoder.frames.map((f) => f.kind)).toEqual([...FRAME_ORDER]);
      expect(report).toBeDefined();
      clean = true;
    },
  );
});

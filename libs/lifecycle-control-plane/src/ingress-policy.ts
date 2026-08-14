import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import type {
  ControlPlaneSignal,
  ControlPlaneSignalEnvelope,
  PolicyDecision,
  PolicyPrincipal,
  TenantRef,
} from '@agent-lcars/dispatch-contracts';
import {
  controlPlaneSignalEnvelopeSchema,
  policyPrincipalSchema,
  tenantRefSchema,
  utcDateTimeSchema,
} from '@agent-lcars/dispatch-contracts';

import type { AuthorityClock, WriteResult } from './authority-storage';

const SHA256 = /^[a-f0-9]{64}$/u;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const SIGNATURE = /^sha256=([a-f0-9]{64})$/u;
const POLICY_DECISIONS = new Set(['accepted', 'rejected']);
const SOURCE_KINDS = new Set([
  'github-webhook',
  'operator-command',
  'schedule-reconcile',
]);
const SIGNAL_KINDS = new Set(['cancel', 'park', 'reconcile', 'requested-work']);
const REQUESTED_WORK_MODES = new Set([
  'implement',
  'reply',
  'review',
  'runbook',
]);

export class IngressPolicyConflict extends Error {
  override name = 'IngressPolicyConflict';
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => compareStrings(left, right))
        .map(([key, child]) => [key, canonicalValue(child)]),
    );
  }
  return value;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function validOpaqueId(value: string): boolean {
  return OPAQUE_ID.test(value);
}

function trustedNow(clock: AuthorityClock): string {
  const value = clock.now();
  if (!utcDateTimeSchema.safeParse(value).success) {
    throw new IngressPolicyConflict('Trusted clock returned an invalid time');
  }
  return value;
}

export interface WebhookVerificationKey {
  version: string;
  secret: Uint8Array;
}

/** Secret lookup/rotation remains an injected service boundary. */
export interface WebhookVerificationKeyResolver {
  resolveKeys(): Promise<readonly WebhookVerificationKey[]>;
}

export interface WebhookHmacSha256 {
  digest(secret: Uint8Array, rawBody: Uint8Array): Promise<Uint8Array>;
}

export class NodeWebhookHmacSha256 implements WebhookHmacSha256 {
  async digest(secret: Uint8Array, rawBody: Uint8Array): Promise<Uint8Array> {
    return createHmac('sha256', secret).update(rawBody).digest();
  }
}

const verifiedBrand = Symbol('verified-github-webhook');
const normalizedBrand = Symbol('verified-normalized-ingress');

export interface VerifiedGitHubWebhookReceipt {
  readonly schema: 'agent-lcars.verified-github-webhook/v1';
  readonly version: 1;
  readonly deliveryId: string;
  readonly event: string;
  readonly bodySha256: string;
  readonly hmacKeyVersion: string;
  readonly receivedAt: string;
  readonly [verifiedBrand]: true;
}

const verifiedBodies = new WeakMap<object, Uint8Array>();
const verifiedEnvelopes = new WeakSet<object>();

export type VerifiedControlPlaneSignalEnvelope = ControlPlaneSignalEnvelope & {
  readonly [normalizedBrand]: true;
};

function verifiedBody(receipt: VerifiedGitHubWebhookReceipt): Uint8Array {
  const body = verifiedBodies.get(receipt);
  if (body === undefined || receipt[verifiedBrand] !== true) {
    throw new IngressPolicyConflict('Webhook receipt was not verified here');
  }
  return body;
}

export interface VerifyGitHubWebhookInput {
  rawBody: Uint8Array;
  signatureHeader: string;
  deliveryId: string;
  event: string;
}

/**
 * Verifies exact raw bytes. The caller cannot select a key version or assert a
 * body digest, and the returned receipt serializes no raw body/signature/key.
 */
export class GitHubWebhookVerifier {
  constructor(
    private readonly keys: WebhookVerificationKeyResolver,
    private readonly hmac: WebhookHmacSha256,
    private readonly clock: AuthorityClock,
  ) {}

  async verify(
    input: VerifyGitHubWebhookInput,
  ): Promise<VerifiedGitHubWebhookReceipt> {
    const signature = input.signatureHeader.match(SIGNATURE)?.[1];
    if (
      signature === undefined ||
      !validOpaqueId(input.deliveryId) ||
      input.event.length === 0 ||
      input.event.length > 200
    ) {
      throw new IngressPolicyConflict('Webhook verification failed');
    }
    const expected = Buffer.from(signature, 'hex');
    const configured = await this.keys.resolveKeys();
    const versions = new Set<string>();
    const matches: string[] = [];
    for (const key of configured) {
      if (
        !validOpaqueId(key.version) ||
        key.secret.length === 0 ||
        versions.has(key.version)
      ) {
        throw new IngressPolicyConflict('Webhook key configuration is invalid');
      }
      versions.add(key.version);
      const actual = await this.hmac.digest(key.secret, input.rawBody);
      if (
        actual.length === expected.length &&
        timingSafeEqual(actual, expected)
      ) {
        matches.push(key.version);
      }
    }
    if (matches.length !== 1) {
      throw new IngressPolicyConflict('Webhook verification failed');
    }
    const receipt: VerifiedGitHubWebhookReceipt = {
      schema: 'agent-lcars.verified-github-webhook/v1',
      version: 1,
      deliveryId: input.deliveryId,
      event: input.event,
      bodySha256: sha256(input.rawBody),
      hmacKeyVersion: matches[0] as string,
      receivedAt: trustedNow(this.clock),
      [verifiedBrand]: true,
    };
    deepFreeze(receipt);
    verifiedBodies.set(receipt, Uint8Array.from(input.rawBody));
    return receipt;
  }
}

export interface TenantRegistration {
  tenant: TenantRef;
}

export interface TenantRegistrationRegistry {
  register(registration: TenantRegistration): Promise<WriteResult>;
  resolve(
    repositoryId: number,
    installationId: number,
  ): Promise<TenantRegistration | undefined>;
}

export class InMemoryTenantRegistrationRegistry implements TenantRegistrationRegistry {
  private readonly byProviderIdentity = new Map<string, TenantRegistration>();
  private readonly byTenant = new Map<string, TenantRegistration>();

  async register(registration: TenantRegistration): Promise<WriteResult> {
    if (!tenantRefSchema.safeParse(registration.tenant).success) {
      throw new IngressPolicyConflict('Tenant registration is invalid');
    }
    const providerKey = `${registration.tenant.repositoryId}:${registration.tenant.installationId}`;
    const providerCurrent = this.byProviderIdentity.get(providerKey);
    const tenantCurrent = this.byTenant.get(registration.tenant.tenantId);
    if (
      same(providerCurrent, registration) &&
      same(tenantCurrent, registration)
    ) {
      return 'replay';
    }
    if (providerCurrent !== undefined || tenantCurrent !== undefined) {
      throw new IngressPolicyConflict('Tenant registration conflicts');
    }
    this.byProviderIdentity.set(providerKey, clone(registration));
    this.byTenant.set(registration.tenant.tenantId, clone(registration));
    return 'applied';
  }

  async resolve(
    repositoryId: number,
    installationId: number,
  ): Promise<TenantRegistration | undefined> {
    const value = this.byProviderIdentity.get(
      `${repositoryId}:${installationId}`,
    );
    return value === undefined ? undefined : clone(value);
  }
}

export interface ParsedGitHubWebhookFact {
  event: string;
  action: string;
  repositoryId: number;
  repository: string;
  installationId: number;
  actorId: number;
  actorLogin: string;
  issueNumber: number;
  occurredAt: string;
  requestId: string;
  factId: string;
  payload: unknown;
}

export interface GitHubSignalInterpreter {
  interpret(fact: ParsedGitHubWebhookFact): Promise<ControlPlaneSignal>;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function nonemptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function parsedGitHubFact(
  receipt: VerifiedGitHubWebhookReceipt,
  rawBody: Uint8Array,
): Omit<ParsedGitHubWebhookFact, 'requestId' | 'factId'> {
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(rawBody).toString('utf8')) as unknown;
  } catch {
    throw new IngressPolicyConflict('Signed webhook payload is invalid');
  }
  const root = object(payload);
  const repository = object(root?.repository);
  const installation = object(root?.installation);
  const sender = object(root?.sender);
  const issue = object(root?.issue);
  const pullRequest = object(root?.pull_request);
  const comment = object(root?.comment);
  const repositoryId = positiveInteger(repository?.id);
  const installationId = positiveInteger(installation?.id);
  const actorId = positiveInteger(sender?.id);
  const issueNumber =
    positiveInteger(issue?.number) ?? positiveInteger(pullRequest?.number);
  const action = nonemptyString(root?.action);
  const repositoryName = nonemptyString(repository?.full_name);
  const actorLogin = nonemptyString(sender?.login);
  const occurredAt =
    nonemptyString(comment?.created_at) ??
    nonemptyString(issue?.updated_at) ??
    nonemptyString(pullRequest?.updated_at);
  if (
    repositoryId === undefined ||
    installationId === undefined ||
    actorId === undefined ||
    issueNumber === undefined ||
    action === undefined ||
    repositoryName === undefined ||
    actorLogin === undefined ||
    occurredAt === undefined ||
    !utcDateTimeSchema.safeParse(occurredAt).success
  ) {
    throw new IngressPolicyConflict('Signed webhook payload is invalid');
  }
  return {
    event: receipt.event,
    action,
    repositoryId,
    repository: repositoryName,
    installationId,
    actorId,
    actorLogin,
    issueNumber,
    occurredAt,
    payload,
  };
}

/** Numeric repository+installation registration is the sole tenant selector. */
export class GitHubWebhookNormalizer {
  constructor(
    private readonly tenants: TenantRegistrationRegistry,
    private readonly interpreter: GitHubSignalInterpreter,
  ) {}

  async normalize(
    receipt: VerifiedGitHubWebhookReceipt,
  ): Promise<VerifiedControlPlaneSignalEnvelope> {
    const rawBody = verifiedBody(receipt);
    const unscoped = parsedGitHubFact(receipt, rawBody);
    const registration = await this.tenants.resolve(
      unscoped.repositoryId,
      unscoped.installationId,
    );
    if (registration === undefined) {
      throw new IngressPolicyConflict('Webhook tenant is not registered');
    }
    const identityMaterial = canonicalJson([
      registration.tenant.tenantId,
      receipt.deliveryId,
    ]);
    const requestId = `gh-request:${sha256(`request:${identityMaterial}`)}`;
    const factId = `gh-fact:${sha256(`fact:${identityMaterial}`)}`;
    const fact: ParsedGitHubWebhookFact = {
      ...unscoped,
      requestId,
      factId,
    };
    const signal = await this.interpreter.interpret(clone(fact));
    const envelope: ControlPlaneSignalEnvelope = {
      schema: 'agent-lcars.control-plane-signal/v1',
      version: 1,
      requestId,
      factId,
      tenant: clone(registration.tenant),
      task: {
        tenantId: registration.tenant.tenantId,
        repositoryId: registration.tenant.repositoryId,
        issueNumber: fact.issueNumber,
      },
      signal: clone(signal),
      receivedAt: receipt.receivedAt,
      source: {
        kind: 'github-webhook',
        deliveryId: receipt.deliveryId,
        repositoryId: registration.tenant.repositoryId,
        installationId: registration.tenant.installationId,
        bodySha256: receipt.bodySha256,
        event: receipt.event,
        action: fact.action,
        actorId: fact.actorId,
        actorLogin: fact.actorLogin,
        occurredAt: fact.occurredAt,
        hmacKeyVersion: receipt.hmacKeyVersion,
      },
    };
    const parsed = controlPlaneSignalEnvelopeSchema.safeParse(envelope);
    if (!parsed.success) {
      throw new IngressPolicyConflict('Normalized webhook signal is invalid');
    }
    const verifiedEnvelope = parsed.data as VerifiedControlPlaneSignalEnvelope;
    Object.defineProperty(verifiedEnvelope, normalizedBrand, {
      value: true,
      enumerable: false,
    });
    deepFreeze(verifiedEnvelope);
    verifiedEnvelopes.add(verifiedEnvelope);
    return verifiedEnvelope;
  }
}

export type PolicyRulePrincipal =
  | { kind: 'github-actor'; actorIds: readonly number[] }
  | { kind: 'operator'; operatorIds: readonly string[] }
  | { kind: 'system'; systemIds: readonly string[] };

export interface IngressPolicyRule {
  ruleId: string;
  priority: number;
  decision: 'accepted' | 'rejected';
  principal: PolicyRulePrincipal;
  requiredRoles?: readonly string[];
  sourceKinds: readonly ControlPlaneSignalEnvelope['source']['kind'][];
  signalKinds: readonly ControlPlaneSignal['kind'][];
  modes?: readonly Extract<
    ControlPlaneSignal,
    { kind: 'requested-work' }
  >['mode'][];
}

export interface RegisteredIngressPolicy {
  schema: 'agent-lcars.registered-ingress-policy/v1';
  version: 1;
  tenantId: string;
  repositoryId: number;
  policyId: string;
  policyVersion: number;
  contentSha256: string;
  rules: readonly IngressPolicyRule[];
}

function uniqueSorted<T extends string | number>(values: readonly T[]): T[] {
  return [...new Set(values)].sort((left, right) =>
    compareStrings(String(left), String(right)),
  );
}

function normalizedRule(rule: IngressPolicyRule): unknown {
  const principal =
    rule.principal.kind === 'github-actor'
      ? {
          kind: rule.principal.kind,
          actorIds: uniqueSorted(rule.principal.actorIds),
        }
      : rule.principal.kind === 'operator'
        ? {
            kind: rule.principal.kind,
            operatorIds: uniqueSorted(rule.principal.operatorIds),
          }
        : {
            kind: rule.principal.kind,
            systemIds: uniqueSorted(rule.principal.systemIds),
          };
  return {
    ruleId: rule.ruleId,
    priority: rule.priority,
    decision: rule.decision,
    principal,
    requiredRoles: uniqueSorted(rule.requiredRoles ?? []),
    sourceKinds: uniqueSorted(rule.sourceKinds),
    signalKinds: uniqueSorted(rule.signalKinds),
    modes: uniqueSorted(rule.modes ?? []),
  };
}

export function ingressPolicyContentSha256(
  policy: Omit<RegisteredIngressPolicy, 'contentSha256'>,
): string {
  return sha256(
    canonicalJson({
      schema: policy.schema,
      version: policy.version,
      tenantId: policy.tenantId,
      repositoryId: policy.repositoryId,
      policyId: policy.policyId,
      policyVersion: policy.policyVersion,
      rules: [...policy.rules]
        .sort((left, right) => compareStrings(left.ruleId, right.ruleId))
        .map(normalizedRule),
    }),
  );
}

function stringArray(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === 'string')
  );
}

function validPolicyRule(value: unknown, ruleIds: Set<string>): boolean {
  const candidate = object(value);
  const principal = object(candidate?.principal);
  if (
    candidate === undefined ||
    principal === undefined ||
    !validOpaqueId(String(candidate.ruleId ?? '')) ||
    ruleIds.has(candidate.ruleId as string) ||
    !Number.isSafeInteger(candidate.priority) ||
    (candidate.priority as number) < 0 ||
    !POLICY_DECISIONS.has(String(candidate.decision)) ||
    !stringArray(candidate.sourceKinds) ||
    candidate.sourceKinds.length === 0 ||
    !candidate.sourceKinds.every((kind) => SOURCE_KINDS.has(kind)) ||
    !stringArray(candidate.signalKinds) ||
    candidate.signalKinds.length === 0 ||
    !candidate.signalKinds.every((kind) => SIGNAL_KINDS.has(kind)) ||
    (candidate.modes !== undefined &&
      (!stringArray(candidate.modes) ||
        !candidate.modes.every((mode) => REQUESTED_WORK_MODES.has(mode)))) ||
    (candidate.requiredRoles !== undefined &&
      (!stringArray(candidate.requiredRoles) ||
        !candidate.requiredRoles.every(validOpaqueId)))
  ) {
    return false;
  }
  const principalKind = principal.kind;
  const principalIds =
    principalKind === 'github-actor'
      ? principal.actorIds
      : principalKind === 'operator'
        ? principal.operatorIds
        : principalKind === 'system'
          ? principal.systemIds
          : undefined;
  if (!Array.isArray(principalIds) || principalIds.length === 0) return false;
  if (
    principalKind === 'github-actor'
      ? !principalIds.every(
          (id) => typeof id === 'number' && Number.isSafeInteger(id) && id > 0,
        )
      : !principalIds.every((id) => typeof id === 'string' && validOpaqueId(id))
  ) {
    return false;
  }
  ruleIds.add(candidate.ruleId as string);
  return true;
}

function validPolicy(policy: RegisteredIngressPolicy): boolean {
  if (policy === null || typeof policy !== 'object') return false;
  const ruleIds = new Set<string>();
  return (
    policy.schema === 'agent-lcars.registered-ingress-policy/v1' &&
    policy.version === 1 &&
    validOpaqueId(policy.tenantId) &&
    Number.isSafeInteger(policy.repositoryId) &&
    policy.repositoryId > 0 &&
    validOpaqueId(policy.policyId) &&
    Number.isSafeInteger(policy.policyVersion) &&
    policy.policyVersion > 0 &&
    SHA256.test(policy.contentSha256) &&
    Array.isArray(policy.rules) &&
    policy.rules.every((rule) => validPolicyRule(rule, ruleIds)) &&
    ingressPolicyContentSha256({
      schema: policy.schema,
      version: policy.version,
      tenantId: policy.tenantId,
      repositoryId: policy.repositoryId,
      policyId: policy.policyId,
      policyVersion: policy.policyVersion,
      rules: policy.rules,
    }) === policy.contentSha256
  );
}

export interface AuthenticatedPolicyEvidence {
  principal: PolicyPrincipal;
  roles: readonly string[];
  evidenceRef: string;
}

/**
 * Server-owned authentication/role lookup boundary. The inbox never accepts a
 * caller's role assertion directly, and exact delivery replay skips lookup.
 */
export interface PolicyEvidenceResolver {
  resolve(
    envelope: VerifiedControlPlaneSignalEnvelope,
  ): Promise<AuthenticatedPolicyEvidence>;
}

function principalForEnvelope(
  envelope: ControlPlaneSignalEnvelope,
): PolicyPrincipal {
  if (envelope.source.kind === 'github-webhook') {
    return {
      kind: 'github-actor',
      actorId: envelope.source.actorId,
      login: envelope.source.actorLogin,
    };
  }
  if (envelope.source.kind === 'operator-command') {
    return { kind: 'operator', operatorId: envelope.source.operatorId };
  }
  return { kind: 'system', systemId: envelope.source.schedulerId };
}

function samePrincipalAuthority(
  left: PolicyPrincipal,
  right: PolicyPrincipal,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'github-actor' && right.kind === 'github-actor') {
    return left.actorId === right.actorId;
  }
  if (left.kind === 'operator' && right.kind === 'operator') {
    return left.operatorId === right.operatorId;
  }
  return (
    left.kind === 'system' &&
    right.kind === 'system' &&
    left.systemId === right.systemId
  );
}

function principalMatches(
  principal: PolicyPrincipal,
  matcher: PolicyRulePrincipal,
): boolean {
  return (
    (principal.kind === 'github-actor' &&
      matcher.kind === 'github-actor' &&
      matcher.actorIds.includes(principal.actorId)) ||
    (principal.kind === 'operator' &&
      matcher.kind === 'operator' &&
      matcher.operatorIds.includes(principal.operatorId)) ||
    (principal.kind === 'system' &&
      matcher.kind === 'system' &&
      matcher.systemIds.includes(principal.systemId))
  );
}

function ruleMatches(
  rule: IngressPolicyRule,
  envelope: ControlPlaneSignalEnvelope,
  principal: PolicyPrincipal,
  roles: ReadonlySet<string>,
): boolean {
  const mode =
    envelope.signal.kind === 'requested-work'
      ? envelope.signal.mode
      : undefined;
  return (
    principalMatches(principal, rule.principal) &&
    rule.sourceKinds.includes(envelope.source.kind) &&
    rule.signalKinds.includes(envelope.signal.kind) &&
    (rule.modes === undefined ||
      (mode !== undefined && rule.modes.includes(mode))) &&
    (rule.requiredRoles ?? []).every((role) => roles.has(role))
  );
}

export function evaluateIngressPolicy(input: {
  policy: RegisteredIngressPolicy;
  envelope: ControlPlaneSignalEnvelope;
  evidence: AuthenticatedPolicyEvidence;
  decidedAt: string;
}): PolicyDecision {
  if (
    !validPolicy(input.policy) ||
    !controlPlaneSignalEnvelopeSchema.safeParse(input.envelope).success ||
    !policyPrincipalSchema.safeParse(input.evidence.principal).success ||
    !validOpaqueId(input.evidence.evidenceRef) ||
    !input.evidence.roles.every(validOpaqueId) ||
    !utcDateTimeSchema.safeParse(input.decidedAt).success ||
    input.policy.tenantId !== input.envelope.tenant.tenantId ||
    input.policy.repositoryId !== input.envelope.tenant.repositoryId ||
    !samePrincipalAuthority(
      principalForEnvelope(input.envelope),
      input.evidence.principal,
    )
  ) {
    throw new IngressPolicyConflict('Policy evaluation input is invalid');
  }
  const decisionPrincipal = principalForEnvelope(input.envelope);
  const roles = new Set(input.evidence.roles);
  const matches = input.policy.rules.filter((rule) =>
    ruleMatches(rule, input.envelope, decisionPrincipal, roles),
  );
  const highestPriority = Math.max(-1, ...matches.map((rule) => rule.priority));
  const highest = matches.filter((rule) => rule.priority === highestPriority);
  const selected = highest.length === 1 ? highest[0] : undefined;
  const ruleId =
    selected?.ruleId ??
    (highest.length > 1 ? 'ambiguous-policy' : 'deny-by-default');
  return {
    schema: 'agent-lcars.policy-decision/v1',
    version: 1,
    policy: {
      policyId: input.policy.policyId,
      policyVersion: input.policy.policyVersion,
      contentSha256: input.policy.contentSha256,
    },
    decision: selected?.decision ?? 'rejected',
    ruleId,
    sourceFactId: input.envelope.factId,
    principal: decisionPrincipal,
    evidenceRef: input.evidence.evidenceRef,
    decidedAt: input.decidedAt,
  };
}

export interface VerifiedIngressHandoff {
  envelope: ControlPlaneSignalEnvelope;
  policyDecision: PolicyDecision;
}

export interface IngressInboxRecord {
  tenantId: string;
  deliveryId: string;
  inputSha256: string;
  bodySha256: string;
  event: string;
  action: string;
  repositoryId: number;
  installationId: number;
  requestId: string;
  factId: string;
  hmacKeyVersion: string;
  receivedAt: string;
  handoff: VerifiedIngressHandoff;
}

export type IngressRecordResult =
  | { status: 'applied'; record: IngressInboxRecord }
  | { status: 'replay'; record: IngressInboxRecord };

function stableDeliverySha256(envelope: ControlPlaneSignalEnvelope): string {
  if (envelope.source.kind !== 'github-webhook') {
    throw new IngressPolicyConflict('Inbox delivery is invalid');
  }
  const { hmacKeyVersion: _keyVersion, ...signedSource } = envelope.source;
  return sha256(
    canonicalJson({
      schema: envelope.schema,
      version: envelope.version,
      requestId: envelope.requestId,
      factId: envelope.factId,
      tenant: {
        tenantId: envelope.tenant.tenantId,
        repositoryId: envelope.tenant.repositoryId,
        installationId: envelope.tenant.installationId,
      },
      task: envelope.task,
      signal: envelope.signal,
      source: signedSource,
    }),
  );
}

export interface IngressPolicyInbox {
  registerPolicy(policy: RegisteredIngressPolicy): Promise<WriteResult>;
  recordAndEvaluate(input: {
    envelope: VerifiedControlPlaneSignalEnvelope;
  }): Promise<IngressRecordResult>;
  readDelivery(input: {
    tenantId: string;
    deliveryId: string;
  }): Promise<IngressInboxRecord | undefined>;
}

/**
 * Atomic metadata-only inbox + policy decision reference implementation. An
 * exact replay returns the original decision before reading the current policy.
 */
export class InMemoryIngressPolicyInbox implements IngressPolicyInbox {
  private readonly policies = new Map<string, RegisteredIngressPolicy>();
  private readonly records = new Map<string, IngressInboxRecord>();

  constructor(
    private readonly clock: AuthorityClock,
    private readonly evidenceResolver: PolicyEvidenceResolver,
  ) {}

  private deliveryKey(tenantId: string, deliveryId: string): string {
    return canonicalJson([tenantId, deliveryId]);
  }

  async registerPolicy(policy: RegisteredIngressPolicy): Promise<WriteResult> {
    if (!validPolicy(policy)) {
      throw new IngressPolicyConflict('Registered policy is invalid');
    }
    const key = `${policy.tenantId}:${policy.repositoryId}`;
    const current = this.policies.get(key);
    if (current !== undefined && same(current, policy)) return 'replay';
    if (
      current !== undefined &&
      (current.policyId !== policy.policyId ||
        policy.policyVersion <= current.policyVersion)
    ) {
      throw new IngressPolicyConflict(
        'Policy registration is not forward-only',
      );
    }
    this.policies.set(key, clone(policy));
    return 'applied';
  }

  async recordAndEvaluate(input: {
    envelope: VerifiedControlPlaneSignalEnvelope;
  }): Promise<IngressRecordResult> {
    if (!verifiedEnvelopes.has(input.envelope)) {
      throw new IngressPolicyConflict('Inbox delivery was not normalized here');
    }
    const parsedEnvelope = controlPlaneSignalEnvelopeSchema.safeParse(
      input.envelope,
    );
    if (
      !parsedEnvelope.success ||
      parsedEnvelope.data.source.kind !== 'github-webhook'
    ) {
      throw new IngressPolicyConflict('Inbox delivery is invalid');
    }
    const envelope = parsedEnvelope.data;
    if (envelope.source.kind !== 'github-webhook') {
      throw new IngressPolicyConflict('Inbox delivery is invalid');
    }
    const source = envelope.source;
    const key = this.deliveryKey(envelope.tenant.tenantId, source.deliveryId);
    const inputSha256 = stableDeliverySha256(envelope);
    const current = this.records.get(key);
    if (current !== undefined) {
      if (current.inputSha256 !== inputSha256) {
        throw new IngressPolicyConflict('Delivery identity conflicts');
      }
      return { status: 'replay', record: clone(current) };
    }
    const evidence = await this.evidenceResolver.resolve(input.envelope);
    const concurrent = this.records.get(key);
    if (concurrent !== undefined) {
      if (concurrent.inputSha256 !== inputSha256) {
        throw new IngressPolicyConflict('Delivery identity conflicts');
      }
      return { status: 'replay', record: clone(concurrent) };
    }
    const policy = this.policies.get(
      `${envelope.tenant.tenantId}:${envelope.tenant.repositoryId}`,
    );
    if (policy === undefined) {
      throw new IngressPolicyConflict('No registered policy for delivery');
    }
    const decision = evaluateIngressPolicy({
      policy,
      envelope,
      evidence,
      decidedAt: trustedNow(this.clock),
    });
    const record: IngressInboxRecord = {
      tenantId: envelope.tenant.tenantId,
      deliveryId: source.deliveryId,
      inputSha256,
      bodySha256: source.bodySha256,
      event: source.event,
      action: source.action,
      repositoryId: source.repositoryId,
      installationId: source.installationId,
      requestId: envelope.requestId,
      factId: envelope.factId,
      hmacKeyVersion: source.hmacKeyVersion,
      receivedAt: envelope.receivedAt,
      handoff: { envelope: clone(envelope), policyDecision: decision },
    };
    this.records.set(key, record);
    return { status: 'applied', record: clone(record) };
  }

  async readDelivery(input: {
    tenantId: string;
    deliveryId: string;
  }): Promise<IngressInboxRecord | undefined> {
    const value = this.records.get(
      this.deliveryKey(input.tenantId, input.deliveryId),
    );
    return value === undefined ? undefined : clone(value);
  }
}

export interface ReducerIngressHandoff {
  status: 'ready' | 'replay';
  handoff?: VerifiedIngressHandoff;
  /** This inactive slice never owns provider effects, including in shadow. */
  effects: [];
}

export function prepareReducerIngressHandoff(
  result: IngressRecordResult,
): ReducerIngressHandoff {
  return result.status === 'applied'
    ? { status: 'ready', handoff: clone(result.record.handoff), effects: [] }
    : { status: 'replay', effects: [] };
}

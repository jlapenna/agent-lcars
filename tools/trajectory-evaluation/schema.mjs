import assert from 'node:assert/strict';

export const CORPUS_SCHEMA_VERSION = 'agent-lcars.trajectory-corpus/v1';
export const VARIANT_SCHEMA_VERSION = 'agent-lcars.trajectory-variant/v1';

const AGENTS = new Set(['claude', 'codex', 'opencode', 'unknown']);
const SETUP_OUTCOMES = new Set([
  'ready',
  'credential-failure',
  'provider-failure',
  'bootstrap-failure',
  'unknown',
]);
const TRAJECTORY_OUTCOMES = new Set([
  'not-started',
  'productive',
  'loop',
  'tool-failure',
  'provider-delay',
  'unknown',
]);
const TERMINAL_KINDS = new Set([
  'startup-failure',
  'provider-failure',
  'trajectory-failure',
  'correct-park',
  'correct-no-op',
  'outcome-gate-failure',
  'merged-deliverable',
  'superseded-duplicate',
  'unknown-success',
]);
const PROTOCOL_OBSERVATIONS = new Set([
  'observed',
  'missing',
  'not-applicable',
  'unknown',
]);

function record(value, name) {
  assert(
    value && typeof value === 'object' && !Array.isArray(value),
    `${name} must be an object`,
  );
  return value;
}

function string(value, name) {
  assert(
    typeof value === 'string' && value.length > 0,
    `${name} must be a non-empty string`,
  );
}

function nullableBoolean(value, name) {
  assert(
    value === null || typeof value === 'boolean',
    `${name} must be boolean or null`,
  );
}

function iso(value, name, nullable = false) {
  if (nullable && value === null) return;
  string(value, name);
  assert(!Number.isNaN(Date.parse(value)), `${name} must be an ISO timestamp`);
}

function finiteOrNull(value, name) {
  assert(
    value === null ||
      (typeof value === 'number' && Number.isFinite(value) && value >= 0),
    `${name} must be a non-negative number or null`,
  );
}

function validateSourceRef(value, name) {
  const source = record(value, name);
  string(source.kind, `${name}.kind`);
  string(source.url, `${name}.url`);
  assert(
    ['public', 'protected'].includes(source.access),
    `${name}.access is invalid`,
  );
  assert(
    source.sha256 === undefined ||
      source.sha256 === null ||
      typeof source.sha256 === 'string',
    `${name}.sha256 must be a string or null`,
  );
}

function validateSnapshot(value, name) {
  const snapshot = record(value, name);
  assert(
    ['captured', 'reference-only'].includes(snapshot.availability),
    `${name}.availability is invalid`,
  );
  iso(snapshot.capturedAt, `${name}.capturedAt`, true);
  validateSourceRef(snapshot.sourceRef, `${name}.sourceRef`);
  if (snapshot.availability === 'reference-only') {
    assert(
      snapshot.title === null || snapshot.title === undefined,
      `${name} reference-only snapshot cannot embed a title`,
    );
    assert(
      snapshot.bodySha256 === null || snapshot.bodySha256 === undefined,
      `${name} reference-only snapshot cannot embed a body hash`,
    );
  }
}

function validateEntry(value, index) {
  const name = `entries[${index}]`;
  const entry = record(value, name);
  assert(/^run-[0-9]+$/u.test(entry.id), `${name}.id must be run-<id>`);
  assert(
    /^[^/]+\/[^/]+$/u.test(entry.repository),
    `${name}.repository must be owner/repo`,
  );
  assert(
    ['public', 'private'].includes(entry.repositoryVisibility),
    `${name}.repositoryVisibility is invalid`,
  );

  const anchor = record(entry.anchor, `${name}.anchor`);
  assert(
    Number.isInteger(anchor.number) && anchor.number > 0,
    `${name}.anchor.number is invalid`,
  );
  assert(
    ['issue', 'pull-request'].includes(anchor.type),
    `${name}.anchor.type is invalid`,
  );
  validateSnapshot(anchor.snapshot, `${name}.anchor.snapshot`);
  if (entry.repositoryVisibility === 'private') {
    assert(
      anchor.snapshot.availability === 'reference-only',
      `${name} private repository content must stay reference-only`,
    );
  }
  string(entry.taskClass, `${name}.taskClass`);

  const dispatch = record(entry.dispatch, `${name}.dispatch`);
  assert(AGENTS.has(dispatch.agent), `${name}.dispatch.agent is invalid`);
  assert(
    Number.isInteger(dispatch.runId) && dispatch.runId > 0,
    `${name}.dispatch.runId is invalid`,
  );
  assert(
    entry.id === `run-${dispatch.runId}`,
    `${name}.id must match dispatch.runId`,
  );
  string(dispatch.runUrl, `${name}.dispatch.runUrl`);
  string(dispatch.workflowSha, `${name}.dispatch.workflowSha`);
  string(dispatch.workflowPath, `${name}.dispatch.workflowPath`);
  string(dispatch.provider, `${name}.dispatch.provider`);
  assert(
    dispatch.model === null || typeof dispatch.model === 'string',
    `${name}.dispatch.model is invalid`,
  );
  assert(
    dispatch.budgetMinutes === null ||
      (Number.isInteger(dispatch.budgetMinutes) && dispatch.budgetMinutes > 0),
    `${name}.dispatch.budgetMinutes is invalid`,
  );
  validateSnapshot(dispatch.brief, `${name}.dispatch.brief`);

  const setup = record(entry.setup, `${name}.setup`);
  assert(SETUP_OUTCOMES.has(setup.outcome), `${name}.setup.outcome is invalid`);
  nullableBoolean(
    setup.agentProcessStarted,
    `${name}.setup.agentProcessStarted`,
  );
  nullableBoolean(setup.modelTurnObserved, `${name}.setup.modelTurnObserved`);

  const protocol = record(entry.protocol, `${name}.protocol`);
  for (const field of [
    'takeover',
    'progress',
    'durableResult',
    'terminalBehavior',
  ]) {
    assert(
      PROTOCOL_OBSERVATIONS.has(protocol[field]),
      `${name}.protocol.${field} is invalid`,
    );
  }
  nullableBoolean(protocol.adherent, `${name}.protocol.adherent`);

  const milestones = record(entry.milestones, `${name}.milestones`);
  iso(milestones.queuedAt, `${name}.milestones.queuedAt`);
  iso(milestones.agentStartedAt, `${name}.milestones.agentStartedAt`, true);
  iso(milestones.takeoverAt, `${name}.milestones.takeoverAt`, true);
  iso(milestones.diagnosisAt, `${name}.milestones.diagnosisAt`, true);
  iso(
    milestones.firstDurableArtifactAt,
    `${name}.milestones.firstDurableArtifactAt`,
    true,
  );
  iso(milestones.terminalAt, `${name}.milestones.terminalAt`);

  const trajectory = record(entry.trajectory, `${name}.trajectory`);
  assert(
    TRAJECTORY_OUTCOMES.has(trajectory.outcome),
    `${name}.trajectory.outcome is invalid`,
  );
  assert(
    Array.isArray(trajectory.archiveRefs),
    `${name}.trajectory.archiveRefs must be an array`,
  );
  trajectory.archiveRefs.forEach((source, sourceIndex) =>
    validateSourceRef(source, `${name}.trajectory.archiveRefs[${sourceIndex}]`),
  );

  const terminal = record(entry.terminal, `${name}.terminal`);
  assert(TERMINAL_KINDS.has(terminal.kind), `${name}.terminal.kind is invalid`);
  assert(
    Array.isArray(terminal.artifactRefs),
    `${name}.terminal.artifactRefs must be an array`,
  );
  terminal.artifactRefs.forEach((source, sourceIndex) =>
    validateSourceRef(source, `${name}.terminal.artifactRefs[${sourceIndex}]`),
  );

  const quality = record(entry.quality, `${name}.quality`);
  nullableBoolean(quality.accepted, `${name}.quality.accepted`);
  nullableBoolean(quality.merged, `${name}.quality.merged`);

  const efficiency = record(entry.efficiency, `${name}.efficiency`);
  finiteOrNull(efficiency.queueSeconds, `${name}.efficiency.queueSeconds`);
  finiteOrNull(efficiency.modelSeconds, `${name}.efficiency.modelSeconds`);
  finiteOrNull(
    efficiency.firstArtifactSeconds,
    `${name}.efficiency.firstArtifactSeconds`,
  );
  finiteOrNull(efficiency.runnerMinutes, `${name}.efficiency.runnerMinutes`);
  assert(
    Number.isInteger(efficiency.retries) && efficiency.retries >= 0,
    `${name}.efficiency.retries is invalid`,
  );

  const annotations = record(entry.annotations, `${name}.annotations`);
  const automatic = record(
    annotations.automatic,
    `${name}.annotations.automatic`,
  );
  assert(
    ['high', 'medium', 'low', 'unknown'].includes(automatic.confidence),
    `${name}.annotations.automatic.confidence is invalid`,
  );
  assert(
    Array.isArray(automatic.sourceRefs),
    `${name}.annotations.automatic.sourceRefs must be an array`,
  );
  if (annotations.human !== null) {
    const human = record(annotations.human, `${name}.annotations.human`);
    string(human.reviewer, `${name}.annotations.human.reviewer`);
    iso(human.reviewedAt, `${name}.annotations.human.reviewedAt`);
    assert(
      ['high', 'medium', 'low'].includes(human.confidence),
      `${name}.annotations.human.confidence is invalid`,
    );
    assert(
      typeof human.useful === 'boolean',
      `${name}.annotations.human.useful must be boolean`,
    );
    assert(
      ['correct', 'incorrect', 'inconclusive'].includes(human.correctness),
      `${name}.annotations.human.correctness is invalid`,
    );
    assert(
      typeof human.notes === 'string',
      `${name}.annotations.human.notes must be a string`,
    );
  }

  assert(
    Array.isArray(entry.sourceRefs) && entry.sourceRefs.length > 0,
    `${name}.sourceRefs must not be empty`,
  );
  entry.sourceRefs.forEach((source, sourceIndex) =>
    validateSourceRef(source, `${name}.sourceRefs[${sourceIndex}]`),
  );
}

export function validateCorpus(value) {
  const corpus = record(value, 'corpus');
  assert.equal(
    corpus.schemaVersion,
    CORPUS_SCHEMA_VERSION,
    'unsupported corpus schemaVersion',
  );
  string(corpus.corpusId, 'corpus.corpusId');
  iso(corpus.frozenAt, 'corpus.frozenAt');
  const sourceWindow = record(corpus.sourceWindow, 'corpus.sourceWindow');
  iso(sourceWindow.from, 'corpus.sourceWindow.from');
  iso(sourceWindow.to, 'corpus.sourceWindow.to');
  string(sourceWindow.selection, 'corpus.sourceWindow.selection');
  assert(
    Array.isArray(sourceWindow.sourceRefs),
    'corpus.sourceWindow.sourceRefs must be an array',
  );
  const privacy = record(corpus.privacy, 'corpus.privacy');
  assert.equal(privacy.redactionPolicy, 'agent-lcars.trajectory-redaction/v1');
  assert.equal(privacy.transcriptPolicy, 'protected-reference-only');
  assert(Array.isArray(corpus.entries), 'corpus.entries must be an array');
  corpus.entries.forEach(validateEntry);
  assert.equal(
    new Set(corpus.entries.map((entry) => entry.id)).size,
    corpus.entries.length,
    'entry ids must be unique',
  );
  return corpus;
}

export function validateVariant(value) {
  const variant = record(value, 'variant');
  assert.equal(
    variant.schemaVersion,
    VARIANT_SCHEMA_VERSION,
    'unsupported variant schemaVersion',
  );
  string(variant.variantId, 'variant.variantId');
  assert(
    ['prompt', 'setup', 'prompt-and-setup'].includes(variant.kind),
    'variant.kind is invalid',
  );
  string(variant.description, 'variant.description');
  const rules = record(variant.rules, 'variant.rules');
  assert(
    Array.isArray(rules.blockSetupOutcomes),
    'variant.rules.blockSetupOutcomes must be an array',
  );
  for (const outcome of rules.blockSetupOutcomes) {
    assert(
      ['credential-failure', 'provider-failure', 'bootstrap-failure'].includes(
        outcome,
      ),
      `variant block outcome ${outcome} is invalid`,
    );
  }
  assert(
    typeof rules.structuredNoOp === 'boolean',
    'variant.rules.structuredNoOp must be boolean',
  );
  assert(
    rules.maxNoArtifactMinutes === null ||
      (Number.isInteger(rules.maxNoArtifactMinutes) &&
        rules.maxNoArtifactMinutes > 0),
    'variant.rules.maxNoArtifactMinutes is invalid',
  );
  const expectations = record(
    variant.reviewedExpectations,
    'variant.reviewedExpectations',
  );
  for (const [entryId, expectationValue] of Object.entries(expectations)) {
    assert(
      /^run-[0-9]+$/u.test(entryId),
      `invalid expectation entry id ${entryId}`,
    );
    const expectation = record(
      expectationValue,
      `variant.reviewedExpectations.${entryId}`,
    );
    assert(
      TERMINAL_KINDS.has(expectation.kind),
      `invalid expectation terminal kind for ${entryId}`,
    );
    assert(
      typeof expectation.useful === 'boolean',
      `${entryId}.useful must be boolean`,
    );
    assert(
      typeof expectation.accepted === 'boolean',
      `${entryId}.accepted must be boolean`,
    );
    assert(
      ['high', 'medium', 'low'].includes(expectation.confidence),
      `${entryId}.confidence is invalid`,
    );
    string(expectation.reviewer, `${entryId}.reviewer`);
    iso(expectation.reviewedAt, `${entryId}.reviewedAt`);
    assert(
      expectation.protocolAdherent === undefined ||
        typeof expectation.protocolAdherent === 'boolean',
      `${entryId}.protocolAdherent must be boolean when present`,
    );
    assert(
      expectation.trajectoryOutcome === undefined ||
        TRAJECTORY_OUTCOMES.has(expectation.trajectoryOutcome),
      `${entryId}.trajectoryOutcome is invalid`,
    );
    if (expectation.firstArtifactSeconds !== undefined) {
      finiteOrNull(
        expectation.firstArtifactSeconds,
        `${entryId}.firstArtifactSeconds`,
      );
    }
    string(expectation.rationale, `${entryId}.rationale`);
  }
  return variant;
}

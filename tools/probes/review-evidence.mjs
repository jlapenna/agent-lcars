// Accept observable native delegation and source-bound artifacts, not a model's
// unsupported assertion that it performed four independent reviews.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function evaluateReview({
  manifest,
  execution,
  receipt,
  payload,
  native,
}) {
  const failures = [];
  const require = (condition, reason) => {
    if (!condition) failures.push(reason);
  };
  require(execution?.exitCode === 0 &&
    execution?.timedOut === false &&
    execution?.interrupted !== true, 'native-execution-failed');
  require(execution?.sourceUnchanged !== false, 'review-source-changed');
  require(receipt?.complete === true, 'procedure-incomplete');
  require(receipt?.head === manifest.reviewedHead, 'receipt-head-mismatch');
  const reviewers = receipt?.reviewers ?? [];
  const roles = ['guidance-a', 'guidance-b', 'bugs-a', 'bugs-b'];
  require(reviewers.length === 4 &&
    roles.every(
      (role) =>
        reviewers.filter(
          (reviewer) => reviewer.role === role && reviewer.complete === true,
        ).length === 1,
    ), 'four-complete-review-passes-required');
  const canonical = (id) => native?.canonicalIds?.[id] ?? id;
  const ids = reviewers.map((reviewer) => canonical(reviewer.nativeSessionId));
  require(ids.every((id) => typeof id === 'string' && id.length) &&
    new Set(ids).size === 4, 'reviewer-identities-not-distinct');
  const observed = new Set(native?.completedChildren ?? []);
  require(ids.every((id) =>
    observed.has(id),
  ), 'reviewer-completion-not-observed-natively');
  require(native?.errors?.length === 0, 'native-evidence-incomplete');
  const candidates = receipt?.candidates ?? [];
  const validators = receipt?.validators ?? [];
  require(Array.isArray(receipt?.candidates) &&
    Array.isArray(
      receipt?.validators,
    ), 'candidate-and-validator-inventory-required');
  const validatorIds = validators.map((validator) =>
    canonical(validator.nativeSessionId),
  );
  if (native?.provider === 'codex') {
    const independent = new Set(native.isolatedChildren ?? []);
    require([...ids, ...validatorIds].every((id) =>
      independent.has(id),
    ), 'codex-child-context-is-not-observably-fresh');
  }
  require(new Set(candidates.map((candidate) => candidate.id)).size ===
    candidates.length &&
    validators.every((validator) =>
      candidates.some((candidate) => candidate.id === validator.candidateId),
    ), 'candidate-validation-inventory-mismatch');
  require(new Set(validatorIds).size === validatorIds.length &&
    validatorIds.every(
      (id) => !ids.includes(id) && observed.has(id),
    ), 'validator-is-not-a-fresh-completed-native-child');
  require(candidates.every(
    (candidate) =>
      typeof candidate.id === 'string' &&
      validators.filter(
        (validator) =>
          validator.candidateId === candidate.id &&
          /^(confirmed|rejected)$/i.test(validator.decision ?? '') &&
          (typeof validator.evidence === 'string'
            ? validator.evidence.trim().length > 0
            : Array.isArray(validator.evidence) &&
              validator.evidence.length > 0),
      ).length === 1,
  ), 'every-candidate-needs-one-independent-validation');
  require(payload?.commit_id ===
    manifest.reviewedHead, 'publication-head-mismatch');
  require(payload?.event === 'COMMENT', 'qualification-must-capture-comment');
  require(typeof payload?.body === 'string' &&
    payload.body.includes(manifest.marker), 'publication-marker-missing');
  require(payload?.body?.includes(
    manifest.upstreamRevision,
  ), 'upstream-revision-receipt-missing');
  require(Array.isArray(
    payload?.comments,
  ), 'inline-comment-inventory-required');
  return {
    passed: failures.length === 0,
    failures,
    reviewPasses: reviewers.length,
    candidates: candidates.length,
    validators: validators.length,
    validatedFindings: validators.filter((v) =>
      /^confirmed$/i.test(v.decision ?? ''),
    ).length,
    publication: manifest.publication,
    environment: manifest.environment,
  };
}

export function readReviewEvidence(directory) {
  const read = (name) =>
    JSON.parse(readFileSync(join(directory, name), 'utf8'));
  return evaluateReview({
    manifest: read('manifest.json'),
    execution: read('execution.json'),
    receipt: read('receipt.json'),
    payload: read('review.json'),
    native: read('native-evidence.json'),
  });
}

// Native task-export schema observed from the pinned OpenCode CLI. Exporting
// the store is read-only and preserves evidence across long JSON-stream gaps.
export function completedOpenCodeChild(root, task, child) {
  const metadata = task?.state?.metadata;
  const assistant = child?.messages
    ?.filter((message) => message.info?.role === 'assistant')
    .at(-1);
  return (
    task?.tool === 'task' &&
    task.state.status === 'completed' &&
    metadata?.parentSessionId === root?.info?.id &&
    metadata?.sessionId === child?.info?.id &&
    child?.info?.parentID === root?.info?.id &&
    child?.info?.id !== root?.info?.id &&
    metadata?.truncated === false &&
    metadata?.background !== true &&
    assistant?.info?.finish === 'stop' &&
    !assistant.info.error &&
    assistant.parts?.some(
      (part) =>
        part.type === 'text' &&
        typeof part.text === 'string' &&
        part.text.trim().length > 0,
    )
  );
}

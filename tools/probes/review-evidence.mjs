// Accept observable native delegation and source-bound artifacts, not a model's
// unsupported assertion that it performed independent review passes.
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
  const roles = ['guardrails', 'bugs'];
  require(reviewers.length === 2 &&
    roles.every(
      (role) =>
        reviewers.filter(
          (reviewer) => reviewer.role === role && reviewer.complete === true,
        ).length === 1,
    ), 'two-complete-review-passes-required');
  const canonical = (id) => native?.canonicalIds?.[id] ?? id;
  const ids = reviewers.map((reviewer) => canonical(reviewer.nativeSessionId));
  require(ids.every((id) => typeof id === 'string' && id.length) &&
    new Set(ids).size === 2, 'reviewer-identities-not-distinct');
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
  const isPassingVerdict =
    payload?.event === 'APPROVE' ||
    (typeof payload?.body === 'string' &&
      payload.body
        .split('\n')
        .some(
          (line) => line.replace(/\r$/, '') === '<!-- lcars-review:pass -->',
        ));
  require(!isPassingVerdict ||
    (Array.isArray(payload?.comments) &&
      payload.comments.length ===
        0), 'passing-review-must-not-open-inline-threads');
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

// OpenCode 2 subagents always run in the background: the `subagent` call
// completes as soon as the child starts (`metadata.status: "running"`), so the
// call itself is not completion proof. Completion is the child's own export --
// its native parent, a succeeded outcome, and a final assistant step that
// stopped with non-empty text -- plus the parent's synthetic `<subagent>`
// report for that child. Field names captured from OpenCode v2.3.2 exports.
export function completedOpenCode2Child(root, call, child, maxSteps) {
  const metadata = call?.state?.metadata;
  const childId = child?.info?.id;
  const messages = child?.messages ?? [];
  const assistantSteps = messages.filter(
    (message) =>
      message?.type === 'assistant' && message.finish && !message.error,
  );
  const assistant = messages.findLast(
    (message) => message?.type === 'assistant',
  );
  const text = (assistant?.content ?? [])
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join(' ')
    .trim();
  const report = '<subagent sessionID="' + childId + '" state="completed"';
  return (
    call?.type === 'tool' &&
    call.name === 'subagent' &&
    call.state?.status === 'completed' &&
    typeof childId === 'string' &&
    metadata?.sessionID === childId &&
    metadata?.truncated === false &&
    call.state.input?.sessionID === undefined &&
    messages.filter((message) => message?.type === 'user').length === 1 &&
    child?.info?.parentID === root?.info?.id &&
    childId !== root?.info?.id &&
    child?.info?.outcome === 'succeeded' &&
    assistant?.finish === 'stop' &&
    !assistant.error &&
    // The final configured step disables tools and requests a progress
    // summary. Its native outcome can still be succeeded with finish: stop.
    Number.isInteger(maxSteps) &&
    assistantSteps.length < maxSteps &&
    text.length > 0 &&
    !/\b(?:maximum (?:number of )?steps?|step limit)\b.{0,80}\b(?:reached|exhausted)\b/i.test(
      text,
    ) &&
    root?.messages?.some(
      (message) =>
        message?.type === 'synthetic' &&
        typeof message.text === 'string' &&
        message.text.startsWith(report + ' '),
    ) === true
  );
}

// Antigravity 1.5.9 emits completed invocation IDs in structured subagent_info.
// Listing is optional: spawning is not completion, so callers must still
// verify each child's terminal native transcript.
export function antigravityChildIds(trace) {
  const ids = new Set();
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
  for (const event of trace) {
    const step = event.step_update;
    if (step?.state !== 'DONE') continue;
    if (step.tool_name === 'invoke_subagent') {
      for (const child of step.subagent_info?.subagents ?? []) {
        if (
          typeof child.conversation_id === 'string' &&
          uuid.test(child.conversation_id)
        )
          ids.add(child.conversation_id);
      }
    }
    if (
      step.tool_name === 'manage_subagents' &&
      typeof step.tool_info?.output === 'string'
    ) {
      for (const match of step.tool_info.output.matchAll(
        /"conversationId"\s*:\s*"([a-f0-9-]{36})"/g,
      ))
        if (uuid.test(match[1])) ids.add(match[1]);
    }
  }
  return [...ids];
}

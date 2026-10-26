import {
  codeModeInvocation,
  codeModePublication,
  codeModePublishedPR,
  codeModeResult,
} from './codex-publication';
import {
  findDeliverables,
  findQualifiedPRs,
  isPRPublicationCommand,
} from './deliverables';
import type { TranscriptAdapter } from './transcript-adapter-types';
import { type QualifiedSessionPR, SessionSummary, TokenUsage } from './types';
import {
  asArray,
  asNumber,
  asRecord,
  asString,
  isSafeIdentifier,
  truncateTitle,
} from './unknown-value';

/** Codex records exec stdout inside a JSON result envelope. Code-mode
 * orchestration can add prose plus one envelope per line. Decode only known
 * stdout envelopes; unrelated metadata does not become publication evidence. */
function publicationOutput(value: unknown): unknown {
  const blocks = asArray(value);
  if (blocks)
    return blocks.map((raw) => {
      const block = asRecord(raw);
      return block &&
        (block['type'] === 'input_text' || block['type'] === 'text')
        ? publicationOutput(block['text'])
        : [];
    });
  const envelope = asRecord(value);
  if (envelope && 'output' in envelope)
    return envelope['exit_code'] === undefined || envelope['exit_code'] === 0
      ? envelope['output']
      : [];
  if (typeof value !== 'string') return [];
  const outputs: unknown[] = [];
  let recognized = false;
  for (const candidate of [value, ...value.split('\n')]) {
    let parsed: Record<string, unknown> | undefined;
    try {
      parsed = asRecord(JSON.parse(candidate));
    } catch {
      continue;
    }
    if (parsed && 'output' in parsed) {
      recognized = true;
      // A recognized failed result is not publication evidence.
      if (parsed['exit_code'] === undefined || parsed['exit_code'] === 0)
        outputs.push(parsed['output']);
      if (candidate === value) return outputs;
    }
  }
  return recognized ? outputs : value;
}

/** Decode the supported shell tool argument, not unrelated JSON properties
 * or code-mode orchestration source that merely mentions a command. */
function publicationCommand(input: unknown): string | undefined {
  if (typeof input === 'string') {
    try {
      return publicationCommand(JSON.parse(input));
    } catch {
      return input;
    }
  }
  const record = asRecord(input);
  return asString(record?.['cmd']) ?? asString(record?.['command']);
}

function emptyTokens(): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  };
}

function looksLikeCodexLine(line: string): boolean {
  try {
    const raw = asRecord(JSON.parse(line));
    const payload = raw && asRecord(raw['payload']);
    return (
      asString(raw?.['type']) === 'session_meta' &&
      typeof payload?.['id'] === 'string' &&
      typeof payload?.['originator'] === 'string'
    );
  } catch {
    return false;
  }
}

function userMessageText(payload: Record<string, unknown>): string | undefined {
  const legacyMessage = asString(payload['message']);
  if (legacyMessage) return legacyMessage;

  const content = asArray(payload['content']);
  if (!content) return undefined;
  for (const item of content) {
    const block = asRecord(item);
    if (
      block &&
      (asString(block['type']) === 'input_text' ||
        asString(block['type']) === 'text')
    ) {
      const text = asString(block['text']);
      if (text) return text;
    }
  }
  return undefined;
}

/** Codex prepends repository instructions and its environment context
 * (date, timezone, workspace roots) as user-role inputs. They are context,
 * not the user's task, so using them as a session title produces a
 * misleading label and hides the first real request. */
function isInjectedContext(message: string): boolean {
  return (
    (message.startsWith('# AGENTS.md instructions') &&
      message.includes('<INSTRUCTIONS>')) ||
    message.startsWith('<environment_context>')
  );
}

/** Reduces Codex CLI rollout JSONL without retaining message bodies. */
export const codexAdapter: TranscriptAdapter = {
  agent: 'codex',
  detect(firstLines: string[]): boolean {
    return firstLines.some(looksLikeCodexLine);
  },
  reduce(lines: Iterable<string>): SessionSummary[] {
    let sessionId: string | undefined;
    let cwd: string | undefined;
    let model: string | undefined;
    let permissionMode: string | undefined;
    let startedAt: string | undefined;
    let lastActivityAt: string | undefined;
    let title: string | undefined;
    let turns = 0;
    let tokens = emptyTokens();
    let lastToolCall: SessionSummary['lastToolCall'];
    const toolCallCounts: Record<string, number> = {};
    const prNumbers = new Set<number>();
    const qualifiedPRs = new Map<string, QualifiedSessionPR>();
    const creatingCalls = new Set<string>();
    const seenCalls = new Set<string>();
    type Publication = { identityReads?: number; sessionId?: number };
    const codeCalls = new Map<string, Publication>();
    const pendingExecs = new Map<number, Publication>();
    const seenExecs = new Set<number>();
    const invalidExecs = new Set<number>();
    const invalidateExec = (session: number) => {
      pendingExecs.delete(session);
      invalidExecs.add(session);
      seenExecs.add(session);
    };
    const invalidatePendingExecs = () => {
      for (const session of pendingExecs.keys()) invalidateExec(session);
      for (const owned of codeCalls.values())
        if (owned.sessionId !== undefined) invalidateExec(owned.sessionId);
    };
    const commitShas = new Set<string>();

    for (const line of lines) {
      if (!line.trim()) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const raw = asRecord(parsed);
      const payload = raw && asRecord(raw['payload']);
      if (!raw || !payload) continue;

      const timestamp = asString(raw['timestamp']);
      if (timestamp) {
        if (!startedAt || timestamp < startedAt) startedAt = timestamp;
        if (!lastActivityAt || timestamp > lastActivityAt) {
          lastActivityAt = timestamp;
        }
      }

      const lineType = asString(raw['type']);
      const payloadType = asString(payload['type']);
      if (lineType === 'session_meta') {
        sessionId =
          asString(payload['id']) ??
          asString(payload['session_id']) ??
          sessionId;
        cwd = asString(payload['cwd']) ?? cwd;
      } else if (lineType === 'turn_context') {
        cwd = asString(payload['cwd']) ?? cwd;
        model = asString(payload['model']) ?? model;
        permissionMode = asString(payload['approval_policy']) ?? permissionMode;
      } else if (lineType === 'event_msg') {
        if (payloadType === 'task_started') turns += 1;
        if (payloadType === 'user_message' && !title) {
          const message = userMessageText(payload);
          if (message && !isInjectedContext(message)) {
            title = truncateTitle(message);
          }
        }
        if (payloadType === 'token_count') {
          const info = asRecord(payload['info']);
          const total = info && asRecord(info['total_token_usage']);
          if (total) {
            // Codex/OpenAI reports cached input as a subset of input_tokens,
            // unlike Claude's mutually exclusive usage fields. Normalize to
            // the shared TokenUsage contract so input + output means fresh
            // tokens for either agent and cache reads are not counted twice.
            const inclusiveInput = asNumber(total['input_tokens']) ?? 0;
            const cachedInput = asNumber(total['cached_input_tokens']) ?? 0;
            tokens = {
              inputTokens: Math.max(0, inclusiveInput - cachedInput),
              outputTokens: asNumber(total['output_tokens']) ?? 0,
              cacheCreationTokens: 0,
              cacheReadTokens: cachedInput,
            };
          }
        }
      } else if (
        lineType === 'response_item' &&
        payloadType === 'custom_tool_call'
      ) {
        const name = asString(payload['name']);
        if (name) {
          toolCallCounts[name] = (toolCallCounts[name] ?? 0) + 1;
          if (timestamp) lastToolCall = { name, timestamp };
        }
      } else if (
        lineType === 'response_item' &&
        payloadType === 'message' &&
        asString(payload['role']) === 'user' &&
        !title
      ) {
        const message = userMessageText(payload);
        if (message && !isInjectedContext(message)) {
          title = truncateTitle(message);
        }
      }

      const deliverables = findDeliverables(raw);
      for (const number of deliverables.prNumbers) prNumbers.add(number);
      for (const sha of deliverables.commitShas) commitShas.add(sha);

      // Keep historical display hints, but financial attribution requires a
      // qualified URL from the correlated result of a creating command.
      if (lineType === 'response_item') {
        const callId = asString(payload['call_id']);
        if (
          callId &&
          (payloadType === 'function_call' ||
            payloadType === 'custom_tool_call')
        ) {
          const input = payload['arguments'] ?? payload['input'];
          const toolName = asString(payload['name']);
          // Call identities are single use, including non-creating calls.
          if (seenCalls.has(callId)) {
            creatingCalls.delete(callId);
            codeCalls.delete(callId);
            invalidatePendingExecs();
            continue;
          }
          seenCalls.add(callId);
          const invocation =
            toolName === 'exec' || toolName === 'functions.exec'
              ? codeModeInvocation(input)
              : undefined;
          if (invocation?.tool === 'exec_command') {
            codeCalls.set(callId, {
              identityReads: codeModePublication(invocation.args['cmd']),
            });
          } else if (invocation?.tool === 'write_stdin') {
            const session = invocation.args['session_id'];
            if (
              typeof session === 'number' &&
              (invocation.args['chars'] === undefined ||
                invocation.args['chars'] === '')
            ) {
              const owned = pendingExecs.get(session);
              // Reserve the session until this poll returns. Overlapping polls
              // or an already consumed session have no unambiguous ownership.
              pendingExecs.delete(session);
              if (owned && !invalidExecs.has(session))
                codeCalls.set(callId, owned);
              else if (seenExecs.has(session)) invalidateExec(session);
            } else if (typeof session === 'number') {
              // Intervening stdin can change process behavior. No later empty
              // poll may resurrect this publication's previous ownership.
              invalidateExec(session);
            }
          } else {
            if (toolName === 'exec' || toolName === 'functions.exec') {
              // An unrecognized program could print or poll any pending exec.
              // Without structured nested evidence, independence is unknown.
              invalidatePendingExecs();
            }
            if (
              toolName === 'write_stdin' ||
              toolName === 'functions.write_stdin'
            ) {
              // Direct stdin calls are outside this code-mode grammar but can
              // still mutate its owned process, so invalidate conservatively.
              try {
                const args = asRecord(
                  typeof input === 'string' ? JSON.parse(input) : input,
                );
                const session = args?.['session_id'];
                if (typeof session === 'number') invalidateExec(session);
              } catch {
                invalidatePendingExecs();
              }
            }
            const command = publicationCommand(input);
            if (
              toolName &&
              [
                'exec_command',
                'functions.exec_command',
                'shell',
                'Bash',
                'bash',
                // Preserve direct JSON shell arguments on historical exec calls.
                'exec',
                'functions.exec',
              ].includes(toolName) &&
              command &&
              isPRPublicationCommand(command)
            )
              creatingCalls.add(callId);
          }
        } else if (
          callId &&
          codeCalls.has(callId) &&
          (payloadType === 'function_call_output' ||
            payloadType === 'custom_tool_call_output')
        ) {
          const owned = codeCalls.get(callId);
          if (!owned) continue;
          codeCalls.delete(callId);
          const result = codeModeResult(payload['output']);
          if (
            !result ||
            (owned.sessionId !== undefined &&
              (invalidExecs.has(owned.sessionId) ||
                (result.sessionId !== undefined &&
                  result.sessionId !== owned.sessionId)))
          )
            continue;
          if (
            owned.sessionId === undefined &&
            result.sessionId !== undefined &&
            (seenExecs.has(result.sessionId) || result.exitCode !== undefined)
          ) {
            // Fresh exec results cannot reuse a session or simultaneously claim
            // a running session and terminal success.
            invalidateExec(result.sessionId);
            continue;
          }
          if (result.exitCode !== undefined) {
            if (owned.sessionId !== undefined)
              pendingExecs.delete(owned.sessionId);
            if (result.exitCode === 0 && owned.identityReads !== undefined) {
              const pr = codeModePublishedPR(
                result.output,
                owned.identityReads,
              );
              if (pr)
                qualifiedPRs.set(
                  `${pr.repo.owner.toLowerCase()}/${pr.repo.name.toLowerCase()}#${pr.number}`,
                  pr,
                );
            }
          } else if (result.sessionId !== undefined) {
            const session = result.sessionId;
            if (!invalidExecs.has(session)) {
              seenExecs.add(session);
              pendingExecs.set(session, { ...owned, sessionId: session });
            }
          }
        } else if (
          callId &&
          creatingCalls.has(callId) &&
          (payloadType === 'function_call_output' ||
            payloadType === 'custom_tool_call_output')
        ) {
          creatingCalls.delete(callId);
          for (const pr of findQualifiedPRs(
            publicationOutput(payload['output']),
          ))
            qualifiedPRs.set(
              `${pr.repo.owner}/${pr.repo.name}#${pr.number}`,
              pr,
            );
        }
      }
    }

    if (!sessionId || !isSafeIdentifier(sessionId)) return [];
    return [
      {
        sessionId,
        source: 'cli',
        agent: 'codex',
        ...(cwd && { cwd }),
        ...(model && { model }),
        ...(permissionMode && { permissionMode }),
        startedAt: startedAt ?? '',
        lastActivityAt: lastActivityAt ?? '',
        turns,
        toolCallCounts,
        tokens,
        ...(lastToolCall && { lastToolCall }),
        ...(title && { title, titleSource: 'inferred' as const }),
        deliverables: {
          prNumbers: Array.from(prNumbers),
          ...(qualifiedPRs.size > 0 && {
            qualifiedPRs: [...qualifiedPRs.values()],
          }),
          commitShas: Array.from(commitShas),
        },
      },
    ];
  },
};

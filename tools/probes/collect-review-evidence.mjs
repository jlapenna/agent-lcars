#!/usr/bin/env node
// Collect private native receipts. Never turn a missing transcript into a pass.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  chmodSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readReviewEvidence } from './review-evidence.mjs';

const directory = resolve(process.argv[2] ?? '');
if (!process.argv[2])
  throw new Error('Usage: collect-review-evidence.mjs <evidence directory>');
const manifest = JSON.parse(
  readFileSync(join(directory, 'manifest.json'), 'utf8'),
);
const errors = [];
const lines = (path) =>
  readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        errors.push('Malformed native JSONL: ' + path);
        return [];
      }
    });
const trace = lines(join(directory, 'trace.jsonl'));
const completed = new Set();
const isolated = new Set();
const canonicalIds = {};
const models = new Set();
const artifacts = [];
const archive = (path, name) => {
  if (!existsSync(path)) {
    errors.push('Missing native transcript: ' + path);
    return null;
  }
  const destination = join(directory, 'native', name);
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  copyFileSync(path, destination);
  chmodSync(destination, 0o600);
  artifacts.push('native/' + name);
  return lines(destination);
};
if (manifest.provider === 'claude') {
  const session = trace.find((event) => event.subtype === 'init')?.session_id;
  const ids = new Set();
  for (const event of trace) {
    for (const block of event.message?.content ?? []) {
      if (typeof block !== 'object' || block.type !== 'tool_result') continue;
      for (const match of JSON.stringify(block).matchAll(
        /agentId:\s*([a-f0-9]{8,})/g,
      ))
        ids.add(match[1]);
    }
  }
  const cwd = trace.find((event) => event.subtype === 'init')?.cwd;
  if (!session || !cwd) errors.push('Claude native session binding missing');
  for (const id of ids) {
    const project = cwd.replace(/[^a-zA-Z0-9]/g, '-');
    const path = join(
      process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'),
      'projects',
      project,
      session,
      'subagents',
      'agent-' + id + '.jsonl',
    );
    const child = archive(path, 'claude-' + id + '.jsonl');
    const assistant = child
      ?.filter((event) => event.type === 'assistant')
      .at(-1);
    const canonical = session + '/subagents/agent-' + id;
    canonicalIds[id] = canonical;
    canonicalIds[canonical] = canonical;
    canonicalIds[path] = canonical;
    if (assistant?.message?.stop_reason === 'end_turn')
      completed.add(canonical);
    for (const event of child ?? [])
      if (event.message?.model) models.add(event.message.model);
  }
}
if (manifest.provider === 'codex') {
  const thread = trace.find(
    (event) => event.type === 'thread.started',
  )?.thread_id;
  const home = process.env.CODEX_HOME ?? join(homedir(), '.codex');
  const find = (path, id) => {
    if (!existsSync(path)) return [];
    return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
      const file = join(path, entry.name);
      return entry.isDirectory()
        ? find(file, id)
        : entry.name.endsWith(id + '.jsonl')
          ? [file]
          : [];
    });
  };
  const files = thread ? find(join(home, 'sessions'), thread) : [];
  if (files.length !== 1)
    errors.push('Cannot establish unique Codex native transcript');
  const native =
    files.length === 1 ? archive(files[0], 'codex-root.jsonl') : [];
  const spawned = new Set();
  const calls = new Map();
  const spawnArguments = new Map();
  for (const event of native ?? []) {
    const payload = event.payload ?? {};
    if (event.type === 'turn_context' && payload.model)
      models.add(payload.model);
    if (payload.type === 'function_call')
      calls.set(payload.call_id, payload.name);
    if (payload.type === 'function_call' && payload.name === 'spawn_agent') {
      try {
        spawnArguments.set(payload.call_id, JSON.parse(payload.arguments));
      } catch {
        errors.push('Cannot read native Codex spawn arguments');
      }
    }
    if (
      payload.type === 'agent_message' &&
      spawned.has(payload.author) &&
      payload.content?.some(
        (block) =>
          block.type === 'input_text' &&
          block.text.startsWith('Message Type: FINAL_ANSWER\n'),
      )
    )
      completed.add(payload.author);
    if (payload.type !== 'function_call_output') continue;
    let output;
    try {
      output = JSON.parse(payload.output);
    } catch {
      continue;
    }
    if (
      calls.get(payload.call_id) === 'spawn_agent' &&
      typeof output.task_name === 'string'
    ) {
      spawned.add(output.task_name);
      const arguments_ = spawnArguments.get(payload.call_id);
      if (
        arguments_?.fork_turns === 'none' ||
        arguments_?.fork_context === false
      )
        isolated.add(output.task_name);
    }
    for (const agent of output.agents ?? []) {
      if (
        spawned.has(agent.agent_name) &&
        typeof agent.agent_status?.completed === 'string'
      )
        completed.add(agent.agent_name);
    }
  }
  const receiptPath = join(directory, 'receipt.json');
  if (existsSync(receiptPath)) {
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    for (const id of [
      ...(receipt.reviewers ?? []),
      ...(receipt.validators ?? []),
    ].map((item) => item.nativeSessionId)) {
      if (!/^[a-f0-9-]{36}$/.test(id ?? '')) continue;
      const children = find(join(home, 'sessions'), id);
      if (children.length !== 1) {
        errors.push('Cannot establish unique Codex child transcript: ' + id);
        continue;
      }
      const child = archive(children[0], 'codex-' + id + '.jsonl');
      const binding = child?.find(
        (event) => event.type === 'session_meta' && event.payload?.id === id,
      )?.payload;
      const parent = binding?.source?.subagent?.thread_spawn;
      if (
        parent?.parent_thread_id !== thread ||
        parent.depth !== 1 ||
        !spawned.has(parent.agent_path)
      ) {
        errors.push('Codex child is not bound to this native parent: ' + id);
        continue;
      }
      canonicalIds[parent.agent_path] = id;
      canonicalIds[id] = id;
      if (
        child.some(
          (event) =>
            event.type === 'event_msg' &&
            event.payload?.type === 'task_complete',
        )
      )
        completed.add(id);
    }
  }
}
if (manifest.provider === 'agy') {
  const ids = new Set();
  for (const event of trace) {
    const step = event.step_update;
    if (step?.tool_name !== 'manage_subagents' || step.state !== 'DONE')
      continue;
    const output = step.tool_info?.output ?? '';
    for (const match of output.matchAll(/"conversationId":"([a-f0-9-]{36})"/g))
      ids.add(match[1]);
  }
  for (const id of ids) {
    const child = archive(
      join(
        homedir(),
        '.gemini/antigravity-cli/brain',
        id,
        '.system_generated/logs/transcript.jsonl',
      ),
      'agy-' + id + '.jsonl',
    );
    const last = child?.at(-1);
    if (
      last?.type === 'PLANNER_RESPONSE' &&
      last.status === 'DONE' &&
      typeof last.content === 'string' &&
      last.content &&
      !last.tool_calls?.length
    )
      completed.add(id);
    for (const event of child ?? []) if (event.model) models.add(event.model);
  }
}
if (manifest.provider === 'opencode') {
  for (const event of trace) {
    const part = event.part;
    if (event.type === 'error') errors.push('OpenCode native provider error');
    if (part?.tool !== 'task' || part.state?.status !== 'completed') continue;
    const metadata = part.state.metadata;
    if (
      metadata?.sessionId &&
      metadata.parentSessionId === event.sessionID &&
      metadata.sessionId !== event.sessionID &&
      metadata.truncated === false
    )
      completed.add(metadata.sessionId);
    if (metadata?.model) models.add(JSON.stringify(metadata.model));
  }
}
writeFileSync(
  join(directory, 'native-evidence.json'),
  JSON.stringify(
    {
      provider: manifest.provider,
      isolatedChildren: [...isolated].map((id) => canonicalIds[id] ?? id),
      completedChildren: [...completed].map((id) => canonicalIds[id] ?? id),
      canonicalIds,
      models: [...models],
      artifacts,
      errors,
      providerFailure: trace.some((event) =>
        /quota|RESOURCE_EXHAUSTED|rate.limit|usage.limit/i.test(
          String(event.result?.error ?? event.error?.message ?? ''),
        ),
      )
        ? 'provider-limit'
        : null,
    },
    null,
    2,
  ),
  { mode: 0o600 },
);
let result;
try {
  result = readReviewEvidence(directory);
} catch (error) {
  result = {
    passed: false,
    failures: ['missing-or-invalid-output: ' + error.message],
  };
}
writeFileSync(
  join(directory, 'evaluation.json'),
  JSON.stringify(result, null, 2),
  { mode: 0o600 },
);
console.log(JSON.stringify(result));
process.exitCode = result.passed ? 0 : 1;

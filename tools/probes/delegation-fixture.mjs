// Route deterministic model responses through the CLI's real delegation tool.
// Identity proof comes from native lifecycle receipts, not this routing marker.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { fileProbeFixture } from './worktree-fixture.mjs';

// Exercise the actual launch policy, not a friendlier hand-maintained copy.
// Parse only the two literal native flags; never execute runner source here.
export function claudeRunnerToolArgs() {
  const runner = readFileSync(
    new URL(
      '../../apps/runner-autoscaler/runner-image/direct-runner.sh',
      import.meta.url,
    ),
    'utf8',
  );
  const flags = [
    ...runner.matchAll(/--(allowedTools|disallowedTools) "([^"\n]*)"/g),
  ];
  if (flags.length !== 2 || new Set(flags.map((flag) => flag[1])).size !== 2)
    throw new Error('Cannot identify Claude runner tool policy');
  return flags.flatMap((flag) => [`--${flag[1]}`, flag[2]]);
}

export function delegationFixture(directory, home, mode, provider) {
  const files = fileProbeFixture(directory, home, mode);
  const lifecycle = join(directory, 'child-lifecycle.jsonl');
  const events = join(directory, 'delegated-tools.jsonl');
  const marker = 'LCARS_NATIVE_CHILD_FIXTURE';
  const preserved = join(directory, 'workspace', 'unpublished-work.txt');
  writeFileSync(preserved, 'retain unpublished work\n');
  let spawned = false,
    searched = false,
    childIssued = false,
    childReturned = false,
    childId;
  return {
    ...files,
    lifecycle,
    events,
    next(input, tools) {
      // OpenCode also requests auxiliary titles without a tool surface.
      if (provider === 'opencode' && !tools.length) return null;
      const child = input.some(
        (item) =>
          item.role === 'user' && JSON.stringify(item.content).includes(marker),
      );
      if (child) {
        if (childIssued) {
          childReturned ||= input.some(
            (item) =>
              item.type === 'custom_tool_call_output' ||
              item.role === 'tool' ||
              (Array.isArray(item.content) &&
                item.content.some((block) => block.type === 'tool_result')),
          );
          return null;
        }
        childIssued = true;
        return {
          tool:
            provider === 'codex'
              ? 'apply_patch'
              : provider === 'claude'
                ? 'Write'
                : 'write',
          write: true,
        };
      }
      if (!spawned) {
        if (provider !== 'codex') {
          spawned = true;
          return {
            tool: provider === 'claude' ? 'Agent' : 'task',
            args: {
              subagent_type:
                provider === 'claude' ? 'general-purpose' : 'general',
              description: 'Exercise native child hook',
              prompt: `${marker}: perform the supplied native file edit, then finish.`,
            },
          };
        }
        if (!tools.some((tool) => tool.name === 'spawn_agent')) {
          if (searched)
            throw new Error('Native discovery did not expose spawn_agent');
          searched = true;
          return {
            tool: 'tool_search',
            args: { query: 'spawn_agent wait multi-agent', limit: 2 },
          };
        }
        spawned = true;
        return {
          tool: 'spawn_agent',
          args: {
            fork_context: false,
            message: `${marker}: perform the supplied native file edit, then finish.`,
          },
        };
      }
      if (provider !== 'codex') return null;
      for (const item of input.filter(
        (entry) => entry.type === 'function_call_output',
      )) {
        try {
          childId ??= JSON.parse(item.output).agent_id;
        } catch {
          /* Not a spawn result. */
        }
      }
      if (!childId) return null;
      const completed = input.some(
        (item) =>
          item.type === 'function_call_output' &&
          String(item.output).includes('"completed"'),
      );
      return childReturned && completed
        ? null
        : {
            tool: 'wait_agent',
            args: { targets: [childId], timeout_ms: 10000 },
          };
    },
    verify(context, nativeBinding) {
      try {
        if (provider === 'opencode') {
          const receipts = readFileSync(events, 'utf8')
            .trim()
            .split('\n')
            .map(JSON.parse);
          const task = receipts.find(
            (event) => event.phase === 'before' && event.tool === 'task',
          );
          const write = receipts.find(
            (event) => event.phase === 'before' && event.tool === 'write',
          );
          const details = {
            nativeChildTool:
              childIssued &&
              childReturned &&
              !!write &&
              !!task &&
              write.sessionID !== task.sessionID &&
              write.parentID === task.sessionID,
            taskReturned:
              !!task &&
              receipts.some(
                (event) =>
                  event.phase === 'after' &&
                  event.tool === 'task' &&
                  event.callID === task.callID &&
                  event.sessionID === task.sessionID,
              ),
            immutableRoot:
              !!nativeBinding?.sessionId &&
              nativeBinding.sessionId === task?.sessionID,
            boundAttempt: nativeBinding?.attemptId === context.attemptId,
            workPreserved:
              readFileSync(preserved, 'utf8') === 'retain unpublished work\n',
            effectMatchesMode:
              existsSync(files.target) === !mode.endsWith('-review'),
            allowedContent:
              mode.endsWith('-review') ||
              readFileSync(files.target, 'utf8') === 'LCARS_FILE_PROBE\n',
          };
          return {
            passed: Object.values(details).every(Boolean),
            childId: write?.sessionID,
            ...details,
          };
        }
        const lifecycleEvents = readFileSync(lifecycle, 'utf8')
          .trim()
          .split('\n')
          .map(JSON.parse);
        const toolEvents = readFileSync(events, 'utf8')
          .trim()
          .split('\n')
          .map(JSON.parse);
        const starts = lifecycleEvents.filter(
          (event) => event.hook_event_name === 'SubagentStart',
        );
        const stops = lifecycleEvents.filter(
          (event) => event.hook_event_name === 'SubagentStop',
        );
        if (provider === 'claude') childId = starts[0]?.agent_id;
        const details = {
          childStartedAndStopped:
            !!childId &&
            starts.length === 1 &&
            stops.length === 1 &&
            [...starts, ...stops].every((event) => event.agent_id === childId),
          immutableRoot:
            !!nativeBinding?.sessionId &&
            [...lifecycleEvents, ...toolEvents].every(
              (event) => event.session_id === nativeBinding.sessionId,
            ),
          nativeChildTool:
            childIssued &&
            childReturned &&
            toolEvents.some(
              (event) =>
                event.tool_name ===
                  (provider === 'codex' ? 'apply_patch' : 'Write') &&
                (provider === 'codex'
                  ? event.transcript_path === starts[0]?.transcript_path
                  : event.agent_id === childId),
            ),
          workPreserved:
            readFileSync(preserved, 'utf8') === 'retain unpublished work\n',
          effectMatchesMode:
            existsSync(files.target) === !mode.endsWith('-review'),
          allowedContent:
            mode.endsWith('-review') ||
            readFileSync(files.target, 'utf8') === 'LCARS_FILE_PROBE\n',
          boundAttempt: nativeBinding?.attemptId === context.attemptId,
        };
        return {
          passed: Object.values(details).every(Boolean),
          childId,
          ...details,
        };
      } catch (error) {
        return {
          passed: false,
          error: error.message,
          childId,
          childIssued,
          childReturned,
        };
      }
    },
  };
}

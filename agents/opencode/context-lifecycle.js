import { readFile, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

// A working-set budget, not a per-read limit. Recent turns and instructions
// are exempt; native session history remains intact for inspection/recovery.
const READ_HISTORY_BYTES = 96_000;
// Keep policy documents, working notes, dispatch JSON, and unknown formats.
// Only reproducible source-code bodies are eligible for early eviction.
const SOURCE_FILE =
  /\.(?:[cm]?[jt]sx?|go|py|rs|sh|bash|css|scss|html|vue|svelte|sql)$/i;
const SUMMARY_OUTPUT_TOKENS = 4096;

function splitInstructions(output, loaded) {
  const index = loaded?.length
    ? output.lastIndexOf('\n\n<system-reminder>\n')
    : -1;
  return index < 0
    ? [output, '']
    : [output.slice(0, index), output.slice(index)];
}

function deduplicateInstructions(reminder, loaded, systemBodies) {
  for (const filepath of loaded ?? []) {
    const header = `Instructions from: ${filepath}\n`;
    for (const body of systemBodies) {
      const entry = header + body;
      const index = reminder.indexOf(entry);
      if (index < 0) continue;
      // Match an entire instruction file, never a shared prefix or paragraph.
      const tail = reminder.slice(index + entry.length);
      if (
        !tail.startsWith('\n\nInstructions from: ') &&
        tail !== '\n</system-reminder>'
      )
        continue;
      reminder =
        reminder.slice(0, index) +
        `[Instructions from ${filepath} are already present in the system message.]` +
        tail;
      break;
    }
  }
  return reminder;
}

export default async function contextLifecycle() {
  const systemFiles = new Map();
  return {
    'experimental.chat.system.transform': async ({ sessionID }, { system }) => {
      if (!sessionID) return;
      const text = system.join('\n');
      const candidates = [...text.matchAll(/^Instructions from: ([^\n]+)\n/gm)]
        .map((match) => match[1])
        .filter(isAbsolute);
      const files = (
        await Promise.all(
          candidates.map(async (filepath) => {
            try {
              const info = await stat(filepath);
              if (!info.isFile() || info.size > 1_048_576) return undefined;
              const body = await readFile(filepath, 'utf8');
              return text.includes(`Instructions from: ${filepath}\n${body}`)
                ? { filepath, body }
                : undefined;
            } catch {
              return undefined;
            }
          }),
        )
      ).filter(Boolean);
      // Summary requests have a different system prompt. They must not erase
      // the working agent's instruction identity before continuation.
      if (files.length) systemFiles.set(sessionID, files);
    },
    'experimental.chat.messages.transform': async (_input, { messages }) => {
      const sessionID = messages[0]?.info.sessionID;
      const bodies = (
        await Promise.all(
          (systemFiles.get(sessionID) ?? []).map(async ({ filepath, body }) => {
            const current = await readFile(filepath, 'utf8').catch(
              () => undefined,
            );
            return current === body ? body : undefined;
          }),
        )
      ).filter((body) => body !== undefined);
      const recent = new Set(
        messages
          .filter((message) => message.info.role === 'assistant')
          .slice(-2),
      );
      let remaining = READ_HISTORY_BYTES;
      for (const message of [...messages].reverse()) {
        for (const part of [...message.parts].reverse()) {
          if (
            part.type !== 'tool' ||
            part.tool !== 'read' ||
            part.state.status !== 'completed'
          )
            continue;
          const state = part.state;
          const [content, reminder] = splitInstructions(
            state.output,
            state.metadata?.loaded,
          );
          const instructions = deduplicateInstructions(
            reminder,
            state.metadata?.loaded,
            bodies,
          );
          const bytes = Buffer.byteLength(content);
          const eligible = SOURCE_FILE.test(state.input?.filePath ?? '');
          const keep = !eligible || recent.has(message) || bytes <= remaining;
          if (keep && eligible) remaining = Math.max(0, remaining - bytes);
          // This hook transforms request-local messages, not persisted parts.
          // Keep source arguments, all scoped instructions, and recent reads.
          part.state = {
            ...state,
            output:
              (keep
                ? content
                : '[Older read content omitted from this request; retained in session history. Use the original filePath/offset/limit to reread only if needed.]') +
              instructions,
          };
        }
      }
    },
    'chat.params': async ({ agent }, output) => {
      if (agent === 'compaction') {
        output.maxOutputTokens = Math.min(
          output.maxOutputTokens ?? SUMMARY_OUTPUT_TOKENS,
          SUMMARY_OUTPUT_TOKENS,
        );
      }
    },
    'experimental.session.compacting': async (_input, output) => {
      output.context.push(
        'Keep the handoff under 600 words. Prioritize the exact task and deliverable, active worktree/branch and claim, completed edits and test results, unresolved questions, and the next concrete action. Preserve required constraints and working-note paths. Merge previous state; omit repeated exploration history and copies of instructions already supplied in the system prompt.',
      );
    },
    event: async ({ event }) => {
      if (event.type === 'session.deleted')
        systemFiles.delete(event.properties.info.id);
    },
  };
}

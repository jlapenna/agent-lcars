import v1, {
  captureSystemInstructionFiles,
  COMPACTION_HANDOFF_GUIDANCE,
  currentSystemBodies,
  deduplicateInstructions,
  READ_HISTORY_BYTES,
  SOURCE_FILE,
  SUMMARY_OUTPUT_TOKENS,
} from './v1.js';

export default {
  id: 'context-lifecycle',
  server: v1,
  async setup(ctx) {
    const systemFiles = new Map();
    const ac = new AbortController();

    await ctx.session.hook('context', async (input) => {
      const sessionID = input.sessionID;
      if (sessionID && Array.isArray(input.system)) {
        const sysText = input.system
          .map((part) => (typeof part === 'string' ? part : (part?.text ?? '')))
          .join('\n');
        const files = await captureSystemInstructionFiles(sysText);
        // Auxiliary/compaction requests may carry a different system prompt;
        // never erase the working session's instruction identity.
        if (files.length) systemFiles.set(sessionID, files);
      }

      const bodies = await currentSystemBodies(systemFiles.get(sessionID));
      const messages = input.messages ?? [];
      const assistants = messages.filter((msg) => msg?.role === 'assistant');
      const recentAssistants = new Set(assistants.slice(-2));
      const readCallMeta = new Map();
      for (const assistant of assistants) {
        if (!Array.isArray(assistant.content)) continue;
        for (const part of assistant.content) {
          if (part?.type === 'tool-call' && part.name === 'read' && part.id) {
            readCallMeta.set(part.id, {
              assistant,
              filePath: part.input?.path ?? part.input?.filePath ?? '',
            });
          }
        }
      }

      let remaining = READ_HISTORY_BYTES;
      for (const message of [...messages].reverse()) {
        if (
          message?.role === 'user' &&
          bodies.length > 0 &&
          Array.isArray(message.metadata?.instruction?.paths) &&
          Array.isArray(message.content)
        ) {
          const loaded = message.metadata.instruction.paths;
          message.content = message.content.map((part) =>
            part?.type === 'text' && typeof part.text === 'string'
              ? {
                  ...part,
                  text: deduplicateInstructions(
                    part.text,
                    loaded,
                    bodies,
                    true,
                  ),
                }
              : part,
          );
          continue;
        }

        if (message?.role !== 'tool' || !Array.isArray(message.content)) {
          continue;
        }
        const updatedParts = [...message.content];
        for (let i = updatedParts.length - 1; i >= 0; i--) {
          const part = updatedParts[i];
          if (
            part?.type !== 'tool-result' ||
            part.name !== 'read' ||
            part.result?.type !== 'text' ||
            typeof part.result.value !== 'string'
          ) {
            continue;
          }
          const meta = readCallMeta.get(part.id);
          const filePath = meta?.filePath ?? '';
          const isRecent = meta ? recentAssistants.has(meta.assistant) : true;
          const bytes = Buffer.byteLength(part.result.value);
          const eligible = SOURCE_FILE.test(filePath);
          const keep = !eligible || isRecent || bytes <= remaining;
          if (keep && eligible) remaining = Math.max(0, remaining - bytes);
          if (!keep) {
            updatedParts[i] = {
              ...part,
              result: {
                ...part.result,
                value:
                  '[Older read content omitted from this request; retained in session history. Use the original path/offset/limit to reread only if needed.]',
              },
            };
          }
        }
        message.content = updatedParts;
      }
    });

    await ctx.session.hook('compaction', async (input) => {
      if (input.options) {
        input.options.maxTokens = Math.min(
          input.options.maxTokens ?? SUMMARY_OUTPUT_TOKENS,
          SUMMARY_OUTPUT_TOKENS,
        );
      }
      const bodies = await currentSystemBodies(
        systemFiles.get(input.sessionID),
      );
      const messages = input.messages ?? [];
      if (bodies.length > 0) {
        for (const message of messages) {
          if (
            message?.role === 'user' &&
            Array.isArray(message.metadata?.instruction?.paths) &&
            Array.isArray(message.content)
          ) {
            const loaded = message.metadata.instruction.paths;
            message.content = message.content.map((part) =>
              part?.type === 'text' && typeof part.text === 'string'
                ? {
                    ...part,
                    text: deduplicateInstructions(
                      part.text,
                      loaded,
                      bodies,
                      true,
                    ),
                  }
                : part,
            );
          }
        }
      }
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg?.role === 'user' && Array.isArray(msg.content)) {
          msg.content = [
            ...msg.content,
            { type: 'text', text: `\n\n${COMPACTION_HANDOFF_GUIDANCE}` },
          ];
          return;
        }
      }
      messages.push({
        role: 'user',
        content: [{ type: 'text', text: COMPACTION_HANDOFF_GUIDANCE }],
      });
    });

    if (typeof ctx.event?.subscribe === 'function') {
      void (async () => {
        try {
          for await (const event of ctx.event.subscribe({
            signal: ac.signal,
          })) {
            const id = event?.data?.sessionID ?? event?.data?.info?.id;
            if (event?.type === 'session.deleted' && id) {
              systemFiles.delete(id);
            }
          }
        } catch {
          // Subscription ended on abort/shutdown.
        }
      })();
    }

    return () => {
      ac.abort();
    };
  },
};

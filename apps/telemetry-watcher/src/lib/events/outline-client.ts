import { z } from 'zod';

export const OUTLINE_ORIGIN = 'https://outline.lan.jlapenna.net';
const userSchema = z.object({ id: z.uuid(), role: z.string() });
const documentSchema = z.object({
  id: z.uuid(),
  createdBy: z.object({ id: z.uuid() }),
  updatedBy: z.object({ id: z.uuid() }),
  updatedAt: z.iso.datetime(),
  text: z.string(),
});
const commentSchema = z.object({
  id: z.uuid(),
  documentId: z.uuid(),
  parentCommentId: z.uuid().nullable().optional(),
  createdBy: z.object({ id: z.uuid() }),
});
export interface OutlineSourceApi {
  me(): Promise<z.infer<typeof userSchema>>;
  user(id: string): Promise<z.infer<typeof userSchema>>;
  document(id: string): Promise<z.infer<typeof documentSchema> | undefined>;
  comment(id: string): Promise<z.infer<typeof commentSchema> | undefined>;
  createComment(input: {
    id: string;
    documentId: string;
    parentCommentId?: string;
    text: string;
  }): Promise<void>;
}

/** Error messages deliberately contain neither response bodies nor credentials. */
export class OutlineApiError extends Error {
  constructor(readonly status: number) {
    super(`Outline API HTTP ${status}`);
    this.name = 'OutlineApiError';
  }
}

export function outlineSourceApi(
  key: string,
  fetch: typeof globalThis.fetch = globalThis.fetch,
): OutlineSourceApi {
  const call = async (method: string, input: object): Promise<unknown> => {
    const response = await fetch(`${OUTLINE_ORIGIN}/api/${method}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(15_000),
      redirect: 'error',
    });
    if (!response.ok) throw new OutlineApiError(response.status);
    return z.object({ data: z.unknown() }).parse(await response.json()).data;
  };
  return {
    me: async () =>
      z.object({ user: userSchema }).parse(await call('auth.info', {})).user,
    user: async (id) => userSchema.parse(await call('users.info', { id })),
    document: async (id) => {
      try {
        return documentSchema.parse(await call('documents.info', { id }));
      } catch (error) {
        if (
          error instanceof OutlineApiError &&
          (error.status === 403 || error.status === 404)
        )
          return undefined;
        throw error;
      }
    },
    comment: async (id) => {
      try {
        return commentSchema.parse(await call('comments.info', { id }));
      } catch (error) {
        if (error instanceof OutlineApiError && error.status === 404)
          return undefined;
        throw error;
      }
    },
    createComment: async (input) => {
      const comment = commentSchema.parse(await call('comments.create', input));
      if (comment.id !== input.id || comment.documentId !== input.documentId)
        throw new Error('Outline comment identity mismatch');
    },
  };
}

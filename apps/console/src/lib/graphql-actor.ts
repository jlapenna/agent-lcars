import { z } from 'zod';

export const graphqlActorSchema = z.object({
  __typename: z.string().nullable().optional(),
  login: z.string(),
});

export type GraphqlActor = z.infer<typeof graphqlActorSchema>;

/**
 * Normalizes a GitHub GraphQL `Actor` (or `gh --json` author) login to the
 * canonical REST `{slug}[bot]` format used across Agent LCARS
 * (`docs/bot-identity-formats.md`).
 *
 * Raw GitHub GraphQL `Actor { __typename login }` returns
 * `{ __typename: 'Bot', login: 'agent-lcars' }` without `app/` or `[bot]`,
 * while `gh` CLI JSON emits `app/agent-lcars` and synthetic unit-test fixtures
 * may pass `{ login: 'agent-lcars[bot]' }` without `__typename`.
 */
export function normalizeGraphqlActorLogin(
  actor:
    | { readonly __typename?: string | null; readonly login?: string }
    | null
    | undefined,
): string | undefined {
  const raw = actor?.login;
  if (!raw) return undefined;
  if (
    raw.startsWith('app/') &&
    raw.length > 'app/'.length &&
    (actor?.__typename === undefined ||
      actor.__typename === null ||
      actor.__typename === 'Bot')
  ) {
    return `${raw.slice('app/'.length)}[bot]`;
  }
  if (actor?.__typename === 'Bot' && !raw.toLowerCase().endsWith('[bot]')) {
    return `${raw}[bot]`;
  }
  return raw;
}

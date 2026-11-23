import { describe, expect, it } from 'vitest';

import { normalizeGraphqlActorLogin } from './graphql-actor';

describe('normalizeGraphqlActorLogin', () => {
  it('converts raw GraphQL Bot actors to canonical REST [bot] logins', () => {
    expect(
      normalizeGraphqlActorLogin({
        __typename: 'Bot',
        login: 'agent-lcars',
      }),
    ).toBe('agent-lcars[bot]');
    expect(
      normalizeGraphqlActorLogin({
        __typename: 'Bot',
        login: 'renovate',
      }),
    ).toBe('renovate[bot]');
  });

  it('leaves User actors unchanged and never promotes a User slug to [bot]', () => {
    expect(
      normalizeGraphqlActorLogin({
        __typename: 'User',
        login: 'jlapenna',
      }),
    ).toBe('jlapenna');
    expect(
      normalizeGraphqlActorLogin({
        __typename: 'User',
        login: 'agent-lcars',
      }),
    ).toBe('agent-lcars');
    expect(
      normalizeGraphqlActorLogin({
        __typename: 'User',
        login: 'app/agent-lcars',
      }),
    ).toBe('app/agent-lcars');
    expect(normalizeGraphqlActorLogin({ login: 'app/' })).toBe('app/');
  });

  it('normalizes app/ prefixes and preserves already-normalized [bot] fixtures', () => {
    expect(normalizeGraphqlActorLogin({ login: 'app/agent-lcars' })).toBe(
      'agent-lcars[bot]',
    );
    expect(
      normalizeGraphqlActorLogin({
        __typename: 'Bot',
        login: 'agent-lcars[bot]',
      }),
    ).toBe('agent-lcars[bot]');
    expect(normalizeGraphqlActorLogin({ login: 'claude[bot]' })).toBe(
      'claude[bot]',
    );
    expect(normalizeGraphqlActorLogin(null)).toBeUndefined();
    expect(normalizeGraphqlActorLogin(undefined)).toBeUndefined();
  });
});

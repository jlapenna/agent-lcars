import type { Session } from 'next-auth';

import { assertOnboarding } from './assertOnboarding';

function makeSession(
  onboarding?: Partial<NonNullable<Session['user']['onboarding']>>,
): Session {
  return {
    user: {
      id: 'user-1',
      isAdmin: false,
      onboarding: onboarding && {
        hasAcceptedWaiver: false,
        hasCompletedProfile: false,
        isStravaConnected: false,
        hasActiveMembership: false,
        ...onboarding,
      },
    },
  } as Session;
}

describe('assertOnboarding', () => {
  it('throws when there is no session', () => {
    expect(() => assertOnboarding(null)).toThrow('Not authenticated');
  });

  it('throws when the session has no onboarding status', () => {
    const session = { user: { id: 'user-1' } } as Session;
    expect(() => assertOnboarding(session)).toThrow(
      'Onboarding status could not be determined.',
    );
  });

  it('throws when the waiver gate is required and unmet', () => {
    const session = makeSession({ hasCompletedProfile: true });
    expect(() => assertOnboarding(session)).toThrow(
      'Liability waiver and Terms of Service must be accepted first.',
    );
  });

  it('throws when the profile gate is required and unmet', () => {
    const session = makeSession({ hasAcceptedWaiver: true });
    expect(() => assertOnboarding(session)).toThrow(
      'Profile onboarding must be completed first.',
    );
  });

  it('passes with the default gates once waiver and profile are met', () => {
    const session = makeSession({
      hasAcceptedWaiver: true,
      hasCompletedProfile: true,
    });
    expect(() => assertOnboarding(session)).not.toThrow();
  });

  it('does not require membership unless explicitly listed', () => {
    const session = makeSession({
      hasAcceptedWaiver: true,
      hasCompletedProfile: true,
      hasActiveMembership: false,
    });
    expect(() => assertOnboarding(session)).not.toThrow();
  });

  it('throws when membership is required and unmet', () => {
    const session = makeSession({
      hasAcceptedWaiver: true,
      hasCompletedProfile: true,
      hasActiveMembership: false,
    });
    expect(() =>
      assertOnboarding(session, ['waiver', 'profile', 'membership']),
    ).toThrow('Active membership is required.');
  });

  it('throws when strava is required and unmet', () => {
    const session = makeSession({
      hasAcceptedWaiver: true,
      hasCompletedProfile: true,
    });
    expect(() => assertOnboarding(session, ['strava'])).toThrow(
      'Strava connection is required.',
    );
  });

  it('only checks the gates listed in required', () => {
    const session = makeSession({});
    expect(() => assertOnboarding(session, ['waiver'])).toThrow(
      'Liability waiver and Terms of Service must be accepted first.',
    );
    expect(() => assertOnboarding(session, [])).not.toThrow();
  });
});

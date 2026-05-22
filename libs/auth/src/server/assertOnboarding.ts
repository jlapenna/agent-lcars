import type { Session } from 'next-auth';

/**
 * Asserts that the current session meets the required onboarding gates.
 * Throws an error if the requirements are not met.
 *
 * @param session - The NextAuth session
 * @param required - An array of required gates. Defaults to ['waiver', 'profile']
 * @throws {Error} - If the user is not authenticated or fails a required gate
 */
export function assertOnboarding(
  session: Session | null,
  required: ('waiver' | 'profile' | 'strava')[] = ['waiver', 'profile'],
): asserts session is Session & { user: { id: string } } {
  if (!session?.user?.id) {
    throw new Error('Not authenticated');
  }

  const onboarding = session.user.onboarding;

  if (!onboarding) {
    throw new Error('Onboarding status could not be determined.');
  }

  if (required.includes('waiver') && !onboarding.hasAcceptedWaiver) {
    throw new Error(
      'Liability waiver and Terms of Service must be accepted first.',
    );
  }

  if (required.includes('profile') && !onboarding.hasCompletedProfile) {
    throw new Error('Profile onboarding must be completed first.');
  }

  if (required.includes('strava') && !onboarding.isStravaConnected) {
    throw new Error('Strava connection is required.');
  }
}

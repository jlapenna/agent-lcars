import { NextResponse } from 'next/server';

import { loadInboxNotificationSnapshot } from '../../../lib/inbox-notifications-data';

/** Bound the optional HTTP response separately from read-store timeouts. A
 * browser abort cannot cancel an underlying store read, but neither can hold
 * the app's Work mutation queue. Late reads have no side effects. */
export async function GET(): Promise<NextResponse> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const headers = { 'Cache-Control': 'private, no-store' };
  try {
    const snapshot = await Promise.race([
      loadInboxNotificationSnapshot(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Read unavailable')), 5_000);
      }),
    ]);
    return NextResponse.json(snapshot, { headers });
  } catch {
    return NextResponse.json(
      { error: 'Notification source unavailable' },
      { status: 503, headers },
    );
  } finally {
    clearTimeout(timer);
  }
}

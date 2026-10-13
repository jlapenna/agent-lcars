import { NextResponse } from 'next/server';

import { loadShellReadouts } from '../../../../lib/shell-readouts';

/** The console frame's figures (rail readouts, destination counts, identity)
 * for the signed-in user. Bounded so a slow source leaves the frame showing
 * unavailable markers rather than holding the request open. */
export async function GET(): Promise<NextResponse> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const headers = { 'Cache-Control': 'private, no-store' };
  try {
    const readouts = await Promise.race([
      loadShellReadouts(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Read unavailable')), 8_000);
      }),
    ]);
    if (!readouts) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401, headers },
      );
    }
    return NextResponse.json(readouts, { headers });
  } catch {
    return NextResponse.json(
      { error: 'Console readouts unavailable' },
      { status: 503, headers },
    );
  } finally {
    clearTimeout(timer);
  }
}

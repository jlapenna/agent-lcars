import { NextResponse } from 'next/server';

import { auth } from '@/auth';
import { getAutoscalerStatuses } from '@/lib/autoscaler-status';

export async function GET(): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.isAdmin) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return NextResponse.json(await getAutoscalerStatuses(), {
    headers: { 'Cache-Control': 'no-store' },
  });
}

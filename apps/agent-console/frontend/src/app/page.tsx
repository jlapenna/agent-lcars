import { redirect } from 'next/navigation';

import { auth } from '../auth';
import { ActionItemCard } from './action-item-card';
import { getActionItems } from './actions';
import { formatRelativeTime } from './format';

export const dynamic = 'force-dynamic';

export default async function Index() {
  const session = await auth();
  if (
    !session?.user?.isAdmin &&
    process.env.SKIP_AUTH_FOR_LAN_PREVIEW !== 'true'
  ) {
    redirect('/login');
  }

  const items = await getActionItems();
  const needsAction = items.filter((item) => item.actionTypes.length > 0);
  const rest = items.filter((item) => item.actionTypes.length === 0);

  return (
    <main style={{ maxWidth: 900, margin: '0 auto', padding: 24 }}>
      <h1>Agent Console</h1>
      <p style={{ color: '#9ca3af' }}>
        supersprinklesracing/members &mdash; Claude issue agent activity
      </p>

      <h2>Needs your action ({needsAction.length})</h2>
      {needsAction.length === 0 && (
        <p style={{ color: '#9ca3af' }}>Nothing waiting on you right now.</p>
      )}
      {needsAction.map((item) => (
        <ActionItemCard
          key={`${item.kind}-${item.number}`}
          item={item}
          updatedAtLabel={formatRelativeTime(item.updatedAt)}
        />
      ))}

      {rest.length > 0 && (
        <>
          <h2>Everything else ({rest.length})</h2>
          {rest.map((item) => (
            <ActionItemCard
              key={`${item.kind}-${item.number}`}
              item={item}
              updatedAtLabel={formatRelativeTime(item.updatedAt)}
            />
          ))}
        </>
      )}
    </main>
  );
}

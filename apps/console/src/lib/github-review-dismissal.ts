import 'server-only';

export async function dismissGithubReview(
  pullRequestUrl: string,
  reviewId: number,
  message: string,
  headers: HeadersInit,
  fetchImpl = fetch,
): Promise<void> {
  const response = await fetchImpl(
    `${pullRequestUrl}/reviews/${reviewId}/dismissals`,
    {
      method: 'PUT',
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({ message, event: 'DISMISS' }),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Dismissing GitHub review ${reviewId} failed (${response.status})`,
    );
  }
}

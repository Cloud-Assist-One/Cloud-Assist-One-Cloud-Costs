// AWS per-resource tag lookups (Lambda, DynamoDB, S3, IAM users) need one
// API call per resource. Firing them all via Promise.all is unbounded — an
// account with thousands of resources fires thousands of simultaneous
// calls, AWS throttles, and callers that swallow the throttling error end
// up with silently blank cells. This caps how many calls are ever in
// flight at once.
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  // Each worker pulls the next unclaimed index and writes its result at
  // that index, so the output stays in input order regardless of which
  // item finishes first.
  async function worker(): Promise<void> {
    for (;;) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]);
    }
  }

  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return results;
}

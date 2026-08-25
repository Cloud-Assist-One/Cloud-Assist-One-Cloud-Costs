// Every AWS list API paginates, but each one names its continuation token
// differently (NextToken, NextMarker, nextToken, position,
// LastEvaluatedTableName...). The AWS routes pass service-specific readers
// into this one loop instead of hand-rolling a while loop per fetcher.

// A hard ceiling so a service that keeps returning a token can never hang
// the request handler. At AWS's typical 50-100 items per page this still
// covers thousands of resources.
export const MAX_PAGES = 50;

export async function collectPages<TPage, TItem>(
  fetchPage: (token: string | undefined) => Promise<TPage>,
  readItems: (page: TPage) => TItem[] | undefined,
  readToken: (page: TPage) => string | undefined
): Promise<TItem[]> {
  const items: TItem[] = [];
  let token: string | undefined = undefined;

  for (let page = 0; page < MAX_PAGES; page++) {
    const response = await fetchPage(token);
    items.push(...(readItems(response) ?? []));

    // Some APIs signal "done" with an empty string rather than omitting the
    // field, which would otherwise re-request the first page forever.
    token = readToken(response) || undefined;
    if (!token) break;
  }

  return items;
}

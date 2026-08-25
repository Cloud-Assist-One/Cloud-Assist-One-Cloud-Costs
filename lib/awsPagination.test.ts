import { collectPages, MAX_PAGES } from './awsPagination';

// Each AWS list API names its continuation token differently (NextToken,
// Marker, nextToken, position, LastEvaluatedTableName...), so these tests
// drive the shared loop with plain objects rather than any one SDK's shape.
type Page = { items?: string[]; token?: string | null };

const readItems = (page: Page) => page.items;
const readToken = (page: Page) => page.token ?? undefined;

describe('collectPages', () => {
  it('returns the items from a single unpaginated response', async () => {
    const result = await collectPages(async () => ({ items: ['a', 'b'] }), readItems, readToken);
    expect(result).toEqual(['a', 'b']);
  });

  it('follows continuation tokens and concatenates pages in order', async () => {
    const pages: Record<string, Page> = {
      start: { items: ['a'], token: 't1' },
      t1: { items: ['b'], token: 't2' },
      t2: { items: ['c'] },
    };

    const result = await collectPages(
      async (token) => pages[token ?? 'start'],
      readItems,
      readToken
    );

    expect(result).toEqual(['a', 'b', 'c']);
  });

  it('passes each page token into the following request', async () => {
    const seen: (string | undefined)[] = [];
    const pages: Page[] = [{ items: ['a'], token: 't1' }, { items: ['b'] }];
    let index = 0;

    await collectPages(
      async (token) => {
        seen.push(token);
        return pages[index++];
      },
      readItems,
      readToken
    );

    expect(seen).toEqual([undefined, 't1']);
  });

  it('stops on an empty-string token', async () => {
    // Some AWS APIs signal "no more pages" with '' rather than omitting the
    // field; treating that as a real token would re-request page one forever.
    let calls = 0;
    const result = await collectPages(
      async () => {
        calls++;
        return { items: ['a'], token: '' };
      },
      readItems,
      readToken
    );

    expect(result).toEqual(['a']);
    expect(calls).toBe(1);
  });

  it('tolerates a page that carries a token but no items', async () => {
    const pages: Record<string, Page> = {
      start: { token: 't1' },
      t1: { items: ['a'] },
    };
    const result = await collectPages(
      async (token) => pages[token ?? 'start'],
      readItems,
      readToken
    );
    expect(result).toEqual(['a']);
  });

  it('gives up at the page cap instead of looping forever', async () => {
    // A service that keeps handing back a token would otherwise hang the
    // request handler indefinitely.
    let calls = 0;
    const result = await collectPages(
      async () => {
        calls++;
        return { items: ['a'], token: 'always-more' };
      },
      readItems,
      readToken
    );

    expect(calls).toBe(MAX_PAGES);
    expect(result).toHaveLength(MAX_PAGES);
  });

  it('lets a failure from the underlying call propagate', async () => {
    // Fetchers upstream turn this into their own { data, error } result, so
    // the loop must not swallow an AccessDenied into a silently empty list.
    await expect(
      collectPages(
        async () => {
          throw new Error('AccessDenied');
        },
        readItems,
        readToken
      )
    ).rejects.toThrow('AccessDenied');
  });
});

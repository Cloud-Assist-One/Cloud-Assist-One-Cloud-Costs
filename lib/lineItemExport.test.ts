import { fetchAllLineItems, EXPORT_ROW_CAP, LINE_ITEM_CSV_COLUMNS, lineItemsToCsv } from './lineItemExport';

const filters = { periodId: 'p1' };
const sort = { column: 'usage_date' as const, direction: 'desc' as const };

/** Stands in for fetchLineItemsPage, recording the pages asked for. */
function pager(totalRows: number) {
  const requested: { pageIndex: number; pageSize: number }[] = [];
  const fetchPage = jest.fn(async (_c: unknown, _f: unknown, _s: unknown, page: { pageIndex: number; pageSize: number }) => {
    requested.push(page);
    const from = page.pageIndex * page.pageSize;
    const rows = Array.from({ length: Math.max(0, Math.min(page.pageSize, totalRows - from)) }, (_, i) => ({
      id: `row-${from + i}`,
    }));
    return { rows, totalCount: totalRows };
  });
  return { fetchPage, requested };
}

describe('fetchAllLineItems', () => {
  it('returns every row when the set is small', async () => {
    const { fetchPage } = pager(120);

    const result = await fetchAllLineItems({} as never, filters, sort, { fetchPage: fetchPage as never });

    expect(result.rows).toHaveLength(120);
    expect(result.capped).toBe(false);
    expect(result.totalCount).toBe(120);
  });

  it('pages until the set is exhausted rather than taking the first page', async () => {
    const { fetchPage, requested } = pager(2500);

    await fetchAllLineItems({} as never, filters, sort, { fetchPage: fetchPage as never });

    expect(requested.length).toBeGreaterThan(1);
    expect(requested[0].pageIndex).toBe(0);
    expect(requested[1].pageIndex).toBe(1);
  });

  it('returns nothing for an empty set without looping forever', async () => {
    const { fetchPage } = pager(0);

    const result = await fetchAllLineItems({} as never, filters, sort, { fetchPage: fetchPage as never });

    expect(result.rows).toEqual([]);
    expect(result.capped).toBe(false);
  });

  // A CSV that silently stops at row N claims a completeness it does not have.
  // The cap has to be reported, the way the bucket scan reports its own.
  it('stops at the cap and says so', async () => {
    const { fetchPage } = pager(EXPORT_ROW_CAP + 500);

    const result = await fetchAllLineItems({} as never, filters, sort, { fetchPage: fetchPage as never });

    expect(result.rows).toHaveLength(EXPORT_ROW_CAP);
    expect(result.capped).toBe(true);
    expect(result.totalCount).toBe(EXPORT_ROW_CAP + 500);
  });

  it('does not report a cap when the set lands exactly on it', async () => {
    const { fetchPage } = pager(EXPORT_ROW_CAP);

    const result = await fetchAllLineItems({} as never, filters, sort, { fetchPage: fetchPage as never });

    expect(result.rows).toHaveLength(EXPORT_ROW_CAP);
    expect(result.capped).toBe(false);
  });

  it('passes the caller’s filters through unchanged, so the export matches the grid', async () => {
    const { fetchPage } = pager(1);
    const withSearch = { ...filters, searchText: 'ec2', excludeZeroCost: true };

    await fetchAllLineItems({} as never, withSearch, sort, { fetchPage: fetchPage as never });

    expect(fetchPage.mock.calls[0][1]).toEqual(withSearch);
  });
});

describe('LINE_ITEM_CSV_COLUMNS', () => {
  it('leads with the columns a reader identifies a row by', () => {
    expect(LINE_ITEM_CSV_COLUMNS.slice(0, 4).map((column) => column.key)).toEqual([
      'usage_date',
      'cloud_provider',
      'service_name',
      'cost',
    ]);
  });

  it('includes the billing code, which is what reports are grouped by', () => {
    expect(LINE_ITEM_CSV_COLUMNS.some((column) => column.key === 'billing_code')).toBe(true);
  });
});

describe('lineItemsToCsv', () => {
  it('renders the billing code from the tags object', () => {
    const csv = lineItemsToCsv([
      { usage_date: '2026-08-01', service_name: 'Amazon EC2', cost: 1, tags: { 'Billing Code': 'CC-1' } },
    ] as never);

    expect(csv).toContain('CC-1');
  });

  it('leaves the billing code empty when there is no such tag', () => {
    const csv = lineItemsToCsv([{ usage_date: '2026-08-01', service_name: 'x', cost: 1, tags: null }] as never);

    expect(csv).not.toContain('—');
  });
});

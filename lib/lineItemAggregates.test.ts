import { aggregateArgs, GROUPABLE_COLUMNS, fetchLineItemSummary, fetchLineItemGroups } from './lineItemAggregates';

describe('aggregateArgs', () => {
  it('always sends the period', () => {
    expect(aggregateArgs({ periodId: 'p1' })).toEqual({
      p_period_id: 'p1',
      p_cloud_provider: null,
      p_service_names: null,
      p_search_text: null,
      p_billing_code: null,
      p_account_id: null,
      p_region: null,
      p_date_from: null,
      p_date_to: null,
      p_cost_min: null,
      p_cost_max: null,
      p_exclude_zero_cost: false,
    });
  });

  // Every unset filter must be null, not undefined: PostgREST drops undefined
  // keys, which would silently fall back to the function's defaults rather
  // than saying "no filter" -- fine today, a trap the first time a default
  // changes.
  it('sends null for unset filters rather than omitting them', () => {
    const args = aggregateArgs({ periodId: 'p1' });

    expect(Object.values(args).every((value) => value !== undefined)).toBe(true);
  });

  it('passes every filter through under its argument name', () => {
    expect(
      aggregateArgs({
        periodId: 'p1',
        cloudProvider: 'aws',
        serviceNames: ['Amazon EC2'],
        searchText: 'i-abc',
        billingCode: 'CC-1',
        accountId: '123',
        region: 'us-east-1',
        dateFrom: '2026-08-01',
        dateTo: '2026-08-31',
        costMin: 1,
        costMax: 2,
        excludeZeroCost: true,
      })
    ).toEqual({
      p_period_id: 'p1',
      p_cloud_provider: 'aws',
      p_service_names: ['Amazon EC2'],
      p_search_text: 'i-abc',
      p_billing_code: 'CC-1',
      p_account_id: '123',
      p_region: 'us-east-1',
      p_date_from: '2026-08-01',
      p_date_to: '2026-08-31',
      p_cost_min: 1,
      p_cost_max: 2,
      p_exclude_zero_cost: true,
    });
  });

  // The grid lowercases before matching search_text; the total has to agree or
  // it would count different rows than the rows underneath it.
  it('lowercases and trims the search term, exactly as the grid filter does', () => {
    expect(aggregateArgs({ periodId: 'p1', searchText: '  I-ABC  ' }).p_search_text).toBe('i-abc');
  });

  it('treats a whitespace-only search as no search', () => {
    expect(aggregateArgs({ periodId: 'p1', searchText: '   ' }).p_search_text).toBeNull();
  });

  it('treats an empty service list as no service filter', () => {
    expect(aggregateArgs({ periodId: 'p1', serviceNames: [] }).p_service_names).toBeNull();
  });

  it('keeps a cost floor of zero rather than dropping it as falsy', () => {
    expect(aggregateArgs({ periodId: 'p1', costMin: 0 }).p_cost_min).toBe(0);
  });
});

describe('GROUPABLE_COLUMNS', () => {
  // The database whitelists the same names in a CASE. A column here that the
  // function does not know would group every row under one null key.
  it('lists only columns the grouping function recognises', () => {
    expect(GROUPABLE_COLUMNS.map((column) => column.value)).toEqual([
      'service_name',
      'billing_code',
      'account_id',
      'region',
      'charge_type',
      'cloud_provider',
    ]);
  });
});

function rpcClient(result: { data: unknown; error: { message: string } | null }) {
  const rpc = jest.fn().mockResolvedValue(result);
  return { client: { rpc } as never, rpc };
}

describe('fetchLineItemSummary', () => {
  it('returns the single summary row', async () => {
    const { client } = rpcClient({ data: [{ row_count: 42, total_cost: '1234.56' }], error: null });

    expect(await fetchLineItemSummary(client, { periodId: 'p1' })).toEqual({ rowCount: 42, totalCost: 1234.56 });
  });

  // Postgres returns numeric as a string over the wire; a raw value would make
  // the UI concatenate instead of add.
  it('coerces the numeric total, which arrives as a string', async () => {
    const { client } = rpcClient({ data: [{ row_count: 1, total_cost: '10.50' }], error: null });

    expect(typeof (await fetchLineItemSummary(client, { periodId: 'p1' })).totalCost).toBe('number');
  });

  it('reads an empty result as zero rather than failing', async () => {
    const { client } = rpcClient({ data: [], error: null });

    expect(await fetchLineItemSummary(client, { periodId: 'p1' })).toEqual({ rowCount: 0, totalCost: 0 });
  });

  it('throws the database message so the tab can show it', async () => {
    const { client } = rpcClient({ data: null, error: { message: 'permission denied' } });

    await expect(fetchLineItemSummary(client, { periodId: 'p1' })).rejects.toThrow('permission denied');
  });
});

describe('fetchLineItemGroups', () => {
  it('returns each group with its count and total', async () => {
    const { client, rpc } = rpcClient({
      data: [
        { group_key: 'Amazon EC2', row_count: 10, total_cost: '900.00' },
        { group_key: 'Amazon S3', row_count: 4, total_cost: '12.30' },
      ],
      error: null,
    });

    const groups = await fetchLineItemGroups(client, { periodId: 'p1' }, 'service_name');

    expect(groups).toEqual([
      { groupKey: 'Amazon EC2', rowCount: 10, totalCost: 900 },
      { groupKey: 'Amazon S3', rowCount: 4, totalCost: 12.3 },
    ]);
    expect(rpc).toHaveBeenCalledWith('line_items_grouped', expect.objectContaining({ p_group_by: 'service_name' }));
  });

  // Rows with no value for the grouped column are a real group, not a gap.
  it('keeps an untagged group rather than dropping it', async () => {
    const { client } = rpcClient({ data: [{ group_key: null, row_count: 3, total_cost: '5' }], error: null });

    expect(await fetchLineItemGroups(client, { periodId: 'p1' }, 'billing_code')).toEqual([
      { groupKey: null, rowCount: 3, totalCost: 5 },
    ]);
  });
});

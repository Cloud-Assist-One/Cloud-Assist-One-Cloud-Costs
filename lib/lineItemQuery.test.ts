import { fetchLineItemsPage } from './lineItemQuery';

function makeMockSupabase(response: { data: unknown[] | null; count: number | null; error: { message: string } | null }) {
  const range = jest.fn().mockResolvedValue(response);
  const order = jest.fn(() => ({ range }));
  const inFn = jest.fn(() => ({ order }));
  const eq = jest.fn(() => ({ eq, in: inFn, order }));
  const select = jest.fn(() => ({ eq }));
  const from = jest.fn(() => ({ select }));
  return { client: { from } as never, range, order, inFn, eq, select, from };
}

describe('fetchLineItemsPage', () => {
  it('returns rows and totalCount from a successful query', async () => {
    const { client, range } = makeMockSupabase({
      data: [{ id: 'r1', service_name: 'Amazon EC2', cost: 10 }],
      count: 42,
      error: null,
    });

    const result = await fetchLineItemsPage(
      client,
      { periodId: 'period-1' },
      { column: 'usage_date', direction: 'desc' },
      { pageIndex: 0, pageSize: 50 }
    );

    expect(result).toEqual({ rows: [{ id: 'r1', service_name: 'Amazon EC2', cost: 10 }], totalCount: 42 });
    expect(range).toHaveBeenCalledWith(0, 49);
  });

  it('computes the correct range for a later page', async () => {
    const { client, range } = makeMockSupabase({ data: [], count: 0, error: null });

    await fetchLineItemsPage(
      client,
      { periodId: 'period-1' },
      { column: 'cost', direction: 'asc' },
      { pageIndex: 2, pageSize: 50 }
    );

    expect(range).toHaveBeenCalledWith(100, 149);
  });

  it('applies the service-name filter via .in() when provided', async () => {
    const { client, inFn } = makeMockSupabase({ data: [], count: 0, error: null });

    await fetchLineItemsPage(
      client,
      { periodId: 'period-1', serviceNames: ['Amazon EC2', 'Amazon S3'] },
      { column: 'usage_date', direction: 'desc' },
      { pageIndex: 0, pageSize: 50 }
    );

    expect(inFn).toHaveBeenCalledWith('service_name', ['Amazon EC2', 'Amazon S3']);
  });

  it('applies the cloud provider filter via .eq() when provided', async () => {
    const { client, eq } = makeMockSupabase({ data: [], count: 0, error: null });

    await fetchLineItemsPage(
      client,
      { periodId: 'period-1', cloudProvider: 'azure' },
      { column: 'usage_date', direction: 'desc' },
      { pageIndex: 0, pageSize: 50 }
    );

    expect(eq).toHaveBeenCalledWith('cloud_provider', 'azure');
  });

  it('throws with the underlying message when the query errors', async () => {
    const { client } = makeMockSupabase({ data: null, count: null, error: { message: 'boom' } });

    await expect(
      fetchLineItemsPage(
        client,
        { periodId: 'period-1' },
        { column: 'usage_date', direction: 'desc' },
        { pageIndex: 0, pageSize: 50 }
      )
    ).rejects.toThrow('boom');
  });
});

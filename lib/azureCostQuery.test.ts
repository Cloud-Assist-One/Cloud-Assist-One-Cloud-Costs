import { mapQueryResultToRows, fetchAzureCostRows } from './azureCostQuery';

describe('mapQueryResultToRows', () => {
  // The API returns rows as positional arrays described by a separate columns
  // array. Microsoft does not contractually guarantee column ORDER, so these
  // tests deliberately vary it to prove lookup is by name.
  it('maps rows using column names rather than fixed positions', () => {
    const result = {
      columns: [
        { name: 'Cost', type: 'Number' },
        { name: 'MeterCategory', type: 'String' },
        { name: 'UsageDate', type: 'Number' },
        { name: 'Currency', type: 'String' },
      ],
      rows: [
        [19.5, 'Virtual Machines', 20260801, 'USD'],
        [3.25, 'Storage', 20260802, 'USD'],
      ],
    };

    expect(mapQueryResultToRows(result, 'Cost', 'MeterCategory')).toEqual([
      { service_name: 'Virtual Machines', usage_date: '2026-08-01', cost: 19.5 },
      { service_name: 'Storage', usage_date: '2026-08-02', cost: 3.25 },
    ]);
  });

  it('still maps correctly when the columns come back in a different order', () => {
    const result = {
      columns: [
        { name: 'UsageDate', type: 'Number' },
        { name: 'Currency', type: 'String' },
        { name: 'MeterCategory', type: 'String' },
        { name: 'Cost', type: 'Number' },
      ],
      rows: [[20260815, 'USD', 'Bandwidth', 7.5]],
    };

    expect(mapQueryResultToRows(result, 'Cost', 'MeterCategory')).toEqual([
      { service_name: 'Bandwidth', usage_date: '2026-08-15', cost: 7.5 },
    ]);
  });

  it('converts the integer YYYYMMDD usage date into an ISO date string', () => {
    const result = {
      columns: [
        { name: 'Cost', type: 'Number' },
        { name: 'MeterCategory', type: 'String' },
        { name: 'UsageDate', type: 'Number' },
      ],
      rows: [[1, 'Storage', 20261231]],
    };

    expect(mapQueryResultToRows(result, 'Cost', 'MeterCategory')[0].usage_date).toBe('2026-12-31');
  });

  it('keeps zero-cost rows, which are real data and not padding', () => {
    const result = {
      columns: [
        { name: 'Cost', type: 'Number' },
        { name: 'MeterCategory', type: 'String' },
        { name: 'UsageDate', type: 'Number' },
      ],
      rows: [[0, 'Storage', 20260801]],
    };

    expect(mapQueryResultToRows(result, 'Cost', 'MeterCategory')).toHaveLength(1);
  });

  it('throws a clear error when the expected cost column is absent', () => {
    const result = {
      columns: [
        { name: 'PreTaxCost', type: 'Number' },
        { name: 'MeterCategory', type: 'String' },
        { name: 'UsageDate', type: 'Number' },
      ],
      rows: [[1, 'Storage', 20260801]],
    };

    expect(() => mapQueryResultToRows(result, 'Cost', 'MeterCategory')).toThrow(/Cost/);
  });
});

describe('fetchAzureCostRows', () => {
  const credentials = {
    tenantId: 'tenant-1',
    clientId: 'client-1',
    clientSecret: 'secret-1',
    subscriptionId: 'sub-1',
  };

  function tokenResponse() {
    return { ok: true, json: async () => ({ access_token: 'token-abc' }) };
  }

  function queryResponse(body: unknown, ok = true, status = 200) {
    return { ok, status, json: async () => body, text: async () => JSON.stringify(body) };
  }

  beforeEach(() => {
    global.fetch = jest.fn();
  });

  it('returns rows filtered to the requested half-open date range', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(
      queryResponse({
        properties: {
          columns: [
            { name: 'Cost', type: 'Number' },
            { name: 'MeterCategory', type: 'String' },
            { name: 'UsageDate', type: 'Number' },
          ],
          // 07-31 is before the window and 08-03 is on the exclusive end —
          // both must be dropped no matter how Azure interprets `to`.
          rows: [
            [1, 'Storage', 20260731],
            [2, 'Storage', 20260801],
            [3, 'Storage', 20260802],
            [4, 'Storage', 20260803],
          ],
          nextLink: null,
        },
      })
    );

    const { rows } = await fetchAzureCostRows(credentials, '2026-08-01', '2026-08-03');

    expect(rows.map((r) => r.usage_date)).toEqual(['2026-08-01', '2026-08-02']);
  });

  it('follows nextLink until it is absent, accumulating every page', async () => {
    const columns = [
      { name: 'Cost', type: 'Number' },
      { name: 'MeterCategory', type: 'String' },
      { name: 'UsageDate', type: 'Number' },
    ];

    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        queryResponse({
          properties: { columns, rows: [[1, 'Storage', 20260801]], nextLink: 'https://next-page-1' },
        })
      )
      .mockResolvedValueOnce(
        queryResponse({
          properties: { columns, rows: [[2, 'Virtual Machines', 20260802]], nextLink: null },
        })
      );

    const { rows, rawPages } = await fetchAzureCostRows(credentials, '2026-08-01', '2026-08-03');

    expect(rows).toHaveLength(2);
    expect(rows[1].service_name).toBe('Virtual Machines');
    // Both pages are retained verbatim for the stored audit artifact.
    expect(rawPages).toHaveLength(2);
  });

  it('retries with the alternate cost column name when the first attempt is rejected', async () => {
    // Legacy/EA scopes expose PreTaxCost while MCA scopes expose Cost; the
    // account type isn't known ahead of time, so a rejection on one name
    // must transparently retry with the other.
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(queryResponse({ error: { message: 'Invalid aggregation column Cost' } }, false, 400))
      .mockResolvedValueOnce(
        queryResponse({
          properties: {
            columns: [
              { name: 'PreTaxCost', type: 'Number' },
              { name: 'MeterCategory', type: 'String' },
              { name: 'UsageDate', type: 'Number' },
            ],
            rows: [[5, 'Storage', 20260801]],
            nextLink: null,
          },
        })
      );

    const { rows } = await fetchAzureCostRows(credentials, '2026-08-01', '2026-08-03');

    expect(rows).toEqual([{ service_name: 'Storage', usage_date: '2026-08-01', cost: 5 }]);
  });

  it('surfaces the Azure error message when the token request fails', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({ error_description: 'AADSTS7000215: Invalid client secret provided.' }),
      text: async () => 'AADSTS7000215: Invalid client secret provided.',
    });

    await expect(fetchAzureCostRows(credentials, '2026-08-01', '2026-08-03')).rejects.toThrow(/Invalid client secret/);
  });

  it('surfaces the Azure error message when both cost-column attempts fail', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        queryResponse({ error: { message: 'The client does not have authorization to perform action.' } }, false, 403)
      )
      .mockResolvedValueOnce(
        queryResponse({ error: { message: 'The client does not have authorization to perform action.' } }, false, 403)
      );

    await expect(fetchAzureCostRows(credentials, '2026-08-01', '2026-08-03')).rejects.toThrow(/does not have authorization/);
  });
});

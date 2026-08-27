import { ingestCostFile } from './ingestCostFile';
import type { SupabaseClient } from '@supabase/supabase-js';

jest.mock('./parseCostFile', () => ({ parseCostFile: jest.fn() }));
import { parseCostFile } from './parseCostFile';

function row(overrides: Record<string, unknown> = {}) {
  return {
    service_name: 'Amazon EC2',
    usage_date: '2026-08-10',
    cost: 12.5,
    account_id: '123456789012',
    resource_id: 'i-abc',
    resource_group: null,
    region: 'us-east-1',
    availability_zone: null,
    instance_type: 't3.micro',
    database_engine: null,
    meter_category: null,
    meter_name: null,
    usage_type: null,
    operation: null,
    subscription_id: null,
    subscription_name: null,
    purchase_type: null,
    reservation_id: null,
    reservation_name: null,
    quantity: 1,
    unit: 'Hrs',
    unit_price: 12.5,
    effective_price: 12.5,
    currency: 'USD',
    charge_type: 'Usage',
    tags: null,
    ...overrides,
  };
}

function makeClient() {
  const deleteChain = { eq: jest.fn(), gte: jest.fn(), lte: jest.fn() };
  deleteChain.eq.mockReturnValue(deleteChain);
  deleteChain.gte.mockReturnValue(deleteChain);
  deleteChain.lte.mockResolvedValue({ error: null });

  const insert = jest.fn().mockResolvedValue({ error: null });
  const updateEq = jest.fn().mockResolvedValue({ error: null });
  const update = jest.fn().mockReturnValue({ eq: updateEq });

  const client = {
    from: jest.fn((table: string) => {
      if (table === 'cost_records') return { delete: () => deleteChain, insert };
      return { update };
    }),
  };

  return { client: client as unknown as SupabaseClient, deleteChain, insert, update, updateEq };
}

function input(over: Record<string, unknown> = {}) {
  return {
    adminClient: makeClient().client,
    companyId: 'company-1',
    cloudProvider: 'aws' as const,
    periodId: 'period-1',
    uploadedFileId: 'file-1',
    buffers: [Buffer.from('x')],
    ...over,
  };
}

describe('ingestCostFile', () => {
  beforeEach(() => {
    (parseCostFile as jest.Mock).mockReset();
  });

  it('inserts every parsed row and reports the count', async () => {
    (parseCostFile as jest.Mock).mockReturnValue({ rows: [row(), row()], errors: [] });
    const { client, insert } = makeClient();

    const result = await ingestCostFile(input({ adminClient: client }));

    expect(result).toEqual({ status: 'processed', rowCount: 2 });
    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert.mock.calls[0][0]).toHaveLength(2);
  });

  // Multi-part CUR: the parts are one logical file and must land as one set.
  it('parses every buffer and concatenates the rows', async () => {
    (parseCostFile as jest.Mock)
      .mockReturnValueOnce({ rows: [row()], errors: [] })
      .mockReturnValueOnce({ rows: [row(), row()], errors: [] });
    const { client, insert } = makeClient();

    const result = await ingestCostFile(input({ adminClient: client, buffers: [Buffer.from('a'), Buffer.from('b')] }));

    expect(parseCostFile).toHaveBeenCalledTimes(2);
    expect(result.rowCount).toBe(3);
    expect(insert.mock.calls[0][0]).toHaveLength(3);
  });

  // A corrected export replacing an earlier one must not double the month.
  it('deletes the date range it is about to insert, scoped to this period', async () => {
    (parseCostFile as jest.Mock).mockReturnValue({
      rows: [row({ usage_date: '2026-08-05' }), row({ usage_date: '2026-08-20' })],
      errors: [],
    });
    const { client, deleteChain } = makeClient();

    await ingestCostFile(input({ adminClient: client }));

    expect(deleteChain.eq).toHaveBeenCalledWith('company_id', 'company-1');
    expect(deleteChain.eq).toHaveBeenCalledWith('cloud_provider', 'aws');
    expect(deleteChain.eq).toHaveBeenCalledWith('period_id', 'period-1');
    expect(deleteChain.gte).toHaveBeenCalledWith('usage_date', '2026-08-05');
    expect(deleteChain.lte).toHaveBeenCalledWith('usage_date', '2026-08-20');
  });

  it('carries the detail columns through to the insert', async () => {
    (parseCostFile as jest.Mock).mockReturnValue({ rows: [row({ resource_id: 'i-xyz' })], errors: [] });
    const { client, insert } = makeClient();

    await ingestCostFile(input({ adminClient: client }));

    expect(insert.mock.calls[0][0][0]).toMatchObject({
      resource_id: 'i-xyz',
      source_file_id: 'file-1',
      period_id: 'period-1',
      company_id: 'company-1',
      cloud_provider: 'aws',
    });
  });

  it('marks the file row errored and inserts nothing when the parse yields no rows', async () => {
    (parseCostFile as jest.Mock).mockReturnValue({ rows: [], errors: ['Unrecognised header row.'] });
    const { client, insert, update } = makeClient();

    const result = await ingestCostFile(input({ adminClient: client }));

    expect(result.status).toBe('error');
    expect(result.errors).toEqual(['Unrecognised header row.']);
    expect(insert).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ status: 'error' }));
  });

  // parseCostFile throws on corrupt binary rather than returning an error, and
  // the file row must never be left stuck at 'processing'.
  it('marks the file row errored when the parser throws', async () => {
    (parseCostFile as jest.Mock).mockImplementation(() => {
      throw new Error('Corrupted zip');
    });
    const { client, update } = makeClient();

    const result = await ingestCostFile(input({ adminClient: client }));

    expect(result.status).toBe('error');
    expect(result.errors?.[0]).toContain('Corrupted zip');
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ status: 'error' }));
  });

  it('marks the file row processed with its row count on success', async () => {
    (parseCostFile as jest.Mock).mockReturnValue({ rows: [row()], errors: [] });
    const { client, update } = makeClient();

    await ingestCostFile(input({ adminClient: client }));

    expect(update).toHaveBeenCalledWith({ status: 'processed', row_count: 1 });
  });

  // Distinguishes a thrown parse error (couldn't even read the file) from an
  // in-band one, so the upload route can still answer 500 for the former.
  it('reports a thrown parse error distinctly, so the route can still answer 500 for it', async () => {
    (parseCostFile as jest.Mock).mockImplementation(() => {
      throw new Error('Corrupted zip');
    });
    const { client } = makeClient();

    expect((await ingestCostFile(input({ adminClient: client }))).thrown).toBe(true);
  });

  it('does not mark an in-band error as thrown', async () => {
    (parseCostFile as jest.Mock).mockReturnValue({ rows: [], errors: ['Unrecognised header row.'] });
    const { client } = makeClient();

    expect((await ingestCostFile(input({ adminClient: client }))).thrown).toBeFalsy();
  });
});

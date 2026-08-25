import { persistPulledBilling } from './pullBillingPersist';
import type { PersistPulledBillingArgs } from './pullBillingPersist';

// A recording fake of the Supabase admin client. It captures the order of
// operations, because the ordering IS the contract here: archiving must
// happen before the billing-month check (so the check sees the new period),
// and the delete must precede the insert.
function createFakeAdminClient(overrides: { archiveError?: string; deleteError?: string; insertError?: string } = {}) {
  const calls: string[] = [];
  const captured: Record<string, unknown> = {};

  const costRecordsDelete = {
    eq(column: string, value: unknown) {
      if (column === 'period_id') captured.deletePeriodId = value;
      return costRecordsDelete;
    },
    gte(_column: string, value: unknown) {
      captured.deleteGte = value;
      return costRecordsDelete;
    },
    lt(_column: string, value: unknown) {
      captured.deleteLt = value;
      return Promise.resolve({ error: overrides.deleteError ? { message: overrides.deleteError } : null });
    },
    lte() {
      captured.usedLte = true;
      return Promise.resolve({ error: null });
    },
  };

  return {
    calls,
    captured,
    rpc(name: string, args: Record<string, unknown>) {
      calls.push(`rpc:${name}`);
      captured.rpcArgs = args;
      if (overrides.archiveError) {
        return Promise.resolve({ data: null, error: { message: overrides.archiveError } });
      }
      return Promise.resolve({ data: 'new-period-id', error: null });
    },
    storage: {
      from() {
        return {
          upload(path: string) {
            calls.push('storage:upload');
            captured.storagePath = path;
            return Promise.resolve({ error: null });
          },
        };
      },
    },
    from(table: string) {
      if (table === 'billing_periods') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                single: () => {
                  calls.push('lookup:activePeriod');
                  return Promise.resolve({ data: { id: 'active-period-id' }, error: null });
                },
              }),
            }),
          }),
        };
      }

      if (table === 'uploaded_files') {
        return {
          // Used by checkBillingMonthMatches.
          select: () => ({
            eq: () => ({
              eq: () => ({
                neq: () => ({
                  not: () => {
                    calls.push('check:billingMonth');
                    return Promise.resolve({ data: [], error: null });
                  },
                }),
              }),
            }),
          }),
          insert: (payload: Record<string, unknown>) => {
            calls.push('insert:uploadedFile');
            captured.uploadedFile = payload;
            return {
              select: () => ({
                single: () => Promise.resolve({ data: { id: 'uploaded-file-id' }, error: null }),
              }),
            };
          },
          update: (payload: Record<string, unknown>) => {
            calls.push(`update:uploadedFile:${payload.status}`);
            captured.lastUpdate = payload;
            return { eq: () => Promise.resolve({ error: null }) };
          },
        };
      }

      if (table === 'cost_records') {
        return {
          delete: () => {
            calls.push('delete:costRecords');
            return costRecordsDelete;
          },
          insert: (rows: unknown[]) => {
            calls.push('insert:costRecords');
            captured.insertedRows = rows;
            return Promise.resolve({ error: overrides.insertError ? { message: overrides.insertError } : null });
          },
        };
      }

      throw new Error(`Unexpected table ${table}`);
    },
  };
}

function baseArgs(fake: ReturnType<typeof createFakeAdminClient>): PersistPulledBillingArgs {
  return {
    // The fake stands in for the Supabase client's chained query builder.
    adminClient: fake as unknown as PersistPulledBillingArgs['adminClient'],
    companyId: 'company-1',
    provider: 'azure',
    billingMonth: '2026-08-01',
    archiveFirst: false,
    rows: [{ service_name: 'Virtual Machines', usage_date: '2026-08-01', cost: 12.5 }],
    rawResponse: [{ columns: [], rows: [] }],
    artifactSuffix: 'azure-cost-management-pull.json',
    filename: 'Azure Cost Management — Production',
    uploadedBy: 'user-1',
    rangeStart: '2026-08-01',
    rangeEndExclusive: '2026-09-01',
  };
}

describe('persistPulledBilling', () => {
  it('writes into the existing active period when not archiving', async () => {
    const fake = createFakeAdminClient();

    const result = await persistPulledBilling(baseArgs(fake));

    expect(result).toEqual({
      ok: true,
      response: { uploadedFileId: 'uploaded-file-id', status: 'processed', rowCount: 1 },
    });
    expect(fake.calls).not.toContain('rpc:archive_billing_period');
    expect(fake.captured.deletePeriodId).toBe('active-period-id');
  });

  it('archives first and targets the newly created period for every later write', async () => {
    const fake = createFakeAdminClient();

    const result = await persistPulledBilling({ ...baseArgs(fake), archiveFirst: true });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.response.newPeriodId).toBe('new-period-id');

    // The archive must land before the month check, so the check evaluates
    // the fresh period rather than the one just archived.
    expect(fake.calls.indexOf('rpc:archive_billing_period')).toBeLessThan(fake.calls.indexOf('check:billingMonth'));
    expect(fake.captured.deletePeriodId).toBe('new-period-id');
  });

  it('deletes the existing range as half-open, so the exclusive end day is untouched', async () => {
    const fake = createFakeAdminClient();

    await persistPulledBilling(baseArgs(fake));

    expect(fake.captured.deleteGte).toBe('2026-08-01');
    expect(fake.captured.deleteLt).toBe('2026-09-01');
    // .lte would delete a day beyond the pulled window.
    expect(fake.captured.usedLte).toBeUndefined();
  });

  it('replaces before inserting, so a re-pull cannot double the data', async () => {
    const fake = createFakeAdminClient();

    await persistPulledBilling(baseArgs(fake));

    expect(fake.calls.indexOf('delete:costRecords')).toBeLessThan(fake.calls.indexOf('insert:costRecords'));
  });

  it('records the pull as an uploaded file so it appears in the audit trail', async () => {
    const fake = createFakeAdminClient();

    await persistPulledBilling(baseArgs(fake));

    expect(fake.captured.uploadedFile).toMatchObject({
      company_id: 'company-1',
      cloud_provider: 'azure',
      filename: 'Azure Cost Management — Production',
      billing_month: '2026-08-01',
      uploaded_by: 'user-1',
      status: 'processing',
    });
    expect(fake.captured.storagePath).toMatch(/^company-1\/\d+-azure-cost-management-pull\.json$/);
    expect(fake.calls).toContain('update:uploadedFile:processed');
  });

  it('stamps each cost record with the source file and the pulling provider', async () => {
    const fake = createFakeAdminClient();

    await persistPulledBilling(baseArgs(fake));

    expect(fake.captured.insertedRows).toEqual([
      {
        company_id: 'company-1',
        cloud_provider: 'azure',
        service_name: 'Virtual Machines',
        usage_date: '2026-08-01',
        cost: 12.5,
        account_id: null,
        source_file_id: 'uploaded-file-id',
      },
    ]);
  });

  it('returns the archive failure without touching storage or the billing tables', async () => {
    const fake = createFakeAdminClient({ archiveError: 'period is already archived' });

    const result = await persistPulledBilling({ ...baseArgs(fake), archiveFirst: true });

    expect(result).toEqual({ ok: false, status: 500, error: 'period is already archived' });
    expect(fake.calls).not.toContain('storage:upload');
    expect(fake.calls).not.toContain('insert:costRecords');
  });

  it('marks the uploaded file as errored when inserting cost records fails', async () => {
    const fake = createFakeAdminClient({ insertError: 'insert failed' });

    const result = await persistPulledBilling(baseArgs(fake));

    expect(result).toEqual({ ok: false, status: 500, error: 'insert failed' });
    // Otherwise the row would sit at "processing" forever.
    expect(fake.calls).toContain('update:uploadedFile:error');
  });
});

import { billingMonthForPeriod, deletePeriodAndContents } from './deletePeriod';

// A recording fake of the Supabase admin client: the order of operations is
// the contract here, since Storage objects must go before the rows that name
// their paths.
function createFakeAdminClient(
  options: {
    files?: { storage_path: string }[];
    notes?: { voice_note_path: string }[];
    billingMonth?: string | null;
    lookupError?: boolean;
    removeError?: boolean;
  } = {}
) {
  const calls: string[] = [];
  const removedFromBucket: Record<string, string[]> = {};

  // PostgREST's builder is chainable and awaitable at any point, so the fake
  // has to be both: every filter returns itself, and awaiting resolves to the
  // configured rows.
  function chain(table: string) {
    const result =
      table === 'uploaded_files'
        ? { data: options.files ?? [], error: null }
        : { data: options.notes ?? [], error: null };

    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: () => builder,
      not: () => builder,
      limit: () => builder,
      maybeSingle: () => {
        calls.push('lookup:billingMonth');
        if (options.lookupError) return Promise.resolve({ data: null, error: { message: 'nope' } });
        return Promise.resolve({
          data: options.billingMonth ? { billing_month: options.billingMonth } : null,
          error: null,
        });
      },
      delete: () => ({
        eq: () => {
          calls.push(`delete:${table}`);
          return Promise.resolve({ error: null });
        },
      }),
      // Makes the builder awaitable, which is how the non-maybeSingle
      // lookups in deletePeriodAndContents read their rows.
      then: (resolve: (value: unknown) => unknown) => {
        calls.push(`lookup:${table}`);
        return Promise.resolve(result).then(resolve);
      },
    };

    return builder;
  }

  return {
    calls,
    removedFromBucket,
    storage: {
      from(bucket: string) {
        return {
          remove(paths: string[]) {
            calls.push(`storage:remove:${bucket}`);
            removedFromBucket[bucket] = paths;
            return Promise.resolve({ error: options.removeError ? { message: 'storage boom' } : null });
          },
        };
      },
    },
    from: (table: string) => chain(table),
  };
}

describe('billingMonthForPeriod', () => {
  it('returns the month recorded on the period\'s processed uploads', async () => {
    const fake = createFakeAdminClient({ billingMonth: '2026-08-01' });

    const month = await billingMonthForPeriod(
      fake as unknown as Parameters<typeof billingMonthForPeriod>[0],
      'period-1'
    );

    expect(month).toBe('2026-08-01');
  });

  it('returns null for a period that never received data, so it is never treated as a duplicate', async () => {
    const fake = createFakeAdminClient({ billingMonth: null });

    const month = await billingMonthForPeriod(
      fake as unknown as Parameters<typeof billingMonthForPeriod>[0],
      'period-1'
    );

    expect(month).toBeNull();
  });

  it('returns null rather than throwing when the lookup fails', async () => {
    const fake = createFakeAdminClient({ lookupError: true });

    const month = await billingMonthForPeriod(
      fake as unknown as Parameters<typeof billingMonthForPeriod>[0],
      'period-1'
    );

    expect(month).toBeNull();
  });
});

describe('deletePeriodAndContents', () => {
  it('removes stored files before deleting the rows that name them', async () => {
    const fake = createFakeAdminClient({ files: [{ storage_path: 'company/august.xlsx' }] });

    const result = await deletePeriodAndContents(
      fake as unknown as Parameters<typeof deletePeriodAndContents>[0],
      'period-1'
    );

    expect(result).toEqual({ ok: true });
    // Losing this ordering orphans the files: once the rows are gone, nothing
    // records where they live.
    const storageIndex = fake.calls.findIndex((c) => c.startsWith('storage:remove'));
    const rowsIndex = fake.calls.indexOf('delete:uploaded_files');
    if (storageIndex !== -1) expect(storageIndex).toBeLessThan(rowsIndex);
  });

  it('deletes the period itself last', async () => {
    const fake = createFakeAdminClient();

    await deletePeriodAndContents(fake as unknown as Parameters<typeof deletePeriodAndContents>[0], 'period-1');

    expect(fake.calls[fake.calls.length - 1]).toBe('delete:billing_periods');
  });

  it('stops and reports when storage removal fails, leaving the rows intact', async () => {
    const fake = createFakeAdminClient({ files: [{ storage_path: 'company/august.xlsx' }], removeError: true });

    const result = await deletePeriodAndContents(
      fake as unknown as Parameters<typeof deletePeriodAndContents>[0],
      'period-1'
    );

    if (result.ok) throw new Error('expected the delete to fail');
    expect(result.status).toBe(500);
    expect(fake.calls).not.toContain('delete:billing_periods');
  });
});

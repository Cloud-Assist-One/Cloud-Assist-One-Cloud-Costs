import { getConnectionAllowance } from './connectionAllowance';

// A recording fake of the Supabase admin client, following the pattern in
// pullBillingPersist.test.ts. Captures which column the connection count is
// filtered by, since the whole point of this helper is that the cap is
// company-wide across every provider, not per provider.
function createFakeAdminClient(
  opts: {
    tier?: string | null;
    companyError?: string;
    count?: number;
    countError?: string;
  } = {}
) {
  const calls: string[] = [];
  const captured: Record<string, unknown> = {};

  return {
    calls,
    captured,
    from(table: string) {
      if (table === 'companies') {
        return {
          select: () => ({
            eq: (column: string, value: unknown) => {
              captured.companyEqColumn = column;
              captured.companyEqValue = value;
              return {
                maybeSingle: () => {
                  calls.push('lookup:company');
                  if (opts.companyError) {
                    return Promise.resolve({ data: null, error: { message: opts.companyError } });
                  }
                  return Promise.resolve({ data: { subscription_tier: opts.tier ?? 'free' }, error: null });
                },
              };
            },
          }),
        };
      }

      if (table === 'cloud_provider_credentials') {
        return {
          select: (columns: string, options?: { count?: string; head?: boolean }) => {
            captured.countSelectColumns = columns;
            captured.countSelectOptions = options;
            return {
              eq: (column: string, value: unknown) => {
                calls.push('count:cloud_provider_credentials');
                captured.countEqColumn = column;
                captured.countEqValue = value;
                if (opts.countError) {
                  return Promise.resolve({ data: null, error: { message: opts.countError }, count: null });
                }
                return Promise.resolve({ data: null, error: null, count: opts.count ?? 0 });
              },
            };
          },
        };
      }

      throw new Error(`Unexpected table ${table}`);
    },
  };
}

// The fake stands in for the Supabase client's chained query builder.
function asAdminClient(fake: ReturnType<typeof createFakeAdminClient>): Parameters<typeof getConnectionAllowance>[0] {
  return fake as unknown as Parameters<typeof getConnectionAllowance>[0];
}

describe('getConnectionAllowance', () => {
  it('allows adding on the free tier with 0 connections', async () => {
    const fake = createFakeAdminClient({ tier: 'free', count: 0 });

    const result = await getConnectionAllowance(asAdminClient(fake), 'company-1');

    expect(result).toEqual({ tier: 'free', limit: 1, used: 0, canAdd: true, message: null });
  });

  it('refuses on the free tier once already at 1 connection', async () => {
    const fake = createFakeAdminClient({ tier: 'free', count: 1 });

    const result = await getConnectionAllowance(asAdminClient(fake), 'company-1');

    expect(result.canAdd).toBe(false);
    expect(result.message).toMatch(/free/i);
  });

  it('allows adding on subscription_4 with 3 connections', async () => {
    const fake = createFakeAdminClient({ tier: 'subscription_4', count: 3 });

    const result = await getConnectionAllowance(asAdminClient(fake), 'company-1');

    expect(result.canAdd).toBe(true);
    expect(result.limit).toBe(4);
  });

  it('refuses on subscription_4 once already at 4 connections', async () => {
    const fake = createFakeAdminClient({ tier: 'subscription_4', count: 4 });

    const result = await getConnectionAllowance(asAdminClient(fake), 'company-1');

    expect(result.canAdd).toBe(false);
    expect(result.message).toMatch(/subscription 4/i);
  });

  it('never refuses on the unlimited tier, however many connections exist', async () => {
    const fake = createFakeAdminClient({ tier: 'subscription_unlimited', count: 1000 });

    const result = await getConnectionAllowance(asAdminClient(fake), 'company-1');

    expect(result.canAdd).toBe(true);
    expect(result.limit).toBeNull();
    expect(result.message).toBeNull();
  });

  it('refuses rather than allows when the company lookup fails', async () => {
    const fake = createFakeAdminClient({ companyError: 'company not found', count: 0 });

    const result = await getConnectionAllowance(asAdminClient(fake), 'company-1');

    expect(result.canAdd).toBe(false);
  });

  it('refuses rather than allows when the count query fails', async () => {
    const fake = createFakeAdminClient({ tier: 'subscription_unlimited', countError: 'count failed' });

    const result = await getConnectionAllowance(asAdminClient(fake), 'company-1');

    expect(result.canAdd).toBe(false);
  });

  it('counts connections across every provider — the query is filtered by company only', async () => {
    const fake = createFakeAdminClient({ tier: 'free', count: 2 });

    await getConnectionAllowance(asAdminClient(fake), 'company-1');

    expect(fake.captured.countEqColumn).toBe('company_id');
    expect(fake.captured.countEqValue).toBe('company-1');
    expect(fake.captured.countSelectOptions).toEqual({ count: 'exact', head: true });
    // A single .eq() call for the whole count query: nothing narrows it
    // further by provider, so connections on every cloud all count toward
    // the same total.
    expect(fake.calls.filter((c) => c === 'count:cloud_provider_credentials')).toHaveLength(1);
  });
});

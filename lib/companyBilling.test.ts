import { fetchCompanyAccess } from './companyBilling';

type Row = {
  subscription_tier: string | null;
  trial_ends_at: string | null;
  stripe_subscription_id: string | null;
  subscription_status: string | null;
};

// Recording fake of the Supabase admin client, following the pattern in
// connectionAllowance.test.ts.
function createFakeAdminClient(opts: { row?: Row | null; error?: string } = {}) {
  const captured: Record<string, unknown> = {};

  return {
    captured,
    from(table: string) {
      captured.table = table;
      return {
        select: (columns: string) => {
          captured.columns = columns;
          return {
            eq: (column: string, value: unknown) => {
              captured.eqColumn = column;
              captured.eqValue = value;
              return {
                maybeSingle: () =>
                  Promise.resolve(
                    opts.error
                      ? { data: null, error: { message: opts.error } }
                      : { data: opts.row ?? null, error: null }
                  ),
              };
            },
          };
        },
      };
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asAdminClient = (fake: unknown) => fake as any;

describe('fetchCompanyAccess', () => {
  it('reads the billing columns for the given company', async () => {
    const fake = createFakeAdminClient({
      row: {
        subscription_tier: 'subscription_4',
        trial_ends_at: null,
        stripe_subscription_id: 'sub_1',
        subscription_status: 'active',
      },
    });

    const access = await fetchCompanyAccess(asAdminClient(fake), 'company-1');

    expect(fake.captured.table).toBe('companies');
    expect(fake.captured.eqColumn).toBe('id');
    expect(fake.captured.eqValue).toBe('company-1');
    expect(access).toEqual({ state: 'active', tier: 'subscription_4' });
  });

  it('locks rather than opens when the lookup fails', async () => {
    const fake = createFakeAdminClient({ error: 'connection reset' });

    const access = await fetchCompanyAccess(asAdminClient(fake), 'company-1');

    expect(access.state).toBe('trial_expired');
  });

  it('locks when the company does not exist', async () => {
    const fake = createFakeAdminClient({ row: null });

    const access = await fetchCompanyAccess(asAdminClient(fake), 'missing');

    expect(access.state).toBe('trial_expired');
  });

  it('locks rather than lets an exception escape when the client throws', async () => {
    // A thrown client error (network exception, DNS failure, ...) is no more
    // verifiable than a returned `{ error }` -- this must still resolve to
    // trial_expired instead of propagating out of the guard as a 500.
    const throwingClient = {
      from() {
        throw new Error('network exception');
      },
    };

    const access = await fetchCompanyAccess(asAdminClient(throwingClient), 'company-1');

    expect(access.state).toBe('trial_expired');
  });
});

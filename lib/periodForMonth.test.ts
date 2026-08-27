import { periodForMonth } from './periodForMonth';
import type { SupabaseClient } from '@supabase/supabase-js';

function makeClient(existingArchive: { id: string } | null, updateError: { message: string } | null = null) {
  const maybeSingle = jest.fn().mockResolvedValue({ data: existingArchive, error: null });
  const select = jest.fn().mockReturnValue({
    eq: jest.fn().mockReturnValue({
      eq: jest.fn().mockReturnValue({ eq: jest.fn().mockReturnValue({ maybeSingle }) }),
    }),
  });
  const insertSingle = jest.fn().mockResolvedValue({ data: { id: 'new-archived' }, error: null });
  const insert = jest.fn().mockReturnValue({ select: () => ({ single: insertSingle }) });
  const update = jest.fn().mockReturnValue({ eq: jest.fn().mockResolvedValue({ error: updateError }) });

  const client = { from: jest.fn(() => ({ select, insert, update })) };
  return { client: client as unknown as SupabaseClient, insert, update };
}

describe('periodForMonth', () => {
  it('puts the latest month in the active period', async () => {
    const { client, insert } = makeClient(null);

    const target = await periodForMonth(client, 'company-1', '2026-08-01', 'active-1', true);

    expect(target).toEqual({ periodId: 'active-1', kind: 'active' });
    expect(insert).not.toHaveBeenCalled();
  });

  // The active period is created without a month; the pull is what gives it one.
  it('stamps the billing month on the active period', async () => {
    const { client, update } = makeClient(null);

    await periodForMonth(client, 'company-1', '2026-08-01', 'active-1', true);

    expect(update).toHaveBeenCalledWith({ billing_month: '2026-08-01' });
  });

  it('reuses an existing archived period for an earlier month', async () => {
    const { client, insert } = makeClient({ id: 'archived-july' });

    const target = await periodForMonth(client, 'company-1', '2026-07-01', 'active-1', false);

    expect(target).toEqual({ periodId: 'archived-july', kind: 'archived' });
    expect(insert).not.toHaveBeenCalled();
  });

  it('creates an archived period when none exists for that month', async () => {
    const { client, insert } = makeClient(null);

    const target = await periodForMonth(client, 'company-1', '2026-06-01', 'active-1', false);

    expect(target).toEqual({ periodId: 'new-archived', kind: 'archived' });
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ company_id: 'company-1', status: 'archived', billing_month: '2026-06-01' })
    );
  });

  it('stamps archived_at on a period it creates, so the Archive tab can order it', async () => {
    const { client, insert } = makeClient(null);

    await periodForMonth(client, 'company-1', '2026-06-01', 'active-1', false);

    expect(insert.mock.calls[0][0].archived_at).toEqual(expect.any(String));
  });

  // Unchecked, a failed stamp leaves the active period silently unstamped
  // with nothing reporting it. Throwing lets the pull route's per-run
  // try/catch report this run as failed instead.
  it('throws when stamping the active period fails, rather than leaving it silently unstamped', async () => {
    const { client } = makeClient(null, { message: 'connection reset' });

    await expect(periodForMonth(client, 'company-1', '2026-08-01', 'active-1', true)).rejects.toThrow(
      'connection reset'
    );
  });
});

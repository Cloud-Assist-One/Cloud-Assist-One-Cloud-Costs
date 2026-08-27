import { fetchCostsForResources, lookupCost } from './findingCosts';
import type { SupabaseClient } from '@supabase/supabase-js';

function makeSupabase(rows: { resource_id: string | null; cost: number }[], error: { message: string } | null = null) {
  const inSpy = jest.fn().mockResolvedValue({ data: rows, error });
  const client = {
    from: jest.fn().mockReturnValue({
      select: jest.fn().mockReturnValue({
        eq: jest.fn().mockReturnValue({
          eq: jest.fn().mockReturnValue({ in: inSpy }),
        }),
      }),
    }),
  };
  return { client: client as unknown as SupabaseClient, inSpy };
}

describe('fetchCostsForResources', () => {
  it('returns an empty map and makes no query when there is no active period', async () => {
    const { client, inSpy } = makeSupabase([]);

    const costs = await fetchCostsForResources(client, null, 'aws', ['arn:aws:ec2:us-east-1:1:volume/vol-1']);

    expect(costs.size).toBe(0);
    expect(inSpy).not.toHaveBeenCalled();
  });

  it('returns an empty map and makes no query when there are no findings to price', async () => {
    const { client, inSpy } = makeSupabase([]);

    const costs = await fetchCostsForResources(client, 'period-1', 'aws', []);

    expect(costs.size).toBe(0);
    expect(inSpy).not.toHaveBeenCalled();
  });

  it('queries both the original and the lowercased spelling of each resource id', async () => {
    const { client, inSpy } = makeSupabase([]);

    await fetchCostsForResources(client, 'period-1', 'azure', ['/subscriptions/S1/resourceGroups/RG/disk-1']);

    expect(inSpy).toHaveBeenCalledWith('resource_id', [
      '/subscriptions/S1/resourceGroups/RG/disk-1',
      '/subscriptions/s1/resourcegroups/rg/disk-1',
    ]);
  });

  it('sums every line item belonging to the same resource', async () => {
    const { client } = makeSupabase([
      { resource_id: 'vol-1', cost: 4.5 },
      { resource_id: 'vol-1', cost: 3.25 },
    ]);

    const costs = await fetchCostsForResources(client, 'period-1', 'aws', ['vol-1']);

    expect(costs.get('vol-1')).toBeCloseTo(7.75);
  });

  it('matches case-insensitively', async () => {
    const { client } = makeSupabase([{ resource_id: '/SUBSCRIPTIONS/S1/DISK-1', cost: 12 }]);

    const costs = await fetchCostsForResources(client, 'period-1', 'azure', ['/subscriptions/s1/disk-1']);

    expect(lookupCost(costs, '/subscriptions/S1/disk-1')).toBe(12);
  });

  it('skips rows with a null resource id', async () => {
    const { client } = makeSupabase([
      { resource_id: null, cost: 99 },
      { resource_id: 'vol-1', cost: 1 },
    ]);

    const costs = await fetchCostsForResources(client, 'period-1', 'aws', ['vol-1']);

    expect(costs.size).toBe(1);
    expect(costs.get('vol-1')).toBe(1);
  });

  it('throws when the query fails, so the route can report it rather than showing every cost as unknown', async () => {
    const { client } = makeSupabase([], { message: 'connection reset' });

    await expect(fetchCostsForResources(client, 'period-1', 'aws', ['vol-1'])).rejects.toThrow('connection reset');
  });
});

describe('lookupCost', () => {
  it('returns null for a resource that was not in the billing pull', () => {
    expect(lookupCost(new Map(), 'vol-missing')).toBeNull();
  });

  it('distinguishes a genuine zero from a miss', () => {
    expect(lookupCost(new Map([['vol-1', 0]]), 'vol-1')).toBe(0);
  });
});

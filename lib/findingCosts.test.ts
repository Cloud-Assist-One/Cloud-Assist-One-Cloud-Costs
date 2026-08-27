import { fetchCostsForResources, lookupCost } from './findingCosts';
import type { SupabaseClient } from '@supabase/supabase-js';

function makeSupabase(rows: { resource_id: string | null; cost: number }[], error: { message: string } | null = null) {
  const orSpy = jest.fn().mockResolvedValue({ data: rows, error });
  const client = {
    from: jest.fn().mockReturnValue({
      select: jest.fn().mockReturnValue({
        eq: jest.fn().mockReturnValue({
          eq: jest.fn().mockReturnValue({ or: orSpy }),
        }),
      }),
    }),
  };
  return { client: client as unknown as SupabaseClient, orSpy };
}

describe('fetchCostsForResources', () => {
  it('returns an empty map and makes no query when there is no active period', async () => {
    const { client, orSpy } = makeSupabase([]);

    const costs = await fetchCostsForResources(client, null, 'aws', ['arn:aws:ec2:us-east-1:1:volume/vol-1']);

    expect(costs.size).toBe(0);
    expect(orSpy).not.toHaveBeenCalled();
  });

  it('returns an empty map and makes no query when there are no findings to price', async () => {
    const { client, orSpy } = makeSupabase([]);

    const costs = await fetchCostsForResources(client, 'period-1', 'aws', []);

    expect(costs.size).toBe(0);
    expect(orSpy).not.toHaveBeenCalled();
  });

  it('builds an .or() filter with the exact id, exact bare id, and bare-suffix terms for each resource', async () => {
    const { client, orSpy } = makeSupabase([]);

    await fetchCostsForResources(client, 'period-1', 'aws', ['arn:aws:ec2:us-east-1:1:volume/vol-1']);

    expect(orSpy).toHaveBeenCalledTimes(1);
    const filter = orSpy.mock.calls[0][0] as string;
    expect(filter).toContain('resource_id.eq.arn:aws:ec2:us-east-1:1:volume/vol-1');
    expect(filter).toContain('resource_id.eq.vol-1');
    expect(filter).toContain('resource_id.ilike.%/vol-1');
  });

  it('matches a bare-id finding against a full-ARN billing row', async () => {
    const { client } = makeSupabase([
      { resource_id: 'arn:aws:ec2:us-east-1:123456789012:volume/vol-abc', cost: 5 },
    ]);

    const costs = await fetchCostsForResources(client, 'period-1', 'aws', ['vol-abc']);

    expect(lookupCost(costs, 'vol-abc')).toBe(5);
  });

  it('matches a full-ARN finding against a bare-id billing row', async () => {
    const { client } = makeSupabase([{ resource_id: 'vol-abc', cost: 5 }]);

    const costs = await fetchCostsForResources(client, 'period-1', 'aws', [
      'arn:aws:ec2:us-east-1:123456789012:volume/vol-abc',
    ]);

    expect(lookupCost(costs, 'arn:aws:ec2:us-east-1:123456789012:volume/vol-abc')).toBe(5);
  });

  it('does not cross-match two resources with different bare ids', async () => {
    const { client } = makeSupabase([{ resource_id: 'vol-1', cost: 5 }]);

    const costs = await fetchCostsForResources(client, 'period-1', 'aws', ['vol-1', 'vol-2']);

    expect(lookupCost(costs, 'vol-1')).toBe(5);
    expect(lookupCost(costs, 'vol-2')).toBeNull();
  });

  it('skips a resource id containing a comma rather than building a malformed filter', async () => {
    const { client, orSpy } = makeSupabase([]);

    await fetchCostsForResources(client, 'period-1', 'aws', ['vol,1', 'vol-2']);

    expect(orSpy).toHaveBeenCalledTimes(1);
    const filter = orSpy.mock.calls[0][0] as string;
    expect(filter).not.toContain('vol,1');
    expect(filter).toContain('resource_id.eq.vol-2');
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

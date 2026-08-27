import { fetchCostsForResources, lookupCost } from './findingCosts';
import type { SupabaseClient } from '@supabase/supabase-js';

function makeSupabase(rows: { resource_id: string | null; cost: number }[], error: { message: string } | null = null) {
  const orSpy = jest.fn().mockResolvedValue({ data: rows, error });
  const companyEqSpy = jest.fn().mockReturnValue({ or: orSpy });
  const providerEqSpy = jest.fn().mockReturnValue({ eq: companyEqSpy });
  const periodEqSpy = jest.fn().mockReturnValue({ eq: providerEqSpy });
  const client = {
    from: jest.fn().mockReturnValue({
      select: jest.fn().mockReturnValue({
        eq: periodEqSpy,
      }),
    }),
  };
  return { client: client as unknown as SupabaseClient, orSpy, periodEqSpy, providerEqSpy, companyEqSpy };
}

describe('fetchCostsForResources', () => {
  it('returns an empty map and makes no query when there is no active period', async () => {
    const { client, orSpy } = makeSupabase([]);

    const costs = await fetchCostsForResources(client, null, 'aws', 'company-1', ['arn:aws:ec2:us-east-1:1:volume/vol-1']);

    expect(costs.size).toBe(0);
    expect(orSpy).not.toHaveBeenCalled();
  });

  it('returns an empty map and makes no query when there are no findings to price', async () => {
    const { client, orSpy } = makeSupabase([]);

    const costs = await fetchCostsForResources(client, 'period-1', 'aws', 'company-1', []);

    expect(costs.size).toBe(0);
    expect(orSpy).not.toHaveBeenCalled();
  });

  it('builds an .or() filter with the exact id, exact bare id, and bare-suffix terms for each resource', async () => {
    const { client, orSpy } = makeSupabase([]);

    await fetchCostsForResources(client, 'period-1', 'aws', 'company-1', ['arn:aws:ec2:us-east-1:1:volume/vol-1']);

    expect(orSpy).toHaveBeenCalledTimes(1);
    const filter = orSpy.mock.calls[0][0] as string;
    expect(filter).toContain('resource_id.eq.arn:aws:ec2:us-east-1:1:volume/vol-1');
    expect(filter).toContain('resource_id.eq.vol-1');
    expect(filter).toContain('resource_id.ilike.%/vol-1');
  });

  // Fix: the cost join used to filter only on period_id + cloud_provider, so
  // a client could pass another company's periodId and have that company's
  // billed costs joined onto their own findings -- this route runs on the
  // service-role client, so RLS does not catch it. The query must scope to
  // the caller's own company explicitly.
  it('scopes the query to the caller-supplied company id', async () => {
    const { client, periodEqSpy, providerEqSpy, companyEqSpy } = makeSupabase([]);

    await fetchCostsForResources(client, 'period-1', 'aws', 'company-77', ['vol-1']);

    expect(periodEqSpy).toHaveBeenCalledWith('period_id', 'period-1');
    expect(providerEqSpy).toHaveBeenCalledWith('cloud_provider', 'aws');
    expect(companyEqSpy).toHaveBeenCalledWith('company_id', 'company-77');
  });

  it('matches a bare-id finding against a full-ARN billing row', async () => {
    const { client } = makeSupabase([
      { resource_id: 'arn:aws:ec2:us-east-1:123456789012:volume/vol-abc', cost: 5 },
    ]);

    const costs = await fetchCostsForResources(client, 'period-1', 'aws', 'company-1', ['vol-abc']);

    expect(lookupCost(costs, 'vol-abc')).toBe(5);
  });

  it('matches a full-ARN finding against a bare-id billing row', async () => {
    const { client } = makeSupabase([{ resource_id: 'vol-abc', cost: 5 }]);

    const costs = await fetchCostsForResources(client, 'period-1', 'aws', 'company-1', [
      'arn:aws:ec2:us-east-1:123456789012:volume/vol-abc',
    ]);

    expect(lookupCost(costs, 'arn:aws:ec2:us-east-1:123456789012:volume/vol-abc')).toBe(5);
  });

  it('does not cross-match two resources with different bare ids', async () => {
    const { client } = makeSupabase([{ resource_id: 'vol-1', cost: 5 }]);

    const costs = await fetchCostsForResources(client, 'period-1', 'aws', 'company-1', ['vol-1', 'vol-2']);

    expect(lookupCost(costs, 'vol-1')).toBe(5);
    expect(lookupCost(costs, 'vol-2')).toBeNull();
  });

  it('skips a resource id containing a comma rather than building a malformed filter', async () => {
    const { client, orSpy } = makeSupabase([]);

    await fetchCostsForResources(client, 'period-1', 'aws', 'company-1', ['vol,1', 'vol-2']);

    expect(orSpy).toHaveBeenCalledTimes(1);
    const filter = orSpy.mock.calls[0][0] as string;
    expect(filter).not.toContain('vol,1');
    expect(filter).toContain('resource_id.eq.vol-2');
  });

  // Fix: '_' and '%' are LIKE/ILIKE wildcards, not literal characters, and
  // Azure resource names permit '_'. Without this exclusion, a finding for
  // "my_disk" would ilike-match a billing row for "my-disk" (or any other
  // single-character difference in that position).
  it('omits the ilike suffix term for a bare id containing an underscore, but keeps both eq terms', async () => {
    const { client, orSpy } = makeSupabase([]);

    await fetchCostsForResources(client, 'period-1', 'azure', 'company-1', [
      '/subscriptions/s1/disks/my_disk',
    ]);

    expect(orSpy).toHaveBeenCalledTimes(1);
    const filter = orSpy.mock.calls[0][0] as string;
    expect(filter).toContain('resource_id.eq./subscriptions/s1/disks/my_disk');
    expect(filter).toContain('resource_id.eq.my_disk');
    expect(filter).not.toContain('ilike');
  });

  it('omits the ilike suffix term for a bare id containing a percent sign', async () => {
    const { client, orSpy } = makeSupabase([]);

    await fetchCostsForResources(client, 'period-1', 'azure', 'company-1', ['disk%1']);

    expect(orSpy).toHaveBeenCalledTimes(1);
    const filter = orSpy.mock.calls[0][0] as string;
    expect(filter).toContain('resource_id.eq.disk%1');
    expect(filter).not.toContain('ilike');
  });

  it('still builds the ilike suffix term for a bare id with no wildcard characters', async () => {
    const { client, orSpy } = makeSupabase([]);

    await fetchCostsForResources(client, 'period-1', 'azure', 'company-1', ['/subscriptions/s1/disks/disk-1']);

    const filter = orSpy.mock.calls[0][0] as string;
    expect(filter).toContain('resource_id.ilike.%/disk-1');
  });

  it('sums every line item belonging to the same resource', async () => {
    const { client } = makeSupabase([
      { resource_id: 'vol-1', cost: 4.5 },
      { resource_id: 'vol-1', cost: 3.25 },
    ]);

    const costs = await fetchCostsForResources(client, 'period-1', 'aws', 'company-1', ['vol-1']);

    expect(costs.get('vol-1')).toBeCloseTo(7.75);
  });

  it('matches case-insensitively', async () => {
    const { client } = makeSupabase([{ resource_id: '/SUBSCRIPTIONS/S1/DISK-1', cost: 12 }]);

    const costs = await fetchCostsForResources(client, 'period-1', 'azure', 'company-1', ['/subscriptions/s1/disk-1']);

    expect(lookupCost(costs, '/subscriptions/S1/disk-1')).toBe(12);
  });

  it('skips rows with a null resource id', async () => {
    const { client } = makeSupabase([
      { resource_id: null, cost: 99 },
      { resource_id: 'vol-1', cost: 1 },
    ]);

    const costs = await fetchCostsForResources(client, 'period-1', 'aws', 'company-1', ['vol-1']);

    expect(costs.size).toBe(1);
    expect(costs.get('vol-1')).toBe(1);
  });

  // Fix: a non-numeric `cost` used to become NaN via `Number(row.cost ?? 0)`,
  // which then propagated all the way to the rendered "$NaN". The row is
  // skipped instead so a bad value degrades to "unknown", not garbage.
  it('skips a row whose cost is not a finite number, rather than propagating NaN', async () => {
    const { client } = makeSupabase([
      { resource_id: 'vol-1', cost: Number.NaN },
      { resource_id: 'vol-2', cost: 5 },
    ]);

    const costs = await fetchCostsForResources(client, 'period-1', 'aws', 'company-1', ['vol-1', 'vol-2']);

    expect(costs.has('vol-1')).toBe(false);
    expect(costs.get('vol-2')).toBe(5);
  });

  it('throws when the query fails, so the caller can decide how to handle it', async () => {
    const { client } = makeSupabase([], { message: 'connection reset' });

    await expect(fetchCostsForResources(client, 'period-1', 'aws', 'company-1', ['vol-1'])).rejects.toThrow(
      'connection reset'
    );
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

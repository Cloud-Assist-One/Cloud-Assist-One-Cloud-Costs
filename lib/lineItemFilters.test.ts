import { applyLineItemFilters } from './lineItemFilters';

/**
 * Records what the filter function asked PostgREST for, without a database.
 *
 * Every method returns the same recorder, so a chain of filters accumulates
 * into one ordered list of calls the assertions read.
 */
function recorder() {
  const calls: { method: string; args: unknown[] }[] = [];
  const builder: Record<string, (...args: unknown[]) => unknown> = {};
  for (const method of ['eq', 'neq', 'in', 'ilike', 'gte', 'lte']) {
    builder[method] = (...args: unknown[]) => {
      calls.push({ method, args });
      return builder;
    };
  }
  return { builder, calls };
}

function apply(filters: Parameters<typeof applyLineItemFilters>[1]) {
  const { builder, calls } = recorder();
  applyLineItemFilters(builder as never, filters);
  return calls;
}

describe('applyLineItemFilters', () => {
  it('always scopes to the period', () => {
    expect(apply({ periodId: 'p1' })).toEqual([{ method: 'eq', args: ['period_id', 'p1'] }]);
  });

  it('adds nothing beyond the period when no filter is set', () => {
    expect(apply({ periodId: 'p1' })).toHaveLength(1);
  });

  it('filters by provider and service list', () => {
    const calls = apply({ periodId: 'p1', cloudProvider: 'aws', serviceNames: ['Amazon EC2'] });

    expect(calls).toContainEqual({ method: 'eq', args: ['cloud_provider', 'aws'] });
    expect(calls).toContainEqual({ method: 'in', args: ['service_name', ['Amazon EC2']] });
  });

  it('ignores an empty service list rather than matching nothing', () => {
    expect(apply({ periodId: 'p1', serviceNames: [] })).toHaveLength(1);
  });

  // Free text goes at the generated search_text column, which the migration
  // fills from every column worth searching and indexes with pg_trgm.
  it('matches free text against search_text as a contains-ilike', () => {
    const calls = apply({ periodId: 'p1', searchText: 'i-abc123' });

    expect(calls).toContainEqual({ method: 'ilike', args: ['search_text', '%i-abc123%'] });
  });

  it('lowercases the search term, since search_text is stored lowercased', () => {
    const calls = apply({ periodId: 'p1', searchText: 'I-ABC123' });

    expect(calls).toContainEqual({ method: 'ilike', args: ['search_text', '%i-abc123%'] });
  });

  it('trims the search term and ignores one that is only whitespace', () => {
    expect(apply({ periodId: 'p1', searchText: '  ' })).toHaveLength(1);
    expect(apply({ periodId: 'p1', searchText: '  ec2  ' })).toContainEqual({
      method: 'ilike',
      args: ['search_text', '%ec2%'],
    });
  });

  // A user typing "100%" must not turn into a wildcard that matches every row.
  it('escapes LIKE wildcards in the search term', () => {
    const calls = apply({ periodId: 'p1', searchText: '100%' });

    expect(calls).toContainEqual({ method: 'ilike', args: ['search_text', '%100\\%%'] });
  });

  it('escapes an underscore, which LIKE treats as a single-character wildcard', () => {
    const calls = apply({ periodId: 'p1', searchText: 'a_b' });

    expect(calls).toContainEqual({ method: 'ilike', args: ['search_text', '%a\\_b%'] });
  });

  // billing_code is its own generated column, so the tag's many spellings are
  // resolved once in the database rather than guessed at per query.
  it('filters by billing code exactly', () => {
    const calls = apply({ periodId: 'p1', billingCode: 'CC-1234' });

    expect(calls).toContainEqual({ method: 'eq', args: ['billing_code', 'CC-1234'] });
  });

  it('filters by account and region', () => {
    const calls = apply({ periodId: 'p1', accountId: '123456789012', region: 'us-east-1' });

    expect(calls).toContainEqual({ method: 'eq', args: ['account_id', '123456789012'] });
    expect(calls).toContainEqual({ method: 'eq', args: ['region', 'us-east-1'] });
  });

  it('applies an inclusive date range', () => {
    const calls = apply({ periodId: 'p1', dateFrom: '2026-08-01', dateTo: '2026-08-15' });

    expect(calls).toContainEqual({ method: 'gte', args: ['usage_date', '2026-08-01'] });
    expect(calls).toContainEqual({ method: 'lte', args: ['usage_date', '2026-08-15'] });
  });

  it('applies either end of a date range on its own', () => {
    expect(apply({ periodId: 'p1', dateFrom: '2026-08-01' })).toContainEqual({
      method: 'gte',
      args: ['usage_date', '2026-08-01'],
    });
    expect(apply({ periodId: 'p1', dateTo: '2026-08-15' })).toContainEqual({
      method: 'lte',
      args: ['usage_date', '2026-08-15'],
    });
  });

  it('applies a cost range', () => {
    const calls = apply({ periodId: 'p1', costMin: 100, costMax: 500 });

    expect(calls).toContainEqual({ method: 'gte', args: ['cost', 100] });
    expect(calls).toContainEqual({ method: 'lte', args: ['cost', 500] });
  });

  // 0 is a real threshold — "everything at or above nothing" is a valid ask,
  // and a truthiness check would silently drop it.
  it('applies a cost floor of zero rather than treating it as unset', () => {
    expect(apply({ periodId: 'p1', costMin: 0 })).toContainEqual({ method: 'gte', args: ['cost', 0] });
  });

  describe('excludeZeroCost', () => {
    it('drops rows costing exactly zero', () => {
      expect(apply({ periodId: 'p1', excludeZeroCost: true })).toContainEqual({
        method: 'neq',
        args: ['cost', 0],
      });
    });

    // A negative cost is a credit or refund. "greater than zero" would hide
    // real money; "not equal to zero" keeps it.
    it('uses neq rather than gt, so credits and refunds survive', () => {
      const calls = apply({ periodId: 'p1', excludeZeroCost: true });

      expect(calls.some((call) => call.method === 'gte' && call.args[0] === 'cost')).toBe(false);
    });

    it('adds nothing when it is off', () => {
      expect(apply({ periodId: 'p1', excludeZeroCost: false })).toHaveLength(1);
    });

    it('composes with an explicit cost range', () => {
      const calls = apply({ periodId: 'p1', excludeZeroCost: true, costMin: -100, costMax: 100 });

      expect(calls).toContainEqual({ method: 'neq', args: ['cost', 0] });
      expect(calls).toContainEqual({ method: 'gte', args: ['cost', -100] });
      expect(calls).toContainEqual({ method: 'lte', args: ['cost', 100] });
    });
  });

  it('combines every filter into one query', () => {
    const calls = apply({
      periodId: 'p1',
      cloudProvider: 'azure',
      serviceNames: ['Virtual Machines'],
      searchText: 'web',
      billingCode: 'CC-9',
      accountId: 'sub-1',
      region: 'eastus',
      dateFrom: '2026-08-01',
      dateTo: '2026-08-31',
      costMin: 1,
      costMax: 2,
      excludeZeroCost: true,
    });

    expect(calls).toHaveLength(12);
  });
});

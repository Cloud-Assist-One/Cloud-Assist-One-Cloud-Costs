import { parseAssistantFilters, ASSISTANT_FILTER_PROPERTIES } from './assistantFilters';

describe('parseAssistantFilters', () => {
  it('accepts a well-formed filter', () => {
    expect(
      parseAssistantFilters({ cloudProvider: 'aws', searchText: 'ec2', costMin: 100 })
    ).toEqual({ cloudProvider: 'aws', searchText: 'ec2', costMin: 100 });
  });

  it('returns an empty filter for an empty object', () => {
    expect(parseAssistantFilters({})).toEqual({});
  });

  // The model is a translator, not an authority. Everything below is about
  // what happens when it returns something it should not have.
  it('drops keys that are not filters', () => {
    expect(
      parseAssistantFilters({ searchText: 'ec2', companyId: 'other-co', periodId: 'other-period' })
    ).toEqual({ searchText: 'ec2' });
  });

  // periodId decides whose data is read. It comes from the session, never from
  // the model, so a model that returns one must not be able to change it.
  it('never lets a returned periodId through', () => {
    const parsed = parseAssistantFilters({ periodId: 'attacker-period' }) as Record<string, unknown>;

    expect(parsed.periodId).toBeUndefined();
  });

  it('rejects a provider that is not a real cloud', () => {
    expect(parseAssistantFilters({ cloudProvider: 'oracle' })).toEqual({});
  });

  it('accepts every real provider', () => {
    for (const provider of ['aws', 'azure', 'gcp', 'snowflake']) {
      expect(parseAssistantFilters({ cloudProvider: provider })).toEqual({ cloudProvider: provider });
    }
  });

  it('rejects a date that is not YYYY-MM-DD', () => {
    expect(parseAssistantFilters({ dateFrom: 'last tuesday', dateTo: '2026-08-31' })).toEqual({
      dateTo: '2026-08-31',
    });
  });

  it('rejects a cost that is not a finite number', () => {
    expect(parseAssistantFilters({ costMin: 'a lot', costMax: Infinity })).toEqual({});
  });

  it('keeps a cost of zero, which is a real threshold', () => {
    expect(parseAssistantFilters({ costMin: 0 })).toEqual({ costMin: 0 });
  });

  it('rejects a non-boolean for the zero-cost flag', () => {
    expect(parseAssistantFilters({ excludeZeroCost: 'yes' })).toEqual({});
    expect(parseAssistantFilters({ excludeZeroCost: true })).toEqual({ excludeZeroCost: true });
  });

  it('trims text and drops it when only whitespace', () => {
    expect(parseAssistantFilters({ searchText: '  ec2  ', region: '   ' })).toEqual({ searchText: 'ec2' });
  });

  // A model looping could otherwise emit a megabyte of text into a query.
  it('caps the length of a text filter', () => {
    const parsed = parseAssistantFilters({ searchText: 'x'.repeat(500) });

    expect((parsed.searchText ?? '').length).toBeLessThanOrEqual(200);
  });

  it('accepts a service list of strings and drops non-strings inside it', () => {
    expect(parseAssistantFilters({ serviceNames: ['Amazon EC2', 42, 'Amazon S3'] })).toEqual({
      serviceNames: ['Amazon EC2', 'Amazon S3'],
    });
  });

  it('drops an empty service list rather than matching nothing', () => {
    expect(parseAssistantFilters({ serviceNames: [] })).toEqual({});
  });

  it('survives a null or non-object payload instead of throwing', () => {
    expect(parseAssistantFilters(null)).toEqual({});
    expect(parseAssistantFilters('nope')).toEqual({});
    expect(parseAssistantFilters([1, 2])).toEqual({});
  });
});

describe('ASSISTANT_FILTER_PROPERTIES', () => {
  // The schema handed to the model and the parser that validates its reply
  // have to describe the same filters, or the model is told about a field
  // that gets silently discarded.
  it('describes exactly the filters the parser accepts', () => {
    expect(Object.keys(ASSISTANT_FILTER_PROPERTIES).sort()).toEqual([
      'accountId',
      'billingCode',
      'cloudProvider',
      'costMax',
      'costMin',
      'dateFrom',
      'dateTo',
      'excludeZeroCost',
      'region',
      'searchText',
      'serviceNames',
    ]);
  });

  it('does not offer the model a period or company field', () => {
    expect(ASSISTANT_FILTER_PROPERTIES).not.toHaveProperty('periodId');
    expect(ASSISTANT_FILTER_PROPERTIES).not.toHaveProperty('companyId');
  });
});

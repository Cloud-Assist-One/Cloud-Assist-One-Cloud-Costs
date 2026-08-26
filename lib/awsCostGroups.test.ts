import { isTagGroupingRejection, mapCostGroupsToRows, splitTagGroupKey } from './awsCostGroups';

type Results = Parameters<typeof mapCostGroupsToRows>[0];

function day(date: string, groups: { keys: string[]; amount: string }[]): Results[number] {
  return {
    TimePeriod: { Start: date, End: date },
    Groups: groups.map((g) => ({ Keys: g.keys, Metrics: { UnblendedCost: { Amount: g.amount, Unit: 'USD' } } })),
  };
}

describe('splitTagGroupKey', () => {
  it('splits Cost Explorer\'s "TagKey$TagValue" form', () => {
    expect(splitTagGroupKey('BillingCode$CC-1234')).toEqual({ key: 'BillingCode', value: 'CC-1234' });
  });

  it('reads untagged spend as an empty value', () => {
    expect(splitTagGroupKey('BillingCode$')).toEqual({ key: 'BillingCode', value: '' });
  });

  it('keeps a dollar sign that is part of the value', () => {
    expect(splitTagGroupKey('BillingCode$a$b')).toEqual({ key: 'BillingCode', value: 'a$b' });
  });
});

describe('mapCostGroupsToRows', () => {
  it('reads service, date and cost with no tag configured', () => {
    const rows = mapCostGroupsToRows([day('2026-08-01', [{ keys: ['Amazon EC2'], amount: '12.5' }])], '');

    expect(rows).toEqual([{ service_name: 'Amazon EC2', usage_date: '2026-08-01', cost: 12.5 }]);
  });

  it('attaches the billing code from the second group key', () => {
    const rows = mapCostGroupsToRows(
      [day('2026-08-01', [{ keys: ['Amazon EC2', 'Billing Code$CC-1234'], amount: '12.5' }])],
      'Billing Code'
    );

    expect(rows[0].tags).toEqual({ 'Billing Code': 'CC-1234' });
  });

  it('keeps untagged spend, with no tag rather than a blank one', () => {
    const rows = mapCostGroupsToRows(
      [
        day('2026-08-01', [
          { keys: ['Amazon EC2', 'Billing Code$CC-1'], amount: '10' },
          { keys: ['Amazon EC2', 'Billing Code$'], amount: '4' },
        ]),
      ],
      'Billing Code'
    );

    // Dropping the untagged row would under-report the month's total.
    expect(rows).toHaveLength(2);
    expect(rows[1].cost).toBe(4);
    // Null, not {'Billing Code': ''} — the grid renders null as an em dash.
    expect(rows[1].tags).toBeNull();
  });

  it('produces a row per service and tag pair', () => {
    const rows = mapCostGroupsToRows(
      [
        day('2026-08-01', [
          { keys: ['Amazon EC2', 'Billing Code$CC-1'], amount: '10' },
          { keys: ['Amazon EC2', 'Billing Code$CC-2'], amount: '5' },
          { keys: ['Amazon S3', 'Billing Code$CC-1'], amount: '1' },
        ]),
      ],
      'Billing Code'
    );

    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.cost)).toEqual([10, 5, 1]);
  });

  it('skips groups with no amount rather than writing NaN', () => {
    const rows = mapCostGroupsToRows(
      [{ TimePeriod: { Start: '2026-08-01', End: '2026-08-01' }, Groups: [{ Keys: ['Amazon EC2'], Metrics: {} }] }],
      ''
    );

    expect(rows).toEqual([]);
  });

  it('skips a day with no start date', () => {
    expect(mapCostGroupsToRows([{ Groups: [{ Keys: ['EC2'], Metrics: { UnblendedCost: { Amount: '1' } } }] }], '')).toEqual(
      []
    );
  });
});

describe('isTagGroupingRejection', () => {
  function validationError(message: string) {
    const err = new Error(message);
    err.name = 'ValidationException';
    return err;
  }

  it('recognises a validation error naming the tag', () => {
    expect(isTagGroupingRejection(validationError('Invalid group by key: Billing Code'), 'Billing Code')).toBe(true);
  });

  it('recognises the cost allocation tag wording', () => {
    expect(
      isTagGroupingRejection(validationError('The tag is not an active cost allocation tag'), 'Billing Code')
    ).toBe(true);
  });

  it('does not treat a permission error as a tag problem', () => {
    const err = new Error('User is not authorized to perform ce:GetCostAndUsage');
    err.name = 'AccessDeniedException';
    // Retrying this without the tag would hide a real permissions failure
    // behind a warning about tags.
    expect(isTagGroupingRejection(err, 'Billing Code')).toBe(false);
  });

  it('does not treat throttling as a tag problem', () => {
    const err = new Error('Rate exceeded');
    err.name = 'ThrottlingException';
    expect(isTagGroupingRejection(err, 'Billing Code')).toBe(false);
  });

  it('is never true when no tag is configured', () => {
    expect(isTagGroupingRejection(validationError('Invalid group by key'), '')).toBe(false);
  });

  it('does not match a tag name that is merely a substring of another word', () => {
    expect(isTagGroupingRejection(validationError('Invalid key: CostCentre'), 'Cost')).toBe(false);
  });
});

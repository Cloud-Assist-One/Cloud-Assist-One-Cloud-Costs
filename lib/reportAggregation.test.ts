import { aggregateByDate, aggregateByService, totalCost } from './reportAggregation';

const records = [
  { service_name: 'Amazon EC2', usage_date: '2026-07-01', cost: 10 },
  { service_name: 'Amazon EC2', usage_date: '2026-07-02', cost: 5 },
  { service_name: 'Amazon S3', usage_date: '2026-07-01', cost: 2 },
];

describe('aggregateByDate', () => {
  it('sums cost per date and sorts ascending', () => {
    expect(aggregateByDate(records)).toEqual([
      { date: '2026-07-01', total: 12 },
      { date: '2026-07-02', total: 5 },
    ]);
  });

  it('returns an empty array for no records', () => {
    expect(aggregateByDate([])).toEqual([]);
  });
});

describe('aggregateByService', () => {
  it('sums cost per service and sorts descending by total', () => {
    expect(aggregateByService(records)).toEqual([
      { service_name: 'Amazon EC2', total: 15 },
      { service_name: 'Amazon S3', total: 2 },
    ]);
  });
});

describe('totalCost', () => {
  it('sums the cost of every record', () => {
    expect(totalCost(records)).toBe(17);
  });

  it('returns 0 for no records', () => {
    expect(totalCost([])).toBe(0);
  });
});

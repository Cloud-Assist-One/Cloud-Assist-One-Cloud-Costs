import { aggregateByCategoryComparison, aggregateByDate, aggregateByService, totalCost } from './reportAggregation';

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

describe('aggregateByCategoryComparison', () => {
  const categorize = (serviceName: string) => (serviceName.includes('EC2') || serviceName.includes('App Service') ? 'Compute' : 'Storage');

  it('sums cost per category, split by cloud provider', () => {
    const mixedRecords = [
      { service_name: 'Amazon EC2', cloud_provider: 'aws' as const, cost: 10 },
      { service_name: 'Azure App Service', cloud_provider: 'azure' as const, cost: 8 },
      { service_name: 'Amazon S3', cloud_provider: 'aws' as const, cost: 3 },
      { service_name: 'Compute Engine', cloud_provider: 'gcp' as const, cost: 6 },
    ];
    const categorizeWithCompute = (serviceName: string) =>
      serviceName.includes('EC2') || serviceName.includes('App Service') || serviceName.includes('Compute Engine')
        ? 'Compute'
        : 'Storage';

    expect(aggregateByCategoryComparison(mixedRecords, categorizeWithCompute)).toEqual([
      { category: 'Compute', aws: 10, azure: 8, gcp: 6 },
      { category: 'Storage', aws: 3, azure: 0, gcp: 0 },
    ]);
  });

  it('returns an empty array for no records', () => {
    expect(aggregateByCategoryComparison([], categorize)).toEqual([]);
  });
});

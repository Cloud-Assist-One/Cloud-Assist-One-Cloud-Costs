export interface AggregatableCostRecord {
  service_name: string;
  usage_date: string;
  cost: number;
}

export interface CostByDate {
  date: string;
  total: number;
}

export interface CostByService {
  service_name: string;
  total: number;
}

export function aggregateByDate(records: AggregatableCostRecord[]): CostByDate[] {
  const totals = new Map<string, number>();
  for (const record of records) {
    totals.set(record.usage_date, (totals.get(record.usage_date) ?? 0) + record.cost);
  }
  return Array.from(totals.entries())
    .map(([date, total]) => ({ date, total }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export function aggregateByService(records: AggregatableCostRecord[]): CostByService[] {
  const totals = new Map<string, number>();
  for (const record of records) {
    totals.set(record.service_name, (totals.get(record.service_name) ?? 0) + record.cost);
  }
  return Array.from(totals.entries())
    .map(([service_name, total]) => ({ service_name, total }))
    .sort((a, b) => b.total - a.total);
}

export function totalCost(records: AggregatableCostRecord[]): number {
  return records.reduce((sum, record) => sum + record.cost, 0);
}

export interface CategoryComparisonRow {
  category: string;
  aws: number;
  azure: number;
  gcp: number;
}

export interface CategorizableCostRecord {
  service_name: string;
  cloud_provider: 'aws' | 'azure' | 'gcp';
  cost: number;
}

export function aggregateByCategoryComparison(
  records: CategorizableCostRecord[],
  categorize: (serviceName: string) => string
): CategoryComparisonRow[] {
  const totals = new Map<string, { aws: number; azure: number; gcp: number }>();
  for (const record of records) {
    const category = categorize(record.service_name);
    const entry = totals.get(category) ?? { aws: 0, azure: 0, gcp: 0 };
    entry[record.cloud_provider] += record.cost;
    totals.set(category, entry);
  }
  return Array.from(totals.entries())
    .map(([category, { aws, azure, gcp }]) => ({ category, aws, azure, gcp }))
    .sort((a, b) => b.aws + b.azure + b.gcp - (a.aws + a.azure + a.gcp));
}

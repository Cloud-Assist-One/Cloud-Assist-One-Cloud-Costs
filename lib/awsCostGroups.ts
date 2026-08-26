import type { GetCostAndUsageCommandOutput } from '@aws-sdk/client-cost-explorer';
import type { PulledCostRow } from '@/lib/pullBillingPersist';

type ResultsByTime = NonNullable<GetCostAndUsageCommandOutput['ResultsByTime']>;

/**
 * Cost Explorer returns a tag group key as "TagKey$TagValue", with an empty
 * value for spend that carries no such tag. Splitting on the first `$` keeps
 * values that contain one themselves.
 */
export function splitTagGroupKey(groupKey: string): { key: string; value: string } {
  const separator = groupKey.indexOf('$');
  if (separator === -1) return { key: groupKey, value: '' };
  return { key: groupKey.slice(0, separator), value: groupKey.slice(separator + 1) };
}

/**
 * Flattens a Cost Explorer response into rows.
 *
 * With a tag key configured the request groups by SERVICE *and* that tag, so
 * a day yields one row per service/tag pair rather than one per service.
 * Untagged spend still gets its row -- dropping it would quietly under-report
 * the month, which is worse than a row with no billing code.
 */
export function mapCostGroupsToRows(resultsByTime: ResultsByTime, tagKey: string): PulledCostRow[] {
  const rows: PulledCostRow[] = [];

  for (const result of resultsByTime) {
    const usageDate = result.TimePeriod?.Start;
    if (!usageDate) continue;

    for (const group of result.Groups ?? []) {
      const serviceName = group.Keys?.[0];
      const amount = group.Metrics?.UnblendedCost?.Amount;
      if (!serviceName || amount === undefined) continue;

      const row: PulledCostRow = { service_name: serviceName, usage_date: usageDate, cost: Number(amount) };

      if (tagKey) {
        const secondKey = group.Keys?.[1];
        const tagValue = secondKey === undefined ? '' : splitTagGroupKey(secondKey).value;
        // Null rather than an empty-string tag: the Line Items grid renders a
        // missing billing code as an em dash, and `{ "Billing Code": "" }`
        // would render as blank instead.
        row.tags = tagValue ? { [tagKey]: tagValue } : null;
      }

      rows.push(row);
    }
  }

  return rows;
}

/**
 * True when Cost Explorer rejected the request because of the tag grouping.
 *
 * A tag must be activated as a cost allocation tag in Billing before Cost
 * Explorer will group by it, and that is separate from the tag existing on
 * resources -- so a connection whose tag key works fine on the Resources tab
 * can still be rejected here. Detected narrowly: the error has to look like a
 * validation failure *and* name the tag, so an unrelated 403 or throttle is
 * never mistaken for one and retried without the grouping.
 */
export function isTagGroupingRejection(err: unknown, tagKey: string): boolean {
  if (!tagKey) return false;
  const name = err instanceof Error ? err.name : '';
  const message = err instanceof Error ? err.message : String(err);

  const looksLikeValidation = /ValidationException|DataUnavailableException|InvalidParameter/i.test(
    `${name} ${message}`
  );
  if (!looksLikeValidation) return false;

  const escaped = tagKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const namesTheTag = new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(message);
  return namesTheTag || /cost allocation tag/i.test(message);
}

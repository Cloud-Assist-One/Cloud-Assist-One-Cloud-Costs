import type { SupabaseClient } from '@supabase/supabase-js';
import type { CloudProvider } from './types';

export type ResourceCostMap = Map<string, number>;

// Supabase caps an .in() filter well before this, and a URL built from
// hundreds of full Azure resource IDs gets long fast. Chunking keeps each
// request comfortably sized.
const ID_CHUNK_SIZE = 200;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

/**
 * Bills-back the resources a leakage rule flagged.
 *
 * Azure's Cost Management export lowercases resource IDs while the ARM SDK
 * returns them cased, so every ID is queried in both spellings and the map
 * is keyed lowercase.
 */
export async function fetchCostsForResources(
  supabase: SupabaseClient,
  periodId: string | null,
  cloudProvider: CloudProvider,
  resourceIds: readonly string[]
): Promise<ResourceCostMap> {
  const costs: ResourceCostMap = new Map();
  if (!periodId || resourceIds.length === 0) return costs;

  const candidates = [...new Set(resourceIds.flatMap((id) => [id, id.toLowerCase()]))];

  for (const batch of chunk(candidates, ID_CHUNK_SIZE)) {
    const { data, error } = await supabase
      .from('cost_records')
      .select('resource_id, cost')
      .eq('period_id', periodId)
      .eq('cloud_provider', cloudProvider)
      .in('resource_id', batch);

    if (error) throw new Error(error.message);

    for (const row of (data ?? []) as { resource_id: string | null; cost: number | null }[]) {
      if (!row.resource_id) continue;
      const key = row.resource_id.toLowerCase();
      costs.set(key, (costs.get(key) ?? 0) + Number(row.cost ?? 0));
    }
  }

  return costs;
}

// A miss is null, never 0 — "we have no billing row for this" and "this
// costs nothing" lead to opposite decisions about whether to delete it.
export function lookupCost(costs: ResourceCostMap, resourceId: string): number | null {
  const value = costs.get(resourceId.toLowerCase());
  return value === undefined ? null : value;
}

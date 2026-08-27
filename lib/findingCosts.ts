import type { SupabaseClient } from '@supabase/supabase-js';
import type { CloudProvider } from './types';

export type ResourceCostMap = Map<string, number>;

// Each id contributes up to 3 OR-terms (see buildOrFilter below), and a
// synthesized clause plus a real ARN both stay well under Postgres's row
// filter limits at this width. Chunking at 60 ids (<=180 terms) keeps the
// resulting `.or()` string comfortably under typical proxy/URL length
// limits, which matter more here than they did for the old `.in()` shape
// because every id now expands into several terms instead of one.
const ID_CHUNK_SIZE = 60;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

// The segment after the last '/', or failing that the last ':', or failing
// that the whole string. This is how a full ARN's or Azure resource ID's
// bare resource name is recovered for suffix matching.
function bareId(id: string): string {
  const afterSlash = id.slice(id.lastIndexOf('/') + 1);
  if (afterSlash !== id) return afterSlash;
  const afterColon = id.slice(id.lastIndexOf(':') + 1);
  return afterColon;
}

// Supabase/PostgREST's .or() filter syntax uses ',' '(' ')' as structural
// characters. An id containing any of them can't be safely interpolated
// into an .or() term, so it's skipped rather than risking a malformed
// filter (which PostgREST would reject, failing the whole query for every
// other resource in the chunk too). Cloud resource ids do not normally
// contain these characters.
const UNSAFE_OR_CHARS = /[,()]/;

// '_' and '%' are LIKE/ILIKE wildcards, not literal characters, and Azure
// resource names permit '_'. A bare id containing either would make the
// ilike.%/${bare} suffix term match more than intended (e.g. "my_disk"
// matching a billing row for "my-disk"), so the ilike term is dropped for
// that id while the exact-match eq terms -- which are not wildcard-parsed
// -- still apply.
const LIKE_WILDCARD_CHARS = /[_%]/;

/**
 * Bills-back the resources a leakage rule flagged.
 *
 * Billing rows are not spelled consistently: an uploaded Cost and Usage
 * Report writes a resource's full ARN, while other exports (and the ids
 * this route synthesizes, which can't include the account-ID segment of a
 * real ARN) write just the bare id. So each candidate id is matched up to
 * three ways: exact full id, exact bare id, and "ends with /bareId" (to
 * catch a billing row that stored the full ARN while the finding only
 * carries the bare id, or vice versa) -- the third only when the bare id
 * has no LIKE wildcard character, see LIKE_WILDCARD_CHARS below. Azure's
 * Cost Management export also lowercases
 * resource IDs while the ARM SDK returns them cased, so matching is
 * case-insensitive throughout (ilike for the suffix; eq relies on the
 * caller pre-lowercasing everywhere applicable — see the keying below).
 */
export async function fetchCostsForResources(
  supabase: SupabaseClient,
  periodId: string | null,
  cloudProvider: CloudProvider,
  companyId: string,
  resourceIds: readonly string[]
): Promise<ResourceCostMap> {
  const costs: ResourceCostMap = new Map();
  if (!periodId || resourceIds.length === 0) return costs;

  const candidates = [...new Set(resourceIds)].filter((id) => id.length > 0);

  for (const batch of chunk(candidates, ID_CHUNK_SIZE)) {
    const terms: string[] = [];
    for (const id of batch) {
      const bare = bareId(id);
      // Skip defensively: an id with a comma or parenthesis would corrupt
      // the shared .or() string for the whole batch, not just itself.
      if (UNSAFE_OR_CHARS.test(id) || UNSAFE_OR_CHARS.test(bare)) continue;
      terms.push(`resource_id.eq.${id}`, `resource_id.eq.${bare}`);
      // Omit the wildcard-unsafe suffix term rather than let '_'/'%' in the
      // bare id match unintended rows -- the two eq terms above still catch
      // an exact match either way.
      if (!LIKE_WILDCARD_CHARS.test(bare)) {
        terms.push(`resource_id.ilike.%/${bare}`);
      }
    }

    if (terms.length === 0) continue;

    const { data, error } = await supabase
      .from('cost_records')
      .select('resource_id, cost')
      .eq('period_id', periodId)
      .eq('cloud_provider', cloudProvider)
      // Scopes the join to the caller's own company so a client cannot pass
      // another company's periodId and have that company's billed costs
      // joined onto their findings. periodId arrives as an unvalidated query
      // parameter and this route runs on the service-role client, so RLS
      // does not enforce this -- it has to be explicit here.
      .eq('company_id', companyId)
      .or(terms.join(','));

    if (error) throw new Error(error.message);

    for (const row of (data ?? []) as { resource_id: string | null; cost: number }[]) {
      if (!row.resource_id) continue;
      const amount = Number(row.cost);
      // A non-numeric value would otherwise become NaN here and propagate
      // all the way to the rendered $NaN; skip the row instead.
      if (!Number.isFinite(amount)) continue;
      const fullKey = row.resource_id.toLowerCase();
      const bareKey = bareId(row.resource_id).toLowerCase();
      // Index under both spellings so lookupCost can hit on either the
      // finding's full id or its bare suffix.
      costs.set(fullKey, (costs.get(fullKey) ?? 0) + amount);
      if (bareKey !== fullKey) {
        costs.set(bareKey, (costs.get(bareKey) ?? 0) + amount);
      }
    }
  }

  return costs;
}

// A miss is null, never 0 — "we have no billing row for this" and "this
// costs nothing" lead to opposite decisions about whether to delete it.
// Tries the full id first, then its bare suffix, so a finding carrying a
// full ARN still matches a billing row keyed by the bare id and vice versa.
export function lookupCost(costs: ResourceCostMap, resourceId: string): number | null {
  const fullValue = costs.get(resourceId.toLowerCase());
  if (fullValue !== undefined) return fullValue;

  const bareValue = costs.get(bareId(resourceId).toLowerCase());
  return bareValue === undefined ? null : bareValue;
}

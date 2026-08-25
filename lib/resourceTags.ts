// Cloud providers return tags in different shapes depending on which
// service (or provider) you ask, so every resource route funnels its raw
// tag payload through here rather than each fetcher re-deriving the
// difference:
//   [{ Key, Value }]  AWS EC2, RDS, DynamoDB, S3, IAM
//   [{ key, value }]  AWS ECS
//   { key: value }    AWS Lambda, API Gateway; Azure ARM resources (.tags)
type TagEntry = { Key?: unknown; Value?: unknown; key?: unknown; value?: unknown };

export type ResourceTags = readonly TagEntry[] | Record<string, unknown> | null | undefined;

export function tagValue(tags: ResourceTags, tagKey: string): string | null {
  // A blank tagKey means the connection has no tag configured. Bailing here
  // also stops '' from matching a tag whose key is literally empty.
  if (!tagKey || !tags) return null;

  const wanted = tagKey.toLowerCase();
  const asString = (candidate: unknown) => (typeof candidate === 'string' ? candidate : null);

  // A single pass for one "does this key match" rule. A key match whose
  // value isn't a string (e.g. null) doesn't stop the scan — a later entry
  // may still hold a real, well-formed value for the same key.
  function scan(matches: (candidate: unknown) => boolean): string | null {
    if (Array.isArray(tags)) {
      for (const entry of tags) {
        if (!entry || typeof entry !== 'object') continue;
        if (matches(entry.Key)) {
          const value = asString(entry.Value);
          if (value !== null) return value;
        }
        if (matches(entry.key)) {
          const value = asString(entry.value);
          if (value !== null) return value;
        }
      }
      return null;
    }
    for (const [key, value] of Object.entries(tags as Record<string, unknown>)) {
      if (matches(key)) {
        const stringValue = asString(value);
        if (stringValue !== null) return stringValue;
      }
    }
    return null;
  }

  // AWS tag keys are case-sensitive, so 'CostCenter' and 'costcenter' can
  // coexist on the same resource — do one exact-case pass first...
  const exactResult = scan((candidate) => candidate === tagKey);
  if (exactResult !== null) return exactResult;

  // ...then fall back to a case-insensitive pass, since clients are also
  // inconsistent about costcenter/CostCenter/COSTCENTER across accounts,
  // and treating that as "missing data" would be worse than a loose match.
  return scan((candidate) => typeof candidate === 'string' && candidate.toLowerCase() === wanted);
}

// AWS and Azure both permit Unicode letters/numbers (not just ASCII \w) in
// a tag key, plus spaces and + - = . _ : / @, up to 128 characters.
// Rejecting anything else here means a typo surfaces on the settings form
// rather than as a silently empty column later. Both provider settings
// routes used to keep byte-identical copies of this pattern and its reader
// — sharing them here means they can't drift out of sync again.
export const TAG_KEY_PATTERN = /^[\p{L}\p{N} _.:/=+\-@]{1,128}$/u;

export function readTagKey(value: unknown): { ok: true; tagKey: string } | { ok: false } {
  // An absent or blank tag key is valid — it just switches the column off.
  if (value === undefined || value === null || value === '') return { ok: true, tagKey: '' };
  if (typeof value !== 'string') return { ok: false };
  const trimmed = value.trim();
  if (!trimmed) return { ok: true, tagKey: '' };
  if (!TAG_KEY_PATTERN.test(trimmed)) return { ok: false };
  return { ok: true, tagKey: trimmed };
}

export type TagLookupResult = { ok: true; value: string | null } | { ok: false };

// A missing tag permission or a throttled call on one resource must not
// blank that resource's whole row, but it also must not be indistinguishable
// from "this resource just has no such tag" — the two used to both collapse
// to null. Callers can now tell them apart via `ok`, and count `ok: false`
// results to warn the user that some tag values may be wrong rather than
// merely absent.
export async function lookupTag(
  tagKey: string,
  fetchTagValue: () => Promise<string | null>
): Promise<TagLookupResult> {
  if (!tagKey) return { ok: true, value: null };
  try {
    return { ok: true, value: await fetchTagValue() };
  } catch {
    return { ok: false };
  }
}

// Every AWS resource fetcher that does per-resource tag lookups (Lambda,
// DynamoDB, S3, IAM users) needs to surface the same warning shape when
// some of those lookups fail, so it lives here instead of being
// re-worded at each call site.
export function tagFailureWarning(failures: number, total: number): string | null {
  if (failures <= 0) return null;
  return `${failures} of ${total} tag lookups failed (throttling or a missing permission); some tag values may be blank.`;
}

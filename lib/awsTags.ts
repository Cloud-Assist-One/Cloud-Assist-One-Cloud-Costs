// AWS returns tags in three different shapes depending on which service you
// ask, so every AWS route funnels its raw tag payload through here rather
// than each fetcher re-deriving the difference:
//   [{ Key, Value }]  EC2, RDS, DynamoDB, S3, IAM
//   [{ key, value }]  ECS
//   { key: value }    Lambda, API Gateway
type TagEntry = { Key?: unknown; Value?: unknown; key?: unknown; value?: unknown };

export type AwsTags = readonly TagEntry[] | Record<string, unknown> | null | undefined;

export function tagValue(tags: AwsTags, tagKey: string): string | null {
  // A blank tagKey means the connection has no tag configured. Bailing here
  // also stops '' from matching a tag whose key is literally empty.
  if (!tagKey || !tags) return null;

  const wanted = tagKey.toLowerCase();
  // Clients spell the same tag costcenter/CostCenter/COSTCENTER across
  // accounts; an exact-case match would render those as missing data.
  const matches = (candidate: unknown) =>
    typeof candidate === 'string' && candidate.toLowerCase() === wanted;

  const asString = (candidate: unknown) => (typeof candidate === 'string' ? candidate : null);

  if (Array.isArray(tags)) {
    for (const entry of tags) {
      if (!entry || typeof entry !== 'object') continue;
      if (matches(entry.Key)) return asString(entry.Value);
      if (matches(entry.key)) return asString(entry.value);
    }
    return null;
  }

  for (const [key, value] of Object.entries(tags)) {
    if (matches(key)) return asString(value);
  }
  return null;
}

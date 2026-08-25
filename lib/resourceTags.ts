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

export type ResourceAgeColor = 'orange' | 'blue' | 'green' | null;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// Flags how recently a resource was created, so newly-built infrastructure
// stands out in the Resources grids: orange < 24h, blue < 1 week, green < 1
// month, no color beyond that (or when no creation date is available).
export function getResourceAgeColor(createdAt: string | null | undefined): ResourceAgeColor {
  if (!createdAt) return null;
  const createdMs = new Date(createdAt).getTime();
  if (Number.isNaN(createdMs)) return null;

  const ageMs = Date.now() - createdMs;
  if (ageMs < 0) return null;
  if (ageMs < DAY_MS) return 'orange';
  if (ageMs < 7 * DAY_MS) return 'blue';
  if (ageMs < 30 * DAY_MS) return 'green';
  return null;
}

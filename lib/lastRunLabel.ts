/**
 * How the cost report describes the run that produced the data it is showing.
 *
 * Rendered under the billing month, so a reader can tell a light API pull from
 * a full export import without opening Settings — the two differ in what they
 * can populate, most visibly the per-resource costs on the Cost Leakage tab.
 */

export interface LastRun {
  /** uploaded_files.origin; null on rows written before that column existed. */
  origin: string | null;
  createdAt: string;
}

// Deliberately not exhaustive over a union: origin arrives from the database
// as a plain string, so an unrecognised value has to fall through to the time
// alone rather than being asserted into one of these.
const ORIGIN_LABELS: Record<string, string> = {
  quick_pull: 'Quick pull',
  detail_pull: 'Detail pull',
  upload: 'Uploaded',
};

function formatRunTime(createdAt: string): string | null {
  const at = new Date(createdAt);
  if (Number.isNaN(at.getTime())) return null;

  // UTC, and labelled as such. The alternative is the viewer's local zone,
  // which would have two people reading the same report disagree about when
  // the pull ran.
  return `${at.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
  })} UTC`;
}

export function lastRunLabel(run: LastRun | null): string | null {
  if (!run) return null;

  const at = formatRunTime(run.createdAt);
  // An unusable timestamp makes the whole line meaningless -- "Detail pull ·
  // Invalid Date" is worse than saying nothing.
  if (!at) return null;

  const origin = run.origin ? ORIGIN_LABELS[run.origin] : undefined;
  return origin ? `${origin} · ${at}` : at;
}

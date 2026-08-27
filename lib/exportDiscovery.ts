import type { CloudProvider, CurManifest, ExportRun, RemoteObject } from './types';

const SPREADSHEET_PATTERN = /\.(csv|xlsx|xls)(\.gz)?$/i;
const MANIFEST_PATTERN = /manifest\.json$/i;
// The YYYYMMDD-YYYYMMDD folder both providers put a billing period in.
const DATE_RANGE_SEGMENT = /(?:^|\/)(\d{8})-(\d{8})(?:\/|$)/;

/** "20260801T000000.000Z" or "20260801" -> "2026-08-01". */
export function monthFromCompactDate(value: string): string | null {
  const match = /^(\d{4})(\d{2})\d{2}/.exec(value ?? '');
  return match ? `${match[1]}-${match[2]}-01` : null;
}

function newest(a: RemoteObject, b: RemoteObject): RemoteObject {
  return (b.lastModified ?? '') > (a.lastModified ?? '') ? b : a;
}

/**
 * A bucket listing becomes a list of import units.
 *
 * The manifest reader is injected rather than called directly so that every
 * layout below is testable against a fixture listing, with no cloud account
 * and no network.
 */
export async function discoverRuns(
  provider: CloudProvider,
  objects: readonly RemoteObject[],
  readManifest: (key: string) => Promise<CurManifest | null>
): Promise<ExportRun[]> {
  const sizeByKey = new Map(objects.map((object) => [object.key, object.size]));

  // --- AWS: manifests are authoritative, and name every part of their run ---
  const manifestObjects = provider === 'aws' ? objects.filter((object) => MANIFEST_PATTERN.test(object.key)) : [];

  if (manifestObjects.length > 0) {
    // Newest assembly per month: CUR rewrites the whole month under a new
    // assembly id on each refresh, so importing every one would multiply it.
    const bestByMonth = new Map<string, { object: RemoteObject; manifest: CurManifest }>();

    for (const object of manifestObjects) {
      // One unreadable manifest must not take the other months down with it.
      const manifest = await readManifest(object.key).catch(() => null);
      if (!manifest) continue;

      const month = monthFromCompactDate(manifest.billingPeriod?.start ?? '');
      if (!month) continue;

      const existing = bestByMonth.get(month);
      if (!existing || newest(existing.object, object) === object) {
        bestByMonth.set(month, { object, manifest });
      }
    }

    if (bestByMonth.size > 0) {
      return [...bestByMonth.entries()].map(([month, { object, manifest }]) => ({
        key: object.key,
        etag: object.etag,
        parts: manifest.reportKeys,
        month,
        totalBytes: manifest.reportKeys.reduce((total, key) => total + (sizeByKey.get(key) ?? 0), 0),
      }));
    }
  }

  // --- Date-range folders: Azure's daily exports, and CUR without manifests ---
  const bestByFolder = new Map<string, { object: RemoteObject; month: string }>();

  for (const object of objects) {
    if (!SPREADSHEET_PATTERN.test(object.key)) continue;
    const match = DATE_RANGE_SEGMENT.exec(object.key);
    if (!match) continue;

    const month = monthFromCompactDate(match[1]);
    if (!month) continue;

    // Each daily export is a full month-to-date snapshot, so the newest one
    // is the complete one and the earlier ones are strict subsets of it.
    const existing = bestByFolder.get(month);
    if (!existing || newest(existing.object, object) === object) {
      bestByFolder.set(month, { object, month });
    }
  }

  if (bestByFolder.size > 0) {
    return [...bestByFolder.values()].map(({ object, month }) => ({
      key: object.key,
      etag: object.etag,
      parts: [object.key],
      month,
      totalBytes: object.size,
    }));
  }

  // --- Fallback: files someone dropped in by hand, month read from contents ---
  return objects
    .filter((object) => SPREADSHEET_PATTERN.test(object.key))
    .map((object) => ({
      key: object.key,
      etag: object.etag,
      parts: [object.key],
      month: null,
      totalBytes: object.size,
    }));
}

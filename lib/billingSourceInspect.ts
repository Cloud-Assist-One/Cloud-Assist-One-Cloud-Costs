import { discoverRuns } from './exportDiscovery';
import { gunzipIfNeeded } from './gunzipIfNeeded';
import { describeCostFileColumns, parseCostFile } from './parseCostFile';
import { errorMessage } from './errorMessage';
import type { ObjectStore } from './objectStore';
import type { BillingSourceInspection, CloudProvider, InspectionVerdict, RemoteObject } from './types';

/**
 * Look in a bucket without importing from it.
 *
 * The pull route reports what happened to an import; that is the wrong shape
 * of answer when the question is why an import found nothing, or parsed a
 * file into no rows. Those two failures have completely different causes --
 * a credential, a prefix, a layout, a column name -- and the pull's summary
 * cannot tell them apart because by the time it speaks, it has already
 * committed to importing.
 *
 * So this walks the same path the pull walks (list, discover, download the
 * first part, read the header row) and stops before the first write, then
 * reports each step's own answer. The store is injected, exactly as
 * discoverRuns injects its manifest reader, so every branch below is testable
 * against a fake listing with no cloud account and no network.
 */

/** Newest objects returned to the caller. Enough to recognise a layout, few enough to read. */
const MAX_LISTED_OBJECTS = 25;

/**
 * Bounds the one download this makes. The goal is a header row, so a file too
 * big to sample cheaply is reported as such rather than pulled through the
 * server -- the diagnostic must never be the expensive part of the day.
 */
const MAX_SAMPLE_BYTES = 100 * 1024 * 1024;

const SPREADSHEET_PATTERN = /\.(csv|xlsx|xls)(\.gz)?$/i;

function newestFirst(objects: readonly RemoteObject[]): RemoteObject[] {
  return [...objects].sort((a, b) => (b.lastModified ?? '').localeCompare(a.lastModified ?? ''));
}

export async function inspectBillingSource(
  provider: CloudProvider,
  store: ObjectStore,
  prefix: string
): Promise<BillingSourceInspection> {
  const objects = await store.list(prefix);
  const discovered = await discoverRuns(provider, objects, (key) => store.readManifest(key));
  const sizeByKey = new Map(objects.map((object) => [object.key, object.size]));

  // Newest month first, matching the order the pull would work through them.
  const byNewestMonth = [...discovered].sort((a, b) => (b.month ?? '').localeCompare(a.month ?? ''));
  const runs = byNewestMonth.map((run) => ({
    key: run.key,
    month: run.month,
    partCount: run.parts.length,
    totalBytes: run.totalBytes,
  }));

  const inspection: BillingSourceInspection = {
    prefix,
    objectCount: objects.length,
    totalBytes: objects.reduce((total, object) => total + object.size, 0),
    objects: newestFirst(objects).slice(0, MAX_LISTED_OBJECTS),
    listingTruncated: objects.length > MAX_LISTED_OBJECTS,
    runs,
    sample: null,
    sampleSkipped: null,
  };

  // What to open. The first part of the newest discovered run is exactly what
  // a pull would read first, so sampling anything else would diagnose a file
  // the pull is not going to touch. Only when discovery found nothing does it
  // fall back to the newest spreadsheet-shaped object -- which is the whole
  // point in that case, because "there IS a CSV here and discovery skipped
  // it" is the answer, and it names the file to go look at the prefix with.
  const sampleKey =
    byNewestMonth.length > 0
      ? byNewestMonth[0].parts[0]
      : newestFirst(objects).find((object) => SPREADSHEET_PATTERN.test(object.key))?.key;

  if (!sampleKey) {
    inspection.sampleSkipped =
      objects.length === 0
        ? 'The container has no objects under this prefix, so there was nothing to open.'
        : 'No object here looks like a cost export (.csv, .xlsx or .xls, optionally gzipped), so there was nothing to open.';
    return inspection;
  }

  const sampleBytes = sizeByKey.get(sampleKey) ?? 0;
  if (sampleBytes > MAX_SAMPLE_BYTES) {
    inspection.sampleSkipped = `${sampleKey} is ${Math.round(sampleBytes / (1024 * 1024))} MB, over the ${Math.round(
      MAX_SAMPLE_BYTES / (1024 * 1024)
    )} MB this will download to read a header row. A pull would still import it.`;
    return inspection;
  }

  try {
    const buffer = gunzipIfNeeded(sampleKey, await store.get(sampleKey));
    // Reads the workbook a second time, after parseCostFile below reads it
    // once. Deliberate: the cost is one extra parse of a file already capped
    // at MAX_SAMPLE_BYTES, and the alternative is a parseCostFile that hands
    // back its internals purely so this can avoid it.
    const report = describeCostFileColumns(buffer);
    // Parsed alongside the header report because the two failures look
    // identical from outside: a sheet whose columns all resolved can still
    // yield no rows, and only the row count separates "wrong column names"
    // from "right names, unreadable values".
    const parsed = parseCostFile(buffer);
    const firstRow = parsed.rows[0] ?? null;

    inspection.sample = {
      key: sampleKey,
      byteCount: buffer.byteLength,
      sheetName: report.sheetName,
      headers: report.headers,
      columns: report.columns,
      missingRequired: report.missingRequired,
      tagColumns: report.tagColumns,
      parsedRowCount: parsed.rows.length,
      firstRow: firstRow
        ? { service: firstRow.service_name, date: firstRow.usage_date, cost: firstRow.cost }
        : null,
    };
  } catch (err) {
    // A download or a corrupt workbook must still leave the listing above
    // readable -- that part of the answer is already earned.
    inspection.sampleSkipped = `Could not read ${sampleKey}: ${errorMessage(err)}`;
  }

  return inspection;
}

/**
 * The one sentence someone actually wants back.
 *
 * Every branch below leads with whether the connection worked, because that
 * is the question being asked and it is answered by this function existing at
 * all -- a credential or container problem never reaches here, it comes back
 * from the route as an error. Saying "connected" first is what stops a column
 * problem being read as a permissions problem, which is the exact wrong turn
 * this whole diagnostic exists to prevent.
 */
/** ["Date"] -> "Date"; ["Date","Cost"] -> "Date or Cost"; three -> "a, b or c". */
function joinLabels(labels: readonly string[]): string {
  if (labels.length <= 1) return labels[0] ?? '';
  return `${labels.slice(0, -1).join(', ')} or ${labels[labels.length - 1]}`;
}

export function summariseInspection(inspection: BillingSourceInspection): InspectionVerdict {
  const { objectCount, runs, sample, sampleSkipped, prefix } = inspection;
  const where = prefix ? `under "${prefix}"` : 'in this container';

  if (objectCount === 0) {
    return {
      tone: 'warn',
      headline: `Connected, and the container is empty ${where}.`,
      detail:
        'The credential can read it, so this is a delivery problem rather than an access one: either the export has not run yet, or it writes somewhere other than this prefix.',
    };
  }

  if (!sample) {
    return {
      tone: 'warn',
      headline: `Connected. ${objectCount} object(s) ${where}, but none could be opened.`,
      detail: sampleSkipped ?? 'No file was sampled.',
    };
  }

  if (sample.missingRequired.length > 0) {
    const missing = joinLabels(sample.missingRequired);
    const plural = sample.missingRequired.length > 1 ? 'columns' : 'column';
    return {
      tone: 'problem',
      headline: `Connected, and ${sample.key} downloaded — but it has no ${missing} ${plural}.`,
      detail:
        'The export is being delivered and read; only its column names are unrecognised. The header row below is what the file actually offers, which is what a new alias would have to match.',
    };
  }

  if (sample.parsedRowCount === 0) {
    return {
      tone: 'problem',
      headline: `Connected, and every required column in ${sample.key} resolved — but no row parsed.`,
      detail:
        'Right column names, unreadable values underneath: a blank export, or dates and costs in a form the parser cannot read. The resolved headers below name the columns to go and look at.',
    };
  }

  if (runs.length === 0) {
    return {
      tone: 'warn',
      headline: `Connected, and ${sample.key} parses — but discovery claimed no run from it.`,
      detail: 'A pull would find nothing to import. Check the prefix points at the export folder itself.',
    };
  }

  return {
    tone: 'ok',
    headline: `Connected, and ${sample.key} parses into ${sample.parsedRowCount} row(s).`,
    detail: `${objectCount} object(s) ${where}, forming ${runs.length} import run(s). A pull would work from this bucket.`,
  };
}

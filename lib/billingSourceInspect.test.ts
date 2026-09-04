import { gzipSync } from 'node:zlib';
import { inspectBillingSource, summariseInspection } from './billingSourceInspect';
import type { ObjectStore } from './objectStore';
import type { RemoteObject } from './types';

// A real Azure FOCUS header, trimmed to the columns these tests assert on.
const FOCUS_CSV = [
  'ServiceName,ChargePeriodStart,BilledCost,SubAccountId,x_ResourceGroupName',
  'Virtual Machines,2026-08-03T00:00:00Z,18.40,sub-1,rg-app',
  'Storage,2026-08-03T00:00:00Z,2.10,sub-1,rg-data',
].join('\n');

// What a container looked like before FOCUS was recognised: a perfectly good
// export the parser could not read.
const UNKNOWN_COLUMNS_CSV = ['Widget,When,HowMuch', 'a,b,c'].join('\n');

function object(key: string, overrides: Partial<RemoteObject> = {}): RemoteObject {
  return { key, etag: `etag-${key}`, size: 1024, lastModified: '2026-08-04T00:00:00.000Z', ...overrides };
}

function fakeStore(objects: RemoteObject[], contents: Record<string, Buffer | string> = {}): ObjectStore {
  return {
    list: async () => objects,
    get: async (key: string) => {
      const body = contents[key];
      if (body === undefined) throw new Error(`no such blob: ${key}`);
      return Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
    },
    readManifest: async () => null,
  };
}

// Azure writes each daily export into a YYYYMMDD-YYYYMMDD folder, which is
// how discovery dates a container that ships no manifest.
const AZURE_KEY = 'exports/daily/20260801-20260831/part_0_0001.csv';

describe('inspectBillingSource', () => {
  it('reports a healthy Azure container: the run discovery found and the columns it resolved', async () => {
    const store = fakeStore([object(AZURE_KEY)], { [AZURE_KEY]: FOCUS_CSV });

    const result = await inspectBillingSource('azure', store, 'exports/daily');

    expect(result.objectCount).toBe(1);
    expect(result.runs).toEqual([
      { key: AZURE_KEY, month: '2026-08-01', partCount: 1, totalBytes: 1024 },
    ]);
    expect(result.sampleSkipped).toBeNull();
    expect(result.sample?.key).toBe(AZURE_KEY);
    expect(result.sample?.missingRequired).toEqual([]);
    expect(result.sample?.parsedRowCount).toBe(2);
    expect(result.sample?.firstRow).toEqual({ service: 'Virtual Machines', date: '2026-08-03', cost: 18.4 });
  });

  it('names the header each field resolved to, so a column matched to the wrong one is visible', async () => {
    const store = fakeStore([object(AZURE_KEY)], { [AZURE_KEY]: FOCUS_CSV });

    const { sample } = await inspectBillingSource('azure', store, '');
    const headerFor = (field: string) => sample?.columns.find((c) => c.field === field)?.header;

    expect(sample?.headers).toContain('ChargePeriodStart');
    expect(headerFor('usage_date')).toBe('ChargePeriodStart');
    expect(headerFor('cost')).toBe('BilledCost');
    expect(headerFor('service_name')).toBe('ServiceName');
    expect(headerFor('resource_group')).toBe('x_ResourceGroupName');
    // Reported as null rather than omitted: "the export has no such column" is
    // an answer, and dropping it would make the list look complete.
    expect(headerFor('instance_type')).toBeNull();
  });

  // The failure that prompted this diagnostic: the pull said only that two
  // columns were missing, and could not say what the file did contain.
  it('shows the header row of a file whose required columns do not resolve', async () => {
    const store = fakeStore([object(AZURE_KEY)], { [AZURE_KEY]: UNKNOWN_COLUMNS_CSV });

    const { sample } = await inspectBillingSource('azure', store, '');

    expect(sample?.missingRequired).toEqual(['Service', 'Date', 'Cost']);
    expect(sample?.headers).toEqual(['Widget', 'When', 'HowMuch']);
    expect(sample?.parsedRowCount).toBe(0);
    expect(sample?.firstRow).toBeNull();
  });

  it('distinguishes an empty container from one holding nothing recognisable', async () => {
    const empty = await inspectBillingSource('azure', fakeStore([]), 'exports/');
    expect(empty.objectCount).toBe(0);
    expect(empty.sampleSkipped).toMatch(/no objects under this prefix/i);

    const wrongFiles = await inspectBillingSource('azure', fakeStore([object('exports/notes.txt')]), 'exports/');
    expect(wrongFiles.objectCount).toBe(1);
    expect(wrongFiles.sampleSkipped).toMatch(/looks like a cost export/i);
    expect(wrongFiles.sample).toBeNull();
  });

  // Discovery skipping a real CSV is the hardest failure to diagnose blind,
  // because the pull reports it as a prefix problem without naming a file.
  it('still opens a spreadsheet discovery did not recognise', async () => {
    const loose = 'exports/august.csv';
    const store = fakeStore([object(loose)], { [loose]: FOCUS_CSV });

    const result = await inspectBillingSource('azure', store, 'exports/');

    // No date-range folder, so the month has to come from the contents later.
    expect(result.runs).toEqual([{ key: loose, month: null, partCount: 1, totalBytes: 1024 }]);
    expect(result.sample?.key).toBe(loose);
    expect(result.sample?.missingRequired).toEqual([]);
  });

  it('samples the newest month, which is the one a pull would import first', async () => {
    const july = 'exports/20260701-20260731/part_0_0001.csv';
    const august = 'exports/20260801-20260831/part_0_0001.csv';
    const store = fakeStore(
      [
        object(july, { lastModified: '2026-07-31T00:00:00.000Z' }),
        object(august, { lastModified: '2026-08-31T00:00:00.000Z' }),
      ],
      { [july]: FOCUS_CSV, [august]: FOCUS_CSV }
    );

    const result = await inspectBillingSource('azure', store, 'exports/');

    expect(result.runs.map((run) => run.month)).toEqual(['2026-08-01', '2026-07-01']);
    expect(result.sample?.key).toBe(august);
  });

  it('reads a gzipped export, and reports the size after decompression', async () => {
    const key = 'exports/20260801-20260831/part_0_0001.csv.gz';
    const gzipped = gzipSync(Buffer.from(FOCUS_CSV, 'utf8'));
    const store = fakeStore([object(key, { size: gzipped.byteLength })], { [key]: gzipped });

    const { sample } = await inspectBillingSource('azure', store, '');

    expect(sample?.parsedRowCount).toBe(2);
    expect(sample?.byteCount).toBe(Buffer.byteLength(FOCUS_CSV, 'utf8'));
  });

  // The diagnostic must never be the expensive part of the day.
  it('refuses to download a file too large to sample, and says so', async () => {
    const key = 'exports/20260801-20260831/huge.csv';
    const get = jest.fn();
    const store: ObjectStore = {
      list: async () => [object(key, { size: 400 * 1024 * 1024 })],
      get,
      readManifest: async () => null,
    };

    const result = await inspectBillingSource('azure', store, '');

    expect(get).not.toHaveBeenCalled();
    expect(result.sample).toBeNull();
    expect(result.sampleSkipped).toMatch(/400 MB, over the 100 MB/);
    // The listing is still an answer, and it was already earned.
    expect(result.runs).toHaveLength(1);
  });

  it('keeps the listing when the sample download fails', async () => {
    const store = fakeStore([object(AZURE_KEY)]); // listed, but get() has no body for it

    const result = await inspectBillingSource('azure', store, '');

    expect(result.objectCount).toBe(1);
    expect(result.runs).toHaveLength(1);
    expect(result.sample).toBeNull();
    expect(result.sampleSkipped).toMatch(/Could not read .*: no such blob/);
  });

  it('caps the object list, newest first, and says when it did', async () => {
    const objects = Array.from({ length: 40 }, (_, i) =>
      object(`exports/file-${String(i).padStart(2, '0')}.csv`, {
        lastModified: `2026-08-${String((i % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
      })
    );

    const result = await inspectBillingSource('azure', fakeStore(objects), 'exports/');

    expect(result.objectCount).toBe(40);
    expect(result.objects).toHaveLength(25);
    expect(result.listingTruncated).toBe(true);
    expect(result.totalBytes).toBe(40 * 1024);
    const dates = result.objects.map((o) => o.lastModified ?? '');
    expect([...dates].sort().reverse()).toEqual(dates);
  });

  // AWS manifests are authoritative, so a manifest-driven run reports every
  // part it would download rather than the one file that names them.
  it('reports an AWS run as its manifest describes it', async () => {
    const manifestKey = 'cur/my-report/20260801-20260901/my-report-Manifest.json';
    const parts = ['cur/my-report/20260801-20260901/abc/part-0.csv.gz', 'cur/my-report/20260801-20260901/abc/part-1.csv.gz'];
    const store: ObjectStore = {
      list: async () => [object(manifestKey), ...parts.map((key) => object(key, { size: 2048 }))],
      // Keys end in .gz, so the bytes have to be too — gunzipIfNeeded goes by
      // the name, and plain text under a .gz key is a corrupt part.
      get: async () => gzipSync(Buffer.from(FOCUS_CSV, 'utf8')),
      readManifest: async () => ({ parts, month: '2026-08-01' }),
    };

    const result = await inspectBillingSource('aws', store, 'cur/');

    expect(result.runs).toEqual([{ key: manifestKey, month: '2026-08-01', partCount: 2, totalBytes: 4096 }]);
    // The first part, not the manifest — the manifest has no header row.
    expect(result.sample?.key).toBe(parts[0]);
  });
});

// Every verdict below leads with "Connected", because reaching this function
// at all means the listing succeeded. A credential or container failure never
// gets here -- it comes back from the route as an error.
describe('summariseInspection', () => {
  async function verdictFor(objects: RemoteObject[], contents: Record<string, Buffer | string> = {}, prefix = '') {
    return summariseInspection(await inspectBillingSource('azure', fakeStore(objects, contents), prefix));
  }

  it('calls a readable, parsing bucket healthy', async () => {
    const verdict = await verdictFor([object(AZURE_KEY)], { [AZURE_KEY]: FOCUS_CSV });

    expect(verdict.tone).toBe('ok');
    expect(verdict.headline).toMatch(/parses into 2 row\(s\)/);
  });

  // The distinction this diagnostic exists to draw. An unreadable column is
  // not a permissions problem, and reading it as one sends people into the
  // Azure portal reassigning roles that were never wrong.
  it('separates a column problem from an access problem in the first sentence', async () => {
    const verdict = await verdictFor([object(AZURE_KEY)], { [AZURE_KEY]: UNKNOWN_COLUMNS_CSV });

    expect(verdict.tone).toBe('problem');
    expect(verdict.headline).toMatch(/^Connected/);
    expect(verdict.headline).toMatch(/no Service, Date or Cost columns/);
    expect(verdict.detail).toMatch(/only its column names are unrecognised/i);
  });

  it('names one missing column in the singular', async () => {
    const noCost = ['Service,Date', 'EC2,2026-08-01'].join('\n');
    const verdict = await verdictFor([object(AZURE_KEY)], { [AZURE_KEY]: noCost });

    expect(verdict.headline).toMatch(/no Cost column\./);
  });

  // Reachable only through AWS: manifests are authoritative, so when none of
  // them can be read discovery returns nothing even though the parts are
  // sitting right there in the listing. Sampling one of those parts is what
  // separates "the credential cannot read the manifest" from "the manifest is
  // in a shape this does not recognise".
  it('flags parts that parse while every manifest describing them failed to read', async () => {
    const part = 'cur/20260801-20260901/abc/part-0.csv';
    const store: ObjectStore = {
      list: async () => [object('cur/my-report-Manifest.json'), object(part)],
      get: async () => Buffer.from(FOCUS_CSV, 'utf8'),
      readManifest: async () => null,
    };

    const inspection = await inspectBillingSource('aws', store, 'cur/');
    const verdict = summariseInspection(inspection);

    expect(inspection.runs).toEqual([]);
    expect(inspection.sample?.key).toBe(part);
    expect(verdict.tone).toBe('warn');
    expect(verdict.headline).toMatch(/parses — but discovery claimed no run from it/);
  });

  it('calls an empty container a delivery problem, not an access one', async () => {
    const verdict = await verdictFor([], {}, 'exports/');

    expect(verdict.tone).toBe('warn');
    expect(verdict.headline).toMatch(/container is empty under "exports\/"/);
    expect(verdict.detail).toMatch(/has not run yet/);
  });

  it('flags a file that resolves every column but yields no row', async () => {
    const headerOnly = 'Service,Date,Cost';
    const verdict = await verdictFor([object(AZURE_KEY)], { [AZURE_KEY]: headerOnly });

    expect(verdict.tone).toBe('problem');
    expect(verdict.headline).toMatch(/every required column .* resolved — but no row parsed/);
  });

  it('reports a container holding nothing openable', async () => {
    const verdict = await verdictFor([object('exports/readme.txt')], {}, 'exports/');

    expect(verdict.tone).toBe('warn');
    expect(verdict.headline).toMatch(/1 object\(s\) under "exports\/", but none could be opened/);
  });
});

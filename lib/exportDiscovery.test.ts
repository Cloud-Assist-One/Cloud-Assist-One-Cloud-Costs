import { discoverRuns, monthFromCompactDate } from './exportDiscovery';
import type { ManifestRun, RemoteObject } from './types';

function obj(key: string, overrides: Partial<RemoteObject> = {}): RemoteObject {
  return { key, etag: `etag-${key}`, size: 1000, lastModified: '2026-08-05T00:00:00.000Z', ...overrides };
}

function manifestReader(manifests: Record<string, ManifestRun>) {
  return async (key: string) => manifests[key] ?? null;
}

const noManifests = manifestReader({});

describe('monthFromCompactDate', () => {
  it('reads a CUR billing period start', () => {
    expect(monthFromCompactDate('20260801T000000.000Z')).toBe('2026-08-01');
  });

  it('reads a bare compact date from an Azure folder', () => {
    expect(monthFromCompactDate('20260801')).toBe('2026-08-01');
  });

  it('returns null for anything else', () => {
    expect(monthFromCompactDate('August 2026')).toBeNull();
    expect(monthFromCompactDate('')).toBeNull();
  });
});

describe('discoverRuns for AWS', () => {
  const manifest: ManifestRun = {
    parts: ['cur/report/20260801-20260901/aaa/report-00001.csv.gz', 'cur/report/20260801-20260901/aaa/report-00002.csv.gz'],
    month: '2026-08-01',
  };

  it('emits one run per manifest, carrying every part', async () => {
    const runs = await discoverRuns(
      'aws',
      [
        obj('cur/report/20260801-20260901/aaa/Manifest.json'),
        obj('cur/report/20260801-20260901/aaa/report-00001.csv.gz'),
        obj('cur/report/20260801-20260901/aaa/report-00002.csv.gz'),
      ],
      manifestReader({ 'cur/report/20260801-20260901/aaa/Manifest.json': manifest })
    );

    expect(runs).toHaveLength(1);
    expect(runs[0].key).toBe('cur/report/20260801-20260901/aaa/Manifest.json');
    expect(runs[0].parts).toEqual(manifest.parts);
    expect(runs[0].month).toBe('2026-08-01');
  });

  // CUR rewrites the whole month under a new assembly id on each refresh.
  // Importing both would double the month.
  it('keeps only the newest assembly when a month has several', async () => {
    const older: ManifestRun = { ...manifest, parts: ['cur/report/20260801-20260901/old/report-00001.csv.gz'] };

    const runs = await discoverRuns(
      'aws',
      [
        obj('cur/report/20260801-20260901/old/Manifest.json', { lastModified: '2026-08-02T00:00:00.000Z' }),
        obj('cur/report/20260801-20260901/aaa/Manifest.json', { lastModified: '2026-08-09T00:00:00.000Z' }),
      ],
      manifestReader({
        'cur/report/20260801-20260901/old/Manifest.json': older,
        'cur/report/20260801-20260901/aaa/Manifest.json': manifest,
      })
    );

    expect(runs).toHaveLength(1);
    expect(runs[0].key).toContain('/aaa/');
  });

  it('emits a run per month when the bucket holds several', async () => {
    const july: ManifestRun = {
      parts: ['cur/report/20260701-20260801/jjj/report-00001.csv.gz'],
      month: '2026-07-01',
    };

    const runs = await discoverRuns(
      'aws',
      [obj('cur/report/20260801-20260901/aaa/Manifest.json'), obj('cur/report/20260701-20260801/jjj/Manifest.json')],
      manifestReader({
        'cur/report/20260801-20260901/aaa/Manifest.json': manifest,
        'cur/report/20260701-20260801/jjj/Manifest.json': july,
      })
    );

    expect(runs.map((run) => run.month).sort()).toEqual(['2026-07-01', '2026-08-01']);
  });

  it('sums the parts it can size, so a caller can enforce a byte cap', async () => {
    const runs = await discoverRuns(
      'aws',
      [
        obj('cur/report/20260801-20260901/aaa/Manifest.json', { size: 500 }),
        obj('cur/report/20260801-20260901/aaa/report-00001.csv.gz', { size: 4000 }),
        obj('cur/report/20260801-20260901/aaa/report-00002.csv.gz', { size: 6000 }),
      ],
      manifestReader({ 'cur/report/20260801-20260901/aaa/Manifest.json': manifest })
    );

    expect(runs[0].totalBytes).toBe(10000);
  });

  // An unreadable manifest must not take the other months down with it.
  it('skips a manifest it cannot read and keeps the rest', async () => {
    const runs = await discoverRuns(
      'aws',
      [obj('cur/report/20260801-20260901/aaa/Manifest.json'), obj('cur/report/20260701-20260801/bad/Manifest.json')],
      manifestReader({ 'cur/report/20260801-20260901/aaa/Manifest.json': manifest })
    );

    expect(runs).toHaveLength(1);
    expect(runs[0].month).toBe('2026-08-01');
  });

  // A narrow s3:GetObject policy can permit the report parts but not
  // Manifest.json. Falling through to the folder branch would then treat one
  // part as a whole month and silently import a fraction of its cost.
  it('discovers nothing rather than mistaking a CUR part for a whole month when no manifest resolves', async () => {
    const runs = await discoverRuns(
      'aws',
      [
        obj('cur/report/20260801-20260901/aaa/Manifest.json'),
        obj('cur/report/20260801-20260901/aaa/report-00001.csv.gz', { size: 4000 }),
        obj('cur/report/20260801-20260901/aaa/report-00002.csv.gz', { size: 6000 }),
      ],
      noManifests
    );

    expect(runs).toEqual([]);
  });
});

// Regression: a real CUR 2.0 bucket reported "no recognisable cost exports".
// The manifest matched by name so the manifest branch took ownership, then
// failed to parse, and the branch returns empty by design -- so the data file,
// which the fallback branch would have accepted, was never reached. Keys are
// from the bucket that hit it.
describe('discoverRuns for a CUR 2.0 (Data Exports) bucket', () => {
  const MANIFEST_KEY = 'daily/cloud-cost-assist/metadata/BILLING_PERIOD=2026-08/cloud-cost-assist-Manifest.json';
  const DATA_KEY = 'daily/cloud-cost-assist/data/BILLING_PERIOD=2026-08/cloud-cost-assist-00001.csv.gz';

  it('emits a run for a bucket whose only objects are a manifest and one part', async () => {
    const runs = await discoverRuns(
      'aws',
      [obj(MANIFEST_KEY), obj(DATA_KEY, { size: 4096 })],
      manifestReader({ [MANIFEST_KEY]: { parts: [DATA_KEY], month: '2026-08-01' } })
    );

    expect(runs).toHaveLength(1);
    expect(runs[0].month).toBe('2026-08-01');
    expect(runs[0].parts).toEqual([DATA_KEY]);
    // Sized from the listing, which only works because the s3:// prefix came
    // off the manifest's dataFiles entry.
    expect(runs[0].totalBytes).toBe(4096);
  });
});

describe('MANIFEST_PATTERN', () => {
  // Real CUR manifests are "<report-name>-Manifest.json" — no path separator
  // before "Manifest.json" at all, just a hyphen.
  it('treats a hyphen-prefixed manifest name as a manifest', async () => {
    const manifest: ManifestRun = { parts: ['report-00001.csv.gz'], month: '2026-08-01' };

    const runs = await discoverRuns('aws', [obj('report-Manifest.json')], manifestReader({ 'report-Manifest.json': manifest }));

    expect(runs).toHaveLength(1);
  });

  // A file that merely ends in "manifest.json" with no "-" or "/" right
  // before it is not a CUR manifest and must not be read as one.
  it('does not treat manifest.json.bak as a manifest', async () => {
    const manifest: ManifestRun = { parts: ['data.csv'], month: '2026-08-01' };

    const runs = await discoverRuns('aws', [obj('manifest.json.bak')], manifestReader({ 'manifest.json.bak': manifest }));

    expect(runs).toEqual([]);
  });
});

describe('discoverRuns for Azure', () => {
  // A scheduled daily export writes a full month-to-date snapshot each day.
  // Importing all of them would import August thirty-one times.
  it('keeps only the newest snapshot in a date-range folder', async () => {
    const runs = await discoverRuns(
      'azure',
      [
        obj('exports/daily/20260801-20260831/cost_1.csv', { lastModified: '2026-08-04T00:00:00.000Z' }),
        obj('exports/daily/20260801-20260831/cost_2.csv', { lastModified: '2026-08-05T00:00:00.000Z' }),
      ],
      noManifests
    );

    expect(runs).toHaveLength(1);
    expect(runs[0].key).toBe('exports/daily/20260801-20260831/cost_2.csv');
    expect(runs[0].parts).toEqual(['exports/daily/20260801-20260831/cost_2.csv']);
    expect(runs[0].month).toBe('2026-08-01');
  });

  it('emits one run per date-range folder', async () => {
    const runs = await discoverRuns(
      'azure',
      [
        obj('exports/daily/20260801-20260831/cost.csv'),
        obj('exports/daily/20260701-20260731/cost.csv'),
      ],
      noManifests
    );

    expect(runs.map((run) => run.month).sort()).toEqual(['2026-07-01', '2026-08-01']);
  });
});

describe('discoverRuns fallback for hand-dropped files', () => {
  it('treats each spreadsheet as its own run with no stated month', async () => {
    const runs = await discoverRuns(
      'aws',
      [obj('august.csv'), obj('july.xlsx')],
      noManifests
    );

    expect(runs).toHaveLength(2);
    expect(runs.every((run) => run.month === null)).toBe(true);
    expect(runs.map((run) => run.parts.length)).toEqual([1, 1]);
  });

  it('ignores objects that are not spreadsheets', async () => {
    const runs = await discoverRuns('aws', [obj('notes.txt'), obj('logo.png'), obj('data.csv')], noManifests);

    expect(runs.map((run) => run.key)).toEqual(['data.csv']);
  });

  it('accepts a gzipped csv', async () => {
    const runs = await discoverRuns('aws', [obj('data.csv.gz')], noManifests);

    expect(runs).toHaveLength(1);
  });

  it('returns nothing for an empty bucket', async () => {
    expect(await discoverRuns('aws', [], noManifests)).toEqual([]);
  });
});

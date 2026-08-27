import { discoverRuns, monthFromCompactDate } from './exportDiscovery';
import type { CurManifest, RemoteObject } from './types';

function obj(key: string, overrides: Partial<RemoteObject> = {}): RemoteObject {
  return { key, etag: `etag-${key}`, size: 1000, lastModified: '2026-08-05T00:00:00.000Z', ...overrides };
}

function manifestReader(manifests: Record<string, CurManifest>) {
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
  const manifest: CurManifest = {
    assemblyId: 'aaa',
    reportKeys: ['cur/report/20260801-20260901/aaa/report-00001.csv.gz', 'cur/report/20260801-20260901/aaa/report-00002.csv.gz'],
    billingPeriod: { start: '20260801T000000.000Z', end: '20260901T000000.000Z' },
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
    expect(runs[0].parts).toEqual(manifest.reportKeys);
    expect(runs[0].month).toBe('2026-08-01');
  });

  // CUR rewrites the whole month under a new assembly id on each refresh.
  // Importing both would double the month.
  it('keeps only the newest assembly when a month has several', async () => {
    const older: CurManifest = { ...manifest, assemblyId: 'old', reportKeys: ['cur/report/20260801-20260901/old/report-00001.csv.gz'] };

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
    const july: CurManifest = {
      assemblyId: 'jjj',
      reportKeys: ['cur/report/20260701-20260801/jjj/report-00001.csv.gz'],
      billingPeriod: { start: '20260701T000000.000Z', end: '20260801T000000.000Z' },
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

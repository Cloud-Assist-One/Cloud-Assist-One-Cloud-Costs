const send = jest.fn();

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send })),
  ListObjectsV2Command: jest.fn((input) => ({ __type: 'list', input })),
  GetObjectCommand: jest.fn((input) => ({ __type: 'get', input })),
}));

import { createS3ObjectStore } from './objectStoreS3';

function store() {
  return createS3ObjectStore({
    accessKeyId: 'AKIA', secretAccessKey: 'secret', region: 'us-east-1', bucket: 'cur-bucket',
  });
}

/** The SDK returns a stream; the store has to buffer it. */
function bodyOf(text: string) {
  return { transformToByteArray: async () => new TextEncoder().encode(text) };
}

describe('createS3ObjectStore', () => {
  beforeEach(() => send.mockReset());

  it('lists objects under the prefix, normalized', async () => {
    send.mockResolvedValueOnce({
      Contents: [{ Key: 'cur/a.csv', ETag: '"abc"', Size: 120, LastModified: new Date('2026-08-05T00:00:00Z') }],
      NextContinuationToken: undefined,
    });

    const objects = await store().list('cur/');

    expect(objects).toEqual([
      { key: 'cur/a.csv', etag: 'abc', size: 120, lastModified: '2026-08-05T00:00:00.000Z' },
    ]);
  });

  // S3 quotes its ETags; the value is stored and compared, so the quotes
  // would otherwise become part of the dedupe key.
  it('strips the quotes S3 wraps around an ETag', async () => {
    send.mockResolvedValueOnce({ Contents: [{ Key: 'a.csv', ETag: '"xyz"', Size: 1 }] });

    expect((await store().list(''))[0].etag).toBe('xyz');
  });

  it('follows pagination to the end', async () => {
    send
      .mockResolvedValueOnce({ Contents: [{ Key: 'a.csv', ETag: '"1"', Size: 1 }], NextContinuationToken: 'more' })
      .mockResolvedValueOnce({ Contents: [{ Key: 'b.csv', ETag: '"2"', Size: 1 }] });

    expect((await store().list('')).map((object) => object.key)).toEqual(['a.csv', 'b.csv']);
  });

  it('downloads an object as a buffer', async () => {
    send.mockResolvedValueOnce({ Body: bodyOf('service,cost\nEC2,10\n') });

    expect((await store().get('a.csv')).toString()).toBe('service,cost\nEC2,10\n');
  });

  it('parses a legacy CUR manifest', async () => {
    const manifest = { assemblyId: 'aaa', reportKeys: ['p1.csv.gz'], billingPeriod: { start: '20260801T000000.000Z', end: '20260901T000000.000Z' } };
    send.mockResolvedValueOnce({ Body: bodyOf(JSON.stringify(manifest)) });

    expect(await store().readManifest('report-Manifest.json')).toEqual({
      parts: ['p1.csv.gz'],
      month: '2026-08-01',
    });
  });

  // CUR 2.0 / Data Exports. Shape taken from a real manifest: no billingPeriod
  // field at all, dataFiles instead of reportKeys, and full s3:// URIs.
  const DATA_EXPORT_KEY = 'daily/cloud-cost-assist/metadata/BILLING_PERIOD=2026-08/cloud-cost-assist-Manifest.json';
  const dataExportManifest = {
    executionId: 'f85c0903-d71d-34e7-a895-dc4a87b5e9b6',
    exportArn: 'arn:aws:bcm-data-exports:us-east-1:123456789012:export/cloud-cost-assist-73037a91',
    columns: [{ name: 'bill_bill_type', type: 'string' }],
    dataFiles: [
      's3://cur-bucket/daily/cloud-cost-assist/data/BILLING_PERIOD=2026-08/cloud-cost-assist-00001.csv.gz',
    ],
    additionalOutputFiles: [],
  };

  it('parses a CUR 2.0 manifest, which names no billing period', async () => {
    send.mockResolvedValueOnce({ Body: bodyOf(JSON.stringify(dataExportManifest)) });

    expect(await store().readManifest(DATA_EXPORT_KEY)).toEqual({
      parts: ['daily/cloud-cost-assist/data/BILLING_PERIOD=2026-08/cloud-cost-assist-00001.csv.gz'],
      // Derived from the key's BILLING_PERIOD segment: the manifest itself
      // carries no date anywhere.
      month: '2026-08-01',
    });
  });

  // The s3:// prefix has to come off or nothing downstream can find the part:
  // the byte-size lookup misses and the part download 404s on a key that
  // never existed.
  it('strips the s3://bucket/ prefix CUR 2.0 puts on every data file', async () => {
    send.mockResolvedValueOnce({ Body: bodyOf(JSON.stringify(dataExportManifest)) });

    const manifest = await store().readManifest(DATA_EXPORT_KEY);

    expect(manifest?.parts[0].startsWith('s3://')).toBe(false);
    expect(manifest?.parts[0]).toBe(
      'daily/cloud-cost-assist/data/BILLING_PERIOD=2026-08/cloud-cost-assist-00001.csv.gz'
    );
  });

  it('returns null for a CUR 2.0 manifest whose key states no billing period', async () => {
    send.mockResolvedValueOnce({ Body: bodyOf(JSON.stringify(dataExportManifest)) });

    expect(await store().readManifest('somewhere/else/cloud-cost-assist-Manifest.json')).toBeNull();
  });

  // An unreadable manifest must skip its month, not abort the whole pull.
  it('returns null for a manifest that is not valid JSON', async () => {
    send.mockResolvedValueOnce({ Body: bodyOf('<html>access denied</html>') });

    expect(await store().readManifest('Manifest.json')).toBeNull();
  });

  it('returns null when the manifest is missing the fields it needs', async () => {
    send.mockResolvedValueOnce({ Body: bodyOf(JSON.stringify({ assemblyId: 'aaa' })) });

    expect(await store().readManifest('Manifest.json')).toBeNull();
  });
});

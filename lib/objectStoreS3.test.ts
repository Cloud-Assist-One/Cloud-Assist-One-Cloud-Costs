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

  it('parses a manifest', async () => {
    const manifest = { assemblyId: 'aaa', reportKeys: ['p1.csv.gz'], billingPeriod: { start: '20260801T000000.000Z', end: '20260901T000000.000Z' } };
    send.mockResolvedValueOnce({ Body: bodyOf(JSON.stringify(manifest)) });

    expect(await store().readManifest('Manifest.json')).toEqual(manifest);
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

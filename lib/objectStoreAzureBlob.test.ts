const listBlobsFlat = jest.fn();
const downloadToBuffer = jest.fn();
const getBlockBlobClient = jest.fn(() => ({ downloadToBuffer }));
const getContainerClient = jest.fn(() => ({ listBlobsFlat, getBlockBlobClient }));

jest.mock('@azure/storage-blob', () => ({
  BlobServiceClient: jest.fn().mockImplementation(() => ({ getContainerClient })),
}));
jest.mock('@azure/identity', () => ({ ClientSecretCredential: jest.fn() }));

import { createAzureBlobObjectStore } from './objectStoreAzureBlob';

function store() {
  return createAzureBlobObjectStore({
    tenantId: 't', clientId: 'c', clientSecret: 's', account: 'acct', container: 'exports',
  });
}

async function* blobs(...items: unknown[]) {
  for (const item of items) yield item;
}

describe('createAzureBlobObjectStore', () => {
  beforeEach(() => {
    listBlobsFlat.mockReset();
    downloadToBuffer.mockReset();
  });

  it('lists blobs under the prefix, normalized', async () => {
    listBlobsFlat.mockReturnValue(
      blobs({
        name: 'exports/daily/20260801-20260831/cost.csv',
        properties: { etag: '"e1"', contentLength: 400, lastModified: new Date('2026-08-05T00:00:00Z') },
      })
    );

    expect(await store().list('exports/')).toEqual([
      {
        key: 'exports/daily/20260801-20260831/cost.csv',
        etag: 'e1',
        size: 400,
        lastModified: '2026-08-05T00:00:00.000Z',
      },
    ]);
  });

  it('passes the prefix to the listing rather than filtering after', async () => {
    listBlobsFlat.mockReturnValue(blobs());

    await store().list('exports/daily/');

    expect(listBlobsFlat).toHaveBeenCalledWith({ prefix: 'exports/daily/' });
  });

  it('downloads a blob as a buffer', async () => {
    downloadToBuffer.mockResolvedValue(Buffer.from('service,cost\n'));

    expect((await store().get('a.csv')).toString()).toBe('service,cost\n');
  });

  // Azure exports have no manifest; discovery uses the date-range folder.
  it('never returns a manifest, since Azure exports do not have one', async () => {
    expect(await store().readManifest('anything')).toBeNull();
  });
});

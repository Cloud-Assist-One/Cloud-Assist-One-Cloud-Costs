import { BlobServiceClient } from '@azure/storage-blob';
import { ClientSecretCredential } from '@azure/identity';
import type { ObjectStore } from './objectStore';
import type { RemoteObject } from './types';

export function createAzureBlobObjectStore(config: {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  account: string;
  container: string;
}): ObjectStore {
  const credential = new ClientSecretCredential(config.tenantId, config.clientId, config.clientSecret);
  const service = new BlobServiceClient(`https://${config.account}.blob.core.windows.net`, credential);
  const container = service.getContainerClient(config.container);

  return {
    async list(prefix: string): Promise<RemoteObject[]> {
      const objects: RemoteObject[] = [];
      // Filtering server-side rather than listing the whole container and
      // discarding: a cost export container can hold years of daily files.
      for await (const blob of container.listBlobsFlat({ prefix: prefix || undefined })) {
        objects.push({
          key: blob.name,
          etag: (blob.properties.etag ?? '').replace(/"/g, ''),
          size: blob.properties.contentLength ?? 0,
          lastModified: blob.properties.lastModified?.toISOString() ?? null,
        });
      }
      return objects;
    },

    async get(key: string): Promise<Buffer> {
      return container.getBlockBlobClient(key).downloadToBuffer();
    },

    // Azure cost exports carry no manifest — discovery reads the month from
    // the YYYYMMDD-YYYYMMDD folder instead.
    async readManifest(): Promise<null> {
      return null;
    },
  };
}

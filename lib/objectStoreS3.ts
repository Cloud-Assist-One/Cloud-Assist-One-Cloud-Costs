import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import { collectPages } from './awsPagination';
import type { ObjectStore } from './objectStore';
import type { CurManifest, RemoteObject } from './types';

export function createS3ObjectStore(config: {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  bucket: string;
}): ObjectStore {
  const client = new S3Client({
    region: config.region,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    // A CUR bucket often sits outside the connection's configured region.
    // Same fix already applied to the S3 tag lookups on the Resources tab.
    followRegionRedirects: true,
  });

  async function download(key: string): Promise<Buffer> {
    const response = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }));
    const body = response.Body as { transformToByteArray: () => Promise<Uint8Array> };
    return Buffer.from(await body.transformToByteArray());
  }

  return {
    async list(prefix: string): Promise<RemoteObject[]> {
      const contents = await collectPages(
        (token) =>
          client.send(
            new ListObjectsV2Command({ Bucket: config.bucket, Prefix: prefix || undefined, ContinuationToken: token })
          ),
        (page) => page.Contents ?? [],
        (page) => page.NextContinuationToken
      );

      return contents.map((object) => ({
        key: object.Key ?? '',
        // S3 quotes its ETags, and the raw value becomes part of the dedupe
        // key, so the quotes have to come off before it is stored.
        etag: (object.ETag ?? '').replace(/"/g, ''),
        size: object.Size ?? 0,
        lastModified: object.LastModified?.toISOString() ?? null,
      }));
    },

    get: download,

    async readManifest(key: string): Promise<CurManifest | null> {
      try {
        const parsed = JSON.parse((await download(key)).toString('utf8')) as Partial<CurManifest>;
        // A truncated or unexpected manifest should skip its month rather than
        // producing a run with no parts and no month.
        if (!Array.isArray(parsed.reportKeys) || !parsed.billingPeriod?.start) return null;
        return parsed as CurManifest;
      } catch {
        return null;
      }
    },
  };
}

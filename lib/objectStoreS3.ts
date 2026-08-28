import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import { collectPages } from './awsPagination';
import { monthFromCompactDate } from './exportDiscovery';
import type { ObjectStore } from './objectStore';
import type { CurManifest, DataExportManifest, ManifestRun, RemoteObject } from './types';

/** "…/BILLING_PERIOD=2026-08/…" -> "2026-08-01". */
const BILLING_PERIOD_SEGMENT = /BILLING_PERIOD=(\d{4})-(\d{2})/i;

// CUR 2.0 lists each part as a full "s3://bucket/key" URI. Everything
// downstream -- the byte-size lookup against the bucket listing, and the
// download of each part -- works in bare keys, so a URI left intact resolves
// to nothing and the part silently disappears from the run.
function bareKey(dataFile: string): string {
  return dataFile.replace(/^s3:\/\/[^/]+\//, '');
}

/**
 * Both AWS manifest generations reduced to the parts and month discovery
 * needs, or null when this one states neither.
 */
function normalizeManifest(key: string, parsed: unknown): ManifestRun | null {
  const manifest = (parsed ?? {}) as Partial<CurManifest> & Partial<DataExportManifest>;

  // Legacy CUR: the manifest names its own billing period.
  if (Array.isArray(manifest.reportKeys) && manifest.billingPeriod?.start) {
    const month = monthFromCompactDate(manifest.billingPeriod.start);
    return month ? { parts: manifest.reportKeys, month } : null;
  }

  // CUR 2.0 / Data Exports: no date in the document at all, so the month can
  // only come from the manifest's own key.
  if (Array.isArray(manifest.dataFiles) && manifest.dataFiles.length > 0) {
    const match = BILLING_PERIOD_SEGMENT.exec(key);
    if (!match) return null;
    return { parts: manifest.dataFiles.map(bareKey), month: `${match[1]}-${match[2]}-01` };
  }

  return null;
}

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

    async readManifest(key: string): Promise<ManifestRun | null> {
      try {
        // A truncated or unrecognised manifest should skip its month rather
        // than producing a run with no parts and no month.
        return normalizeManifest(key, JSON.parse((await download(key)).toString('utf8')));
      } catch {
        return null;
      }
    },
  };
}

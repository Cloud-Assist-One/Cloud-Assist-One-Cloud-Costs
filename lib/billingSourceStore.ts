import { decryptCredentials } from './cloudCredentialsCrypto';
import { errorMessage } from './errorMessage';
import { createS3ObjectStore } from './objectStoreS3';
import { createAzureBlobObjectStore } from './objectStoreAzureBlob';
import type { AzureCredentials } from './azureCostQuery';
import type { ObjectStore } from './objectStore';
import type { CloudProvider } from './types';

/**
 * Turning a stored billing_file_sources row into a live ObjectStore.
 *
 * Shared by the pull route and the inspect route so the two cannot disagree
 * about which container a source points at. That matters more here than it
 * looks: a diagnostic that resolved the container even slightly differently
 * from the pull would happily report a healthy connection to a place the
 * pull never reads.
 */

export type StoreResolution =
  | { ok: true; store: ObjectStore }
  | { ok: false; status: number; error: string };

export { errorMessage };

/** Names the role rather than echoing the SDK, which is the usual cause of a first pull failing. */
export function permissionHint(provider: CloudProvider, err: unknown): string {
  const message = errorMessage(err);
  const status = err as { statusCode?: number; $metadata?: { httpStatusCode?: number } };
  const denied = status?.statusCode === 403 || status?.$metadata?.httpStatusCode === 403;
  if (!denied) return message;

  return provider === 'aws'
    ? `${message} The credential needs s3:ListBucket on the bucket and s3:GetObject on its contents.`
    : `${message} The app registration needs the Storage Blob Data Reader role on the storage account — a data-plane role the Reader and Cost Management Reader roles do not grant.`;
}

export function createStoreForSource(input: {
  provider: CloudProvider;
  /** S3 bucket name, or Azure "account/container". */
  container: string;
  encryptedPayload: string;
  region: string | null;
}): StoreResolution {
  const { provider, container, encryptedPayload, region } = input;

  try {
    if (provider === 'aws') {
      const secrets = decryptCredentials<{ accessKeyId: string; secretAccessKey: string }>(encryptedPayload);
      return {
        ok: true,
        store: createS3ObjectStore({
          accessKeyId: secrets.accessKeyId,
          secretAccessKey: secrets.secretAccessKey,
          region: region ?? 'us-east-1',
          bucket: container,
        }),
      };
    }

    if (provider === 'azure') {
      const secrets = decryptCredentials<AzureCredentials>(encryptedPayload);
      // An Azure container name can never itself contain "/", so anything
      // past the second segment is not a nested path we can safely rejoin —
      // it means the stored value is wrong. Reject rather than silently
      // dropping the extra segments and pointing at the wrong container.
      const containerParts = String(container).split('/');
      if (containerParts.length > 2) {
        return {
          ok: false,
          status: 400,
          error: `The container "${container}" has more than one "/" — expected "account/container".`,
        };
      }
      const [account, containerName] = containerParts;
      return {
        ok: true,
        store: createAzureBlobObjectStore({
          tenantId: secrets.tenantId,
          clientId: secrets.clientId,
          clientSecret: secrets.clientSecret,
          account,
          container: containerName,
        }),
      };
    }

    return { ok: false, status: 400, error: `Pulling from a ${provider} bucket is not supported yet.` };
  } catch (err) {
    console.error('Failed to build the object store:', err);
    return { ok: false, status: 500, error: 'Could not read the stored credentials for this bucket.' };
  }
}

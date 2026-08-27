import { gunzipSync } from 'node:zlib';

/**
 * Cost and Usage Report parts arrive gzipped far more often than not, and the
 * spreadsheet parser cannot see through that. Node's zlib handles it, so no
 * dependency is needed.
 */
export function gunzipIfNeeded(key: string, buffer: Buffer): Buffer {
  if (!key.toLowerCase().endsWith('.gz')) return buffer;

  try {
    return gunzipSync(buffer);
  } catch (err) {
    // Naming the key here is the difference between a fixable report and the
    // parser later failing on binary garbage for no stated reason.
    const message = err instanceof Error ? err.message : 'unknown error';
    throw new Error(`Could not decompress ${key}: ${message}`);
  }
}

import type { CurManifest, RemoteObject } from './types';

/**
 * Listing and downloading, without the pull route knowing which cloud it is
 * talking to. readManifest belongs here because reading a manifest is I/O,
 * which is what lets lib/exportDiscovery.ts stay a pure function.
 */
export interface ObjectStore {
  list(prefix: string): Promise<RemoteObject[]>;
  get(key: string): Promise<Buffer>;
  /** Null when the object is missing, unreadable, or not a manifest. */
  readManifest(key: string): Promise<CurManifest | null>;
}

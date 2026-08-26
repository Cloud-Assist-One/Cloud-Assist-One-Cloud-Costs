import { gunzipSync } from 'node:zlib';
import type { AzureCredentials } from '@/lib/azureCostQuery';

/**
 * Azure Cost Details report generation.
 *
 * Replaces the Cost Management Query API for pulling billing. Query is
 * throttled aggressively -- Microsoft recommends at most one cost query a day
 * -- and three pulls in fifteen minutes was already enough to get a 429. The
 * Cost Details API is the documented path for bulk cost export and returns the
 * full line-item detail (resource id, meter, region, tags, quantity, prices)
 * instead of the two grouping dimensions Query allows.
 *
 * It is asynchronous: POST returns 202 with a Location to poll, and the report
 * is delivered as CSV blobs on short-lived SAS links.
 *
 * Subscription scope with a `timePeriod` works for every agreement type. Only
 * `billingPeriod` (Enterprise Agreement) and `invoiceId` (Microsoft Customer
 * Agreement) are restricted, and this uses neither.
 */

// Pinned rather than tracking "latest": a well-exercised version is worth more
// than the newest one, matching how the Query API version is handled.
const API_VERSION = '2025-03-01';

const REQUEST_TIMEOUT_MS = 60_000;

// Azure documents 429 and 503 as its throttling/backpressure responses, both
// carrying Retry-After.
const THROTTLE_STATUSES = new Set([429, 503]);
const MAX_THROTTLE_RETRIES = 3;

const RETRY_AFTER_HEADERS = ['retry-after', 'x-ms-ratelimit-microsoft.costmanagement-entity-retry-after'];

// Report generation is the slow part. The route allows 300s, so the poll
// budget stays under it with room for the blob downloads and the database
// writes that follow.
const DEFAULT_POLL_BUDGET_MS = 210_000;
const MIN_POLL_WAIT_MS = 2_000;
const MAX_POLL_WAIT_MS = 30_000;
const DEFAULT_POLL_WAIT_MS = 5_000;

export interface CostDetailsBlob {
  blobLink: string;
  byteCount?: number;
}

export interface CostDetailsManifest {
  blobCount?: number;
  blobs?: CostDetailsBlob[];
  compressData?: boolean;
  dataFormat?: string;
}

export interface CostDetailsOperationResult {
  status?: string;
  manifest?: CostDetailsManifest;
  error?: { code?: string; message?: string };
}

export interface FetchCostDetailsOptions {
  fetchImpl?: typeof fetch;
  /** Injectable so tests exercise the polling loop without real waiting. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable so tests can drive the budget deterministically. */
  now?: () => number;
  pollBudgetMs?: number;
}

export interface AzureCostDetailsCsv {
  /** The report's CSV text, with the header row of later blobs removed. */
  csv: string;
  blobCount: number;
  /** NoDataFound is a documented, successful outcome meaning zero charges. */
  status: 'Completed' | 'NoDataFound';
}

type HeaderReader = { get(name: string): string | null };

function retryAfterMsFrom(headers: HeaderReader | undefined): number | null {
  if (!headers) return null;
  for (const name of RETRY_AFTER_HEADERS) {
    const raw = headers.get(name);
    if (!raw) continue;
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  }
  return null;
}

function clampWait(ms: number | null): number {
  if (ms === null) return DEFAULT_POLL_WAIT_MS;
  return Math.min(Math.max(ms, MIN_POLL_WAIT_MS), MAX_POLL_WAIT_MS);
}

function errorTextFrom(body: unknown, fallback: string): string {
  if (body && typeof body === 'object') {
    const error = (body as { error?: { message?: unknown; code?: unknown } }).error;
    if (error && typeof error.message === 'string' && error.message) return error.message;
    if (typeof (body as { message?: unknown }).message === 'string') {
      return (body as { message: string }).message;
    }
  }
  return fallback;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Runs one request, retrying while Azure signals throttling.
 *
 * Unlike the Query API's aggressive per-entity limits, report generation is
 * meant to be called in bulk, so a short bounded backoff is enough here.
 */
async function requestWithThrottleRetry(
  doFetch: () => Promise<Response>,
  sleep: (ms: number) => Promise<void>
): Promise<Response> {
  let attempt = 0;
  for (;;) {
    const response = await doFetch();
    if (!THROTTLE_STATUSES.has(response.status) || attempt >= MAX_THROTTLE_RETRIES) {
      return response;
    }
    const waitMs = clampWait(retryAfterMsFrom(response.headers));
    attempt += 1;
    await sleep(waitMs);
  }
}

/**
 * Strips the header row from every blob after the first.
 *
 * Each blob is a standalone CSV with its own header, so concatenating them
 * raw would leave header rows scattered through the data as if they were
 * charges.
 */
export function concatenateCsvBlobs(parts: string[]): string {
  const usable = parts.map((part) => part.replace(/^﻿/, '').trimEnd()).filter((part) => part.length > 0);
  if (usable.length === 0) return '';

  const [first, ...rest] = usable;
  const tails = rest.map((part) => {
    const newline = part.indexOf('\n');
    return newline === -1 ? '' : part.slice(newline + 1);
  });

  return [first, ...tails.filter((tail) => tail.trim().length > 0)].join('\n');
}

async function downloadBlob(
  blob: CostDetailsBlob,
  compressed: boolean,
  fetchImpl: typeof fetch
): Promise<string> {
  // The blob link is a pre-signed SAS URL, so it carries its own auth and must
  // not be sent the ARM bearer token.
  const response = await fetchImpl(blob.blobLink, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) {
    throw new Error(`Could not download the Azure cost report (HTTP ${response.status}).`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (!compressed) return buffer.toString('utf8');

  try {
    return gunzipSync(buffer).toString('utf8');
  } catch {
    // compressData has been observed to be set while the payload is plain
    // text; falling back beats failing the whole pull.
    return buffer.toString('utf8');
  }
}

export async function getAzureManagementToken(
  credentials: AzureCredentials,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  const response = await fetchImpl(
    `https://login.microsoftonline.com/${credentials.tenantId}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        scope: 'https://management.azure.com/.default',
      }).toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }
  );

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(errorTextFrom(body, `Could not obtain an Azure access token (HTTP ${response.status}).`));
  }

  const accessToken = (body as Record<string, unknown> | null)?.access_token;
  if (typeof accessToken !== 'string' || accessToken === '') {
    throw new Error('Azure returned no access token.');
  }
  return accessToken;
}

/**
 * Requests a cost details report for one month and returns its CSV.
 *
 * `end` is inclusive, which is what the API expects -- callers holding an
 * exclusive range end must subtract a day before calling.
 */
export async function fetchAzureCostDetailsCsv(
  credentials: AzureCredentials,
  start: string,
  end: string,
  options: FetchCostDetailsOptions = {}
): Promise<AzureCostDetailsCsv> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const budgetMs = options.pollBudgetMs ?? DEFAULT_POLL_BUDGET_MS;

  const token = await getAzureManagementToken(credentials, fetchImpl);
  const scope = `subscriptions/${credentials.subscriptionId}`;
  const createUrl = `https://management.azure.com/${scope}/providers/Microsoft.CostManagement/generateCostDetailsReport?api-version=${API_VERSION}`;

  const createResponse = await requestWithThrottleRetry(
    () =>
      fetchImpl(createUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ metric: 'ActualCost', timePeriod: { start, end } }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }),
    sleep
  );

  // 204 is documented as a valid response and carries no body: no charges.
  if (createResponse.status === 204) {
    return { csv: '', blobCount: 0, status: 'NoDataFound' };
  }

  if (!createResponse.ok && createResponse.status !== 202) {
    const body = await createResponse.json().catch(() => null);
    throw new Error(
      errorTextFrom(body, `Azure could not start the cost report (HTTP ${createResponse.status}).`)
    );
  }

  let result: CostDetailsOperationResult | null = null;

  if (createResponse.status === 202) {
    const location = createResponse.headers.get('location');
    if (!location) {
      throw new Error('Azure accepted the cost report request but returned no polling location.');
    }
    result = await pollForResult(location, token, {
      fetchImpl,
      sleep,
      now,
      budgetMs,
      initialWaitMs: clampWait(retryAfterMsFrom(createResponse.headers)),
    });
  } else {
    result = (await createResponse.json().catch(() => null)) as CostDetailsOperationResult | null;
  }

  if (!result) {
    throw new Error('Azure returned an unreadable cost report response.');
  }

  if (result.status === 'Failed') {
    throw new Error(result.error?.message ?? 'Azure failed to generate the cost report.');
  }

  if (result.status === 'NoDataFound') {
    return { csv: '', blobCount: 0, status: 'NoDataFound' };
  }

  const manifest = result.manifest;
  const blobs = manifest?.blobs ?? [];
  if (blobs.length === 0) {
    return { csv: '', blobCount: 0, status: 'NoDataFound' };
  }

  const compressed = manifest?.compressData === true;
  // Downloaded in sequence rather than in parallel: the blobs are large and a
  // report can have many, and this runs inside a request with a time budget
  // already accounted for.
  const parts: string[] = [];
  for (const blob of blobs) {
    parts.push(await downloadBlob(blob, compressed, fetchImpl));
  }

  return { csv: concatenateCsvBlobs(parts), blobCount: blobs.length, status: 'Completed' };
}

async function pollForResult(
  location: string,
  token: string,
  options: {
    fetchImpl: typeof fetch;
    sleep: (ms: number) => Promise<void>;
    now: () => number;
    budgetMs: number;
    initialWaitMs: number;
  }
): Promise<CostDetailsOperationResult> {
  const { fetchImpl, sleep, now, budgetMs, initialWaitMs } = options;
  const deadline = now() + budgetMs;
  let waitMs = initialWaitMs;

  for (;;) {
    if (now() >= deadline) {
      throw new Error(
        'Azure is still preparing the cost report. This usually means a large month — try the pull again in a few minutes.'
      );
    }

    await sleep(waitMs);

    const response = await requestWithThrottleRetry(
      () =>
        fetchImpl(location, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }),
      sleep
    );

    if (response.status === 202) {
      waitMs = clampWait(retryAfterMsFrom(response.headers));
      continue;
    }

    if (response.status === 204) {
      return { status: 'NoDataFound' };
    }

    if (!response.ok) {
      const body = await response.json().catch(() => null);
      throw new Error(errorTextFrom(body, `Azure could not finish the cost report (HTTP ${response.status}).`));
    }

    const body = (await response.json().catch(() => null)) as CostDetailsOperationResult | null;
    if (!body) {
      throw new Error('Azure returned an unreadable cost report result.');
    }

    // A 200 without a terminal status means the operation is still running on
    // some API versions, so keep polling rather than treating it as done.
    if (body.status === undefined && body.manifest === undefined) {
      waitMs = clampWait(retryAfterMsFrom(response.headers));
      continue;
    }

    return body;
  }
}

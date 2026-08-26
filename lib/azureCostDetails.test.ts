import { concatenateCsvBlobs, fetchAzureCostDetailsCsv } from './azureCostDetails';
import type { AzureCredentials } from './azureCostQuery';

const credentials: AzureCredentials = {
  tenantId: 'tenant',
  clientId: 'client',
  clientSecret: 'secret',
  subscriptionId: 'sub-1',
};

// jsdom has no global Response, so responses are duck-typed the same way the
// sibling azureCostQuery tests do.
function makeHeaders(headers: Record<string, string>) {
  const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (name: string) => lower.get(name.toLowerCase()) ?? null };
}

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  const status = init.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: makeHeaders(init.headers ?? {}),
    json: async () => body,
  } as unknown as Response;
}

function emptyResponse(status: number, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: makeHeaders(headers),
    json: async () => null,
  } as unknown as Response;
}

function csvResponse(text: string) {
  return {
    ok: true,
    status: 200,
    headers: makeHeaders({}),
    arrayBuffer: async () => Buffer.from(text, 'utf8'),
  } as unknown as Response;
}

const TOKEN_RESPONSE = () => jsonResponse({ access_token: 'token-123' });

const CSV = 'Date,MeterCategory,CostInBillingCurrency\n2026-08-01,Virtual Machines,1.50\n';

function manifest(blobLinks: string[], compressData = false) {
  return {
    status: 'Completed',
    manifest: {
      blobCount: blobLinks.length,
      blobs: blobLinks.map((blobLink) => ({ blobLink, byteCount: 10 })),
      compressData,
      dataFormat: 'Csv',
    },
  };
}

const noSleep = async () => {};

describe('concatenateCsvBlobs', () => {
  it('keeps only the first blob\'s header row', () => {
    const combined = concatenateCsvBlobs(['h1,h2\na,1\n', 'h1,h2\nb,2\n']);

    expect(combined).toBe('h1,h2\na,1\nb,2');
  });

  it('drops a blob that has a header but no data rows', () => {
    const combined = concatenateCsvBlobs(['h1,h2\na,1\n', 'h1,h2\n']);

    expect(combined).toBe('h1,h2\na,1');
  });

  it('strips a UTF-8 byte order mark so the first header is not corrupted', () => {
    const combined = concatenateCsvBlobs(['﻿h1,h2\na,1\n']);

    expect(combined.startsWith('h1')).toBe(true);
  });
});

describe('fetchAzureCostDetailsCsv', () => {
  it('polls the Location until the report completes, then downloads the blob', async () => {
    const calls: string[] = [];
    const fetchImpl = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('login.microsoftonline.com')) return TOKEN_RESPONSE();
      if (url.includes('generateCostDetailsReport')) {
        return emptyResponse(202, { Location: 'https://poll.example/op1', 'Retry-After': '1' });
      }
      if (url === 'https://poll.example/op1') {
        // First poll still running, second returns the manifest.
        const pollCount = calls.filter((c) => c === 'https://poll.example/op1').length;
        if (pollCount === 1) return emptyResponse(202, { 'Retry-After': '1' });
        return jsonResponse(manifest(['https://blob.example/report.csv']));
      }
      return csvResponse(CSV);
    }) as unknown as typeof fetch;

    const result = await fetchAzureCostDetailsCsv(credentials, '2026-08-01', '2026-08-31', {
      fetchImpl,
      sleep: noSleep,
    });

    expect(result.status).toBe('Completed');
    expect(result.blobCount).toBe(1);
    expect(result.csv).toContain('Virtual Machines');
    expect(calls.filter((c) => c === 'https://poll.example/op1')).toHaveLength(2);
  });

  it('requests the report at subscription scope with an ActualCost time period', async () => {
    let body: unknown = null;
    const fetchImpl = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('login.microsoftonline.com')) return TOKEN_RESPONSE();
      if (url.includes('generateCostDetailsReport')) {
        body = JSON.parse(String(init?.body));
        return jsonResponse(manifest(['https://blob.example/report.csv']));
      }
      return csvResponse(CSV);
    }) as unknown as typeof fetch;

    await fetchAzureCostDetailsCsv(credentials, '2026-08-01', '2026-08-31', { fetchImpl, sleep: noSleep });

    const requested = fetchImpl as unknown as jest.Mock;
    const createUrl = requested.mock.calls.map((c) => String(c[0])).find((u) => u.includes('generateCostDetailsReport'));
    // Subscription scope with timePeriod is the form that works for every
    // agreement type; billingPeriod and invoiceId are EA/MCA-only.
    expect(createUrl).toContain('/subscriptions/sub-1/providers/Microsoft.CostManagement/');
    expect(body).toEqual({ metric: 'ActualCost', timePeriod: { start: '2026-08-01', end: '2026-08-31' } });
  });

  it('treats NoDataFound as an empty report rather than an error', async () => {
    const fetchImpl = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('login.microsoftonline.com')) return TOKEN_RESPONSE();
      return jsonResponse({ status: 'NoDataFound' });
    }) as unknown as typeof fetch;

    const result = await fetchAzureCostDetailsCsv(credentials, '2026-08-01', '2026-08-31', {
      fetchImpl,
      sleep: noSleep,
    });

    expect(result).toEqual({ csv: '', blobCount: 0, status: 'NoDataFound' });
  });

  it('treats a 204 on create as an empty report', async () => {
    const fetchImpl = jest.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('login.microsoftonline.com')) return TOKEN_RESPONSE();
      return emptyResponse(204);
    }) as unknown as typeof fetch;

    const result = await fetchAzureCostDetailsCsv(credentials, '2026-08-01', '2026-08-31', {
      fetchImpl,
      sleep: noSleep,
    });

    expect(result.status).toBe('NoDataFound');
  });

  it('surfaces the Azure message when the report fails', async () => {
    const fetchImpl = jest.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('login.microsoftonline.com')) return TOKEN_RESPONSE();
      return jsonResponse({ status: 'Failed', error: { code: 'BadRequest', message: 'Start date must be after X.' } });
    }) as unknown as typeof fetch;

    await expect(
      fetchAzureCostDetailsCsv(credentials, '2020-01-01', '2020-01-31', { fetchImpl, sleep: noSleep })
    ).rejects.toThrow('Start date must be after X.');
  });

  it('retries a throttled create instead of failing the pull', async () => {
    let creates = 0;
    const fetchImpl = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('login.microsoftonline.com')) return TOKEN_RESPONSE();
      if (url.includes('generateCostDetailsReport')) {
        creates += 1;
        if (creates === 1) {
          return jsonResponse({ error: { message: 'throttled' } }, { status: 429, headers: { 'Retry-After': '1' } });
        }
        return jsonResponse(manifest(['https://blob.example/report.csv']));
      }
      return csvResponse(CSV);
    }) as unknown as typeof fetch;

    const result = await fetchAzureCostDetailsCsv(credentials, '2026-08-01', '2026-08-31', {
      fetchImpl,
      sleep: noSleep,
    });

    expect(creates).toBe(2);
    expect(result.status).toBe('Completed');
  });

  it('gives up with an actionable message when the report outlasts the budget', async () => {
    let clock = 0;
    const fetchImpl = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('login.microsoftonline.com')) return TOKEN_RESPONSE();
      if (url.includes('generateCostDetailsReport')) {
        return emptyResponse(202, { Location: 'https://poll.example/op1', 'Retry-After': '5' });
      }
      return emptyResponse(202, { 'Retry-After': '5' });
    }) as unknown as typeof fetch;

    await expect(
      fetchAzureCostDetailsCsv(credentials, '2026-08-01', '2026-08-31', {
        fetchImpl,
        // Advancing the clock on each sleep is what ends the loop; without a
        // budget this would poll forever against a stuck report.
        sleep: async () => {
          clock += 10_000;
        },
        now: () => clock,
        pollBudgetMs: 30_000,
      })
    ).rejects.toThrow(/still preparing/i);
  });

  it('merges multiple blobs into one CSV without repeating the header', async () => {
    const fetchImpl = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('login.microsoftonline.com')) return TOKEN_RESPONSE();
      if (url.includes('generateCostDetailsReport')) {
        return jsonResponse(manifest(['https://blob.example/1.csv', 'https://blob.example/2.csv']));
      }
      if (url.endsWith('1.csv')) return csvResponse('Date,Cost\n2026-08-01,1\n');
      return csvResponse('Date,Cost\n2026-08-02,2\n');
    }) as unknown as typeof fetch;

    const result = await fetchAzureCostDetailsCsv(credentials, '2026-08-01', '2026-08-31', {
      fetchImpl,
      sleep: noSleep,
    });

    expect(result.blobCount).toBe(2);
    expect(result.csv).toBe('Date,Cost\n2026-08-01,1\n2026-08-02,2');
    expect(result.csv.match(/Date,Cost/g)).toHaveLength(1);
  });
});

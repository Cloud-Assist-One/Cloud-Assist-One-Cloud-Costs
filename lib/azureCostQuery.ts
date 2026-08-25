export interface AzureCredentials {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  subscriptionId: string;
}

export interface AzureQueryColumn {
  name: string;
  type: string;
}

export interface AzureQueryResult {
  columns: AzureQueryColumn[];
  rows: unknown[][];
  nextLink?: string | null;
}

export interface AzureCostRow {
  service_name: string;
  usage_date: string;
  cost: number;
}

// Pinned deliberately rather than tracking "latest": the schema has been
// stable across recent versions, and a well-exercised version is worth more
// here than the newest one.
const API_VERSION = '2024-08-01';

// MeterCategory is the dimension whose values read like the service names a
// customer recognises on an Azure bill (Virtual Machines, Storage,
// Bandwidth), which is the closest analogue to the AWS Cost Explorer SERVICE
// dimension the AWS pull groups by. Microsoft's own docs disagree with
// themselves about what ServiceName means across account types, so that one
// is deliberately avoided.
const GROUPING_DIMENSION = 'MeterCategory';

// Which column holds the money depends on the billing account type: MCA
// scopes expose "Cost", legacy/EA scopes expose "PreTaxCost". The account
// type isn't known ahead of time, so the query is attempted with one and
// retried with the other.
const COST_COLUMN_CANDIDATES = ['Cost', 'PreTaxCost'] as const;

// A daily, single-subscription month is a few hundred rows; anything past
// this many pages means pagination isn't terminating.
const MAX_PAGES = 100;

const REQUEST_TIMEOUT_MS = 30_000;

// Deliberately strict on both halves: the column name has to appear as a
// whole word (so prose like "reports costs in more than one currency" doesn't
// match "Cost"), and the message has to read like a schema rejection rather
// than a transport or permission failure.
function mentionsCostColumn(err: unknown, costColumnName: string): boolean {
  if (!(err instanceof Error)) return false;
  const namedTheColumn = new RegExp(`\\b${costColumnName}\\b`).test(err.message);
  const looksLikeSchemaRejection = /column|aggregation|invalid|not supported|unsupported/i.test(err.message);
  return namedTheColumn && looksLikeSchemaRejection;
}

function errorTextFrom(body: unknown, fallback: string): string {
  if (body && typeof body === 'object') {
    const asRecord = body as Record<string, unknown>;
    const errorDescription = asRecord.error_description;
    if (typeof errorDescription === 'string') return errorDescription;
    const error = asRecord.error;
    if (error && typeof error === 'object') {
      const message = (error as Record<string, unknown>).message;
      if (typeof message === 'string') return message;
    }
    if (typeof asRecord.message === 'string') return asRecord.message;
  }
  return fallback;
}

// Azure returns the usage date for Daily granularity as the integer
// 20260801. An ISO string is also accepted so an unannounced format change
// degrades into "this row parsed" rather than silently dropping every row
// and surfacing as a bogus "no cost data for this month".
function usageDateToIso(value: unknown): string | null {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) {
    return value.slice(0, 10);
  }
  const asNumber = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(asNumber)) return null;
  const digits = String(Math.trunc(asNumber));
  if (digits.length !== 8) return null;
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
}

export function mapQueryResultToRows(
  result: AzureQueryResult,
  costColumnName: string,
  groupingColumnName: string
): AzureCostRow[] {
  const indexOf = (name: string) => result.columns.findIndex((column) => column.name === name);

  // Column ORDER is not part of the API contract — only that `columns`
  // describes what each positional row array holds — so every lookup goes
  // through the column names.
  const costIndex = indexOf(costColumnName);
  const serviceIndex = indexOf(groupingColumnName);
  const dateIndex = indexOf('UsageDate');

  if (costIndex === -1) {
    throw new Error(`Azure Cost Management response has no "${costColumnName}" column.`);
  }
  if (serviceIndex === -1) {
    throw new Error(`Azure Cost Management response has no "${groupingColumnName}" column.`);
  }
  if (dateIndex === -1) {
    throw new Error('Azure Cost Management response has no "UsageDate" column.');
  }

  const rows: AzureCostRow[] = [];
  for (const row of result.rows ?? []) {
    const usageDate = usageDateToIso(row[dateIndex]);
    const rawCost = row[costIndex];
    const cost = typeof rawCost === 'number' ? rawCost : Number(rawCost);
    const serviceName = row[serviceIndex];

    // A row with no parseable date or cost can't be placed on the report at
    // all, so it's skipped. A blank service name is different: that's real
    // spend Azure didn't attribute to a meter category, and dropping it would
    // quietly under-report the month's total against the Azure portal.
    if (!usageDate || rawCost === null || rawCost === undefined || !Number.isFinite(cost)) continue;
    const label = typeof serviceName === 'string' && serviceName.trim() !== '' ? serviceName : 'Unattributed';
    rows.push({ service_name: label, usage_date: usageDate, cost });
  }
  return rows;
}

// The response carries a Currency column the app has nowhere to store —
// cost_records holds a bare number and the UI formats everything as USD. A
// single non-USD subscription is the user's own business, but two different
// currencies in one result set cannot be summed into one total, so that is
// refused rather than silently mis-added.
export function assertSingleCurrency(result: AzureQueryResult): void {
  const currencyIndex = result.columns.findIndex((column) => column.name === 'Currency');
  if (currencyIndex === -1) return;

  const currencies = new Set<string>();
  for (const row of result.rows ?? []) {
    const value = row[currencyIndex];
    if (typeof value === 'string' && value !== '') currencies.add(value);
  }

  if (currencies.size > 1) {
    throw new Error(
      `This subscription reports costs in more than one currency (${[...currencies].sort().join(', ')}), ` +
        `which cannot be combined into a single total. Pull each currency's subscription separately.`
    );
  }
}

async function getAccessToken(credentials: AzureCredentials): Promise<string> {
  const response = await fetch(`https://login.microsoftonline.com/${credentials.tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      scope: 'https://management.azure.com/.default',
    }).toString(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

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

function buildQueryBody(from: string, to: string, costColumnName: string) {
  return {
    type: 'ActualCost',
    timeframe: 'Custom',
    timePeriod: { from: `${from}T00:00:00Z`, to: `${to}T00:00:00Z` },
    dataset: {
      granularity: 'Daily',
      aggregation: { totalCost: { name: costColumnName, function: 'Sum' } },
      grouping: [{ type: 'Dimension', name: GROUPING_DIMENSION }],
    },
  };
}

async function runQuery(
  token: string,
  url: string,
  queryBody: ReturnType<typeof buildQueryBody>
): Promise<AzureQueryResult> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(queryBody),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(errorTextFrom(body, `Azure Cost Management request failed (HTTP ${response.status}).`));
  }

  const properties = (body as Record<string, unknown> | null)?.properties;
  if (!properties || typeof properties !== 'object') {
    throw new Error('Azure Cost Management returned an unexpected response shape.');
  }
  return properties as unknown as AzureQueryResult;
}

/**
 * Fetches per-service daily costs for a subscription.
 *
 * `rangeStart` is inclusive and `rangeEndExclusive` is exclusive, matching the
 * half-open range the rest of the billing pipeline uses. Microsoft does not
 * document whether the API's own `timePeriod.to` includes that day, so the
 * query asks for the wider interpretation and the returned rows are filtered
 * to the intended window here — correct under either behaviour.
 */
export async function fetchAzureCostRows(
  credentials: AzureCredentials,
  rangeStart: string,
  rangeEndExclusive: string
): Promise<{ rows: AzureCostRow[]; rawPages: AzureQueryResult[] }> {
  const token = await getAccessToken(credentials);
  const queryUrl = `https://management.azure.com/subscriptions/${credentials.subscriptionId}/providers/Microsoft.CostManagement/query?api-version=${API_VERSION}`;

  for (let attempt = 0; attempt < COST_COLUMN_CANDIDATES.length; attempt += 1) {
    const costColumnName = COST_COLUMN_CANDIDATES[attempt];
    const queryBody = buildQueryBody(rangeStart, rangeEndExclusive, costColumnName);

    try {
      const rows: AzureCostRow[] = [];
      // Kept so the caller can store the provider's verbatim response as the
      // audit artifact, rather than only our derived rows.
      const rawPages: AzureQueryResult[] = [];
      let url = queryUrl;
      const seenUrls = new Set<string>();

      for (;;) {
        const result = await runQuery(token, url, queryBody);
        rawPages.push(result);
        assertSingleCurrency(result);
        rows.push(...mapQueryResultToRows(result, costColumnName, GROUPING_DIMENSION));

        // `nextLink` is an opaque, fully-formed URL (it carries its own
        // $skiptoken and api-version) — re-POST the same body to it rather
        // than rebuilding it. Microsoft doesn't document that contract, so
        // guard against a service that ignores the skiptoken and hands back
        // the same page forever, which would otherwise spin until the
        // platform timeout with rawPages growing without bound.
        if (!result.nextLink) break;
        if (seenUrls.has(result.nextLink) || rawPages.length >= MAX_PAGES) {
          throw new Error('Azure Cost Management pagination did not advance; stopping to avoid an endless loop.');
        }
        seenUrls.add(result.nextLink);
        url = result.nextLink;
      }

      return {
        rows: rows.filter((row) => row.usage_date >= rangeStart && row.usage_date < rangeEndExclusive),
        rawPages,
      };
    } catch (err) {
      // Only a rejection that actually names the cost column we tried is
      // worth retrying with the other one. Retrying on anything else (a 429
      // from the QPU limit, a 403, a network blip) would both hammer the API
      // and replace a meaningful error with a bogus "invalid column" one,
      // since the alternate column is wrong for this account type.
      const isLastAttempt = attempt === COST_COLUMN_CANDIDATES.length - 1;
      if (isLastAttempt || !mentionsCostColumn(err, costColumnName)) throw err;
    }
  }

  throw new Error('Azure Cost Management request failed.');
}

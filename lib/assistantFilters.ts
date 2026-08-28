import { CLOUD_PROVIDERS } from './cloudProvider';
import type { CloudProvider } from './types';

/**
 * The contract between the assistant and the Line Items filter.
 *
 * Claude's job is translation only: a plain-English question becomes this
 * small object, which existing code then executes through
 * applyLineItemFilters under the user's own session. No SQL is generated, so
 * there is nothing to inject, and RLS still decides what is readable — a
 * wrong answer is a wrong filter, never someone else's data.
 *
 * Everything here treats the model's reply as untrusted input. It is a
 * translator, not an authority.
 */

/** Filters the assistant may set. Anything absent here it cannot reach. */
export const ASSISTANT_FILTER_PROPERTIES = {
  searchText: {
    type: 'string',
    description:
      'Free text matched against service, resource id, region, instance type, meter, usage type, operation, subscription and account. Use for anything not covered by a specific field.',
  },
  cloudProvider: { type: 'string', enum: CLOUD_PROVIDERS, description: 'Restrict to one cloud.' },
  serviceNames: {
    type: 'array',
    items: { type: 'string' },
    description:
      'Exact, complete service names only, matched with equality — e.g. "Amazon Elastic Compute Cloud - Compute". A partial name like "EC2" matches nothing. Use searchText for anything short of the full name.',
  },
  billingCode: { type: 'string', description: 'Exact billing-code tag value.' },
  accountId: { type: 'string', description: 'Exact account or subscription id.' },
  region: { type: 'string', description: 'Exact region, e.g. "us-east-1".' },
  dateFrom: { type: 'string', description: 'Inclusive start date as YYYY-MM-DD.' },
  dateTo: { type: 'string', description: 'Inclusive end date as YYYY-MM-DD.' },
  costMin: { type: 'number', description: 'Only lines costing at least this.' },
  costMax: { type: 'number', description: 'Only lines costing at most this.' },
  excludeZeroCost: { type: 'boolean', description: 'Hide lines costing exactly zero.' },
} as const;

// Deliberately absent from the schema above and rejected by the parser below:
// periodId and companyId. Those decide WHOSE data is read, they come from the
// session, and the model is never given the chance to name them.

/** The filters the assistant may return, as the tab's own filter shape. */
export interface AssistantFilters {
  searchText?: string;
  cloudProvider?: CloudProvider;
  serviceNames?: string[];
  billingCode?: string;
  accountId?: string;
  region?: string;
  dateFrom?: string;
  dateTo?: string;
  costMin?: number;
  costMax?: number;
  excludeZeroCost?: boolean;
}

const MAX_TEXT = 200;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function cleanText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().slice(0, MAX_TEXT);
  return trimmed === '' ? undefined : trimmed;
}

function cleanNumber(value: unknown): number | undefined {
  // Number.isFinite rejects Infinity and NaN as well as non-numbers, and zero
  // survives — it is a real threshold.
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function cleanDate(value: unknown): string | undefined {
  const text = cleanText(value);
  return text && ISO_DATE.test(text) ? text : undefined;
}

/**
 * The model's reply reduced to filters that are safe to run.
 *
 * Unknown keys, wrong types and malformed values are dropped rather than
 * rejected outright: a question that produces one bad field should still run
 * the fields that were fine, and every dropped field is visible to the user
 * because the filter bar shows exactly what was applied.
 */
export function parseAssistantFilters(raw: unknown): AssistantFilters {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const input = raw as Record<string, unknown>;
  const out: AssistantFilters = {};

  const searchText = cleanText(input.searchText);
  if (searchText) out.searchText = searchText;

  if (typeof input.cloudProvider === 'string' && (CLOUD_PROVIDERS as string[]).includes(input.cloudProvider)) {
    out.cloudProvider = input.cloudProvider as CloudProvider;
  }

  if (Array.isArray(input.serviceNames)) {
    const names = input.serviceNames.map(cleanText).filter((name): name is string => Boolean(name));
    if (names.length > 0) out.serviceNames = names;
  }

  const billingCode = cleanText(input.billingCode);
  if (billingCode) out.billingCode = billingCode;

  const accountId = cleanText(input.accountId);
  if (accountId) out.accountId = accountId;

  const region = cleanText(input.region);
  if (region) out.region = region;

  const dateFrom = cleanDate(input.dateFrom);
  if (dateFrom) out.dateFrom = dateFrom;

  const dateTo = cleanDate(input.dateTo);
  if (dateTo) out.dateTo = dateTo;

  const costMin = cleanNumber(input.costMin);
  if (costMin !== undefined) out.costMin = costMin;

  const costMax = cleanNumber(input.costMax);
  if (costMax !== undefined) out.costMax = costMax;

  if (typeof input.excludeZeroCost === 'boolean') out.excludeZeroCost = input.excludeZeroCost;

  return out;
}

import * as XLSX from 'xlsx';

export interface ParsedCostRow {
  service_name: string;
  usage_date: string;
  cost: number;
  account_id: string | null;

  // Billing line-item detail. Populated when the sheet has a matching
  // column; null otherwise. See lib/types.ts CostRecord for the full story.
  resource_id: string | null;
  resource_group: string | null;
  region: string | null;
  availability_zone: string | null;
  instance_type: string | null;
  database_engine: string | null;
  meter_category: string | null;
  meter_name: string | null;
  usage_type: string | null;
  operation: string | null;
  subscription_id: string | null;
  subscription_name: string | null;
  purchase_type: string | null;
  reservation_id: string | null;
  reservation_name: string | null;
  quantity: number | null;
  unit: string | null;
  unit_price: number | null;
  effective_price: number | null;
  currency: string | null;
  charge_type: string | null;
  tags: Record<string, string> | null;
}

export interface ParseResult {
  rows: ParsedCostRow[];
  errors: string[];
}

// Aliases are tried in order, so the earliest match wins. Azure Cost Details
// names are appended to each list rather than inserted, which keeps the
// column an existing spreadsheet resolves to unchanged.
const SERVICE_HEADER_ALIASES = [
  'service',
  'service name',
  'service description',
  'servicename',
  // Azure Cost Details has no plain service column. MeterCategory holds the
  // service-like names ("Virtual Machines", "Storage") and is what the Azure
  // pull grouped by before it moved to this report, so pulled months keep
  // reading the same. ConsumedService ("Microsoft.Compute") is the fallback.
  'metercategory',
  'consumedservice',
];
const DATE_HEADER_ALIASES = ['date', 'usage date', 'start date', 'month', 'usagedatetime'];
const COST_HEADER_ALIASES = [
  'cost',
  'amount',
  'blended cost',
  'unblended cost',
  'total cost',
  'cost (usd)',
  'costinbillingcurrency',
  'pretaxcost',
];
const ACCOUNT_HEADER_ALIASES = ['account id', 'linked account', 'subscription id', 'subscription name'];

// Line-item detail aliases, covering both AWS Cost and Usage Report (CUR)
// and Azure usage-export naming. Matched case-insensitively via
// normalizeHeader, same as the four aliases above.
const RESOURCE_ID_HEADER_ALIASES = ['resource id', 'resourceid', 'lineitem/resourceid', 'line_item_resource_id', 'instance id', 'instancename'];
const RESOURCE_GROUP_HEADER_ALIASES = ['resource group', 'resourcegroup', 'resourcegroupname'];
const REGION_HEADER_ALIASES = ['region', 'resourcelocation', 'resource location', 'location', 'product/region', 'product_region', 'meterregion'];
const AVAILABILITY_ZONE_HEADER_ALIASES = ['availability zone', 'az', 'lineitem/availabilityzone'];
const INSTANCE_TYPE_HEADER_ALIASES = ['instance type', 'instancetype', 'product/instancetype', 'product_instance_type'];
const DATABASE_ENGINE_HEADER_ALIASES = ['database engine', 'databaseengine', 'product/databaseengine', 'product_database_engine'];
const METER_CATEGORY_HEADER_ALIASES = ['meter category', 'metercategory'];
const METER_NAME_HEADER_ALIASES = ['meter name', 'metername', 'meter'];
const USAGE_TYPE_HEADER_ALIASES = ['usage type', 'usagetype', 'lineitem/usagetype', 'line_item_usage_type'];
const OPERATION_HEADER_ALIASES = ['operation', 'lineitem/operation', 'line_item_operation'];
const SUBSCRIPTION_ID_HEADER_ALIASES = ['subscription id', 'subscriptionid', 'subscriptionguid'];
const SUBSCRIPTION_NAME_HEADER_ALIASES = ['subscription name', 'subscriptionname'];
const PURCHASE_TYPE_HEADER_ALIASES = ['purchase type', 'purchaseoption', 'pricingmodel', 'pricing model', 'lineitem/lineitemtype', 'charge type'];
const RESERVATION_ID_HEADER_ALIASES = ['reservation id', 'reservationid'];
const RESERVATION_NAME_HEADER_ALIASES = ['reservation name', 'reservationname'];
const QUANTITY_HEADER_ALIASES = ['quantity', 'usagequantity', 'lineitem/usageamount', 'line_item_usage_amount'];
const UNIT_HEADER_ALIASES = ['unit', 'unitofmeasure', 'pricing/unit'];
const UNIT_PRICE_HEADER_ALIASES = ['unit price', 'unitprice', 'pricing/publicondemandrate'];
const EFFECTIVE_PRICE_HEADER_ALIASES = ['effective price', 'effectiveprice', 'lineitem/netunblendedcost'];
const CURRENCY_HEADER_ALIASES = ['currency', 'billingcurrency', 'currencycode', 'pricing/currency'];
const CHARGE_TYPE_HEADER_ALIASES = ['charge type', 'chargetype', 'lineitem/lineitemtype'];
const TAGS_HEADER_ALIASES = ['tags', 'resource tags', 'resourcetags'];

// CUR-style per-tag columns: `resource_tags/user_<key>` (Azure-flavored
// separators) or `resourceTags/user:<key>` (AWS CUR). Matched against the
// trimmed but NOT lowercased header so the captured key keeps its case.
const TAG_USER_COLUMN_REGEX = /^resource[_\s-]?tags\/user[:_](.+)$/i;

function normalizeHeader(header: string): string {
  return header.trim().toLowerCase();
}

function findColumnIndex(headers: string[], aliases: string[]): number {
  const normalized = headers.map(normalizeHeader);
  for (const alias of aliases) {
    const idx = normalized.indexOf(alias);
    if (idx !== -1) return idx;
  }
  return -1;
}

function findTagUserColumns(headers: string[]): { index: number; key: string }[] {
  const columns: { index: number; key: string }[] = [];
  headers.forEach((header, index) => {
    const match = TAG_USER_COLUMN_REGEX.exec(header.trim());
    const key = match?.[1]?.trim();
    if (key) columns.push({ index, key });
  });
  return columns;
}

function parseDateValue(value: unknown): string | null {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === 'string') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString().slice(0, 10);
    }
  }
  // Fallback for a raw Excel serial-number date: cellDates: true should already convert
  // date-formatted cells to JS Date objects, but some sheets store dates as plain numbers
  // with cell-format metadata that XLSX.read doesn't always resolve. parse_date_code's
  // `.m` is 1-indexed (matches ISO month numbering), so no adjustment is needed there.
  if (typeof value === 'number' && Number.isFinite(value)) {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (parsed && Number.isFinite(parsed.y) && Number.isFinite(parsed.m) && Number.isFinite(parsed.d) && parsed.d > 0) {
      const year = String(parsed.y).padStart(4, '0');
      const month = String(parsed.m).padStart(2, '0');
      const day = String(parsed.d).padStart(2, '0');
      return `${year}-${month}-${day}`;
    }
  }
  return null;
}

// Shared by cost, quantity, unit_price, and effective_price: strips currency
// symbols/commas, and a value that still isn't numeric becomes null rather
// than an error (only service/date/cost are required).
function parseNumericValue(value: unknown): number | null {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const cleaned = value.replace(/[$,]/g, '').trim();
    if (cleaned === '') return null;
    const parsed = Number(cleaned);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function stringOrNull(rowData: unknown[], idx: number): string | null {
  if (idx === -1) return null;
  const raw = rowData[idx];
  if (raw === undefined || raw === null) return null;
  const str = String(raw).trim();
  return str === '' ? null : str;
}

function numberOrNull(rowData: unknown[], idx: number): number | null {
  if (idx === -1) return null;
  return parseNumericValue(rowData[idx]);
}

// A single JSON-ish tags column becomes an object; a string that isn't
// valid JSON (or isn't a JSON object) is kept as { raw: <original> } rather
// than silently dropped.
function parseTagsColumnValue(raw: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const obj: Record<string, string> = {};
      for (const [key, val] of Object.entries(parsed as Record<string, unknown>)) {
        obj[key] = typeof val === 'string' ? val : JSON.stringify(val);
      }
      return obj;
    }
    return { raw };
  } catch {
    return { raw };
  }
}

function buildTags(
  rowData: unknown[],
  tagsIdx: number,
  tagUserColumns: { index: number; key: string }[]
): Record<string, string> | null {
  let tags: Record<string, string> | null = null;

  if (tagsIdx !== -1) {
    const rawValue = stringOrNull(rowData, tagsIdx);
    if (rawValue) {
      tags = parseTagsColumnValue(rawValue);
    }
  }

  for (const { index, key } of tagUserColumns) {
    const value = stringOrNull(rowData, index);
    if (value) {
      if (!tags) tags = {};
      tags[key] = value;
    }
  }

  return tags;
}

export function parseCostFile(buffer: ArrayBuffer | Buffer): ParseResult {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    return { rows: [], errors: ['The file has no sheets.'] };
  }

  const sheet = workbook.Sheets[sheetName];
  const data = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true });

  if (data.length === 0) {
    return { rows: [], errors: ['The file is empty.'] };
  }

  const headers = (data[0] as unknown[]).map((h) => String(h ?? ''));
  const serviceIdx = findColumnIndex(headers, SERVICE_HEADER_ALIASES);
  const dateIdx = findColumnIndex(headers, DATE_HEADER_ALIASES);
  const costIdx = findColumnIndex(headers, COST_HEADER_ALIASES);
  const accountIdx = findColumnIndex(headers, ACCOUNT_HEADER_ALIASES);

  const resourceIdIdx = findColumnIndex(headers, RESOURCE_ID_HEADER_ALIASES);
  const resourceGroupIdx = findColumnIndex(headers, RESOURCE_GROUP_HEADER_ALIASES);
  const regionIdx = findColumnIndex(headers, REGION_HEADER_ALIASES);
  const availabilityZoneIdx = findColumnIndex(headers, AVAILABILITY_ZONE_HEADER_ALIASES);
  const instanceTypeIdx = findColumnIndex(headers, INSTANCE_TYPE_HEADER_ALIASES);
  const databaseEngineIdx = findColumnIndex(headers, DATABASE_ENGINE_HEADER_ALIASES);
  const meterCategoryIdx = findColumnIndex(headers, METER_CATEGORY_HEADER_ALIASES);
  const meterNameIdx = findColumnIndex(headers, METER_NAME_HEADER_ALIASES);
  const usageTypeIdx = findColumnIndex(headers, USAGE_TYPE_HEADER_ALIASES);
  const operationIdx = findColumnIndex(headers, OPERATION_HEADER_ALIASES);
  const subscriptionIdIdx = findColumnIndex(headers, SUBSCRIPTION_ID_HEADER_ALIASES);
  const subscriptionNameIdx = findColumnIndex(headers, SUBSCRIPTION_NAME_HEADER_ALIASES);
  const purchaseTypeIdx = findColumnIndex(headers, PURCHASE_TYPE_HEADER_ALIASES);
  const reservationIdIdx = findColumnIndex(headers, RESERVATION_ID_HEADER_ALIASES);
  const reservationNameIdx = findColumnIndex(headers, RESERVATION_NAME_HEADER_ALIASES);
  const quantityIdx = findColumnIndex(headers, QUANTITY_HEADER_ALIASES);
  const unitIdx = findColumnIndex(headers, UNIT_HEADER_ALIASES);
  const unitPriceIdx = findColumnIndex(headers, UNIT_PRICE_HEADER_ALIASES);
  const effectivePriceIdx = findColumnIndex(headers, EFFECTIVE_PRICE_HEADER_ALIASES);
  const currencyIdx = findColumnIndex(headers, CURRENCY_HEADER_ALIASES);
  const chargeTypeIdx = findColumnIndex(headers, CHARGE_TYPE_HEADER_ALIASES);
  const tagsIdx = findColumnIndex(headers, TAGS_HEADER_ALIASES);
  const tagUserColumns = findTagUserColumns(headers);

  const errors: string[] = [];
  if (serviceIdx === -1) errors.push('Could not find a "Service" column.');
  if (dateIdx === -1) errors.push('Could not find a "Date" column.');
  if (costIdx === -1) errors.push('Could not find a "Cost" column.');

  if (errors.length > 0) {
    return { rows: [], errors };
  }

  const rows: ParsedCostRow[] = [];
  for (let i = 1; i < data.length; i += 1) {
    const rowData = data[i] as unknown[] | undefined;
    if (!rowData || rowData.length === 0) continue;

    const serviceName = String(rowData[serviceIdx] ?? '').trim();
    const usageDate = parseDateValue(rowData[dateIdx]);
    const cost = parseNumericValue(rowData[costIdx]);
    const accountId = accountIdx !== -1 ? String(rowData[accountIdx] ?? '').trim() || null : null;

    if (!serviceName || !usageDate || cost === null) {
      errors.push(`Row ${i + 1}: could not parse service/date/cost.`);
      continue;
    }

    rows.push({
      service_name: serviceName,
      usage_date: usageDate,
      cost,
      account_id: accountId,

      resource_id: stringOrNull(rowData, resourceIdIdx),
      resource_group: stringOrNull(rowData, resourceGroupIdx),
      region: stringOrNull(rowData, regionIdx),
      availability_zone: stringOrNull(rowData, availabilityZoneIdx),
      instance_type: stringOrNull(rowData, instanceTypeIdx),
      database_engine: stringOrNull(rowData, databaseEngineIdx),
      meter_category: stringOrNull(rowData, meterCategoryIdx),
      meter_name: stringOrNull(rowData, meterNameIdx),
      usage_type: stringOrNull(rowData, usageTypeIdx),
      operation: stringOrNull(rowData, operationIdx),
      subscription_id: stringOrNull(rowData, subscriptionIdIdx),
      subscription_name: stringOrNull(rowData, subscriptionNameIdx),
      purchase_type: stringOrNull(rowData, purchaseTypeIdx),
      reservation_id: stringOrNull(rowData, reservationIdIdx),
      reservation_name: stringOrNull(rowData, reservationNameIdx),
      quantity: numberOrNull(rowData, quantityIdx),
      unit: stringOrNull(rowData, unitIdx),
      unit_price: numberOrNull(rowData, unitPriceIdx),
      effective_price: numberOrNull(rowData, effectivePriceIdx),
      currency: stringOrNull(rowData, currencyIdx),
      charge_type: stringOrNull(rowData, chargeTypeIdx),
      tags: buildTags(rowData, tagsIdx, tagUserColumns),
    });
  }

  return { rows, errors };
}

import * as XLSX from 'xlsx';

export interface ParsedCostRow {
  service_name: string;
  usage_date: string;
  cost: number;
  account_id: string | null;
}

export interface ParseResult {
  rows: ParsedCostRow[];
  errors: string[];
}

const SERVICE_HEADER_ALIASES = ['service', 'service name'];
const DATE_HEADER_ALIASES = ['date', 'usage date', 'start date'];
const COST_HEADER_ALIASES = ['cost', 'amount', 'blended cost', 'unblended cost', 'total cost'];
const ACCOUNT_HEADER_ALIASES = ['account id', 'linked account', 'subscription id', 'subscription name'];

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

function parseDateValue(value: unknown): string | null {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === 'string') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString().slice(0, 10);
    }
  }
  return null;
}

function parseCostValue(value: unknown): number | null {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const cleaned = value.replace(/[$,]/g, '').trim();
    if (cleaned === '') return null;
    const parsed = Number(cleaned);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

export function parseCostFile(buffer: ArrayBuffer | Buffer): ParseResult {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
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
    const cost = parseCostValue(rowData[costIdx]);
    const accountId = accountIdx !== -1 ? String(rowData[accountIdx] ?? '').trim() || null : null;

    if (!serviceName || !usageDate || cost === null) {
      errors.push(`Row ${i + 1}: could not parse service/date/cost.`);
      continue;
    }

    rows.push({ service_name: serviceName, usage_date: usageDate, cost, account_id: accountId });
  }

  return { rows, errors };
}

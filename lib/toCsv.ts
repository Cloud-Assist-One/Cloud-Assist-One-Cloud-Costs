/**
 * Rows to CSV, for the Line Items export.
 *
 * Small and hand-rolled rather than a dependency: the whole job is quoting,
 * and the two rules worth getting right are quoting and formula injection.
 */

export interface CsvColumn {
  key: string;
  header: string;
}

// Excel, Sheets and LibreOffice execute a cell beginning with any of these as
// a formula when the file is opened. Cost data carries user-typed resource
// tags and names, so a cell can absolutely start with one.
const FORMULA_PREFIXES = ['=', '+', '-', '@'];

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';

  // Numbers pass through bare so a spreadsheet reads them as numbers rather
  // than text, and a negative number is not a formula.
  if (typeof value === 'number') return String(value);

  const text = String(value);

  if (FORMULA_PREFIXES.some((prefix) => text.startsWith(prefix))) {
    // Leading apostrophe is the spreadsheet convention for "this is text".
    return `"'${text.replace(/"/g, '""')}"`;
  }

  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }

  return text;
}

export function toCsv(rows: readonly Record<string, unknown>[], columns: readonly CsvColumn[]): string {
  const header = columns.map((column) => csvCell(column.header)).join(',');
  const body = rows.map((row) => columns.map((column) => csvCell(row[column.key])).join(','));

  // CRLF: a bare LF makes older Excel read the whole file as one line.
  return [header, ...body].join('\r\n');
}

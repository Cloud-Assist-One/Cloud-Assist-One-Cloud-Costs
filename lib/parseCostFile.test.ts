import * as XLSX from 'xlsx';
import { parseCostFile } from './parseCostFile';

function buildWorkbookBuffer(rows: (string | number | Date)[][]): Buffer {
  const worksheet = XLSX.utils.aoa_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Sheet1');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

describe('parseCostFile', () => {
  it('parses valid rows with a Service/Date/Cost header', () => {
    const buffer = buildWorkbookBuffer([
      ['Service', 'Date', 'Cost'],
      ['Amazon EC2', '2026-07-01', 12.5],
      ['Amazon S3', '2026-07-02', 3.25],
    ]);

    const result = parseCostFile(buffer);

    expect(result.errors).toEqual([]);
    expect(result.rows).toEqual([
      { service_name: 'Amazon EC2', usage_date: '2026-07-01', cost: 12.5, account_id: null },
      { service_name: 'Amazon S3', usage_date: '2026-07-02', cost: 3.25, account_id: null },
    ]);
  });

  it('recognizes alias headers and an account column', () => {
    const buffer = buildWorkbookBuffer([
      ['Service Name', 'Usage Date', 'Blended Cost', 'Linked Account'],
      ['Azure App Service', '2026-07-03', '$45.10', '1234-5678'],
    ]);

    const result = parseCostFile(buffer);

    expect(result.errors).toEqual([]);
    expect(result.rows).toEqual([
      { service_name: 'Azure App Service', usage_date: '2026-07-03', cost: 45.1, account_id: '1234-5678' },
    ]);
  });

  it('recognizes "Service Description", "Cost (USD)", and "Month" as header aliases', () => {
    const buffer = buildWorkbookBuffer([
      ['Service Description', 'Month', 'Cost (USD)'],
      ['Google Compute Engine', '2026-08-01', 45.2],
    ]);

    const result = parseCostFile(buffer);

    expect(result.errors).toEqual([]);
    expect(result.rows).toEqual([
      { service_name: 'Google Compute Engine', usage_date: '2026-08-01', cost: 45.2, account_id: null },
    ]);
  });

  it('reports an error and returns no rows when required columns are missing', () => {
    const buffer = buildWorkbookBuffer([
      ['Something', 'Else'],
      ['a', 'b'],
    ]);

    const result = parseCostFile(buffer);

    expect(result.rows).toEqual([]);
    expect(result.errors).toContain('Could not find a "Service" column.');
    expect(result.errors).toContain('Could not find a "Date" column.');
    expect(result.errors).toContain('Could not find a "Cost" column.');
  });

  it('reports an error for an empty file', () => {
    const buffer = buildWorkbookBuffer([]);

    const result = parseCostFile(buffer);

    expect(result.rows).toEqual([]);
    expect(result.errors).toEqual(['The file is empty.']);
  });

  it('skips unparseable rows but keeps valid ones, reporting the row number', () => {
    const buffer = buildWorkbookBuffer([
      ['Service', 'Date', 'Cost'],
      ['Amazon EC2', '2026-07-01', 12.5],
      ['Amazon S3', 'not-a-date', 3.25],
      ['Amazon RDS', '2026-07-04', 'not-a-number'],
    ]);

    const result = parseCostFile(buffer);

    expect(result.rows).toEqual([
      { service_name: 'Amazon EC2', usage_date: '2026-07-01', cost: 12.5, account_id: null },
    ]);
    expect(result.errors).toEqual([
      'Row 3: could not parse service/date/cost.',
      'Row 4: could not parse service/date/cost.',
    ]);
  });

  it('parses a native Excel date cell (not a string) into an ISO date', () => {
    const buffer = buildWorkbookBuffer([
      ['Service', 'Date', 'Cost'],
      ['Amazon EC2', new Date(2026, 6, 15), 12.5],
    ]);

    const result = parseCostFile(buffer);

    expect(result.errors).toEqual([]);
    expect(result.rows).toEqual([
      { service_name: 'Amazon EC2', usage_date: '2026-07-15', cost: 12.5, account_id: null },
    ]);
  });
});

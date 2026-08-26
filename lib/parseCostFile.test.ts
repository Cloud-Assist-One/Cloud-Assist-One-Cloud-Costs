import * as XLSX from 'xlsx';
import { parseCostFile } from './parseCostFile';

function buildWorkbookBuffer(rows: (string | number | Date)[][]): Buffer {
  const worksheet = XLSX.utils.aoa_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Sheet1');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

// Every parsed row carries the full set of line-item fields, even when a
// sheet has no columns for them. Spread this into `toEqual` expectations so
// each test only calls out the fields it actually cares about.
const NULL_LINE_ITEM_FIELDS = {
  resource_id: null,
  resource_group: null,
  region: null,
  availability_zone: null,
  instance_type: null,
  database_engine: null,
  meter_category: null,
  meter_name: null,
  usage_type: null,
  operation: null,
  subscription_id: null,
  subscription_name: null,
  purchase_type: null,
  reservation_id: null,
  reservation_name: null,
  quantity: null,
  unit: null,
  unit_price: null,
  effective_price: null,
  currency: null,
  charge_type: null,
  tags: null,
};

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
      { service_name: 'Amazon EC2', usage_date: '2026-07-01', cost: 12.5, account_id: null, ...NULL_LINE_ITEM_FIELDS },
      { service_name: 'Amazon S3', usage_date: '2026-07-02', cost: 3.25, account_id: null, ...NULL_LINE_ITEM_FIELDS },
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
      {
        service_name: 'Azure App Service',
        usage_date: '2026-07-03',
        cost: 45.1,
        account_id: '1234-5678',
        ...NULL_LINE_ITEM_FIELDS,
      },
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
      {
        service_name: 'Google Compute Engine',
        usage_date: '2026-08-01',
        cost: 45.2,
        account_id: null,
        ...NULL_LINE_ITEM_FIELDS,
      },
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
      { service_name: 'Amazon EC2', usage_date: '2026-07-01', cost: 12.5, account_id: null, ...NULL_LINE_ITEM_FIELDS },
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
      { service_name: 'Amazon EC2', usage_date: '2026-07-15', cost: 12.5, account_id: null, ...NULL_LINE_ITEM_FIELDS },
    ]);
  });

  it('still parses fine with only the original four columns, leaving new fields null', () => {
    const buffer = buildWorkbookBuffer([
      ['Service', 'Date', 'Cost', 'Account Id'],
      ['Amazon EC2', '2026-07-01', 12.5, '111122223333'],
    ]);

    const result = parseCostFile(buffer);

    expect(result.errors).toEqual([]);
    expect(result.rows).toEqual([
      {
        service_name: 'Amazon EC2',
        usage_date: '2026-07-01',
        cost: 12.5,
        account_id: '111122223333',
        ...NULL_LINE_ITEM_FIELDS,
      },
    ]);
  });

  it('parses a CUR-style sheet: resource id, instance type, region, and per-tag columns', () => {
    const buffer = buildWorkbookBuffer([
      [
        'Service',
        'Date',
        'Cost',
        'ResourceId',
        'Product/InstanceType',
        'Product/Region',
        'resourceTags/user:Environment',
        'resourceTags/user:CostCenter',
      ],
      ['Amazon EC2', '2026-07-01', 12.5, 'i-0123456789abcdef0', 'm5.large', 'us-east-1', 'production', '1234'],
    ]);

    const result = parseCostFile(buffer);

    expect(result.errors).toEqual([]);
    expect(result.rows).toEqual([
      {
        service_name: 'Amazon EC2',
        usage_date: '2026-07-01',
        cost: 12.5,
        account_id: null,
        ...NULL_LINE_ITEM_FIELDS,
        resource_id: 'i-0123456789abcdef0',
        instance_type: 'm5.large',
        region: 'us-east-1',
        tags: { Environment: 'production', CostCenter: '1234' },
      },
    ]);
  });

  it('parses an Azure-style sheet: ResourceLocation, SubscriptionName, MeterCategory, PricingModel', () => {
    const buffer = buildWorkbookBuffer([
      ['Service', 'Date', 'Cost', 'ResourceLocation', 'SubscriptionName', 'MeterCategory', 'PricingModel'],
      ['Virtual Machines', '2026-07-05', '$67.89', 'East US', 'Contoso Prod', 'Virtual Machines', 'Reservation'],
    ]);

    const result = parseCostFile(buffer);

    expect(result.errors).toEqual([]);
    expect(result.rows).toEqual([
      {
        service_name: 'Virtual Machines',
        usage_date: '2026-07-05',
        cost: 67.89,
        account_id: null,
        ...NULL_LINE_ITEM_FIELDS,
        region: 'East US',
        subscription_name: 'Contoso Prod',
        meter_category: 'Virtual Machines',
        purchase_type: 'Reservation',
      },
    ]);
  });

  it('parses a single JSON tags column into an object', () => {
    const buffer = buildWorkbookBuffer([
      ['Service', 'Date', 'Cost', 'Tags'],
      ['Amazon EC2', '2026-07-01', 12.5, '{"Billing Code":"1234"}'],
    ]);

    const result = parseCostFile(buffer);

    expect(result.errors).toEqual([]);
    expect(result.rows[0].tags).toEqual({ 'Billing Code': '1234' });
  });

  it('falls back to { raw } when the tags column is not valid JSON', () => {
    const buffer = buildWorkbookBuffer([
      ['Service', 'Date', 'Cost', 'Tags'],
      ['Amazon EC2', '2026-07-01', 12.5, 'not valid json {'],
    ]);

    const result = parseCostFile(buffer);

    expect(result.errors).toEqual([]);
    expect(result.rows[0].tags).toEqual({ raw: 'not valid json {' });
  });

  it('parses a non-numeric quantity as null rather than erroring the row', () => {
    const buffer = buildWorkbookBuffer([
      ['Service', 'Date', 'Cost', 'Quantity'],
      ['Amazon EC2', '2026-07-01', 12.5, 'N/A'],
    ]);

    const result = parseCostFile(buffer);

    expect(result.errors).toEqual([]);
    expect(result.rows[0].quantity).toBeNull();
  });
});

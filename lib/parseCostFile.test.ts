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

  // The Azure pull downloads a Cost Details CSV and hands it straight to this
  // parser, so these exact column names are the contract between the two.
  describe('Azure Cost Details report', () => {
    const COST_DETAILS_CSV = [
      'Date,MeterCategory,MeterName,ConsumedService,CostInBillingCurrency,BillingCurrency,ResourceId,ResourceGroup,' +
        'ResourceLocation,SubscriptionId,SubscriptionName,Quantity,UnitOfMeasure,UnitPrice,EffectivePrice,ChargeType,' +
        'PricingModel,ReservationId,ReservationName,Tags',
      '2026-08-03,Virtual Machines,D2s v3,Microsoft.Compute,12.34,USD,/subscriptions/s1/resourceGroups/rg1/providers/' +
        'Microsoft.Compute/virtualMachines/web1,rg1,eastus,s1,Production,24,1 Hour,0.55,0.51,Usage,OnDemand,,,' +
        '"{""env"":""prod""}"',
    ].join('\n');

    function parseCsv(csv: string) {
      return parseCostFile(Buffer.from(csv, 'utf8'));
    }

    it('reads the report Azure actually returns, filling the line-item columns', () => {
      const result = parseCsv(COST_DETAILS_CSV);

      expect(result.errors).toEqual([]);
      expect(result.rows).toHaveLength(1);

      const row = result.rows[0];
      expect(row.usage_date).toBe('2026-08-03');
      expect(row.cost).toBeCloseTo(12.34);
      // MeterCategory is the service-like name, matching what the pull showed
      // before it moved off the Query API.
      expect(row.service_name).toBe('Virtual Machines');
      expect(row.meter_name).toBe('D2s v3');
      expect(row.region).toBe('eastus');
      expect(row.resource_group).toBe('rg1');
      expect(row.resource_id).toContain('virtualMachines/web1');
      expect(row.subscription_name).toBe('Production');
      expect(row.quantity).toBe(24);
      expect(row.unit).toBe('1 Hour');
      expect(row.unit_price).toBeCloseTo(0.55);
      expect(row.effective_price).toBeCloseTo(0.51);
      expect(row.currency).toBe('USD');
      expect(row.charge_type).toBe('Usage');
      expect(row.tags).toEqual({ env: 'prod' });
    });

    it('reads the pay-as-you-go column spellings too', () => {
      // EA and pay-as-you-go exports name these differently from MCA, and the
      // account type is not something the pull can know in advance.
      const result = parseCsv(
        ['UsageDateTime,MeterCategory,PreTaxCost,Currency', '2026-08-04,Storage,3.21,USD'].join('\n')
      );

      expect(result.errors).toEqual([]);
      expect(result.rows[0].usage_date).toBe('2026-08-04');
      expect(result.rows[0].cost).toBeCloseTo(3.21);
      expect(result.rows[0].service_name).toBe('Storage');
    });

    it('still prefers an explicit Service column when a sheet has one', () => {
      // Adding MeterCategory as a service fallback must not change how an
      // uploaded spreadsheet that already names its service resolves.
      const result = parseCsv(
        ['Service,MeterCategory,Date,Cost', 'Contoso Widgets,Virtual Machines,2026-08-05,1.00'].join('\n')
      );

      expect(result.rows[0].service_name).toBe('Contoso Widgets');
    });
  });
});

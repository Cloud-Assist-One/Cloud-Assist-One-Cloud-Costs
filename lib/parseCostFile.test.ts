import * as XLSX from 'xlsx';
import { COST_FILE_COLUMNS, describeCostFileColumns, parseCostFile } from './parseCostFile';

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

  // AWS CUR 2.0 / Data Exports names every column in snake_case. The header
  // below is a subset of a real 116-column export; before these aliases
  // existed, none of cost, date, service or account resolved and a real CUR
  // parsed into nothing.
  describe('AWS CUR 2.0 (Data Exports) report', () => {
    const CUR2_CSV = [
      'bill_payer_account_id,line_item_usage_account_id,line_item_usage_start_date,line_item_product_code,' +
        'line_item_unblended_cost,line_item_net_unblended_cost,line_item_currency_code,line_item_line_item_type,' +
        'line_item_resource_id,line_item_availability_zone,line_item_usage_amount,line_item_usage_type,' +
        'line_item_operation,product_region_code,product_instance_type,pricing_unit,' +
        'pricing_public_on_demand_rate,pricing_purchase_option',
      '123456789012,123456789012,2026-08-03T00:00:00Z,AmazonEC2,12.34,11.90,USD,Usage,' +
        'arn:aws:ec2:us-east-1:123456789012:instance/i-abc123,us-east-1a,24,BoxUsage:t3.medium,' +
        'RunInstances,us-east-1,t3.medium,Hrs,0.0416,On Demand',
    ].join('\n');

    function parseCsv(csv: string) {
      return parseCostFile(Buffer.from(csv, 'utf8'));
    }

    it('resolves the four core columns a real CUR 2.0 export uses', () => {
      const result = parseCsv(CUR2_CSV);

      expect(result.errors).toEqual([]);
      expect(result.rows).toHaveLength(1);

      const row = result.rows[0];
      expect(row.cost).toBeCloseTo(12.34);
      expect(row.usage_date).toBe('2026-08-03');
      // AWS ships no friendly service name in this export; the product code
      // is what there is.
      expect(row.service_name).toBe('AmazonEC2');
      expect(row.account_id).toBe('123456789012');
    });

    it('fills the line-item columns from their snake_case names', () => {
      const row = parseCsv(CUR2_CSV).rows[0];

      expect(row.resource_id).toBe('arn:aws:ec2:us-east-1:123456789012:instance/i-abc123');
      expect(row.region).toBe('us-east-1');
      expect(row.availability_zone).toBe('us-east-1a');
      expect(row.instance_type).toBe('t3.medium');
      expect(row.usage_type).toBe('BoxUsage:t3.medium');
      expect(row.operation).toBe('RunInstances');
      expect(row.quantity).toBe(24);
      expect(row.unit).toBe('Hrs');
      expect(row.currency).toBe('USD');
      expect(row.charge_type).toBe('Usage');
    });

    // The resource id is what the Cost Leakage tab joins findings against, so
    // a CUR that parses without it defeats the reason for pulling a CUR.
    it('carries the resource id, which grouped API pulls cannot provide', () => {
      expect(parseCsv(CUR2_CSV).rows[0].resource_id).toContain('i-abc123');
    });
  });

  // FOCUS is what the current Azure "Exports" wizard offers first, so it is
  // what a newly configured container is most likely to be filled with. The
  // header below is a subset of a real Azure FOCUS 1.0 export.
  describe('Azure FOCUS export', () => {
    const FOCUS_CSV = [
      'BillingAccountId,SubAccountId,SubAccountName,ChargePeriodStart,ChargePeriodEnd,BillingPeriodStart,' +
        'ServiceName,ServiceCategory,BilledCost,EffectiveCost,ListCost,ContractedCost,BillingCurrency,' +
        'ChargeCategory,ResourceId,ResourceName,RegionId,AvailabilityZone,PricingQuantity,PricingUnit,' +
        'ListUnitPrice,ContractedUnitPrice,PricingCategory,CommitmentDiscountId,CommitmentDiscountName,' +
        'x_ResourceGroupName,x_SkuMeterCategory,x_SkuMeterName,Tags',
      '9876543,11111111-2222-3333-4444-555555555555,Production,2026-08-03T00:00:00Z,2026-08-04T00:00:00Z,' +
        '2026-08-01T00:00:00Z,Virtual Machines,Compute,18.40,17.10,22.00,19.50,USD,' +
        'Usage,/subscriptions/1111/resourceGroups/rg-app/providers/Microsoft.Compute/virtualMachines/vm-web-01,' +
        'vm-web-01,eastus,eastus-az1,24,1 Hour,0.9167,0.8125,Committed,' +
        '/providers/Microsoft.Capacity/reservationOrders/abc/reservations/def,vm-ri-3yr,' +
        'rg-app,Virtual Machines,D2s v3,"{""env"":""prod""}"',
    ].join('\n');

    function parseCsv(csv: string) {
      return parseCostFile(Buffer.from(csv, 'utf8'));
    }

    // The exact failure a FOCUS export produced before these aliases existed:
    // ServiceName resolved, so Service was never among the errors, and the
    // report named only Date and Cost.
    it('resolves the four core columns a real FOCUS export uses', () => {
      const result = parseCsv(FOCUS_CSV);

      expect(result.errors).toEqual([]);
      expect(result.rows).toHaveLength(1);

      const row = result.rows[0];
      expect(row.service_name).toBe('Virtual Machines');
      expect(row.usage_date).toBe('2026-08-03');
      expect(row.cost).toBeCloseTo(18.4);
      expect(row.account_id).toBe('11111111-2222-3333-4444-555555555555');
    });

    // BilledCost, not EffectiveCost: a company moving an existing export to
    // FOCUS must keep seeing the invoiced figure the legacy actual-cost
    // export gave it, rather than silently switching to the amortized one.
    it('prefers BilledCost over EffectiveCost when both are present', () => {
      expect(parseCsv(FOCUS_CSV).rows[0].cost).toBeCloseTo(18.4);
    });

    it('falls back to EffectiveCost when the export omits BilledCost', () => {
      const result = parseCsv(
        ['ServiceName,ChargePeriodStart,EffectiveCost', 'Storage,2026-08-03T00:00:00Z,4.25'].join('\n')
      );

      expect(result.errors).toEqual([]);
      expect(result.rows[0].cost).toBeCloseTo(4.25);
    });

    // BillingPeriodStart is the same month-start on every row of the export.
    // Reading the date from it would report a whole month of usage as landing
    // on the 1st, which is why only ChargePeriodStart is an alias.
    it('reads the date from ChargePeriodStart, not BillingPeriodStart', () => {
      expect(parseCsv(FOCUS_CSV).rows[0].usage_date).toBe('2026-08-03');
    });

    it('fills the line-item columns from their FOCUS names', () => {
      const row = parseCsv(FOCUS_CSV).rows[0];

      expect(row.resource_id).toContain('vm-web-01');
      expect(row.resource_group).toBe('rg-app');
      expect(row.region).toBe('eastus');
      expect(row.availability_zone).toBe('eastus-az1');
      expect(row.meter_category).toBe('Virtual Machines');
      expect(row.meter_name).toBe('D2s v3');
      expect(row.subscription_id).toBe('11111111-2222-3333-4444-555555555555');
      expect(row.subscription_name).toBe('Production');
      expect(row.purchase_type).toBe('Committed');
      expect(row.reservation_id).toContain('reservations/def');
      expect(row.reservation_name).toBe('vm-ri-3yr');
      expect(row.quantity).toBe(24);
      expect(row.unit).toBe('1 Hour');
      expect(row.unit_price).toBeCloseTo(0.9167);
      expect(row.effective_price).toBeCloseTo(0.8125);
      expect(row.currency).toBe('USD');
      expect(row.charge_type).toBe('Usage');
      expect(row.tags).toEqual({ env: 'prod' });
    });

    // ServiceName has to win over the x_SkuMeterCategory fallback, or every
    // FOCUS row would read "Virtual Machines" where the legacy export said
    // the same thing by accident and a Storage row would not.
    it('prefers ServiceName over the meter category for the service name', () => {
      const result = parseCsv(
        [
          'ServiceName,ChargePeriodStart,BilledCost,x_SkuMeterCategory',
          'Azure Database for PostgreSQL,2026-08-03T00:00:00Z,9.99,Storage',
        ].join('\n')
      );

      expect(result.rows[0].service_name).toBe('Azure Database for PostgreSQL');
      expect(result.rows[0].meter_category).toBe('Storage');
    });
  });

  // What the container-inspect diagnostic reports. Its whole value is that it
  // answers for the SAME alias lists parseCostFile resolves against, so these
  // tests are mostly about the two not drifting apart.
  describe('describeCostFileColumns', () => {
    it('names the header each field resolved to, and null for the ones absent', () => {
      const report = describeCostFileColumns(
        buildWorkbookBuffer([
          ['ServiceName', 'ChargePeriodStart', 'BilledCost', 'x_ResourceGroupName'],
          ['Virtual Machines', '2026-08-03', 18.4, 'rg-app'],
        ])
      );

      const headerFor = (field: string) => report.columns.find((c) => c.field === field)?.header;

      expect(report.headers).toEqual(['ServiceName', 'ChargePeriodStart', 'BilledCost', 'x_ResourceGroupName']);
      expect(headerFor('service_name')).toBe('ServiceName');
      expect(headerFor('usage_date')).toBe('ChargePeriodStart');
      expect(headerFor('cost')).toBe('BilledCost');
      expect(headerFor('resource_group')).toBe('x_ResourceGroupName');
      expect(headerFor('instance_type')).toBeNull();
      expect(report.missingRequired).toEqual([]);
    });

    // The point of the diagnostic is to explain a failed pull, so its labels
    // have to be the words that pull actually printed. If someone renames a
    // label without touching the parser's error, this fails.
    it('reports missing columns under the same names parseCostFile puts in its errors', () => {
      const buffer = buildWorkbookBuffer([
        ['Widget', 'When', 'HowMuch'],
        ['a', 'b', 'c'],
      ]);

      const { missingRequired } = describeCostFileColumns(buffer);
      const { errors } = parseCostFile(buffer);

      expect(missingRequired).toEqual(['Service', 'Date', 'Cost']);
      expect(missingRequired.map((label) => `Could not find a "${label}" column.`)).toEqual(errors);
    });

    // A FOCUS export resolves Service but not Date or Cost, which is exactly
    // the two-error shape the pull reported before FOCUS was recognised.
    it('reports only the required columns that are genuinely absent', () => {
      const { missingRequired } = describeCostFileColumns(
        buildWorkbookBuffer([['ServiceName', 'Widget'], ['Virtual Machines', 'x']])
      );

      expect(missingRequired).toEqual(['Date', 'Cost']);
    });

    it('lists CUR-style per-tag columns by their key', () => {
      const report = describeCostFileColumns(
        buildWorkbookBuffer([
          ['Service', 'Date', 'Cost', 'resourceTags/user:env', 'resource_tags/user_owner'],
          ['EC2', '2026-08-01', 1, 'prod', 'platform'],
        ])
      );

      expect(report.tagColumns).toEqual(['env', 'owner']);
    });

    // A field the table forgets is a field the diagnostic silently never
    // mentions, which is the one failure mode nobody would notice.
    it('covers every field a parsed row carries', () => {
      const parsed = parseCostFile(
        buildWorkbookBuffer([
          ['Service', 'Date', 'Cost'],
          ['EC2', '2026-08-01', 1],
        ])
      );

      expect([...COST_FILE_COLUMNS].map((c) => c.field).sort()).toEqual(Object.keys(parsed.rows[0]).sort());
    });

    it('reports an empty sheet without inventing columns', () => {
      const report = describeCostFileColumns(buildWorkbookBuffer([]));

      expect(report.headers).toEqual([]);
      expect(report.missingRequired).toEqual(['Service', 'Date', 'Cost']);
    });
  });
});

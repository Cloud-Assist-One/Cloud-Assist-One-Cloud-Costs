/**
 * @jest-environment node
 *
 * Route Handlers use the Web Request/Response globals, which the jsdom
 * environment (this project's default, for component tests) does not
 * provide. Node's environment has them natively.
 */
import { POST } from './route';

jest.mock('@/lib/admin-guard', () => ({
  requireAdmin: jest.fn(),
}));

jest.mock('@/lib/supabase/admin', () => ({
  createAdminClient: jest.fn(),
}));

jest.mock('@/lib/stripe', () => {
  const actual = jest.requireActual('@/lib/stripe');
  return { ...actual, getStripe: jest.fn() };
});

import { requireAdmin } from '@/lib/admin-guard';
import { createAdminClient } from '@/lib/supabase/admin';
import { getStripe } from '@/lib/stripe';

function request(body: unknown) {
  return new Request('http://localhost/api/billing/consulting/invoice', {
    method: 'POST',
    body: JSON.stringify(body),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
}

const companyRow = {
  id: 'company-1',
  name: 'Acme',
  stripe_customer_id: 'cus_existing',
  hourly_rate_cents: null,
};

const unbilledEntries = [
  { id: 'entry-1', entry_date: '2026-09-02', minutes_spent: 90, description: 'Cost review call' },
  { id: 'entry-2', entry_date: '2026-09-03', minutes_spent: 30, description: 'Tag cleanup' },
];

/**
 * Mirrors the exact query chains the route calls, so a change to the route's
 * shape (an added .eq, a renamed table) surfaces as a broken mock rather than
 * a silently-passing test.
 */
function stubAdminClient(options: {
  company?: Partial<typeof companyRow> | null;
  entries?: typeof unbilledEntries;
  stampError?: { message: string } | null;
} = {}) {
  const company = options.company === null ? null : { ...companyRow, ...options.company };
  const entries = options.entries ?? unbilledEntries;
  const stampError = options.stampError ?? null;

  const companyUpdateEq = jest.fn().mockResolvedValue({ error: null });
  const companyUpdate = jest.fn().mockReturnValue({ eq: companyUpdateEq });

  const timeEntriesUpdateIn = jest.fn().mockResolvedValue({ error: stampError });
  const timeEntriesUpdate = jest.fn().mockReturnValue({ in: timeEntriesUpdateIn });

  const order = jest.fn().mockResolvedValue({ data: entries, error: null });
  const is = jest.fn().mockReturnValue({ order });
  const entriesEq2 = jest.fn().mockReturnValue({ is });
  const entriesEq1 = jest.fn().mockReturnValue({ eq: entriesEq2 });
  const entriesSelect = jest.fn().mockReturnValue({ eq: entriesEq1 });

  const maybeSingle = jest.fn().mockResolvedValue({ data: company, error: null });
  const companyEq = jest.fn().mockReturnValue({ maybeSingle });
  const companySelect = jest.fn().mockReturnValue({ eq: companyEq });

  (createAdminClient as jest.Mock).mockReturnValue({
    from: (table: string) => {
      if (table === 'companies') return { select: companySelect, update: companyUpdate };
      if (table === 'time_entries') return { select: entriesSelect, update: timeEntriesUpdate };
      throw new Error(`unexpected table ${table}`);
    },
  });

  return { companyUpdate, companyUpdateEq, timeEntriesUpdate, timeEntriesUpdateIn, entriesSelect };
}

function stubStripe(overrides: { customersCreate?: jest.Mock } = {}) {
  const invoiceItemsCreate = jest.fn().mockResolvedValue({ id: 'ii_1' });
  const invoicesCreate = jest.fn().mockResolvedValue({ id: 'in_1' });
  const finalizeInvoice = jest.fn().mockResolvedValue({ id: 'in_1' });
  const sendInvoice = jest.fn().mockResolvedValue({ id: 'in_1' });
  const customersCreate = overrides.customersCreate ?? jest.fn().mockResolvedValue({ id: 'cus_new' });

  const stripeMock = {
    customers: { create: customersCreate },
    invoiceItems: { create: invoiceItemsCreate },
    invoices: { create: invoicesCreate, finalizeInvoice, sendInvoice },
  };
  (getStripe as jest.Mock).mockReturnValue(stripeMock);

  return {
    invoiceItems: { create: invoiceItemsCreate },
    invoicesCreate,
    finalizeInvoice,
    sendInvoice,
    customersCreate,
    stripeMock,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  (requireAdmin as jest.Mock).mockResolvedValue({ authorized: true, userId: 'admin-1' });
});

describe('POST /api/billing/consulting/invoice', () => {
  it('rejects a non-admin caller and never touches Stripe', async () => {
    (requireAdmin as jest.Mock).mockResolvedValue({
      authorized: false,
      status: 403,
      message: 'Admin access required.',
    });
    const stubs = stubAdminClient();
    const stripe = stubStripe();

    const response = await POST(request({ companyId: 'company-1' }));

    expect(response.status).toBe(403);
    expect(stripe.invoiceItems.create).not.toHaveBeenCalled();
    expect(stripe.invoicesCreate).not.toHaveBeenCalled();
    expect(stubs.entriesSelect).not.toHaveBeenCalled();
  });

  it('returns 400 with no Stripe call when the company has no unbilled entries', async () => {
    stubAdminClient({ entries: [] });
    const stripe = stubStripe();

    const response = await POST(request({ companyId: 'company-1' }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toMatch(/no unbilled/i);
    expect(stripe.invoiceItems.create).not.toHaveBeenCalled();
    expect(stripe.invoicesCreate).not.toHaveBeenCalled();
  });

  it('returns 404 and never calls Stripe when the company does not exist', async () => {
    stubAdminClient({ company: null });
    const stripe = stubStripe();

    const response = await POST(request({ companyId: 'missing' }));

    expect(response.status).toBe(404);
    expect(stripe.invoiceItems.create).not.toHaveBeenCalled();
  });

  it('creates one invoice item per entry with the expected idempotency keys, sends the invoice, and stamps every entry', async () => {
    const stubs = stubAdminClient();
    const stripe = stubStripe();

    const response = await POST(request({ companyId: 'company-1' }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.invoiceId).toBe('in_1');
    expect(body.entryCount).toBe(2);

    // One item per entry, priced and keyed off that entry.
    expect(stripe.invoiceItems.create).toHaveBeenCalledTimes(2);
    expect(stripe.invoiceItems.create).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ customer: 'cus_existing', amount: 26250 }),
      { idempotencyKey: 'ti_entry-1' }
    );
    expect(stripe.invoiceItems.create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ customer: 'cus_existing', amount: 8750 }),
      { idempotencyKey: 'ti_entry-2' }
    );

    // A customer already existed, so no new Stripe customer should be made.
    expect(stripe.customersCreate).not.toHaveBeenCalled();

    expect(stripe.finalizeInvoice).toHaveBeenCalledWith('in_1');
    expect(stripe.sendInvoice).toHaveBeenCalledWith('in_1');

    // Every unbilled entry -- not a subset -- gets stamped as billed.
    expect(stubs.timeEntriesUpdateIn).toHaveBeenCalledWith('id', ['entry-1', 'entry-2']);
    expect(stubs.timeEntriesUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ stripe_invoice_id: 'in_1' })
    );
  });

  it('creates a Stripe customer when the company has none yet', async () => {
    stubAdminClient({ company: { stripe_customer_id: null } });
    const stripe = stubStripe();

    await POST(request({ companyId: 'company-1' }));

    expect(stripe.customersCreate).toHaveBeenCalledTimes(1);
    const args = stripe.invoiceItems.create.mock.calls[0][0];
    expect(args.customer).toBe('cus_new');
  });

  it('surfaces the invoice id with a 500, not a silent success, when the database stamp fails after the invoice was sent', async () => {
    stubAdminClient({ stampError: { message: 'db unreachable' } });
    const stripe = stubStripe();

    const response = await POST(request({ companyId: 'company-1' }));
    const body = await response.json();

    // The invoice was already created and sent -- that must not be undone or
    // hidden. Silently reporting success here is exactly the double-billing
    // trap: a caller who sees 200 might re-run the request, and a caller who
    // sees a bare 500 with no invoice id has no way to reconcile Stripe
    // against the database by hand.
    expect(response.status).toBe(500);
    expect(body.invoiceId).toBe('in_1');
    expect(stripe.invoiceItems.create).toHaveBeenCalledTimes(2);
    expect(stripe.finalizeInvoice).toHaveBeenCalledWith('in_1');
    expect(stripe.sendInvoice).toHaveBeenCalledWith('in_1');
  });
});

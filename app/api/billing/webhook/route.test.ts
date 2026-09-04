/**
 * @jest-environment node
 *
 * Route Handlers use the Web Request/Response globals, which the jsdom
 * environment (this project's default, for component tests) does not
 * provide. Node's environment has them natively.
 */
import { POST } from './route';

jest.mock('@/lib/supabase/admin', () => ({
  createAdminClient: jest.fn(),
}));

jest.mock('@/lib/stripe', () => {
  const actual = jest.requireActual('@/lib/stripe');
  return { ...actual, getStripe: jest.fn() };
});

import { createAdminClient } from '@/lib/supabase/admin';
import { getStripe } from '@/lib/stripe';

function request(body: string) {
  return new Request('http://localhost/api/billing/webhook', {
    method: 'POST',
    headers: { 'stripe-signature': 'sig_test' },
    body,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
}

const checkoutEvent = {
  id: 'evt_1',
  type: 'checkout.session.completed',
  data: {
    object: {
      customer: 'cus_1',
      subscription: 'sub_1',
      metadata: { company_id: 'company-1', tier: 'subscription_4' },
    },
  },
};

/** Stubs the admin client's stripe_events insert/delete and companies update. */
function stubAdminClient(options: {
  claimError?: { code: string } | null;
  updateError?: { message: string } | null;
}) {
  const claimError = options.claimError ?? null;
  const updateError = options.updateError ?? null;

  const updateEq = jest.fn().mockResolvedValue({ error: updateError });
  const update = jest.fn().mockReturnValue({ eq: updateEq });

  const deleteEq = jest.fn().mockResolvedValue({ error: null });
  const del = jest.fn().mockReturnValue({ eq: deleteEq });

  const insert = jest.fn().mockResolvedValue({ error: claimError });

  (createAdminClient as jest.Mock).mockReturnValue({
    from: (table: string) => {
      if (table === 'stripe_events') return { insert, delete: del };
      if (table === 'companies') return { update };
      throw new Error(`unexpected table ${table}`);
    },
  });

  return { insert, update, updateEq, del, deleteEq };
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
  process.env.STRIPE_PRICE_SUB4 = 'price_sub4';
  process.env.STRIPE_PRICE_SUB20 = 'price_sub20';
});

describe('POST /api/billing/webhook', () => {
  it('rejects a bad signature and never touches the database', async () => {
    const constructEvent = jest.fn(() => {
      throw new Error('signature mismatch');
    });
    (getStripe as jest.Mock).mockReturnValue({ webhooks: { constructEvent } });
    const mocks = stubAdminClient({});

    const response = await POST(request(JSON.stringify(checkoutEvent)));

    expect(response.status).toBe(400);
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  // Regression test for Critical 1: an earlier version treated ANY claim
  // error as a duplicate, so this case alone would not distinguish a real
  // 23505 conflict from a transient failure. It must fail against that code.
  it('acknowledges a genuine duplicate (23505) without re-applying the update', async () => {
    (getStripe as jest.Mock).mockReturnValue({
      webhooks: { constructEvent: jest.fn(() => checkoutEvent) },
    });
    const mocks = stubAdminClient({ claimError: { code: '23505' } });

    const response = await POST(request(JSON.stringify(checkoutEvent)));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.duplicate).toBe(true);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('reports failure and does not tell Stripe to stop retrying on a non-duplicate claim error', async () => {
    (getStripe as jest.Mock).mockReturnValue({
      webhooks: { constructEvent: jest.fn(() => checkoutEvent) },
    });
    const mocks = stubAdminClient({ claimError: { code: '08006' } });

    const response = await POST(request(JSON.stringify(checkoutEvent)));

    expect(response.status).toBe(500);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('releases the claim and returns 500 when the company update fails', async () => {
    (getStripe as jest.Mock).mockReturnValue({
      webhooks: { constructEvent: jest.fn(() => checkoutEvent) },
    });
    const mocks = stubAdminClient({ updateError: { message: 'db down' } });

    const response = await POST(request(JSON.stringify(checkoutEvent)));

    expect(response.status).toBe(500);
    expect(mocks.del).toHaveBeenCalled();
    expect(mocks.deleteEq).toHaveBeenCalledWith('id', 'evt_1');
  });

  it('applies the update with the right match column and returns 200', async () => {
    (getStripe as jest.Mock).mockReturnValue({
      webhooks: { constructEvent: jest.fn(() => checkoutEvent) },
    });
    const mocks = stubAdminClient({});

    const response = await POST(request(JSON.stringify(checkoutEvent)));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.received).toBe(true);
    expect(mocks.update).toHaveBeenCalledWith({
      stripe_customer_id: 'cus_1',
      stripe_subscription_id: 'sub_1',
      subscription_tier: 'subscription_4',
      subscription_status: 'active',
    });
    expect(mocks.updateEq).toHaveBeenCalledWith('id', 'company-1');
  });
});

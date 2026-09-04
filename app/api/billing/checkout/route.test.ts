/**
 * @jest-environment node
 *
 * Route Handlers use the Web Request/Response globals, which the jsdom
 * environment (this project's default, for component tests) does not
 * provide. Node's environment has them natively.
 */
import { POST } from './route';

jest.mock('@/lib/admin-guard', () => ({
  requireCompanyAccess: jest.fn(),
}));

jest.mock('@/lib/supabase/admin', () => ({
  createAdminClient: jest.fn(),
}));

jest.mock('@/lib/stripe', () => {
  const actual = jest.requireActual('@/lib/stripe');
  return { ...actual, getStripe: jest.fn() };
});

import { requireCompanyAccess } from '@/lib/admin-guard';
import { createAdminClient } from '@/lib/supabase/admin';
import { getStripe } from '@/lib/stripe';

function request(body: unknown) {
  return new Request('http://localhost/api/billing/checkout', {
    method: 'POST',
    body: JSON.stringify(body),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
}

const companyRow = {
  id: 'company-1',
  stripe_customer_id: 'cus_existing',
  name: 'Acme',
};

function stubAdminClient() {
  const updates: Record<string, unknown>[] = [];
  (createAdminClient as jest.Mock).mockReturnValue({
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: () => Promise.resolve({ data: companyRow, error: null }) }),
      }),
      update: (values: Record<string, unknown>) => {
        updates.push(values);
        return { eq: () => Promise.resolve({ error: null }) };
      },
    }),
  });
  return updates;
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.STRIPE_PRICE_SUB4 = 'price_sub4';
  process.env.STRIPE_PRICE_SUB20 = 'price_sub20';
  (requireCompanyAccess as jest.Mock).mockResolvedValue({
    authorized: true,
    userId: 'user-1',
    role: 'client',
  });
});

describe('POST /api/billing/checkout', () => {
  it('rejects a caller who is not signed in', async () => {
    (requireCompanyAccess as jest.Mock).mockResolvedValue({
      authorized: false,
      status: 401,
      message: 'Not signed in.',
    });

    const response = await POST(request({ companyId: 'company-1', tier: 'subscription_4' }));

    expect(response.status).toBe(401);
  });

  it('refuses a tier that is not purchasable', async () => {
    stubAdminClient();

    const response = await POST(
      request({ companyId: 'company-1', tier: 'subscription_unlimited' })
    );

    expect(response.status).toBe(400);
  });

  it('ignores any price id the client tries to supply', async () => {
    stubAdminClient();
    const create = jest.fn().mockResolvedValue({ url: 'https://checkout.stripe.com/c/pay/123' });
    (getStripe as jest.Mock).mockReturnValue({ checkout: { sessions: { create } } });

    await POST(
      request({
        companyId: 'company-1',
        tier: 'subscription_4',
        priceId: 'price_attacker_zero_dollars',
      })
    );

    const args = create.mock.calls[0][0];
    expect(args.line_items[0].price).toBe('price_sub4');
  });

  it('returns the Stripe-hosted checkout url', async () => {
    stubAdminClient();
    const create = jest.fn().mockResolvedValue({ url: 'https://checkout.stripe.com/c/pay/123' });
    (getStripe as jest.Mock).mockReturnValue({ checkout: { sessions: { create } } });

    const response = await POST(request({ companyId: 'company-1', tier: 'subscription_4' }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.url).toBe('https://checkout.stripe.com/c/pay/123');

    const args = create.mock.calls[0][0];
    expect(args.mode).toBe('subscription');
    expect(args.customer).toBe('cus_existing');
    expect(args.metadata).toEqual({ company_id: 'company-1', tier: 'subscription_4' });
  });
});

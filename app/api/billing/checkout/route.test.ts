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
  stripe_subscription_id: null,
  subscription_status: null,
};

function stubAdminClient(overrides: Partial<typeof companyRow> = {}) {
  const updates: Record<string, unknown>[] = [];
  (createAdminClient as jest.Mock).mockReturnValue({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () =>
            Promise.resolve({ data: { ...companyRow, ...overrides }, error: null }),
        }),
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
  delete process.env.NEXT_PUBLIC_SITE_URL;
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

  it('builds the redirect urls from the trusted site url, not a forged request origin', async () => {
    // request.nextUrl.origin is derived from the incoming Host header, which
    // a caller can forge. NEXT_PUBLIC_SITE_URL must win whenever it is set,
    // or a forged Host could send a paying customer to an attacker's page
    // the instant they finish checkout.
    process.env.NEXT_PUBLIC_SITE_URL = 'https://trusted.example.com';
    stubAdminClient();
    const create = jest.fn().mockResolvedValue({ url: 'https://checkout.stripe.com/c/pay/123' });
    (getStripe as jest.Mock).mockReturnValue({ checkout: { sessions: { create } } });

    const req = request({ companyId: 'company-1', tier: 'subscription_4' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (req as any).nextUrl = { origin: 'https://attacker.example' };

    await POST(req);

    const args = create.mock.calls[0][0];
    expect(args.success_url).toBe('https://trusted.example.com/billing?checkout=success');
    expect(args.cancel_url).toBe('https://trusted.example.com/billing?checkout=cancelled');
  });

  describe('an existing subscription blocks a second Checkout Session', () => {
    it.each(['active', 'trialing', 'past_due'])(
      'refuses with 400 and never calls Stripe when the status is %s',
      async (status) => {
        stubAdminClient({ stripe_subscription_id: 'sub_existing', subscription_status: status });
        const create = jest.fn();
        (getStripe as jest.Mock).mockReturnValue({ checkout: { sessions: { create } } });

        const response = await POST(
          request({ companyId: 'company-1', tier: 'subscription_20' })
        );
        const body = await response.json();

        expect(response.status).toBe(400);
        expect(body.error).toMatch(/manage billing/i);
        expect(create).not.toHaveBeenCalled();
      }
    );

    it('still succeeds for a company with no subscription at all', async () => {
      stubAdminClient({ stripe_subscription_id: null, subscription_status: null });
      const create = jest.fn().mockResolvedValue({ url: 'https://checkout.stripe.com/c/pay/123' });
      (getStripe as jest.Mock).mockReturnValue({ checkout: { sessions: { create } } });

      const response = await POST(request({ companyId: 'company-1', tier: 'subscription_4' }));

      expect(response.status).toBe(200);
      expect(create).toHaveBeenCalledTimes(1);
    });

    it('still succeeds for a company whose subscription was canceled -- they genuinely need to re-subscribe', async () => {
      stubAdminClient({ stripe_subscription_id: 'sub_old', subscription_status: 'canceled' });
      const create = jest.fn().mockResolvedValue({ url: 'https://checkout.stripe.com/c/pay/123' });
      (getStripe as jest.Mock).mockReturnValue({ checkout: { sessions: { create } } });

      const response = await POST(request({ companyId: 'company-1', tier: 'subscription_4' }));

      expect(response.status).toBe(200);
      expect(create).toHaveBeenCalledTimes(1);
    });
  });
});

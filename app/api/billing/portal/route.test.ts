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
  return new Request('http://localhost/api/billing/portal', {
    method: 'POST',
    body: JSON.stringify(body),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
}

function stubAdminClient(company: Record<string, unknown> | null) {
  (createAdminClient as jest.Mock).mockReturnValue({
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: () => Promise.resolve({ data: company, error: null }) }),
      }),
    }),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.NEXT_PUBLIC_SITE_URL;
  (requireCompanyAccess as jest.Mock).mockResolvedValue({
    authorized: true,
    userId: 'user-1',
    role: 'client',
  });
});

describe('POST /api/billing/portal', () => {
  it('rejects an unauthorised caller without calling Stripe', async () => {
    (requireCompanyAccess as jest.Mock).mockResolvedValue({
      authorized: false,
      status: 403,
      message: 'You do not have access to this company.',
    });
    const create = jest.fn();
    (getStripe as jest.Mock).mockReturnValue({ billingPortal: { sessions: { create } } });

    const response = await POST(request({ companyId: 'company-1' }));

    expect(response.status).toBe(403);
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects a request missing companyId', async () => {
    const response = await POST(request({}));

    expect(response.status).toBe(400);
  });

  it('refuses a company with no Stripe customer yet, without calling Stripe', async () => {
    stubAdminClient({ id: 'company-1', stripe_customer_id: null });
    const create = jest.fn();
    (getStripe as jest.Mock).mockReturnValue({ billingPortal: { sessions: { create } } });

    const response = await POST(request({ companyId: 'company-1' }));

    expect(response.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it('creates a portal session for the existing customer, using the trusted origin', async () => {
    // Same forged-Host concern as checkout: request.nextUrl.origin must lose
    // to NEXT_PUBLIC_SITE_URL, since a portal session exposes invoices and
    // saved card details behind the return_url.
    process.env.NEXT_PUBLIC_SITE_URL = 'https://trusted.example.com';
    stubAdminClient({ id: 'company-1', stripe_customer_id: 'cus_existing' });
    const create = jest.fn().mockResolvedValue({ url: 'https://billing.stripe.com/session/abc' });
    (getStripe as jest.Mock).mockReturnValue({ billingPortal: { sessions: { create } } });

    const req = request({ companyId: 'company-1' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (req as any).nextUrl = { origin: 'https://attacker.example' };

    const response = await POST(req);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.url).toBe('https://billing.stripe.com/session/abc');

    const args = create.mock.calls[0][0];
    expect(args.customer).toBe('cus_existing');
    expect(args.return_url).toBe('https://trusted.example.com/billing');
  });
});

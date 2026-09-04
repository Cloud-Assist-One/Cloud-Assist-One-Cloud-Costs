import { requireActiveBilling } from './billingGuard';
import { fetchCompanyAccess } from '@/lib/companyBilling';
import type { CompanyAccess } from '@/lib/companyAccess';

// requireActiveBilling is the real enforcement point -- it is what stops an
// expired account from POSTing directly to a mutating route. Mock the
// lookup and the admin client so each CompanyAccess state can be driven
// directly, without a real Supabase client ever being constructed.
jest.mock('@/lib/companyBilling');
jest.mock('@/lib/supabase/admin', () => ({
  createAdminClient: jest.fn(() => ({})),
}));

const mockedFetchCompanyAccess = fetchCompanyAccess as jest.MockedFunction<typeof fetchCompanyAccess>;

describe('requireActiveBilling', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('denies with a 403 and the trial-ended message when access is trial_expired', async () => {
    mockedFetchCompanyAccess.mockResolvedValue({ state: 'trial_expired', trialEndsAt: null });

    const result = await requireActiveBilling('company-1');

    expect(result).toEqual({
      allowed: false,
      status: 403,
      message: 'Your free trial has ended. Add a payment method to continue.',
    });
  });

  const allowedStates: CompanyAccess[] = [
    { state: 'trialing', daysLeft: 3, trialEndsAt: '2026-09-10T00:00:00.000Z' },
    { state: 'active', tier: 'subscription_4' },
    // Deliberate: a customer whose card just failed keeps working while
    // Stripe retries, so past_due must pass through, not lock.
    { state: 'past_due', tier: 'subscription_4' },
    { state: 'exempt', tier: 'subscription_unlimited' },
  ];

  it.each(allowedStates)('allows access when the state is $state', async (access) => {
    mockedFetchCompanyAccess.mockResolvedValue(access);

    const result = await requireActiveBilling('company-1');

    expect(result).toEqual({ allowed: true });
  });
});

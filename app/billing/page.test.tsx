import type { ReactElement } from 'react';
import { render, screen } from '@testing-library/react';
import BillingPage from './page';
import LoginForm from '@/components/auth/LoginForm';
import PlanCards from '@/components/billing/PlanCards';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { fetchCompanyAccess } from '@/lib/companyBilling';

// BillingPage is an async Server Component -- called directly here, the same
// way app/page.test.tsx exercises Home(), rather than rendered. JSX only
// builds a tree of plain element objects; it never invokes a component
// function on its own.
jest.mock('@/lib/supabase/server', () => ({ createClient: jest.fn() }));
jest.mock('@/lib/supabase/admin', () => ({ createAdminClient: jest.fn() }));
jest.mock('@/lib/companyBilling', () => ({ fetchCompanyAccess: jest.fn() }));

const mockedCreateClient = createClient as jest.MockedFunction<typeof createClient>;
const mockedCreateAdminClient = createAdminClient as jest.MockedFunction<typeof createAdminClient>;
const mockedFetchCompanyAccess = fetchCompanyAccess as jest.MockedFunction<typeof fetchCompanyAccess>;

function containsType(node: unknown, type: unknown): boolean {
  if (node === null || node === undefined || typeof node !== 'object') return false;
  if (Array.isArray(node)) return node.some((child) => containsType(child, type));
  const element = node as ReactElement;
  if (element.type === type) return true;
  return containsType(element.props?.children, type);
}

function stubSupabase(
  user: { id: string } | null,
  profile: { company_id: string | null } | null
) {
  mockedCreateClient.mockResolvedValue({
    auth: { getUser: jest.fn().mockResolvedValue({ data: { user } }) },
    from: jest.fn(() => ({
      select: jest.fn(() => ({
        eq: jest.fn(() => ({
          single: jest.fn().mockResolvedValue({ data: profile }),
        })),
      })),
    })),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
}

// A distinct client from stubSupabase's: app/billing/page.tsx queries
// `companies.stripe_customer_id` through createAdminClient(), separately
// from the `profiles.company_id` lookup on the request-scoped client.
function stubAdminClient(stripeCustomerId: string | null) {
  mockedCreateAdminClient.mockReturnValue({
    from: jest.fn(() => ({
      select: jest.fn(() => ({
        eq: jest.fn(() => ({
          maybeSingle: jest.fn().mockResolvedValue({ data: { stripe_customer_id: stripeCustomerId } }),
        })),
      })),
    })),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('BillingPage', () => {
  it('shows the login form when no user is signed in', async () => {
    stubSupabase(null, null);

    const ui = await BillingPage();

    expect(containsType(ui, LoginForm)).toBe(true);
    expect(containsType(ui, PlanCards)).toBe(false);
  });

  it('renders a fallback instead of crashing when no company is linked to the account', async () => {
    stubSupabase({ id: 'user-1' }, { company_id: null });

    const ui = await BillingPage();
    render(ui);

    expect(screen.getByText(/no company is linked to your account/i)).toBeInTheDocument();
    // fetchCompanyAccess needs a company id -- it must never be called with
    // none, since that would silently mask this branch not firing.
    expect(mockedFetchCompanyAccess).not.toHaveBeenCalled();
  });

  it('shows the days-left message while trialing, and passes hasCustomer=false to PlanCards', async () => {
    stubSupabase({ id: 'user-1' }, { company_id: 'company-1' });
    stubAdminClient(null);
    mockedFetchCompanyAccess.mockResolvedValue({
      state: 'trialing',
      daysLeft: 5,
      trialEndsAt: '2026-09-10T00:00:00.000Z',
    });

    const ui = await BillingPage();
    render(ui);

    expect(screen.getByText(/5 days left in your free trial/i)).toBeInTheDocument();
    // No stripe_customer_id on the company -> no Manage Billing button
    // anywhere on the page, since PlanCards received hasCustomer=false.
    expect(screen.queryByRole('button', { name: /manage billing/i })).not.toBeInTheDocument();
  });

  it('shows the trial-ended message when trial_expired', async () => {
    stubSupabase({ id: 'user-1' }, { company_id: 'company-1' });
    stubAdminClient(null);
    mockedFetchCompanyAccess.mockResolvedValue({ state: 'trial_expired', trialEndsAt: null });

    const ui = await BillingPage();
    render(ui);

    expect(screen.getByText(/your trial has ended\. choose a plan to restore access\./i)).toBeInTheDocument();
  });

  it('shows the failed-payment message when past_due, and passes hasCustomer=true to PlanCards', async () => {
    stubSupabase({ id: 'user-1' }, { company_id: 'company-1' });
    stubAdminClient('cus_existing');
    mockedFetchCompanyAccess.mockResolvedValue({ state: 'past_due', tier: 'subscription_4' });

    const ui = await BillingPage();
    render(ui);

    expect(screen.getByText(/your last payment failed/i)).toBeInTheDocument();
    // The company has a stripe_customer_id -> a Manage Billing control must
    // reach the page, proving hasCustomer=true made it into PlanCards.
    expect(screen.getAllByRole('button', { name: /manage billing/i }).length).toBeGreaterThan(0);
  });

  it('shows no state banner for an active company, and still passes hasCustomer=true through', async () => {
    stubSupabase({ id: 'user-1' }, { company_id: 'company-1' });
    stubAdminClient('cus_existing');
    mockedFetchCompanyAccess.mockResolvedValue({ state: 'active', tier: 'subscription_4' });

    const ui = await BillingPage();
    render(ui);

    expect(screen.queryByText(/free trial/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/payment failed/i)).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /manage billing/i }).length).toBeGreaterThan(0);
  });
});

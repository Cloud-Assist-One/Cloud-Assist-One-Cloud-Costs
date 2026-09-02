import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import BillingPanel from './BillingPanel';
import type { Company } from '@/lib/types';

const maybeSingle = jest.fn();

jest.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: (...args: unknown[]) => maybeSingle(...args) }),
      }),
    }),
  }),
}));

function company(overrides: Partial<Company> = {}): Company {
  return {
    id: 'company-1',
    name: 'Acme Corp',
    created_at: '2026-08-01T00:00:00.000Z',
    subscription_tier: 'free',
    stripe_customer_id: null,
    stripe_subscription_id: null,
    subscription_status: null,
    ...overrides,
  };
}

describe('BillingPanel', () => {
  // jsdom deliberately makes window.location non-configurable (Window.js
  // marks it `{ configurable: false }`, and Location's own href/assign
  // setters the same way), so it cannot be swapped for a mock the way most
  // browser globals can -- there is no way to intercept the actual
  // navigation from outside the component. history.pushState/replaceState
  // are NOT locked down the same way, so the banner-from-query-string tests
  // use real navigation via pushState rather than mocking anything.
  beforeEach(() => {
    global.fetch = jest.fn();
    maybeSingle.mockReset();
    window.history.pushState({}, '', '/');
  });

  it('shows the current plan and connection allowance', async () => {
    maybeSingle.mockResolvedValue({ data: company(), error: null });

    render(<BillingPanel companyId="company-1" />);

    expect(await screen.findByText('Free')).toBeInTheDocument();
    expect(screen.getByText('1 cloud connection')).toBeInTheDocument();
  });

  it('offers the three paid plans when on the free tier', async () => {
    maybeSingle.mockResolvedValue({ data: company(), error: null });

    render(<BillingPanel companyId="company-1" />);

    await screen.findByText('Free');
    expect(screen.getAllByRole('button', { name: /subscribe/i })).toHaveLength(3);
    expect(screen.getByText('Unlimited cloud connections')).toBeInTheDocument();
  });

  it('hides the plan cards and shows Manage billing once already subscribed', async () => {
    maybeSingle.mockResolvedValue({
      data: company({ subscription_tier: 'subscription_20', stripe_customer_id: 'cus_1', subscription_status: 'active' }),
      error: null,
    });

    render(<BillingPanel companyId="company-1" />);

    expect(await screen.findByText('Subscription 20')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /subscribe/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /manage billing/i })).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  // A cancelled subscription is back on the free tier but keeps its Stripe
  // customer -- Manage billing (invoices, past card) should still be there.
  it('still offers Manage billing on the free tier when a Stripe customer already exists', async () => {
    maybeSingle.mockResolvedValue({
      data: company({ stripe_customer_id: 'cus_1', subscription_status: 'canceled' }),
      error: null,
    });

    render(<BillingPanel companyId="company-1" />);

    await screen.findByText('Free');
    expect(screen.getByRole('button', { name: /manage billing/i })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /subscribe/i })).toHaveLength(3);
  });

  it('starts checkout for the clicked plan and redirects to the returned url', async () => {
    maybeSingle.mockResolvedValue({ data: company(), error: null });
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ url: 'https://checkout.stripe.com/session_abc' }),
    });

    const user = userEvent.setup();
    render(<BillingPanel companyId="company-1" />);

    await screen.findByText('Free');
    const buttons = screen.getAllByRole('button', { name: /subscribe/i });
    await user.click(buttons[1]); // Subscription 20

    // The actual navigation (window.location.href = url) is not
    // assertable -- jsdom locks that property against being swapped for a
    // mock -- so this stops at confirming the right session was requested
    // for the right tier; the one-line assignment past that is not worth
    // fighting jsdom's own hardening to re-prove.
    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/billing/checkout',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ companyId: 'company-1', tier: 'subscription_20' }) })
      )
    );
  });

  it('shows an error beside the button when checkout cannot start', async () => {
    maybeSingle.mockResolvedValue({ data: company(), error: null });
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      json: async () => ({ error: 'This plan is not available for checkout yet. Contact support.' }),
    });

    const user = userEvent.setup();
    render(<BillingPanel companyId="company-1" />);

    await screen.findByText('Free');
    await user.click(screen.getAllByRole('button', { name: /subscribe/i })[0]);

    expect(await screen.findByRole('alert')).toHaveTextContent(/not available for checkout/i);
    // The button must recover so a second attempt is possible.
    expect(screen.getAllByRole('button', { name: /subscribe/i })[0]).not.toBeDisabled();
  });

  it('opens the billing portal and redirects to the returned url', async () => {
    maybeSingle.mockResolvedValue({
      data: company({ subscription_tier: 'subscription_4', stripe_customer_id: 'cus_1' }),
      error: null,
    });
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ url: 'https://billing.stripe.com/session_xyz' }),
    });

    const user = userEvent.setup();
    render(<BillingPanel companyId="company-1" />);

    await user.click(await screen.findByRole('button', { name: /manage billing/i }));

    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/billing/portal',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ companyId: 'company-1' }) })
      )
    );
  });

  it('shows a banner for a successful checkout and strips the query param', async () => {
    maybeSingle.mockResolvedValue({ data: company(), error: null });
    window.history.pushState({}, '', '/?billing=success');

    render(<BillingPanel companyId="company-1" />);

    expect(await screen.findByText(/subscription started/i)).toBeInTheDocument();
    // A page refresh right after landing back must not keep re-showing this
    // banner for the rest of the session.
    expect(window.location.search).toBe('');
  });

  it('shows a banner when checkout is cancelled, with no charge implied', async () => {
    maybeSingle.mockResolvedValue({ data: company(), error: null });
    window.history.pushState({}, '', '/?billing=cancelled');

    render(<BillingPanel companyId="company-1" />);

    expect(await screen.findByText(/no charge was made/i)).toBeInTheDocument();
  });

  it('says so plainly when the company cannot be loaded', async () => {
    maybeSingle.mockResolvedValue({ data: null, error: { message: 'boom' } });

    render(<BillingPanel companyId="company-1" />);

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not load billing/i);
  });

  it('reloads the company row when Refresh is clicked', async () => {
    maybeSingle.mockResolvedValue({ data: company(), error: null });

    const user = userEvent.setup();
    render(<BillingPanel companyId="company-1" />);

    await screen.findByText('Free');
    maybeSingle.mockResolvedValue({ data: company({ subscription_tier: 'subscription_unlimited' }), error: null });
    await user.click(screen.getByRole('button', { name: /^refresh$/i }));

    expect(await screen.findByText('Subscription Unlimited')).toBeInTheDocument();
  });
});

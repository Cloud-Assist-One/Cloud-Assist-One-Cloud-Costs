import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PlanCards from './PlanCards';

const trialingAccess = { state: 'trialing', daysLeft: 10, trialEndsAt: '2026-09-27T12:00:00Z' } as const;

describe('PlanCards', () => {
  beforeEach(() => {
    global.fetch = jest.fn();
    // The component writes window.location.href after a successful
    // checkout/portal call. jsdom doesn't implement real navigation and logs
    // a harmless "not implemented" error for it; that console noise doesn't
    // affect the assertions below, so it's left alone rather than fighting
    // jsdom's non-configurable location property.
  });

  it('disables and marks the current tier instead of offering it for purchase', () => {
    render(
      <PlanCards
        companyId="company-1"
        access={{ state: 'active', tier: 'subscription_4' }}
        hasCustomer
      />
    );

    const currentButton = screen.getByRole('button', { name: /current plan/i });
    expect(currentButton).toBeDisabled();

    const otherButton = screen.getByRole('button', { name: /choose subscription 20/i });
    expect(otherButton).not.toBeDisabled();
  });

  it('also treats an admin-granted (exempt) tier as the current plan', () => {
    render(
      <PlanCards
        companyId="company-1"
        access={{ state: 'exempt', tier: 'subscription_20' }}
        hasCustomer={false}
      />
    );

    expect(screen.getByRole('button', { name: /current plan/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /choose subscription 4/i })).not.toBeDisabled();
  });

  it('surfaces the server error message when checkout fails', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: 'That plan is not available to buy.' }),
    });
    const user = userEvent.setup();

    render(<PlanCards companyId="company-1" access={trialingAccess} hasCustomer={false} />);

    await user.click(screen.getByRole('button', { name: /choose subscription 4/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('That plan is not available to buy.');
    // A failed request must leave the button clickable again, not stuck busy.
    expect(screen.getByRole('button', { name: /choose subscription 4/i })).not.toBeDisabled();
  });

  it('falls back to a generic message when the failed response has no error field', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: false, json: async () => ({}) });
    const user = userEvent.setup();

    render(<PlanCards companyId="company-1" access={trialingAccess} hasCustomer={false} />);

    await user.click(screen.getByRole('button', { name: /choose subscription 20/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/something went wrong/i);
  });

  it('shows Manage billing only when the company already has a Stripe customer', () => {
    const { rerender } = render(
      <PlanCards companyId="company-1" access={trialingAccess} hasCustomer={false} />
    );
    expect(screen.queryByRole('button', { name: /manage billing/i })).not.toBeInTheDocument();

    rerender(<PlanCards companyId="company-1" access={trialingAccess} hasCustomer />);
    expect(screen.getByRole('button', { name: /manage billing/i })).toBeInTheDocument();
  });

  it('sends only companyId and tier to checkout, never a price id', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ url: 'https://checkout.stripe.com/session' }),
    });
    const user = userEvent.setup();

    render(<PlanCards companyId="company-1" access={trialingAccess} hasCustomer={false} />);

    await user.click(screen.getByRole('button', { name: /choose subscription 4/i }));

    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('/api/billing/checkout');
    expect(JSON.parse(init.body)).toEqual({ companyId: 'company-1', tier: 'subscription_4' });
  });
});

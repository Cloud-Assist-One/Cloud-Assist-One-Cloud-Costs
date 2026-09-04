import { render, screen } from '@testing-library/react';
import TrialBanner from './TrialBanner';

describe('TrialBanner', () => {
  it('shows the days remaining during a trial', () => {
    render(
      <TrialBanner access={{ state: 'trialing', daysLeft: 23, trialEndsAt: '2026-09-27T12:00:00Z' }} />
    );

    expect(screen.getByText(/23 days left/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /add payment method/i })).toBeInTheDocument();
  });

  it('uses the singular on the final day', () => {
    render(
      <TrialBanner access={{ state: 'trialing', daysLeft: 1, trialEndsAt: '2026-09-05T12:00:00Z' }} />
    );

    expect(screen.getByText(/1 day left/i)).toBeInTheDocument();
  });

  it('warns urgently when a payment has failed', () => {
    render(<TrialBanner access={{ state: 'past_due', tier: 'subscription_4' }} />);

    expect(screen.getByText(/payment failed/i)).toBeInTheDocument();
  });

  it('renders nothing for a paying customer', () => {
    const { container } = render(
      <TrialBanner access={{ state: 'active', tier: 'subscription_4' }} />
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for an admin-granted account', () => {
    const { container } = render(
      <TrialBanner access={{ state: 'exempt', tier: 'subscription_unlimited' }} />
    );

    expect(container).toBeEmptyDOMElement();
  });
});

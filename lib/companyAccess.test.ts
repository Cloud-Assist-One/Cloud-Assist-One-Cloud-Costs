import { resolveCompanyAccess, trialDaysLeft } from './companyAccess';

const NOW = new Date('2026-09-04T12:00:00Z');

function daysFromNow(days: number): string {
  return new Date(NOW.getTime() + days * 86_400_000).toISOString();
}

describe('resolveCompanyAccess', () => {
  it('treats a paid tier with no Stripe subscription as exempt', () => {
    const access = resolveCompanyAccess(
      {
        subscription_tier: 'subscription_unlimited',
        trial_ends_at: null,
        stripe_subscription_id: null,
        subscription_status: null,
      },
      NOW
    );

    expect(access).toEqual({ state: 'exempt', tier: 'subscription_unlimited' });
  });

  it('reports past_due for a paid tier whose card failed', () => {
    const access = resolveCompanyAccess(
      {
        subscription_tier: 'subscription_4',
        trial_ends_at: null,
        stripe_subscription_id: 'sub_123',
        subscription_status: 'past_due',
      },
      NOW
    );

    expect(access).toEqual({ state: 'past_due', tier: 'subscription_4' });
  });

  it('reports active for a paid tier in good standing', () => {
    const access = resolveCompanyAccess(
      {
        subscription_tier: 'subscription_20',
        trial_ends_at: null,
        stripe_subscription_id: 'sub_123',
        subscription_status: 'active',
      },
      NOW
    );

    expect(access).toEqual({ state: 'active', tier: 'subscription_20' });
  });

  it('counts down a free company still inside its trial', () => {
    const access = resolveCompanyAccess(
      {
        subscription_tier: 'free',
        trial_ends_at: daysFromNow(23),
        stripe_subscription_id: null,
        subscription_status: null,
      },
      NOW
    );

    expect(access.state).toBe('trialing');
    if (access.state === 'trialing') expect(access.daysLeft).toBe(23);
  });

  it('expires the moment the trial end is reached', () => {
    const access = resolveCompanyAccess(
      {
        subscription_tier: 'free',
        trial_ends_at: NOW.toISOString(),
        stripe_subscription_id: null,
        subscription_status: null,
      },
      NOW
    );

    expect(access.state).toBe('trial_expired');
  });

  it('locks a free company whose trial is long past', () => {
    const access = resolveCompanyAccess(
      {
        subscription_tier: 'free',
        trial_ends_at: daysFromNow(-60),
        stripe_subscription_id: null,
        subscription_status: null,
      },
      NOW
    );

    expect(access.state).toBe('trial_expired');
  });

  it('locks a paid tier whose subscription is canceled', () => {
    const access = resolveCompanyAccess(
      {
        subscription_tier: 'subscription_4',
        trial_ends_at: null,
        stripe_subscription_id: 'sub_123',
        subscription_status: 'canceled',
      },
      NOW
    );

    expect(access.state).toBe('trial_expired');
  });

  it('locks a paid tier whose subscription is incomplete', () => {
    const access = resolveCompanyAccess(
      {
        subscription_tier: 'subscription_20',
        trial_ends_at: null,
        stripe_subscription_id: 'sub_123',
        subscription_status: 'incomplete',
      },
      NOW
    );

    expect(access.state).toBe('trial_expired');
  });

  it('locks a paid tier whose subscription status is null', () => {
    const access = resolveCompanyAccess(
      {
        subscription_tier: 'subscription_4',
        trial_ends_at: null,
        stripe_subscription_id: 'sub_123',
        subscription_status: null,
      },
      NOW
    );

    expect(access.state).toBe('trial_expired');
  });

  it('locks rather than opens when the row is missing', () => {
    expect(resolveCompanyAccess(null, NOW).state).toBe('trial_expired');
  });

  it('locks rather than opens on an unrecognised tier', () => {
    const access = resolveCompanyAccess(
      {
        subscription_tier: 'enterprise_gold',
        trial_ends_at: null,
        stripe_subscription_id: null,
        subscription_status: null,
      },
      NOW
    );

    expect(access.state).toBe('trial_expired');
  });

  it('locks rather than opens when a free company has no trial date', () => {
    const access = resolveCompanyAccess(
      {
        subscription_tier: 'free',
        trial_ends_at: null,
        stripe_subscription_id: null,
        subscription_status: null,
      },
      NOW
    );

    expect(access.state).toBe('trial_expired');
  });
});

describe('trialDaysLeft', () => {
  it('rounds a partial day up, so 30.5 days reads as 31', () => {
    expect(trialDaysLeft(daysFromNow(30.5), NOW)).toBe(31);
  });

  it('never goes negative', () => {
    expect(trialDaysLeft(daysFromNow(-5), NOW)).toBe(0);
  });

  it('is 0 for a null date', () => {
    expect(trialDaysLeft(null, NOW)).toBe(0);
  });

  it('is 0 for a malformed date string', () => {
    expect(trialDaysLeft('not-a-date', NOW)).toBe(0);
  });
});

describe('resolveCompanyAccess with malformed data', () => {
  it('locks rather than opens when trial_ends_at is malformed', () => {
    const access = resolveCompanyAccess(
      {
        subscription_tier: 'free',
        trial_ends_at: 'garbage-date',
        stripe_subscription_id: null,
        subscription_status: null,
      },
      NOW
    );

    expect(access.state).toBe('trial_expired');
  });
});

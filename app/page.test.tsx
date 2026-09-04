import type { ReactElement } from 'react';
import Home from './page';
import AppShell from '@/components/shell/AppShell';
import TrialExpired from '@/components/billing/TrialExpired';
import TrialBanner from '@/components/billing/TrialBanner';
import LoginForm from '@/components/auth/LoginForm';
import { createClient } from '@/lib/supabase/server';
import { fetchCompanyAccess } from '@/lib/companyBilling';

// Home is an async Server Component -- called directly here, not rendered.
// JSX only builds a tree of plain element objects; it never invokes a
// component function. So walking the returned tree for AppShell/TrialExpired
// by identity proves what actually got composed (the real hard-lock logic)
// without ever executing AppShell's client-only hooks (useState,
// useSyncExternalStore, etc.), which would blow up outside a real DOM.
jest.mock('@/lib/supabase/server', () => ({ createClient: jest.fn() }));
jest.mock('@/lib/supabase/admin', () => ({ createAdminClient: jest.fn(() => ({})) }));
jest.mock('@/lib/companyBilling', () => ({ fetchCompanyAccess: jest.fn() }));

const mockedCreateClient = createClient as jest.MockedFunction<typeof createClient>;
const mockedFetchCompanyAccess = fetchCompanyAccess as jest.MockedFunction<typeof fetchCompanyAccess>;

function containsType(node: unknown, type: unknown): boolean {
  if (node === null || node === undefined || typeof node !== 'object') return false;
  if (Array.isArray(node)) return node.some((child) => containsType(child, type));
  const element = node as ReactElement;
  if (element.type === type) return true;
  return containsType(element.props?.children, type);
}

function stubSupabase(
  user: { id: string; email: string } | null,
  profile: { role: string; company_id: string | null } | null
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

beforeEach(() => {
  jest.clearAllMocks();
});

describe('Home', () => {
  it('locks a client whose trial has expired -- AppShell never reaches the tree', async () => {
    stubSupabase({ id: 'user-1', email: 'client@example.com' }, { role: 'client', company_id: 'company-1' });
    mockedFetchCompanyAccess.mockResolvedValue({ state: 'trial_expired', trialEndsAt: null });

    const ui = await Home();

    expect(containsType(ui, TrialExpired)).toBe(true);
    expect(containsType(ui, AppShell)).toBe(false);
  });

  it('shows AppShell plus the countdown banner for a trialing client', async () => {
    stubSupabase({ id: 'user-1', email: 'client@example.com' }, { role: 'client', company_id: 'company-1' });
    mockedFetchCompanyAccess.mockResolvedValue({
      state: 'trialing',
      daysLeft: 5,
      trialEndsAt: '2026-09-10T00:00:00.000Z',
    });

    const ui = await Home();

    expect(containsType(ui, AppShell)).toBe(true);
    expect(containsType(ui, TrialBanner)).toBe(true);
    expect(containsType(ui, TrialExpired)).toBe(false);
  });

  it('never locks staff out of a client company whose trial expired', async () => {
    stubSupabase({ id: 'staff-1', email: 'staff@example.com' }, { role: 'staff', company_id: 'company-1' });
    mockedFetchCompanyAccess.mockResolvedValue({ state: 'trial_expired', trialEndsAt: null });

    const ui = await Home();

    expect(containsType(ui, AppShell)).toBe(true);
    expect(containsType(ui, TrialExpired)).toBe(false);
  });

  it('never locks an admin out of a client company whose trial expired', async () => {
    stubSupabase({ id: 'admin-1', email: 'admin@example.com' }, { role: 'admin', company_id: 'company-1' });
    mockedFetchCompanyAccess.mockResolvedValue({ state: 'trial_expired', trialEndsAt: null });

    const ui = await Home();

    expect(containsType(ui, AppShell)).toBe(true);
    expect(containsType(ui, TrialExpired)).toBe(false);
  });

  it('shows the login form when no user is signed in', async () => {
    stubSupabase(null, null);

    const ui = await Home();

    expect(containsType(ui, LoginForm)).toBe(true);
    expect(containsType(ui, AppShell)).toBe(false);
  });
});

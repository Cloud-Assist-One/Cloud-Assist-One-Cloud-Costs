import { collectAuthActivity, describeAccountStatus, mergeAuthActivity } from './adminUserActivity';
import type { AuthUserPage } from './adminUserActivity';
import type { Profile } from './types';

function profile(id: string, overrides: Partial<Profile> = {}): Profile {
  return {
    id,
    company_id: 'company-1',
    email: `${id}@example.com`,
    role: 'client',
    created_at: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('collectAuthActivity', () => {
  it('reads both timestamps off a single page', async () => {
    const activity = await collectAuthActivity(async () => ({
      users: [{ id: 'u1', email_confirmed_at: '2026-08-02T10:00:00Z', last_sign_in_at: '2026-08-30T09:00:00Z' }],
      nextPage: null,
    }));

    expect(activity.get('u1')).toEqual({
      id: 'u1',
      emailConfirmedAt: '2026-08-02T10:00:00Z',
      lastSignInAt: '2026-08-30T09:00:00Z',
    });
  });

  // Stopping after page one would leave everyone past it looking as though
  // they had never signed in, which is exactly the state this reports.
  it('walks every page', async () => {
    const pages: Record<number, AuthUserPage> = {
      1: { users: [{ id: 'u1', last_sign_in_at: '2026-08-30T09:00:00Z' }], nextPage: 2 },
      2: { users: [{ id: 'u2', last_sign_in_at: '2026-08-29T09:00:00Z' }], nextPage: 3 },
      3: { users: [{ id: 'u3', last_sign_in_at: null }], nextPage: null },
    };
    const listPage = jest.fn(async (page: number) => pages[page]);

    const activity = await collectAuthActivity(listPage);

    expect(listPage).toHaveBeenCalledTimes(3);
    expect([...activity.keys()]).toEqual(['u1', 'u2', 'u3']);
    expect(activity.get('u3')?.lastSignInAt).toBeNull();
  });

  // The admin API omits these keys rather than nulling them, and undefined
  // would read as "no data" where null means "never happened".
  it('normalises an omitted timestamp to null', async () => {
    const activity = await collectAuthActivity(async () => ({ users: [{ id: 'u1' }], nextPage: null }));

    expect(activity.get('u1')).toEqual({ id: 'u1', emailConfirmedAt: null, lastSignInAt: null });
  });

  // A partial map renders as "never signed in" for everyone missing from it,
  // so a failed page has to be louder than a quiet gap.
  it('propagates a failing page rather than returning a partial map', async () => {
    const listPage = jest.fn(async (page: number) => {
      if (page === 2) throw new Error('rate limited');
      return { users: [{ id: 'u1' }], nextPage: 2 } as AuthUserPage;
    });

    await expect(collectAuthActivity(listPage)).rejects.toThrow('rate limited');
  });

  it('gives up rather than spinning on a listing that never ends', async () => {
    const listPage = jest.fn(async (page: number) => ({ users: [{ id: `u${page}` }], nextPage: page + 1 }));

    const activity = await collectAuthActivity(listPage);

    expect(listPage).toHaveBeenCalledTimes(200);
    expect(activity.size).toBe(200);
  });
});

describe('mergeAuthActivity', () => {
  it('joins the timestamps onto their profile', () => {
    const rows = mergeAuthActivity(
      [profile('u1')],
      new Map([['u1', { id: 'u1', emailConfirmedAt: '2026-08-02T10:00:00Z', lastSignInAt: '2026-08-30T09:00:00Z' }]])
    );

    expect(rows[0]).toMatchObject({
      id: 'u1',
      email: 'u1@example.com',
      email_confirmed_at: '2026-08-02T10:00:00Z',
      last_sign_in_at: '2026-08-30T09:00:00Z',
    });
  });

  // The row is still an account someone may need to revoke; dropping it to
  // tidy up a join would take that away.
  it('keeps a profile with no matching auth user, with nulls', () => {
    const rows = mergeAuthActivity([profile('u1'), profile('u2')], new Map());

    expect(rows).toHaveLength(2);
    expect(rows[0].email_confirmed_at).toBeNull();
    expect(rows[0].last_sign_in_at).toBeNull();
  });

  it('preserves the order the profiles arrived in', () => {
    const rows = mergeAuthActivity([profile('u3'), profile('u1'), profile('u2')], new Map());

    expect(rows.map((row) => row.id)).toEqual(['u3', 'u1', 'u2']);
  });
});

describe('describeAccountStatus', () => {
  // The state this exists to surface: a free sign-up whose magic link was
  // never used is otherwise indistinguishable from an account that is quiet.
  it('flags a sign-up whose magic link was never used', () => {
    expect(describeAccountStatus({ email_confirmed_at: null, last_sign_in_at: null })).toEqual({
      label: 'Link not used yet',
      tone: 'pending',
    });
  });

  // `undefined !== null` is true, so a null check here reported a row that
  // carries no data at all as confirmed AND signed in.
  it('treats absent timestamps as absent, not as confirmed', () => {
    expect(describeAccountStatus({})).toEqual({ label: 'Link not used yet', tone: 'pending' });
    expect(describeAccountStatus({ email_confirmed_at: undefined, last_sign_in_at: undefined })).toEqual({
      label: 'Link not used yet',
      tone: 'pending',
    });
  });

  it('calls a confirmed account that has signed in active', () => {
    expect(
      describeAccountStatus({ email_confirmed_at: '2026-08-02T10:00:00Z', last_sign_in_at: '2026-08-30T09:00:00Z' })
    ).toEqual({ label: 'Active', tone: 'ok' });
  });

  // Where every admin-created account sits until its first sign-in: that
  // route confirms the address outright, so no link was ever clicked.
  it('does not let a confirmed-at-creation account read as a used link', () => {
    expect(describeAccountStatus({ email_confirmed_at: '2026-08-02T10:00:00Z', last_sign_in_at: null })).toEqual({
      label: 'Confirmed, never signed in',
      tone: 'warn',
    });
  });

  // Reachable only with email confirmation turned off in Supabase. Folding it
  // into the unused-link case would claim the link went unused by someone
  // plainly using it.
  it('names a sign-in without a confirmation rather than calling the link unused', () => {
    expect(describeAccountStatus({ email_confirmed_at: null, last_sign_in_at: '2026-08-30T09:00:00Z' })).toEqual({
      label: 'Signed in, not confirmed',
      tone: 'warn',
    });
  });
});

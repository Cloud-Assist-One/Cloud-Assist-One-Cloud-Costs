import type { Profile } from './types';

/**
 * Sign-in facts live in Supabase's `auth.users`, which PostgREST does not
 * expose -- they are reachable only through the admin auth API, as a separate
 * paginated call from the `profiles` query the admin list is built on. So the
 * two have to be joined in application code, and this is where that happens.
 *
 * Everything here is pure and takes its data as arguments, including the
 * pager, so the page-walking loop is testable. That loop is worth testing: a
 * silent single-page fetch would leave every user past the first page looking
 * like they had never signed in, which is indistinguishable from the real
 * thing it is meant to report.
 */

/** The two `auth.users` columns this reads, as the admin API returns them. */
export interface AuthActivity {
  id: string;
  /** When the account's email was confirmed. Null until the magic link is used. */
  emailConfirmedAt: string | null;
  lastSignInAt: string | null;
}

/** A profile row with its sign-in facts joined on. */
export interface AdminUserRow extends Profile {
  email_confirmed_at: string | null;
  last_sign_in_at: string | null;
}

/** One page of the admin auth API's user listing, narrowed to what is read. */
export interface AuthUserPage {
  users: { id: string; email_confirmed_at?: string | null; last_sign_in_at?: string | null }[];
  nextPage: number | null;
}

// A listing that never reports a last page would otherwise spin forever
// against a paginated API. 200 pages at the caller's page size is far past
// any real account count; reaching it means the API is misbehaving.
const MAX_PAGES = 200;

/**
 * Walk every page of the admin user listing into a lookup by user id.
 *
 * A page that fails is not silently skipped -- the error propagates, because
 * a partial map renders as "never signed in" for everyone missing from it,
 * and a wrong answer here is worse than no answer.
 */
export async function collectAuthActivity(
  listPage: (page: number) => Promise<AuthUserPage>
): Promise<Map<string, AuthActivity>> {
  const activity = new Map<string, AuthActivity>();
  let page: number | null = 1;

  for (let guard = 0; page !== null && guard < MAX_PAGES; guard += 1) {
    const result: AuthUserPage = await listPage(page);
    for (const user of result.users) {
      activity.set(user.id, {
        id: user.id,
        // The API omits these rather than nulling them, and `undefined` would
        // read as "no data" downstream where null means "never happened".
        emailConfirmedAt: user.email_confirmed_at ?? null,
        lastSignInAt: user.last_sign_in_at ?? null,
      });
    }
    page = result.nextPage;
  }

  return activity;
}

/**
 * Join sign-in facts onto profile rows.
 *
 * A profile with no matching auth user keeps nulls rather than being dropped:
 * the row is still a real account someone may need to revoke, and hiding it
 * from Email Management to tidy up a join would take that away.
 */
export function mergeAuthActivity(
  profiles: readonly Profile[],
  activity: ReadonlyMap<string, AuthActivity>
): AdminUserRow[] {
  return profiles.map((profile) => {
    const found = activity.get(profile.id);
    return {
      ...profile,
      email_confirmed_at: found?.emailConfirmedAt ?? null,
      last_sign_in_at: found?.lastSignInAt ?? null,
    };
  });
}

export type AccountStatusTone = 'ok' | 'warn' | 'pending';

export interface AccountStatus {
  label: string;
  tone: AccountStatusTone;
}

/**
 * The two timestamps, read as one state.
 *
 * A free signup is created unconfirmed and is sent a magic link; using that
 * link both confirms the address and signs them in, so an account with
 * neither timestamp is one whose link was never used. That is the state this
 * exists to make visible -- it is otherwise indistinguishable from an account
 * that is merely quiet.
 */
export function describeAccountStatus(row: {
  email_confirmed_at?: string | null;
  last_sign_in_at?: string | null;
}): AccountStatus {
  // Truthiness, not `!== null`. A row that carries these keys as `undefined`
  // -- anything not built by mergeAuthActivity -- would otherwise satisfy a
  // null check and be reported as Active: confirmed AND signed in, from a row
  // that says nothing at all. Absent has to read as absent.
  const confirmed = Boolean(row.email_confirmed_at);
  const signedIn = Boolean(row.last_sign_in_at);

  if (confirmed && signedIn) return { label: 'Active', tone: 'ok' };

  // Every account an admin creates from the Users form lands here until its
  // first sign-in: that route confirms the address outright, so nobody ever
  // clicked a link. Saying "never signed in" rather than "confirmed" is what
  // keeps that from reading as a link someone used.
  if (confirmed && !signedIn) return { label: 'Confirmed, never signed in', tone: 'warn' };

  // Only reachable with email confirmation turned off in Supabase, where a
  // link signs someone in without confirming the address. Named rather than
  // folded into the case below, which would claim the link went unused by
  // someone plainly using it.
  if (!confirmed && signedIn) return { label: 'Signed in, not confirmed', tone: 'warn' };

  return { label: 'Link not used yet', tone: 'pending' };
}

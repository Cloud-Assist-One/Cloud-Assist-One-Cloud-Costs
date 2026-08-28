import { NextRequest, NextResponse } from 'next/server';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '@/lib/supabase/admin';

const MAX_TEXT = 200;
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const GENERIC_ERROR = 'Could not create your account. Please try again.';

function cleanText(value: unknown, limit: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, limit);
}

// A separate anon-key client, not the service-role admin client, so the
// magic link is sent exactly the way a signed-out browser would send one.
function createAnonClient() {
  return createSupabaseClient(
    (process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').trim(),
    (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '').trim(),
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}

// This is the front door for a brand-new client — no session exists yet —
// so it is intentionally public with no admin/staff guard in front of it.
export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Malformed request body.' }, { status: 400 });
  }

  const { email, companyName, firstName, lastName, phone } = (body ?? {}) as {
    email?: string;
    companyName?: string;
    firstName?: string;
    lastName?: string;
    phone?: string;
  };

  const cleanEmail = cleanText(email, MAX_TEXT)?.toLowerCase() ?? null;
  const cleanCompanyName = cleanText(companyName, MAX_TEXT);
  const cleanFirstName = cleanText(firstName, MAX_TEXT);
  const cleanLastName = cleanText(lastName, MAX_TEXT);
  const cleanPhone = cleanText(phone, MAX_TEXT);

  if (!cleanEmail || !EMAIL_PATTERN.test(cleanEmail)) {
    return NextResponse.json({ error: 'A valid email address is required.' }, { status: 400 });
  }
  if (!cleanCompanyName) {
    return NextResponse.json({ error: 'Company name is required.' }, { status: 400 });
  }
  if (!cleanFirstName || !cleanLastName) {
    return NextResponse.json({ error: 'First and last name are required.' }, { status: 400 });
  }
  // Any non-empty value is accepted deliberately: phone numbers vary too much
  // by country for a format check to reject junk without also rejecting real
  // people. This is a lead-quality gate, not a bot defence -- a bot posting
  // straight to this route fills every field it is given.
  if (!cleanPhone) {
    return NextResponse.json({ error: 'A phone number is required.' }, { status: 400 });
  }

  const adminClient = createAdminClient();

  // Refuse without revealing anything about the address beyond "you already
  // have an account" -- never confirm/deny it belongs to a real user further
  // than that.
  const { data: existingProfile, error: existingProfileError } = await adminClient
    .from('profiles')
    .select('id')
    .eq('email', cleanEmail)
    .maybeSingle();

  if (existingProfileError) {
    console.error('signup: failed to check for an existing account:', existingProfileError);
    return NextResponse.json({ error: GENERIC_ERROR }, { status: 500 });
  }
  if (existingProfile) {
    return NextResponse.json(
      { error: 'An account with that email already exists. Please sign in instead.' },
      { status: 409 }
    );
  }

  const { data: company, error: companyError } = await adminClient
    .from('companies')
    .insert({ name: cleanCompanyName, subscription_tier: 'free' })
    .select('id')
    .single();

  if (companyError || !company) {
    console.error('signup: failed to create company:', companyError);
    return NextResponse.json({ error: GENERIC_ERROR }, { status: 500 });
  }

  // Pulled into its own const, not read off `company` again below: TypeScript
  // can't carry the null-check narrowing into the closures defined further
  // down, since they could in principle run at any later point.
  const companyId = company.id;

  const { data: userResult, error: userError } = await adminClient.auth.admin.createUser({
    email: cleanEmail,
    email_confirm: false,
  });

  if (userError || !userResult?.user) {
    console.error('signup: failed to create auth user:', userError);
    const { error: rollbackError } = await adminClient.from('companies').delete().eq('id', companyId);
    if (rollbackError) {
      console.error('signup: failed to roll back company after auth user creation failed:', rollbackError);
    }
    return NextResponse.json({ error: GENERIC_ERROR }, { status: 500 });
  }

  const newUserId = userResult.user.id;

  // Deleting the auth user cascades to remove its auto-created profile row
  // (profiles.id references auth.users(id) on delete cascade), so only the
  // company needs a separate delete to leave nothing stranded behind.
  async function rollbackUserAndCompany(reason: string, err: unknown) {
    console.error(reason, err);
    const { error: deleteUserError } = await adminClient.auth.admin.deleteUser(newUserId);
    if (deleteUserError) {
      console.error('signup: failed to roll back auth user:', deleteUserError);
    }
    const { error: deleteCompanyError } = await adminClient.from('companies').delete().eq('id', companyId);
    if (deleteCompanyError) {
      console.error('signup: failed to roll back company:', deleteCompanyError);
    }
  }

  const { error: profileError } = await adminClient
    .from('profiles')
    .update({
      company_id: companyId,
      first_name: cleanFirstName,
      last_name: cleanLastName,
      phone: cleanPhone,
    })
    .eq('id', newUserId);

  if (profileError) {
    await rollbackUserAndCompany('signup: failed to update the auto-created profile:', profileError);
    return NextResponse.json({ error: GENERIC_ERROR }, { status: 500 });
  }

  // The user already exists (just created above, unverified), so this sends
  // a sign-in link rather than creating a second account.
  const anonClient = createAnonClient();
  const emailRedirectTo = request.nextUrl.origin;
  const { error: otpError } = await anonClient.auth.signInWithOtp({
    email: cleanEmail,
    options: { emailRedirectTo },
  });

  if (otpError) {
    // Rolling back is deliberate: the account is passwordless, so one that
    // never received its link is an account nobody can get into.
    await rollbackUserAndCompany('signup: failed to send the sign-in link:', otpError);

    // Two of these are worth naming. A rejected address means a typo the user
    // can fix, and telling them to "try again" would have them retry forever.
    // A rate limit is temporary and genuinely is worth retrying — Supabase's
    // built-in mailer allows only a few messages an hour.
    if (otpError.code === 'email_address_invalid') {
      return NextResponse.json(
        { error: 'That email address was rejected. Please check it and try again.' },
        { status: 400 }
      );
    }
    if (otpError.status === 429) {
      return NextResponse.json(
        { error: 'Too many sign-up emails have been sent just now. Please wait a few minutes and try again.' },
        { status: 429 }
      );
    }
    return NextResponse.json({ error: GENERIC_ERROR }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}

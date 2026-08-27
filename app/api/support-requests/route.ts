import { NextRequest, NextResponse } from 'next/server';
import { requireCompanyAccess, requireStaff } from '@/lib/admin-guard';
import { createAdminClient } from '@/lib/supabase/admin';
import { isSupportTopic } from '@/lib/supportTopics';
import { resolveSubmitterIdentity } from '@/lib/supportIdentity';
import { sendEmail } from '@/lib/sendEmail';
import { buildSupportRequestEmail } from '@/lib/supportRequestEmail';
import type { SupportRequestWithCompany } from '@/lib/types';

const MAX_TEXT = 200;
const MAX_DETAILS = 2000;

// Where support notifications land. Overridable without a deploy, so routing
// them to a real support inbox later is a settings change.
const SUPPORT_INBOX = process.env.SUPPORT_EMAIL_TO ?? 'mgolino@outlook.com';

function cleanText(value: unknown, limit: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, limit);
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { companyId, firstName, email, phone, phoneExt, topics, details, origin } = body as {
    companyId?: string;
    firstName?: string;
    email?: string;
    phone?: string;
    phoneExt?: string;
    topics?: unknown;
    details?: string;
    origin?: string;
  };

  // A ticket raised by the Verify button on a grid row has no form behind it,
  // so its submitter comes from the session below rather than from the body.
  // Without this marker the form's own validation is unchanged.
  const isPortalRaised = origin === 'portal';

  if (typeof companyId !== 'string' || !companyId) {
    return NextResponse.json({ error: 'Missing companyId.' }, { status: 400 });
  }

  let cleanFirstName = cleanText(firstName, MAX_TEXT);
  let cleanEmail = cleanText(email, MAX_TEXT);
  if (!isPortalRaised) {
    if (!cleanFirstName) {
      return NextResponse.json({ error: 'First name is required.' }, { status: 400 });
    }
    if (!cleanEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(cleanEmail)) {
      return NextResponse.json({ error: 'A valid email address is required.' }, { status: 400 });
    }
  }

  // Only the known checkbox labels are accepted, so the stored topics always
  // match what the grids render.
  const cleanTopics = Array.isArray(topics) ? topics.filter(isSupportTopic) : [];
  if (cleanTopics.length === 0) {
    return NextResponse.json({ error: 'Please choose at least one topic.' }, { status: 400 });
  }

  const guard = await requireCompanyAccess(companyId);
  if (!guard.authorized) {
    return NextResponse.json({ error: guard.message }, { status: guard.status });
  }

  const adminClient = createAdminClient();

  // Identity for a portal-raised ticket is read from the signed-in user, so a
  // caller cannot file a ticket under someone else's name.
  if (isPortalRaised) {
    const { data: profile } = await adminClient
      .from('profiles')
      .select('first_name')
      .eq('id', guard.userId)
      .maybeSingle();
    const { data: authUser } = await adminClient.auth.admin.getUserById(guard.userId);

    const identity = resolveSubmitterIdentity(
      (profile?.first_name as string | null) ?? null,
      authUser?.user?.email ?? null
    );
    if (!identity.email) {
      return NextResponse.json(
        { error: 'Your account has no email address on file, so a ticket cannot be raised.' },
        { status: 400 }
      );
    }
    cleanFirstName = identity.firstName;
    cleanEmail = identity.email;
  }
  // Both branches above set these, but narrowing them here keeps the insert
  // honest rather than asserting non-null at the call site.
  if (!cleanFirstName || !cleanEmail) {
    return NextResponse.json({ error: 'A name and email address are required.' }, { status: 400 });
  }

  const { data, error } = await adminClient
    .from('support_requests')
    .insert({
      company_id: companyId,
      submitted_by: guard.userId,
      first_name: cleanFirstName,
      email: cleanEmail,
      phone: cleanText(phone, MAX_TEXT),
      phone_ext: cleanText(phoneExt, MAX_TEXT),
      topics: cleanTopics,
      details: cleanText(details, MAX_DETAILS),
    })
    .select()
    .single();

  if (error) {
    console.error('Failed to record support request:', error);
    return NextResponse.json({ error: 'Could not submit your request. Please try again.' }, { status: 500 });
  }

  // The ticket is already saved, so notification failures are logged and the
  // submitter still gets a success -- the request is not lost, and the queue
  // in the Support Requests tab remains the system of record.
  const { data: company } = await adminClient.from('companies').select('name').eq('id', companyId).maybeSingle();

  const { subject, text } = buildSupportRequestEmail({
    companyName: company?.name ?? 'Unknown company',
    firstName: cleanFirstName,
    email: cleanEmail,
    phone: cleanText(phone, MAX_TEXT),
    phoneExt: cleanText(phoneExt, MAX_TEXT),
    topics: cleanTopics,
    details: cleanText(details, MAX_DETAILS),
  });

  const sent = await sendEmail({ to: SUPPORT_INBOX, subject, text, replyTo: cleanEmail });
  if (!sent.ok) {
    console.error('Recorded the support request but could not email it:', sent.error);
  }

  return NextResponse.json({ request: data });
}

export async function GET(request: NextRequest) {
  const companyId = request.nextUrl.searchParams.get('companyId');
  const scope = request.nextUrl.searchParams.get('scope');
  const adminClient = createAdminClient();

  // scope=all is the staff/admin queue spanning every client; anything else
  // is a single company's own history. This mirrors the table's RLS rule,
  // where staff and admin both see every company's requests.
  if (scope === 'all') {
    const guard = await requireStaff();
    if (!guard.authorized) {
      return NextResponse.json({ error: guard.message }, { status: guard.status });
    }

    const { data, error } = await adminClient
      .from('support_requests')
      .select('*, companies(name)')
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Failed to list support requests:', error);
      return NextResponse.json({ error: 'Could not load support requests.' }, { status: 500 });
    }

    const requests: SupportRequestWithCompany[] = (data ?? []).map((row) => {
      const { companies, ...rest } = row as typeof row & { companies: { name: string } | null };
      return { ...rest, company_name: companies?.name ?? '—' } as SupportRequestWithCompany;
    });

    return NextResponse.json({ requests });
  }

  if (!companyId) {
    return NextResponse.json({ error: 'companyId is required.' }, { status: 400 });
  }

  const guard = await requireCompanyAccess(companyId);
  if (!guard.authorized) {
    return NextResponse.json({ error: guard.message }, { status: guard.status });
  }

  const { data, error } = await adminClient
    .from('support_requests')
    .select('*')
    .eq('company_id', companyId)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Failed to list support requests:', error);
    return NextResponse.json({ error: 'Could not load your support requests.' }, { status: 500 });
  }

  return NextResponse.json({ requests: data ?? [] });
}

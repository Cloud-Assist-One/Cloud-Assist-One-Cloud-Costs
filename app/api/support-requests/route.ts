import { NextRequest, NextResponse } from 'next/server';
import { requireCompanyAccess, requireStaff } from '@/lib/admin-guard';
import { createAdminClient } from '@/lib/supabase/admin';
import { isSupportTopic } from '@/lib/supportTopics';
import type { SupportRequestWithCompany } from '@/lib/types';

const MAX_TEXT = 200;
const MAX_DETAILS = 2000;

function cleanText(value: unknown, limit: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, limit);
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { companyId, firstName, email, phone, phoneExt, topics, details } = body as {
    companyId?: string;
    firstName?: string;
    email?: string;
    phone?: string;
    phoneExt?: string;
    topics?: unknown;
    details?: string;
  };

  if (typeof companyId !== 'string' || !companyId) {
    return NextResponse.json({ error: 'Missing companyId.' }, { status: 400 });
  }

  const cleanFirstName = cleanText(firstName, MAX_TEXT);
  const cleanEmail = cleanText(email, MAX_TEXT);
  if (!cleanFirstName) {
    return NextResponse.json({ error: 'First name is required.' }, { status: 400 });
  }
  if (!cleanEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(cleanEmail)) {
    return NextResponse.json({ error: 'A valid email address is required.' }, { status: 400 });
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

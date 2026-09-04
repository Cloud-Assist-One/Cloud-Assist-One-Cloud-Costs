import { NextRequest, NextResponse } from 'next/server';
import { requireCompanyAccess } from '@/lib/admin-guard';
import { requireActiveBilling } from '@/lib/billingGuard';
import { createAdminClient } from '@/lib/supabase/admin';
import { billingMonthForPeriod, deletePeriodAndContents } from '@/lib/deletePeriod';

export async function POST(request: NextRequest) {
  const body = await request.json();
  const companyId = body?.companyId;

  if (typeof companyId !== 'string' || companyId.length === 0) {
    return NextResponse.json({ error: 'Missing companyId.' }, { status: 400 });
  }

  const guard = await requireCompanyAccess(companyId);
  if (!guard.authorized) {
    return NextResponse.json({ error: guard.message }, { status: guard.status });
  }

  const billing = await requireActiveBilling(companyId, guard.role);
  if (!billing.allowed) {
    return NextResponse.json({ error: billing.message }, { status: billing.status });
  }

  const adminClient = createAdminClient();

  // Captured before archiving: the RPC returns the id of the *new* active
  // period, not the one it just archived, and the month has to be stamped on
  // the latter.
  const { data: activePeriod, error: activePeriodError } = await adminClient
    .from('billing_periods')
    .select('id')
    .eq('company_id', companyId)
    .eq('status', 'active')
    .single();

  if (activePeriodError || !activePeriod) {
    return NextResponse.json({ error: 'No active billing period found for this company.' }, { status: 500 });
  }

  const archivingPeriodId = activePeriod.id as string;
  const billingMonth = await billingMonthForPeriod(adminClient, archivingPeriodId);

  // One archive per billing month: re-pulling August and archiving again used
  // to leave two archived Augusts. The old one is removed first so the new
  // archive replaces it rather than sitting alongside. A period with no
  // billing month (nothing was ever uploaded or pulled into it) can't be
  // keyed this way, so it is archived without displacing anything.
  let replacedArchiveId: string | null = null;
  if (billingMonth) {
    const { data: existingArchive, error: existingError } = await adminClient
      .from('billing_periods')
      .select('id')
      .eq('company_id', companyId)
      .eq('status', 'archived')
      .eq('billing_month', billingMonth)
      .maybeSingle();

    if (existingError) {
      console.error('Failed to look for an existing archive for this month:', existingError);
      return NextResponse.json({ error: 'Could not check for an existing archive of this month.' }, { status: 500 });
    }

    if (existingArchive) {
      const deleted = await deletePeriodAndContents(adminClient, existingArchive.id as string);
      if (!deleted.ok) {
        return NextResponse.json({ error: deleted.error }, { status: deleted.status });
      }
      replacedArchiveId = existingArchive.id as string;
    }
  }

  const { data: newPeriodId, error } = await adminClient.rpc('archive_billing_period', { p_company_id: companyId });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Stamped after the RPC succeeds, so a failed archive leaves no month
  // recorded against a period that was never archived.
  if (billingMonth) {
    const { error: stampError } = await adminClient
      .from('billing_periods')
      .update({ billing_month: billingMonth })
      .eq('id', archivingPeriodId);

    if (stampError) {
      // The archive itself worked; without the stamp this month just won't be
      // de-duplicated next time, which is not worth failing the request over.
      console.error('Archived the period but could not stamp its billing month:', stampError);
    }
  }

  return NextResponse.json({ newPeriodId, billingMonth, replacedArchiveId });
}

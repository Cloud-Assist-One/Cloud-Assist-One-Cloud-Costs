import { NextResponse } from 'next/server';
import { requireCompanyAccess } from '@/lib/admin-guard';
import { requireActiveBilling } from '@/lib/billingGuard';
import { createAdminClient } from '@/lib/supabase/admin';
import { deletePeriodAndContents } from '@/lib/deletePeriod';

export async function DELETE(_request: Request, context: RouteContext<'/api/periods/[periodId]'>) {
  const { periodId } = await context.params;

  const adminClient = createAdminClient();

  const { data: period, error: periodError } = await adminClient
    .from('billing_periods')
    .select('company_id, status')
    .eq('id', periodId)
    .maybeSingle();

  if (periodError) {
    console.error('Failed to look up period before delete:', periodError);
    return NextResponse.json({ error: 'Could not look up that period.' }, { status: 500 });
  }

  if (!period) {
    return NextResponse.json({ error: 'Period not found.' }, { status: 404 });
  }

  const guard = await requireCompanyAccess(period.company_id);
  if (!guard.authorized) {
    return NextResponse.json({ error: guard.message }, { status: guard.status });
  }

  const billing = await requireActiveBilling(period.company_id, guard.role);
  if (!billing.allowed) {
    return NextResponse.json({ error: billing.message }, { status: billing.status });
  }

  // The active period is exactly-one-per-company and drives the whole app's
  // "current" view — only an archived, frozen period can be deleted here.
  if (period.status !== 'archived') {
    return NextResponse.json({ error: 'Only archived periods can be deleted.' }, { status: 400 });
  }

  const deleted = await deletePeriodAndContents(adminClient, periodId);
  if (!deleted.ok) {
    return NextResponse.json({ error: deleted.error }, { status: deleted.status });
  }

  return NextResponse.json({ deleted: true });
}

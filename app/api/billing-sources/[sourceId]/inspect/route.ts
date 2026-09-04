import { NextRequest, NextResponse } from 'next/server';
import { requireCompanyAccess } from '@/lib/admin-guard';
import { createAdminClient } from '@/lib/supabase/admin';
import { createStoreForSource, permissionHint } from '@/lib/billingSourceStore';
import { inspectBillingSource } from '@/lib/billingSourceInspect';
import type { CloudProvider } from '@/lib/types';

// Lists a container and downloads a single file to read its header row. Far
// cheaper than a pull, but a cold Azure listing over a year of daily exports
// is not instant, so the default 15s is still too tight.
export const maxDuration = 60;

// POST rather than GET even though this writes nothing: it costs a round trip
// to the cloud provider on every call, and a GET route invites being cached
// or prefetched into doing that on its own.
export async function POST(request: NextRequest, context: RouteContext<'/api/billing-sources/[sourceId]/inspect'>) {
  const { sourceId } = await context.params;
  const body = await request.json();
  const companyId = body?.companyId;

  if (typeof companyId !== 'string' || !companyId) {
    return NextResponse.json({ error: 'companyId is required.' }, { status: 400 });
  }

  const guard = await requireCompanyAccess(companyId);
  if (!guard.authorized) {
    return NextResponse.json({ error: guard.message }, { status: guard.status });
  }

  const adminClient = createAdminClient();

  const { data: source } = await adminClient
    .from('billing_file_sources')
    .select('*')
    .eq('id', sourceId)
    .eq('company_id', companyId)
    .maybeSingle();

  if (!source) {
    return NextResponse.json({ error: 'That bucket is not configured for this company.' }, { status: 404 });
  }

  // Deliberately not gated on source.enabled, unlike the pull: a disabled
  // bucket is exactly the one someone is most likely to be trying to diagnose
  // before they turn it on.

  const { data: credRow } = await adminClient
    .from('cloud_provider_credentials')
    .select('encrypted_payload, region')
    .eq('id', source.credential_id)
    .eq('company_id', companyId)
    .maybeSingle();

  if (!credRow) {
    return NextResponse.json({ error: 'The connection this bucket uses no longer exists.' }, { status: 400 });
  }

  const provider = source.cloud_provider as CloudProvider;
  const resolved = createStoreForSource({
    provider,
    container: source.container,
    encryptedPayload: credRow.encrypted_payload,
    region: credRow.region ?? null,
  });

  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.error }, { status: resolved.status });
  }

  try {
    const inspection = await inspectBillingSource(provider, resolved.store, source.prefix ?? '');
    return NextResponse.json({ container: source.container, provider, inspection });
  } catch (err) {
    // The listing itself failed, which IS the answer: the credential, the
    // account, or the container name is wrong. permissionHint names the role
    // a 403 needs rather than echoing the SDK.
    return NextResponse.json({ error: permissionHint(provider, err) }, { status: 502 });
  }
}

import { NextRequest, NextResponse } from 'next/server';
import { requireCompanyAccess } from '@/lib/admin-guard';
import { requireActiveBilling } from '@/lib/billingGuard';
import { createAdminClient } from '@/lib/supabase/admin';
import { CLOUD_PROVIDERS } from '@/lib/cloudProvider';
import type { CloudProvider } from '@/lib/types';

const MAX_TEXT = 200;

function cleanText(value: unknown, limit: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, limit) : null;
}

export async function GET(request: NextRequest) {
  const companyId = request.nextUrl.searchParams.get('companyId');
  if (!companyId) {
    return NextResponse.json({ error: 'companyId is required.' }, { status: 400 });
  }

  const guard = await requireCompanyAccess(companyId);
  if (!guard.authorized) {
    return NextResponse.json({ error: guard.message }, { status: guard.status });
  }

  const adminClient = createAdminClient();
  const { data, error } = await adminClient
    .from('billing_file_sources')
    .select('*')
    .eq('company_id', companyId)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Failed to list billing file sources:', error);
    return NextResponse.json({ error: 'Could not load the configured buckets.' }, { status: 500 });
  }

  return NextResponse.json({ sources: data ?? [] });
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { companyId, credentialId, cloudProvider, container, prefix, label } = body as Record<string, unknown>;

  if (typeof companyId !== 'string' || !companyId) {
    return NextResponse.json({ error: 'companyId is required.' }, { status: 400 });
  }
  if (typeof credentialId !== 'string' || !credentialId) {
    return NextResponse.json({ error: 'Pick a saved connection to read the bucket with.' }, { status: 400 });
  }
  if (!CLOUD_PROVIDERS.includes(cloudProvider as CloudProvider)) {
    return NextResponse.json({ error: `cloudProvider must be one of: ${CLOUD_PROVIDERS.join(', ')}.` }, { status: 400 });
  }

  const cleanContainer = cleanText(container, MAX_TEXT);
  const cleanLabel = cleanText(label, MAX_TEXT);
  if (!cleanContainer) {
    return NextResponse.json(
      { error: 'Enter the S3 bucket name, or the Azure storage account and container as "account/container".' },
      { status: 400 }
    );
  }
  if (!cleanLabel) {
    return NextResponse.json({ error: 'Give this bucket a label.' }, { status: 400 });
  }
  // Azure needs both halves; catching it here beats a confusing 404 at pull time.
  if (cloudProvider === 'azure' && !cleanContainer.includes('/')) {
    return NextResponse.json(
      { error: 'For Azure, enter the storage account and container as "account/container".' },
      { status: 400 }
    );
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

  // The connection is what the bucket is read with, so a source pointing at
  // another company's connection would read their cloud account with their
  // credentials. Checked here rather than trusted from the body.
  const { data: credential } = await adminClient
    .from('cloud_provider_credentials')
    .select('id')
    .eq('id', credentialId)
    .eq('company_id', companyId)
    .maybeSingle();

  if (!credential) {
    return NextResponse.json({ error: 'That connection does not belong to this company.' }, { status: 403 });
  }

  const { data, error } = await adminClient
    .from('billing_file_sources')
    .insert({
      company_id: companyId,
      credential_id: credentialId,
      cloud_provider: cloudProvider,
      container: cleanContainer,
      prefix: cleanText(prefix, MAX_TEXT) ?? '',
      label: cleanLabel,
      created_by: guard.userId,
    })
    .select()
    .single();

  if (error) {
    console.error('Failed to save the billing file source:', error);
    return NextResponse.json({ error: 'Could not save this bucket.' }, { status: 500 });
  }

  return NextResponse.json({ source: data });
}

export async function DELETE(request: NextRequest) {
  const companyId = request.nextUrl.searchParams.get('companyId');
  const sourceId = request.nextUrl.searchParams.get('sourceId');
  if (!companyId || !sourceId) {
    return NextResponse.json({ error: 'companyId and sourceId are required.' }, { status: 400 });
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
  // Scoped by company as well as id, so an id from another company deletes nothing.
  const { error } = await adminClient
    .from('billing_file_sources')
    .delete()
    .eq('id', sourceId)
    .eq('company_id', companyId);

  if (error) {
    console.error('Failed to delete the billing file source:', error);
    return NextResponse.json({ error: 'Could not remove this bucket.' }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}

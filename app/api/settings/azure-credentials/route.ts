import { NextRequest, NextResponse } from 'next/server';
import { requireCompanyAccess } from '@/lib/admin-guard';
import { createAdminClient } from '@/lib/supabase/admin';
import { encryptCredentials } from '@/lib/cloudCredentialsCrypto';
import type { AzureCredentialSummary } from '@/lib/types';

function toSummary(row: { id: string; label: string; metadata: Record<string, unknown> }): AzureCredentialSummary {
  return {
    id: row.id,
    label: row.label,
    tenantId: (row.metadata?.tenantId as string | undefined) ?? '',
    clientId: (row.metadata?.clientId as string | undefined) ?? '',
    subscriptionId: (row.metadata?.subscriptionId as string | undefined) ?? '',
  };
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
    .from('cloud_provider_credentials')
    .select('id, label, metadata')
    .eq('company_id', companyId)
    .eq('provider', 'azure')
    .order('created_at', { ascending: true });

  if (error) {
    console.error('Failed to look up Azure credentials:', error);
    return NextResponse.json({ error: 'Could not look up the Azure connections.' }, { status: 500 });
  }

  return NextResponse.json({ connections: (data ?? []).map(toSummary) });
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { companyId, label, tenantId, clientId, clientSecret, subscriptionId } = body as {
    companyId?: string;
    label?: string;
    tenantId?: string;
    clientId?: string;
    clientSecret?: string;
    subscriptionId?: string;
  };

  if (
    typeof companyId !== 'string' ||
    typeof label !== 'string' ||
    !label.trim() ||
    typeof tenantId !== 'string' ||
    !tenantId.trim() ||
    typeof clientId !== 'string' ||
    !clientId.trim() ||
    typeof clientSecret !== 'string' ||
    !clientSecret.trim() ||
    typeof subscriptionId !== 'string' ||
    !subscriptionId.trim()
  ) {
    return NextResponse.json(
      { error: 'companyId, label, tenantId, clientId, clientSecret, and subscriptionId are all required.' },
      { status: 400 }
    );
  }

  const guard = await requireCompanyAccess(companyId);
  if (!guard.authorized) {
    return NextResponse.json({ error: guard.message }, { status: guard.status });
  }

  let encryptedPayload: string;
  try {
    encryptedPayload = encryptCredentials({ tenantId, clientId, clientSecret, subscriptionId });
  } catch (err) {
    console.error('Failed to encrypt Azure credentials:', err);
    return NextResponse.json({ error: 'Could not save the Azure connection.' }, { status: 500 });
  }

  const adminClient = createAdminClient();
  const { data, error } = await adminClient
    .from('cloud_provider_credentials')
    .insert({
      company_id: companyId,
      provider: 'azure',
      label,
      auth_type: 'keys',
      encrypted_payload: encryptedPayload,
      metadata: { tenantId, clientId, subscriptionId },
      created_by: guard.userId,
    })
    .select('id, label, metadata')
    .single();

  if (error) {
    if (error.code === '23505') {
      return NextResponse.json(
        { error: `An Azure connection labeled "${label}" already exists for this company.` },
        { status: 409 }
      );
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ connection: toSummary(data) });
}

export async function DELETE(request: NextRequest) {
  const companyId = request.nextUrl.searchParams.get('companyId');
  const id = request.nextUrl.searchParams.get('id');
  if (!companyId || !id) {
    return NextResponse.json({ error: 'companyId and id are required.' }, { status: 400 });
  }

  const guard = await requireCompanyAccess(companyId);
  if (!guard.authorized) {
    return NextResponse.json({ error: guard.message }, { status: guard.status });
  }

  const adminClient = createAdminClient();
  const { error } = await adminClient
    .from('cloud_provider_credentials')
    .delete()
    .eq('company_id', companyId)
    .eq('provider', 'azure')
    .eq('id', id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ deleted: true });
}

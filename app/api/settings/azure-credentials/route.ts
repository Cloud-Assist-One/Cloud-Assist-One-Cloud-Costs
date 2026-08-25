import { NextRequest, NextResponse } from 'next/server';
import { requireCompanyAccess } from '@/lib/admin-guard';
import { createAdminClient } from '@/lib/supabase/admin';
import { encryptCredentials } from '@/lib/cloudCredentialsCrypto';
import type { AzureCredentialSummary } from '@/lib/types';

// AWS allows letters, numbers, spaces and + - = . _ : / @ in a tag key, up
// to 128 characters. Azure ARM tag keys follow the same shape closely
// enough that reusing the same rule here means a typo surfaces on the
// settings form rather than as a silently empty column later.
const TAG_KEY_PATTERN = /^[\w\s+\-=._:/@]{1,128}$/;

function readTagKey(value: unknown): { ok: true; tagKey: string } | { ok: false } {
  // An absent or blank tag key is valid — it just switches the column off.
  if (value === undefined || value === null || value === '') return { ok: true, tagKey: '' };
  if (typeof value !== 'string') return { ok: false };
  const trimmed = value.trim();
  if (!trimmed) return { ok: true, tagKey: '' };
  if (!TAG_KEY_PATTERN.test(trimmed)) return { ok: false };
  return { ok: true, tagKey: trimmed };
}

function toSummary(row: { id: string; label: string; metadata: Record<string, unknown> }): AzureCredentialSummary {
  return {
    id: row.id,
    label: row.label,
    tenantId: (row.metadata?.tenantId as string | undefined) ?? '',
    clientId: (row.metadata?.clientId as string | undefined) ?? '',
    subscriptionId: (row.metadata?.subscriptionId as string | undefined) ?? '',
    tagKey: (row.metadata?.tagKey as string | undefined) ?? '',
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
  const { companyId, label, tenantId, clientId, clientSecret, subscriptionId, tagKey } = body as {
    companyId?: string;
    label?: string;
    tenantId?: string;
    clientId?: string;
    clientSecret?: string;
    subscriptionId?: string;
    tagKey?: string;
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

  const parsedTagKey = readTagKey(tagKey);
  if (!parsedTagKey.ok) {
    return NextResponse.json({ error: 'tagKey must be a valid Azure tag key (up to 128 characters).' }, { status: 400 });
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
      metadata: { tenantId, clientId, subscriptionId, tagKey: parsedTagKey.tagKey },
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

// Changing which tag is reported must not mean deleting and re-entering the
// client secret, so the tag key is editable on an existing connection.
export async function PATCH(request: NextRequest) {
  const body = await request.json();
  const { companyId, id, tagKey } = body as { companyId?: string; id?: string; tagKey?: string };

  if (typeof companyId !== 'string' || typeof id !== 'string') {
    return NextResponse.json({ error: 'companyId and id are required.' }, { status: 400 });
  }

  const parsedTagKey = readTagKey(tagKey);
  if (!parsedTagKey.ok) {
    return NextResponse.json({ error: 'tagKey must be a valid Azure tag key (up to 128 characters).' }, { status: 400 });
  }

  const guard = await requireCompanyAccess(companyId);
  if (!guard.authorized) {
    return NextResponse.json({ error: guard.message }, { status: guard.status });
  }

  const adminClient = createAdminClient();
  const { data: existing, error: readError } = await adminClient
    .from('cloud_provider_credentials')
    .select('metadata')
    .eq('company_id', companyId)
    .eq('provider', 'azure')
    .eq('id', id)
    .maybeSingle();

  if (readError) {
    console.error('Failed to look up Azure credentials:', readError);
    return NextResponse.json({ error: 'Could not look up the Azure connection.' }, { status: 500 });
  }
  if (!existing) {
    return NextResponse.json({ error: 'That Azure connection does not exist.' }, { status: 404 });
  }

  // metadata is a single jsonb blob, so merge rather than overwrite —
  // otherwise this would drop tenantId/clientId/subscriptionId.
  const { data, error } = await adminClient
    .from('cloud_provider_credentials')
    .update({
      metadata: { ...(existing.metadata as Record<string, unknown>), tagKey: parsedTagKey.tagKey },
      updated_at: new Date().toISOString(),
    })
    .eq('company_id', companyId)
    .eq('provider', 'azure')
    .eq('id', id)
    .select('id, label, metadata')
    .single();

  if (error) {
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

import { NextRequest, NextResponse } from 'next/server';
import { requireCompanyAccess } from '@/lib/admin-guard';
import { createAdminClient } from '@/lib/supabase/admin';
import { encryptCredentials } from '@/lib/cloudCredentialsCrypto';
import { readTagKey } from '@/lib/resourceTags';
import { getConnectionAllowance } from '@/lib/connectionAllowance';
import type { AwsCredentialSummary } from '@/lib/types';

const REGION_PATTERN = /^[a-z]{2}-[a-z]+-\d$/;

function maskAccessKeyId(accessKeyId: string): string {
  if (accessKeyId.length <= 8) return accessKeyId;
  return `${accessKeyId.slice(0, 4)}${'*'.repeat(accessKeyId.length - 8)}${accessKeyId.slice(-4)}`;
}

function toSummary(row: { id: string; label: string; region: string | null; metadata: Record<string, unknown> }): AwsCredentialSummary {
  return {
    id: row.id,
    label: row.label,
    accessKeyIdMasked: (row.metadata?.accessKeyIdMasked as string | undefined) ?? '',
    region: row.region ?? '',
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
    .select('id, label, region, metadata')
    .eq('company_id', companyId)
    .eq('provider', 'aws')
    .order('created_at', { ascending: true });

  if (error) {
    console.error('Failed to look up AWS credentials:', error);
    return NextResponse.json({ error: 'Could not look up the AWS connections.' }, { status: 500 });
  }

  return NextResponse.json({ connections: (data ?? []).map(toSummary) });
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { companyId, label, accessKeyId, secretAccessKey, region, tagKey } = body as {
    companyId?: string;
    label?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    region?: string;
    tagKey?: string;
  };

  if (
    typeof companyId !== 'string' ||
    typeof label !== 'string' ||
    !label.trim() ||
    typeof accessKeyId !== 'string' ||
    !accessKeyId.trim() ||
    typeof secretAccessKey !== 'string' ||
    !secretAccessKey.trim() ||
    typeof region !== 'string' ||
    !region.trim()
  ) {
    return NextResponse.json(
      { error: 'companyId, label, accessKeyId, secretAccessKey, and region are all required.' },
      { status: 400 }
    );
  }
  if (!REGION_PATTERN.test(region)) {
    return NextResponse.json({ error: 'region must look like an AWS region, e.g. us-east-1.' }, { status: 400 });
  }

  const parsedTagKey = readTagKey(tagKey);
  if (!parsedTagKey.ok) {
    return NextResponse.json({ error: 'tagKey must be a valid AWS tag key (up to 128 characters).' }, { status: 400 });
  }

  const guard = await requireCompanyAccess(companyId);
  if (!guard.authorized) {
    return NextResponse.json({ error: guard.message }, { status: guard.status });
  }

  const adminClient = createAdminClient();

  // The real enforcement of the subscription tier's connection cap — the
  // UI greying the Add Connection button is only a courtesy, since a user
  // could POST directly.
  const allowance = await getConnectionAllowance(adminClient, companyId);
  if (!allowance.canAdd) {
    return NextResponse.json(
      { error: allowance.message ?? 'Your plan does not allow adding another cloud connection.' },
      { status: 409 }
    );
  }

  const accessKeyIdMasked = maskAccessKeyId(accessKeyId);
  let encryptedPayload: string;
  try {
    encryptedPayload = encryptCredentials({ accessKeyId, secretAccessKey });
  } catch (err) {
    console.error('Failed to encrypt AWS credentials:', err);
    return NextResponse.json({ error: 'Could not save the AWS connection.' }, { status: 500 });
  }

  const { data, error } = await adminClient
    .from('cloud_provider_credentials')
    .insert({
      company_id: companyId,
      provider: 'aws',
      label,
      auth_type: 'keys',
      encrypted_payload: encryptedPayload,
      region,
      metadata: { accessKeyIdMasked, tagKey: parsedTagKey.tagKey },
      created_by: guard.userId,
    })
    .select('id, label, region, metadata')
    .single();

  if (error) {
    if (error.code === '23505') {
      return NextResponse.json(
        { error: `An AWS connection labeled "${label}" already exists for this company.` },
        { status: 409 }
      );
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ connection: toSummary(data) });
}

// Changing which tag is reported must not mean deleting and re-entering the
// access keys, so the tag key is editable on an existing connection.
export async function PATCH(request: NextRequest) {
  const body = await request.json();
  const { companyId, id, tagKey } = body as { companyId?: string; id?: string; tagKey?: string };

  if (typeof companyId !== 'string' || typeof id !== 'string') {
    return NextResponse.json({ error: 'companyId and id are required.' }, { status: 400 });
  }

  const parsedTagKey = readTagKey(tagKey);
  if (!parsedTagKey.ok) {
    return NextResponse.json({ error: 'tagKey must be a valid AWS tag key (up to 128 characters).' }, { status: 400 });
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
    .eq('provider', 'aws')
    .eq('id', id)
    .maybeSingle();

  if (readError) {
    console.error('Failed to look up AWS credentials:', readError);
    return NextResponse.json({ error: 'Could not look up the AWS connection.' }, { status: 500 });
  }
  if (!existing) {
    return NextResponse.json({ error: 'That AWS connection does not exist.' }, { status: 404 });
  }

  // metadata is a single jsonb blob, so merge rather than overwrite —
  // otherwise this would drop accessKeyIdMasked.
  const { data, error } = await adminClient
    .from('cloud_provider_credentials')
    .update({
      metadata: { ...(existing.metadata as Record<string, unknown>), tagKey: parsedTagKey.tagKey },
      updated_at: new Date().toISOString(),
    })
    .eq('company_id', companyId)
    .eq('provider', 'aws')
    .eq('id', id)
    .select('id, label, region, metadata')
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
    .eq('provider', 'aws')
    .eq('id', id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ deleted: true });
}

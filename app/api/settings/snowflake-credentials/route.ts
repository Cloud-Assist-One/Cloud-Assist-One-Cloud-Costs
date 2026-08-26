import { NextRequest, NextResponse } from 'next/server';
import { requireCompanyAccess } from '@/lib/admin-guard';
import { createAdminClient } from '@/lib/supabase/admin';
import { encryptCredentials } from '@/lib/cloudCredentialsCrypto';
import { getConnectionAllowance } from '@/lib/connectionAllowance';
import type { SnowflakeCredentialSummary } from '@/lib/types';

function toSummary(row: { id: string; label: string; metadata: Record<string, unknown> }): SnowflakeCredentialSummary {
  return {
    id: row.id,
    label: row.label,
    account: (row.metadata?.account as string | undefined) ?? '',
    username: (row.metadata?.username as string | undefined) ?? '',
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
    .eq('provider', 'snowflake')
    .order('created_at', { ascending: true });

  if (error) {
    console.error('Failed to look up Snowflake credentials:', error);
    return NextResponse.json({ error: 'Could not look up the Snowflake connections.' }, { status: 500 });
  }

  return NextResponse.json({ connections: (data ?? []).map(toSummary) });
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { companyId, label, account, username, password } = body as {
    companyId?: string;
    label?: string;
    account?: string;
    username?: string;
    password?: string;
  };

  if (
    typeof companyId !== 'string' ||
    typeof label !== 'string' ||
    !label.trim() ||
    typeof account !== 'string' ||
    !account.trim() ||
    typeof username !== 'string' ||
    !username.trim() ||
    typeof password !== 'string' ||
    !password.trim()
  ) {
    return NextResponse.json(
      { error: 'companyId, label, account, username, and password are all required.' },
      { status: 400 }
    );
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

  let encryptedPayload: string;
  try {
    encryptedPayload = encryptCredentials({ account, username, password });
  } catch (err) {
    console.error('Failed to encrypt Snowflake credentials:', err);
    return NextResponse.json({ error: 'Could not save the Snowflake connection.' }, { status: 500 });
  }

  const { data, error } = await adminClient
    .from('cloud_provider_credentials')
    .insert({
      company_id: companyId,
      provider: 'snowflake',
      label,
      auth_type: 'keys',
      encrypted_payload: encryptedPayload,
      metadata: { account, username },
      created_by: guard.userId,
    })
    .select('id, label, metadata')
    .single();

  if (error) {
    if (error.code === '23505') {
      return NextResponse.json(
        { error: `A Snowflake connection labeled "${label}" already exists for this company.` },
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
    .eq('provider', 'snowflake')
    .eq('id', id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ deleted: true });
}

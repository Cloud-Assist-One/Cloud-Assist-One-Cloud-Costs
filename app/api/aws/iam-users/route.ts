import { NextRequest, NextResponse } from 'next/server';
import { IAMClient, ListUsersCommand } from '@aws-sdk/client-iam';
import { requireCompanyAccess } from '@/lib/admin-guard';
import { createAdminClient } from '@/lib/supabase/admin';
import { decryptCredentials } from '@/lib/cloudCredentialsCrypto';
import type { AwsIamUsersResponse, IamUserRow } from '@/lib/types';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Unknown error.';
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
  const { data: credRow, error: credError } = await adminClient
    .from('cloud_provider_credentials')
    .select('encrypted_payload, region')
    .eq('company_id', companyId)
    .eq('provider', 'aws')
    .maybeSingle();

  if (credError) {
    console.error('Failed to look up AWS credentials:', credError);
    return NextResponse.json({ error: 'Could not look up the AWS connection.' }, { status: 500 });
  }

  if (!credRow) {
    return NextResponse.json({ connected: false } satisfies AwsIamUsersResponse);
  }

  let secrets: { accessKeyId: string; secretAccessKey: string };
  try {
    secrets = decryptCredentials(credRow.encrypted_payload);
  } catch (err) {
    console.error('Failed to decrypt AWS credentials:', err);
    return NextResponse.json({ error: 'Could not decrypt the stored AWS credentials.' }, { status: 500 });
  }

  // IAM is a global service — it doesn't use the per-company region setting.
  const clientConfig = {
    region: credRow.region ?? 'us-east-1',
    credentials: { accessKeyId: secrets.accessKeyId, secretAccessKey: secrets.secretAccessKey },
  };

  let users: IamUserRow[] = [];
  let usersError: string | null = null;
  try {
    const client = new IAMClient(clientConfig);
    const result = await client.send(new ListUsersCommand({}));
    users = (result.Users ?? []).map((user) => ({
      userName: user.UserName ?? '',
      userId: user.UserId ?? '',
      arn: user.Arn ?? '',
      path: user.Path ?? '/',
      createDate: user.CreateDate ? new Date(user.CreateDate).toISOString() : null,
      passwordLastUsed: user.PasswordLastUsed ? new Date(user.PasswordLastUsed).toISOString() : null,
    }));
  } catch (err) {
    usersError = errorMessage(err);
  }

  return NextResponse.json({
    connected: true,
    fetchedAt: new Date().toISOString(),
    users: { data: users, error: usersError },
  } satisfies AwsIamUsersResponse);
}

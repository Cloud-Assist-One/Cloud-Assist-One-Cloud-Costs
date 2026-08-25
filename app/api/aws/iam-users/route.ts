import { NextRequest, NextResponse } from 'next/server';
import { IAMClient, ListUsersCommand, ListUserTagsCommand } from '@aws-sdk/client-iam';
import { requireCompanyAccess } from '@/lib/admin-guard';
import { createAdminClient } from '@/lib/supabase/admin';
import { decryptCredentials } from '@/lib/cloudCredentialsCrypto';
import { collectPages } from '@/lib/awsPagination';
import { tagValue } from '@/lib/awsTags';
import type { AwsIamUsersResponse, IamUserRow } from '@/lib/types';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Unknown error.';
}

export async function GET(request: NextRequest) {
  const companyId = request.nextUrl.searchParams.get('companyId');
  const credentialId = request.nextUrl.searchParams.get('credentialId');
  if (!companyId || !credentialId) {
    return NextResponse.json({ error: 'companyId and credentialId are required.' }, { status: 400 });
  }

  const guard = await requireCompanyAccess(companyId);
  if (!guard.authorized) {
    return NextResponse.json({ error: guard.message }, { status: guard.status });
  }

  const adminClient = createAdminClient();
  const { data: credRow, error: credError } = await adminClient
    .from('cloud_provider_credentials')
    .select('encrypted_payload, region, metadata')
    .eq('company_id', companyId)
    .eq('provider', 'aws')
    .eq('id', credentialId)
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

  // The tag to surface as an extra column is configured per connection.
  // Blank means the feature is off, and no ListUserTags calls are made — so
  // an unconfigured connection needs no iam:ListUserTags permission.
  const tagKey = ((credRow.metadata as Record<string, unknown> | null)?.tagKey as string | undefined) ?? '';

  let users: IamUserRow[] = [];
  let usersError: string | null = null;
  try {
    const client = new IAMClient(clientConfig);
    const iamUsers = await collectPages(
      (Marker) => client.send(new ListUsersCommand({ Marker })),
      (page) => page.Users,
      (page) => page.Marker
    );
    // IAM has no bulk tag read, so each user needs its own ListUserTags. A
    // failure on one user degrades that cell to null rather than the table.
    users = await Promise.all(
      iamUsers.map(async (user): Promise<IamUserRow> => {
        let userTagValue: string | null = null;
        if (tagKey && user.UserName) {
          try {
            const tags = await client.send(new ListUserTagsCommand({ UserName: user.UserName }));
            userTagValue = tagValue(tags.Tags, tagKey);
          } catch {
            userTagValue = null;
          }
        }
        return {
          userName: user.UserName ?? '',
          userId: user.UserId ?? '',
          arn: user.Arn ?? '',
          path: user.Path ?? '/',
          createDate: user.CreateDate ? new Date(user.CreateDate).toISOString() : null,
          passwordLastUsed: user.PasswordLastUsed ? new Date(user.PasswordLastUsed).toISOString() : null,
          tagValue: userTagValue,
        };
      })
    );
  } catch (err) {
    usersError = errorMessage(err);
  }

  return NextResponse.json({
    connected: true,
    fetchedAt: new Date().toISOString(),
    tagKey,
    users: { data: users, error: usersError },
  } satisfies AwsIamUsersResponse);
}

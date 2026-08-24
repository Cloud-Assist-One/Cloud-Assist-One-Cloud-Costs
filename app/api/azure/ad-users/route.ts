import { NextRequest, NextResponse } from 'next/server';
import { ClientSecretCredential } from '@azure/identity';
import { Client, PageIterator } from '@microsoft/microsoft-graph-client';
import { TokenCredentialAuthenticationProvider } from '@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials';
import { requireCompanyAccess } from '@/lib/admin-guard';
import { createAdminClient } from '@/lib/supabase/admin';
import { decryptCredentials } from '@/lib/cloudCredentialsCrypto';
import type { AzureAdUsersResponse, AzureAdUserRow } from '@/lib/types';

// Microsoft Graph's most common failure here is a missing admin-consented
// User.Read.All application permission -- a completely separate grant from
// the ARM "Reader" role the Resources tab needs, so this is the single most
// likely support question this feature generates. Point at it directly
// rather than surfacing Graph's raw, generic authorization error text.
function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    if (/authorization|forbidden|insufficient/i.test(err.message)) {
      return `${err.message} (This usually means the app registration needs the Microsoft Graph "User.Read.All" application permission, with admin consent granted -- a separate grant from the ARM "Reader" role used for the Resources tab.)`;
    }
    return err.message;
  }
  return 'Unknown error.';
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
    .select('encrypted_payload')
    .eq('company_id', companyId)
    .eq('provider', 'azure')
    .eq('id', credentialId)
    .maybeSingle();

  if (credError) {
    console.error('Failed to look up Azure credentials:', credError);
    return NextResponse.json({ error: 'Could not look up the Azure connection.' }, { status: 500 });
  }

  if (!credRow) {
    return NextResponse.json({ connected: false } satisfies AzureAdUsersResponse);
  }

  let secrets: { tenantId: string; clientId: string; clientSecret: string; subscriptionId: string };
  try {
    secrets = decryptCredentials(credRow.encrypted_payload);
  } catch (err) {
    console.error('Failed to decrypt Azure credentials:', err);
    return NextResponse.json({ error: 'Could not decrypt the stored Azure credentials.' }, { status: 500 });
  }

  let users: AzureAdUserRow[] = [];
  let usersError: string | null = null;
  try {
    const credential = new ClientSecretCredential(secrets.tenantId, secrets.clientId, secrets.clientSecret);
    const authProvider = new TokenCredentialAuthenticationProvider(credential, {
      scopes: ['https://graph.microsoft.com/.default'],
    });
    const client = Client.initWithMiddleware({ authProvider });
    const result = await client.api('/users').select('id,displayName,userPrincipalName,createdDateTime').get();

    // Graph paginates at ~100 users per page via @odata.nextLink -- follow
    // every page with the SDK's own iterator or a tenant with more than one
    // page's worth of users silently loses everyone past the first page.
    const rawUsers: Record<string, unknown>[] = [];
    const pageIterator = new PageIterator(client, result, (user) => {
      rawUsers.push(user as Record<string, unknown>);
      return true;
    });
    await pageIterator.iterate();

    users = rawUsers.map((user) => ({
      id: (user.id as string) ?? '',
      displayName: (user.displayName as string | null) ?? null,
      userPrincipalName: (user.userPrincipalName as string | null) ?? null,
      createdDateTime: user.createdDateTime ? new Date(user.createdDateTime as string).toISOString() : null,
    }));
  } catch (err) {
    usersError = errorMessage(err);
  }

  return NextResponse.json({
    connected: true,
    fetchedAt: new Date().toISOString(),
    users: { data: users, error: usersError },
  } satisfies AzureAdUsersResponse);
}

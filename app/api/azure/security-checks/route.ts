import { NextRequest, NextResponse } from 'next/server';
import { ClientSecretCredential } from '@azure/identity';
import { SecurityCenter } from '@azure/arm-security';
import { NetworkManagementClient } from '@azure/arm-network';
import { SqlManagementClient } from '@azure/arm-sql';
import { StorageManagementClient } from '@azure/arm-storage';
import { WebSiteManagementClient } from '@azure/arm-appservice';
import { Client } from '@microsoft/microsoft-graph-client';
import { TokenCredentialAuthenticationProvider } from '@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials';
import { requireCompanyAccess } from '@/lib/admin-guard';
import { createAdminClient } from '@/lib/supabase/admin';
import { decryptCredentials } from '@/lib/cloudCredentialsCrypto';
import { mapWithConcurrency } from '@/lib/concurrency';
import { unavailableCheck } from '@/lib/findings';
import { classifyDefenderError, normalizeDefenderAssessments } from '@/lib/azure/defender';
import {
  openNsgRules,
  openSqlFirewallRules,
  publicBlobStorage,
  sqlPublicNetworkAccess,
  entraUsersWithoutMfa,
  insecureStorageTransport,
  appServiceNotHttpsOnly,
  normalizeNsgRule,
  type SqlServerInput,
  type StorageAccountInput,
} from '@/lib/azure/securityChecks';
import type { CheckResult, FindingsResponse } from '@/lib/types';

// Used for both the Entra MFA per-user fan-out and the SQL server firewall
// per-server fan-out below -- matches the cap used everywhere else in this
// project.
const AZURE_LOOKUP_CONCURRENCY = 8;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Unknown error.';
}

function permissionHint(err: unknown): string {
  const message = errorMessage(err);
  if ((err as { statusCode?: number })?.statusCode === 403) {
    return `${message} Grant the service principal the Reader role on this subscription.`;
  }
  return message;
}

function resourceGroupFromId(id: string | undefined): string {
  if (!id) return '';
  const match = id.match(/\/resourceGroups\/([^/]+)/i);
  return match ? match[1] : '';
}

async function runCheck(checkId: string, title: string, run: () => Promise<CheckResult>): Promise<CheckResult> {
  try {
    return await run();
  } catch (err) {
    return unavailableCheck(checkId, title, 'builtin', permissionHint(err));
  }
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
    return NextResponse.json({ connected: false } satisfies FindingsResponse);
  }

  let secrets: { tenantId: string; clientId: string; clientSecret: string; subscriptionId: string };
  try {
    secrets = decryptCredentials(credRow.encrypted_payload);
  } catch (err) {
    console.error('Failed to decrypt Azure credentials:', err);
    return NextResponse.json({ error: 'Could not decrypt the stored Azure credentials.' }, { status: 500 });
  }

  const credential = new ClientSecretCredential(secrets.tenantId, secrets.clientId, secrets.clientSecret);
  const subscriptionId = secrets.subscriptionId;

  // Native first, same three-outcome rule as the AWS route.
  const security = new SecurityCenter(credential, subscriptionId);
  let nativeChecks: CheckResult[] | null = null;
  let nativeWarning: CheckResult | null = null;

  try {
    const assessments = [];
    const scope = `/subscriptions/${subscriptionId}`;
    for await (const assessment of security.assessments.list(scope)) {
      // resourceDetails is a polymorphic union keyed by `source`; only the
      // "Azure" variant carries an `id` -- on-premise variants do not.
      const details = assessment.resourceDetails;
      const azureResourceId = details && 'id' in details ? details.id : undefined;
      assessments.push({
        id: assessment.id ?? '',
        assessmentKey: assessment.name ?? '',
        displayName: assessment.displayName ?? 'Defender assessment',
        description: assessment.metadata?.description ?? '',
        severity: assessment.metadata?.severity ?? null,
        statusCode: assessment.status?.code ?? null,
        resourceId: azureResourceId ?? assessment.id ?? '',
        resourceName: (azureResourceId ?? '').split('/').pop() ?? '',
      });
    }
    nativeChecks = normalizeDefenderAssessments(assessments);
  } catch (err) {
    const availability = classifyDefenderError(err);
    if (availability.kind === 'unavailable') {
      nativeWarning = unavailableCheck('defender', 'Microsoft Defender for Cloud', 'native', availability.reason);
    }
  }

  if (nativeChecks && nativeChecks.length > 0) {
    return NextResponse.json({
      connected: true,
      region: null,
      fetchedAt: new Date().toISOString(),
      checks: nativeChecks,
    } satisfies FindingsResponse);
  }

  const network = new NetworkManagementClient(credential, subscriptionId);
  const sql = new SqlManagementClient(credential, subscriptionId);
  const storage = new StorageManagementClient(credential, subscriptionId);
  const web = new WebSiteManagementClient(credential, subscriptionId);

  const checks: CheckResult[] = [];
  if (nativeWarning) checks.push(nativeWarning);

  checks.push(
    await runCheck('open-nsg-rules', 'Network security groups open to the internet', async () => {
      const groups = [];
      for await (const nsg of network.networkSecurityGroups.listAll()) {
        groups.push({
          id: nsg.id ?? '',
          name: nsg.name ?? '',
          location: nsg.location ?? null,
          // ARM populates either the singular field or the plural array,
          // never both, so each rule's values are merged from both --
          // see normalizeNsgRule for why this fold has to happen at all.
          rules: (nsg.securityRules ?? []).map((rule) =>
            normalizeNsgRule({
              name: rule.name ?? '',
              direction: rule.direction ?? null,
              access: rule.access ?? null,
              protocol: rule.protocol ?? null,
              destinationPortRange: rule.destinationPortRange,
              destinationPortRanges: rule.destinationPortRanges,
              sourceAddressPrefix: rule.sourceAddressPrefix,
              sourceAddressPrefixes: rule.sourceAddressPrefixes,
            })
          ),
        });
      }
      return openNsgRules(groups);
    })
  );

  // Both SQL rules share one server list plus its per-server firewall fan-out.
  let sqlServers: SqlServerInput[] | null = null;
  let sqlError: string | null = null;
  try {
    const servers = [];
    for await (const server of sql.servers.list()) {
      servers.push(server);
    }
    sqlServers = await mapWithConcurrency(servers, AZURE_LOOKUP_CONCURRENCY, async (server) => {
      const resourceGroup = resourceGroupFromId(server.id);
      const firewallRules = [];
      try {
        for await (const rule of sql.firewallRules.listByServer(resourceGroup, server.name ?? '')) {
          firewallRules.push({
            name: rule.name ?? '',
            startIpAddress: rule.startIpAddress ?? null,
            endIpAddress: rule.endIpAddress ?? null,
          });
        }
      } catch {
        // A server whose firewall rules we cannot read still contributes to
        // the public-network-access check, so this is not fatal.
      }
      return {
        id: server.id ?? '',
        name: server.name ?? '',
        location: server.location ?? null,
        publicNetworkAccess: server.publicNetworkAccess ?? null,
        firewallRules,
      };
    });
  } catch (err) {
    sqlError = permissionHint(err);
  }

  if (sqlServers) {
    checks.push(openSqlFirewallRules(sqlServers));
    checks.push(sqlPublicNetworkAccess(sqlServers));
  } else {
    const reason = `Could not read SQL servers: ${sqlError}`;
    checks.push(unavailableCheck('open-sql-firewall-rules', 'SQL servers open to any IP address', 'builtin', reason));
    checks.push(
      unavailableCheck('sql-public-network-access', 'SQL servers with public network access', 'builtin', reason)
    );
  }

  // Both storage rules share one account list.
  let storageAccounts: StorageAccountInput[] | null = null;
  let storageError: string | null = null;
  try {
    storageAccounts = [];
    for await (const account of storage.storageAccounts.list()) {
      storageAccounts.push({
        id: account.id ?? '',
        name: account.name ?? '',
        location: account.location ?? null,
        // Azure defaults this to true when the property is absent.
        allowBlobPublicAccess: account.allowBlobPublicAccess !== false,
        httpsOnly: account.enableHttpsTrafficOnly !== false,
        minimumTlsVersion: account.minimumTlsVersion ?? null,
      });
    }
  } catch (err) {
    storageAccounts = null;
    storageError = permissionHint(err);
  }

  if (storageAccounts) {
    checks.push(publicBlobStorage(storageAccounts));
    checks.push(insecureStorageTransport(storageAccounts));
  } else {
    const reason = `Could not read storage accounts: ${storageError}`;
    checks.push(
      unavailableCheck('public-blob-storage', 'Storage accounts allowing public blob access', 'builtin', reason)
    );
    checks.push(
      unavailableCheck(
        'insecure-storage-transport',
        'Storage accounts without enforced HTTPS/TLS 1.2',
        'builtin',
        reason
      )
    );
  }

  checks.push(
    await runCheck('app-service-not-https-only', 'App Services not HTTPS-only', async () => {
      const sites = [];
      for await (const site of web.webApps.list()) {
        sites.push({
          id: site.id ?? '',
          name: site.name ?? '',
          location: site.location ?? null,
          httpsOnly: site.httpsOnly === true,
        });
      }
      return appServiceNotHttpsOnly(sites);
    })
  );

  checks.push(
    await runCheck('entra-users-without-mfa', 'Entra users without MFA', async () => {
      const authProvider = new TokenCredentialAuthenticationProvider(credential, {
        scopes: ['https://graph.microsoft.com/.default'],
      });
      const graph = Client.initWithMiddleware({ authProvider });

      const users: { id: string; displayName: string; userPrincipalName: string; accountEnabled: boolean }[] = [];
      let page = await graph.api('/users').select('id,displayName,userPrincipalName,accountEnabled').get();
      for (;;) {
        users.push(...(page.value ?? []));
        const next = page['@odata.nextLink'];
        if (!next) break;
        page = await graph.api(next).get();
      }

      const rows = await mapWithConcurrency(users, AZURE_LOOKUP_CONCURRENCY, async (user) => {
        const methods = await graph.api(`/users/${user.id}/authentication/methods`).get();
        // Every account has a password method; anything beyond that is a
        // second factor.
        const mfaRegistered = (methods.value ?? []).some(
          (method: { '@odata.type'?: string }) =>
            method['@odata.type'] !== '#microsoft.graph.passwordAuthenticationMethod'
        );
        return {
          id: user.id,
          displayName: user.displayName ?? user.userPrincipalName,
          userPrincipalName: user.userPrincipalName,
          accountEnabled: user.accountEnabled !== false,
          mfaRegistered,
        };
      });

      return entraUsersWithoutMfa(rows);
    })
  );

  // The MFA check needs a Graph permission the other checks do not, so its
  // failure message has to name that permission specifically rather than
  // pointing at the subscription's Reader role.
  const mfaCheckIndex = checks.findIndex((check) => check.checkId === 'entra-users-without-mfa');
  if (mfaCheckIndex >= 0 && checks[mfaCheckIndex].status === 'unavailable') {
    checks[mfaCheckIndex] = unavailableCheck(
      'entra-users-without-mfa',
      'Entra users without MFA',
      'builtin',
      `${checks[mfaCheckIndex].unavailableReason} Reading registered MFA methods needs the Microsoft Graph application permission UserAuthenticationMethod.Read.All, granted with admin consent — this is a separate grant from the User.Read.All permission the Users tab uses.`
    );
  }

  return NextResponse.json({
    connected: true,
    region: null,
    fetchedAt: new Date().toISOString(),
    checks,
  } satisfies FindingsResponse);
}

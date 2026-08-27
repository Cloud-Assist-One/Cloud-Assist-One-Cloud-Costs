import { okCheck } from '@/lib/findings';
import type { CheckResult, Finding, FindingSeverity } from '@/lib/types';

export const SENSITIVE_PORTS = [22, 3389, 3306, 5432, 1433, 27017] as const;

// Azure spells "the whole internet" three different ways depending on
// whether the rule was written by hand, by the portal, or by a template.
const PUBLIC_SOURCES = ['*', 'internet', '0.0.0.0/0', 'any'];

const ACCEPTABLE_TLS_VERSIONS = ['TLS1_2', 'TLS1_3'];

export interface NsgRuleInput {
  name: string;
  direction: string | null;
  access: string | null;
  protocol: string | null;
  destinationPortRanges: string[];
  sourceAddressPrefixes: string[];
}

export interface NsgInput {
  id: string;
  name: string;
  location: string | null;
  rules: NsgRuleInput[];
}

export interface SqlFirewallRuleInput {
  name: string;
  startIpAddress: string | null;
  endIpAddress: string | null;
}

export interface SqlServerInput {
  id: string;
  name: string;
  location: string | null;
  publicNetworkAccess: string | null;
  firewallRules: SqlFirewallRuleInput[];
}

export interface StorageAccountInput {
  id: string;
  name: string;
  location: string | null;
  allowBlobPublicAccess: boolean;
  httpsOnly: boolean;
  minimumTlsVersion: string | null;
}

export interface EntraUserInput {
  id: string;
  displayName: string;
  userPrincipalName: string;
  accountEnabled: boolean;
  mfaRegistered: boolean;
}

export interface AppServiceInput {
  id: string;
  name: string;
  location: string | null;
  httpsOnly: boolean;
}

function finding(
  severity: FindingSeverity,
  resourceId: string,
  resourceName: string,
  region: string | null,
  detail: string
): Finding {
  return { severity, resourceId, resourceName, region, detail, monthlyCost: null };
}

function isPublicSource(prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => PUBLIC_SOURCES.includes(prefix.trim().toLowerCase()));
}

// Azure port ranges are strings: "22", "3000-6000", or "*".
function sensitivePortsInRange(range: string): 'all' | number[] {
  const trimmed = range.trim();
  if (trimmed === '*') return 'all';

  const [startRaw, endRaw] = trimmed.split('-');
  const start = Number(startRaw);
  const end = endRaw === undefined ? start : Number(endRaw);
  if (Number.isNaN(start) || Number.isNaN(end)) return [];
  if (start === 0 && end === 65535) return 'all';

  return SENSITIVE_PORTS.filter((port) => port >= start && port <= end);
}

export function openNsgRules(groups: readonly NsgInput[]): CheckResult {
  const findings: Finding[] = [];

  for (const group of groups) {
    let allPorts = false;
    const ports = new Set<number>();

    for (const rule of group.rules) {
      if (rule.direction !== 'Inbound' || rule.access !== 'Allow') continue;
      if (!isPublicSource(rule.sourceAddressPrefixes)) continue;

      for (const range of rule.destinationPortRanges) {
        const exposed = sensitivePortsInRange(range);
        if (exposed === 'all') allPorts = true;
        else exposed.forEach((port) => ports.add(port));
      }
    }

    if (!allPorts && ports.size === 0) continue;

    const detail = allPorts
      ? `Network security group ${group.name} allows inbound traffic from the internet on all ports.`
      : `Network security group ${group.name} allows inbound traffic from the internet on port ${[...ports]
          .sort((a, b) => a - b)
          .join(', ')}.`;

    findings.push(finding('critical', group.id, group.name, group.location, detail));
  }

  return okCheck('open-nsg-rules', 'Network security groups open to the internet', 'builtin', findings);
}

export function openSqlFirewallRules(servers: readonly SqlServerInput[]): CheckResult {
  const findings: Finding[] = [];

  for (const server of servers) {
    // 0.0.0.0 to 0.0.0.0 is Azure's "allow other Azure services" special
    // case, not an internet-wide opening. Only a rule that actually spans
    // the address space is a finding.
    const openRules = server.firewallRules.filter(
      (rule) => rule.startIpAddress === '0.0.0.0' && rule.endIpAddress === '255.255.255.255'
    );
    if (openRules.length === 0) continue;

    findings.push(
      finding(
        'critical',
        server.id,
        server.name,
        server.location,
        `SQL server ${server.name} has a firewall rule (${openRules
          .map((rule) => rule.name)
          .join(', ')}) that allows connections from any IP address on the internet.`
      )
    );
  }

  return okCheck('open-sql-firewall-rules', 'SQL servers open to any IP address', 'builtin', findings);
}

export function publicBlobStorage(accounts: readonly StorageAccountInput[]): CheckResult {
  const findings = accounts
    .filter((account) => account.allowBlobPublicAccess)
    .map((account) =>
      finding(
        'critical',
        account.id,
        account.name,
        account.location,
        `Storage account ${account.name} allows anonymous public read access to blob containers.`
      )
    );

  return okCheck('public-blob-storage', 'Storage accounts allowing public blob access', 'builtin', findings);
}

export function sqlPublicNetworkAccess(servers: readonly SqlServerInput[]): CheckResult {
  const findings = servers
    .filter((server) => server.publicNetworkAccess === 'Enabled')
    .map((server) =>
      finding(
        'high',
        server.id,
        server.name,
        server.location,
        `SQL server ${server.name} accepts connections over its public endpoint. Disabling public network access limits it to private endpoints.`
      )
    );

  return okCheck('sql-public-network-access', 'SQL servers with public network access', 'builtin', findings);
}

export function entraUsersWithoutMfa(users: readonly EntraUserInput[]): CheckResult {
  const findings = users
    // A disabled account cannot sign in, so its MFA state is not a risk.
    .filter((user) => user.accountEnabled && !user.mfaRegistered)
    .map((user) =>
      finding(
        'high',
        user.id,
        user.userPrincipalName,
        null,
        `${user.displayName} has no MFA method registered.`
      )
    );

  return okCheck('entra-users-without-mfa', 'Entra users without MFA', 'builtin', findings);
}

export function insecureStorageTransport(accounts: readonly StorageAccountInput[]): CheckResult {
  const findings: Finding[] = [];

  for (const account of accounts) {
    const reasons: string[] = [];
    if (!account.httpsOnly) reasons.push('it accepts plain HTTP requests');
    if (account.minimumTlsVersion && !ACCEPTABLE_TLS_VERSIONS.includes(account.minimumTlsVersion)) {
      reasons.push(`its minimum TLS version is ${account.minimumTlsVersion}`);
    }
    if (reasons.length === 0) continue;

    findings.push(
      finding(
        'medium',
        account.id,
        account.name,
        account.location,
        `Storage account ${account.name} does not enforce modern transport security: ${reasons.join(', and ')}.`
      )
    );
  }

  return okCheck('insecure-storage-transport', 'Storage accounts without enforced HTTPS/TLS 1.2', 'builtin', findings);
}

export function appServiceNotHttpsOnly(sites: readonly AppServiceInput[]): CheckResult {
  const findings = sites
    .filter((site) => !site.httpsOnly)
    .map((site) =>
      finding(
        'medium',
        site.id,
        site.name,
        site.location,
        `App Service ${site.name} does not redirect HTTP traffic to HTTPS.`
      )
    );

  return okCheck('app-service-not-https-only', 'App Services not HTTPS-only', 'builtin', findings);
}

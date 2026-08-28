import { okCheck } from '@/lib/findings';
import type { CheckResult, Finding, FindingSeverity } from '@/lib/types';

// Ports where internet-wide exposure is a finding rather than a design
// choice: SSH, RDP, MySQL, Postgres, SQL Server, MongoDB. Port 443 open to
// the world is a web server; port 22 open to the world is an incident
// waiting to happen.
export const SENSITIVE_PORTS = [22, 3389, 3306, 5432, 1433, 27017] as const;

export const ACCESS_KEY_MAX_AGE_DAYS = 90;
export const INACTIVE_USER_DAYS = 90;

const OPEN_CIDRS = ['0.0.0.0/0', '::/0'];

export interface SecurityGroupInboundRule {
  protocol: string | null;
  fromPort: number | null;
  toPort: number | null;
  cidrs: string[];
}

export interface SecurityGroupInput {
  groupId: string;
  groupName: string;
  arn: string;
  region: string;
  inboundRules: SecurityGroupInboundRule[];
}

export interface S3BucketInput {
  name: string;
  region: string;
  publicAccessBlockAll: boolean;
  isPublicByPolicy: boolean;
  hasPublicAcl: boolean;
}

export interface AccountSummaryInput {
  accountAccessKeysPresent: number;
}

export interface RdsSecurityInput {
  arn: string;
  identifier: string;
  publiclyAccessible: boolean;
  storageEncrypted: boolean;
  region: string;
}

export interface IamAccessKeyInput {
  accessKeyId: string;
  createDate: string | null;
  lastUsedDate: string | null;
}

export interface IamUserInput {
  userName: string;
  arn: string;
  hasConsolePassword: boolean;
  mfaDeviceCount: number;
  accessKeys: IamAccessKeyInput[];
  passwordLastUsed: string | null;
}

export interface VolumeEncryptionInput {
  volumeId: string;
  arn: string;
  name: string | null;
  encrypted: boolean;
  region: string;
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

function daysSince(iso: string, now: Date): number {
  return Math.floor((now.getTime() - new Date(iso).getTime()) / 86_400_000);
}

function exposedPorts(rule: SecurityGroupInboundRule): 'all' | number[] {
  if (!rule.cidrs.some((cidr) => OPEN_CIDRS.includes(cidr))) return [];

  // Protocol '-1' means every protocol and every port, and AWS omits the
  // port fields entirely for it.
  if (rule.protocol === '-1' || (rule.fromPort === null && rule.toPort === null)) return 'all';

  const from = rule.fromPort ?? 0;
  const to = rule.toPort ?? 65535;
  if (from === 0 && to === 65535) return 'all';

  return SENSITIVE_PORTS.filter((port) => port >= from && port <= to);
}

export function openSecurityGroups(groups: readonly SecurityGroupInput[]): CheckResult {
  const findings: Finding[] = [];

  for (const group of groups) {
    let allPorts = false;
    const ports = new Set<number>();

    for (const rule of group.inboundRules) {
      const exposed = exposedPorts(rule);
      if (exposed === 'all') allPorts = true;
      else exposed.forEach((port) => ports.add(port));
    }

    if (!allPorts && ports.size === 0) continue;

    // One finding per group, not per rule: a group with five open rules is
    // one thing to go fix, and five near-identical rows buries the others.
    const detail = allPorts
      ? `Security group ${group.groupName} (${group.groupId}) allows inbound traffic from the internet on all ports.`
      : `Security group ${group.groupName} (${group.groupId}) allows inbound traffic from the internet on port ${[...ports]
          .sort((a, b) => a - b)
          .join(', ')}.`;

    findings.push(finding('critical', group.arn, group.groupName, group.region, detail));
  }

  return okCheck('open-security-groups', 'Security groups open to the internet', 'builtin', findings);
}

export function publicS3Buckets(buckets: readonly S3BucketInput[]): CheckResult {
  const findings: Finding[] = [];

  for (const bucket of buckets) {
    const reasons: string[] = [];
    if (!bucket.publicAccessBlockAll) reasons.push('Public Access Block is not fully enabled');
    if (bucket.isPublicByPolicy) reasons.push('its bucket policy grants public access');
    if (bucket.hasPublicAcl) reasons.push('its ACL grants access to everyone');
    if (reasons.length === 0) continue;

    findings.push(
      finding(
        'critical',
        `arn:aws:s3:::${bucket.name}`,
        bucket.name,
        bucket.region,
        `Bucket ${bucket.name} may be reachable publicly: ${reasons.join(', and ')}.`
      )
    );
  }

  return okCheck('public-s3-buckets', 'Publicly accessible S3 buckets', 'builtin', findings);
}

export function rootAccessKeys(summary: AccountSummaryInput, accountId: string): CheckResult {
  const findings =
    summary.accountAccessKeysPresent > 0
      ? [
          finding(
            'critical',
            `arn:aws:iam::${accountId}:root`,
            'root',
            null,
            'The root user has active access keys. Root keys cannot be scoped and should be deleted after moving any automation onto an IAM role.'
          ),
        ]
      : [];

  return okCheck('root-access-keys', 'Root account access keys', 'builtin', findings);
}

export function publicRdsInstances(instances: readonly RdsSecurityInput[]): CheckResult {
  const findings = instances
    .filter((instance) => instance.publiclyAccessible)
    .map((instance) =>
      finding(
        'high',
        instance.arn,
        instance.identifier,
        instance.region,
        `Database ${instance.identifier} is marked publicly accessible, so it is reachable from outside the VPC subject only to its security group.`
      )
    );

  return okCheck('public-rds-instances', 'Publicly accessible databases', 'builtin', findings);
}

export function iamUsersWithoutMfa(users: readonly IamUserInput[]): CheckResult {
  const findings = users
    // A user with no console password cannot sign in interactively, so MFA
    // is not applicable — flagging service users here would be noise.
    .filter((user) => user.hasConsolePassword && user.mfaDeviceCount === 0)
    .map((user) =>
      finding(
        'high',
        user.arn,
        user.userName,
        null,
        `User ${user.userName} can sign in to the console but has no MFA device registered.`
      )
    );

  return okCheck('iam-users-without-mfa', 'Console users without MFA', 'builtin', findings);
}

export function staleAccessKeys(users: readonly IamUserInput[], now: Date): CheckResult {
  const findings: Finding[] = [];

  for (const user of users) {
    const stale = user.accessKeys.filter(
      (key) => key.createDate && daysSince(key.createDate, now) > ACCESS_KEY_MAX_AGE_DAYS
    );
    if (stale.length === 0) continue;

    const oldest = Math.max(...stale.map((key) => daysSince(key.createDate as string, now)));
    findings.push(
      finding(
        'medium',
        user.arn,
        user.userName,
        null,
        `User ${user.userName} has ${stale.length} access key(s) older than ${ACCESS_KEY_MAX_AGE_DAYS} days (${stale
          .map((key) => key.accessKeyId)
          .join(', ')}); the oldest is ${oldest} days old.`
      )
    );
  }

  return okCheck('stale-access-keys', `Access keys older than ${ACCESS_KEY_MAX_AGE_DAYS} days`, 'builtin', findings);
}

export function inactiveIamUsers(users: readonly IamUserInput[], now: Date): CheckResult {
  const findings: Finding[] = [];

  for (const user of users) {
    const activity = [user.passwordLastUsed, ...user.accessKeys.map((key) => key.lastUsedDate)].filter(
      (value): value is string => Boolean(value)
    );

    // No recorded activity at all is ambiguous — a user created yesterday
    // looks exactly like one abandoned two years ago — so it is not a
    // finding. Age-based cleanup is a different check.
    if (activity.length === 0) continue;

    const mostRecent = activity.reduce((latest, value) => (value > latest ? value : latest));
    const idleDays = daysSince(mostRecent, now);
    if (idleDays < INACTIVE_USER_DAYS) continue;

    findings.push(
      finding(
        'medium',
        user.arn,
        user.userName,
        null,
        `User ${user.userName} has not signed in or used an access key in ${idleDays} days.`
      )
    );
  }

  return okCheck('inactive-iam-users', `IAM users inactive over ${INACTIVE_USER_DAYS} days`, 'builtin', findings);
}

export function unencryptedVolumes(volumes: readonly VolumeEncryptionInput[]): CheckResult {
  const findings = volumes
    .filter((volume) => !volume.encrypted)
    .map((volume) =>
      finding(
        'medium',
        volume.arn,
        volume.name ?? volume.volumeId,
        volume.region,
        `Volume ${volume.volumeId} is not encrypted at rest.`
      )
    );

  return okCheck('unencrypted-ebs-volumes', 'Unencrypted EBS volumes', 'builtin', findings);
}

export function unencryptedRdsStorage(instances: readonly RdsSecurityInput[]): CheckResult {
  const findings = instances
    .filter((instance) => !instance.storageEncrypted)
    .map((instance) =>
      finding(
        'medium',
        instance.arn,
        instance.identifier,
        instance.region,
        `Database ${instance.identifier} does not have storage encryption enabled. This can only be changed by restoring from a snapshot into a new encrypted instance.`
      )
    );

  return okCheck('unencrypted-rds-storage', 'Unencrypted database storage', 'builtin', findings);
}

// Renewal windows. A certificate 200 days out is not actionable and listing it
// buries the ones that are; 30 days is the point where a renewal has to be
// scheduled rather than noted.
export const CERT_EXPIRY_HIGH_DAYS = 30;
export const CERT_EXPIRY_MEDIUM_DAYS = 90;

export interface CertificateInput {
  arn: string;
  domainName: string;
  /** ACM's NotAfter. Null when the certificate has no expiry recorded. */
  notAfter: string | null;
  inUse: boolean;
  region: string;
}

export function expiringCertificates(certs: readonly CertificateInput[], now: Date): CheckResult {
  const findings: Finding[] = [];

  for (const cert of certs) {
    // No expiry recorded is absent data, not evidence of a problem — the same
    // rule the inactive-user check follows.
    if (!cert.notAfter) continue;

    const daysLeft = Math.floor((new Date(cert.notAfter).getTime() - now.getTime()) / 86_400_000);
    if (daysLeft > CERT_EXPIRY_MEDIUM_DAYS) continue;

    const severity: FindingSeverity =
      daysLeft < 0 ? 'critical' : daysLeft <= CERT_EXPIRY_HIGH_DAYS ? 'high' : 'medium';

    // Whether anything is actually serving the certificate decides how urgent a
    // renewal is, and ACM reports it, so it belongs in the detail.
    const usage = cert.inUse ? 'in use' : 'not attached to any resource';
    const timing =
      daysLeft < 0
        ? `expired ${Math.abs(daysLeft)} days ago`
        : `expires in ${daysLeft} days (${cert.notAfter.slice(0, 10)})`;

    findings.push({
      severity,
      resourceId: cert.arn,
      resourceName: cert.domainName,
      region: cert.region,
      detail: `Certificate for ${cert.domainName} ${timing}, and is ${usage}.`,
      monthlyCost: null,
    });
  }

  return okCheck('expiring-certificates', 'Certificates expiring or expired', 'builtin', findings);
}

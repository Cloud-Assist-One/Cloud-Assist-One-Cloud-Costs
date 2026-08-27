import { NextRequest, NextResponse } from 'next/server';
import { SecurityHubClient, GetFindingsCommand } from '@aws-sdk/client-securityhub';
import { EC2Client, DescribeSecurityGroupsCommand, DescribeVolumesCommand } from '@aws-sdk/client-ec2';
import {
  IAMClient,
  GetAccountSummaryCommand,
  ListUsersCommand,
  ListAccessKeysCommand,
  ListMFADevicesCommand,
  GetLoginProfileCommand,
  GetAccessKeyLastUsedCommand,
} from '@aws-sdk/client-iam';
import {
  S3Client,
  ListBucketsCommand,
  GetPublicAccessBlockCommand,
  GetBucketPolicyStatusCommand,
  GetBucketAclCommand,
} from '@aws-sdk/client-s3';
import { RDSClient, DescribeDBInstancesCommand } from '@aws-sdk/client-rds';
import { requireCompanyAccess } from '@/lib/admin-guard';
import { createAdminClient } from '@/lib/supabase/admin';
import { decryptCredentials } from '@/lib/cloudCredentialsCrypto';
import { collectPages } from '@/lib/awsPagination';
import { mapWithConcurrency } from '@/lib/concurrency';
import { unavailableCheck } from '@/lib/findings';
import { classifySecurityHubError, normalizeSecurityHubFindings } from '@/lib/aws/securityHub';
import {
  openSecurityGroups,
  publicS3Buckets,
  rootAccessKeys,
  publicRdsInstances,
  iamUsersWithoutMfa,
  staleAccessKeys,
  inactiveIamUsers,
  unencryptedVolumes,
  unencryptedRdsStorage,
  type IamUserInput,
  type RdsSecurityInput,
} from '@/lib/aws/securityChecks';
import type { CheckResult, FindingsResponse } from '@/lib/types';

const BUCKET_LOOKUP_CONCURRENCY = 8;
const USER_LOOKUP_CONCURRENCY = 8;

// Security Hub keeps resolved findings around; only active ones belong on a
// dashboard that tells someone what to go fix.
const ACTIVE_FINDINGS_FILTER = {
  RecordState: [{ Value: 'ACTIVE', Comparison: 'EQUALS' as const }],
  WorkflowStatus: [{ Value: 'RESOLVED', Comparison: 'NOT_EQUALS' as const }],
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Unknown error.';
}

// AWS's raw SDK error text does not reliably name the missing permission
// (and for a non-permission failure, there is nothing to name at all), so
// each check's required action(s) are looked up here and appended rather
// than relying on the SDK message alone. Mirrors the Azure routes'
// permissionHint, which does the same for the service principal's role.
const REQUIRED_PERMISSIONS: Record<string, string> = {
  'open-security-groups': 'ec2:DescribeSecurityGroups',
  'public-s3-buckets': 's3:ListBuckets, GetPublicAccessBlock, GetBucketPolicyStatus, and GetBucketAcl',
  'root-access-keys': 'iam:GetAccountSummary and ListUsers',
  'iam-users-without-mfa': 'iam:ListUsers, ListAccessKeys, ListMFADevices, and GetLoginProfile',
  'stale-access-keys': 'iam:ListUsers and ListAccessKeys',
  'inactive-iam-users': 'iam:ListUsers, ListAccessKeys, and GetLoginProfile',
  'unencrypted-ebs-volumes': 'ec2:DescribeVolumes',
  'public-rds-instances': 'rds:DescribeDBInstances',
  'unencrypted-rds-storage': 'rds:DescribeDBInstances',
};

// The AWS-managed SecurityAudit policy grants every permission in
// REQUIRED_PERMISSIONS above, so it is worth naming once as the fix.
function withPermissionHint(checkId: string, message: string): string {
  const actions = REQUIRED_PERMISSIONS[checkId];
  if (!actions) return message;
  return `${message} The credential needs ${actions}. The AWS-managed SecurityAudit policy covers this and every other permission these checks need.`;
}

async function runCheck(checkId: string, title: string, run: () => Promise<CheckResult>): Promise<CheckResult> {
  try {
    return await run();
  } catch (err) {
    return unavailableCheck(checkId, title, 'builtin', withPermissionHint(checkId, errorMessage(err)));
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
    .select('encrypted_payload, region')
    .eq('company_id', companyId)
    .eq('provider', 'aws')
    .eq('id', credentialId)
    .maybeSingle();

  if (credError) {
    console.error('Failed to look up AWS credentials:', credError);
    return NextResponse.json({ error: 'Could not look up the AWS connection.' }, { status: 500 });
  }

  if (!credRow) {
    return NextResponse.json({ connected: false } satisfies FindingsResponse);
  }

  let secrets: { accessKeyId: string; secretAccessKey: string };
  try {
    secrets = decryptCredentials(credRow.encrypted_payload);
  } catch (err) {
    console.error('Failed to decrypt AWS credentials:', err);
    return NextResponse.json({ error: 'Could not decrypt the stored AWS credentials.' }, { status: 500 });
  }

  const region = credRow.region ?? 'us-east-1';
  const clientConfig = {
    region,
    credentials: { accessKeyId: secrets.accessKeyId, secretAccessKey: secrets.secretAccessKey },
  };

  // Native first. Only a positive "not enabled" signal is allowed to be
  // silent; every other failure produces a visible check.
  const securityHub = new SecurityHubClient(clientConfig);
  let nativeChecks: CheckResult[] | null = null;
  let nativeWarning: CheckResult | null = null;

  try {
    const raw = await collectPages(
      (token) => securityHub.send(new GetFindingsCommand({ Filters: ACTIVE_FINDINGS_FILTER, NextToken: token })),
      (page) => page.Findings ?? [],
      (page) => page.NextToken
    );
    nativeChecks = normalizeSecurityHubFindings(
      raw.map((item) => ({
        id: item.Id ?? '',
        title: item.Title ?? 'Security Hub finding',
        description: item.Description ?? '',
        severityLabel: item.Severity?.Label ?? null,
        region: item.Region ?? region,
        resourceId: item.Resources?.[0]?.Id ?? item.Id ?? '',
        generatorId: item.GeneratorId ?? item.Title ?? 'unknown',
      }))
    );
  } catch (err) {
    const availability = classifySecurityHubError(err);
    if (availability.kind === 'unavailable') {
      nativeWarning = unavailableCheck('securityhub', 'AWS Security Hub', 'native', availability.reason);
    }
  }

  // Security Hub answered, so its controls are the source of truth for this
  // account and the built-in rules would only duplicate them.
  if (nativeChecks && nativeChecks.length > 0) {
    return NextResponse.json({
      connected: true,
      region,
      fetchedAt: new Date().toISOString(),
      checks: nativeChecks,
    } satisfies FindingsResponse);
  }

  const ec2 = new EC2Client(clientConfig);
  const iam = new IAMClient(clientConfig);
  const s3 = new S3Client(clientConfig);
  const rds = new RDSClient(clientConfig);

  const checks: CheckResult[] = [];
  if (nativeWarning) checks.push(nativeWarning);

  checks.push(
    await runCheck('open-security-groups', 'Security groups open to the internet', async () => {
      const groups = await collectPages(
        (token) => ec2.send(new DescribeSecurityGroupsCommand({ NextToken: token })),
        (page) => page.SecurityGroups ?? [],
        (page) => page.NextToken
      );
      return openSecurityGroups(
        groups.map((group) => ({
          groupId: group.GroupId ?? '',
          groupName: group.GroupName ?? '',
          arn: group.GroupId ?? '',
          region,
          inboundRules: (group.IpPermissions ?? []).map((permission) => ({
            protocol: permission.IpProtocol ?? null,
            fromPort: permission.FromPort ?? null,
            toPort: permission.ToPort ?? null,
            cidrs: [
              ...(permission.IpRanges ?? []).map((range) => range.CidrIp ?? ''),
              ...(permission.Ipv6Ranges ?? []).map((range) => range.CidrIpv6 ?? ''),
            ].filter(Boolean),
          })),
        }))
      );
    })
  );

  checks.push(
    await runCheck('public-s3-buckets', 'Publicly accessible S3 buckets', async () => {
      const listed = await s3.send(new ListBucketsCommand({}));
      const rows = await mapWithConcurrency(listed.Buckets ?? [], BUCKET_LOOKUP_CONCURRENCY, async (bucket) => {
        const name = bucket.Name ?? '';

        // Each of these three calls throws its own "not configured" error on
        // a perfectly ordinary bucket, so each is judged on its own.
        let publicAccessBlockAll = false;
        try {
          const block = await s3.send(new GetPublicAccessBlockCommand({ Bucket: name }));
          const config = block.PublicAccessBlockConfiguration;
          publicAccessBlockAll = Boolean(
            config?.BlockPublicAcls && config?.BlockPublicPolicy && config?.IgnorePublicAcls && config?.RestrictPublicBuckets
          );
        } catch {
          publicAccessBlockAll = false;
        }

        let isPublicByPolicy = false;
        try {
          const status = await s3.send(new GetBucketPolicyStatusCommand({ Bucket: name }));
          isPublicByPolicy = Boolean(status.PolicyStatus?.IsPublic);
        } catch {
          isPublicByPolicy = false;
        }

        let hasPublicAcl = false;
        try {
          const acl = await s3.send(new GetBucketAclCommand({ Bucket: name }));
          hasPublicAcl = (acl.Grants ?? []).some((grant) =>
            (grant.Grantee?.URI ?? '').includes('AllUsers')
          );
        } catch {
          hasPublicAcl = false;
        }

        return { name, region, publicAccessBlockAll, isPublicByPolicy, hasPublicAcl };
      });

      return publicS3Buckets(rows);
    })
  );

  checks.push(
    await runCheck('root-access-keys', 'Root account access keys', async () => {
      const summary = await iam.send(new GetAccountSummaryCommand({}));
      const users = await iam.send(new ListUsersCommand({ MaxItems: 1 }));
      // Account ID is not on the summary; the first user's ARN carries it.
      const accountId = users.Users?.[0]?.Arn?.split(':')[4] ?? 'unknown';
      return rootAccessKeys(
        { accountAccessKeysPresent: Number(summary.SummaryMap?.AccountAccessKeysPresent ?? 0) },
        accountId
      );
    })
  );

  // The three IAM user rules share one expensive fan-out, so the users are
  // gathered once and passed to all three.
  let iamUsers: IamUserInput[] | null = null;
  let iamUsersError: string | null = null;
  try {
    const users = await collectPages(
      (token) => iam.send(new ListUsersCommand({ Marker: token })),
      (page) => page.Users ?? [],
      (page) => page.Marker
    );

    iamUsers = await mapWithConcurrency(users, USER_LOOKUP_CONCURRENCY, async (user) => {
      const userName = user.UserName ?? '';

      let hasConsolePassword = false;
      try {
        await iam.send(new GetLoginProfileCommand({ UserName: userName }));
        hasConsolePassword = true;
      } catch {
        // NoSuchEntity here simply means the user has no console password.
        hasConsolePassword = false;
      }

      const mfa = await iam.send(new ListMFADevicesCommand({ UserName: userName }));
      const keys = await iam.send(new ListAccessKeysCommand({ UserName: userName }));

      const accessKeys = await Promise.all(
        (keys.AccessKeyMetadata ?? []).map(async (key) => {
          let lastUsedDate: string | null = null;
          try {
            const lastUsed = await iam.send(new GetAccessKeyLastUsedCommand({ AccessKeyId: key.AccessKeyId }));
            lastUsedDate = lastUsed.AccessKeyLastUsed?.LastUsedDate?.toISOString() ?? null;
          } catch {
            lastUsedDate = null;
          }
          return {
            accessKeyId: key.AccessKeyId ?? '',
            createDate: key.CreateDate?.toISOString() ?? null,
            lastUsedDate,
          };
        })
      );

      return {
        userName,
        arn: user.Arn ?? '',
        hasConsolePassword,
        mfaDeviceCount: mfa.MFADevices?.length ?? 0,
        accessKeys,
        passwordLastUsed: user.PasswordLastUsed?.toISOString() ?? null,
      };
    });
  } catch (err) {
    iamUsersError = errorMessage(err);
  }

  const now = new Date();
  if (iamUsers) {
    checks.push(iamUsersWithoutMfa(iamUsers));
    checks.push(staleAccessKeys(iamUsers, now));
    checks.push(inactiveIamUsers(iamUsers, now));
  } else {
    const baseReason = `Could not read IAM users: ${iamUsersError}`;
    checks.push(
      unavailableCheck(
        'iam-users-without-mfa',
        'Console users without MFA',
        'builtin',
        withPermissionHint('iam-users-without-mfa', baseReason)
      )
    );
    checks.push(
      unavailableCheck(
        'stale-access-keys',
        'Access keys older than 90 days',
        'builtin',
        withPermissionHint('stale-access-keys', baseReason)
      )
    );
    checks.push(
      unavailableCheck(
        'inactive-iam-users',
        'IAM users inactive over 90 days',
        'builtin',
        withPermissionHint('inactive-iam-users', baseReason)
      )
    );
  }

  checks.push(
    await runCheck('unencrypted-ebs-volumes', 'Unencrypted EBS volumes', async () => {
      const volumes = await collectPages(
        (token) => ec2.send(new DescribeVolumesCommand({ NextToken: token })),
        (page) => page.Volumes ?? [],
        (page) => page.NextToken
      );
      return unencryptedVolumes(
        volumes.map((volume) => ({
          volumeId: volume.VolumeId ?? '',
          // Bare id, not a synthesized ARN: without an account-ID segment
          // (this route has no STS/IAM dependency to discover it) the old
          // `arn:aws:ec2:${region}:volume/${id}` form was malformed anyway,
          // and it gave the same volume two different identities between
          // this tab and Cost Leakage's bare-id form. Security findings
          // have no cost join, so nothing here relies on ARN shape.
          arn: volume.VolumeId ?? '',
          name: volume.Tags?.find((tag) => tag.Key === 'Name')?.Value ?? null,
          encrypted: Boolean(volume.Encrypted),
          region,
        }))
      );
    })
  );

  // Both RDS rules read the same list.
  let rdsRows: RdsSecurityInput[] | null = null;
  let rdsError: string | null = null;
  try {
    const dbInstances = await collectPages(
      (token) => rds.send(new DescribeDBInstancesCommand({ Marker: token })),
      (page) => page.DBInstances ?? [],
      (page) => page.Marker
    );
    rdsRows = dbInstances.map((instance) => ({
      arn: instance.DBInstanceArn ?? '',
      identifier: instance.DBInstanceIdentifier ?? '',
      publiclyAccessible: Boolean(instance.PubliclyAccessible),
      storageEncrypted: Boolean(instance.StorageEncrypted),
      region,
    }));
  } catch (err) {
    rdsError = errorMessage(err);
  }

  if (rdsRows) {
    checks.push(publicRdsInstances(rdsRows));
    checks.push(unencryptedRdsStorage(rdsRows));
  } else {
    const baseReason = `Could not read RDS instances: ${rdsError}`;
    checks.push(
      unavailableCheck(
        'public-rds-instances',
        'Publicly accessible databases',
        'builtin',
        withPermissionHint('public-rds-instances', baseReason)
      )
    );
    checks.push(
      unavailableCheck(
        'unencrypted-rds-storage',
        'Unencrypted database storage',
        'builtin',
        withPermissionHint('unencrypted-rds-storage', baseReason)
      )
    );
  }

  return NextResponse.json({
    connected: true,
    region,
    fetchedAt: new Date().toISOString(),
    checks,
  } satisfies FindingsResponse);
}

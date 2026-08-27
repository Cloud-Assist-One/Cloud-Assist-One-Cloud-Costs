# Security Checks & Cost Leakage Sub-Tabs — Design Spec

## Overview

The AWS and Azure tabs each have three sub-tabs today: Overview (cost report), Resources, and IAM Users / Users. This spec adds two more to each provider — **Security Checks** and **Cost Leakage** — for four new sub-tabs total, each backed by its own API route that calls the provider's APIs live and renders findings in a grid.

Both new tabs answer a question the Resources tab cannot. Resources says *what exists*; Security Checks says *what is dangerously configured*, and Cost Leakage says *what is being paid for but not used*. Because both answers have the same shape — a list of flagged resources with a severity, a reason, and a resource identity — all four sub-tabs share a single tab component and a single grid component, parameterized by provider and kind. This departs from the `AwsResourcesTab` / `AzureResourcesTab` precedent of one component per provider, deliberately: the Resources tabs differ because EC2 and Virtual Machines have genuinely different columns, whereas a finding is a finding regardless of cloud. Duplicating the connection-picker / fetch / refresh block four more times would leave six near-identical copies of it in the repo.

Findings are computed live on every visit, exactly like the Resources tab. Nothing is persisted; there are no new database tables and no migrations.

## Goals

- **Native-first, built-in fallback.** Security Checks calls AWS Security Hub (`GetFindings`) and Azure Defender for Cloud (assessments) first. When those services are not enabled on the account — the common case for small customers, since both cost money — the route falls back to a built-in rule set written against the SDKs the project already uses. Each check reports which source produced it so the customer can see the difference.
- **A permissions error must never look like a clean bill of health.** Every check carries a `status` of `'ok'` or `'unavailable'`. A denied `securityhub:GetFindings` or a missing `Security Reader` role renders as a visible warning on that section, never as an empty findings list.
- **Cost Leakage shows real dollars where a price is available, not estimates.** Each leaked resource is matched against `cost_records.resource_id` for the active period and, when matched, shows that resource's actual billed cost — never a pricing API and never a hardcoded rate table. See **Cost join** below for when a resource_id is available to match against in the first place.
- **Rules are pure functions.** All detection logic lives in `lib/` modules that take already-fetched SDK payloads and return findings. They are unit-tested against fixtures with no cloud account and no network.

## Non-goals

- **No utilization-based detection.** Low-CPU instances, idle databases, and rightsizing recommendations all require CloudWatch / Azure Monitor metric queries over a lookback window. Cost Leakage v1 covers orphaned resources only — things that are waste by their configuration alone, with no sampling and therefore no false positives. Metrics-based rules are a candidate follow-up.
- **No persistence, no history, no trend.** Findings are not stored, so "new since last scan" and "resolved" states are out of scope. The `FindingsResponse` shape is designed so persistence could be added later without changing the UI contract.
- **No remediation.** The tabs report; they do not fix, and no route in this spec makes a mutating cloud API call. Every SDK call added here is a read.
- **GCP and Snowflake are untouched.** Those tabs remain bare `CostReportTab` renders.
- **No changes to the existing Resources / IAM Users tabs**, beyond `AppShell`'s sub-tab union widening.

## New dependencies

| Package | Used for |
|---|---|
| `@aws-sdk/client-securityhub` | Native AWS findings (`GetFindings`) |
| `@aws-sdk/client-elastic-load-balancing-v2` | Load balancers with no registered targets |
| `@azure/arm-security` | Native Defender for Cloud assessments |
| `@azure/arm-network` | NSG rules, public IPs, load balancer backend pools, network interfaces |

`@aws-sdk/client-ec2`, `-iam`, `-s3`, `-rds`, `@azure/arm-compute`, `-sql`, `-storage`, `-appservice`, `@azure/identity`, and `@microsoft/microsoft-graph-client` are already dependencies and cover the rest.

## Data contract

Added to `lib/types.ts`:

```ts
export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface Finding {
  severity: FindingSeverity;
  resourceId: string;          // ARN (AWS) or full resource ID (Azure)
  resourceName: string;
  region: string | null;
  detail: string;              // why it tripped, in plain language
  monthlyCost: number | null;  // cost-leakage only; null when unmatched
}

export interface CheckResult {
  checkId: string;                   // stable slug, e.g. 'sg-open-to-internet'
  title: string;                     // 'Security groups open to the internet'
  source: 'native' | 'builtin';
  status: 'ok' | 'unavailable';
  unavailableReason: string | null;  // permission denied, API error, service not enabled
  findings: Finding[];
}

export type FindingsResponse =
  | { connected: false }
  | { connected: true; fetchedAt: string; region: string | null; checks: CheckResult[] };
```

`CheckResult` is the per-check analogue of the existing `AwsResourceResult<T>`'s `{ data, error }` split — the same isolation principle, extended with the source and reason fields these tabs need.

## Files

| File | Purpose |
|---|---|
| `components/reports/FindingsTab.tsx` | Shared tab. Props: `companyId`, `periodId`, `provider: 'aws' \| 'azure'`, `kind: 'security-checks' \| 'cost-leakage'`. Owns the connection picker, fetch, refresh, loading/error/not-connected states. Fetches `/api/{provider}/{kind}`. |
| `components/reports/FindingsTab.module.css` | Reuses the header/account-picker layout from `AwsResourcesTab.module.css`. |
| `components/reports/FindingsGrid.tsx` | One `<section>` per `CheckResult`, severity badge per row, findings sorted critical → low. An `unavailable` check renders its reason in place of the table. Cost column present only when `kind === 'cost-leakage'`. |
| `components/reports/FindingsGrid.module.css` | Styles for `FindingsGrid`. |
| `app/api/aws/security-checks/route.ts` | `GET ?companyId=&credentialId=` |
| `app/api/aws/cost-leakage/route.ts` | `GET ?companyId=&credentialId=&periodId=` |
| `app/api/azure/security-checks/route.ts` | `GET ?companyId=&credentialId=` |
| `app/api/azure/cost-leakage/route.ts` | `GET ?companyId=&credentialId=&periodId=` |
| `lib/findings.ts` | Shared severity ordering and check builders used by all four rule modules. |
| `lib/aws/securityChecks.ts` | Built-in AWS security rules |
| `lib/aws/securityHub.ts` | Security Hub error classification and finding normalization |
| `lib/aws/costLeakage.ts` | AWS orphan rules |
| `lib/azure/securityChecks.ts` | Built-in Azure security rules |
| `lib/azure/defender.ts` | Defender for Cloud error classification and assessment normalization |
| `lib/azure/costLeakage.ts` | Azure orphan rules |
| `lib/findingCosts.ts` | `resource_id` → cost map for a period; case-insensitive matching |
| `components/shell/AppShell.tsx` | Sub-tab unions widened; two new `TabsTrigger`s per provider |

Each route follows the established shape: `requireCompanyAccess` guard, `createAdminClient`, credential row lookup by `company_id` + `provider` + `id`, `decryptCredentials`, `{ connected: false }` when no row, then fan out over checks.

## Checks

### Security — AWS

| Check | Severity | Source |
|---|---|---|
| Security group open to `0.0.0.0/0` on 22 / 3389 / 3306 / 5432 / 1433 / 27017 | critical | `ec2:DescribeSecurityGroups` |
| S3 bucket without Public Access Block, or public via ACL or policy | critical | `s3:GetPublicAccessBlock`, `GetBucketAcl`, `GetBucketPolicyStatus` |
| Root account has active access keys | critical | `iam:GetAccountSummary` |
| RDS instance publicly accessible | high | `rds:DescribeDBInstances` |
| IAM user with a console password and no MFA device | high | `iam:ListUsers`, `GetLoginProfile`, `ListMFADevices` |
| IAM access key older than 90 days | medium | `iam:ListAccessKeys` |
| IAM user with no activity in 90 days | medium | `iam:GetUser`, `ListAccessKeys` last-used |
| EBS volume unencrypted | medium | `ec2:DescribeVolumes` |
| RDS storage unencrypted | medium | `rds:DescribeDBInstances` |

### Security — Azure

| Check | Severity | Source |
|---|---|---|
| NSG rule allowing inbound from `*` / `Internet` on a sensitive port | critical | `@azure/arm-network` |
| SQL firewall rule spanning `0.0.0.0`–`255.255.255.255` | critical | `@azure/arm-sql` |
| Storage account allowing public blob access | critical | `@azure/arm-storage` |
| SQL server with public network access enabled | high | `@azure/arm-sql` |
| Entra user with no MFA method registered | high | Microsoft Graph |
| Storage account not HTTPS-only, or minimum TLS below 1.2 | medium | `@azure/arm-storage` |
| App Service not HTTPS-only | medium | `@azure/arm-appservice` |

### Cost Leakage — AWS

| Check | Source |
|---|---|
| Unattached EBS volumes (state `available`) | `ec2:DescribeVolumes` |
| Unassociated Elastic IPs | `ec2:DescribeAddresses` |
| EC2 instances stopped 30+ days (EBS still billed) | `ec2:DescribeInstances` |
| Snapshots whose source volume no longer exists | `ec2:DescribeSnapshots` + volume cross-reference |
| Load balancers with zero registered targets | `elasticloadbalancingv2:DescribeTargetHealth` |
| NAT gateways in VPCs with no running instances | `ec2:DescribeNatGateways` + instance cross-reference |
| RDS instances left in `stopped` state | `rds:DescribeDBInstances` |

### Cost Leakage — Azure

| Check | Source |
|---|---|
| Unattached managed disks (`diskState === 'Unattached'`) | `@azure/arm-compute` |
| Unassociated public IPs | `@azure/arm-network` |
| VMs stopped but not deallocated (still billed for compute) | `@azure/arm-compute` instance view |
| Snapshots whose source disk no longer exists | `@azure/arm-compute` + disk cross-reference |
| App Service plans with no apps | `@azure/arm-appservice` |
| Load balancers with empty backend pools | `@azure/arm-network` |
| Orphaned network interfaces (attached to no VM) | `@azure/arm-network` |

Severity is not meaningful for leakage findings; those rows carry `severity: 'low'` uniformly and the grid hides the severity column when `kind === 'cost-leakage'`, sorting by `monthlyCost` descending instead.

## Native-first resolution

Security Hub and Defender for Cloud run before the built-in rules. Three outcomes:

1. **Service enabled, findings returned** — normalize into `CheckResult[]` grouped by the native control/assessment, `source: 'native'`. Built-in rules are skipped for that provider.
2. **Service not enabled** — AWS returns `InvalidAccessException`; Azure returns an empty assessment list or a subscription-not-registered error. Both are treated as *not enabled*, not as failures: fall back to built-in rules, `source: 'builtin'`. No error is surfaced, because nothing is wrong.
3. **Service enabled but access denied** — `AccessDeniedException` / 403. This *is* a failure and must be distinguished from case 2. Fall back to built-in rules and additionally emit an `unavailable` check explaining that native findings were refused, so the customer knows the grid is less complete than it could be.

Distinguishing case 2 from case 3 by exception type is the subtle part of this feature and warrants direct test coverage.

## Cost join

`lib/findingCosts.ts` queries only the resource IDs the rules actually flagged, scoped to the caller's own `company_id` (never trust `periodId` alone — it arrives as an unvalidated query parameter and this route runs on the service-role client, so RLS does not enforce the boundary). For each ID it builds a PostgREST `.or()` of up to three terms — exact full id, exact bare id (the segment after the last `/` or `:`), and an `ilike` suffix match (`%/bareId`) to catch a billing row spelled the other way — case-insensitively throughout. The `ilike` term is omitted whenever the bare id contains `_` or `%`, since those are LIKE wildcards rather than literal characters and Azure resource names permit `_`; the two exact-match `eq` terms still apply. IDs are chunked at 60 per query (up to 180 OR-terms) to keep the resulting filter string well under typical proxy/URL length limits. Scanning every line item in a period would exceed Supabase's default row cap and require paging through six figures of rows to price a handful of findings.

An unmatched resource gets `monthlyCost: null` and renders as `—`. It must not render as `$0.00`: a resource absent from the last billing pull is unknown, not free, and the two mean very different things to someone deciding what to delete. When no period is active, the join is skipped entirely and every finding carries `null`.

**`resource_id` is only populated by uploaded cost files.** The in-app AWS billing pull (`app/api/aws/pull-billing/route.ts`) asks Cost Explorer to group results by `SERVICE` and, optionally, a billing-code `TAG` — it never requests or records a per-resource ID. The in-app Azure billing pull (`lib/azureCostQuery.ts`) groups by a single dimension, `MeterCategory`, for the same reason: neither in-app pull has a resource ID to write. `resource_id` is populated only when a customer uploads a Cost and Usage Report (AWS) or a Cost Management export (Azure), via `lib/parseCostFile.ts`, which reads it from a `Resource ID` / `ResourceId` / `LineItem/ResourceId` header. Practically, this means the monthly cost column is only populated for customers who upload cost files; customers who rely solely on the in-app pull will see `—` on every finding, in both Security Checks and Cost Leakage. The findings themselves are unaffected — the rules run identically either way — only the price tag next to them is missing.

## Error handling

Each check is wrapped independently so one failure degrades one section, following the `{ data, error }` precedent in `app/api/aws/resources/route.ts`. A rejected check becomes `status: 'unavailable'` with the error message as `unavailableReason`; it never rejects the whole request.

Per-resource lookups that fan out (S3 bucket policy checks, per-server SQL firewall rules) reuse `mapWithConcurrency` from `lib/concurrency.ts` at the existing concurrency cap of 8, for the same throttling reason documented in the Resources route.

## Permissions

These routes need read permissions the stored credentials may not have today. This is expected to be the most common support question the feature generates, so the `unavailableReason` text must name the specific missing permission rather than echoing a raw SDK error.

- **AWS** — `securityhub:GetFindings`, `ec2:DescribeSecurityGroups`, `DescribeVolumes`, `DescribeAddresses`, `DescribeSnapshots`, `DescribeNatGateways`, `iam:GetAccountSummary`, `ListUsers`, `ListAccessKeys`, `ListMFADevices`, `GetLoginProfile`, `s3:GetBucketPolicyStatus`, `GetBucketAcl`, `GetPublicAccessBlock`, `elasticloadbalancing:DescribeTargetHealth`, `rds:DescribeDBInstances`. The AWS-managed `SecurityAudit` policy covers all of these.
- **Azure** — `Security Reader` on the subscription for Defender assessments, on top of the `Reader` role the Resources tab already requires. Graph `User.Read.All` (already granted for the Users tab) lists the users, but reading which MFA methods each has registered additionally requires the `UserAuthenticationMethod.Read.All` application permission, granted with admin consent. Without it, only the MFA check is unavailable; every other Azure check still runs.

A subscription whose service principal holds only `Reader` will show several Azure sections as unavailable on first run. That is correct behavior, and the reason text should make the fix obvious.

## Verification plan

- **Unit tests** — one suite per rule module against fixture SDK payloads: a security group open to `0.0.0.0/0` on 22 yields a critical finding, one scoped to a CIDR yields none; an `Unattached` disk is flagged, an attached one is not; `InvalidAccessException` triggers silent fallback while `AccessDeniedException` produces an `unavailable` check. `lib/findingCosts.ts` tested for case-insensitive matching and for null-on-miss.
- **Component tests** — `FindingsTab` and `FindingsGrid` via Testing Library with mocked `fetch`, covering connected / not-connected / unavailable-check / empty-findings states, the account picker, refresh, severity sort, and the cost column appearing only for `cost-leakage`. No Jest coverage for the four API routes, per the project's established convention.
- **Gates** — `npm test`, `tsc`, `lint`, and `build` all clean.
- **Live verification** — against the existing real AWS and Azure test connections, confirming that a credential without the added permissions produces readable per-check reasons rather than a falsely clean grid. Rotate the AWS key and Azure client secret afterward, as with prior sub-projects.

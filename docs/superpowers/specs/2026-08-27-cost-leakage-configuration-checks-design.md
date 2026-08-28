# Cost Leakage: Configuration and Rightsizing Checks — Design Spec

## Overview

Cost Leakage today finds **orphaned resources** — an unattached disk, an unassociated IP, a VM stopped but still billing. That catches waste you can see by looking at what exists. It misses waste that comes from how things are *configured*: a bucket with no lifecycle policy quietly accumulating objects forever, a log group set to never expire, an instance three sizes too big for its load.

This adds three such families, each with an AWS and an Azure side:

- **Storage lifecycle** — buckets and storage accounts with no lifecycle policy, plus incomplete multipart uploads that bill as storage indefinitely.
- **Log retention** — log groups that never expire, and Log Analytics workspaces with long retention or no ingestion cap.
- **Underutilized instances** — over-provisioned VMs, read from the providers' own recommendation services rather than computed here.

## Goals

- **Findings stay resource-shaped.** Every finding names a bucket, log group, workspace or instance, so it fits the existing `Finding` contract and the billing cost join unchanged.
- **Rightsizing without metric queries.** AWS Compute Optimizer and Azure Advisor already do the utilization analysis; this reads their conclusions rather than sampling CloudWatch or Azure Monitor.
- **No double-reporting.** Azure Advisor's cost category overlaps with rules this tab already has; the filter is what keeps one piece of waste from appearing twice with two different dollar figures.
- **Caps are reported.** The AWS route's per-bucket fan-out is bounded, and anything a bound excludes is stated rather than silently dropped.

## Non-goals

- **Commitment coverage is deferred to its own spec.** Reservation utilization and Savings Plans coverage are account-level facts, not resources, so they do not fit `Finding` without widening it. They also bill per API request against a tab that recomputes on every visit, which is a pricing decision worth taking deliberately rather than in passing.
- **No Azure multipart-upload equivalent.** Uncommitted blocks are not listable through ARM, so that check is AWS-only. The Azure storage section is genuinely thinner, not incomplete.
- **No change to `Finding`, `cost_records`, or any schema.** This is additive.
- **Estimated savings do not enter the cost column** — see Data model below.

## What already exists and gets reused

- `lib/aws/costLeakage.ts` and `lib/azure/costLeakage.ts` — pure rule modules taking hand-written input types, never SDK types. New rules follow that pattern exactly.
- `okCheck` / `unavailableCheck` from `lib/findings.ts`.
- `mapWithConcurrency` (`lib/concurrency.ts`) at the established cap of 8, and `collectPages` (`lib/awsPagination.ts`).
- `@aws-sdk/client-s3` and `@azure/arm-storage` are already dependencies and cover the lifecycle checks.

**Four new dependencies:** `@aws-sdk/client-cloudwatch-logs`, `@aws-sdk/client-compute-optimizer`, `@azure/arm-operationalinsights`, `@azure/arm-advisor`.

## Data model

**Estimated savings belong in `detail`, never in `monthlyCost`.**

`monthlyCost` means one thing throughout this feature: what the resource actually cost, joined from the customer's billing data, with `null` meaning "not in the last pull". Compute Optimizer and Advisor both return a *projected* saving. Putting that in the same column would make one section out of eight mean something different from the other seven, in a column the UI labels "Monthly cost", with no way for a reader to tell which kind of number they are looking at.

So a rightsizing finding reads:

> Instance `web-3` is over-provisioned. Currently `m5.2xlarge`; Compute Optimizer suggests `m5.large`, an estimated saving of $180/month.

and its cost column shows what that instance actually cost last period, exactly like every other row.

## The checks

### Storage lifecycle

**AWS — buckets without a lifecycle policy.** For each bucket, `GetBucketLifecycleConfiguration`. AWS throws `NoSuchLifecycleConfiguration` when none is set, so **the error is the finding** — it must be caught and interpreted, not treated as a failure. Any other error on a bucket (denied, region trouble) makes that bucket unknown rather than clean, and is reported.

**AWS — stale incomplete multipart uploads.** `ListMultipartUploads` per bucket, keeping uploads initiated more than **7 days** ago. These bill as storage indefinitely, do not appear in the console's object listing, and are invisible until someone goes looking. Reported per bucket with a count and the oldest upload's age, not one finding per upload — a bucket with 4,000 abandoned parts is one thing to fix.

**Azure — storage accounts without a lifecycle policy.** `managementPolicies.get(resourceGroup, accountName, 'default')`; a 404 means no policy. Same rule: the 404 is the finding, any other error is unknown.

### Log retention

**AWS — log groups that never expire.** `DescribeLogGroups`, keeping those where `retentionInDays` is null, which means "keep forever". `storedBytes` arrives on the same call, so the detail states how much has already accumulated — the difference between a noticed setting and an urgent one.

**Azure — workspaces with costly log settings.** Log Analytics always has a retention value (30–730 days), so "no retention" cannot happen. Two things can:

- retention above the free 30-day allowance, which bills per GB-month for the excess;
- **no daily ingestion cap** (`workspaceCapping.dailyQuotaGb` unset), which is unbounded spend rather than accumulated waste.

One check reports whichever applies, joining the reasons the way `insecureStorageTransport` already does for HTTPS and TLS.

### Underutilized instances

**AWS — Compute Optimizer.** `GetEC2InstanceRecommendations`, keeping recommendations whose finding is `OVER_PROVISIONED`, with the current type and the top recommended type.

Compute Optimizer is **opt-in**. When it is not enrolled the API returns `OptInRequiredException`. Unlike Security Hub — where a not-enabled service falls back to built-in rules — there is no fallback here, so the check reports `unavailable` with a reason saying to enable Compute Optimizer. Silence would be indistinguishable from "no over-provisioned instances", which is the opposite conclusion.

**Azure — Advisor.** `recommendations.list()`, filtered to `category === 'Cost'` **and** `impactedField === 'Microsoft.Compute/virtualMachines'`.

That filter is load-bearing. Advisor's cost category also returns unassociated public IPs and unattached disks — both of which this tab already detects with its own rules — and "buy reserved instances", which is the deferred commitment coverage. Without the filter a customer sees the same disk twice, in two sections, with two different cost figures.

## Caps

The AWS Cost Leakage route already reads EC2, ELB and RDS. This adds S3 lifecycle, S3 multipart uploads, CloudWatch Logs and Compute Optimizer, and the two S3 checks fan out per bucket. An account with a thousand buckets would otherwise make two thousand extra calls inside the route's 300-second budget.

**Bucket fan-out cap: 200 buckets**, applied to the lifecycle and multipart checks together, at the existing concurrency of 8.

When the cap bites it has to be visible, and `unavailableReason` is not the place: the check *did* run, so its status is `ok` and that field stays null. Instead each affected check emits **one extra finding** carrying the shortfall:

> **Bucket scan incomplete** — Examined 200 of 1,432 buckets. The remaining 1,232 were not checked for a lifecycle policy.

It sorts with the other findings and reads like one, which is the point: a section reporting "3 buckets without a lifecycle policy" while silently having looked at an eighth of them claims a completeness it does not have. Same rule the bucket pull follows for its own caps.

## Permissions the customer must grant

- **AWS** — `s3:GetLifecycleConfiguration` and `s3:ListBucketMultipartUploads` on the buckets, `logs:DescribeLogGroups`, and `compute-optimizer:GetEC2InstanceRecommendations`. The `ReadOnlyAccess` policy covers all four. Compute Optimizer additionally requires **enrollment**, which is not an IAM grant.
- **Azure** — the existing subscription `Reader` role covers storage management policies, Log Analytics workspaces and Advisor. **No new role is required**, which is worth stating because the last three Azure additions each needed one.

## Error handling

Every check is wrapped independently, as the routes already do: one denied permission degrades one section rather than the tab. Three cases need interpreting rather than reporting:

- `NoSuchLifecycleConfiguration` (AWS) and a 404 from `managementPolicies.get` (Azure) are **findings**, not errors.
- `OptInRequiredException` from Compute Optimizer is an `unavailable` check naming enrollment, not a failure.
- Any other error on a per-bucket lookup makes that bucket unknown and is surfaced, never silently treated as "has a policy".

## Files

- `package.json` — four new dependencies.
- `lib/aws/costLeakage.ts` (+ test) — `bucketsWithoutLifecycle`, `staleMultipartUploads`, `logGroupsWithoutRetention`, `overProvisionedInstances`, and their input types.
- `lib/azure/costLeakage.ts` (+ test) — `storageAccountsWithoutLifecycle`, `workspacesWithCostlyLogSettings`, `advisorRightsizingRecommendations`, and their input types.
- `app/api/aws/cost-leakage/route.ts` — four new checks, the bucket cap, and the S3/Logs/Compute Optimizer clients.
- `app/api/azure/cost-leakage/route.ts` — three new checks and the Storage/OperationalInsights/Advisor clients.

## Verification

- `npm test`, `npx tsc --noEmit`, `npm run lint`, `npm run build`, checking the build's exit code directly.
- **Unit tests per rule**, against fixture inputs: a bucket with and without a policy; multipart uploads either side of the 7-day threshold; a log group with null retention and one with a value; an Azure workspace with long retention, one with no ingestion cap, one with both, and one with neither; an `OVER_PROVISIONED` recommendation and a well-provisioned one; an Advisor list containing a VM rightsizing recommendation alongside a public-IP one, proving the filter excludes the duplicate.
- **The savings-in-detail rule** gets its own test: a rightsizing finding's `monthlyCost` must not be populated from the recommendation's projected saving.
- **Live**: against the real AWS connection, confirm a bucket without a lifecycle policy is found, confirm the Compute Optimizer check reports the enrollment message rather than an empty list when not enrolled, and confirm the Azure Advisor section contains no resource already reported by another section.

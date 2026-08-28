# Cost Leakage Configuration Checks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three families of configuration-based waste detection to Cost Leakage — storage lifecycle, log retention, and underutilized instances — across AWS and Azure.

**Architecture:** Seven new pure rule functions join the existing `lib/aws/costLeakage.ts` and `lib/azure/costLeakage.ts` modules, taking hand-written input types rather than SDK types so every case is testable with no cloud account. The two existing cost-leakage routes gain the SDK calls that feed them. Rightsizing findings come from AWS Compute Optimizer and Azure Advisor rather than from metric queries, so no CloudWatch or Azure Monitor sampling is involved.

**Tech Stack:** Next.js 16 (App Router), TypeScript, AWS SDK v3, Azure ARM SDKs, Jest.

**Spec:** `docs/superpowers/specs/2026-08-27-cost-leakage-configuration-checks-design.md`

## Global Constraints

- **Every commit message ends with a blank line then the trailer** `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
- **Git commands must be scoped to explicit paths.** Always `git add <path>` — never `git add .`, never `git add -A`.
- **Exactly four new dependencies:** `@aws-sdk/client-cloudwatch-logs`, `@aws-sdk/client-compute-optimizer`, `@azure/arm-operationalinsights`, `@azure/arm-advisor`. Nothing else.
- **Code style:** ES modules, `async`/`await` (never `.then()` chains), 2-space indentation, descriptive names. Comment *why*, not *what*.
- **Rule modules must NOT import from `@aws-sdk/*` or `@azure/*`.** They take locally-declared input interfaces. This is what makes them testable without a cloud account.
- **Estimated savings go in the finding's `detail` string, NEVER in `monthlyCost`.** That column means what the resource actually cost per the billing join; a projected saving in the same column would make one section mean something different under a header reading "Monthly cost".
- **Two errors are findings, not failures:** AWS `NoSuchLifecycleConfiguration` and Azure's 404 from `managementPolicies.get` both mean "no lifecycle policy", which is the thing being looked for. **Any other error on those calls leaves that resource unknown and must be surfaced** — never silently treated as "has a policy".
- **Bucket fan-out cap: 200**, shared by the two S3 checks, at the existing concurrency of 8. When it bites, each affected check emits one extra finding stating how many buckets were examined and how many were not.
- **Every finding carries `monthlyCost: null`** from the rule modules — the route fills costs in afterwards, as it already does.
- **Test commands:** `npx jest <path>` for one suite, `npm test` for all. Type check `npx tsc --noEmit`. Lint `npm run lint`. Build `npm run build`.
- **This is not the Next.js in your training data** (16.3.1). Before editing route-handler code read `node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md`. If `AGENTS.md` appears modified in your tree, commit it with your work rather than reverting it.

## File Structure

| File | Responsibility |
|---|---|
| `package.json` (modify) | The four new dependencies |
| `lib/aws/costLeakage.ts` (modify) | Four new rules: `bucketsWithoutLifecycle`, `staleMultipartUploads`, `logGroupsWithoutRetention`, `overProvisionedInstances` |
| `lib/aws/costLeakage.test.ts` (modify) | Their tests |
| `lib/azure/costLeakage.ts` (modify) | Three new rules: `storageAccountsWithoutLifecycle`, `workspacesWithCostlyLogSettings`, `advisorRightsizingRecommendations` |
| `lib/azure/costLeakage.test.ts` (modify) | Their tests |
| `app/api/aws/cost-leakage/route.ts` (modify) | S3 lifecycle + multipart fan-out with the bucket cap, CloudWatch Logs, Compute Optimizer |
| `app/api/azure/cost-leakage/route.ts` (modify) | Storage management policies, Log Analytics workspaces, Advisor |

**Task order.** Tasks 1–3 are the AWS rules (pure, no dependencies between them beyond the shared module). Task 4 wires the AWS route. Tasks 5–6 are the Azure rules, Task 7 wires the Azure route, Task 8 verifies. Nothing depends on a task after it.

---

### Task 1: Dependencies and the AWS storage rules

**Files:**
- Modify: `package.json`
- Modify: `lib/aws/costLeakage.ts`
- Test: `lib/aws/costLeakage.test.ts`

**Interfaces:**
- Consumes: `okCheck` from `@/lib/findings`; `CheckResult`, `Finding` from `@/lib/types`; the module's existing private `leak(resourceId, resourceName, region, detail)` helper
- Produces: `MULTIPART_UPLOAD_STALE_DAYS = 7`; `BucketLifecycleInput`, `MultipartUploadBucketInput`; `bucketsWithoutLifecycle(buckets, scanned?, total?)`, `staleMultipartUploads(buckets, now, scanned?, total?)`

Both rules take optional `scanned` and `total` counts so the route can tell them the bucket cap bit; when `total` exceeds `scanned` they append the shortfall finding the spec requires.

- [ ] **Step 1: Install the four dependencies**

```bash
npm install @aws-sdk/client-cloudwatch-logs @aws-sdk/client-compute-optimizer @azure/arm-operationalinsights @azure/arm-advisor
```

- [ ] **Step 2: Write the failing tests**

Append to `lib/aws/costLeakage.test.ts`, and add `bucketsWithoutLifecycle`, `staleMultipartUploads` and `MULTIPART_UPLOAD_STALE_DAYS` to the existing import block at the top of the file:

```ts
describe('bucketsWithoutLifecycle', () => {
  it('flags a bucket with no lifecycle policy', () => {
    const result = bucketsWithoutLifecycle([
      { name: 'assets', region: 'us-east-1', hasLifecyclePolicy: false, lookupError: null },
    ]);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].resourceName).toBe('assets');
    expect(result.findings[0].monthlyCost).toBeNull();
  });

  it('ignores a bucket that has one', () => {
    const result = bucketsWithoutLifecycle([
      { name: 'archived', region: 'us-east-1', hasLifecyclePolicy: true, lookupError: null },
    ]);

    expect(result.findings).toEqual([]);
  });

  // A denied bucket is unknown, not clean. Reporting it as having a policy
  // would hide real waste behind a permissions gap.
  it('reports a bucket whose policy could not be read, rather than assuming it has one', () => {
    const result = bucketsWithoutLifecycle([
      { name: 'locked', region: 'us-east-1', hasLifecyclePolicy: false, lookupError: 'Access Denied' },
    ]);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].detail).toContain('could not be read');
    expect(result.findings[0].detail).toContain('Access Denied');
  });

  it('adds a shortfall finding when the bucket cap bit', () => {
    const result = bucketsWithoutLifecycle(
      [{ name: 'assets', region: 'us-east-1', hasLifecyclePolicy: true, lookupError: null }],
      200,
      1432
    );

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].detail).toContain('200');
    expect(result.findings[0].detail).toContain('1432');
  });

  it('adds no shortfall finding when every bucket was examined', () => {
    const result = bucketsWithoutLifecycle(
      [{ name: 'assets', region: 'us-east-1', hasLifecyclePolicy: true, lookupError: null }],
      1,
      1
    );

    expect(result.findings).toEqual([]);
  });
});

describe('staleMultipartUploads', () => {
  const now = new Date('2026-08-27T00:00:00.000Z');

  it('flags a bucket with uploads older than the threshold', () => {
    const result = staleMultipartUploads(
      [{ name: 'uploads', region: 'us-east-1', oldestInitiated: '2026-08-01T00:00:00.000Z', staleCount: 12 }],
      now
    );

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].detail).toContain('12');
    expect(result.findings[0].detail).toContain('26 days');
  });

  it('ignores a bucket with no stale uploads', () => {
    const result = staleMultipartUploads(
      [{ name: 'clean', region: 'us-east-1', oldestInitiated: null, staleCount: 0 }],
      now
    );

    expect(result.findings).toEqual([]);
  });

  // One bucket with 4,000 abandoned parts is one thing to go and fix.
  it('reports one finding per bucket rather than one per upload', () => {
    const result = staleMultipartUploads(
      [{ name: 'busy', region: 'us-east-1', oldestInitiated: '2026-07-01T00:00:00.000Z', staleCount: 4000 }],
      now
    );

    expect(result.findings).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx jest lib/aws/costLeakage.test.ts`
Expected: FAIL — `bucketsWithoutLifecycle is not defined`

- [ ] **Step 4: Write the implementation**

Append to `lib/aws/costLeakage.ts`:

```ts
// An upload abandoned for a week is not an upload in progress. AWS bills the
// uploaded parts as storage until the upload is aborted, and they do not
// appear in the console's object listing.
export const MULTIPART_UPLOAD_STALE_DAYS = 7;

export interface BucketLifecycleInput {
  name: string;
  region: string;
  hasLifecyclePolicy: boolean;
  /** Set when the lookup failed for a reason other than "no policy configured". */
  lookupError: string | null;
}

export interface MultipartUploadBucketInput {
  name: string;
  region: string;
  /** Oldest stale upload's initiation time, or null when there are none. */
  oldestInitiated: string | null;
  staleCount: number;
}

// The route caps how many buckets it will examine. A section reporting "3
// buckets without a policy" after looking at an eighth of them claims a
// completeness it has not earned, so the shortfall is stated as its own row.
function shortfallFinding(scanned: number, total: number, what: string): Finding[] {
  if (total <= scanned) return [];
  return [
    leak(
      'bucket-scan-incomplete',
      'Bucket scan incomplete',
      null,
      `Examined ${scanned} of ${total} buckets. The remaining ${total - scanned} were not checked ${what}.`
    ),
  ];
}

export function bucketsWithoutLifecycle(
  buckets: readonly BucketLifecycleInput[],
  scanned = buckets.length,
  total = buckets.length
): CheckResult {
  const findings: Finding[] = [];

  for (const bucket of buckets) {
    if (bucket.lookupError) {
      // Unknown is not clean: saying nothing here would hide real waste behind
      // a permissions gap.
      findings.push(
        leak(
          `arn:aws:s3:::${bucket.name}`,
          bucket.name,
          bucket.region,
          `Bucket ${bucket.name}'s lifecycle policy could not be read (${bucket.lookupError}), so whether it expires old objects is unknown.`
        )
      );
      continue;
    }

    if (bucket.hasLifecyclePolicy) continue;

    findings.push(
      leak(
        `arn:aws:s3:::${bucket.name}`,
        bucket.name,
        bucket.region,
        `Bucket ${bucket.name} has no lifecycle policy, so nothing expires or tiers old objects and its storage bill only grows.`
      )
    );
  }

  findings.push(...shortfallFinding(scanned, total, 'for a lifecycle policy'));

  return okCheck('buckets-without-lifecycle', 'Buckets with no lifecycle policy', 'builtin', findings);
}

export function staleMultipartUploads(
  buckets: readonly MultipartUploadBucketInput[],
  now: Date,
  scanned = buckets.length,
  total = buckets.length
): CheckResult {
  const findings: Finding[] = [];

  for (const bucket of buckets) {
    if (bucket.staleCount === 0 || !bucket.oldestInitiated) continue;

    const days = Math.floor((now.getTime() - new Date(bucket.oldestInitiated).getTime()) / 86_400_000);

    findings.push(
      leak(
        `arn:aws:s3:::${bucket.name}`,
        bucket.name,
        bucket.region,
        `Bucket ${bucket.name} has ${bucket.staleCount} incomplete multipart upload(s), the oldest ${days} days old. Their uploaded parts bill as storage until the uploads are aborted, and they do not show in the object listing.`
      )
    );
  }

  findings.push(...shortfallFinding(scanned, total, 'for incomplete uploads'));

  return okCheck('stale-multipart-uploads', 'Incomplete multipart uploads', 'builtin', findings);
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx jest lib/aws/costLeakage.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json lib/aws/costLeakage.ts lib/aws/costLeakage.test.ts
git commit -m "Add AWS storage lifecycle and multipart upload rules"
```

---

### Task 2: AWS log retention rule

**Files:**
- Modify: `lib/aws/costLeakage.ts`
- Test: `lib/aws/costLeakage.test.ts`

**Interfaces:**
- Consumes: `okCheck`, `CheckResult`, `Finding`, the module's `leak` helper
- Produces: `LogGroupInput`; `logGroupsWithoutRetention(groups: readonly LogGroupInput[]): CheckResult`

- [ ] **Step 1: Write the failing tests**

Append to `lib/aws/costLeakage.test.ts`, adding `logGroupsWithoutRetention` to the import block:

```ts
describe('logGroupsWithoutRetention', () => {
  it('flags a log group that never expires', () => {
    const result = logGroupsWithoutRetention([
      { name: '/aws/lambda/api', arn: 'arn:aws:logs:us-east-1:1:log-group:/aws/lambda/api', retentionInDays: null, storedBytes: 5_368_709_120, region: 'us-east-1' },
    ]);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].resourceName).toBe('/aws/lambda/api');
    expect(result.findings[0].detail).toContain('never expire');
  });

  // The stored size is what turns "a setting nobody chose" into "this is
  // costing real money right now".
  it('states how much has already accumulated', () => {
    const result = logGroupsWithoutRetention([
      { name: '/aws/lambda/api', arn: 'arn:log', retentionInDays: null, storedBytes: 5_368_709_120, region: 'us-east-1' },
    ]);

    expect(result.findings[0].detail).toContain('5.0 GB');
  });

  it('ignores a log group with a retention period set', () => {
    const result = logGroupsWithoutRetention([
      { name: '/aws/lambda/short', arn: 'arn:log', retentionInDays: 30, storedBytes: 1000, region: 'us-east-1' },
    ]);

    expect(result.findings).toEqual([]);
  });

  it('handles a log group whose size is not reported', () => {
    const result = logGroupsWithoutRetention([
      { name: '/aws/new', arn: 'arn:log', retentionInDays: null, storedBytes: null, region: 'us-east-1' },
    ]);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].detail).not.toContain('NaN');
  });

  it('reports nothing for an account with no log groups', () => {
    expect(logGroupsWithoutRetention([]).findings).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest lib/aws/costLeakage.test.ts -t logGroupsWithoutRetention`
Expected: FAIL — `logGroupsWithoutRetention is not defined`

- [ ] **Step 3: Write the implementation**

Append to `lib/aws/costLeakage.ts`:

```ts
export interface LogGroupInput {
  name: string;
  arn: string;
  /** Null means "keep forever" — CloudWatch's default when nobody chose. */
  retentionInDays: number | null;
  storedBytes: number | null;
  region: string;
}

function formatBytes(bytes: number | null): string | null {
  if (bytes === null) return null;
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(bytes / 1024 ** 2).toFixed(0)} MB`;
}

export function logGroupsWithoutRetention(groups: readonly LogGroupInput[]): CheckResult {
  const findings: Finding[] = groups
    .filter((group) => group.retentionInDays === null)
    .map((group) => {
      const size = formatBytes(group.storedBytes);
      // The accumulated size is what separates a setting nobody chose from a
      // bill that is already large.
      const accumulated = size ? ` It currently holds ${size}.` : '';
      return leak(
        group.arn,
        group.name,
        group.region,
        `Log group ${group.name} has no retention period, so its logs never expire.${accumulated}`
      );
    });

  return okCheck('log-groups-without-retention', 'Log groups that never expire', 'builtin', findings);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest lib/aws/costLeakage.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/aws/costLeakage.ts lib/aws/costLeakage.test.ts
git commit -m "Add AWS log retention rule"
```

---

### Task 3: AWS over-provisioned instance rule

**Files:**
- Modify: `lib/aws/costLeakage.ts`
- Test: `lib/aws/costLeakage.test.ts`

**Interfaces:**
- Consumes: `okCheck`, `CheckResult`, `Finding`, the module's `leak` helper
- Produces: `InstanceRecommendationInput`; `overProvisionedInstances(recommendations: readonly InstanceRecommendationInput[]): CheckResult`

**The rule this task exists to enforce:** the recommendation's projected saving goes in the finding's `detail`. `monthlyCost` stays null so the route can fill it from the billing join, exactly like every other rule. A projected saving in that column would make this one section mean something different from the other seven under a header reading "Monthly cost".

- [ ] **Step 1: Write the failing tests**

Append to `lib/aws/costLeakage.test.ts`, adding `overProvisionedInstances` to the import block:

```ts
describe('overProvisionedInstances', () => {
  function recommendation(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      instanceArn: 'arn:aws:ec2:us-east-1:1:instance/i-abc',
      instanceName: 'web-3',
      finding: 'OVER_PROVISIONED',
      currentInstanceType: 'm5.2xlarge',
      recommendedInstanceType: 'm5.large',
      estimatedMonthlySavings: 180,
      region: 'us-east-1',
      ...overrides,
    };
  }

  it('flags an over-provisioned instance with both instance types', () => {
    const result = overProvisionedInstances([recommendation()]);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].detail).toContain('m5.2xlarge');
    expect(result.findings[0].detail).toContain('m5.large');
  });

  it('states the estimated saving in the detail', () => {
    const result = overProvisionedInstances([recommendation()]);

    expect(result.findings[0].detail).toContain('$180');
  });

  // monthlyCost means "what this resource actually cost per the billing join".
  // Putting a projected saving there would make this section's column mean
  // something different from every other section's.
  it('leaves monthlyCost null rather than putting the projected saving in it', () => {
    const result = overProvisionedInstances([recommendation({ estimatedMonthlySavings: 180 })]);

    expect(result.findings[0].monthlyCost).toBeNull();
  });

  it('ignores an instance Compute Optimizer considers optimized', () => {
    const result = overProvisionedInstances([recommendation({ finding: 'OPTIMIZED' })]);

    expect(result.findings).toEqual([]);
  });

  // Under-provisioned is a performance problem, not a cost leak.
  it('ignores an under-provisioned instance', () => {
    const result = overProvisionedInstances([recommendation({ finding: 'UNDER_PROVISIONED' })]);

    expect(result.findings).toEqual([]);
  });

  it('omits the saving when Compute Optimizer did not estimate one', () => {
    const result = overProvisionedInstances([recommendation({ estimatedMonthlySavings: null })]);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].detail).not.toContain('$');
  });

  it('reports nothing when there are no recommendations', () => {
    expect(overProvisionedInstances([]).findings).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest lib/aws/costLeakage.test.ts -t overProvisionedInstances`
Expected: FAIL — `overProvisionedInstances is not defined`

- [ ] **Step 3: Write the implementation**

Append to `lib/aws/costLeakage.ts`:

```ts
export interface InstanceRecommendationInput {
  instanceArn: string;
  instanceName: string;
  /** Compute Optimizer's finding: OPTIMIZED, OVER_PROVISIONED, UNDER_PROVISIONED. */
  finding: string;
  currentInstanceType: string;
  recommendedInstanceType: string | null;
  estimatedMonthlySavings: number | null;
  region: string;
}

export function overProvisionedInstances(
  recommendations: readonly InstanceRecommendationInput[]
): CheckResult {
  const findings: Finding[] = recommendations
    // UNDER_PROVISIONED is a performance problem, not a cost leak.
    .filter((rec) => rec.finding === 'OVER_PROVISIONED')
    .map((rec) => {
      const target = rec.recommendedInstanceType ? `, and suggests ${rec.recommendedInstanceType}` : '';
      // The saving belongs here rather than in monthlyCost: that column carries
      // what the resource actually cost per the billing join, and a projected
      // number in it would mean something different from every other row.
      const saving =
        rec.estimatedMonthlySavings !== null
          ? ` Estimated saving $${rec.estimatedMonthlySavings.toFixed(2)}/month.`
          : '';

      return leak(
        rec.instanceArn,
        rec.instanceName,
        rec.region,
        `Compute Optimizer reports ${rec.instanceName} as over-provisioned at ${rec.currentInstanceType}${target}.${saving}`
      );
    });

  return okCheck('over-provisioned-instances', 'Over-provisioned instances', 'builtin', findings);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest lib/aws/costLeakage.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/aws/costLeakage.ts lib/aws/costLeakage.test.ts
git commit -m "Add AWS over-provisioned instance rule"
```

---

### Task 4: Wire the AWS cost-leakage route

**Files:**
- Modify: `app/api/aws/cost-leakage/route.ts`

**Interfaces:**
- Consumes: `bucketsWithoutLifecycle`, `staleMultipartUploads`, `logGroupsWithoutRetention`, `overProvisionedInstances`, `MULTIPART_UPLOAD_STALE_DAYS` and their input types from `@/lib/aws/costLeakage`; `collectPages` from `@/lib/awsPagination`; `mapWithConcurrency` from `@/lib/concurrency`
- Produces: four new checks in the route's response

Per project convention there are no Jest tests for API routes; this is covered by type check, build, and Task 8's live check.

- [ ] **Step 1: Add the imports and the bucket cap**

Add to the imports at the top of `app/api/aws/cost-leakage/route.ts`:

```ts
import {
  S3Client,
  ListBucketsCommand,
  GetBucketLifecycleConfigurationCommand,
  ListMultipartUploadsCommand,
} from '@aws-sdk/client-s3';
import { CloudWatchLogsClient, DescribeLogGroupsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { ComputeOptimizerClient, GetEC2InstanceRecommendationsCommand } from '@aws-sdk/client-compute-optimizer';
```

and extend the existing import from `@/lib/aws/costLeakage` with `bucketsWithoutLifecycle`, `staleMultipartUploads`, `logGroupsWithoutRetention`, `overProvisionedInstances`, `MULTIPART_UPLOAD_STALE_DAYS`, and the types `BucketLifecycleInput` and `MultipartUploadBucketInput`.

Add beside the route's existing cap constants:

```ts
// Two checks fan out per bucket. An account with a thousand buckets would
// otherwise make two thousand calls inside the 300-second budget, so the scan
// is bounded and the shortfall is reported as its own finding.
const MAX_BUCKETS_SCANNED = 200;
```

- [ ] **Step 2: Add the two S3 checks**

Insert before the route's cost-join block. Both checks share one bucket listing, so it is fetched once:

```ts
  // Both S3 checks walk the same bucket list; listing once and capping here
  // keeps the two checks consistent about which buckets they examined.
  let allBuckets: string[] = [];
  let bucketListError: string | null = null;
  try {
    const listed = await s3.send(new ListBucketsCommand({}));
    allBuckets = (listed.Buckets ?? []).map((bucket) => bucket.Name ?? '').filter(Boolean);
  } catch (err) {
    bucketListError = errorMessage(err);
  }

  const scannedBuckets = allBuckets.slice(0, MAX_BUCKETS_SCANNED);

  checks.push(
    await runCheck('buckets-without-lifecycle', 'Buckets with no lifecycle policy', async () => {
      if (bucketListError) throw new Error(`Could not list buckets: ${bucketListError}`);

      const rows = await mapWithConcurrency(scannedBuckets, BUCKET_LOOKUP_CONCURRENCY, async (name) => {
        const row: BucketLifecycleInput = { name, region, hasLifecyclePolicy: false, lookupError: null };
        try {
          const config = await s3.send(new GetBucketLifecycleConfigurationCommand({ Bucket: name }));
          row.hasLifecyclePolicy = (config.Rules ?? []).length > 0;
        } catch (err) {
          // NoSuchLifecycleConfiguration IS the finding — a bucket with no
          // policy throws rather than returning an empty list. Anything else
          // leaves the bucket unknown, which the rule reports separately.
          const name_ = err instanceof Error ? err.name : '';
          if (name_ !== 'NoSuchLifecycleConfiguration') row.lookupError = errorMessage(err);
        }
        return row;
      });

      return bucketsWithoutLifecycle(rows, scannedBuckets.length, allBuckets.length);
    })
  );

  checks.push(
    await runCheck('stale-multipart-uploads', 'Incomplete multipart uploads', async () => {
      if (bucketListError) throw new Error(`Could not list buckets: ${bucketListError}`);

      const staleBefore = Date.now() - MULTIPART_UPLOAD_STALE_DAYS * 86_400_000;

      const rows = await mapWithConcurrency(scannedBuckets, BUCKET_LOOKUP_CONCURRENCY, async (name) => {
        const row: MultipartUploadBucketInput = { name, region, oldestInitiated: null, staleCount: 0 };
        try {
          const uploads = await collectPages(
            (token) => s3.send(new ListMultipartUploadsCommand({ Bucket: name, KeyMarker: token })),
            (page) => page.Uploads ?? [],
            (page) => page.NextKeyMarker
          );
          for (const upload of uploads) {
            const initiated = upload.Initiated?.getTime();
            if (initiated === undefined || initiated > staleBefore) continue;
            row.staleCount += 1;
            const iso = new Date(initiated).toISOString();
            if (!row.oldestInitiated || iso < row.oldestInitiated) row.oldestInitiated = iso;
          }
        } catch {
          // A bucket whose uploads cannot be listed contributes nothing rather
          // than failing the whole check; the lifecycle check above already
          // surfaces a denied bucket.
        }
        return row;
      });

      return staleMultipartUploads(rows, new Date(), scannedBuckets.length, allBuckets.length);
    })
  );
```

Declare the S3 client alongside the route's other clients:

```ts
  const s3 = new S3Client({ ...clientConfig, followRegionRedirects: true });
```

`BUCKET_LOOKUP_CONCURRENCY` is 8 — reuse the existing concurrency constant in this file if one is already named, rather than adding a second.

- [ ] **Step 3: Add the log retention check**

```ts
  checks.push(
    await runCheck('log-groups-without-retention', 'Log groups that never expire', async () => {
      const logs = new CloudWatchLogsClient(clientConfig);
      const groups = await collectPages(
        (token) => logs.send(new DescribeLogGroupsCommand({ nextToken: token })),
        (page) => page.logGroups ?? [],
        (page) => page.nextToken
      );

      return logGroupsWithoutRetention(
        groups.map((group) => ({
          name: group.logGroupName ?? '',
          arn: group.arn ?? group.logGroupName ?? '',
          retentionInDays: group.retentionInDays ?? null,
          storedBytes: group.storedBytes ?? null,
          region,
        }))
      );
    })
  );
```

- [ ] **Step 4: Add the Compute Optimizer check**

```ts
  checks.push(
    await runCheck('over-provisioned-instances', 'Over-provisioned instances', async () => {
      const optimizer = new ComputeOptimizerClient(clientConfig);
      try {
        const recommendations = await collectPages(
          (token) => optimizer.send(new GetEC2InstanceRecommendationsCommand({ nextToken: token })),
          (page) => page.instanceRecommendations ?? [],
          (page) => page.nextToken
        );

        return overProvisionedInstances(
          recommendations.map((rec) => ({
            instanceArn: rec.instanceArn ?? '',
            instanceName: rec.instanceName ?? rec.instanceArn?.split('/').pop() ?? '',
            finding: rec.finding ?? '',
            currentInstanceType: rec.currentInstanceType ?? '',
            recommendedInstanceType: rec.recommendationOptions?.[0]?.instanceType ?? null,
            estimatedMonthlySavings:
              rec.recommendationOptions?.[0]?.savingsOpportunity?.estimatedMonthlySavings?.value ?? null,
            region,
          }))
        );
      } catch (err) {
        // Compute Optimizer is opt-in. Unlike Security Hub there is no built-in
        // fallback here, so going quiet would read as "no over-provisioned
        // instances" — the opposite conclusion.
        if (err instanceof Error && err.name === 'OptInRequiredException') {
          throw new Error(
            'AWS Compute Optimizer is not enabled for this account. Enable it in the Compute Optimizer console to see rightsizing recommendations here.'
          );
        }
        throw err;
      }
    })
  );
```

- [ ] **Step 5: Verify**

Run: `npx tsc --noEmit && npm run lint && npm run build`
Expected: no type errors, no lint errors, build succeeds

If the SDK's own types disagree with any field path above (`savingsOpportunity`, `recommendationOptions`), **follow the installed types rather than this plan** and record the difference in your report.

- [ ] **Step 6: Commit**

```bash
git add app/api/aws/cost-leakage/route.ts
git commit -m "Wire storage, log retention and rightsizing checks into the AWS route"
```

---

### Task 5: Azure storage lifecycle and log retention rules

**Files:**
- Modify: `lib/azure/costLeakage.ts`
- Test: `lib/azure/costLeakage.test.ts`

**Interfaces:**
- Consumes: `okCheck`, `CheckResult`, `Finding`, the module's `leak` helper
- Produces: `LOG_ANALYTICS_FREE_RETENTION_DAYS = 30`; `StorageLifecycleInput`, `LogAnalyticsWorkspaceInput`; `storageAccountsWithoutLifecycle(accounts)`, `workspacesWithCostlyLogSettings(workspaces)`

- [ ] **Step 1: Write the failing tests**

Append to `lib/azure/costLeakage.test.ts`, adding both function names to the import block:

```ts
describe('storageAccountsWithoutLifecycle', () => {
  it('flags an account with no management policy', () => {
    const result = storageAccountsWithoutLifecycle([
      { id: '/subscriptions/s1/storage/sa1', name: 'sa1', location: 'eastus', hasLifecyclePolicy: false, lookupError: null },
    ]);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].resourceName).toBe('sa1');
  });

  it('ignores an account that has one', () => {
    const result = storageAccountsWithoutLifecycle([
      { id: '/subscriptions/s1/storage/sa2', name: 'sa2', location: 'eastus', hasLifecyclePolicy: true, lookupError: null },
    ]);

    expect(result.findings).toEqual([]);
  });

  // Unknown is not clean — the same rule the AWS bucket check follows.
  it('reports an account whose policy could not be read', () => {
    const result = storageAccountsWithoutLifecycle([
      { id: '/subscriptions/s1/storage/sa3', name: 'sa3', location: 'eastus', hasLifecyclePolicy: false, lookupError: 'Forbidden' },
    ]);

    expect(result.findings[0].detail).toContain('could not be read');
    expect(result.findings[0].detail).toContain('Forbidden');
  });
});

describe('workspacesWithCostlyLogSettings', () => {
  function workspace(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      id: '/subscriptions/s1/workspaces/law-prod',
      name: 'law-prod',
      location: 'eastus',
      retentionInDays: 30,
      dailyQuotaGb: 5,
      ...overrides,
    };
  }

  it('flags retention above the free allowance', () => {
    const result = workspacesWithCostlyLogSettings([workspace({ retentionInDays: 180 })]);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].detail).toContain('180 days');
  });

  it('flags a workspace with no daily ingestion cap', () => {
    const result = workspacesWithCostlyLogSettings([workspace({ dailyQuotaGb: null })]);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].detail).toContain('no daily ingestion cap');
  });

  it('reports both reasons in one finding when both apply', () => {
    const result = workspacesWithCostlyLogSettings([workspace({ retentionInDays: 365, dailyQuotaGb: null })]);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].detail).toContain('365 days');
    expect(result.findings[0].detail).toContain('no daily ingestion cap');
  });

  it('ignores a workspace at the free retention with a cap set', () => {
    const result = workspacesWithCostlyLogSettings([workspace()]);

    expect(result.findings).toEqual([]);
  });

  it('treats the free allowance itself as fine, not costly', () => {
    const result = workspacesWithCostlyLogSettings([workspace({ retentionInDays: 30 })]);

    expect(result.findings).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest lib/azure/costLeakage.test.ts`
Expected: FAIL — `storageAccountsWithoutLifecycle is not defined`

- [ ] **Step 3: Write the implementation**

Append to `lib/azure/costLeakage.ts`:

```ts
// Log Analytics includes 30 days of retention; beyond that bills per GB-month.
export const LOG_ANALYTICS_FREE_RETENTION_DAYS = 30;

export interface StorageLifecycleInput {
  id: string;
  name: string;
  location: string | null;
  hasLifecyclePolicy: boolean;
  /** Set when the lookup failed for a reason other than "no policy configured". */
  lookupError: string | null;
}

export interface LogAnalyticsWorkspaceInput {
  id: string;
  name: string;
  location: string | null;
  retentionInDays: number | null;
  /** Null means no daily cap, so ingestion spend is unbounded. */
  dailyQuotaGb: number | null;
}

export function storageAccountsWithoutLifecycle(
  accounts: readonly StorageLifecycleInput[]
): CheckResult {
  const findings: Finding[] = [];

  for (const account of accounts) {
    if (account.lookupError) {
      // Unknown is not clean: staying silent would hide real waste behind a
      // permissions gap.
      findings.push(
        leak(
          account.id,
          account.name,
          account.location,
          `Storage account ${account.name}'s lifecycle policy could not be read (${account.lookupError}), so whether it tiers or expires old blobs is unknown.`
        )
      );
      continue;
    }

    if (account.hasLifecyclePolicy) continue;

    findings.push(
      leak(
        account.id,
        account.name,
        account.location,
        `Storage account ${account.name} has no lifecycle management policy, so nothing tiers or expires old blobs and its storage bill only grows.`
      )
    );
  }

  return okCheck(
    'storage-accounts-without-lifecycle',
    'Storage accounts with no lifecycle policy',
    'builtin',
    findings
  );
}

export function workspacesWithCostlyLogSettings(
  workspaces: readonly LogAnalyticsWorkspaceInput[]
): CheckResult {
  const findings: Finding[] = [];

  for (const workspace of workspaces) {
    const reasons: string[] = [];

    // Log Analytics always has a retention value, so "no retention" cannot
    // happen here the way it can on CloudWatch — the leak is retention bought
    // beyond the included allowance.
    if (workspace.retentionInDays !== null && workspace.retentionInDays > LOG_ANALYTICS_FREE_RETENTION_DAYS) {
      reasons.push(
        `retention is ${workspace.retentionInDays} days, beyond the ${LOG_ANALYTICS_FREE_RETENTION_DAYS} included`
      );
    }

    // Unbounded ingestion is future spend rather than accumulated waste, but it
    // is the setting that turns a noisy app into a surprise invoice.
    if (workspace.dailyQuotaGb === null) {
      reasons.push('there is no daily ingestion cap, so ingestion spend is unbounded');
    }

    if (reasons.length === 0) continue;

    findings.push(
      leak(
        workspace.id,
        workspace.name,
        workspace.location,
        `Log Analytics workspace ${workspace.name}: ${reasons.join(', and ')}.`
      )
    );
  }

  return okCheck(
    'workspaces-costly-log-settings',
    'Log Analytics workspaces with costly settings',
    'builtin',
    findings
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest lib/azure/costLeakage.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/azure/costLeakage.ts lib/azure/costLeakage.test.ts
git commit -m "Add Azure storage lifecycle and Log Analytics rules"
```

---

### Task 6: Azure Advisor rightsizing rule

**Files:**
- Modify: `lib/azure/costLeakage.ts`
- Test: `lib/azure/costLeakage.test.ts`

**Interfaces:**
- Consumes: `okCheck`, `CheckResult`, `Finding`, the module's `leak` helper
- Produces: `AdvisorRecommendationInput`; `advisorRightsizingRecommendations(recommendations): CheckResult`

**The filter is the point of this task.** Advisor's cost category also returns unassociated public IPs and unattached disks — both already detected by this tab's own rules — and reserved-instance advice, which is deferred commitment coverage. Without the filter a customer sees the same disk twice, in two sections, with two different cost figures.

- [ ] **Step 1: Write the failing tests**

Append to `lib/azure/costLeakage.test.ts`, adding `advisorRightsizingRecommendations` to the import block:

```ts
describe('advisorRightsizingRecommendations', () => {
  function rec(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      id: '/subscriptions/s1/recommendations/r1',
      category: 'Cost',
      impactedField: 'Microsoft.Compute/virtualMachines',
      impactedValue: 'vm-web-3',
      problem: 'Right-size or shutdown underutilized virtual machines',
      savingsAmount: 92.4,
      savingsCurrency: 'USD',
      ...overrides,
    };
  }

  it('flags a virtual machine rightsizing recommendation', () => {
    const result = advisorRightsizingRecommendations([rec()]);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].resourceName).toBe('vm-web-3');
  });

  it('states the estimated saving in the detail', () => {
    const result = advisorRightsizingRecommendations([rec()]);

    expect(result.findings[0].detail).toContain('92.40');
  });

  // Same rule as the AWS side: monthlyCost is the billing join, not a forecast.
  it('leaves monthlyCost null rather than putting the projected saving in it', () => {
    const result = advisorRightsizingRecommendations([rec()]);

    expect(result.findings[0].monthlyCost).toBeNull();
  });

  // This tab already reports unassociated public IPs with its own rule. Showing
  // Advisor's copy too would report one piece of waste twice, with two figures.
  it('excludes a recommendation about a resource type this tab already covers', () => {
    const result = advisorRightsizingRecommendations([
      rec({ impactedField: 'Microsoft.Network/publicIPAddresses', impactedValue: 'ip-1' }),
    ]);

    expect(result.findings).toEqual([]);
  });

  it('excludes reserved-instance advice, which is deferred commitment coverage', () => {
    const result = advisorRightsizingRecommendations([
      rec({ impactedField: 'Microsoft.Subscription', problem: 'Buy virtual machine reserved instances to save money' }),
    ]);

    expect(result.findings).toEqual([]);
  });

  it('excludes a non-cost recommendation', () => {
    const result = advisorRightsizingRecommendations([rec({ category: 'HighAvailability' })]);

    expect(result.findings).toEqual([]);
  });

  it('omits the saving when Advisor did not provide one', () => {
    const result = advisorRightsizingRecommendations([rec({ savingsAmount: null })]);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].detail).not.toContain('saving');
  });

  it('reports nothing for an empty recommendation list', () => {
    expect(advisorRightsizingRecommendations([]).findings).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest lib/azure/costLeakage.test.ts -t advisorRightsizingRecommendations`
Expected: FAIL — `advisorRightsizingRecommendations is not defined`

- [ ] **Step 3: Write the implementation**

Append to `lib/azure/costLeakage.ts`:

```ts
// Advisor's Cost category is broader than this check. It also returns
// unassociated public IPs and unattached disks -- both of which this tab
// already detects with its own rules -- and reserved-instance advice, which is
// deferred commitment coverage. Scoping to virtual machines is what keeps one
// piece of waste from appearing twice with two different cost figures.
const RIGHTSIZING_IMPACTED_FIELD = 'microsoft.compute/virtualmachines';

export interface AdvisorRecommendationInput {
  id: string;
  category: string;
  impactedField: string;
  impactedValue: string;
  problem: string;
  savingsAmount: number | null;
  savingsCurrency: string | null;
}

export function advisorRightsizingRecommendations(
  recommendations: readonly AdvisorRecommendationInput[]
): CheckResult {
  const findings: Finding[] = recommendations
    .filter(
      (rec) =>
        rec.category === 'Cost' && rec.impactedField.toLowerCase() === RIGHTSIZING_IMPACTED_FIELD
    )
    .map((rec) => {
      // The saving goes in the detail, not monthlyCost: that column carries what
      // the resource actually cost per the billing join.
      const saving =
        rec.savingsAmount !== null
          ? ` Estimated saving ${rec.savingsAmount.toFixed(2)} ${rec.savingsCurrency ?? ''}`.trimEnd() + '/month.'
          : '';

      return leak(
        rec.id,
        rec.impactedValue,
        null,
        `Azure Advisor: ${rec.problem} — ${rec.impactedValue}.${saving}`
      );
    });

  return okCheck('advisor-rightsizing', 'Underutilized virtual machines', 'builtin', findings);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest lib/azure/costLeakage.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/azure/costLeakage.ts lib/azure/costLeakage.test.ts
git commit -m "Add Azure Advisor rightsizing rule"
```

---

### Task 7: Wire the Azure cost-leakage route

**Files:**
- Modify: `app/api/azure/cost-leakage/route.ts`

**Interfaces:**
- Consumes: `storageAccountsWithoutLifecycle`, `workspacesWithCostlyLogSettings`, `advisorRightsizingRecommendations` and their input types from `@/lib/azure/costLeakage`; `mapWithConcurrency` from `@/lib/concurrency`
- Produces: three new checks in the route's response

No Jest tests for API routes, per project convention.

- [ ] **Step 1: Add the imports**

```ts
import { OperationalInsightsManagementClient } from '@azure/arm-operationalinsights';
import { AdvisorManagementClient } from '@azure/arm-advisor';
```

`StorageManagementClient` from `@azure/arm-storage` is already imported by the sibling security route; add it here too if this file does not already have it. Extend the `@/lib/azure/costLeakage` import with the three new functions and the type `StorageLifecycleInput`.

- [ ] **Step 2: Add the storage lifecycle check**

```ts
  checks.push(
    await runCheck('storage-accounts-without-lifecycle', 'Storage accounts with no lifecycle policy', async () => {
      const storage = new StorageManagementClient(credential, subscriptionId);

      const accounts = [];
      for await (const account of storage.storageAccounts.list()) {
        accounts.push(account);
      }

      const rows = await mapWithConcurrency(accounts, AZURE_LOOKUP_CONCURRENCY, async (account) => {
        const resourceGroup = resourceGroupFromId(account.id);
        const row: StorageLifecycleInput = {
          id: account.id ?? '',
          name: account.name ?? '',
          location: account.location ?? null,
          hasLifecyclePolicy: false,
          lookupError: null,
        };
        try {
          const policy = await storage.managementPolicies.get(resourceGroup, account.name ?? '', 'default');
          row.hasLifecyclePolicy = (policy.policy?.rules ?? []).length > 0;
        } catch (err) {
          // A 404 IS the finding: no management policy is configured. Anything
          // else leaves the account unknown, which the rule reports separately.
          const status = (err as { statusCode?: number })?.statusCode;
          if (status !== 404) row.lookupError = errorMessage(err);
        }
        return row;
      });

      return storageAccountsWithoutLifecycle(rows);
    })
  );
```

If this route has no `resourceGroupFromId` helper, copy the one from `app/api/azure/security-checks/route.ts` — it is the established pattern in this codebase for recovering a resource group from an ARM id.

- [ ] **Step 3: Add the Log Analytics check**

```ts
  checks.push(
    await runCheck('workspaces-costly-log-settings', 'Log Analytics workspaces with costly settings', async () => {
      const insights = new OperationalInsightsManagementClient(credential, subscriptionId);

      const rows = [];
      for await (const workspace of insights.workspaces.list()) {
        rows.push({
          id: workspace.id ?? '',
          name: workspace.name ?? '',
          location: workspace.location ?? null,
          retentionInDays: workspace.retentionInDays ?? null,
          dailyQuotaGb: workspace.workspaceCapping?.dailyQuotaGb ?? null,
        });
      }

      return workspacesWithCostlyLogSettings(rows);
    })
  );
```

**Note on the daily quota:** Azure reports "no cap" as `-1` on some API versions rather than omitting the field. Check the installed SDK's typing and the value it returns; if `-1` is what arrives, map it to `null` here so the rule sees "no cap" as the spec intends. Record which behaviour you found in your report.

- [ ] **Step 4: Add the Advisor check**

```ts
  checks.push(
    await runCheck('advisor-rightsizing', 'Underutilized virtual machines', async () => {
      const advisor = new AdvisorManagementClient(credential, subscriptionId);

      const rows = [];
      for await (const rec of advisor.recommendations.list()) {
        const properties = rec as {
          category?: string;
          impactedField?: string;
          impactedValue?: string;
          shortDescription?: { problem?: string };
          extendedProperties?: Record<string, string>;
        };
        const savings = Number(properties.extendedProperties?.savingsAmount);
        rows.push({
          id: rec.id ?? '',
          category: properties.category ?? '',
          impactedField: properties.impactedField ?? '',
          impactedValue: properties.impactedValue ?? '',
          problem: properties.shortDescription?.problem ?? 'Underutilized resource',
          savingsAmount: Number.isFinite(savings) ? savings : null,
          savingsCurrency: properties.extendedProperties?.savingsCurrency ?? null,
        });
      }

      return advisorRightsizingRecommendations(rows);
    })
  );
```

- [ ] **Step 5: Verify**

Run: `npx tsc --noEmit && npm run lint && npm run build`
Expected: no type errors, no lint errors, build succeeds

If the installed SDK's types disagree with any field path above, **follow the types rather than this plan** and record the difference in your report.

- [ ] **Step 6: Commit**

```bash
git add app/api/azure/cost-leakage/route.ts
git commit -m "Wire storage, log retention and Advisor checks into the Azure route"
```

---

### Task 8: Full verification

**Files:** none — this task runs the gates.

- [ ] **Step 1: Run the whole suite**

Run: `npm test`
Expected: every suite passes, including the new cases in `lib/aws/costLeakage.test.ts` and `lib/azure/costLeakage.test.ts`, and every pre-existing suite **unchanged**

- [ ] **Step 2: Type check, lint, build**

Run: `npx tsc --noEmit && npm run lint && npm run build`
Expected: no type errors; lint clean apart from the pre-existing `LineItemsTab` warning; build succeeds

- [ ] **Step 3: Confirm the savings-in-detail rule held**

Run: `npx jest lib/aws/costLeakage.test.ts lib/azure/costLeakage.test.ts -t "monthlyCost null"`
Expected: PASS — both rightsizing rules leave `monthlyCost` null rather than populating it with a projected saving. This is the rule most likely to be "helpfully" broken by a later change.

- [ ] **Step 4: Live check — what mocks cannot cover**

Against the real AWS connection on Test Company:

1. Open **Cost Leakage** and confirm four new sections appear.
2. Confirm a bucket you know has no lifecycle policy is listed, and one that has a policy is not.
3. If Compute Optimizer is not enrolled, confirm the Over-provisioned instances section says so and names enrollment — not an empty "no findings".
4. Confirm no section reports a resource that another section already reported.

Against the real Azure connection:

5. Confirm the three Azure sections appear and that the Advisor section contains **only** virtual machines — no public IPs, no disks, no reserved-instance advice.

- [ ] **Step 5: Commit any fixes**

If the live check surfaced fixes, commit them describing what the live run revealed. If nothing needed changing, say so rather than creating an empty commit.

---

## Self-Review

**Spec coverage.** Every spec section maps to a task: the four dependencies → Task 1; storage lifecycle both clouds → Tasks 1 and 5; multipart uploads → Task 1; log retention both clouds → Tasks 2 and 5; underutilized instances both clouds → Tasks 3 and 6; the savings-in-`detail` rule → Tasks 3, 6 and its dedicated check in Task 8; the "error is the finding" rule for `NoSuchLifecycleConfiguration` and the Azure 404 → Tasks 4 and 7, with the "unknown is not clean" half tested in Tasks 1 and 5; the bucket cap and its shortfall finding → Tasks 1 and 4; the Advisor filter → Task 6; Compute Optimizer opt-in → Task 4; permissions and the live check → Task 8.

**Placeholder scan.** No TBD/TODO, no "similar to Task N", no code step without code. Two steps tell the implementer to follow the installed SDK types over the plan if they disagree (Tasks 4 and 7) — that is a deliberate instruction with a concrete fallback and a reporting requirement, not a placeholder.

**Type consistency.** `leak(resourceId, resourceName, region, detail)` is used identically in all seven new rules, matching the existing private helper in both modules. `CheckResult` and `Finding` come from `@/lib/types` unchanged. Every input interface is defined in the task that first uses it and consumed by name in the wiring task: `BucketLifecycleInput` and `MultipartUploadBucketInput` (Tasks 1→4), `LogGroupInput` (2→4), `InstanceRecommendationInput` (3→4), `StorageLifecycleInput` and `LogAnalyticsWorkspaceInput` (5→7), `AdvisorRecommendationInput` (6→7). Check IDs and titles are identical between each rule's `okCheck` call and the route's `runCheck` label — `buckets-without-lifecycle`, `stale-multipart-uploads`, `log-groups-without-retention`, `over-provisioned-instances`, `storage-accounts-without-lifecycle`, `workspaces-costly-log-settings`, `advisor-rightsizing` — so a failed check renders under the same heading as a successful one.


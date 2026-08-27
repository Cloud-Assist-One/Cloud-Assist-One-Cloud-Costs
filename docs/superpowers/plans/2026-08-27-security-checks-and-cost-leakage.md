# Security Checks & Cost Leakage Sub-Tabs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add "Security Checks" and "Cost Leakage" sub-tabs to both the AWS and Azure tabs, each rendering live findings from the provider's APIs in a grid.

**Architecture:** All four sub-tabs share one `FindingsTab` component and one `FindingsGrid` component, parameterized by `provider` and `kind`; the provider-specific work lives in four API routes. Every detection rule is a pure function in `lib/` that takes a narrow, hand-written input type (not an SDK type) and returns a `CheckResult`, so rules are unit-tested against fixtures with no cloud account and no network. Routes are thin: decrypt credentials, call the SDK, map SDK shapes onto the rule inputs, join costs, return.

**Tech Stack:** Next.js 16 (App Router), React 19, TypeScript, Supabase, AWS SDK v3, Azure ARM SDKs, Microsoft Graph, Jest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-08-27-security-checks-and-cost-leakage-design.md`

## Global Constraints

- **Every commit message ends with the trailer** `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>` on its own line after a blank line.
- **Git commands must be scoped to explicit paths.** Always `git add <path>` — never `git add .`, never `git add -A`.
- **No new dependencies beyond these four**, which Task 1 installs: `@aws-sdk/client-securityhub`, `@aws-sdk/client-elastic-load-balancing-v2`, `@azure/arm-security`, `@azure/arm-network`.
- **Code style:** ES modules, `async`/`await` (never `.then()` chains), 2-space indentation, descriptive names. Comment *why*, not *what*.
- **No route ever makes a mutating cloud API call.** Every SDK call added by this plan is a read.
- **A failed check must never render as "no findings."** Any check that could not run gets `status: 'unavailable'` with a human-readable `unavailableReason`.
- **An unmatched cost renders as `—`, never `$0.00`.** `monthlyCost: null` means unknown, not free.
- **Test commands:** `npx jest <path>` for a single suite, `npm test` for all. Type check with `npx tsc --noEmit`. Lint with `npm run lint`.
- **Rule modules never import AWS or Azure SDK types.** They take locally-declared input interfaces so their tests need no SDK mocking.

## File Structure

| File | Responsibility |
|---|---|
| `lib/types.ts` (modify) | `FindingSeverity`, `Finding`, `CheckResult`, `FindingsResponse` — the contract every other file consumes |
| `lib/findings.ts` (create) | Severity ordering and the `checkResult`/`unavailableCheck` builders shared by all four rule modules |
| `lib/findingCosts.ts` (create) | Looks up billed cost per resource ID for a period |
| `lib/aws/costLeakage.ts` (create) | Seven AWS orphan rules |
| `lib/aws/securityChecks.ts` (create) | Nine built-in AWS security rules, plus Security Hub normalization and error classification |
| `lib/azure/costLeakage.ts` (create) | Seven Azure orphan rules |
| `lib/azure/securityChecks.ts` (create) | Seven built-in Azure security rules, plus Defender normalization and error classification |
| `components/reports/FindingsGrid.tsx` (create) | Renders `CheckResult[]` — one section per check, severity badges, cost column |
| `components/reports/FindingsTab.tsx` (create) | Connection picker, fetch, refresh, loading/error/not-connected states |
| `app/api/aws/cost-leakage/route.ts` (create) | AWS leakage: EC2 + ELBv2 + RDS reads, cost join |
| `app/api/aws/security-checks/route.ts` (create) | AWS security: Security Hub first, then EC2 + IAM + S3 + RDS reads |
| `app/api/azure/cost-leakage/route.ts` (create) | Azure leakage: Compute + Network + AppService reads, cost join |
| `app/api/azure/security-checks/route.ts` (create) | Azure security: Defender first, then Network + SQL + Storage + AppService + Graph reads |
| `components/shell/AppShell.tsx` (modify) | Two new sub-tab triggers per provider |

**Task order builds a working vertical slice first.** Tasks 1–7 ship AWS Cost Leakage end-to-end and visible in the UI; every later task adds one more rule module or route against components that already work.

---

### Task 1: Dependencies and the findings contract

**Files:**
- Modify: `package.json`
- Modify: `lib/types.ts`
- Create: `lib/findings.ts`
- Test: `lib/findings.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `FindingSeverity`, `Finding`, `CheckResult`, `FindingsResponse` from `@/lib/types`; `SEVERITY_ORDER`, `sortFindings(findings: Finding[]): Finding[]`, `okCheck(checkId: string, title: string, source: 'native' | 'builtin', findings: Finding[]): CheckResult`, `unavailableCheck(checkId: string, title: string, source: 'native' | 'builtin', reason: string): CheckResult` from `@/lib/findings`

- [ ] **Step 1: Install the four dependencies**

```bash
npm install @aws-sdk/client-securityhub @aws-sdk/client-elastic-load-balancing-v2 @azure/arm-security @azure/arm-network
```

- [ ] **Step 2: Add the contract types to `lib/types.ts`**

Append to the end of `lib/types.ts`:

```ts
export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface Finding {
  severity: FindingSeverity;
  /** ARN (AWS) or full resource ID (Azure). Used for the billing cost join. */
  resourceId: string;
  resourceName: string;
  region: string | null;
  /** Why this resource tripped the check, in plain language. */
  detail: string;
  /** Cost-leakage tabs only. null means "not in the last billing pull", not "free". */
  monthlyCost: number | null;
}

export interface CheckResult {
  checkId: string;
  title: string;
  source: 'native' | 'builtin';
  status: 'ok' | 'unavailable';
  unavailableReason: string | null;
  findings: Finding[];
}

export type FindingsResponse =
  | { connected: false }
  | { connected: true; fetchedAt: string; region: string | null; checks: CheckResult[] };
```

- [ ] **Step 3: Write the failing test for the shared builders**

Create `lib/findings.test.ts`:

```ts
import { sortFindings, okCheck, unavailableCheck } from './findings';
import type { Finding } from './types';

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    severity: 'low',
    resourceId: 'id-1',
    resourceName: 'name-1',
    region: 'us-east-1',
    detail: 'detail',
    monthlyCost: null,
    ...overrides,
  };
}

describe('sortFindings', () => {
  it('orders critical before high before medium before low', () => {
    const sorted = sortFindings([
      finding({ severity: 'medium', resourceId: 'm' }),
      finding({ severity: 'critical', resourceId: 'c' }),
      finding({ severity: 'low', resourceId: 'l' }),
      finding({ severity: 'high', resourceId: 'h' }),
    ]);

    expect(sorted.map((f) => f.resourceId)).toEqual(['c', 'h', 'm', 'l']);
  });

  it('does not mutate the input array', () => {
    const input = [finding({ severity: 'low', resourceId: 'l' }), finding({ severity: 'critical', resourceId: 'c' })];

    sortFindings(input);

    expect(input.map((f) => f.resourceId)).toEqual(['l', 'c']);
  });
});

describe('okCheck', () => {
  it('builds an ok check with its findings sorted by severity', () => {
    const result = okCheck('sg-open', 'Security groups open to the internet', 'builtin', [
      finding({ severity: 'medium', resourceId: 'm' }),
      finding({ severity: 'critical', resourceId: 'c' }),
    ]);

    expect(result.status).toBe('ok');
    expect(result.unavailableReason).toBeNull();
    expect(result.source).toBe('builtin');
    expect(result.findings.map((f) => f.resourceId)).toEqual(['c', 'm']);
  });
});

describe('unavailableCheck', () => {
  it('carries the reason and no findings', () => {
    const result = unavailableCheck('sg-open', 'Security groups open to the internet', 'builtin', 'Access denied.');

    expect(result.status).toBe('unavailable');
    expect(result.unavailableReason).toBe('Access denied.');
    expect(result.findings).toEqual([]);
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npx jest lib/findings.test.ts`
Expected: FAIL — `Cannot find module './findings'`

- [ ] **Step 5: Write the implementation**

Create `lib/findings.ts`:

```ts
import type { CheckResult, Finding, FindingSeverity } from './types';

export const SEVERITY_ORDER: Record<FindingSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

// Rules push findings in whatever order the SDK returned resources. Sorting
// here rather than in the grid keeps the API response already ranked, so a
// future consumer (an export, an email digest) gets the same ordering the
// UI shows without re-implementing it.
export function sortFindings(findings: readonly Finding[]): Finding[] {
  return [...findings].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

export function okCheck(
  checkId: string,
  title: string,
  source: 'native' | 'builtin',
  findings: readonly Finding[]
): CheckResult {
  return { checkId, title, source, status: 'ok', unavailableReason: null, findings: sortFindings(findings) };
}

export function unavailableCheck(
  checkId: string,
  title: string,
  source: 'native' | 'builtin',
  reason: string
): CheckResult {
  return { checkId, title, source, status: 'unavailable', unavailableReason: reason, findings: [] };
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx jest lib/findings.test.ts`
Expected: PASS, 4 tests

- [ ] **Step 7: Type check**

Run: `npx tsc --noEmit`
Expected: no output

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json lib/types.ts lib/findings.ts lib/findings.test.ts
git commit -m "Add findings contract and shared check builders"
```

---

### Task 2: Cost join

**Files:**
- Create: `lib/findingCosts.ts`
- Test: `lib/findingCosts.test.ts`

**Interfaces:**
- Consumes: `CloudProvider` from `@/lib/types`
- Produces: `type ResourceCostMap = Map<string, number>`; `fetchCostsForResources(supabase: SupabaseClient, periodId: string | null, cloudProvider: CloudProvider, resourceIds: readonly string[]): Promise<ResourceCostMap>`; `lookupCost(costs: ResourceCostMap, resourceId: string): number | null`

**Design note — a refinement on the spec.** The spec describes "one Supabase query per cost-leakage request" pulling the period's `resource_id, cost` rows. Querying every row of a period would hit Supabase's 1000-row default cap and need paging through potentially six figures of line items. Instead this queries only the handful of resource IDs the rules actually flagged, using `.in()` on both the original and lowercased spelling of each ID — exact matching on both variants, which covers the real-world casing difference (Azure Cost Management exports lowercase resource IDs; the ARM SDK does not) without a full scan. `.in()` lists are chunked at 200 IDs, so a request with 500 findings makes 3 queries rather than 1. Same result, bounded cost.

- [ ] **Step 1: Write the failing test**

Create `lib/findingCosts.test.ts`:

```ts
import { fetchCostsForResources, lookupCost } from './findingCosts';
import type { SupabaseClient } from '@supabase/supabase-js';

function makeSupabase(rows: { resource_id: string | null; cost: number }[], error: { message: string } | null = null) {
  const inSpy = jest.fn().mockResolvedValue({ data: rows, error });
  const client = {
    from: jest.fn().mockReturnValue({
      select: jest.fn().mockReturnValue({
        eq: jest.fn().mockReturnValue({
          eq: jest.fn().mockReturnValue({ in: inSpy }),
        }),
      }),
    }),
  };
  return { client: client as unknown as SupabaseClient, inSpy };
}

describe('fetchCostsForResources', () => {
  it('returns an empty map and makes no query when there is no active period', async () => {
    const { client, inSpy } = makeSupabase([]);

    const costs = await fetchCostsForResources(client, null, 'aws', ['arn:aws:ec2:us-east-1:1:volume/vol-1']);

    expect(costs.size).toBe(0);
    expect(inSpy).not.toHaveBeenCalled();
  });

  it('returns an empty map and makes no query when there are no findings to price', async () => {
    const { client, inSpy } = makeSupabase([]);

    const costs = await fetchCostsForResources(client, 'period-1', 'aws', []);

    expect(costs.size).toBe(0);
    expect(inSpy).not.toHaveBeenCalled();
  });

  it('queries both the original and the lowercased spelling of each resource id', async () => {
    const { client, inSpy } = makeSupabase([]);

    await fetchCostsForResources(client, 'period-1', 'azure', ['/subscriptions/S1/resourceGroups/RG/disk-1']);

    expect(inSpy).toHaveBeenCalledWith('resource_id', [
      '/subscriptions/S1/resourceGroups/RG/disk-1',
      '/subscriptions/s1/resourcegroups/rg/disk-1',
    ]);
  });

  it('sums every line item belonging to the same resource', async () => {
    const { client } = makeSupabase([
      { resource_id: 'vol-1', cost: 4.5 },
      { resource_id: 'vol-1', cost: 3.25 },
    ]);

    const costs = await fetchCostsForResources(client, 'period-1', 'aws', ['vol-1']);

    expect(costs.get('vol-1')).toBeCloseTo(7.75);
  });

  it('matches case-insensitively', async () => {
    const { client } = makeSupabase([{ resource_id: '/SUBSCRIPTIONS/S1/DISK-1', cost: 12 }]);

    const costs = await fetchCostsForResources(client, 'period-1', 'azure', ['/subscriptions/s1/disk-1']);

    expect(lookupCost(costs, '/subscriptions/S1/disk-1')).toBe(12);
  });

  it('skips rows with a null resource id', async () => {
    const { client } = makeSupabase([
      { resource_id: null, cost: 99 },
      { resource_id: 'vol-1', cost: 1 },
    ]);

    const costs = await fetchCostsForResources(client, 'period-1', 'aws', ['vol-1']);

    expect(costs.size).toBe(1);
    expect(costs.get('vol-1')).toBe(1);
  });

  it('throws when the query fails, so the route can report it rather than showing every cost as unknown', async () => {
    const { client } = makeSupabase([], { message: 'connection reset' });

    await expect(fetchCostsForResources(client, 'period-1', 'aws', ['vol-1'])).rejects.toThrow('connection reset');
  });
});

describe('lookupCost', () => {
  it('returns null for a resource that was not in the billing pull', () => {
    expect(lookupCost(new Map(), 'vol-missing')).toBeNull();
  });

  it('distinguishes a genuine zero from a miss', () => {
    expect(lookupCost(new Map([['vol-1', 0]]), 'vol-1')).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest lib/findingCosts.test.ts`
Expected: FAIL — `Cannot find module './findingCosts'`

- [ ] **Step 3: Write the implementation**

Create `lib/findingCosts.ts`:

```ts
import type { SupabaseClient } from '@supabase/supabase-js';
import type { CloudProvider } from './types';

export type ResourceCostMap = Map<string, number>;

// Supabase caps an .in() filter well before this, and a URL built from
// hundreds of full Azure resource IDs gets long fast. Chunking keeps each
// request comfortably sized.
const ID_CHUNK_SIZE = 200;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

/**
 * Bills-back the resources a leakage rule flagged.
 *
 * Azure's Cost Management export lowercases resource IDs while the ARM SDK
 * returns them cased, so every ID is queried in both spellings and the map
 * is keyed lowercase.
 */
export async function fetchCostsForResources(
  supabase: SupabaseClient,
  periodId: string | null,
  cloudProvider: CloudProvider,
  resourceIds: readonly string[]
): Promise<ResourceCostMap> {
  const costs: ResourceCostMap = new Map();
  if (!periodId || resourceIds.length === 0) return costs;

  const candidates = [...new Set(resourceIds.flatMap((id) => [id, id.toLowerCase()]))];

  for (const batch of chunk(candidates, ID_CHUNK_SIZE)) {
    const { data, error } = await supabase
      .from('cost_records')
      .select('resource_id, cost')
      .eq('period_id', periodId)
      .eq('cloud_provider', cloudProvider)
      .in('resource_id', batch);

    if (error) throw new Error(error.message);

    for (const row of (data ?? []) as { resource_id: string | null; cost: number | null }[]) {
      if (!row.resource_id) continue;
      const key = row.resource_id.toLowerCase();
      costs.set(key, (costs.get(key) ?? 0) + Number(row.cost ?? 0));
    }
  }

  return costs;
}

// A miss is null, never 0 — "we have no billing row for this" and "this
// costs nothing" lead to opposite decisions about whether to delete it.
export function lookupCost(costs: ResourceCostMap, resourceId: string): number | null {
  const value = costs.get(resourceId.toLowerCase());
  return value === undefined ? null : value;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest lib/findingCosts.test.ts`
Expected: PASS, 9 tests

- [ ] **Step 5: Commit**

```bash
git add lib/findingCosts.ts lib/findingCosts.test.ts
git commit -m "Add resource cost join for leakage findings"
```

---

### Task 3: AWS cost leakage rules

**Files:**
- Create: `lib/aws/costLeakage.ts`
- Test: `lib/aws/costLeakage.test.ts`

**Interfaces:**
- Consumes: `okCheck` from `@/lib/findings`; `CheckResult`, `Finding` from `@/lib/types`
- Produces: input interfaces `VolumeInput`, `ElasticIpInput`, `InstanceInput`, `SnapshotInput`, `LoadBalancerInput`, `NatGatewayInput`, `RdsInput`; rule functions `unattachedVolumes`, `unassociatedElasticIps`, `longStoppedInstances`, `orphanedSnapshots`, `emptyLoadBalancers`, `idleNatGateways`, `stoppedRdsInstances`; helper `stoppedSince(reason: string | null): string | null`; constant `STOPPED_INSTANCE_DAYS = 30`

Each rule returns a `CheckResult` with `source: 'builtin'` and `monthlyCost: null` on every finding — the route fills costs in afterwards.

- [ ] **Step 1: Write the failing test**

Create `lib/aws/costLeakage.test.ts`:

```ts
import {
  stoppedSince,
  unattachedVolumes,
  unassociatedElasticIps,
  longStoppedInstances,
  orphanedSnapshots,
  emptyLoadBalancers,
  idleNatGateways,
  stoppedRdsInstances,
} from './costLeakage';

describe('stoppedSince', () => {
  it('pulls the timestamp out of an EC2 state transition reason', () => {
    expect(stoppedSince('User initiated (2026-07-01 12:30:00 GMT)')).toBe('2026-07-01T12:30:00.000Z');
  });

  it('returns null when the reason carries no timestamp', () => {
    expect(stoppedSince('User initiated')).toBeNull();
  });

  it('returns null for a missing reason', () => {
    expect(stoppedSince(null)).toBeNull();
  });
});

describe('unattachedVolumes', () => {
  it('flags a volume in the available state', () => {
    const result = unattachedVolumes([
      { volumeId: 'vol-1', arn: 'arn:vol-1', name: 'scratch', state: 'available', sizeGiB: 200, region: 'us-east-1' },
    ]);

    expect(result.status).toBe('ok');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].resourceId).toBe('arn:vol-1');
    expect(result.findings[0].resourceName).toBe('scratch');
    expect(result.findings[0].detail).toContain('200 GiB');
    expect(result.findings[0].monthlyCost).toBeNull();
  });

  it('ignores a volume that is in use', () => {
    const result = unattachedVolumes([
      { volumeId: 'vol-2', arn: 'arn:vol-2', name: null, state: 'in-use', sizeGiB: 8, region: 'us-east-1' },
    ]);

    expect(result.findings).toEqual([]);
  });

  it('falls back to the volume id when the volume has no Name tag', () => {
    const result = unattachedVolumes([
      { volumeId: 'vol-3', arn: 'arn:vol-3', name: null, state: 'available', sizeGiB: 1, region: 'us-east-1' },
    ]);

    expect(result.findings[0].resourceName).toBe('vol-3');
  });
});

describe('unassociatedElasticIps', () => {
  it('flags an address with no association', () => {
    const result = unassociatedElasticIps([
      { allocationId: 'eipalloc-1', publicIp: '52.0.0.1', associationId: null, region: 'us-east-1' },
    ]);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].resourceName).toBe('52.0.0.1');
  });

  it('ignores an address attached to something', () => {
    const result = unassociatedElasticIps([
      { allocationId: 'eipalloc-2', publicIp: '52.0.0.2', associationId: 'eipassoc-2', region: 'us-east-1' },
    ]);

    expect(result.findings).toEqual([]);
  });
});

describe('longStoppedInstances', () => {
  const now = new Date('2026-08-27T00:00:00.000Z');

  it('flags an instance stopped longer than the threshold', () => {
    const result = longStoppedInstances(
      [
        {
          instanceId: 'i-1',
          arn: 'arn:i-1',
          name: 'old-worker',
          state: 'stopped',
          stateTransitionReason: 'User initiated (2026-06-01 09:00:00 GMT)',
          region: 'us-east-1',
        },
      ],
      now
    );

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].detail).toContain('87 days');
  });

  it('ignores an instance stopped only a few days ago', () => {
    const result = longStoppedInstances(
      [
        {
          instanceId: 'i-2',
          arn: 'arn:i-2',
          name: null,
          state: 'stopped',
          stateTransitionReason: 'User initiated (2026-08-25 09:00:00 GMT)',
          region: 'us-east-1',
        },
      ],
      now
    );

    expect(result.findings).toEqual([]);
  });

  it('ignores a running instance', () => {
    const result = longStoppedInstances(
      [
        {
          instanceId: 'i-3',
          arn: 'arn:i-3',
          name: null,
          state: 'running',
          stateTransitionReason: null,
          region: 'us-east-1',
        },
      ],
      now
    );

    expect(result.findings).toEqual([]);
  });

  it('flags a stopped instance whose stop date cannot be parsed, since it is still billing for storage', () => {
    const result = longStoppedInstances(
      [
        {
          instanceId: 'i-4',
          arn: 'arn:i-4',
          name: null,
          state: 'stopped',
          stateTransitionReason: null,
          region: 'us-east-1',
        },
      ],
      now
    );

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].detail).toContain('unknown');
  });
});

describe('orphanedSnapshots', () => {
  it('flags a snapshot whose source volume is gone', () => {
    const result = orphanedSnapshots(
      [
        {
          snapshotId: 'snap-1',
          arn: 'arn:snap-1',
          volumeId: 'vol-deleted',
          sizeGiB: 50,
          startTime: '2026-01-01T00:00:00.000Z',
          region: 'us-east-1',
        },
      ],
      new Set(['vol-alive'])
    );

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].detail).toContain('vol-deleted');
  });

  it('ignores a snapshot whose source volume still exists', () => {
    const result = orphanedSnapshots(
      [
        {
          snapshotId: 'snap-2',
          arn: 'arn:snap-2',
          volumeId: 'vol-alive',
          sizeGiB: 50,
          startTime: '2026-01-01T00:00:00.000Z',
          region: 'us-east-1',
        },
      ],
      new Set(['vol-alive'])
    );

    expect(result.findings).toEqual([]);
  });
});

describe('emptyLoadBalancers', () => {
  it('flags a load balancer with no registered targets', () => {
    const result = emptyLoadBalancers([
      { arn: 'arn:lb-1', name: 'legacy-alb', targetCount: 0, region: 'us-east-1' },
    ]);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].resourceName).toBe('legacy-alb');
  });

  it('ignores a load balancer that has targets', () => {
    const result = emptyLoadBalancers([{ arn: 'arn:lb-2', name: 'live-alb', targetCount: 3, region: 'us-east-1' }]);

    expect(result.findings).toEqual([]);
  });
});

describe('idleNatGateways', () => {
  it('flags a gateway in a VPC with no running instances', () => {
    const result = idleNatGateways(
      [{ natGatewayId: 'nat-1', arn: 'arn:nat-1', vpcId: 'vpc-empty', region: 'us-east-1' }],
      new Set(['vpc-busy'])
    );

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].detail).toContain('vpc-empty');
  });

  it('ignores a gateway in a VPC that still runs instances', () => {
    const result = idleNatGateways(
      [{ natGatewayId: 'nat-2', arn: 'arn:nat-2', vpcId: 'vpc-busy', region: 'us-east-1' }],
      new Set(['vpc-busy'])
    );

    expect(result.findings).toEqual([]);
  });
});

describe('stoppedRdsInstances', () => {
  it('flags a stopped database', () => {
    const result = stoppedRdsInstances([
      { arn: 'arn:db-1', identifier: 'reporting', status: 'stopped', allocatedStorage: 100, region: 'us-east-1' },
    ]);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].resourceName).toBe('reporting');
  });

  it('ignores an available database', () => {
    const result = stoppedRdsInstances([
      { arn: 'arn:db-2', identifier: 'prod', status: 'available', allocatedStorage: 100, region: 'us-east-1' },
    ]);

    expect(result.findings).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest lib/aws/costLeakage.test.ts`
Expected: FAIL — `Cannot find module './costLeakage'`

- [ ] **Step 3: Write the implementation**

Create `lib/aws/costLeakage.ts`:

```ts
import { okCheck } from '@/lib/findings';
import type { CheckResult, Finding } from '@/lib/types';

// An instance stopped for a month is almost certainly forgotten rather than
// paused for the weekend, and its EBS volumes have been billing the whole
// time.
export const STOPPED_INSTANCE_DAYS = 30;

export interface VolumeInput {
  volumeId: string;
  arn: string;
  name: string | null;
  state: string;
  sizeGiB: number | null;
  region: string;
}

export interface ElasticIpInput {
  allocationId: string;
  publicIp: string;
  associationId: string | null;
  region: string;
}

export interface InstanceInput {
  instanceId: string;
  arn: string;
  name: string | null;
  state: string;
  stateTransitionReason: string | null;
  region: string;
}

export interface SnapshotInput {
  snapshotId: string;
  arn: string;
  volumeId: string | null;
  sizeGiB: number | null;
  startTime: string | null;
  region: string;
}

export interface LoadBalancerInput {
  arn: string;
  name: string;
  targetCount: number;
  region: string;
}

export interface NatGatewayInput {
  natGatewayId: string;
  arn: string;
  vpcId: string | null;
  region: string;
}

export interface RdsInput {
  arn: string;
  identifier: string;
  status: string;
  allocatedStorage: number | null;
  region: string;
}

// Leakage findings have no meaningful severity — the grid ranks them by
// cost instead — so every one of them is emitted as 'low'.
function leak(resourceId: string, resourceName: string, region: string | null, detail: string): Finding {
  return { severity: 'low', resourceId, resourceName, region, detail, monthlyCost: null };
}

// EC2 does not expose a "stopped at" timestamp. The only record of when an
// instance stopped is embedded in StateTransitionReason, which reads
// "User initiated (2026-07-01 12:30:00 GMT)".
export function stoppedSince(reason: string | null): string | null {
  if (!reason) return null;
  const match = reason.match(/\((\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})\s*GMT\)/);
  if (!match) return null;
  const parsed = new Date(`${match[1]}T${match[2]}Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function daysBetween(fromIso: string, now: Date): number {
  return Math.floor((now.getTime() - new Date(fromIso).getTime()) / 86_400_000);
}

export function unattachedVolumes(volumes: readonly VolumeInput[]): CheckResult {
  const findings = volumes
    .filter((volume) => volume.state === 'available')
    .map((volume) =>
      leak(
        volume.arn,
        volume.name ?? volume.volumeId,
        volume.region,
        `Volume ${volume.volumeId} (${volume.sizeGiB ?? '?'} GiB) is not attached to any instance and bills for its full provisioned size.`
      )
    );

  return okCheck('unattached-ebs-volumes', 'Unattached EBS volumes', 'builtin', findings);
}

export function unassociatedElasticIps(addresses: readonly ElasticIpInput[]): CheckResult {
  const findings = addresses
    .filter((address) => !address.associationId)
    .map((address) =>
      leak(
        address.allocationId,
        address.publicIp,
        address.region,
        `Elastic IP ${address.publicIp} is allocated but not associated with any instance or interface, which AWS bills hourly.`
      )
    );

  return okCheck('unassociated-elastic-ips', 'Unassociated Elastic IPs', 'builtin', findings);
}

export function longStoppedInstances(instances: readonly InstanceInput[], now: Date): CheckResult {
  const findings: Finding[] = [];

  for (const instance of instances) {
    if (instance.state !== 'stopped') continue;

    const since = stoppedSince(instance.stateTransitionReason);

    // A stopped instance whose stop date we cannot read is still worth
    // reporting: compute is free but its volumes are not, and the missing
    // timestamp is a parsing gap on our side, not evidence it is in use.
    if (!since) {
      findings.push(
        leak(
          instance.arn,
          instance.name ?? instance.instanceId,
          instance.region,
          `Instance ${instance.instanceId} is stopped (for an unknown length of time) and its EBS volumes continue to bill.`
        )
      );
      continue;
    }

    const days = daysBetween(since, now);
    if (days < STOPPED_INSTANCE_DAYS) continue;

    findings.push(
      leak(
        instance.arn,
        instance.name ?? instance.instanceId,
        instance.region,
        `Instance ${instance.instanceId} has been stopped for ${days} days and its EBS volumes continue to bill.`
      )
    );
  }

  return okCheck('long-stopped-instances', `Instances stopped over ${STOPPED_INSTANCE_DAYS} days`, 'builtin', findings);
}

export function orphanedSnapshots(
  snapshots: readonly SnapshotInput[],
  existingVolumeIds: ReadonlySet<string>
): CheckResult {
  const findings = snapshots
    .filter((snapshot) => snapshot.volumeId && !existingVolumeIds.has(snapshot.volumeId))
    .map((snapshot) =>
      leak(
        snapshot.arn,
        snapshot.snapshotId,
        snapshot.region,
        `Snapshot of ${snapshot.volumeId}, a volume that no longer exists (${snapshot.sizeGiB ?? '?'} GiB).`
      )
    );

  return okCheck('orphaned-snapshots', 'Snapshots of deleted volumes', 'builtin', findings);
}

export function emptyLoadBalancers(loadBalancers: readonly LoadBalancerInput[]): CheckResult {
  const findings = loadBalancers
    .filter((loadBalancer) => loadBalancer.targetCount === 0)
    .map((loadBalancer) =>
      leak(
        loadBalancer.arn,
        loadBalancer.name,
        loadBalancer.region,
        `Load balancer ${loadBalancer.name} has no registered targets but bills an hourly charge.`
      )
    );

  return okCheck('empty-load-balancers', 'Load balancers with no targets', 'builtin', findings);
}

export function idleNatGateways(
  gateways: readonly NatGatewayInput[],
  vpcIdsWithRunningInstances: ReadonlySet<string>
): CheckResult {
  const findings = gateways
    .filter((gateway) => gateway.vpcId && !vpcIdsWithRunningInstances.has(gateway.vpcId))
    .map((gateway) =>
      leak(
        gateway.natGatewayId,
        gateway.natGatewayId,
        gateway.region,
        `NAT gateway sits in ${gateway.vpcId}, a VPC with no running instances, but bills hourly regardless of traffic.`
      )
    );

  return okCheck('idle-nat-gateways', 'NAT gateways in empty VPCs', 'builtin', findings);
}

export function stoppedRdsInstances(instances: readonly RdsInput[]): CheckResult {
  const findings = instances
    .filter((instance) => instance.status === 'stopped')
    .map((instance) =>
      leak(
        instance.arn,
        instance.identifier,
        instance.region,
        `Database ${instance.identifier} is stopped but still bills for ${instance.allocatedStorage ?? '?'} GB of provisioned storage, and AWS restarts it automatically after 7 days.`
      )
    );

  return okCheck('stopped-rds-instances', 'Stopped RDS instances', 'builtin', findings);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest lib/aws/costLeakage.test.ts`
Expected: PASS, 18 tests

- [ ] **Step 5: Commit**

```bash
git add lib/aws/costLeakage.ts lib/aws/costLeakage.test.ts
git commit -m "Add AWS cost leakage detection rules"
```

---

### Task 4: AWS cost leakage route

**Files:**
- Create: `app/api/aws/cost-leakage/route.ts`

**Interfaces:**
- Consumes: every rule and input interface from `@/lib/aws/costLeakage`; `fetchCostsForResources`, `lookupCost` from `@/lib/findingCosts`; `unavailableCheck` from `@/lib/findings`; `requireCompanyAccess` from `@/lib/admin-guard`; `createAdminClient` from `@/lib/supabase/admin`; `decryptCredentials` from `@/lib/cloudCredentialsCrypto`; `collectPages` from `@/lib/awsPagination`
- Produces: `GET /api/aws/cost-leakage?companyId=&credentialId=&periodId=` returning `FindingsResponse`

Per project convention there is no Jest coverage for API routes — the rule logic this route calls is already covered by Task 3, and the route itself is verified by type check, build, and the live check in Task 15.

- [ ] **Step 1: Create the route**

Create `app/api/aws/cost-leakage/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import {
  EC2Client,
  DescribeVolumesCommand,
  DescribeAddressesCommand,
  DescribeInstancesCommand,
  DescribeSnapshotsCommand,
  DescribeNatGatewaysCommand,
} from '@aws-sdk/client-ec2';
import {
  ElasticLoadBalancingV2Client,
  DescribeLoadBalancersCommand,
  DescribeTargetGroupsCommand,
  DescribeTargetHealthCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import { RDSClient, DescribeDBInstancesCommand } from '@aws-sdk/client-rds';
import { requireCompanyAccess } from '@/lib/admin-guard';
import { createAdminClient } from '@/lib/supabase/admin';
import { decryptCredentials } from '@/lib/cloudCredentialsCrypto';
import { collectPages } from '@/lib/awsPagination';
import { mapWithConcurrency } from '@/lib/concurrency';
import { unavailableCheck } from '@/lib/findings';
import { fetchCostsForResources, lookupCost } from '@/lib/findingCosts';
import {
  unattachedVolumes,
  unassociatedElasticIps,
  longStoppedInstances,
  orphanedSnapshots,
  emptyLoadBalancers,
  idleNatGateways,
  stoppedRdsInstances,
} from '@/lib/aws/costLeakage';
import type { CheckResult, FindingsResponse } from '@/lib/types';

// Matches the cap the resources route uses, for the same throttling reason.
const TARGET_LOOKUP_CONCURRENCY = 8;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Unknown error.';
}

function nameTag(tags: { Key?: string; Value?: string }[] | undefined): string | null {
  return tags?.find((tag) => tag.Key === 'Name')?.Value ?? null;
}

// Every check runs in isolation so one denied permission degrades one
// section instead of blanking the tab.
async function runCheck(
  checkId: string,
  title: string,
  run: () => Promise<CheckResult>
): Promise<CheckResult> {
  try {
    return await run();
  } catch (err) {
    return unavailableCheck(checkId, title, 'builtin', errorMessage(err));
  }
}

export async function GET(request: NextRequest) {
  const companyId = request.nextUrl.searchParams.get('companyId');
  const credentialId = request.nextUrl.searchParams.get('credentialId');
  const periodId = request.nextUrl.searchParams.get('periodId');
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
  const ec2 = new EC2Client(clientConfig);
  const elb = new ElasticLoadBalancingV2Client(clientConfig);
  const rds = new RDSClient(clientConfig);

  // Instances are read once and reused by three checks: the stopped-instance
  // rule, the snapshot rule's volume cross-reference, and the NAT gateway
  // rule's "does this VPC run anything" question.
  const instances = await collectPages(
    (token) => ec2.send(new DescribeInstancesCommand({ NextToken: token })),
    (page) => page.Reservations?.flatMap((reservation) => reservation.Instances ?? []) ?? [],
    (page) => page.NextToken
  ).catch(() => null);

  const volumesPromise = collectPages(
    (token) => ec2.send(new DescribeVolumesCommand({ NextToken: token })),
    (page) => page.Volumes ?? [],
    (page) => page.NextToken
  );

  const checks: CheckResult[] = [];

  const volumeRows = await volumesPromise.catch(() => null);

  checks.push(
    await runCheck('unattached-ebs-volumes', 'Unattached EBS volumes', async () => {
      if (!volumeRows) throw new Error('Could not list EBS volumes. The credential needs ec2:DescribeVolumes.');
      return unattachedVolumes(
        volumeRows.map((volume) => ({
          volumeId: volume.VolumeId ?? '',
          arn: `arn:aws:ec2:${region}:volume/${volume.VolumeId ?? ''}`,
          name: nameTag(volume.Tags),
          state: volume.State ?? '',
          sizeGiB: volume.Size ?? null,
          region,
        }))
      );
    })
  );

  checks.push(
    await runCheck('unassociated-elastic-ips', 'Unassociated Elastic IPs', async () => {
      const response = await ec2.send(new DescribeAddressesCommand({}));
      return unassociatedElasticIps(
        (response.Addresses ?? []).map((address) => ({
          allocationId: address.AllocationId ?? address.PublicIp ?? '',
          publicIp: address.PublicIp ?? '',
          associationId: address.AssociationId ?? null,
          region,
        }))
      );
    })
  );

  checks.push(
    await runCheck(
      'long-stopped-instances',
      'Instances stopped over 30 days',
      async () => {
        if (!instances) throw new Error('Could not list EC2 instances. The credential needs ec2:DescribeInstances.');
        return longStoppedInstances(
          instances.map((instance) => ({
            instanceId: instance.InstanceId ?? '',
            arn: `arn:aws:ec2:${region}:instance/${instance.InstanceId ?? ''}`,
            name: nameTag(instance.Tags),
            state: instance.State?.Name ?? '',
            stateTransitionReason: instance.StateTransitionReason ?? null,
            region,
          })),
          new Date()
        );
      }
    )
  );

  checks.push(
    await runCheck('orphaned-snapshots', 'Snapshots of deleted volumes', async () => {
      if (!volumeRows) throw new Error('Could not list EBS volumes, which is needed to tell which snapshots are orphaned.');
      const existingVolumeIds = new Set(volumeRows.map((volume) => volume.VolumeId ?? ''));
      const snapshots = await collectPages(
        // OwnerIds 'self' matters: without it this returns every public
        // snapshot on AWS, which is tens of thousands of rows.
        (token) => ec2.send(new DescribeSnapshotsCommand({ OwnerIds: ['self'], NextToken: token })),
        (page) => page.Snapshots ?? [],
        (page) => page.NextToken
      );
      return orphanedSnapshots(
        snapshots.map((snapshot) => ({
          snapshotId: snapshot.SnapshotId ?? '',
          arn: `arn:aws:ec2:${region}:snapshot/${snapshot.SnapshotId ?? ''}`,
          volumeId: snapshot.VolumeId ?? null,
          sizeGiB: snapshot.VolumeSize ?? null,
          startTime: snapshot.StartTime?.toISOString() ?? null,
          region,
        })),
        existingVolumeIds
      );
    })
  );

  checks.push(
    await runCheck('empty-load-balancers', 'Load balancers with no targets', async () => {
      const loadBalancers = await collectPages(
        (token) => elb.send(new DescribeLoadBalancersCommand({ Marker: token })),
        (page) => page.LoadBalancers ?? [],
        (page) => page.NextMarker
      );

      const rows = await mapWithConcurrency(loadBalancers, TARGET_LOOKUP_CONCURRENCY, async (loadBalancer) => {
        const groups = await elb.send(
          new DescribeTargetGroupsCommand({ LoadBalancerArn: loadBalancer.LoadBalancerArn })
        );
        let targetCount = 0;
        for (const group of groups.TargetGroups ?? []) {
          const health = await elb.send(
            new DescribeTargetHealthCommand({ TargetGroupArn: group.TargetGroupArn })
          );
          targetCount += health.TargetHealthDescriptions?.length ?? 0;
        }
        return {
          arn: loadBalancer.LoadBalancerArn ?? '',
          name: loadBalancer.LoadBalancerName ?? '',
          targetCount,
          region,
        };
      });

      return emptyLoadBalancers(rows);
    })
  );

  checks.push(
    await runCheck('idle-nat-gateways', 'NAT gateways in empty VPCs', async () => {
      if (!instances) throw new Error('Could not list EC2 instances, which is needed to tell which VPCs are idle.');
      const busyVpcIds = new Set(
        instances
          .filter((instance) => instance.State?.Name === 'running')
          .map((instance) => instance.VpcId ?? '')
          .filter(Boolean)
      );
      const gateways = await collectPages(
        (token) => ec2.send(new DescribeNatGatewaysCommand({ NextToken: token })),
        (page) => page.NatGateways ?? [],
        (page) => page.NextToken
      );
      return idleNatGateways(
        gateways
          .filter((gateway) => gateway.State === 'available')
          .map((gateway) => ({
            natGatewayId: gateway.NatGatewayId ?? '',
            arn: gateway.NatGatewayId ?? '',
            vpcId: gateway.VpcId ?? null,
            region,
          })),
        busyVpcIds
      );
    })
  );

  checks.push(
    await runCheck('stopped-rds-instances', 'Stopped RDS instances', async () => {
      const dbInstances = await collectPages(
        (token) => rds.send(new DescribeDBInstancesCommand({ Marker: token })),
        (page) => page.DBInstances ?? [],
        (page) => page.Marker
      );
      return stoppedRdsInstances(
        dbInstances.map((instance) => ({
          arn: instance.DBInstanceArn ?? '',
          identifier: instance.DBInstanceIdentifier ?? '',
          status: instance.DBInstanceStatus ?? '',
          allocatedStorage: instance.AllocatedStorage ?? null,
          region,
        }))
      );
    })
  );

  // The cost join is best-effort: a billing lookup failure must not blank
  // out findings that are correct on their own.
  try {
    const resourceIds = checks.flatMap((check) => check.findings.map((finding) => finding.resourceId));
    const costs = await fetchCostsForResources(adminClient, periodId, 'aws', resourceIds);
    for (const check of checks) {
      for (const finding of check.findings) {
        finding.monthlyCost = lookupCost(costs, finding.resourceId);
      }
    }
  } catch (err) {
    console.error('Failed to join AWS leakage findings to billing data:', err);
  }

  return NextResponse.json({
    connected: true,
    region,
    fetchedAt: new Date().toISOString(),
    checks,
  } satisfies FindingsResponse);
}
```

- [ ] **Step 2: Type check**

Run: `npx tsc --noEmit`
Expected: no output

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add app/api/aws/cost-leakage/route.ts
git commit -m "Add AWS cost leakage API route"
```

---

### Task 5: FindingsGrid component

**Files:**
- Create: `components/reports/FindingsGrid.tsx`
- Create: `components/reports/FindingsGrid.module.css`
- Test: `components/reports/FindingsGrid.test.tsx`

**Interfaces:**
- Consumes: `CheckResult` from `@/lib/types`
- Produces: `export default function FindingsGrid({ checks, kind }: { checks: CheckResult[]; kind: 'security-checks' | 'cost-leakage' })`

**Behavior this task locks in:**
- One `<section>` per check, titled, with a count badge when it has findings.
- `status: 'unavailable'` renders the reason with `role="alert"` and no table — never an empty-findings message.
- `security-checks` shows a Severity column; `cost-leakage` shows a Monthly cost column instead and sorts by cost descending, nulls last.
- A null cost renders `—`.
- A check sourced from `native` is labeled so the customer can tell where the finding came from.

- [ ] **Step 1: Write the failing test**

Create `components/reports/FindingsGrid.test.tsx`:

```tsx
import { render, screen, within } from '@testing-library/react';
import FindingsGrid from './FindingsGrid';
import type { CheckResult, Finding } from '@/lib/types';

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    severity: 'medium',
    resourceId: 'arn:res-1',
    resourceName: 'res-1',
    region: 'us-east-1',
    detail: 'Something is wrong.',
    monthlyCost: null,
    ...overrides,
  };
}

function check(overrides: Partial<CheckResult> = {}): CheckResult {
  return {
    checkId: 'check-1',
    title: 'Open security groups',
    source: 'builtin',
    status: 'ok',
    unavailableReason: null,
    findings: [finding()],
    ...overrides,
  };
}

describe('FindingsGrid', () => {
  it('renders a section per check with a count badge', () => {
    render(
      <FindingsGrid
        kind="security-checks"
        checks={[check({ checkId: 'a', title: 'Open security groups', findings: [finding(), finding()] })]}
      />
    );

    expect(screen.getByRole('heading', { name: 'Open security groups' })).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('shows the reason and no table when a check could not run', () => {
    render(
      <FindingsGrid
        kind="security-checks"
        checks={[
          check({
            status: 'unavailable',
            unavailableReason: 'The credential needs ec2:DescribeSecurityGroups.',
            findings: [],
          }),
        ]}
      />
    );

    expect(screen.getByRole('alert')).toHaveTextContent('ec2:DescribeSecurityGroups');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('never says "no findings" for an unavailable check', () => {
    render(
      <FindingsGrid
        kind="security-checks"
        checks={[check({ status: 'unavailable', unavailableReason: 'Access denied.', findings: [] })]}
      />
    );

    expect(screen.queryByText(/no findings/i)).not.toBeInTheDocument();
  });

  it('says the check passed when it ran and found nothing', () => {
    render(<FindingsGrid kind="security-checks" checks={[check({ findings: [] })]} />);

    expect(screen.getByText(/no findings/i)).toBeInTheDocument();
  });

  it('shows a severity column for security checks', () => {
    render(<FindingsGrid kind="security-checks" checks={[check({ findings: [finding({ severity: 'critical' })] })]} />);

    expect(screen.getByRole('columnheader', { name: /severity/i })).toBeInTheDocument();
    expect(screen.getByText('critical')).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: /monthly cost/i })).not.toBeInTheDocument();
  });

  it('shows a monthly cost column for cost leakage instead of severity', () => {
    render(
      <FindingsGrid
        kind="cost-leakage"
        checks={[check({ title: 'Unattached EBS volumes', findings: [finding({ monthlyCost: 42.5 })] })]}
      />
    );

    expect(screen.getByRole('columnheader', { name: /monthly cost/i })).toBeInTheDocument();
    expect(screen.getByText('$42.50')).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: /severity/i })).not.toBeInTheDocument();
  });

  it('renders an unmatched cost as a dash, not as zero', () => {
    render(<FindingsGrid kind="cost-leakage" checks={[check({ findings: [finding({ monthlyCost: null })] })]} />);

    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.queryByText('$0.00')).not.toBeInTheDocument();
  });

  it('sorts leakage findings by cost descending with unknown costs last', () => {
    render(
      <FindingsGrid
        kind="cost-leakage"
        checks={[
          check({
            findings: [
              finding({ resourceName: 'cheap', monthlyCost: 5 }),
              finding({ resourceName: 'unknown', monthlyCost: null }),
              finding({ resourceName: 'expensive', monthlyCost: 500 }),
            ],
          }),
        ]}
      />
    );

    const rows = within(screen.getByRole('table')).getAllByRole('row').slice(1);
    expect(rows.map((row) => within(row).getAllByRole('cell')[0].textContent)).toEqual([
      'expensive',
      'cheap',
      'unknown',
    ]);
  });

  it('labels a check whose findings came from the provider native service', () => {
    render(<FindingsGrid kind="security-checks" checks={[check({ source: 'native' })]} />);

    expect(screen.getByText(/security hub \/ defender/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest components/reports/FindingsGrid.test.tsx`
Expected: FAIL — `Cannot find module './FindingsGrid'`

- [ ] **Step 3: Write the stylesheet**

Create `components/reports/FindingsGrid.module.css`:

```css
.section {
  background: var(--color-bg-alt);
  border: 1px solid var(--color-border);
  border-radius: 10px;
  padding: 1.25rem;
  box-shadow: 0 1px 2px rgba(15, 37, 64, 0.06);
}

.sectionHeader {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.75rem;
  margin-bottom: 0.75rem;
  padding-bottom: 0.75rem;
  border-bottom: 1px solid var(--color-border);
}

.sectionHeader h3 {
  margin: 0;
  font-size: 1rem;
  letter-spacing: 0.01em;
}

.headerMeta {
  display: flex;
  align-items: center;
  gap: 0.6rem;
}

.countBadge {
  font-family: var(--font-mono);
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--muted-foreground);
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: 999px;
  padding: 0.15rem 0.6rem;
}

.sourceBadge {
  font-size: 0.7rem;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--muted-foreground);
}

.unavailable {
  color: #b45309;
  font-size: 0.875rem;
  margin: 0;
}

.clean {
  color: var(--muted-foreground);
  font-size: 0.875rem;
  margin: 0;
}

.tableScroll {
  overflow-x: auto;
}

.table {
  width: 100%;
  border-collapse: collapse;
  font-family: var(--font-mono);
  font-size: 0.85rem;
}

.table th,
.table td {
  text-align: left;
  padding: 0.5rem 0.85rem;
  border-bottom: 1px solid var(--color-border);
}

.table th {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  font-size: 0.7rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--muted-foreground);
  background: var(--color-bg);
  border-bottom: 2px solid var(--color-border);
  white-space: nowrap;
}

.table tbody tr:nth-child(even) {
  background: rgba(100, 116, 139, 0.07);
}

.detailCell {
  white-space: normal;
  min-width: 22rem;
}

.numeric {
  text-align: right;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.severity {
  display: inline-block;
  font-size: 0.7rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  border-radius: 999px;
  padding: 0.15rem 0.55rem;
}

.critical {
  background: rgba(209, 39, 75, 0.16);
  color: #d1274b;
}

.high {
  background: rgba(234, 88, 12, 0.16);
  color: #c2410c;
}

.medium {
  background: rgba(202, 138, 4, 0.18);
  color: #a16207;
}

.low {
  background: rgba(100, 116, 139, 0.16);
  color: var(--muted-foreground);
}

.sections {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}
```

- [ ] **Step 4: Write the component**

Create `components/reports/FindingsGrid.tsx`:

```tsx
'use client';

import type { CheckResult, Finding, FindingSeverity } from '@/lib/types';
import styles from './FindingsGrid.module.css';

const SEVERITY_CLASS: Record<FindingSeverity, string> = {
  critical: styles.critical,
  high: styles.high,
  medium: styles.medium,
  low: styles.low,
};

function formatCost(cost: number | null): string {
  // A resource missing from the last billing pull is unknown, not free.
  if (cost === null) return '—';
  return `$${cost.toFixed(2)}`;
}

// Leakage rows all share one severity, so ranking them by money is the only
// ordering that tells the customer anything. Unknown costs sort last: they
// are the rows we can say the least about.
function byCostDescending(a: Finding, b: Finding): number {
  if (a.monthlyCost === null && b.monthlyCost === null) return 0;
  if (a.monthlyCost === null) return 1;
  if (b.monthlyCost === null) return -1;
  return b.monthlyCost - a.monthlyCost;
}

export default function FindingsGrid({
  checks,
  kind,
}: {
  checks: CheckResult[];
  kind: 'security-checks' | 'cost-leakage';
}) {
  const isLeakage = kind === 'cost-leakage';

  return (
    <div className={styles.sections}>
      {checks.map((check) => {
        const rows = isLeakage ? [...check.findings].sort(byCostDescending) : check.findings;

        return (
          <section key={check.checkId} className={styles.section}>
            <div className={styles.sectionHeader}>
              <h3>{check.title}</h3>
              <div className={styles.headerMeta}>
                {check.source === 'native' && (
                  <span className={styles.sourceBadge}>Security Hub / Defender</span>
                )}
                {rows.length > 0 && <span className={styles.countBadge}>{rows.length}</span>}
              </div>
            </div>

            {check.status === 'unavailable' ? (
              <p role="alert" className={styles.unavailable}>
                This check could not run: {check.unavailableReason}
              </p>
            ) : rows.length === 0 ? (
              <p className={styles.clean}>No findings.</p>
            ) : (
              <div className={styles.tableScroll}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>Resource</th>
                      <th>Region</th>
                      {isLeakage ? <th className={styles.numeric}>Monthly cost</th> : <th>Severity</th>}
                      <th>Detail</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, index) => (
                      <tr key={`${row.resourceId}-${index}`}>
                        <td>{row.resourceName}</td>
                        <td>{row.region ?? '—'}</td>
                        {isLeakage ? (
                          <td className={styles.numeric}>{formatCost(row.monthlyCost)}</td>
                        ) : (
                          <td>
                            <span className={`${styles.severity} ${SEVERITY_CLASS[row.severity]}`}>{row.severity}</span>
                          </td>
                        )}
                        <td className={styles.detailCell}>{row.detail}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx jest components/reports/FindingsGrid.test.tsx`
Expected: PASS, 10 tests

- [ ] **Step 6: Commit**

```bash
git add components/reports/FindingsGrid.tsx components/reports/FindingsGrid.module.css components/reports/FindingsGrid.test.tsx
git commit -m "Add FindingsGrid component for security and leakage findings"
```

---

### Task 6: FindingsTab component

**Files:**
- Create: `components/reports/FindingsTab.tsx`
- Create: `components/reports/FindingsTab.module.css`
- Test: `components/reports/FindingsTab.test.tsx`

**Interfaces:**
- Consumes: `FindingsGrid` from `./FindingsGrid`; `Button` from `@/components/ui/button`; `FindingsResponse` from `@/lib/types`
- Produces: `export default function FindingsTab({ companyId, periodId, provider, kind }: FindingsTabProps)` where `FindingsTabProps = { companyId: string; periodId: string | null; provider: 'aws' | 'azure'; kind: 'security-checks' | 'cost-leakage' }`

This mirrors the load sequence in `AwsResourcesTab.tsx:42-76`: list connections, select the first, fetch its findings, and expose an account picker plus a Refresh button. It generalizes the two provider-specific pieces — the settings endpoint (`/api/settings/{provider}-credentials`) and the not-connected copy.

- [ ] **Step 1: Write the failing test**

Create `components/reports/FindingsTab.test.tsx`:

```tsx
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import FindingsTab from './FindingsTab';

const connectionsResponse = {
  connections: [
    { id: 'conn-1', label: 'Production', accessKeyIdMasked: 'AKIA********WXYZ', region: 'us-east-1', tagKey: '' },
    { id: 'conn-2', label: 'Sandbox', accessKeyIdMasked: 'AKIA********ABCD', region: 'us-west-2', tagKey: '' },
  ],
};

function findingsResponse(overrides: Record<string, unknown> = {}) {
  return {
    connected: true,
    region: 'us-east-1',
    fetchedAt: '2026-08-27T12:00:00.000Z',
    checks: [
      {
        checkId: 'unattached-ebs-volumes',
        title: 'Unattached EBS volumes',
        source: 'builtin',
        status: 'ok',
        unavailableReason: null,
        findings: [
          {
            severity: 'low',
            resourceId: 'arn:vol-1',
            resourceName: 'scratch',
            region: 'us-east-1',
            detail: 'Volume vol-1 is not attached to any instance.',
            monthlyCost: 8.4,
          },
        ],
      },
    ],
    ...overrides,
  };
}

describe('FindingsTab', () => {
  beforeEach(() => {
    global.fetch = jest.fn();
  });

  it('tells the user to connect AWS when there are no saved connections', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true, json: async () => ({ connections: [] }) });

    render(<FindingsTab companyId="company-1" periodId="period-1" provider="aws" kind="cost-leakage" />);

    expect(await screen.findByText(/aws isn't connected yet/i)).toBeInTheDocument();
  });

  it('tells the user to connect Azure when the provider is azure', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true, json: async () => ({ connections: [] }) });

    render(<FindingsTab companyId="company-1" periodId="period-1" provider="azure" kind="security-checks" />);

    expect(await screen.findByText(/azure isn't connected yet/i)).toBeInTheDocument();
  });

  it('requests the route for its provider and kind, passing the active period', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => connectionsResponse })
      .mockResolvedValueOnce({ ok: true, json: async () => findingsResponse() });

    render(<FindingsTab companyId="company-1" periodId="period-9" provider="aws" kind="cost-leakage" />);

    await screen.findByText('scratch');

    expect((global.fetch as jest.Mock).mock.calls[0][0]).toBe('/api/settings/aws-credentials?companyId=company-1');
    expect((global.fetch as jest.Mock).mock.calls[1][0]).toBe(
      '/api/aws/cost-leakage?companyId=company-1&credentialId=conn-1&periodId=period-9'
    );
  });

  it('omits the period parameter when no period is active', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => connectionsResponse })
      .mockResolvedValueOnce({ ok: true, json: async () => findingsResponse() });

    render(<FindingsTab companyId="company-1" periodId={null} provider="aws" kind="security-checks" />);

    await screen.findByText('scratch');

    expect((global.fetch as jest.Mock).mock.calls[1][0]).toBe(
      '/api/aws/security-checks?companyId=company-1&credentialId=conn-1'
    );
  });

  it('renders the findings returned by the route', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => connectionsResponse })
      .mockResolvedValueOnce({ ok: true, json: async () => findingsResponse() });

    render(<FindingsTab companyId="company-1" periodId="period-1" provider="aws" kind="cost-leakage" />);

    expect(await screen.findByRole('heading', { name: 'Unattached EBS volumes' })).toBeInTheDocument();
    expect(screen.getByText('scratch')).toBeInTheDocument();
    expect(screen.getByText('$8.40')).toBeInTheDocument();
  });

  it('refetches when a different account is picked', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => connectionsResponse })
      .mockResolvedValueOnce({ ok: true, json: async () => findingsResponse() })
      .mockResolvedValueOnce({ ok: true, json: async () => findingsResponse() });

    render(<FindingsTab companyId="company-1" periodId="period-1" provider="aws" kind="cost-leakage" />);
    await screen.findByText('scratch');

    await userEvent.selectOptions(screen.getByLabelText(/account/i), 'conn-2');

    await waitFor(() => {
      expect((global.fetch as jest.Mock).mock.calls[2][0]).toContain('credentialId=conn-2');
    });
  });

  it('refetches when Refresh is clicked', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => connectionsResponse })
      .mockResolvedValueOnce({ ok: true, json: async () => findingsResponse() })
      .mockResolvedValueOnce({ ok: true, json: async () => findingsResponse() });

    render(<FindingsTab companyId="company-1" periodId="period-1" provider="aws" kind="cost-leakage" />);
    await screen.findByText('scratch');

    await userEvent.click(screen.getByRole('button', { name: /refresh/i }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledTimes(3);
    });
  });

  it('shows the route error when the request fails', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => connectionsResponse })
      .mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'Could not decrypt the stored AWS credentials.' }) });

    render(<FindingsTab companyId="company-1" periodId="period-1" provider="aws" kind="cost-leakage" />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not decrypt the stored AWS credentials.');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest components/reports/FindingsTab.test.tsx`
Expected: FAIL — `Cannot find module './FindingsTab'`

- [ ] **Step 3: Write the stylesheet**

Create `components/reports/FindingsTab.module.css`:

```css
.wrapper {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}

.header {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.75rem 1.25rem;
}

.accountPicker {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.875rem;
}

.accountPicker select {
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--color-bg-alt);
  color: inherit;
  padding: 0.35rem 0.5rem;
  font: inherit;
}

.fetchedAt {
  font-size: 0.8rem;
  color: var(--muted-foreground);
  margin-right: auto;
}

.error {
  color: #d1274b;
  font-size: 0.875rem;
}
```

- [ ] **Step 4: Write the component**

Create `components/reports/FindingsTab.tsx`:

```tsx
'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import FindingsGrid from './FindingsGrid';
import type { FindingsResponse } from '@/lib/types';
import styles from './FindingsTab.module.css';

interface ConnectionSummary {
  id: string;
  label: string;
}

interface FindingsTabProps {
  companyId: string;
  periodId: string | null;
  provider: 'aws' | 'azure';
  kind: 'security-checks' | 'cost-leakage';
}

const PROVIDER_LABEL = { aws: 'AWS', azure: 'Azure' } as const;

export default function FindingsTab({ companyId, periodId, provider, kind }: FindingsTabProps) {
  const [connections, setConnections] = useState<ConnectionSummary[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [response, setResponse] = useState<FindingsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const providerLabel = PROVIDER_LABEL[provider];

  const loadFindings = useCallback(
    async (credentialId: string) => {
      // The cost join needs a period; the security routes ignore it, so it
      // is only sent when there is one to send.
      const periodParam = periodId ? `&periodId=${periodId}` : '';
      const res = await fetch(`/api/${provider}/${kind}?companyId=${companyId}&credentialId=${credentialId}${periodParam}`);
      const body = await res.json();
      if (!res.ok) {
        throw new Error(body.error ?? `Could not load ${providerLabel} findings.`);
      }
      return body as FindingsResponse;
    },
    [companyId, kind, periodId, provider, providerLabel]
  );

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const listRes = await fetch(`/api/settings/${provider}-credentials?companyId=${companyId}`);
        const listBody = await listRes.json();
        const list = (listBody.connections ?? []) as ConnectionSummary[];
        if (cancelled) return;
        setConnections(list);

        if (list.length === 0) {
          setLoading(false);
          return;
        }

        const firstId = list[0].id;
        setSelectedId(firstId);
        const result = await loadFindings(firstId);
        if (!cancelled) {
          setResponse(result);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : `Could not load ${providerLabel} findings.`);
          setLoading(false);
        }
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [companyId, loadFindings, provider, providerLabel]);

  async function refetch(credentialId: string) {
    setRefreshing(true);
    setError(null);
    try {
      setResponse(await loadFindings(credentialId));
    } catch (err) {
      setError(err instanceof Error ? err.message : `Could not load ${providerLabel} findings.`);
    }
    setRefreshing(false);
  }

  async function handleSelectConnection(id: string) {
    setSelectedId(id);
    await refetch(id);
  }

  if (loading) {
    return <p>Loading…</p>;
  }

  if (error) {
    return (
      <p role="alert" className={styles.error}>
        {error}
      </p>
    );
  }

  if (!connections || connections.length === 0 || !response?.connected) {
    return (
      <p>
        {providerLabel} isn&apos;t connected yet. Add your {providerLabel} credentials in the Settings tab to see live
        findings.
      </p>
    );
  }

  return (
    <div className={styles.wrapper}>
      <div className={styles.header}>
        <div className={styles.accountPicker}>
          <label htmlFor={`${provider}-${kind}-account-picker`}>Account</label>
          <select
            id={`${provider}-${kind}-account-picker`}
            value={selectedId ?? ''}
            disabled={refreshing}
            onChange={(e) => handleSelectConnection(e.target.value)}
          >
            {connections.map((connection) => (
              <option key={connection.id} value={connection.id}>
                {connection.label}
              </option>
            ))}
          </select>
        </div>
        <span className={styles.fetchedAt}>
          {response.region ? `Region ${response.region} — ` : ''}last refreshed{' '}
          {new Date(response.fetchedAt).toLocaleTimeString()}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={refreshing}
          onClick={() => selectedId && refetch(selectedId)}
        >
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </Button>
      </div>

      <FindingsGrid checks={response.checks} kind={kind} />
    </div>
  );
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx jest components/reports/FindingsTab.test.tsx`
Expected: PASS, 8 tests

- [ ] **Step 6: Commit**

```bash
git add components/reports/FindingsTab.tsx components/reports/FindingsTab.module.css components/reports/FindingsTab.test.tsx
git commit -m "Add shared FindingsTab component"
```

---

### Task 7: Wire the AWS Cost Leakage sub-tab into AppShell

**Files:**
- Modify: `components/shell/AppShell.tsx:21-24` (imports), `:95` (aws sub-tab state), `:99-100` (wide-view predicate), `:401-427` (aws tab render)
- Test: `components/shell/AppShell.test.tsx`

**Interfaces:**
- Consumes: `FindingsTab` from `../reports/FindingsTab`
- Produces: the AWS tab renders a `Cost Leakage` trigger; `awsSubTab` union gains `'costLeakage'` and (in Task 10) `'securityChecks'`

After this task the first vertical slice is live: AWS → Cost Leakage shows real findings in the browser.

- [ ] **Step 1: Write the failing test**

Append to `components/shell/AppShell.test.tsx` (inside the existing top-level `describe`):

```tsx
it('shows a Cost Leakage sub-tab under AWS', async () => {
  renderAppShell();

  await userEvent.click(screen.getByRole('tab', { name: 'AWS' }));

  expect(screen.getByRole('tab', { name: 'Cost Leakage' })).toBeInTheDocument();
});
```

If the existing suite has no `renderAppShell` helper, use whatever render call the neighbouring tests in that file already use, and click through to the AWS tab the same way they do.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest components/shell/AppShell.test.tsx -t "Cost Leakage"`
Expected: FAIL — unable to find a tab named "Cost Leakage"

- [ ] **Step 3: Add the import**

In `components/shell/AppShell.tsx`, after the existing `AzureUsersTab` import:

```tsx
import FindingsTab from '../reports/FindingsTab';
```

- [ ] **Step 4: Widen the AWS sub-tab state**

Replace line 95:

```tsx
const [awsSubTab, setAwsSubTab] = useState<'overview' | 'resources' | 'iamUsers' | 'costLeakage'>('overview');
```

- [ ] **Step 5: Include the new sub-tab in the wide-layout predicate**

Replace the `isWideCloudView` AWS clause (line 99) so the findings grid gets the same wide layout the resource grids get:

```tsx
(activeTab === 'aws' &&
  (awsSubTab === 'resources' || awsSubTab === 'iamUsers' || awsSubTab === 'costLeakage')) ||
```

- [ ] **Step 6: Render the trigger and the tab**

In the `activeTab === 'aws'` block, add the trigger after the IAM Users trigger:

```tsx
<TabsTrigger value="costLeakage">Cost Leakage</TabsTrigger>
```

Update the `onValueChange` cast on the same `Tabs` element:

```tsx
onValueChange={(value) => setAwsSubTab(value as 'overview' | 'resources' | 'iamUsers' | 'costLeakage')}
```

And replace the render chain's final `else` so the new tab is reachable:

```tsx
{awsSubTab === 'overview' ? (
  <CostReportTab
    companyId={effectiveCompanyId}
    cloudProvider="aws"
    periodId={periodIdForReports}
    isReadOnly={viewingArchivedPeriod}
    onServiceClick={(serviceName) => handleServiceDrillDown([serviceName])}
    onPeriodArchived={(newPeriodId) => setActivePeriodId(newPeriodId)}
  />
) : awsSubTab === 'resources' ? (
  <AwsResourcesTab companyId={effectiveCompanyId} />
) : awsSubTab === 'iamUsers' ? (
  <AwsIamUsersTab companyId={effectiveCompanyId} />
) : (
  <FindingsTab
    companyId={effectiveCompanyId}
    periodId={periodIdForReports}
    provider="aws"
    kind="cost-leakage"
  />
)}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `npx jest components/shell/AppShell.test.tsx`
Expected: PASS, including the new case and every pre-existing one

- [ ] **Step 8: Run the full suite and type check**

Run: `npm test && npx tsc --noEmit`
Expected: all suites pass, no type errors

- [ ] **Step 9: Commit**

```bash
git add components/shell/AppShell.tsx components/shell/AppShell.test.tsx
git commit -m "Add AWS Cost Leakage sub-tab"
```

---

### Task 8: Built-in AWS security rules

**Files:**
- Create: `lib/aws/securityChecks.ts`
- Test: `lib/aws/securityChecks.test.ts`

**Interfaces:**
- Consumes: `okCheck` from `@/lib/findings`; `CheckResult`, `Finding` from `@/lib/types`
- Produces: constants `SENSITIVE_PORTS`, `ACCESS_KEY_MAX_AGE_DAYS = 90`, `INACTIVE_USER_DAYS = 90`; input interfaces `SecurityGroupInput`, `S3BucketInput`, `AccountSummaryInput`, `RdsSecurityInput`, `IamUserInput`, `VolumeEncryptionInput`; rules `openSecurityGroups`, `publicS3Buckets`, `rootAccessKeys`, `publicRdsInstances`, `iamUsersWithoutMfa`, `staleAccessKeys`, `inactiveIamUsers`, `unencryptedVolumes`, `unencryptedRdsStorage`

- [ ] **Step 1: Write the failing test**

Create `lib/aws/securityChecks.test.ts`:

```ts
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
} from './securityChecks';

describe('openSecurityGroups', () => {
  it('flags a group exposing SSH to the whole internet', () => {
    const result = openSecurityGroups([
      {
        groupId: 'sg-1',
        groupName: 'web',
        arn: 'arn:sg-1',
        region: 'us-east-1',
        inboundRules: [{ protocol: 'tcp', fromPort: 22, toPort: 22, cidrs: ['0.0.0.0/0'] }],
      },
    ]);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].severity).toBe('critical');
    expect(result.findings[0].detail).toContain('22');
  });

  it('flags an IPv6 open rule too', () => {
    const result = openSecurityGroups([
      {
        groupId: 'sg-2',
        groupName: 'web6',
        arn: 'arn:sg-2',
        region: 'us-east-1',
        inboundRules: [{ protocol: 'tcp', fromPort: 3389, toPort: 3389, cidrs: ['::/0'] }],
      },
    ]);

    expect(result.findings).toHaveLength(1);
  });

  it('flags an all-protocols rule open to the internet', () => {
    const result = openSecurityGroups([
      {
        groupId: 'sg-3',
        groupName: 'everything',
        arn: 'arn:sg-3',
        region: 'us-east-1',
        inboundRules: [{ protocol: '-1', fromPort: null, toPort: null, cidrs: ['0.0.0.0/0'] }],
      },
    ]);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].detail).toContain('all ports');
  });

  it('flags a wide port range that happens to contain a sensitive port', () => {
    const result = openSecurityGroups([
      {
        groupId: 'sg-4',
        groupName: 'range',
        arn: 'arn:sg-4',
        region: 'us-east-1',
        inboundRules: [{ protocol: 'tcp', fromPort: 3000, toPort: 6000, cidrs: ['0.0.0.0/0'] }],
      },
    ]);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].detail).toContain('3306');
    expect(result.findings[0].detail).toContain('5432');
  });

  it('ignores a sensitive port open only to a private CIDR', () => {
    const result = openSecurityGroups([
      {
        groupId: 'sg-5',
        groupName: 'internal',
        arn: 'arn:sg-5',
        region: 'us-east-1',
        inboundRules: [{ protocol: 'tcp', fromPort: 22, toPort: 22, cidrs: ['10.0.0.0/8'] }],
      },
    ]);

    expect(result.findings).toEqual([]);
  });

  it('ignores a non-sensitive port open to the internet, since that is what web servers do', () => {
    const result = openSecurityGroups([
      {
        groupId: 'sg-6',
        groupName: 'https',
        arn: 'arn:sg-6',
        region: 'us-east-1',
        inboundRules: [{ protocol: 'tcp', fromPort: 443, toPort: 443, cidrs: ['0.0.0.0/0'] }],
      },
    ]);

    expect(result.findings).toEqual([]);
  });

  it('reports one finding per group even when several rules are open', () => {
    const result = openSecurityGroups([
      {
        groupId: 'sg-7',
        groupName: 'multi',
        arn: 'arn:sg-7',
        region: 'us-east-1',
        inboundRules: [
          { protocol: 'tcp', fromPort: 22, toPort: 22, cidrs: ['0.0.0.0/0'] },
          { protocol: 'tcp', fromPort: 3389, toPort: 3389, cidrs: ['0.0.0.0/0'] },
        ],
      },
    ]);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].detail).toContain('22');
    expect(result.findings[0].detail).toContain('3389');
  });
});

describe('publicS3Buckets', () => {
  it('flags a bucket with no public access block', () => {
    const result = publicS3Buckets([
      { name: 'assets', region: 'us-east-1', publicAccessBlockAll: false, isPublicByPolicy: false, hasPublicAcl: false },
    ]);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].severity).toBe('critical');
  });

  it('flags a bucket made public by its policy even when a block is configured', () => {
    const result = publicS3Buckets([
      { name: 'leaky', region: 'us-east-1', publicAccessBlockAll: true, isPublicByPolicy: true, hasPublicAcl: false },
    ]);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].detail).toContain('policy');
  });

  it('flags a bucket with a public ACL', () => {
    const result = publicS3Buckets([
      { name: 'acl', region: 'us-east-1', publicAccessBlockAll: true, isPublicByPolicy: false, hasPublicAcl: true },
    ]);

    expect(result.findings[0].detail).toContain('ACL');
  });

  it('ignores a fully blocked private bucket', () => {
    const result = publicS3Buckets([
      { name: 'safe', region: 'us-east-1', publicAccessBlockAll: true, isPublicByPolicy: false, hasPublicAcl: false },
    ]);

    expect(result.findings).toEqual([]);
  });
});

describe('rootAccessKeys', () => {
  it('flags an account whose root user has access keys', () => {
    const result = rootAccessKeys({ accountAccessKeysPresent: 1 }, '123456789012');

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].severity).toBe('critical');
  });

  it('passes an account with no root keys', () => {
    const result = rootAccessKeys({ accountAccessKeysPresent: 0 }, '123456789012');

    expect(result.findings).toEqual([]);
  });
});

describe('publicRdsInstances', () => {
  it('flags a publicly accessible database', () => {
    const result = publicRdsInstances([
      { arn: 'arn:db-1', identifier: 'prod', publiclyAccessible: true, storageEncrypted: true, region: 'us-east-1' },
    ]);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].severity).toBe('high');
  });

  it('ignores a private database', () => {
    const result = publicRdsInstances([
      { arn: 'arn:db-2', identifier: 'internal', publiclyAccessible: false, storageEncrypted: true, region: 'us-east-1' },
    ]);

    expect(result.findings).toEqual([]);
  });
});

describe('iamUsersWithoutMfa', () => {
  it('flags a user with a console password and no MFA device', () => {
    const result = iamUsersWithoutMfa([
      {
        userName: 'jdoe',
        arn: 'arn:user/jdoe',
        hasConsolePassword: true,
        mfaDeviceCount: 0,
        accessKeys: [],
        passwordLastUsed: null,
      },
    ]);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].severity).toBe('high');
  });

  it('ignores a user with MFA enrolled', () => {
    const result = iamUsersWithoutMfa([
      {
        userName: 'safe',
        arn: 'arn:user/safe',
        hasConsolePassword: true,
        mfaDeviceCount: 1,
        accessKeys: [],
        passwordLastUsed: null,
      },
    ]);

    expect(result.findings).toEqual([]);
  });

  it('ignores a service user with no console access, since MFA does not apply', () => {
    const result = iamUsersWithoutMfa([
      {
        userName: 'ci-bot',
        arn: 'arn:user/ci-bot',
        hasConsolePassword: false,
        mfaDeviceCount: 0,
        accessKeys: [],
        passwordLastUsed: null,
      },
    ]);

    expect(result.findings).toEqual([]);
  });
});

describe('staleAccessKeys', () => {
  const now = new Date('2026-08-27T00:00:00.000Z');

  it('flags a key older than 90 days', () => {
    const result = staleAccessKeys(
      [
        {
          userName: 'jdoe',
          arn: 'arn:user/jdoe',
          hasConsolePassword: false,
          mfaDeviceCount: 0,
          accessKeys: [{ accessKeyId: 'AKIA1', createDate: '2026-01-01T00:00:00.000Z', lastUsedDate: null }],
          passwordLastUsed: null,
        },
      ],
      now
    );

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].detail).toContain('AKIA1');
  });

  it('ignores a freshly rotated key', () => {
    const result = staleAccessKeys(
      [
        {
          userName: 'jdoe',
          arn: 'arn:user/jdoe',
          hasConsolePassword: false,
          mfaDeviceCount: 0,
          accessKeys: [{ accessKeyId: 'AKIA2', createDate: '2026-08-01T00:00:00.000Z', lastUsedDate: null }],
          passwordLastUsed: null,
        },
      ],
      now
    );

    expect(result.findings).toEqual([]);
  });
});

describe('inactiveIamUsers', () => {
  const now = new Date('2026-08-27T00:00:00.000Z');

  it('flags a user whose password and keys have all been unused for 90 days', () => {
    const result = inactiveIamUsers(
      [
        {
          userName: 'ghost',
          arn: 'arn:user/ghost',
          hasConsolePassword: true,
          mfaDeviceCount: 1,
          accessKeys: [{ accessKeyId: 'AKIA3', createDate: '2025-01-01T00:00:00.000Z', lastUsedDate: '2026-01-01T00:00:00.000Z' }],
          passwordLastUsed: '2026-02-01T00:00:00.000Z',
        },
      ],
      now
    );

    expect(result.findings).toHaveLength(1);
  });

  it('ignores a user active last week', () => {
    const result = inactiveIamUsers(
      [
        {
          userName: 'active',
          arn: 'arn:user/active',
          hasConsolePassword: true,
          mfaDeviceCount: 1,
          accessKeys: [],
          passwordLastUsed: '2026-08-20T00:00:00.000Z',
        },
      ],
      now
    );

    expect(result.findings).toEqual([]);
  });

  it('ignores a user with no recorded activity at all, since a brand new user looks identical', () => {
    const result = inactiveIamUsers(
      [
        {
          userName: 'new',
          arn: 'arn:user/new',
          hasConsolePassword: true,
          mfaDeviceCount: 1,
          accessKeys: [],
          passwordLastUsed: null,
        },
      ],
      now
    );

    expect(result.findings).toEqual([]);
  });
});

describe('unencryptedVolumes', () => {
  it('flags an unencrypted volume', () => {
    const result = unencryptedVolumes([
      { volumeId: 'vol-1', arn: 'arn:vol-1', name: 'data', encrypted: false, region: 'us-east-1' },
    ]);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].severity).toBe('medium');
  });

  it('ignores an encrypted volume', () => {
    const result = unencryptedVolumes([
      { volumeId: 'vol-2', arn: 'arn:vol-2', name: null, encrypted: true, region: 'us-east-1' },
    ]);

    expect(result.findings).toEqual([]);
  });
});

describe('unencryptedRdsStorage', () => {
  it('flags a database with unencrypted storage', () => {
    const result = unencryptedRdsStorage([
      { arn: 'arn:db-3', identifier: 'legacy', publiclyAccessible: false, storageEncrypted: false, region: 'us-east-1' },
    ]);

    expect(result.findings).toHaveLength(1);
  });

  it('ignores an encrypted database', () => {
    const result = unencryptedRdsStorage([
      { arn: 'arn:db-4', identifier: 'modern', publiclyAccessible: false, storageEncrypted: true, region: 'us-east-1' },
    ]);

    expect(result.findings).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest lib/aws/securityChecks.test.ts`
Expected: FAIL — `Cannot find module './securityChecks'`

- [ ] **Step 3: Write the implementation**

Create `lib/aws/securityChecks.ts`:

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest lib/aws/securityChecks.test.ts`
Expected: PASS, 24 tests

- [ ] **Step 5: Commit**

```bash
git add lib/aws/securityChecks.ts lib/aws/securityChecks.test.ts
git commit -m "Add built-in AWS security check rules"
```

---

### Task 9: Security Hub availability and normalization

**Files:**
- Create: `lib/aws/securityHub.ts`
- Test: `lib/aws/securityHub.test.ts`

**Interfaces:**
- Consumes: `okCheck` from `@/lib/findings`; `CheckResult`, `Finding`, `FindingSeverity` from `@/lib/types`
- Produces: `type NativeAvailability = { kind: 'not-enabled' } | { kind: 'unavailable'; reason: string }`; `classifySecurityHubError(err: unknown): NativeAvailability`; `SecurityHubFindingInput`; `normalizeSecurityHubFindings(findings: readonly SecurityHubFindingInput[]): CheckResult[]`; `mapSecurityHubSeverity(label: string | null): FindingSeverity`

**Design note — a refinement on the spec.** The spec's file table folds Security Hub normalization into `lib/aws/securityChecks.ts`. It gets its own module here because it has a different job — translating and classifying someone else's data — and because the not-enabled-vs-denied distinction is the subtlest logic in the feature and deserves its own focused test file. The spec's Azure counterpart is split the same way in Task 13.

This is the three-outcome rule from the spec's "Native-first resolution" section:

1. **Enabled with findings** — the caller gets normalized `CheckResult`s and skips the built-in rules.
2. **Not enabled** (`InvalidAccessException`) — silent fallback to built-in rules. Nothing is wrong, so nothing is reported.
3. **Enabled but denied** (`AccessDeniedException`, or HTTP 403) — fall back *and* surface an `unavailable` check, because the grid is less complete than the customer may assume.

Anything else — a throttle, a network failure, an unrecognized error — is treated as case 3. Silence is only ever correct when we positively identify the service as not enabled.

- [ ] **Step 1: Write the failing test**

Create `lib/aws/securityHub.test.ts`:

```ts
import { classifySecurityHubError, normalizeSecurityHubFindings, mapSecurityHubSeverity } from './securityHub';

function awsError(name: string, httpStatusCode?: number) {
  const err = new Error(`${name} occurred`) as Error & { name: string; $metadata?: { httpStatusCode?: number } };
  err.name = name;
  if (httpStatusCode) err.$metadata = { httpStatusCode };
  return err;
}

describe('classifySecurityHubError', () => {
  it('treats InvalidAccessException as the service simply not being enabled', () => {
    expect(classifySecurityHubError(awsError('InvalidAccessException'))).toEqual({ kind: 'not-enabled' });
  });

  it('treats AccessDeniedException as a permissions problem worth reporting', () => {
    const result = classifySecurityHubError(awsError('AccessDeniedException'));

    expect(result.kind).toBe('unavailable');
    expect(result.kind === 'unavailable' && result.reason).toContain('securityhub:GetFindings');
  });

  it('treats an HTTP 403 as a permissions problem even when the name is unfamiliar', () => {
    const result = classifySecurityHubError(awsError('SomeOtherException', 403));

    expect(result.kind).toBe('unavailable');
  });

  it('treats an unrecognized error as unavailable rather than silently falling back', () => {
    const result = classifySecurityHubError(new Error('socket hang up'));

    expect(result.kind).toBe('unavailable');
    expect(result.kind === 'unavailable' && result.reason).toContain('socket hang up');
  });

  it('handles a thrown non-Error value', () => {
    const result = classifySecurityHubError('something odd');

    expect(result.kind).toBe('unavailable');
  });
});

describe('mapSecurityHubSeverity', () => {
  it('maps CRITICAL and HIGH straight through', () => {
    expect(mapSecurityHubSeverity('CRITICAL')).toBe('critical');
    expect(mapSecurityHubSeverity('HIGH')).toBe('high');
  });

  it('maps MEDIUM to medium and both LOW and INFORMATIONAL to low', () => {
    expect(mapSecurityHubSeverity('MEDIUM')).toBe('medium');
    expect(mapSecurityHubSeverity('LOW')).toBe('low');
    expect(mapSecurityHubSeverity('INFORMATIONAL')).toBe('low');
  });

  it('defaults an unknown or missing label to medium', () => {
    expect(mapSecurityHubSeverity(null)).toBe('medium');
    expect(mapSecurityHubSeverity('WEIRD')).toBe('medium');
  });
});

describe('normalizeSecurityHubFindings', () => {
  const base = {
    id: 'finding-1',
    title: 'S3 buckets should prohibit public read access',
    description: 'This control checks whether the bucket allows public reads.',
    severityLabel: 'CRITICAL',
    region: 'us-east-1',
    resourceId: 'arn:aws:s3:::assets',
    generatorId: 's3-bucket-public-read-prohibited',
  };

  it('groups findings that share a control into one check', () => {
    const checks = normalizeSecurityHubFindings([
      base,
      { ...base, id: 'finding-2', resourceId: 'arn:aws:s3:::logs' },
    ]);

    expect(checks).toHaveLength(1);
    expect(checks[0].findings).toHaveLength(2);
    expect(checks[0].title).toBe('S3 buckets should prohibit public read access');
  });

  it('marks every normalized check as sourced from the native service', () => {
    const checks = normalizeSecurityHubFindings([base]);

    expect(checks[0].source).toBe('native');
    expect(checks[0].status).toBe('ok');
  });

  it('splits findings from different controls into separate checks', () => {
    const checks = normalizeSecurityHubFindings([
      base,
      { ...base, id: 'finding-3', generatorId: 'iam-root-access-key-check', title: 'Root user should not have keys' },
    ]);

    expect(checks).toHaveLength(2);
    expect(checks.map((check) => check.title).sort()).toEqual([
      'Root user should not have keys',
      'S3 buckets should prohibit public read access',
    ]);
  });

  it('carries the severity, resource and description onto each finding', () => {
    const checks = normalizeSecurityHubFindings([base]);

    expect(checks[0].findings[0]).toMatchObject({
      severity: 'critical',
      resourceId: 'arn:aws:s3:::assets',
      region: 'us-east-1',
      detail: 'This control checks whether the bucket allows public reads.',
      monthlyCost: null,
    });
  });

  it('shortens the resource ARN into a readable name', () => {
    const checks = normalizeSecurityHubFindings([base]);

    expect(checks[0].findings[0].resourceName).toBe('assets');
  });

  it('returns no checks for an empty finding list', () => {
    expect(normalizeSecurityHubFindings([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest lib/aws/securityHub.test.ts`
Expected: FAIL — `Cannot find module './securityHub'`

- [ ] **Step 3: Write the implementation**

Create `lib/aws/securityHub.ts`:

```ts
import { okCheck } from '@/lib/findings';
import type { CheckResult, Finding, FindingSeverity } from '@/lib/types';

export type NativeAvailability = { kind: 'not-enabled' } | { kind: 'unavailable'; reason: string };

export interface SecurityHubFindingInput {
  id: string;
  title: string;
  description: string;
  severityLabel: string | null;
  region: string | null;
  resourceId: string;
  /** The control that produced the finding — findings are grouped by it. */
  generatorId: string;
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : '';
}

function httpStatus(err: unknown): number | undefined {
  return (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
}

/**
 * Decides whether a Security Hub failure means "not turned on" or "turned on
 * but we cannot see it".
 *
 * Only InvalidAccessException means not-enabled. Everything else — including
 * errors we do not recognize — is reported, because a security tab that goes
 * quiet on an unexpected error is worse than one that admits it is blind.
 */
export function classifySecurityHubError(err: unknown): NativeAvailability {
  if (errorName(err) === 'InvalidAccessException') {
    return { kind: 'not-enabled' };
  }

  if (errorName(err) === 'AccessDeniedException' || httpStatus(err) === 403) {
    return {
      kind: 'unavailable',
      reason:
        'Security Hub is enabled on this account but the credential was refused. Grant securityhub:GetFindings (the AWS-managed SecurityAudit policy includes it) to see its findings here.',
    };
  }

  const message = err instanceof Error ? err.message : String(err);
  return { kind: 'unavailable', reason: `Could not read Security Hub findings: ${message}` };
}

export function mapSecurityHubSeverity(label: string | null): FindingSeverity {
  switch (label) {
    case 'CRITICAL':
      return 'critical';
    case 'HIGH':
      return 'high';
    case 'LOW':
    case 'INFORMATIONAL':
      return 'low';
    default:
      // MEDIUM, plus anything unrecognized. Defaulting unknown labels down to
      // 'low' would hide them at the bottom of the grid.
      return 'medium';
  }
}

// ARNs are unreadable in a table cell. The last path or colon segment is
// almost always the resource's actual name.
function shortName(resourceId: string): string {
  const afterSlash = resourceId.split('/').pop() ?? resourceId;
  return afterSlash.split(':').pop() || resourceId;
}

export function normalizeSecurityHubFindings(findings: readonly SecurityHubFindingInput[]): CheckResult[] {
  const byControl = new Map<string, { title: string; findings: Finding[] }>();

  for (const raw of findings) {
    const group = byControl.get(raw.generatorId) ?? { title: raw.title, findings: [] };
    group.findings.push({
      severity: mapSecurityHubSeverity(raw.severityLabel),
      resourceId: raw.resourceId,
      resourceName: shortName(raw.resourceId),
      region: raw.region,
      detail: raw.description,
      monthlyCost: null,
    });
    byControl.set(raw.generatorId, group);
  }

  return [...byControl.entries()].map(([generatorId, group]) =>
    okCheck(`securityhub:${generatorId}`, group.title, 'native', group.findings)
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest lib/aws/securityHub.test.ts`
Expected: PASS, 14 tests

- [ ] **Step 5: Commit**

```bash
git add lib/aws/securityHub.ts lib/aws/securityHub.test.ts
git commit -m "Add Security Hub availability classification and normalization"
```

---

### Task 10: AWS security checks route and sub-tab

**Files:**
- Create: `app/api/aws/security-checks/route.ts`
- Modify: `components/shell/AppShell.tsx` (aws sub-tab union, wide-view predicate, trigger, render chain)
- Test: `components/shell/AppShell.test.tsx`

**Interfaces:**
- Consumes: every rule from `@/lib/aws/securityChecks`; `classifySecurityHubError`, `normalizeSecurityHubFindings` from `@/lib/aws/securityHub`; `unavailableCheck` from `@/lib/findings`
- Produces: `GET /api/aws/security-checks?companyId=&credentialId=` returning `FindingsResponse`; the AWS tab renders a `Security Checks` trigger

- [ ] **Step 1: Create the route**

Create `app/api/aws/security-checks/route.ts`:

```ts
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

async function runCheck(checkId: string, title: string, run: () => Promise<CheckResult>): Promise<CheckResult> {
  try {
    return await run();
  } catch (err) {
    return unavailableCheck(checkId, title, 'builtin', errorMessage(err));
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
    const reason = `Could not read IAM users: ${iamUsersError}. The credential needs iam:ListUsers, ListAccessKeys, ListMFADevices and GetLoginProfile.`;
    checks.push(unavailableCheck('iam-users-without-mfa', 'Console users without MFA', 'builtin', reason));
    checks.push(unavailableCheck('stale-access-keys', 'Access keys older than 90 days', 'builtin', reason));
    checks.push(unavailableCheck('inactive-iam-users', 'IAM users inactive over 90 days', 'builtin', reason));
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
          arn: `arn:aws:ec2:${region}:volume/${volume.VolumeId ?? ''}`,
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
    const reason = `Could not read RDS instances: ${rdsError}. The credential needs rds:DescribeDBInstances.`;
    checks.push(unavailableCheck('public-rds-instances', 'Publicly accessible databases', 'builtin', reason));
    checks.push(unavailableCheck('unencrypted-rds-storage', 'Unencrypted database storage', 'builtin', reason));
  }

  return NextResponse.json({
    connected: true,
    region,
    fetchedAt: new Date().toISOString(),
    checks,
  } satisfies FindingsResponse);
}
```

- [ ] **Step 2: Write the failing AppShell test**

Append to `components/shell/AppShell.test.tsx`:

```tsx
it('shows a Security Checks sub-tab under AWS', async () => {
  renderAppShell();

  await userEvent.click(screen.getByRole('tab', { name: 'AWS' }));

  expect(screen.getByRole('tab', { name: 'Security Checks' })).toBeInTheDocument();
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx jest components/shell/AppShell.test.tsx -t "Security Checks"`
Expected: FAIL — unable to find a tab named "Security Checks"

- [ ] **Step 4: Widen the AWS sub-tab state**

Replace the `awsSubTab` declaration:

```tsx
const [awsSubTab, setAwsSubTab] = useState<
  'overview' | 'resources' | 'iamUsers' | 'securityChecks' | 'costLeakage'
>('overview');
```

Update the `onValueChange` cast on the AWS `Tabs` element to the same union, and add `awsSubTab === 'securityChecks'` to the `isWideCloudView` AWS clause alongside `costLeakage`.

- [ ] **Step 5: Add the trigger and the render branch**

Add the trigger before the Cost Leakage one:

```tsx
<TabsTrigger value="securityChecks">Security Checks</TabsTrigger>
```

And add a branch to the render chain, before the final `else`:

```tsx
) : awsSubTab === 'securityChecks' ? (
  <FindingsTab
    companyId={effectiveCompanyId}
    periodId={periodIdForReports}
    provider="aws"
    kind="security-checks"
  />
) : (
```

- [ ] **Step 6: Run the tests, type check, and lint**

Run: `npm test && npx tsc --noEmit && npm run lint`
Expected: all suites pass, no type errors, no lint errors

- [ ] **Step 7: Commit**

```bash
git add app/api/aws/security-checks/route.ts components/shell/AppShell.tsx components/shell/AppShell.test.tsx
git commit -m "Add AWS Security Checks route and sub-tab"
```

---

### Task 11: Azure cost leakage rules

**Files:**
- Create: `lib/azure/costLeakage.ts`
- Test: `lib/azure/costLeakage.test.ts`

**Interfaces:**
- Consumes: `okCheck` from `@/lib/findings`; `CheckResult`, `Finding` from `@/lib/types`
- Produces: input interfaces `DiskInput`, `PublicIpInput`, `VmInput`, `SnapshotInput`, `AppServicePlanInput`, `LoadBalancerInput`, `NetworkInterfaceInput`; rules `unattachedDisks`, `unassociatedPublicIps`, `stoppedNotDeallocatedVms`, `orphanedSnapshots`, `emptyAppServicePlans`, `emptyBackendPoolLoadBalancers`, `orphanedNetworkInterfaces`

**The rule that earns this tab on Azure:** a VM in `PowerState/stopped` is still billing full compute — only `PowerState/deallocated` stops the meter. Customers routinely "stop" a VM in the portal's older flows and assume they stopped paying. Getting this distinction right is the single highest-value check in the Azure leakage set.

- [ ] **Step 1: Write the failing test**

Create `lib/azure/costLeakage.test.ts`:

```ts
import {
  unattachedDisks,
  unassociatedPublicIps,
  stoppedNotDeallocatedVms,
  orphanedSnapshots,
  emptyAppServicePlans,
  emptyBackendPoolLoadBalancers,
  orphanedNetworkInterfaces,
} from './costLeakage';

describe('unattachedDisks', () => {
  it('flags an unattached managed disk', () => {
    const result = unattachedDisks([
      {
        id: '/subscriptions/s1/disks/disk-1',
        name: 'disk-1',
        diskState: 'Unattached',
        sizeGb: 512,
        location: 'eastus',
      },
    ]);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].detail).toContain('512 GB');
    expect(result.findings[0].monthlyCost).toBeNull();
  });

  it('ignores a disk attached to a VM', () => {
    const result = unattachedDisks([
      { id: '/subscriptions/s1/disks/disk-2', name: 'disk-2', diskState: 'Attached', sizeGb: 128, location: 'eastus' },
    ]);

    expect(result.findings).toEqual([]);
  });

  it('ignores a disk reserved for an upload, which is a transient state rather than waste', () => {
    const result = unattachedDisks([
      {
        id: '/subscriptions/s1/disks/disk-3',
        name: 'disk-3',
        diskState: 'ActiveUpload',
        sizeGb: 64,
        location: 'eastus',
      },
    ]);

    expect(result.findings).toEqual([]);
  });
});

describe('unassociatedPublicIps', () => {
  it('flags a public IP with no IP configuration', () => {
    const result = unassociatedPublicIps([
      {
        id: '/subscriptions/s1/publicIPAddresses/ip-1',
        name: 'ip-1',
        ipAddress: '20.0.0.1',
        hasIpConfiguration: false,
        location: 'eastus',
      },
    ]);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].resourceName).toBe('ip-1');
  });

  it('ignores an attached public IP', () => {
    const result = unassociatedPublicIps([
      {
        id: '/subscriptions/s1/publicIPAddresses/ip-2',
        name: 'ip-2',
        ipAddress: '20.0.0.2',
        hasIpConfiguration: true,
        location: 'eastus',
      },
    ]);

    expect(result.findings).toEqual([]);
  });
});

describe('stoppedNotDeallocatedVms', () => {
  it('flags a VM that is stopped but not deallocated, because compute still bills', () => {
    const result = stoppedNotDeallocatedVms([
      { id: '/subscriptions/s1/vms/vm-1', name: 'vm-1', powerState: 'PowerState/stopped', location: 'eastus' },
    ]);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].detail).toContain('deallocated');
  });

  it('ignores a deallocated VM, which has stopped billing for compute', () => {
    const result = stoppedNotDeallocatedVms([
      { id: '/subscriptions/s1/vms/vm-2', name: 'vm-2', powerState: 'PowerState/deallocated', location: 'eastus' },
    ]);

    expect(result.findings).toEqual([]);
  });

  it('ignores a running VM', () => {
    const result = stoppedNotDeallocatedVms([
      { id: '/subscriptions/s1/vms/vm-3', name: 'vm-3', powerState: 'PowerState/running', location: 'eastus' },
    ]);

    expect(result.findings).toEqual([]);
  });

  it('ignores a VM whose power state could not be read', () => {
    const result = stoppedNotDeallocatedVms([
      { id: '/subscriptions/s1/vms/vm-4', name: 'vm-4', powerState: null, location: 'eastus' },
    ]);

    expect(result.findings).toEqual([]);
  });
});

describe('orphanedSnapshots', () => {
  it('flags a snapshot whose source disk is gone', () => {
    const result = orphanedSnapshots(
      [
        {
          id: '/subscriptions/s1/snapshots/snap-1',
          name: 'snap-1',
          sourceDiskId: '/subscriptions/s1/disks/gone',
          sizeGb: 128,
          location: 'eastus',
        },
      ],
      new Set(['/subscriptions/s1/disks/alive'])
    );

    expect(result.findings).toHaveLength(1);
  });

  it('matches the source disk id case-insensitively, since ARM casing is inconsistent', () => {
    const result = orphanedSnapshots(
      [
        {
          id: '/subscriptions/s1/snapshots/snap-2',
          name: 'snap-2',
          sourceDiskId: '/SUBSCRIPTIONS/S1/DISKS/ALIVE',
          sizeGb: 128,
          location: 'eastus',
        },
      ],
      new Set(['/subscriptions/s1/disks/alive'])
    );

    expect(result.findings).toEqual([]);
  });
});

describe('emptyAppServicePlans', () => {
  it('flags a plan hosting no apps', () => {
    const result = emptyAppServicePlans([
      { id: '/subscriptions/s1/plans/plan-1', name: 'plan-1', numberOfSites: 0, sku: 'P1v3', location: 'eastus' },
    ]);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].detail).toContain('P1v3');
  });

  it('ignores a plan hosting apps', () => {
    const result = emptyAppServicePlans([
      { id: '/subscriptions/s1/plans/plan-2', name: 'plan-2', numberOfSites: 2, sku: 'P1v3', location: 'eastus' },
    ]);

    expect(result.findings).toEqual([]);
  });
});

describe('emptyBackendPoolLoadBalancers', () => {
  it('flags a load balancer with no backend addresses', () => {
    const result = emptyBackendPoolLoadBalancers([
      { id: '/subscriptions/s1/lb/lb-1', name: 'lb-1', backendAddressCount: 0, sku: 'Standard', location: 'eastus' },
    ]);

    expect(result.findings).toHaveLength(1);
  });

  it('ignores a load balancer with backends', () => {
    const result = emptyBackendPoolLoadBalancers([
      { id: '/subscriptions/s1/lb/lb-2', name: 'lb-2', backendAddressCount: 4, sku: 'Standard', location: 'eastus' },
    ]);

    expect(result.findings).toEqual([]);
  });
});

describe('orphanedNetworkInterfaces', () => {
  it('flags a NIC attached to nothing', () => {
    const result = orphanedNetworkInterfaces([
      { id: '/subscriptions/s1/nics/nic-1', name: 'nic-1', hasVirtualMachine: false, location: 'eastus' },
    ]);

    expect(result.findings).toHaveLength(1);
  });

  it('ignores a NIC attached to a VM', () => {
    const result = orphanedNetworkInterfaces([
      { id: '/subscriptions/s1/nics/nic-2', name: 'nic-2', hasVirtualMachine: true, location: 'eastus' },
    ]);

    expect(result.findings).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest lib/azure/costLeakage.test.ts`
Expected: FAIL — `Cannot find module './costLeakage'`

- [ ] **Step 3: Write the implementation**

Create `lib/azure/costLeakage.ts`:

```ts
import { okCheck } from '@/lib/findings';
import type { CheckResult, Finding } from '@/lib/types';

export interface DiskInput {
  id: string;
  name: string;
  diskState: string | null;
  sizeGb: number | null;
  location: string | null;
}

export interface PublicIpInput {
  id: string;
  name: string;
  ipAddress: string | null;
  hasIpConfiguration: boolean;
  location: string | null;
}

export interface VmInput {
  id: string;
  name: string;
  powerState: string | null;
  location: string | null;
}

export interface SnapshotInput {
  id: string;
  name: string;
  sourceDiskId: string | null;
  sizeGb: number | null;
  location: string | null;
}

export interface AppServicePlanInput {
  id: string;
  name: string;
  numberOfSites: number;
  sku: string | null;
  location: string | null;
}

export interface LoadBalancerInput {
  id: string;
  name: string;
  backendAddressCount: number;
  sku: string | null;
  location: string | null;
}

export interface NetworkInterfaceInput {
  id: string;
  name: string;
  hasVirtualMachine: boolean;
  location: string | null;
}

function leak(resourceId: string, resourceName: string, region: string | null, detail: string): Finding {
  return { severity: 'low', resourceId, resourceName, region, detail, monthlyCost: null };
}

export function unattachedDisks(disks: readonly DiskInput[]): CheckResult {
  const findings = disks
    // Only 'Unattached' is waste. 'Reserved', 'ActiveUpload' and friends are
    // transient states in the middle of an operation.
    .filter((disk) => disk.diskState === 'Unattached')
    .map((disk) =>
      leak(
        disk.id,
        disk.name,
        disk.location,
        `Managed disk ${disk.name} (${disk.sizeGb ?? '?'} GB) is not attached to a VM and bills for its full provisioned size.`
      )
    );

  return okCheck('unattached-managed-disks', 'Unattached managed disks', 'builtin', findings);
}

export function unassociatedPublicIps(addresses: readonly PublicIpInput[]): CheckResult {
  const findings = addresses
    .filter((address) => !address.hasIpConfiguration)
    .map((address) =>
      leak(
        address.id,
        address.name,
        address.location,
        `Public IP ${address.name}${address.ipAddress ? ` (${address.ipAddress})` : ''} is reserved but not associated with any resource.`
      )
    );

  return okCheck('unassociated-public-ips', 'Unassociated public IPs', 'builtin', findings);
}

export function stoppedNotDeallocatedVms(vms: readonly VmInput[]): CheckResult {
  const findings = vms
    // 'PowerState/stopped' still bills full compute; only
    // 'PowerState/deallocated' releases the hardware and stops the meter.
    // This is the distinction most customers do not know exists.
    .filter((vm) => vm.powerState === 'PowerState/stopped')
    .map((vm) =>
      leak(
        vm.id,
        vm.name,
        vm.location,
        `VM ${vm.name} is stopped but not deallocated, so Azure still bills full compute for it. Deallocate it to stop the charge.`
      )
    );

  return okCheck('stopped-not-deallocated-vms', 'VMs stopped but still billing', 'builtin', findings);
}

export function orphanedSnapshots(
  snapshots: readonly SnapshotInput[],
  existingDiskIds: ReadonlySet<string>
): CheckResult {
  // ARM returns resource IDs with inconsistent casing between services, so
  // the comparison set is normalized rather than trusted as-is.
  const normalized = new Set([...existingDiskIds].map((id) => id.toLowerCase()));

  const findings = snapshots
    .filter((snapshot) => snapshot.sourceDiskId && !normalized.has(snapshot.sourceDiskId.toLowerCase()))
    .map((snapshot) =>
      leak(
        snapshot.id,
        snapshot.name,
        snapshot.location,
        `Snapshot of a disk that no longer exists (${snapshot.sizeGb ?? '?'} GB).`
      )
    );

  return okCheck('orphaned-snapshots', 'Snapshots of deleted disks', 'builtin', findings);
}

export function emptyAppServicePlans(plans: readonly AppServicePlanInput[]): CheckResult {
  const findings = plans
    .filter((plan) => plan.numberOfSites === 0)
    .map((plan) =>
      leak(
        plan.id,
        plan.name,
        plan.location,
        `App Service plan ${plan.name} (${plan.sku ?? 'unknown SKU'}) hosts no apps but bills for its reserved capacity.`
      )
    );

  return okCheck('empty-app-service-plans', 'App Service plans with no apps', 'builtin', findings);
}

export function emptyBackendPoolLoadBalancers(loadBalancers: readonly LoadBalancerInput[]): CheckResult {
  const findings = loadBalancers
    .filter((loadBalancer) => loadBalancer.backendAddressCount === 0)
    .map((loadBalancer) =>
      leak(
        loadBalancer.id,
        loadBalancer.name,
        loadBalancer.location,
        `Load balancer ${loadBalancer.name} (${loadBalancer.sku ?? 'unknown SKU'}) has an empty backend pool.`
      )
    );

  return okCheck('empty-backend-load-balancers', 'Load balancers with empty backend pools', 'builtin', findings);
}

export function orphanedNetworkInterfaces(interfaces: readonly NetworkInterfaceInput[]): CheckResult {
  const findings = interfaces
    .filter((nic) => !nic.hasVirtualMachine)
    .map((nic) =>
      leak(
        nic.id,
        nic.name,
        nic.location,
        `Network interface ${nic.name} is not attached to a VM. It is usually left behind when a VM is deleted, and can hold a public IP allocated alongside it.`
      )
    );

  return okCheck('orphaned-network-interfaces', 'Orphaned network interfaces', 'builtin', findings);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest lib/azure/costLeakage.test.ts`
Expected: PASS, 15 tests

- [ ] **Step 5: Commit**

```bash
git add lib/azure/costLeakage.ts lib/azure/costLeakage.test.ts
git commit -m "Add Azure cost leakage detection rules"
```

---

### Task 12: Azure cost leakage route and sub-tab

**Files:**
- Create: `app/api/azure/cost-leakage/route.ts`
- Modify: `components/shell/AppShell.tsx` (azure sub-tab union, wide-view predicate, trigger, render chain)
- Test: `components/shell/AppShell.test.tsx`

**Interfaces:**
- Consumes: every rule from `@/lib/azure/costLeakage`; `fetchCostsForResources`, `lookupCost` from `@/lib/findingCosts`; `unavailableCheck` from `@/lib/findings`
- Produces: `GET /api/azure/cost-leakage?companyId=&credentialId=&periodId=` returning `FindingsResponse`; the Azure tab renders a `Cost Leakage` trigger

- [ ] **Step 1: Create the route**

Create `app/api/azure/cost-leakage/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { ClientSecretCredential } from '@azure/identity';
import { ComputeManagementClient } from '@azure/arm-compute';
import { NetworkManagementClient } from '@azure/arm-network';
import { WebSiteManagementClient } from '@azure/arm-appservice';
import { requireCompanyAccess } from '@/lib/admin-guard';
import { createAdminClient } from '@/lib/supabase/admin';
import { decryptCredentials } from '@/lib/cloudCredentialsCrypto';
import { unavailableCheck } from '@/lib/findings';
import { fetchCostsForResources, lookupCost } from '@/lib/findingCosts';
import {
  unattachedDisks,
  unassociatedPublicIps,
  stoppedNotDeallocatedVms,
  orphanedSnapshots,
  emptyAppServicePlans,
  emptyBackendPoolLoadBalancers,
  orphanedNetworkInterfaces,
} from '@/lib/azure/costLeakage';
import type { CheckResult, FindingsResponse } from '@/lib/types';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Unknown error.';
}

// Azure returns 403 with a long ARM message when the service principal is
// missing a role. Naming the role turns a support ticket into a two-minute fix.
function permissionHint(err: unknown): string {
  const message = errorMessage(err);
  const status = (err as { statusCode?: number })?.statusCode;
  if (status === 403) {
    return `${message} Grant the service principal the Reader role on this subscription.`;
  }
  return message;
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
  const periodId = request.nextUrl.searchParams.get('periodId');
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
  const compute = new ComputeManagementClient(credential, subscriptionId);
  const network = new NetworkManagementClient(credential, subscriptionId);
  const web = new WebSiteManagementClient(credential, subscriptionId);

  const checks: CheckResult[] = [];

  // Disks are read once: the unattached rule needs them, and the snapshot
  // rule needs their IDs to tell which snapshots are orphaned.
  let diskRows: { id: string; name: string; diskState: string | null; sizeGb: number | null; location: string | null }[] | null =
    null;
  let diskError: string | null = null;
  try {
    diskRows = [];
    for await (const disk of compute.disks.list()) {
      diskRows.push({
        id: disk.id ?? '',
        name: disk.name ?? '',
        diskState: disk.diskState ?? null,
        sizeGb: disk.diskSizeGB ?? null,
        location: disk.location ?? null,
      });
    }
  } catch (err) {
    diskRows = null;
    diskError = permissionHint(err);
  }

  checks.push(
    diskRows
      ? unattachedDisks(diskRows)
      : unavailableCheck(
          'unattached-managed-disks',
          'Unattached managed disks',
          'builtin',
          `Could not list managed disks: ${diskError}`
        )
  );

  checks.push(
    await runCheck('unassociated-public-ips', 'Unassociated public IPs', async () => {
      const rows = [];
      for await (const address of network.publicIPAddresses.listAll()) {
        rows.push({
          id: address.id ?? '',
          name: address.name ?? '',
          ipAddress: address.ipAddress ?? null,
          hasIpConfiguration: Boolean(address.ipConfiguration),
          location: address.location ?? null,
        });
      }
      return unassociatedPublicIps(rows);
    })
  );

  checks.push(
    await runCheck('stopped-not-deallocated-vms', 'VMs stopped but still billing', async () => {
      const rows = [];
      // expand: 'instanceView' returns the power state inline; without it
      // this needs one extra call per VM.
      for await (const vm of compute.virtualMachines.listAll({ expand: 'instanceView' })) {
        const powerState =
          vm.instanceView?.statuses?.find((status) => status.code?.startsWith('PowerState/'))?.code ?? null;
        rows.push({
          id: vm.id ?? '',
          name: vm.name ?? '',
          powerState,
          location: vm.location ?? null,
        });
      }
      return stoppedNotDeallocatedVms(rows);
    })
  );

  checks.push(
    await runCheck('orphaned-snapshots', 'Snapshots of deleted disks', async () => {
      if (!diskRows) throw new Error('Could not list managed disks, which is needed to tell which snapshots are orphaned.');
      const existingDiskIds = new Set(diskRows.map((disk) => disk.id));
      const rows = [];
      for await (const snapshot of compute.snapshots.list()) {
        rows.push({
          id: snapshot.id ?? '',
          name: snapshot.name ?? '',
          sourceDiskId: snapshot.creationData?.sourceResourceId ?? null,
          sizeGb: snapshot.diskSizeGB ?? null,
          location: snapshot.location ?? null,
        });
      }
      return orphanedSnapshots(rows, existingDiskIds);
    })
  );

  checks.push(
    await runCheck('empty-app-service-plans', 'App Service plans with no apps', async () => {
      const rows = [];
      for await (const plan of web.appServicePlans.list()) {
        rows.push({
          id: plan.id ?? '',
          name: plan.name ?? '',
          numberOfSites: plan.numberOfSites ?? 0,
          sku: plan.sku?.name ?? null,
          location: plan.location ?? null,
        });
      }
      return emptyAppServicePlans(rows);
    })
  );

  checks.push(
    await runCheck('empty-backend-load-balancers', 'Load balancers with empty backend pools', async () => {
      const rows = [];
      for await (const loadBalancer of network.loadBalancers.listAll()) {
        const backendAddressCount = (loadBalancer.backendAddressPools ?? []).reduce(
          (total, pool) => total + (pool.loadBalancerBackendAddresses?.length ?? pool.backendIPConfigurations?.length ?? 0),
          0
        );
        rows.push({
          id: loadBalancer.id ?? '',
          name: loadBalancer.name ?? '',
          backendAddressCount,
          sku: loadBalancer.sku?.name ?? null,
          location: loadBalancer.location ?? null,
        });
      }
      return emptyBackendPoolLoadBalancers(rows);
    })
  );

  checks.push(
    await runCheck('orphaned-network-interfaces', 'Orphaned network interfaces', async () => {
      const rows = [];
      for await (const nic of network.networkInterfaces.listAll()) {
        rows.push({
          id: nic.id ?? '',
          name: nic.name ?? '',
          hasVirtualMachine: Boolean(nic.virtualMachine?.id),
          location: nic.location ?? null,
        });
      }
      return orphanedNetworkInterfaces(rows);
    })
  );

  try {
    const resourceIds = checks.flatMap((check) => check.findings.map((finding) => finding.resourceId));
    const costs = await fetchCostsForResources(adminClient, periodId, 'azure', resourceIds);
    for (const check of checks) {
      for (const finding of check.findings) {
        finding.monthlyCost = lookupCost(costs, finding.resourceId);
      }
    }
  } catch (err) {
    console.error('Failed to join Azure leakage findings to billing data:', err);
  }

  return NextResponse.json({
    connected: true,
    // Azure resources span locations, so there is no single region for the header.
    region: null,
    fetchedAt: new Date().toISOString(),
    checks,
  } satisfies FindingsResponse);
}
```

- [ ] **Step 2: Write the failing AppShell test**

Append to `components/shell/AppShell.test.tsx`:

```tsx
it('shows a Cost Leakage sub-tab under Azure', async () => {
  renderAppShell();

  await userEvent.click(screen.getByRole('tab', { name: 'Azure' }));

  expect(screen.getByRole('tab', { name: 'Cost Leakage' })).toBeInTheDocument();
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx jest components/shell/AppShell.test.tsx -t "Cost Leakage sub-tab under Azure"`
Expected: FAIL — unable to find a tab named "Cost Leakage" on the Azure tab

- [ ] **Step 4: Widen the Azure sub-tab state**

Replace the `azureSubTab` declaration:

```tsx
const [azureSubTab, setAzureSubTab] = useState<'overview' | 'resources' | 'users' | 'costLeakage'>('overview');
```

Update the `onValueChange` cast on the Azure `Tabs` element to the same union, and extend the `isWideCloudView` Azure clause:

```tsx
(activeTab === 'azure' &&
  (azureSubTab === 'resources' || azureSubTab === 'users' || azureSubTab === 'costLeakage'));
```

- [ ] **Step 5: Add the trigger and the render branch**

Add the trigger after the Users trigger:

```tsx
<TabsTrigger value="costLeakage">Cost Leakage</TabsTrigger>
```

And replace the Azure render chain's final `else`:

```tsx
) : azureSubTab === 'users' ? (
  <AzureUsersTab companyId={effectiveCompanyId} />
) : (
  <FindingsTab
    companyId={effectiveCompanyId}
    periodId={periodIdForReports}
    provider="azure"
    kind="cost-leakage"
  />
)}
```

- [ ] **Step 6: Run the tests, type check, and lint**

Run: `npm test && npx tsc --noEmit && npm run lint`
Expected: all suites pass, no type errors, no lint errors

- [ ] **Step 7: Commit**

```bash
git add app/api/azure/cost-leakage/route.ts components/shell/AppShell.tsx components/shell/AppShell.test.tsx
git commit -m "Add Azure Cost Leakage route and sub-tab"
```

---

### Task 13: Built-in Azure security rules

**Files:**
- Create: `lib/azure/securityChecks.ts`
- Test: `lib/azure/securityChecks.test.ts`

**Interfaces:**
- Consumes: `okCheck` from `@/lib/findings`; `CheckResult`, `Finding`, `FindingSeverity` from `@/lib/types`
- Produces: constant `SENSITIVE_PORTS`; input interfaces `NsgInput`, `SqlServerInput`, `StorageAccountInput`, `EntraUserInput`, `AppServiceInput`; rules `openNsgRules`, `openSqlFirewallRules`, `publicBlobStorage`, `sqlPublicNetworkAccess`, `entraUsersWithoutMfa`, `insecureStorageTransport`, `appServiceNotHttpsOnly`

Azure NSG rules express ports as strings (`"22"`, `"3000-6000"`, `"*"`) and sources as either a single `sourceAddressPrefix` or a `sourceAddressPrefixes` array, with `"*"`, `"Internet"`, and `"0.0.0.0/0"` all meaning the public internet. Parsing that correctly is the bulk of this task.

- [ ] **Step 1: Write the failing test**

Create `lib/azure/securityChecks.test.ts`:

```ts
import {
  openNsgRules,
  openSqlFirewallRules,
  publicBlobStorage,
  sqlPublicNetworkAccess,
  entraUsersWithoutMfa,
  insecureStorageTransport,
  appServiceNotHttpsOnly,
} from './securityChecks';

describe('openNsgRules', () => {
  function nsg(rule: Record<string, unknown>) {
    return [
      {
        id: '/subscriptions/s1/nsg/nsg-1',
        name: 'nsg-1',
        location: 'eastus',
        rules: [
          {
            name: 'rule-1',
            direction: 'Inbound',
            access: 'Allow',
            protocol: 'Tcp',
            destinationPortRanges: ['22'],
            sourceAddressPrefixes: ['*'],
            ...rule,
          },
        ],
      },
    ];
  }

  it('flags SSH open to any source', () => {
    const result = openNsgRules(nsg({}));

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].severity).toBe('critical');
    expect(result.findings[0].detail).toContain('22');
  });

  it('treats the Internet service tag as public', () => {
    const result = openNsgRules(nsg({ sourceAddressPrefixes: ['Internet'] }));

    expect(result.findings).toHaveLength(1);
  });

  it('treats 0.0.0.0/0 as public', () => {
    const result = openNsgRules(nsg({ sourceAddressPrefixes: ['0.0.0.0/0'] }));

    expect(result.findings).toHaveLength(1);
  });

  it('expands a port range and flags the sensitive ports inside it', () => {
    const result = openNsgRules(nsg({ destinationPortRanges: ['3000-6000'] }));

    expect(result.findings[0].detail).toContain('3306');
    expect(result.findings[0].detail).toContain('5432');
  });

  it('treats a wildcard port as all ports', () => {
    const result = openNsgRules(nsg({ destinationPortRanges: ['*'] }));

    expect(result.findings[0].detail).toContain('all ports');
  });

  it('ignores a rule scoped to a private source', () => {
    const result = openNsgRules(nsg({ sourceAddressPrefixes: ['10.0.0.0/8'] }));

    expect(result.findings).toEqual([]);
  });

  it('ignores a Deny rule', () => {
    const result = openNsgRules(nsg({ access: 'Deny' }));

    expect(result.findings).toEqual([]);
  });

  it('ignores an outbound rule', () => {
    const result = openNsgRules(nsg({ direction: 'Outbound' }));

    expect(result.findings).toEqual([]);
  });

  it('ignores a non-sensitive port open to the internet', () => {
    const result = openNsgRules(nsg({ destinationPortRanges: ['443'] }));

    expect(result.findings).toEqual([]);
  });
});

describe('openSqlFirewallRules', () => {
  it('flags a rule spanning the whole IPv4 range', () => {
    const result = openSqlFirewallRules([
      {
        id: '/subscriptions/s1/servers/sql-1',
        name: 'sql-1',
        location: 'eastus',
        publicNetworkAccess: 'Enabled',
        firewallRules: [{ name: 'open-to-world', startIpAddress: '0.0.0.0', endIpAddress: '255.255.255.255' }],
      },
    ]);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].severity).toBe('critical');
  });

  it('does not flag the Allow-Azure-services rule, which is 0.0.0.0 to 0.0.0.0', () => {
    const result = openSqlFirewallRules([
      {
        id: '/subscriptions/s1/servers/sql-2',
        name: 'sql-2',
        location: 'eastus',
        publicNetworkAccess: 'Enabled',
        firewallRules: [{ name: 'AllowAllWindowsAzureIps', startIpAddress: '0.0.0.0', endIpAddress: '0.0.0.0' }],
      },
    ]);

    expect(result.findings).toEqual([]);
  });

  it('ignores a narrowly scoped office IP rule', () => {
    const result = openSqlFirewallRules([
      {
        id: '/subscriptions/s1/servers/sql-3',
        name: 'sql-3',
        location: 'eastus',
        publicNetworkAccess: 'Enabled',
        firewallRules: [{ name: 'office', startIpAddress: '203.0.113.5', endIpAddress: '203.0.113.5' }],
      },
    ]);

    expect(result.findings).toEqual([]);
  });
});

describe('publicBlobStorage', () => {
  it('flags an account that allows public blob access', () => {
    const result = publicBlobStorage([
      {
        id: '/subscriptions/s1/storage/sa-1',
        name: 'sa-1',
        location: 'eastus',
        allowBlobPublicAccess: true,
        httpsOnly: true,
        minimumTlsVersion: 'TLS1_2',
      },
    ]);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].severity).toBe('critical');
  });

  it('ignores an account with public blob access disabled', () => {
    const result = publicBlobStorage([
      {
        id: '/subscriptions/s1/storage/sa-2',
        name: 'sa-2',
        location: 'eastus',
        allowBlobPublicAccess: false,
        httpsOnly: true,
        minimumTlsVersion: 'TLS1_2',
      },
    ]);

    expect(result.findings).toEqual([]);
  });
});

describe('sqlPublicNetworkAccess', () => {
  it('flags a server reachable over the public endpoint', () => {
    const result = sqlPublicNetworkAccess([
      {
        id: '/subscriptions/s1/servers/sql-4',
        name: 'sql-4',
        location: 'eastus',
        publicNetworkAccess: 'Enabled',
        firewallRules: [],
      },
    ]);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].severity).toBe('high');
  });

  it('ignores a server restricted to private endpoints', () => {
    const result = sqlPublicNetworkAccess([
      {
        id: '/subscriptions/s1/servers/sql-5',
        name: 'sql-5',
        location: 'eastus',
        publicNetworkAccess: 'Disabled',
        firewallRules: [],
      },
    ]);

    expect(result.findings).toEqual([]);
  });
});

describe('entraUsersWithoutMfa', () => {
  it('flags an enabled user with no MFA method registered', () => {
    const result = entraUsersWithoutMfa([
      { id: 'user-1', displayName: 'Jane Doe', userPrincipalName: 'jane@example.com', accountEnabled: true, mfaRegistered: false },
    ]);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].resourceName).toBe('jane@example.com');
  });

  it('ignores a user with MFA registered', () => {
    const result = entraUsersWithoutMfa([
      { id: 'user-2', displayName: 'Safe', userPrincipalName: 'safe@example.com', accountEnabled: true, mfaRegistered: true },
    ]);

    expect(result.findings).toEqual([]);
  });

  it('ignores a disabled account, which cannot sign in at all', () => {
    const result = entraUsersWithoutMfa([
      { id: 'user-3', displayName: 'Gone', userPrincipalName: 'gone@example.com', accountEnabled: false, mfaRegistered: false },
    ]);

    expect(result.findings).toEqual([]);
  });
});

describe('insecureStorageTransport', () => {
  it('flags an account that allows plain HTTP', () => {
    const result = insecureStorageTransport([
      {
        id: '/subscriptions/s1/storage/sa-3',
        name: 'sa-3',
        location: 'eastus',
        allowBlobPublicAccess: false,
        httpsOnly: false,
        minimumTlsVersion: 'TLS1_2',
      },
    ]);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].detail).toContain('HTTP');
  });

  it('flags an account still accepting TLS 1.0', () => {
    const result = insecureStorageTransport([
      {
        id: '/subscriptions/s1/storage/sa-4',
        name: 'sa-4',
        location: 'eastus',
        allowBlobPublicAccess: false,
        httpsOnly: true,
        minimumTlsVersion: 'TLS1_0',
      },
    ]);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].detail).toContain('TLS1_0');
  });

  it('ignores an HTTPS-only account on TLS 1.2', () => {
    const result = insecureStorageTransport([
      {
        id: '/subscriptions/s1/storage/sa-5',
        name: 'sa-5',
        location: 'eastus',
        allowBlobPublicAccess: false,
        httpsOnly: true,
        minimumTlsVersion: 'TLS1_2',
      },
    ]);

    expect(result.findings).toEqual([]);
  });
});

describe('appServiceNotHttpsOnly', () => {
  it('flags an app that accepts plain HTTP', () => {
    const result = appServiceNotHttpsOnly([
      { id: '/subscriptions/s1/sites/app-1', name: 'app-1', location: 'eastus', httpsOnly: false },
    ]);

    expect(result.findings).toHaveLength(1);
  });

  it('ignores an HTTPS-only app', () => {
    const result = appServiceNotHttpsOnly([
      { id: '/subscriptions/s1/sites/app-2', name: 'app-2', location: 'eastus', httpsOnly: true },
    ]);

    expect(result.findings).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest lib/azure/securityChecks.test.ts`
Expected: FAIL — `Cannot find module './securityChecks'`

- [ ] **Step 3: Write the implementation**

Create `lib/azure/securityChecks.ts`:

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest lib/azure/securityChecks.test.ts`
Expected: PASS, 23 tests

- [ ] **Step 5: Commit**

```bash
git add lib/azure/securityChecks.ts lib/azure/securityChecks.test.ts
git commit -m "Add built-in Azure security check rules"
```

---

### Task 14: Defender for Cloud availability and normalization

**Files:**
- Create: `lib/azure/defender.ts`
- Test: `lib/azure/defender.test.ts`

**Interfaces:**
- Consumes: `okCheck` from `@/lib/findings`; `CheckResult`, `Finding`, `FindingSeverity` from `@/lib/types`
- Produces: `type NativeAvailability` (same shape as the AWS one); `classifyDefenderError(err: unknown): NativeAvailability`; `DefenderAssessmentInput`; `normalizeDefenderAssessments(assessments: readonly DefenderAssessmentInput[]): CheckResult[]`; `mapDefenderSeverity(severity: string | null): FindingSeverity`

Azure signals "Defender is not turned on" differently from AWS. There is no single exception: the subscription may return an empty assessment list, or an ARM error whose `code` is `SubscriptionNotRegistered` / `MissingSubscriptionRegistration`. A 403 means the service principal lacks `Security Reader` — a real problem worth reporting. Everything else is reported too, for the same reason as the AWS side: only a positive not-enabled signal earns silence.

Defender assessments include passing ones. Only assessments whose status code is `Unhealthy` belong on the grid.

- [ ] **Step 1: Write the failing test**

Create `lib/azure/defender.test.ts`:

```ts
import { classifyDefenderError, normalizeDefenderAssessments, mapDefenderSeverity } from './defender';

function restError(statusCode: number, code?: string) {
  const err = new Error(code ?? `HTTP ${statusCode}`) as Error & { statusCode?: number; code?: string };
  err.statusCode = statusCode;
  if (code) err.code = code;
  return err;
}

describe('classifyDefenderError', () => {
  it('treats SubscriptionNotRegistered as the service not being enabled', () => {
    expect(classifyDefenderError(restError(409, 'SubscriptionNotRegistered'))).toEqual({ kind: 'not-enabled' });
  });

  it('treats MissingSubscriptionRegistration as the service not being enabled', () => {
    expect(classifyDefenderError(restError(409, 'MissingSubscriptionRegistration'))).toEqual({ kind: 'not-enabled' });
  });

  it('treats a 403 as a missing role worth reporting', () => {
    const result = classifyDefenderError(restError(403));

    expect(result.kind).toBe('unavailable');
    expect(result.kind === 'unavailable' && result.reason).toContain('Security Reader');
  });

  it('treats an unrecognized error as unavailable rather than silently falling back', () => {
    const result = classifyDefenderError(new Error('getaddrinfo ENOTFOUND'));

    expect(result.kind).toBe('unavailable');
    expect(result.kind === 'unavailable' && result.reason).toContain('ENOTFOUND');
  });
});

describe('mapDefenderSeverity', () => {
  it('maps High to high and Medium to medium', () => {
    expect(mapDefenderSeverity('High')).toBe('high');
    expect(mapDefenderSeverity('Medium')).toBe('medium');
  });

  it('maps Low to low', () => {
    expect(mapDefenderSeverity('Low')).toBe('low');
  });

  it('defaults an unknown severity to medium', () => {
    expect(mapDefenderSeverity(null)).toBe('medium');
    expect(mapDefenderSeverity('Nonsense')).toBe('medium');
  });
});

describe('normalizeDefenderAssessments', () => {
  const base = {
    id: '/subscriptions/s1/providers/Microsoft.Security/assessments/a1',
    assessmentKey: 'storage-public-access',
    displayName: 'Storage accounts should restrict public access',
    description: 'Public access exposes container contents anonymously.',
    severity: 'High',
    statusCode: 'Unhealthy',
    resourceId: '/subscriptions/s1/storage/sa-1',
    resourceName: 'sa-1',
  };

  it('groups assessments sharing a key into one check', () => {
    const checks = normalizeDefenderAssessments([
      base,
      { ...base, id: 'a2', resourceId: '/subscriptions/s1/storage/sa-2', resourceName: 'sa-2' },
    ]);

    expect(checks).toHaveLength(1);
    expect(checks[0].findings).toHaveLength(2);
    expect(checks[0].title).toBe('Storage accounts should restrict public access');
  });

  it('drops healthy assessments, which are passing controls rather than findings', () => {
    const checks = normalizeDefenderAssessments([{ ...base, statusCode: 'Healthy' }]);

    expect(checks).toEqual([]);
  });

  it('drops not-applicable assessments', () => {
    const checks = normalizeDefenderAssessments([{ ...base, statusCode: 'NotApplicable' }]);

    expect(checks).toEqual([]);
  });

  it('marks normalized checks as native', () => {
    const checks = normalizeDefenderAssessments([base]);

    expect(checks[0].source).toBe('native');
    expect(checks[0].status).toBe('ok');
  });

  it('carries severity, resource and description onto each finding', () => {
    const checks = normalizeDefenderAssessments([base]);

    expect(checks[0].findings[0]).toMatchObject({
      severity: 'high',
      resourceId: '/subscriptions/s1/storage/sa-1',
      resourceName: 'sa-1',
      detail: 'Public access exposes container contents anonymously.',
      monthlyCost: null,
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest lib/azure/defender.test.ts`
Expected: FAIL — `Cannot find module './defender'`

- [ ] **Step 3: Write the implementation**

Create `lib/azure/defender.ts`:

```ts
import { okCheck } from '@/lib/findings';
import type { CheckResult, Finding, FindingSeverity } from '@/lib/types';

export type NativeAvailability = { kind: 'not-enabled' } | { kind: 'unavailable'; reason: string };

// Assessments Defender reports as passing or irrelevant are not findings.
const FINDING_STATUS_CODES = ['Unhealthy'];

const NOT_REGISTERED_CODES = ['SubscriptionNotRegistered', 'MissingSubscriptionRegistration'];

export interface DefenderAssessmentInput {
  id: string;
  /** The control that produced the assessment — assessments group by it. */
  assessmentKey: string;
  displayName: string;
  description: string;
  severity: string | null;
  statusCode: string | null;
  resourceId: string;
  resourceName: string;
}

function errorCode(err: unknown): string | undefined {
  return (err as { code?: string })?.code;
}

function statusCode(err: unknown): number | undefined {
  return (err as { statusCode?: number })?.statusCode;
}

/**
 * Decides whether a Defender failure means "not turned on" or "turned on but
 * we cannot see it".
 *
 * Only an explicit not-registered code is treated as not-enabled. A 403 means
 * the service principal is missing Security Reader, which is a fixable
 * problem the customer should be told about rather than a reason to go quiet.
 */
export function classifyDefenderError(err: unknown): NativeAvailability {
  const code = errorCode(err);
  if (code && NOT_REGISTERED_CODES.includes(code)) {
    return { kind: 'not-enabled' };
  }

  if (statusCode(err) === 403) {
    return {
      kind: 'unavailable',
      reason:
        'Defender for Cloud is available on this subscription but the service principal was refused. Grant it the Security Reader role to see its assessments here.',
    };
  }

  const message = err instanceof Error ? err.message : String(err);
  return { kind: 'unavailable', reason: `Could not read Defender for Cloud assessments: ${message}` };
}

export function mapDefenderSeverity(severity: string | null): FindingSeverity {
  switch (severity) {
    case 'High':
      return 'high';
    case 'Low':
      return 'low';
    default:
      // 'Medium', plus anything unrecognized. Defender has no 'Critical'
      // tier, so its High is the top of the scale here.
      return 'medium';
  }
}

export function normalizeDefenderAssessments(assessments: readonly DefenderAssessmentInput[]): CheckResult[] {
  const byKey = new Map<string, { title: string; findings: Finding[] }>();

  for (const assessment of assessments) {
    if (!assessment.statusCode || !FINDING_STATUS_CODES.includes(assessment.statusCode)) continue;

    const group = byKey.get(assessment.assessmentKey) ?? { title: assessment.displayName, findings: [] };
    group.findings.push({
      severity: mapDefenderSeverity(assessment.severity),
      resourceId: assessment.resourceId,
      resourceName: assessment.resourceName,
      region: null,
      detail: assessment.description,
      monthlyCost: null,
    });
    byKey.set(assessment.assessmentKey, group);
  }

  return [...byKey.entries()].map(([key, group]) => okCheck(`defender:${key}`, group.title, 'native', group.findings));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest lib/azure/defender.test.ts`
Expected: PASS, 12 tests

- [ ] **Step 5: Commit**

```bash
git add lib/azure/defender.ts lib/azure/defender.test.ts
git commit -m "Add Defender for Cloud availability classification and normalization"
```

---

### Task 15: Azure security checks route and sub-tab

**Files:**
- Create: `app/api/azure/security-checks/route.ts`
- Modify: `components/shell/AppShell.tsx` (azure sub-tab union, wide-view predicate, trigger, render chain)
- Test: `components/shell/AppShell.test.tsx`

**Interfaces:**
- Consumes: every rule from `@/lib/azure/securityChecks`; `classifyDefenderError`, `normalizeDefenderAssessments` from `@/lib/azure/defender`; `unavailableCheck` from `@/lib/findings`; `mapWithConcurrency` from `@/lib/concurrency`
- Produces: `GET /api/azure/security-checks?companyId=&credentialId=` returning `FindingsResponse`; the Azure tab renders a `Security Checks` trigger

**Correction to the spec.** The spec says the Entra MFA check reuses the Graph `User.Read.All` permission the Users tab already needs. That is not sufficient: reading which authentication methods a user has registered requires `UserAuthenticationMethod.Read.All`, a separate application permission with its own admin consent. This route therefore treats the MFA check as its own permission boundary — a 403 from the authentication-methods endpoint marks only that one check unavailable, naming the permission, while every other Azure check still renders. (The tenant-wide `userRegistrationDetails` report would answer the same question in one call instead of one per user, but it requires an Entra ID P1 licence, so the per-user endpoint is the portable choice.) Task 17 updates the spec to match.

- [ ] **Step 1: Create the route**

Create `app/api/azure/security-checks/route.ts`:

```ts
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
  type SqlServerInput,
  type StorageAccountInput,
} from '@/lib/azure/securityChecks';
import type { CheckResult, FindingsResponse } from '@/lib/types';

const MFA_LOOKUP_CONCURRENCY = 8;

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
      assessments.push({
        id: assessment.id ?? '',
        assessmentKey: assessment.name ?? '',
        displayName: assessment.displayName ?? 'Defender assessment',
        description: assessment.metadata?.description ?? '',
        severity: assessment.metadata?.severity ?? null,
        statusCode: assessment.status?.code ?? null,
        resourceId: assessment.resourceDetails?.id ?? assessment.id ?? '',
        resourceName: (assessment.resourceDetails?.id ?? '').split('/').pop() ?? '',
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
          rules: (nsg.securityRules ?? []).map((rule) => ({
            name: rule.name ?? '',
            direction: rule.direction ?? null,
            access: rule.access ?? null,
            protocol: rule.protocol ?? null,
            // ARM populates either the singular field or the plural array,
            // never both, so each rule's values are merged from both.
            destinationPortRanges: [
              ...(rule.destinationPortRange ? [rule.destinationPortRange] : []),
              ...(rule.destinationPortRanges ?? []),
            ],
            sourceAddressPrefixes: [
              ...(rule.sourceAddressPrefix ? [rule.sourceAddressPrefix] : []),
              ...(rule.sourceAddressPrefixes ?? []),
            ],
          })),
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
    sqlServers = await mapWithConcurrency(servers, MFA_LOOKUP_CONCURRENCY, async (server) => {
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

      const rows = await mapWithConcurrency(users, MFA_LOOKUP_CONCURRENCY, async (user) => {
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
```

- [ ] **Step 2: Write the failing AppShell test**

Append to `components/shell/AppShell.test.tsx`:

```tsx
it('shows a Security Checks sub-tab under Azure', async () => {
  renderAppShell();

  await userEvent.click(screen.getByRole('tab', { name: 'Azure' }));

  expect(screen.getByRole('tab', { name: 'Security Checks' })).toBeInTheDocument();
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx jest components/shell/AppShell.test.tsx -t "Security Checks sub-tab under Azure"`
Expected: FAIL — unable to find a tab named "Security Checks" on the Azure tab

- [ ] **Step 4: Widen the Azure sub-tab state**

Replace the `azureSubTab` declaration:

```tsx
const [azureSubTab, setAzureSubTab] = useState<
  'overview' | 'resources' | 'users' | 'securityChecks' | 'costLeakage'
>('overview');
```

Update the `onValueChange` cast on the Azure `Tabs` element to the same union, and add `azureSubTab === 'securityChecks'` to the `isWideCloudView` Azure clause.

- [ ] **Step 5: Add the trigger and the render branch**

Add the trigger before the Cost Leakage one:

```tsx
<TabsTrigger value="securityChecks">Security Checks</TabsTrigger>
```

And add a branch to the Azure render chain, before the final `else`:

```tsx
) : azureSubTab === 'securityChecks' ? (
  <FindingsTab
    companyId={effectiveCompanyId}
    periodId={periodIdForReports}
    provider="azure"
    kind="security-checks"
  />
) : (
```

- [ ] **Step 6: Run the tests, type check, and lint**

Run: `npm test && npx tsc --noEmit && npm run lint`
Expected: all suites pass, no type errors, no lint errors

- [ ] **Step 7: Commit**

```bash
git add app/api/azure/security-checks/route.ts components/shell/AppShell.tsx components/shell/AppShell.test.tsx
git commit -m "Add Azure Security Checks route and sub-tab"
```

---

### Task 16: Full verification and live check

**Files:**
- No new files. This task runs the gates and verifies the feature against real accounts.

- [ ] **Step 1: Run the whole suite**

Run: `npm test`
Expected: every suite passes, including the seven new ones (`lib/findings`, `lib/findingCosts`, `lib/aws/costLeakage`, `lib/aws/securityChecks`, `lib/aws/securityHub`, `lib/azure/costLeakage`, `lib/azure/securityChecks`, `lib/azure/defender`) and the two new component suites

- [ ] **Step 2: Type check and lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: no output from either

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: build succeeds and the route list includes `/api/aws/security-checks`, `/api/aws/cost-leakage`, `/api/azure/security-checks`, `/api/azure/cost-leakage`

- [ ] **Step 4: Live-check AWS against the real test connection**

Run `npm run dev`, sign in as a staff test account, and for a company with a saved AWS connection:

1. Open **AWS → Cost Leakage**. Confirm the grid renders, the account picker lists the saved connections, and Refresh re-queries.
2. Confirm that any finding matching a resource in the active period's billing data shows a dollar figure, and that unmatched ones show `—` rather than `$0.00`.
3. Open **AWS → Security Checks**. On an account without Security Hub, confirm the built-in checks render with no spurious Security Hub error. On an account with it enabled, confirm the checks are labelled "Security Hub / Defender".
4. **The critical negative test:** temporarily use a connection whose IAM policy lacks `ec2:DescribeSecurityGroups`, and confirm that check renders a visible reason rather than "No findings." A false clean bill of health is the one failure mode this feature must not have.

- [ ] **Step 5: Live-check Azure against the real test connection**

1. Open **Azure → Cost Leakage** and **Azure → Security Checks** and confirm both render.
2. Confirm any check the service principal cannot read names the role it needs — `Reader` for the ARM checks, `Security Reader` for Defender, and `UserAuthenticationMethod.Read.All` for the Entra MFA check.
3. If the app registration lacks the Graph MFA permission, confirm every other Azure check still renders and only the MFA check is marked unavailable.

- [ ] **Step 6: Rotate the test credentials**

Rotate the AWS access key and regenerate the Azure client secret used for the live check, as with prior sub-projects. Do not delete the app registration itself unless it was created solely for this test.

- [ ] **Step 7: Commit any fixes**

If the live check surfaced fixes, commit them with a message describing what the live run revealed. If nothing needed changing, there is nothing to commit — say so rather than creating an empty commit.

---

### Task 17: Reconcile the spec with what was built

**Files:**
- Modify: `docs/superpowers/specs/2026-08-27-security-checks-and-cost-leakage-design.md`

Three things diverged from the spec during implementation. The spec is the document someone reads in six months, so it gets corrected rather than left stale.

- [ ] **Step 1: Correct the Graph permission claim**

In the **Permissions** section, the Azure bullet currently says Graph `User.Read.All` "is already needed by the Users tab and is reused for the MFA check." Replace that clause with:

> Graph `User.Read.All` (already granted for the Users tab) lists the users, but reading which MFA methods each has registered additionally requires the `UserAuthenticationMethod.Read.All` application permission, granted with admin consent. Without it, only the MFA check is unavailable; every other Azure check still runs.

- [ ] **Step 2: Correct the cost join description**

In the **Cost join** section, replace "runs one Supabase query per cost-leakage request: `cost_records` filtered by `period_id` and `cloud_provider`, selecting `resource_id, cost`, summed into a `Map`" with:

> queries only the resource IDs the rules actually flagged, matching `.in('resource_id', …)` against both the original and lowercased spelling of each ID, chunked at 200 IDs per query. Scanning every line item in a period would exceed Supabase's default row cap and require paging through six figures of rows to price a handful of findings.

- [ ] **Step 3: Correct the file table**

In the **Files** section, split the two normalization modules out of the rule modules to match what was built:

| File | Purpose |
|---|---|
| `lib/aws/securityChecks.ts` | Built-in AWS security rules |
| `lib/aws/securityHub.ts` | Security Hub error classification and finding normalization |
| `lib/azure/securityChecks.ts` | Built-in Azure security rules |
| `lib/azure/defender.ts` | Defender for Cloud error classification and assessment normalization |

Also add `lib/findings.ts` (shared severity ordering and check builders) and `components/reports/FindingsGrid.module.css`, neither of which the original file table listed.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-08-27-security-checks-and-cost-leakage-design.md
git commit -m "Reconcile security and leakage spec with the built implementation"
```

---

## Self-Review

**Spec coverage.** Every spec section maps to a task: native-first fallback → Tasks 9, 10, 14, 15; the never-silently-clean rule → the `unavailable` path in Tasks 1, 5, 10, 15 and the live negative test in Task 16; real dollars → Tasks 2, 4, 12; pure-function rules → Tasks 3, 8, 11, 13; the data contract → Task 1; the file map → the File Structure table; per-check isolation and `mapWithConcurrency` reuse → Tasks 4, 10, 12, 15; permissions → the reason strings in Tasks 10, 12, 15 and the live check in Task 16; the verification plan → Task 16.

**Three deviations, each stated at the task that introduces it and corrected in the spec by Task 17:** the cost join queries flagged IDs rather than the whole period; Security Hub and Defender normalization live in their own modules; and the Entra MFA check needs a Graph permission the spec did not account for.

**Type consistency.** `CheckResult`/`Finding`/`FindingsResponse` are defined once in Task 1 and consumed unchanged everywhere. `okCheck` and `unavailableCheck` keep the same four-parameter signature in all seven rule modules. `NativeAvailability` has the same two-variant shape in `lib/aws/securityHub.ts` and `lib/azure/defender.ts`. `checkId` values are stable strings shared between the rule modules and the routes' fallback `unavailableCheck` calls — `iam-users-without-mfa`, `stale-access-keys`, `inactive-iam-users`, `public-rds-instances`, `unencrypted-rds-storage`, `open-sql-firewall-rules`, `sql-public-network-access`, `public-blob-storage`, `insecure-storage-transport`, and `unattached-managed-disks` each appear in both places with identical spelling.


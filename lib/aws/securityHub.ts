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

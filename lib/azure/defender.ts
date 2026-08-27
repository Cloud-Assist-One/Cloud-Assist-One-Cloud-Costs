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

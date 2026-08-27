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

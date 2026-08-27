import type { CheckResult, CloudProvider, Finding } from './types';
import type { SupportTopic } from './supportTopics';

export interface VerifyMessage {
  subject: string;
  body: string;
}

/** What a Verify action was raised from. */
export type VerifyOrigin = 'security-checks' | 'cost-leakage' | 'resource';

const PROVIDER_LABEL: Partial<Record<CloudProvider, string>> = {
  aws: 'AWS',
  azure: 'Azure',
  gcp: 'Google Cloud',
  snowflake: 'Snowflake',
};

function providerLabel(provider: CloudProvider): string {
  return PROVIDER_LABEL[provider] ?? provider.toUpperCase();
}

function mailto(subject: string, body: string): string {
  return `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

/**
 * The Resources and Users tabs' "is this yours?" email.
 *
 * The provider is a parameter because the original inline version hardcoded
 * "AWS", so the Azure tabs were emailing clients about an "AWS resource:
 * Virtual Machine".
 */
export function buildResourceVerifyMessage(
  provider: CloudProvider,
  resourceType: string,
  name: string
): VerifyMessage {
  return {
    subject: `Verify ${providerLabel(provider)} resource: ${resourceType} ${name}`,
    body: `Please verify this ${resourceType} "${name}" is valid and let me know what it is being used for.`,
  };
}

export function resourceVerifyMailto(
  provider: CloudProvider,
  resourceType: string,
  name: string
): string {
  const { subject, body } = buildResourceVerifyMessage(provider, resourceType, name);
  return mailto(subject, body);
}

/**
 * The Security Checks and Cost Leakage tabs' equivalent.
 *
 * A finding is not a resource: the recipient needs to know what tripped and
 * why before they can answer, so the check title and the finding's own
 * explanation travel with the question. The question itself differs by tab —
 * a security finding asks whether the exposure is deliberate, a leakage
 * finding asks whether the thing can go.
 */
export function buildFindingVerifyMessage(
  provider: CloudProvider,
  kind: 'security-checks' | 'cost-leakage',
  check: CheckResult,
  finding: Finding
): VerifyMessage {
  const label = providerLabel(provider);
  const isLeakage = kind === 'cost-leakage';

  const subject = isLeakage
    ? `Verify ${label} unused resource: ${finding.resourceName}`
    : `Verify ${label} security finding: ${finding.resourceName}`;

  const lines: string[] = [
    isLeakage
      ? 'Our cloud cost review flagged this resource as possibly unused:'
      : 'Our cloud security review flagged this resource:',
    '',
    `  Check:    ${check.title}`,
  ];

  // Severity ranks security findings against each other; every leakage
  // finding is 'low', so printing it there would be noise.
  if (!isLeakage) lines.push(`  Severity: ${finding.severity}`);

  lines.push(`  Resource: ${finding.resourceName}`);
  if (finding.region) lines.push(`  Region:   ${finding.region}`);

  // A null cost means the resource was absent from the last billing pull,
  // not that it is free. Quoting "$0.00" to a client while asking them to
  // delete something would misstate the stakes, so the line is omitted.
  if (isLeakage && finding.monthlyCost !== null) {
    lines.push(`  Cost:     $${finding.monthlyCost.toFixed(2)}/mo`);
  }

  lines.push(
    '',
    `  ${finding.detail}`,
    '',
    isLeakage ? 'Is this still needed, or can it be deleted?' : 'Is this intentional? If not, can it be restricted?'
  );

  return { subject, body: lines.join('\n') };
}

export function findingVerifyMailto(
  provider: CloudProvider,
  kind: 'security-checks' | 'cost-leakage',
  check: CheckResult,
  finding: Finding
): string {
  const { subject, body } = buildFindingVerifyMessage(provider, kind, check, finding);
  return mailto(subject, body);
}

// A finding-raised ticket carries its own topic so staff can tell it from one
// a client typed. A resource row has no finding behind it, so it files under
// the ordinary support topic rather than inventing a third finding topic.
export function ticketTopicFor(origin: VerifyOrigin): SupportTopic {
  if (origin === 'security-checks') return 'Security finding';
  if (origin === 'cost-leakage') return 'Cost leakage';
  return 'Technical cloud support';
}

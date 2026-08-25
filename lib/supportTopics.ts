// The checkbox options on the support form. Stored on the request as the
// label text itself, so a submitted ticket still reads correctly if this list
// is later reordered or edited.
export const SUPPORT_TOPICS = [
  'Understanding my cloud billing',
  'Tagging for cost center reporting',
  'S3/Azure bucket cost reduction',
  'Reduce logging costs',
  'EC2/virtual machine cost reduction',
  'Technical cloud support',
  'Other',
] as const;

export type SupportTopic = (typeof SUPPORT_TOPICS)[number];

export function isSupportTopic(value: unknown): value is SupportTopic {
  return typeof value === 'string' && (SUPPORT_TOPICS as readonly string[]).includes(value);
}

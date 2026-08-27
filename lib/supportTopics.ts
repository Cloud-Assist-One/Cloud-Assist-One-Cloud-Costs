// The checkbox options on the support form. Stored on the request as the
// label text itself, so a submitted ticket still reads correctly if this list
// is later reordered or edited.
export const SUPPORT_FORM_TOPICS = [
  'Understanding my cloud billing',
  'Tagging for cost center reporting',
  'S3/Azure bucket cost reduction',
  'Reduce logging costs',
  'EC2/virtual machine cost reduction',
  'Technical cloud support',
  'Other',
] as const;

// Topics a ticket raised from a finding carries. They are deliberately absent
// from the form: a client ticking "Security finding" on a blank form has no
// finding to attach, and the resulting ticket would tell staff nothing. Kept
// valid here so the queue can distinguish a portal-raised ticket from one
// somebody typed.
export const FINDING_TOPICS = ['Security finding', 'Cost leakage'] as const;

export const SUPPORT_TOPICS = [...SUPPORT_FORM_TOPICS, ...FINDING_TOPICS] as const;

export type SupportFormTopic = (typeof SUPPORT_FORM_TOPICS)[number];
export type SupportTopic = (typeof SUPPORT_TOPICS)[number];

export function isSupportTopic(value: unknown): value is SupportTopic {
  return typeof value === 'string' && (SUPPORT_TOPICS as readonly string[]).includes(value);
}

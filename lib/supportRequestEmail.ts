export interface SupportRequestEmailInput {
  companyName: string;
  firstName: string;
  email: string;
  phone: string | null;
  phoneExt: string | null;
  topics: string[];
  details: string | null;
}

const NOT_PROVIDED = 'Not provided';

function phoneLine(phone: string | null, phoneExt: string | null): string {
  if (!phone) return NOT_PROVIDED;
  return phoneExt ? `${phone} ext. ${phoneExt}` : phone;
}

/**
 * The plain-text notification sent when a client submits a support request.
 *
 * Kept apart from the API route so the wording is testable without a network
 * call or a Supabase session.
 */
export function buildSupportRequestEmail(input: SupportRequestEmailInput): { subject: string; text: string } {
  const { companyName, firstName, email, phone, phoneExt, topics, details } = input;

  const subject = `Support request from ${companyName} — ${firstName}`;

  const text = [
    `A new support request was submitted in the Cloud Assist One portal.`,
    ``,
    `Company: ${companyName}`,
    `Name: ${firstName}`,
    `Email: ${email}`,
    `Phone: ${phoneLine(phone, phoneExt)}`,
    ``,
    `Topics:`,
    ...topics.map((topic) => `  - ${topic}`),
    ``,
    `Details: ${details ?? NOT_PROVIDED}`,
  ].join('\n');

  return { subject, text };
}

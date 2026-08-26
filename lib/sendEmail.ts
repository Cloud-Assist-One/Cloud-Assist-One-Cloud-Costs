const RESEND_ENDPOINT = 'https://api.resend.com/emails';

// Resend can hang on a slow network, and a notification is never worth making
// the user wait on the request that triggered it.
const REQUEST_TIMEOUT_MS = 10_000;

export type SendEmailResult = { ok: true; id: string } | { ok: false; error: string };

export interface SendEmailInput {
  to: string;
  subject: string;
  text: string;
  /** Set so replying from the inbox reaches the person who wrote in. */
  replyTo?: string;
}

/**
 * Sends one transactional email through Resend's REST API.
 *
 * Called over fetch rather than the `resend` SDK so this adds no dependency.
 *
 * Never throws: every failure comes back as `ok: false`. Callers send email as
 * a side effect of work that has already succeeded (a saved support request),
 * and losing that work because a notification failed would be worse than the
 * missing notification.
 */
export async function sendEmail({ to, subject, text, replyTo }: SendEmailInput): Promise<SendEmailResult> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.SUPPORT_EMAIL_FROM;

  if (!apiKey) {
    return { ok: false, error: 'RESEND_API_KEY is not set.' };
  }
  if (!from) {
    return { ok: false, error: 'SUPPORT_EMAIL_FROM is not set.' };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject,
        text,
        ...(replyTo ? { reply_to: replyTo } : {}),
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      // Resend explains refusals (unverified domain, invalid recipient) in the
      // body, and that text is what makes a failed send diagnosable in logs.
      const body = await response.text();
      return { ok: false, error: `Resend responded ${response.status}: ${body.slice(0, 500)}` };
    }

    const body = (await response.json()) as { id?: string };
    return { ok: true, id: body.id ?? '' };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, error: reason };
  } finally {
    clearTimeout(timeout);
  }
}

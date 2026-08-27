export interface SubmitterIdentity {
  firstName: string;
  /** null when the session carries no email — the caller must refuse rather than invent one. */
  email: string | null;
}

/**
 * Who a portal-raised support ticket is from.
 *
 * The support form asks the client for their name and email. A ticket raised
 * by clicking Verify on a row has no form, so the identity comes from the
 * session instead — which also means it cannot be spoofed onto someone else.
 */
export function resolveSubmitterIdentity(
  profileFirstName: string | null,
  authEmail: string | null
): SubmitterIdentity {
  const email = authEmail?.trim() || null;
  const named = profileFirstName?.trim();
  if (named) return { firstName: named, email };

  // support_requests.first_name is NOT NULL and the staff queue renders it,
  // so an empty profile still needs something a human can read.
  const localPart = email?.split('@')[0]?.trim();
  return { firstName: localPart || 'Portal user', email };
}

import { createHash } from 'crypto';
import { invoiceAmountCents } from '@/lib/consultingRate';

export interface TimeEntryRow {
  id: string;
  entry_date: string;
  minutes_spent: number;
  description: string;
}

export interface InvoiceLine {
  entryId: string;
  amountCents: number;
  description: string;
  idempotencyKey: string;
}

export function buildInvoiceLines(entries: TimeEntryRow[], rateCents: number): InvoiceLine[] {
  return entries.map((entry) => ({
    entryId: entry.id,
    amountCents: invoiceAmountCents(entry.minutes_spent, rateCents),
    // Minutes, the unit staff actually log. Decimal hours rounded for display
    // would not reconcile with the exact cents charged on this same line.
    description: `${entry.entry_date} — ${entry.description} (${entry.minutes_spent} min)`,
    // Keyed on the entry id so that if we crash after Stripe creates the item
    // but before we stamp the row, the retry returns the same item instead of
    // billing the work twice.
    idempotencyKey: `ti_${entry.id}`,
  }));
}

/**
 * Idempotency key for stripe.invoices.create, so a retry that lands after the
 * draft invoice was created but before it was finalized/sent reuses that same
 * invoice instead of minting a second, empty one -- the entries are already
 * attached to the first draft via their own item-level idempotency keys, so a
 * fresh invoice would find nothing pending and finalize at $0 while the
 * database still marks the work as billed.
 *
 * Derived from the company id plus the exact set of entries being billed, so
 * it is stable across retries of the same billing run but distinct from any
 * other run (a different day's unbilled entries, or a different company).
 * Hashed rather than concatenated raw: Stripe caps idempotency keys at 255
 * characters, and a company with many unbilled entries could exceed that.
 */
export function buildInvoiceIdempotencyKey(companyId: string, entryIds: string[]): string {
  const sortedIds = [...entryIds].sort();
  const raw = `${companyId}:${sortedIds.join(',')}`;
  const hash = createHash('sha256').update(raw).digest('hex');
  return `inv_${hash}`;
}

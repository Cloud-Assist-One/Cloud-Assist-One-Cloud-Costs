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

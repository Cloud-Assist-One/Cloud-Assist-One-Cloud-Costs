import { buildInvoiceLines } from './consultingInvoice';

const entries = [
  { id: 'entry-1', entry_date: '2026-09-02', minutes_spent: 90, description: 'Cost review call' },
  { id: 'entry-2', entry_date: '2026-09-03', minutes_spent: 30, description: 'Tag cleanup' },
];

describe('buildInvoiceLines', () => {
  it('prices each entry in whole cents at the given rate', () => {
    const lines = buildInvoiceLines(entries, 17500);

    expect(lines[0].amountCents).toBe(26250);
    expect(lines[1].amountCents).toBe(8750);
  });

  // Minutes, not decimal hours: a rounded hours figure would not reconcile
  // with the exact cents charged on the same line.
  it('describes the line with date, work and billable minutes', () => {
    const lines = buildInvoiceLines(entries, 17500);

    expect(lines[0].description).toBe('2026-09-02 — Cost review call (90 min)');
    expect(lines[1].description).toBe('2026-09-03 — Tag cleanup (30 min)');
  });

  it('keeps the displayed minutes and the charged amount reconcilable', () => {
    // 50 minutes is the case that exposed the old decimal-hours bug.
    const lines = buildInvoiceLines(
      [{ id: 'e', entry_date: '2026-09-04', minutes_spent: 50, description: 'Advice' }],
      17500
    );

    expect(lines[0].description).toContain('(50 min)');
    expect(lines[0].amountCents).toBe(Math.round((50 / 60) * 17500));
  });

  it('derives an idempotency key from the entry id, so a retry cannot double-bill', () => {
    const lines = buildInvoiceLines(entries, 17500);

    expect(lines[0].idempotencyKey).toBe('ti_entry-1');
    expect(lines[1].idempotencyKey).toBe('ti_entry-2');
  });

  it('returns nothing for an empty list', () => {
    expect(buildInvoiceLines([], 17500)).toEqual([]);
  });
});

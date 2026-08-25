function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function monthStart(year: number, monthIndex0: number): string {
  return toIsoDate(new Date(Date.UTC(year, monthIndex0, 1)));
}

// billingMonth is always "YYYY-MM-01". rangeEnd is exclusive, matching AWS
// Cost Explorer's own TimePeriod.End semantics: a past month's rangeEnd is
// the first day of the following month (the whole month); the current
// month's rangeEnd is tomorrow (whatever AWS has accumulated so far).
export function resolvePullDateRange(billingMonth: string, today: Date): { rangeStart: string; rangeEnd: string } {
  const [yearStr, monthStr] = billingMonth.split('-');
  const year = Number(yearStr);
  const monthIndex0 = Number(monthStr) - 1;

  const currentYear = today.getUTCFullYear();
  const currentMonthIndex0 = today.getUTCMonth();
  const currentMonthStart = monthStart(currentYear, currentMonthIndex0);

  if (billingMonth > currentMonthStart) {
    throw new Error('billingMonth cannot be after the current calendar month.');
  }

  if (billingMonth === currentMonthStart) {
    const tomorrow = new Date(Date.UTC(currentYear, currentMonthIndex0, today.getUTCDate() + 1));
    return { rangeStart: billingMonth, rangeEnd: toIsoDate(tomorrow) };
  }

  const nextMonthStart = monthStart(year, monthIndex0 + 1);
  return { rangeStart: billingMonth, rangeEnd: nextMonthStart };
}

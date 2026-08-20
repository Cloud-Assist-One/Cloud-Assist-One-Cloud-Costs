export type Granularity = 'day' | 'week' | 'month';

function toISODate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function computeDateRange(granularity: Granularity, referenceDate: Date): { start: string; end: string } {
  const year = referenceDate.getUTCFullYear();
  const month = referenceDate.getUTCMonth();
  const day = referenceDate.getUTCDate();

  if (granularity === 'day') {
    const start = new Date(Date.UTC(year, month, day));
    return { start: toISODate(start), end: toISODate(start) };
  }

  if (granularity === 'week') {
    const current = new Date(Date.UTC(year, month, day));
    const dayOfWeek = current.getUTCDay(); // 0 = Sunday
    const diffToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    const monday = new Date(Date.UTC(year, month, day + diffToMonday));
    const sunday = new Date(Date.UTC(monday.getUTCFullYear(), monday.getUTCMonth(), monday.getUTCDate() + 6));
    return { start: toISODate(monday), end: toISODate(sunday) };
  }

  const firstOfMonth = new Date(Date.UTC(year, month, 1));
  const lastOfMonth = new Date(Date.UTC(year, month + 1, 0));
  return { start: toISODate(firstOfMonth), end: toISODate(lastOfMonth) };
}

export function shiftReferenceDate(granularity: Granularity, referenceDate: Date, direction: 1 | -1): Date {
  const year = referenceDate.getUTCFullYear();
  const month = referenceDate.getUTCMonth();
  const day = referenceDate.getUTCDate();

  if (granularity === 'day') {
    return new Date(Date.UTC(year, month, day + direction));
  }
  if (granularity === 'week') {
    return new Date(Date.UTC(year, month, day + direction * 7));
  }
  return new Date(Date.UTC(year, month + direction, day));
}

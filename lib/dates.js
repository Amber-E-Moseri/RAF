export function monthBounds(year, month) {
  const parsedYear = Number(year);
  const parsedMonth = Number(month);

  if (!Number.isInteger(parsedYear) || !Number.isInteger(parsedMonth) || parsedMonth < 1 || parsedMonth > 12) {
    throw new Error('year and month must describe a valid calendar month');
  }

  const start = new Date(Date.UTC(parsedYear, parsedMonth - 1, 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(parsedYear, parsedMonth, 0, 0, 0, 0, 0));

  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
  };
}

export function parseYearMonth(year, month) {
  const parsedYear = Number(year);
  const parsedMonth = Number(month);

  if (!Number.isInteger(parsedYear) || !Number.isInteger(parsedMonth) || parsedMonth < 1 || parsedMonth > 12) {
    return null;
  }

  return { year: parsedYear, month: parsedMonth };
}

// Inclusive calendar-month range for a review anchor ('YYYY-MM' or 'YYYY-MM-DD').
// Repository range filters are inclusive on both ends, so a single-day range
// (from = to = the first of the month) returns only day one of the month.
export function monthRangeFor(anchor) {
  const match = /^(\d{4})-(\d{2})(?:-\d{2})?$/.exec(String(anchor ?? '').trim());
  if (!match) {
    throw new Error('anchor must be YYYY-MM or YYYY-MM-DD');
  }
  const { start, end } = monthBounds(Number(match[1]), Number(match[2]));
  return { from: start, to: end };
}

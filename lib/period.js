export function monthRangeFromKey(monthKey) {
  const start = new Date(`${monthKey}-01T12:00:00`);
  const end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + 1);
  end.setUTCDate(0);
  return {
    from: start.toISOString().slice(0, 10),
    to: end.toISOString().slice(0, 10),
  };
}

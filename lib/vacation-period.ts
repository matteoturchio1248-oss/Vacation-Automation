/** Include leave overlapping the selected period, including cross-month requests. */
export function vacationInPeriod(record: { start_date: string; end_date: string }, year: number, month: string) {
  const start = `${year}-${month === "all" ? "01" : month}-01`;
  const end = month === "all" ? `${year}-12-31` : `${year}-${month}-${String(new Date(Date.UTC(year, Number(month), 0)).getUTCDate()).padStart(2, "0")}`;
  return record.start_date <= end && record.end_date >= start;
}

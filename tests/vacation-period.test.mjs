import assert from "node:assert/strict";
import test from "node:test";
import { vacationInPeriod } from "../lib/vacation-period.ts";

test("vacation periods include overlapping leave and exclude other months and years", () => {
  const record = { start_date: "2026-09-29", end_date: "2026-10-03" };
  assert.equal(vacationInPeriod(record, 2026, "09"), true);
  assert.equal(vacationInPeriod(record, 2026, "10"), true);
  assert.equal(vacationInPeriod(record, 2026, "11"), false);
  assert.equal(vacationInPeriod(record, 2026, "all"), true);
  assert.equal(vacationInPeriod(record, 2025, "all"), false);
  const yearBoundary = { start_date: "2026-12-30", end_date: "2027-01-02" };
  assert.equal(vacationInPeriod(yearBoundary, 2027, "01"), true);
  assert.equal(vacationInPeriod(yearBoundary, 2026, "all"), true);
  assert.equal(vacationInPeriod(yearBoundary, 2027, "all"), true);
  const leapDay = { start_date: "2028-02-29", end_date: "2028-03-01" };
  assert.equal(vacationInPeriod(leapDay, 2028, "02"), true);
  assert.equal(vacationInPeriod(leapDay, 2028, "03"), true);
  assert.equal(vacationInPeriod(leapDay, 2028, "01"), false);
  assert.equal(vacationInPeriod({ start_date: "2026-11-01", end_date: "2026-11-01" }, 2026, "10"), false);
});

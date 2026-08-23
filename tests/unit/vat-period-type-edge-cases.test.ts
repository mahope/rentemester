// Tests: src/core/periods.ts — edge cases for VAT period windows and periodsForYear
import { describe, expect, test } from "bun:test";
import { vatPeriodWindowFor, vatPeriodsForYear, vatPeriodLabel } from "../../src/core/periods";

describe("vatPeriodWindowFor — Q4 quarter", () => {
  test("October date yields Q4 window with next-year deadline", () => {
    const w = vatPeriodWindowFor("2026-10-15", "quarter");
    expect(w.start).toBe("2026-10-01");
    expect(w.end).toBe("2026-12-31");
    expect(w.filingDeadline).toBe("2027-03-01");
  });

  test("December date also yields Q4", () => {
    const w = vatPeriodWindowFor("2026-12-01", "quarter");
    expect(w.start).toBe("2026-10-01");
    expect(w.end).toBe("2026-12-31");
  });

  test("last day of year (Dec 31) yields Q4", () => {
    const w = vatPeriodWindowFor("2026-12-31", "quarter");
    expect(w.start).toBe("2026-10-01");
    expect(w.end).toBe("2026-12-31");
  });
});

describe("vatPeriodWindowFor — December monthly", () => {
  test("December date yields single-month window with next-year deadline", () => {
    const w = vatPeriodWindowFor("2026-12-15", "month");
    expect(w.start).toBe("2026-12-01");
    expect(w.end).toBe("2026-12-31");
    expect(w.filingDeadline).toBe("2027-03-01");
  });
});

describe("vatPeriodWindowFor — leap year February", () => {
  test("leap year February ends on 29th", () => {
    const w = vatPeriodWindowFor("2024-02-15", "month");
    expect(w.end).toBe("2024-02-29");
  });

  test("non-leap year February ends on 28th", () => {
    const w = vatPeriodWindowFor("2025-02-15", "month");
    expect(w.end).toBe("2025-02-28");
  });

  test("leap year Q1 ends on March 31 (not affected)", () => {
    const w = vatPeriodWindowFor("2024-02-15", "quarter");
    expect(w.end).toBe("2024-03-31");
  });
});

describe("vatPeriodWindowFor — year-end ISO date for each cadence", () => {
  test("December 31 as monthly = December", () => {
    const w = vatPeriodWindowFor("2026-12-31", "month");
    expect(w.start).toBe("2026-12-01");
    expect(w.end).toBe("2026-12-31");
  });

  test("December 31 as quarterly = Q4", () => {
    const w = vatPeriodWindowFor("2026-12-31", "quarter");
    expect(w.start).toBe("2026-10-01");
    expect(w.end).toBe("2026-12-31");
  });

  test("December 31 as half-year = H2", () => {
    const w = vatPeriodWindowFor("2026-12-31", "half-year");
    expect(w.start).toBe("2026-07-01");
    expect(w.end).toBe("2026-12-31");
  });
});

describe("vatPeriodLabel — monthly Danish labels", () => {
  test("all 12 months have Danish names", () => {
    const months = [
      { date: "2026-01-15", expected: "Januar 2026" },
      { date: "2026-02-15", expected: "Februar 2026" },
      { date: "2026-03-15", expected: "Marts 2026" },
      { date: "2026-04-15", expected: "April 2026" },
      { date: "2026-05-15", expected: "Maj 2026" },
      { date: "2026-06-15", expected: "Juni 2026" },
      { date: "2026-07-15", expected: "Juli 2026" },
      { date: "2026-08-15", expected: "August 2026" },
      { date: "2026-09-15", expected: "September 2026" },
      { date: "2026-10-15", expected: "Oktober 2026" },
      { date: "2026-11-15", expected: "November 2026" },
      { date: "2026-12-15", expected: "December 2026" },
    ];
    for (const m of months) {
      const w = vatPeriodWindowFor(m.date, "month");
      expect(vatPeriodLabel(w)).toBe(m.expected);
    }
  });
});

describe("vatPeriodsForYear — leap year February end dates", () => {
  test("leap year monthly periods have Feb 29", () => {
    const periods = vatPeriodsForYear(2024, "month");
    const feb = periods.find(p => p.start === "2024-02-01");
    expect(feb).toBeDefined();
    expect(feb!.end).toBe("2024-02-29");
  });
});
// Tests: src/core/fiscal-year.ts — edge cases for label strategies, start months, boundary dates
import { describe, expect, test } from "bun:test";
import { fiscalYearForDate } from "../../src/core/fiscal-year";

describe("fiscal year — calendar year (startMonth=1)", () => {
  test("date in January falls in calendar year", () => {
    const fy = fiscalYearForDate("2026-01-15", 1, "span");
    expect(fy.start).toBe("2026-01-01");
    expect(fy.end).toBe("2026-12-31");
    expect(fy.displayLabel).toBe("2026");
  });

  test("date in December falls in same calendar year", () => {
    const fy = fiscalYearForDate("2026-12-15", 1, "span");
    expect(fy.start).toBe("2026-01-01");
    expect(fy.end).toBe("2026-12-31");
  });
});

describe("fiscal year — offset start months", () => {
  test("startMonth=7, date in first half", () => {
    const fy = fiscalYearForDate("2026-01-15", 7, "span");
    expect(fy.startYear).toBe(2025);
    expect(fy.endYear).toBe(2026);
    expect(fy.start).toBe("2025-07-01");
    expect(fy.end).toBe("2026-06-30");
    expect(fy.displayLabel).toBe("2025/26");
  });

  test("startMonth=7, date exactly on first day of fiscal year", () => {
    const fy = fiscalYearForDate("2026-07-01", 7, "span");
    expect(fy.startYear).toBe(2026);
    expect(fy.endYear).toBe(2027);
    expect(fy.start).toBe("2026-07-01");
    expect(fy.end).toBe("2027-06-30");
  });

  test("startMonth=7, date on last day of fiscal year", () => {
    const fy = fiscalYearForDate("2027-06-30", 7, "span");
    expect(fy.startYear).toBe(2026);
    expect(fy.endYear).toBe(2027);
    expect(fy.start).toBe("2026-07-01");
    expect(fy.end).toBe("2027-06-30");
  });

  test("startMonth=2 (februar-start) spans correctly", () => {
    const fy = fiscalYearForDate("2026-03-15", 2, "span");
    expect(fy.startYear).toBe(2026);
    expect(fy.endYear).toBe(2027);
    expect(fy.start).toBe("2026-02-01");
    expect(fy.end).toBe("2027-01-31");
    expect(fy.displayLabel).toBe("2026/27");
  });

  test("startMonth=12 (december-start) spans correctly", () => {
    const fy = fiscalYearForDate("2026-12-15", 12, "span");
    expect(fy.startYear).toBe(2026);
    expect(fy.endYear).toBe(2027);
    expect(fy.start).toBe("2026-12-01");
    expect(fy.end).toBe("2027-11-30");
    expect(fy.displayLabel).toBe("2026/27");
  });
});

describe("fiscal year — label strategies", () => {
  test("start-year strategy labels by start year", () => {
    const fy = fiscalYearForDate("2026-07-15", 7, "start-year");
    expect(fy.displayLabel).toBe("2026");
    expect(fy.identifierLabel).toBe("2026");
  });

  test("end-year strategy labels by end year", () => {
    const fy = fiscalYearForDate("2026-07-15", 7, "end-year");
    expect(fy.displayLabel).toBe("2027");
    expect(fy.identifierLabel).toBe("2027");
  });

  test("span strategy shows start/end on offset years", () => {
    const fy = fiscalYearForDate("2026-07-15", 7, "span");
    expect(fy.displayLabel).toBe("2026/27");
    expect(fy.identifierLabel).toBe("2026-27");
  });

  test("span strategy on calendar year shows single year", () => {
    const fy = fiscalYearForDate("2026-07-15", 1, "span");
    expect(fy.displayLabel).toBe("2026");
  });
});

describe("fiscal year — invalid date throws", () => {
  test("throws on non-ISO date", () => {
    expect(() => fiscalYearForDate("not-a-date", 1, "span")).toThrow("invalid ISO date");
    expect(() => fiscalYearForDate("", 1, "span")).toThrow("invalid ISO date");
  });
});
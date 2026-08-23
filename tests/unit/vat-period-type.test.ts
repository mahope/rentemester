// Tests: src/core/periods.ts (VAT period type — issue #289)
import { describe, expect, test } from "bun:test";
import {
  normalizeVatPeriodType,
  vatPeriodWindowFor,
} from "../../src/core/periods";

describe("VAT period type (#289)", () => {
  test("normalizeVatPeriodType accepts the three valid cadences", () => {
    expect(normalizeVatPeriodType("month")).toBe("month");
    expect(normalizeVatPeriodType("quarter")).toBe("quarter");
    expect(normalizeVatPeriodType("half-year")).toBe("half-year");
  });

  test("normalizeVatPeriodType rejects anything else", () => {
    expect(normalizeVatPeriodType("yearly")).toBeNull();
    expect(normalizeVatPeriodType("")).toBeNull();
    expect(normalizeVatPeriodType(null)).toBeNull();
    expect(normalizeVatPeriodType("kvartal")).toBeNull();
  });

  test("quarterly cadence keeps the 3-month window (back-compat default)", () => {
    const window = vatPeriodWindowFor("2026-05-22", "quarter");
    expect(window.start).toBe("2026-04-01");
    expect(window.end).toBe("2026-06-30");
    // Filing deadline: 1st of the 3rd month after period end.
    expect(window.filingDeadline).toBe("2026-09-01");
  });

  test("monthly cadence yields a one-month window", () => {
    const window = vatPeriodWindowFor("2026-05-22", "month");
    expect(window.start).toBe("2026-05-01");
    expect(window.end).toBe("2026-05-31");
    expect(window.filingDeadline).toBe("2026-08-01");
  });

  test("half-yearly cadence yields a six-month window", () => {
    // A date in the first half maps to Jan..Jun.
    const firstHalf = vatPeriodWindowFor("2026-05-22", "half-year");
    expect(firstHalf.start).toBe("2026-01-01");
    expect(firstHalf.end).toBe("2026-06-30");
    expect(firstHalf.filingDeadline).toBe("2026-09-01");

    // A date in the second half maps to Jul..Dec.
    const secondHalf = vatPeriodWindowFor("2026-11-03", "half-year");
    expect(secondHalf.start).toBe("2026-07-01");
    expect(secondHalf.end).toBe("2026-12-31");
    expect(secondHalf.filingDeadline).toBe("2027-03-01");
  });

  test("cadence genuinely differs by period type for the same date", () => {
    const date = "2026-02-10";
    const month = vatPeriodWindowFor(date, "month");
    const quarter = vatPeriodWindowFor(date, "quarter");
    const half = vatPeriodWindowFor(date, "half-year");
    expect(month.end).toBe("2026-02-28");
    expect(quarter.end).toBe("2026-03-31");
    expect(half.end).toBe("2026-06-30");
    // The three windows are distinct — a half-yearly company's VAT period is
    // not the same as a quarterly company's.
    const ends = new Set([month.end, quarter.end, half.end]);
    expect(ends.size).toBe(3);
  });
});

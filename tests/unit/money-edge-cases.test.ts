// Tests: src/core/money.ts — edge cases and untested code paths
import { describe, expect, test } from "bun:test";
import {
  roundDiv,
  toOre,
  fromOre,
  formatAmount,
  formatDkk,
  formatKronerDa,
  addDkk,
  subtractDkk,
  absDkk,
  compareDkk,
  equalsDkk,
  multiplyDkk,
  percentOfDkk,
  accrueInterestDkk,
  normalizeCurrency,
} from "../../src/core/money";

describe("roundDiv — bigint division with half-up rounding", () => {
  test("exact division", () => {
    expect(roundDiv(10n, 5n)).toBe(2n);
    expect(roundDiv(0n, 5n)).toBe(0n);
  });
  test("rounds half up", () => {
    expect(roundDiv(1n, 2n)).toBe(1n);
    expect(roundDiv(3n, 2n)).toBe(2n);
    expect(roundDiv(1n, 3n)).toBe(0n);
    expect(roundDiv(2n, 3n)).toBe(1n);
  });
  test("handles negative numerator symmetrically", () => {
    expect(roundDiv(-1n, 2n)).toBe(-1n);
    expect(roundDiv(-3n, 2n)).toBe(-2n);
  });
  test("handles negative denominator", () => {
    expect(roundDiv(1n, -2n)).toBe(-1n);
    expect(roundDiv(-1n, -2n)).toBe(1n);
  });
  test("throws on division by zero", () => {
    expect(() => roundDiv(1n, 0n)).toThrow("division by zero");
  });
});

describe("toOre / fromOre — conversion", () => {
  test("toOre handles basic cases", () => {
    expect(toOre(0)).toBe(0n);
    expect(toOre(1)).toBe(100n);
    expect(toOre(1.5)).toBe(150n);
    expect(toOre(-1.5)).toBe(-150n);
    expect(toOre(0.01)).toBe(1n);
    expect(toOre(0.005)).toBe(1n);
  });
  test("toOre throws on non-finite", () => {
    expect(() => toOre(NaN)).toThrow("invalid monetary amount");
    expect(() => toOre(Infinity)).toThrow("invalid monetary amount");
  });
  test("fromOre converts back", () => {
    expect(fromOre(100n)).toBe(1);
    expect(fromOre(150n)).toBe(1.5);
    expect(fromOre(-150n)).toBe(-1.5);
    expect(fromOre(1n)).toBe(0.01);
    expect(fromOre(0n)).toBe(0);
  });
});

describe("formatAmount — machine-format string", () => {
  test("handles common values", () => {
    expect(formatAmount(0)).toBe("0.00");
    expect(formatAmount(1.5)).toBe("1.50");
    expect(formatAmount(-1.5)).toBe("-1.50");
    expect(formatAmount(1234567.89)).toBe("1234567.89");
    expect(formatAmount(0.005)).toBe("0.01");
    expect(formatAmount(-0.005)).toBe("-0.01");
  });
  test("handles bigint input (ore)", () => {
    expect(formatAmount(100n)).toBe("1.00");
    expect(formatAmount(-100n)).toBe("-1.00");
    expect(formatAmount(12345n)).toBe("123.45");
    expect(formatAmount(0n)).toBe("0.00");
  });
  test("returns null for null/undefined/NaN", () => {
    expect(formatAmount(null)).toBeNull();
    expect(formatAmount(undefined)).toBeNull();
    expect(formatAmount("")).toBeNull();
    expect(formatAmount(NaN)).toBeNull();
  });
});

describe("formatDkk — amount with currency suffix", () => {
  test("appends DKK by default", () => {
    expect(formatDkk(100)).toBe("100.00 DKK");
    expect(formatDkk(-50.5)).toBe("-50.50 DKK");
  });
  test("accepts custom currency", () => {
    expect(formatDkk(100, "EUR")).toBe("100.00 EUR");
  });
  test("returns null on invalid input", () => {
    expect(formatDkk(null)).toBeNull();
  });
});

describe("formatKronerDa — Danish display format", () => {
  test("basic formatting", () => {
    expect(formatKronerDa(1234.5)).toBe("1.234,50 kr.");
    expect(formatKronerDa(0)).toBe("0,00 kr.");
    expect(formatKronerDa(-0.01)).toBe("-0,01 kr.");
    expect(formatKronerDa(1000000)).toBe("1.000.000,00 kr.");
  });
  test("returns em-dash for null/bad input", () => {
    expect(formatKronerDa(null)).toBe("—");
    expect(formatKronerDa(undefined)).toBe("—");
    expect(formatKronerDa("")).toBe("—");
    expect(formatKronerDa(NaN)).toBe("—");
    expect(formatKronerDa(Infinity)).toBe("—");
  });
});

describe("compareDkk / equalsDkk / absDkk", () => {
  test("compareDkk orders correctly", () => {
    expect(compareDkk(1, 2)).toBe(-1);
    expect(compareDkk(2, 1)).toBe(1);
    expect(compareDkk(1, 1)).toBe(0);
    expect(compareDkk(-0, 0)).toBe(0);
  });
  test("equalsDkk detects equality after ore rounding", () => {
    expect(equalsDkk(1.005, 1.01)).toBe(true);
    expect(equalsDkk(1.004, 1.00)).toBe(true);
    expect(equalsDkk(1.00, 1.01)).toBe(false);
  });
  test("absDkk returns absolute value", () => {
    expect(absDkk(-1.5)).toBe(1.5);
    expect(absDkk(1.5)).toBe(1.5);
    expect(absDkk(0)).toBe(0);
  });
});

describe("addDkk / subtractDkk", () => {
  test("addDkk avoids float drift", () => {
    expect(addDkk(0.1, 0.2)).toBe(0.3);
    expect(addDkk(1, 2, 3)).toBe(6);
  });
  test("subtractDkk round-trips", () => {
    expect(subtractDkk(1, 0.3)).toBe(0.7);
    expect(subtractDkk(10, 3.5, 1.5)).toBe(5);
  });
});

describe("multiplyDkk edge cases", () => {
  test("handles signs and fractions", () => {
    expect(multiplyDkk(100, 7.46)).toBe(746);
    expect(multiplyDkk(-2, 1.5)).toBe(-3);
    expect(multiplyDkk(2, -1.5)).toBe(-3);
    expect(multiplyDkk(-2, -1.5)).toBe(3);
    expect(multiplyDkk(0, 100)).toBe(0);
    expect(multiplyDkk(0.1, 0.1)).toBe(0.01);
  });
});

describe("percentOfDkk edge cases", () => {
  test("boundary values", () => {
    expect(percentOfDkk(100, 0)).toBe(0);
    expect(percentOfDkk(100, 100)).toBe(100);
    expect(percentOfDkk(100, 0.5)).toBe(0.5);
    expect(percentOfDkk(-100, 25)).toBe(-25);
    expect(percentOfDkk(99.99, 25)).toBe(25);
  });
});

describe("accrueInterestDkk edge cases", () => {
  test("full year at 5% = 5% of principal", () => {
    expect(accrueInterestDkk(10000, 5, 365)).toBe(500);
  });
  test("zero days returns 0", () => {
    expect(accrueInterestDkk(10000, 5, 0)).toBe(0);
    expect(accrueInterestDkk(10000, 5, -1)).toBe(0);
  });
  test("non-integer days returns 0", () => {
    expect(accrueInterestDkk(10000, 5, 1.5)).toBe(0);
  });
  test("zero principal = zero interest", () => {
    expect(accrueInterestDkk(0, 5, 30)).toBe(0);
  });
  test("zero rate = zero interest", () => {
    expect(accrueInterestDkk(10000, 0, 30)).toBe(0);
  });
  test("handles small principal over few days", () => {
    expect(accrueInterestDkk(1, 1, 1)).toBe(0);
    expect(accrueInterestDkk(100, 10, 1)).toBe(0.03);
  });
});

describe("normalizeCurrency", () => {
  test("defaults to DKK", () => {
    expect(normalizeCurrency()).toBe("DKK");
    expect(normalizeCurrency(null)).toBe("DKK");
    expect(normalizeCurrency("")).toBe("DKK");
  });
  test("normalizes input", () => {
    expect(normalizeCurrency("eur")).toBe("EUR");
    expect(normalizeCurrency("  usd  ")).toBe("USD");
    expect(normalizeCurrency("dKK")).toBe("DKK");
  });
});
// Tests: src/core/invoice-interest.ts — edge cases for interest calculation
// Leap year, month boundaries, year boundaries, different rates, long periods
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureCompanyDirs } from "../../src/core/paths";
import { openDb, migrate } from "../../src/core/db";
import { issueInvoice } from "../../src/core/issued-invoices";
import { calculateInvoiceLateInterest, registerInvoiceLateInterest, postInvoiceLateInterestToLedger } from "../../src/core/invoice-interest";
import { verifyAuditChain, seedAccounts } from "../../src/core/ledger";

function basicDb(tempName: string) {
  const root = mkdtempSync(join(tmpdir(), tempName));
  const db = openDb(ensureCompanyDirs(root).db);
  migrate(db);
  seedAccounts(db);
  return { db, root };
}

function makeInvoice(db: ReturnType<typeof openDb>, root: string, overrides?: Record<string, unknown>) {
  return issueInvoice(db, root, {
    invoiceType: "full",
    vatTreatment: "standard",
    issueDate: "2026-01-01",
    dueDate: "2026-01-31",
    seller: { name: "Rentemester ApS", address: "Testvej 1", vatOrCvr: "DK12345678" },
    buyer: { name: "Kunde A/S", address: "Købervej 9" },
    lines: [{ description: "Bogføring", quantity: 1, unitPriceExVat: 1000, lineTotalExVat: 1000 }],
    totals: { netAmount: 1000, vatRate: 0.25, vatAmount: 250, grossAmount: 1250 },
    currency: "DKK",
    ...overrides,
  });
}

describe("invoice late interest — randtilfælde", () => {
  test("calculates interest across a leap year February (29 days)", () => {
    const { db, root } = basicDb("interest-leap-feb");
    const issued = makeInvoice(db, root, {
      issueDate: "2024-01-15",
      dueDate: "2024-02-01",
    });
    expect(issued.ok).toBe(true);

    const interest = calculateInvoiceLateInterest(db, {
      invoiceDocumentId: issued.documentId!,
      asOfDate: "2024-03-01",
      referenceRatePercent: 2,
    });
    expect(interest.ok).toBe(true);
    expect(interest.overdueDays).toBe(29);
    expect(interest.annualInterestRatePercent).toBe(10);
    expect(interest.accruedInterestAmount).toBeGreaterThan(0);

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("calculates interest across a year boundary (Dec → Jan)", () => {
    const { db, root } = basicDb("interest-year-boundary");
    const issued = makeInvoice(db, root, {
      issueDate: "2026-12-01",
      dueDate: "2026-12-15",
    });
    expect(issued.ok).toBe(true);

    const interest = calculateInvoiceLateInterest(db, {
      invoiceDocumentId: issued.documentId!,
      asOfDate: "2027-01-15",
      referenceRatePercent: 2,
    });
    expect(interest.ok).toBe(true);
    expect(interest.overdueDays).toBe(31);
    expect(interest.accruedInterestAmount).toBeGreaterThan(0);

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("calculates interest across a month boundary (Mar 31 → Apr 1)", () => {
    const { db, root } = basicDb("interest-month-boundary");
    const issued = makeInvoice(db, root, {
      issueDate: "2026-03-01",
      dueDate: "2026-03-31",
    });
    expect(issued.ok).toBe(true);

    const interest = calculateInvoiceLateInterest(db, {
      invoiceDocumentId: issued.documentId!,
      asOfDate: "2026-04-01",
      referenceRatePercent: 2,
    });
    expect(interest.ok).toBe(true);
    expect(interest.overdueDays).toBe(1);

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("handles negative reference rate (historical DK scenario)", () => {
    const { db, root } = basicDb("interest-negative-rate");
    const issued = makeInvoice(db, root, {
      issueDate: "2026-01-01",
      dueDate: "2026-01-15",
    });
    expect(issued.ok).toBe(true);

    // Reference rate -0.5% + 8% = 7.5% p.a.
    const interest = calculateInvoiceLateInterest(db, {
      invoiceDocumentId: issued.documentId!,
      asOfDate: "2026-02-15",
      referenceRatePercent: -0.5,
    });
    expect(interest.ok).toBe(true);
    expect(interest.annualInterestRatePercent).toBe(7.5);
    expect(interest.accruedInterestAmount).toBeGreaterThan(0);

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("handles zero reference rate", () => {
    const { db, root } = basicDb("interest-zero-ref");
    const issued = makeInvoice(db, root, {
      dueDate: "2026-01-15",
    });
    expect(issued.ok).toBe(true);

    // 0% + 8% = 8% p.a.
    const interest = calculateInvoiceLateInterest(db, {
      invoiceDocumentId: issued.documentId!,
      asOfDate: "2026-02-15",
      referenceRatePercent: 0,
    });
    expect(interest.ok).toBe(true);
    expect(interest.annualInterestRatePercent).toBe(8);

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("full register+post+verify cycle with leap-year interest", () => {
    const { db, root } = basicDb("interest-leap-cycle");
    const issued = makeInvoice(db, root, {
      issueDate: "2024-01-01",
      dueDate: "2024-01-15",
    });
    expect(issued.ok).toBe(true);

    const reg = registerInvoiceLateInterest(db, {
      invoiceDocumentId: issued.documentId!,
      asOfDate: "2024-03-01",
      referenceRatePercent: 2,
      note: "Leap-year interest test",
    });
    expect(reg.ok).toBe(true);

    const posted = postInvoiceLateInterestToLedger(db, { invoiceDocumentId: issued.documentId! });
    expect(posted.ok).toBe(true);

    const chain = verifyAuditChain(db);
    expect(chain.ok).toBe(true);

    db.close();
    rmSync(root, { recursive: true, force: true });
  });
});
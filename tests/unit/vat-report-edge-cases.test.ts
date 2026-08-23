// Tests: src/core/vat.ts — edge cases for VAT report boundaries and empty periods
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureCompanyDirs } from "../../src/core/paths";
import { openDb, migrate } from "../../src/core/db";
import { buildVatReport } from "../../src/core/vat";
import { postJournalEntry, seedAccounts } from "../../src/core/ledger";
import { ingestDocument } from "../../src/core/documents";

function makeEntry(db: ReturnType<typeof openDb>, root: string, inbox: string, overrides: {
  transactionDate: string;
  text: string;
  issueDate?: string;
}) {
  const sourceFile = join(inbox, "entry.txt");
  writeFileSync(sourceFile, "Entry\n1250 DKK\n");
  const doc = ingestDocument(db, root, sourceFile, {
    source: "email",
    issueDate: overrides.issueDate ?? "2026-01-01",
    invoiceNo: "INV-EDGE",
    deliveryDescription: overrides.text,
    amountIncVat: 1250,
    currency: "DKK",
    sender: { name: "Leverandør ApS", address: "Sælgervej 1", vatOrCvr: "DK11223344" },
    recipient: { name: "Rentemester ApS", address: "Testvej 1", vatOrCvr: "DK12345678" },
    vatAmount: 250,
    paymentDetails: "Bankoverførsel",
  });
  if (!doc.ok) throw new Error(`ingest failed: ${doc.errors?.join(", ")}`);
  return postJournalEntry(db, {
    transactionDate: overrides.transactionDate,
    text: overrides.text,
    documentId: doc.documentId,
    lines: [
      { accountNo: "3000", debitAmount: 1000, vatCode: "DK_PURCHASE_25" },
      { accountNo: "4000", debitAmount: 250 },
      { accountNo: "2000", creditAmount: 1250 },
    ],
  });
}

describe("VAT report — edge cases", () => {
  test("empty period returns zero totals", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-vat-empty-"));
    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);
    seedAccounts(db);

    const report = buildVatReport(db, "2026-01-01", "2026-01-31");
    expect(report.ok).toBe(true);
    expect(report.outputVat).toBe(0);
    expect(report.inputVat).toBe(0);
    expect(report.netVatPayable).toBe(0);
    expect(report.salesBase25).toBe(0);
    expect(report.purchaseBase25).toBe(0);
    expect(report.journalEntryCount).toBe(0);
    expect(report.totalJournalEntryCount).toBe(0);
    expect(report.warnings).toEqual([]);

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("transaction on exact period start date is included", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-vat-start-"));
    const inbox = mkdtempSync(join(tmpdir(), "rentemester-vat-start-inbox-"));
    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);
    seedAccounts(db);

    const entry = makeEntry(db, root, inbox, {
      transactionDate: "2026-02-01",
      text: "First day purchase",
    });
    expect(entry.ok).toBe(true);

    const report = buildVatReport(db, "2026-02-01", "2026-02-28");
    expect(report.ok).toBe(true);
    expect(report.purchaseBase25).toBe(1000);
    expect(report.inputVat).toBe(250);
    expect(report.journalEntryCount).toBe(1);

    db.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(inbox, { recursive: true, force: true });
  });

  test("transaction on exact period end date is included", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-vat-end-"));
    const inbox = mkdtempSync(join(tmpdir(), "rentemester-vat-end-inbox-"));
    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);
    seedAccounts(db);

    const entry = makeEntry(db, root, inbox, {
      transactionDate: "2026-02-28",
      text: "Last day purchase",
    });
    expect(entry.ok).toBe(true);

    const report = buildVatReport(db, "2026-02-01", "2026-02-28");
    expect(report.ok).toBe(true);
    expect(report.purchaseBase25).toBe(1000);
    expect(report.journalEntryCount).toBe(1);

    db.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(inbox, { recursive: true, force: true });
  });

  test("transaction one day before period start is excluded", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-vat-excl-"));
    const inbox = mkdtempSync(join(tmpdir(), "rentemester-vat-excl-inbox-"));
    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);
    seedAccounts(db);

    const entry = makeEntry(db, root, inbox, {
      transactionDate: "2026-01-31",
      text: "Excluded purchase",
    });
    expect(entry.ok).toBe(true);

    const report = buildVatReport(db, "2026-02-01", "2026-02-28");
    expect(report.ok).toBe(true);
    expect(report.journalEntryCount).toBe(0);
    expect(report.totalJournalEntryCount).toBe(0);

    db.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(inbox, { recursive: true, force: true });
  });
});
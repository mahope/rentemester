// Tests: src/core/authority-export.ts
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureCompanyDirs } from "../../src/core/paths";
import { openDb, migrate } from "../../src/core/db";
import { issueInvoice } from "../../src/core/issued-invoices";
import { postIssuedInvoiceToLedger } from "../../src/core/invoice-booking";
import { ingestDocument } from "../../src/core/documents";
import { postJournalEntry, seedAccounts } from "../../src/core/ledger";
import { exportAuthorityPackage } from "../../src/core/authority-export";

function sha256(path: string) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const FOUR_WEEKS_MS = 28 * 24 * 60 * 60 * 1000;

describe("authority export", () => {
  test("exports a deterministic period package with audit, exceptions, accounts, and readable supporting documents", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-authority-export-"));
    const companyRoot = join(root, "company");
    const exportRoot = join(root, "exports");
    const paths = ensureCompanyDirs(companyRoot);
    const db = openDb(paths.db);
    migrate(db);
    seedAccounts(db);
    db.run("INSERT INTO companies (id, name, country, currency) VALUES (1, 'Rentemester Test', 'DK', 'DKK')");

    // Audit-log-rækker stemples med den rigtige ur, og fetchAuditLog filtrerer
    // på created_at inde i perioden — derfor ankeres perioden omkring "nu"
    // (periodEnd = sidste dag i NÆSTE måned som margin) med dynamiske
    // fixture-datoer, så testen ikke råddner med kalenderen.
    const nowMs = Date.now();
    const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    const monthStartUtc = new Date(nowMs);
    monthStartUtc.setUTCDate(1);
    const periodStart = utcDay(monthStartUtc.getTime());
    const periodEnd = utcDay(Date.UTC(monthStartUtc.getUTCFullYear(), monthStartUtc.getUTCMonth() + 2, 0));
    const requestedAt = new Date(nowMs).toISOString();
    const deadlineAt = new Date(nowMs + FOUR_WEEKS_MS).toISOString();

    const invoiceFixture = JSON.parse(readFileSync(join(process.cwd(), "examples/full-invoice.dk.json"), "utf8"));
    invoiceFixture.issueDate = periodStart;
    invoiceFixture.dueDate = utcDay(nowMs + 30 * 24 * 60 * 60 * 1000);
    const issued = issueInvoice(db, companyRoot, invoiceFixture);
    expect(issued.ok).toBe(true);
    const posted = postIssuedInvoiceToLedger(db, { invoiceDocumentId: issued.documentId! });
    expect(posted.ok).toBe(true);

    const vendorMetadata = JSON.parse(readFileSync(join(process.cwd(), "examples/vendor-invoice.metadata.json"), "utf8"));
    vendorMetadata.issueDate = periodStart;
    const ingested = ingestDocument(db, companyRoot, join(process.cwd(), "examples/vendor-invoice.txt"), vendorMetadata);
    expect(ingested.ok).toBe(true);

    const expenseFixture = JSON.parse(readFileSync(join(process.cwd(), "examples/journal-entry.expense.json"), "utf8"));
    expenseFixture.transactionDate = periodStart;
    const expense = postJournalEntry(db, expenseFixture);
    expect(expense.ok).toBe(true);

    db.run(
      `INSERT INTO exceptions (type, severity, status, related_document_id, message, required_action, created_at)
       VALUES ('missing_metadata', 'high', 'open', ?, 'Missing detail', 'Review source document', '2026-04-30 23:59:59')`, [
      ingested.documentId!,
    ]);
    db.run(
      `INSERT INTO exceptions (type, severity, status, related_document_id, message, required_action, created_at)
       VALUES ('period_issue', 'medium', 'open', ?, 'Needs period review', 'Check period classification', '2026-05-10 12:00:00')`, [
      ingested.documentId!,
    ]);

    const first = exportAuthorityPackage(db, companyRoot, {
      periodStart,
      periodEnd,
      outputDir: exportRoot,
      requestedAt,
      requester: "Skattestyrelsen",
    });

    expect(first.ok).toBe(true);
    expect(first.generatedAt).toBe(requestedAt);
    expect(first.deadlineAt).toBe(deadlineAt);
    expect(existsSync(first.manifestPath!)).toBe(true);

    const second = exportAuthorityPackage(db, companyRoot, {
      periodStart,
      periodEnd,
      outputDir: exportRoot,
      requestedAt,
      requester: "Skattestyrelsen",
    });

    expect(second.ok).toBe(true);
    expect(second.exportDir).toBe(first.exportDir);
    expect(sha256(first.manifestPath!)).toBe(sha256(second.manifestPath!));
    expect(sha256(join(first.exportDir!, "machine-readable", "journal-entries.json"))).toBe(sha256(join(second.exportDir!, "machine-readable", "journal-entries.json")));
    expect(sha256(join(first.exportDir!, "machine-readable", "documents.json"))).toBe(sha256(join(second.exportDir!, "machine-readable", "documents.json")));

    const manifest = JSON.parse(readFileSync(first.manifestPath!, "utf8"));
    expect(manifest.packageType).toBe("authority_export");
    expect(manifest.counts.journalEntries).toBe(2);
    expect(manifest.counts.documents).toBe(3);
    expect(manifest.counts.auditLog).toBeGreaterThanOrEqual(4);
    expect(manifest.counts.exceptions).toBe(2);
    expect(manifest.counts.accounts).toBeGreaterThanOrEqual(10);
    expect(manifest.counts.companies).toBe(1);
    expect(manifest.counts.schemaMigrations).toBeGreaterThanOrEqual(0);
    expect(manifest.counts.copiedReadableDocuments).toBe(3);
    expect(manifest.files.auditLog).toBe("machine-readable/audit-log.json");
    expect(manifest.files.accounts).toBe("machine-readable/accounts.json");
    expect(manifest.files.exceptions).toBe("machine-readable/exceptions.json");
    expect(manifest.files.readableDocumentsDir).toBe("documents-readable");
    expect(manifest.sourceCompanyRootName).toBe("company");
    expect(manifest.outputs.every((entry: any) => !entry.path.startsWith("/"))).toBe(true);
    expect(manifest.outputs.some((entry: any) => entry.path === "machine-readable/audit-log.json")).toBe(true);
    expect(manifest.outputs.some((entry: any) => entry.path === "README.txt")).toBe(true);

    const auditLog = JSON.parse(readFileSync(join(first.exportDir!, "machine-readable", "audit-log.json"), "utf8"));
    expect(auditLog.some((entry: any) => entry.eventType === "journal_post")).toBe(true);

    const exceptions = JSON.parse(readFileSync(join(first.exportDir!, "machine-readable", "exceptions.json"), "utf8"));
    expect(exceptions).toHaveLength(2);
    expect(exceptions.some((entry: any) => entry.createdAt === "2026-04-30 23:59:59")).toBe(true);

    const accounts = JSON.parse(readFileSync(join(first.exportDir!, "machine-readable", "accounts.json"), "utf8"));
    expect(accounts.some((entry: any) => entry.accountNo === "3070")).toBe(true);

    const exportedDocs = JSON.parse(readFileSync(join(first.exportDir!, "machine-readable", "documents.json"), "utf8"));
    expect(exportedDocs).toHaveLength(3);
    expect(exportedDocs.some((doc: any) => doc.documentType === "issued_invoice")).toBe(true);
    expect(exportedDocs.some((doc: any) => doc.documentType === "issued_invoice_pdf")).toBe(true);
    expect(exportedDocs.some((doc: any) => doc.documentType === "purchase_sale")).toBe(true);
    expect(exportedDocs.every((doc: any) => doc.exportedReadablePath === null || doc.exportedReadablePath.startsWith("documents-readable/"))).toBe(true);
    expect(exportedDocs.every((doc: any) => doc.storedPathRelativeToCompany === null || !doc.storedPathRelativeToCompany.startsWith("/"))).toBe(true);
    expect(exportedDocs.every((doc: any) => typeof doc.retainUntil === "string")).toBe(true);

    const exportedJournal = JSON.parse(readFileSync(join(first.exportDir!, "machine-readable", "journal-entries.json"), "utf8"));
    expect(exportedJournal.every((entry: any) => typeof entry.retainUntil === "string")).toBe(true);

    const exportedBank = JSON.parse(readFileSync(join(first.exportDir!, "machine-readable", "bank-transactions.json"), "utf8"));
    expect(exportedBank.every((row: any) => typeof row.retainUntil === "string")).toBe(true);

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("exports an accountant handoff package without implying hosted reviewer access", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-accountant-export-"));
    const companyRoot = join(root, "company");
    const exportRoot = join(root, "exports");
    const paths = ensureCompanyDirs(companyRoot);
    const db = openDb(paths.db);
    migrate(db);
    seedAccounts(db);
    db.run("INSERT INTO companies (id, name, country, currency) VALUES (1, 'Rentemester Test', 'DK', 'DKK')");

    const issued = issueInvoice(db, companyRoot, JSON.parse(readFileSync(join(process.cwd(), "examples/full-invoice.dk.json"), "utf8")));
    expect(issued.ok).toBe(true);
    const posted = postIssuedInvoiceToLedger(db, { invoiceDocumentId: issued.documentId! });
    expect(posted.ok).toBe(true);

    const exported = exportAuthorityPackage(db, companyRoot, {
      periodStart: "2026-05-01",
      periodEnd: "2026-05-31",
      outputDir: exportRoot,
      requestedAt: "2026-05-17T02:24:00.000Z",
      requester: "Test accountant",
      packageProfile: "accountant_handoff",
    });

    expect(exported.ok).toBe(true);
    const manifest = JSON.parse(readFileSync(exported.manifestPath!, "utf8"));
    expect(manifest.packageType).toBe("accountant_handoff_export");
    expect(manifest.handoffModel).toBe("local_export_package");
    expect(manifest.accessModel).toBe("no_runtime_access");
    expect(manifest.outOfScope).toEqual([
      "hosted_multi_user_access",
      "role_based_write_access",
      "real_time_collaboration",
    ]);

    const readme = readFileSync(join(exported.exportDir!, "README.txt"), "utf8");
    expect(readme).toContain("Primary handoff model: local export package");
    expect(readme).toContain("Out of scope: hosted reviewer/accountant access");

    const auditRows = db.query(
      "SELECT event_type, message FROM audit_log WHERE event_type = 'accountant_handoff_export' ORDER BY id DESC LIMIT 1"
    ).all() as Array<{ event_type: string; message: string }>;
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.message).toContain("Test accountant");

    db.close();
    rmSync(root, { recursive: true, force: true });
  });
});

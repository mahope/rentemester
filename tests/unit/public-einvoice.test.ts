// Tests: src/core/public-einvoice.ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureCompanyDirs } from "../../src/core/paths";
import { openDb, migrate } from "../../src/core/db";
import { issueInvoice } from "../../src/core/issued-invoices";
import {
  exportPublicEInvoiceOioUbl,
  exportPublicEInvoicePreview,
  submitPublicEInvoicePeppol,
} from "../../src/core/public-einvoice";

const PUBLIC_INVOICE = {
  invoiceType: "full" as const,
  vatTreatment: "standard" as const,
  issueDate: "2026-05-20",
  invoiceNumber: "2026-0001",
  seller: { name: "Rentemester ApS", address: "Testvej 1", vatOrCvr: "DK12345678" },
  buyer: {
    name: "Københavns Kommune",
    address: "Rådhuset, 1599 København V",
    publicRecipient: true,
    eanNumber: "5790000000001",
  },
  lines: [{ description: "Bogføring", quantity: 1, unitPriceExVat: 1500, lineTotalExVat: 1500 }],
  totals: { netAmount: 1500, vatRate: 0.25, vatAmount: 375, grossAmount: 1875 },
  currency: "DKK",
  dueDate: "2026-06-19",
};

const ACCESS_POINT = {
  accessPointId: "ap-nemhandel-test",
  endpointUrl: "https://access-point.example.dk/peppol",
  senderEndpointId: "0184:DK12345678",
};

describe("public e-invoice preview export", () => {
  test("exports a deterministic preview artifact for public-recipient invoices", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-public-einvoice-"));
    const outPath = join(root, "public-invoice.xml");
    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);

    const issued = issueInvoice(db, root, {
      invoiceType: "full",
      vatTreatment: "standard",
      issueDate: "2026-05-20",
      invoiceNumber: "2026-0001",
      seller: { name: "Rentemester ApS", address: "Testvej 1", vatOrCvr: "DK12345678" },
      buyer: {
        name: "Københavns Kommune",
        address: "Rådhuset, 1599 København V",
        publicRecipient: true,
        eanNumber: "5790000000001",
      },
      lines: [{ description: "Bogføring", quantity: 1, unitPriceExVat: 1500, lineTotalExVat: 1500 }],
      totals: { netAmount: 1500, vatRate: 0.25, vatAmount: 375, grossAmount: 1875 },
      currency: "DKK",
      dueDate: "2026-06-19",
    });

    expect(issued.ok).toBe(true);
    const first = exportPublicEInvoicePreview(db, { invoiceDocumentId: issued.documentId!, outPath });
    const second = exportPublicEInvoicePreview(db, { invoiceDocumentId: issued.documentId! });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(first.sha256).toBe(second.sha256!);
    expect(first.xml).toBe(second.xml);
    expect(first.xml as string).toBe(readFileSync(outPath, "utf8"));
    expect(first.xml).toContain("<EanNumber>5790000000001</EanNumber>");
    expect(first.xml).toContain("<Transport>out_of_scope_peppol_access_point_required</Transport>");

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("rejects export for invoices that are not marked as public-recipient invoices", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-public-einvoice-nonpublic-"));
    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);

    const issued = issueInvoice(db, root, {
      invoiceType: "full",
      vatTreatment: "standard",
      issueDate: "2026-05-20",
      invoiceNumber: "2026-0001",
      seller: { name: "Rentemester ApS", address: "Testvej 1", vatOrCvr: "DK12345678" },
      buyer: { name: "Privat Kunde", address: "Købervej 9" },
      lines: [{ description: "Bogføring", quantity: 1, unitPriceExVat: 1500, lineTotalExVat: 1500 }],
      totals: { netAmount: 1500, vatRate: 0.25, vatAmount: 375, grossAmount: 1875 },
      currency: "DKK",
    });

    expect(issued.ok).toBe(true);
    const exported = exportPublicEInvoicePreview(db, { invoiceDocumentId: issued.documentId! });

    expect(exported.ok).toBe(false);
    expect(exported.errors).toContain("invoice 2026-0001 is not marked as a public-recipient e-invoice");

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("exports a deterministic OIOUBL handoff artifact and records audit metadata", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-public-oioubl-"));
    const outPath = join(root, "public-invoice-oioubl.xml");
    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);

    const issued = issueInvoice(db, root, {
      invoiceType: "full",
      vatTreatment: "standard",
      issueDate: "2026-05-20",
      invoiceNumber: "2026-0001",
      seller: { name: "Rentemester ApS", address: "Testvej 1", vatOrCvr: "DK12345678" },
      buyer: {
        name: "Københavns Kommune",
        address: "Rådhuset, 1599 København V",
        publicRecipient: true,
        eanNumber: "5790000000001",
      },
      lines: [{ description: "Bogføring", quantity: 1, unitPriceExVat: 1500, lineTotalExVat: 1500 }],
      totals: { netAmount: 1500, vatRate: 0.25, vatAmount: 375, grossAmount: 1875 },
      currency: "DKK",
      dueDate: "2026-06-19",
    });

    expect(issued.ok).toBe(true);

    const first = exportPublicEInvoiceOioUbl(db, { invoiceDocumentId: issued.documentId!, outPath });
    const second = exportPublicEInvoiceOioUbl(db, { invoiceDocumentId: issued.documentId! });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(first.sha256).toBe(second.sha256!);
    expect(first.xml).toBe(second.xml);
    expect(first.xml as string).toBe(readFileSync(outPath, "utf8"));
    expect(first.xml).toContain("<cbc:CustomizationID>urn:fdc:oioubl.dk:trns:billing:invoice:3.0</cbc:CustomizationID>");
    expect(first.xml).toContain("<cbc:ProfileID>urn:fdc:oioubl.dk:bis:billing_with_response:3</cbc:ProfileID>");
    expect(first.xml).toContain('<cbc:EndpointID schemeID="0188">5790000000001</cbc:EndpointID>');

    const auditRows = db.query(
      "SELECT event_type, entity_type, entity_id, message FROM audit_log WHERE event_type = 'public_einvoice_oioubl_export' ORDER BY id ASC",
    ).all() as Array<{ event_type: string; entity_type: string; entity_id: string; message: string }>;

    expect(auditRows).toHaveLength(2);
    expect(auditRows[0]).toEqual({
      event_type: "public_einvoice_oioubl_export",
      entity_type: "document",
      entity_id: String(issued.documentId),
      message: `Generated public OIOUBL handoff artifact for invoice 2026-0001 (sha256 ${first.sha256})`,
    });

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("rejects OIOUBL export when required public-recipient handoff metadata is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-public-oioubl-missing-"));
    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);

    const issued = issueInvoice(db, root, {
      invoiceType: "full",
      vatTreatment: "standard",
      issueDate: "2026-05-20",
      invoiceNumber: "2026-0001",
      seller: { name: "Rentemester ApS", address: "Testvej 1", vatOrCvr: "DK12345678" },
      buyer: {
        name: "Københavns Kommune",
        address: "Rådhuset, 1599 København V",
        publicRecipient: true,
        eanNumber: "5790000000001",
      },
      lines: [{ description: "Bogføring", quantity: 1, unitPriceExVat: 1500, lineTotalExVat: 1500 }],
      totals: { netAmount: 1500, vatRate: 0.25, vatAmount: 375, grossAmount: 1875 },
      currency: "DKK",
    });

    expect(issued.ok).toBe(true);

    const exported = exportPublicEInvoiceOioUbl(db, { invoiceDocumentId: issued.documentId! });

    expect(exported.ok).toBe(false);
    expect(exported.errors).toContain("invoice 2026-0001 is missing dueDate required for OIOUBL handoff");

    db.close();
    rmSync(root, { recursive: true, force: true });
  });
});

describe("public e-invoice PEPPOL submission", () => {
  test("produces a deterministic submission envelope on top of the OIOUBL handoff artifact", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-peppol-submit-"));
    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);

    const issued = issueInvoice(db, root, { ...PUBLIC_INVOICE });
    expect(issued.ok).toBe(true);

    const first = submitPublicEInvoicePeppol(db, {
      invoiceDocumentId: issued.documentId!,
      accessPoint: ACCESS_POINT,
    });
    const second = submitPublicEInvoicePeppol(db, {
      invoiceDocumentId: issued.documentId!,
      accessPoint: ACCESS_POINT,
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    // Deterministic envelope + idempotency key.
    expect(first.envelopeSha256).toBe(second.envelopeSha256);
    expect(first.envelope).toBe(second.envelope);
    expect(first.idempotencyKey).toBe(second.idempotencyKey);
    // Envelope embeds the OIOUBL handoff artifact hash, not a mutated payload.
    const oioubl = exportPublicEInvoiceOioUbl(db, { invoiceDocumentId: issued.documentId! });
    expect(first.oioublSha256).toBe(oioubl.sha256);
    expect(first.envelope).toContain(oioubl.sha256!);
    expect(first.envelope).toContain("ap-nemhandel-test");
    expect(first.appliedRules).toContain("DK-PEPPOL-SUBMIT-001");

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("is idempotent: a duplicate submission reuses the existing attempt record", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-peppol-idempotent-"));
    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);

    const issued = issueInvoice(db, root, { ...PUBLIC_INVOICE });
    expect(issued.ok).toBe(true);

    const first = submitPublicEInvoicePeppol(db, {
      invoiceDocumentId: issued.documentId!,
      accessPoint: ACCESS_POINT,
    });
    const second = submitPublicEInvoicePeppol(db, {
      invoiceDocumentId: issued.documentId!,
      accessPoint: ACCESS_POINT,
    });

    expect(first.ok).toBe(true);
    expect(first.duplicate).toBe(false);
    expect(second.ok).toBe(true);
    expect(second.duplicate).toBe(true);
    expect(second.submissionReference).toBe(first.submissionReference);

    const rows = db
      .query("SELECT id FROM peppol_submissions WHERE idempotency_key = ?")
      .all(first.idempotencyKey!) as Array<{ id: number }>;
    expect(rows).toHaveLength(1);

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("records an audit event linking invoice to submission attempt", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-peppol-audit-"));
    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);

    const issued = issueInvoice(db, root, { ...PUBLIC_INVOICE });
    expect(issued.ok).toBe(true);

    const result = submitPublicEInvoicePeppol(db, {
      invoiceDocumentId: issued.documentId!,
      accessPoint: ACCESS_POINT,
    });
    expect(result.ok).toBe(true);

    const auditRows = db
      .query(
        "SELECT event_type, entity_type, entity_id, message FROM audit_log WHERE event_type = 'public_einvoice_peppol_submission' ORDER BY id ASC",
      )
      .all() as Array<{ event_type: string; entity_type: string; entity_id: string; message: string }>;
    // One submission attempt -> exactly one audit event (idempotent re-runs do not append).
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]!.entity_type).toBe("document");
    expect(auditRows[0]!.entity_id).toBe(String(issued.documentId));
    expect(auditRows[0]!.message).toContain(result.submissionReference!);

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("fails clearly when access-point config is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-peppol-noconfig-"));
    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);

    const issued = issueInvoice(db, root, { ...PUBLIC_INVOICE });
    expect(issued.ok).toBe(true);

    const result = submitPublicEInvoicePeppol(db, {
      invoiceDocumentId: issued.documentId!,
      accessPoint: { accessPointId: "", endpointUrl: "", senderEndpointId: "" },
    });

    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("access-point");

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("fails clearly when required public-recipient OIOUBL metadata is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-peppol-missing-"));
    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);

    // Omit dueDate -> OIOUBL handoff validation fails -> submission must fail too.
    const { dueDate, ...withoutDueDate } = PUBLIC_INVOICE;
    const issued = issueInvoice(db, root, withoutDueDate);
    expect(issued.ok).toBe(true);

    const result = submitPublicEInvoicePeppol(db, {
      invoiceDocumentId: issued.documentId!,
      accessPoint: ACCESS_POINT,
    });

    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("dueDate");
    // No submission row written on failure.
    const rows = db.query("SELECT id FROM peppol_submissions").all() as Array<{ id: number }>;
    expect(rows).toHaveLength(0);

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("records a transport acknowledgement when one is supplied", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-peppol-ack-"));
    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);

    const issued = issueInvoice(db, root, { ...PUBLIC_INVOICE });
    expect(issued.ok).toBe(true);

    const result = submitPublicEInvoicePeppol(db, {
      invoiceDocumentId: issued.documentId!,
      accessPoint: ACCESS_POINT,
      acknowledgement: { transmissionId: "tx-9001", acknowledgedAt: "2026-05-20T10:00:00Z" },
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe("acknowledged");

    const row = db
      .query("SELECT status, transmission_id FROM peppol_submissions WHERE idempotency_key = ?")
      .get(result.idempotencyKey!) as { status: string; transmission_id: string | null };
    expect(row.status).toBe("acknowledged");
    expect(row.transmission_id).toBe("tx-9001");

    db.close();
    rmSync(root, { recursive: true, force: true });
  });
});

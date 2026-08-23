import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { companyPaths } from "./paths";
import { postJournalEntry, } from "./ledger";
import { promoteTempFile, removeIfExists, writeTempFileFor } from "./atomic-file";
import { insertAuditLog } from "./actor";
import { isValidIsoDate as looksLikeIsoDate } from "./dates";
import { roundDkk } from "./money";
import { companySequenceScope, fiscalYearLabelFromDate, nextSequenceValue, reserveSequenceValue } from "./sequences";
import { retainUntilForDate } from "./retention";

export type IssueCreditNoteInput = {
  originalInvoiceDocumentId: number;
  issueDate: string;
  reason: string;
  grossAmount?: number;
  creditNoteNumber?: string;
  createdBy?: string;
  createdByProgram?: string;
};

export type IssueCreditNoteResult = {
  ok: boolean;
  documentId?: number;
  creditNoteNumber?: string;
  originalInvoiceNumber?: string;
  storedPath?: string;
  sha256?: string;
  journalEntryId?: number;
  journalEntryNo?: string;
  appliedRules: string[];
  errors: string[];
};

const RULE_ID = "DK-CREDIT-NOTE-001";
const REVERSE_RULE_ID = "DK-INVOICE-BOOKKEEPING-REVERSE-002";

function sha256(text: string) {
  return createHash("sha256").update(text).digest("hex");
}


function creditNoteSequenceState(db: Database, issueDate: string) {
  const scope = fiscalYearLabelFromDate(db, issueDate);
  const row = db.query(`SELECT COALESCE(MAX(CAST(substr(invoice_no, -4) AS INTEGER)), 0) AS n FROM documents WHERE document_type = 'credit_note' AND invoice_no GLOB ?`).get(`CN-${scope}-[0-9][0-9][0-9][0-9]`) as { n: number };
  return { scope, currentFloor: Number(row.n ?? 0), sequenceScope: companySequenceScope(db, `CN-${scope}`) };
}

function nextCreditNoteNumber(db: Database, issueDate: string) {
  const { scope, currentFloor, sequenceScope } = creditNoteSequenceState(db, issueDate);
  const nextValue = nextSequenceValue(db, "credit_note", sequenceScope, currentFloor);
  return `CN-${scope}-${String(nextValue).padStart(4, "0")}`;
}

function validateManualCreditNoteNumberScope(db: Database, issueDate: string, creditNoteNumber: string) {
  const { scope } = creditNoteSequenceState(db, issueDate);
  const genericCanonical = /^CN-(\d{4})-(\d{4})$/.exec(creditNoteNumber);
  if (genericCanonical && genericCanonical[1] !== scope) {
    return `manual creditNoteNumber ${creditNoteNumber} does not match current fiscal scope ${scope}`;
  }
  return null;
}

function reserveManualCreditNoteNumber(db: Database, issueDate: string, creditNoteNumber: string) {
  const { scope, currentFloor, sequenceScope } = creditNoteSequenceState(db, issueDate);
  const match = new RegExp(`^CN-${scope.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-([0-9]{4})$`).exec(creditNoteNumber);
  if (!match) return { ok: true as const };
  const requestedValue = Number(match[1]);
  const reserved = reserveSequenceValue(db, "credit_note", sequenceScope, requestedValue, currentFloor);
  if (!reserved.ok) {
    return { ok: false as const, error: `manual creditNoteNumber ${creditNoteNumber} exceeds næste fortløbende nummer CN-${scope}-${String(reserved.expectedValue).padStart(4, "0")}` };
  }
  return { ok: true as const };
}


function scaledJournalAmount(amount: number, factor: number) {
  return roundDkk(amount * factor);
}

function creditNoteLinesFromOriginalJournal(db: Database, originalInvoiceDocumentId: number, originalGrossAmount: number, grossAmount: number) {
  if (!(originalGrossAmount > 0)) return null;

  const originalEntry = db.query(
    `SELECT id, entry_no
       FROM journal_entries
      WHERE document_id = ?
        AND reversal_of_entry_id IS NULL
      ORDER BY id ASC
      LIMIT 1`
  ).get(originalInvoiceDocumentId) as { id: number; entry_no: string } | null;
  if (!originalEntry) return null;

  const originalLines = db.query(
    `SELECT a.account_no, jl.debit_amount, jl.credit_amount, jl.vat_code, jl.text
       FROM journal_lines jl
       JOIN accounts a ON a.id = jl.account_id
      WHERE jl.journal_entry_id = ?
      ORDER BY jl.id ASC`
  ).all(originalEntry.id) as Array<{
    account_no: string;
    debit_amount: number;
    credit_amount: number;
    vat_code: string | null;
    text: string | null;
  }>;
  if (originalLines.length === 0) return null;

  const factor = grossAmount / originalGrossAmount;
  const reversedLines = originalLines
    .map((line) => ({
      accountNo: line.account_no,
      debitAmount: line.credit_amount > 0 ? scaledJournalAmount(line.credit_amount, factor) : undefined,
      creditAmount: line.debit_amount > 0 ? scaledJournalAmount(line.debit_amount, factor) : undefined,
      vatCode: line.vat_code ?? undefined,
      text: line.text ?? undefined,
    }))
    .filter((line) => (line.debitAmount ?? 0) > 0 || (line.creditAmount ?? 0) > 0);

  return reversedLines.length > 0 ? reversedLines : null;
}

function fallbackCreditNoteLines(originalInvoiceNo: string, payload: any, grossAmount: number, netAmount: number, vatAmount: number) {
  const vatTreatment = payload?.vatTreatment ?? "standard";
  const isReverseCharge = vatTreatment === "domestic_reverse_charge" || vatTreatment === "foreign_reverse_charge";
  const lines: Array<{ accountNo: string; debitAmount?: number; creditAmount?: number; vatCode?: string; text: string }> = [
    {
      accountNo: "1000",
      debitAmount: netAmount,
      vatCode: isReverseCharge ? "REVERSE_CHARGE_EXEMPT" : "DK_SALE_25",
      text: `Revenue reversal ${originalInvoiceNo}`
    },
    { accountNo: "1100", creditAmount: grossAmount, text: `Receivable reversal ${originalInvoiceNo}` },
  ];
  if (!isReverseCharge && vatAmount > 0) {
    lines.splice(1, 0, { accountNo: "1200", debitAmount: vatAmount, text: `VAT reversal ${originalInvoiceNo}` });
  }
  return { lines, isReverseCharge };
}

export function issueCreditNote(db: Database, companyRoot: string, input: IssueCreditNoteInput): IssueCreditNoteResult {
  const errors: string[] = [];
  if (!Number.isInteger(input.originalInvoiceDocumentId) || input.originalInvoiceDocumentId <= 0) errors.push("originalInvoiceDocumentId must be a positive integer");
  if (!looksLikeIsoDate(input.issueDate)) errors.push("issueDate must be YYYY-MM-DD");
  if (typeof input.reason !== "string" || input.reason.trim().length === 0) errors.push("reason is required");
  if (errors.length > 0) return { ok: false, appliedRules: [RULE_ID], errors };

  const original = db.query(
    `SELECT id, invoice_no, amount_inc_vat, currency, vat_amount, payload_json, document_type
     FROM documents WHERE id = ?`
  ).get(input.originalInvoiceDocumentId) as any | null;
  if (!original) return { ok: false, appliedRules: [RULE_ID], errors: [`invoice document ${input.originalInvoiceDocumentId} does not exist`] };
  if (original.document_type !== "issued_invoice") return { ok: false, appliedRules: [RULE_ID], errors: [`document ${input.originalInvoiceDocumentId} is not an issued invoice`] };

  const payload = original.payload_json ? JSON.parse(original.payload_json) : null;
  const originalGrossAmount = roundDkk(Number(original.amount_inc_vat ?? payload?.totals?.grossAmount ?? 0));
  const originalVatAmount = roundDkk(Number(original.vat_amount ?? payload?.totals?.vatAmount ?? 0));
  const creditedSoFar = roundDkk(Number((db.query("SELECT COALESCE(SUM(amount_inc_vat), 0) AS total FROM documents WHERE document_type = 'credit_note' AND payment_details = ?").get(original.invoice_no) as { total: number }).total ?? 0));
  const remainingGrossAmount = roundDkk(originalGrossAmount - creditedSoFar);
  if (remainingGrossAmount <= 0) return { ok: false, appliedRules: [RULE_ID], errors: [`invoice ${original.invoice_no} is already fully credited`] };

  const grossAmount = roundDkk(input.grossAmount ?? remainingGrossAmount);
  if (!Number.isFinite(grossAmount) || grossAmount <= 0) return { ok: false, appliedRules: [RULE_ID], errors: ["grossAmount must be a positive number when present"] };
  if (grossAmount > remainingGrossAmount) return { ok: false, appliedRules: [RULE_ID], errors: [`credit amount ${grossAmount} exceeds remaining creditable amount ${remainingGrossAmount}`] };

  const vatRatio = originalGrossAmount > 0 ? originalVatAmount / originalGrossAmount : 0;
  const vatAmount = roundDkk(grossAmount * vatRatio);
  const netAmount = roundDkk(grossAmount - vatAmount);
  const explicitCreditNoteNumber = input.creditNoteNumber?.trim();
  if (explicitCreditNoteNumber) {
    const scopeError = validateManualCreditNoteNumberScope(db, input.issueDate, explicitCreditNoteNumber);
    if (scopeError) return { ok: false, appliedRules: [RULE_ID], errors: [scopeError] };
  }

  const paths = companyPaths(companyRoot);
  mkdirSync(paths.invoicesIssued, { recursive: true });
  let tempPath: string | undefined;
  let storedPath: string | undefined;

  try {
    const result = db.transaction(() => {
      let creditNoteNumber = explicitCreditNoteNumber;
      if (creditNoteNumber) {
        const reserved = reserveManualCreditNoteNumber(db, input.issueDate, creditNoteNumber);
        if (!reserved.ok) return { ok: false as const, error: reserved.error };
      } else {
        creditNoteNumber = nextCreditNoteNumber(db, input.issueDate);
      }

      const creditPayload = {
        type: "credit_note",
        creditNoteNumber,
        originalInvoiceNumber: original.invoice_no,
        originalInvoiceDocumentId: original.id,
        issueDate: input.issueDate,
        reason: input.reason.trim(),
        grossAmount,
        vatAmount,
        netAmount,
        creditedSoFar,
        remainingAfterThisCredit: roundDkk(remainingGrossAmount - grossAmount),
        issuedAt: new Date().toISOString(),
      };
      const serialized = JSON.stringify(creditPayload, null, 2);
      const hash = sha256(serialized);
      storedPath = join(paths.invoicesIssued, `${creditNoteNumber}.json`);
      tempPath = writeTempFileFor(storedPath, serialized);

      const doc = db.query(
        `INSERT INTO documents (
          document_no, source, original_filename, stored_path, mime_type, sha256_hash,
          supplier_name, invoice_no, invoice_date, amount_inc_vat, currency, status,
          document_type, delivery_description, sender_name, sender_address, sender_vat_cvr,
          recipient_name, recipient_address, recipient_vat_cvr, vat_amount, payment_details, exemption_code, payload_json, retain_until
        ) VALUES (?, 'rentemester', ?, ?, 'application/json', ?, ?, ?, ?, ?, ?, 'issued', 'credit_note', ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
        RETURNING id`
      ).get(
        creditNoteNumber,
        `${creditNoteNumber}.json`,
        storedPath,
        hash,
        payload?.seller?.name ?? null,
        creditNoteNumber,
        input.issueDate,
        grossAmount,
        original.currency ?? 'DKK',
        `Credit note for ${original.invoice_no}: ${input.reason.trim()}`,
        payload?.seller?.name ?? null,
        payload?.seller?.address ?? null,
        payload?.seller?.vatOrCvr ?? null,
        payload?.buyer?.name ?? null,
        payload?.buyer?.address ?? null,
        payload?.buyer?.vatOrCvr ?? null,
        vatAmount,
        original.invoice_no,
        serialized,
        retainUntilForDate(db, input.issueDate),
      ) as { id: number };

      const fallback = fallbackCreditNoteLines(creditNoteNumber, payload, grossAmount, netAmount, vatAmount);
      const journal = postJournalEntry(db, {
        transactionDate: input.issueDate,
        text: `Credit note ${creditNoteNumber} for invoice ${original.invoice_no}`,
        documentId: doc.id,
        createdBy: input.createdBy,
        createdByProgram: input.createdByProgram,
        lines: creditNoteLinesFromOriginalJournal(db, original.id, originalGrossAmount, grossAmount) ?? fallback.lines,
      });
      if (!journal.ok) throw new Error(JSON.stringify({ appliedRules: journal.appliedRules, errors: journal.errors }));

      insertAuditLog(db, {
        eventType: "credit_note_issue",
        entityType: "document",
        entityId: doc.id,
        message: `Issued credit note ${creditNoteNumber} for ${original.invoice_no}`,
        createdBy: input.createdBy,
        createdByProgram: input.createdByProgram,
      });

      return { ok: true as const, docId: doc.id, creditNoteNumber, sha256: hash, journal, isReverseCharge: fallback.isReverseCharge };
    }, { immediate: true })();

    if (!result.ok) return { ok: false, appliedRules: [RULE_ID], errors: [result.error] };
    promoteTempFile(tempPath!, storedPath!);
    return {
      ok: true,
      documentId: result.docId,
      creditNoteNumber: result.creditNoteNumber,
      originalInvoiceNumber: original.invoice_no,
      storedPath,
      sha256: result.sha256,
      journalEntryId: result.journal.entryId,
      journalEntryNo: result.journal.entryNo,
      appliedRules: [...new Set([RULE_ID, ...(result.journal.appliedRules ?? []), ...(result.isReverseCharge ? [REVERSE_RULE_ID] : [])])],
      errors: [],
    };
  } catch (error) {
    if (tempPath) removeIfExists(tempPath);
    const parsed = typeof error === "object" && error && "message" in error ? (() => {
      try { return JSON.parse(String((error as any).message)); } catch { return null; }
    })() : null;
    return {
      ok: false,
      appliedRules: [...new Set([RULE_ID, ...((parsed?.appliedRules as string[] | undefined) ?? [])])],
      errors: (parsed?.errors as string[] | undefined) ?? [String(error)],
    };
  }
}

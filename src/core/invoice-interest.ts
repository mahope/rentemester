import type { Database } from "bun:sqlite";
import { postJournalEntry, type JournalPostResult } from "./ledger";
import { getInvoiceStatus } from "./invoice-payments";
import { insertAuditLog } from "./actor";
import { isValidIsoDate as looksLikeIsoDate } from "./dates";
import { accrueInterestDkk, addDkk, roundDkk } from "./money";

const RULE_ID = "DK-INVOICE-LATE-INTEREST-001";
const REGISTER_RULE_ID = "DK-INVOICE-LATE-INTEREST-REGISTER-001";
const BOOKKEEPING_RULE_ID = "DK-INVOICE-LATE-INTEREST-BOOKKEEPING-001";

export type CalculateInvoiceLateInterestInput = {
  invoiceDocumentId: number;
  asOfDate: string;
  referenceRatePercent: number;
};

export type CalculateInvoiceLateInterestResult = {
  ok: boolean;
  invoiceDocumentId?: number;
  invoiceNumber?: string;
  asOfDate?: string;
  effectiveDueDate?: string;
  overdueDays?: number;
  principalOpenBalance?: number;
  referenceRatePercent?: number;
  annualInterestRatePercent?: number;
  accruedInterestAmount?: number;
  appliedRules: string[];
  errors: string[];
};

export type RegisterInvoiceLateInterestInput = CalculateInvoiceLateInterestInput & {
  note?: string;
};

export type RegisterInvoiceLateInterestResult = CalculateInvoiceLateInterestResult & {
  claimId?: number;
  claimDate?: string;
  claimOpenBalance?: number;
};

export type PostInvoiceLateInterestToLedgerInput = {
  invoiceDocumentId: number;
  claimId?: number;
  transactionDate?: string;
  receivableAccountNo?: string;
  interestIncomeAccountNo?: string;
  createdBy?: string;
  createdByProgram?: string;
};

export type PostInvoiceLateInterestToLedgerResult = JournalPostResult & {
  claimId?: number;
  invoiceDocumentId?: number;
  invoiceNumber?: string;
  claimDate?: string;
  accruedInterestAmount?: number;
  claimOpenBalance?: number;
};

export function calculateInvoiceLateInterest(db: Database, input: CalculateInvoiceLateInterestInput): CalculateInvoiceLateInterestResult {
  const errors: string[] = [];
  if (!Number.isInteger(input.invoiceDocumentId) || input.invoiceDocumentId <= 0) errors.push("invoiceDocumentId must be a positive integer");
  if (!looksLikeIsoDate(input.asOfDate)) errors.push("asOfDate must be YYYY-MM-DD");
  if (!Number.isFinite(input.referenceRatePercent)) errors.push("referenceRatePercent must be a finite number");
  if (errors.length > 0) return { ok: false, appliedRules: [RULE_ID], errors };

  const status = getInvoiceStatus(db, input.invoiceDocumentId, input.asOfDate);
  if (!status.ok) return { ok: false, appliedRules: [RULE_ID], errors: status.errors };

  const principalOpenBalance = roundDkk(Number(status.openBalance ?? 0));
  const overdueDays = Number(status.overdueDays ?? 0);
  const annualInterestRatePercent = roundDkk(addDkk(Number(input.referenceRatePercent), 8));
  const accruedInterestAmount = overdueDays > 0 && principalOpenBalance > 0
    ? accrueInterestDkk(principalOpenBalance, annualInterestRatePercent, overdueDays)
    : 0;

  return {
    ok: true,
    invoiceDocumentId: input.invoiceDocumentId,
    invoiceNumber: status.invoiceNumber,
    asOfDate: input.asOfDate,
    effectiveDueDate: status.effectiveDueDate,
    overdueDays,
    principalOpenBalance,
    referenceRatePercent: roundDkk(Number(input.referenceRatePercent)),
    annualInterestRatePercent,
    accruedInterestAmount,
    appliedRules: [RULE_ID],
    errors: [],
  };
}

export function registerInvoiceLateInterest(db: Database, input: RegisterInvoiceLateInterestInput): RegisterInvoiceLateInterestResult {
  const calculation = calculateInvoiceLateInterest(db, input);
  if (!calculation.ok) return { ...calculation, appliedRules: [...new Set([...(calculation.appliedRules ?? []), REGISTER_RULE_ID])] };
  if (!(Number(calculation.accruedInterestAmount ?? 0) > 0)) {
    return {
      ...calculation,
      ok: false,
      appliedRules: [...new Set([...(calculation.appliedRules ?? []), REGISTER_RULE_ID])],
      errors: ["late interest must be positive before it can be registered"],
    };
  }

  const existing = db.query(
    `SELECT id FROM invoice_interest_claims WHERE invoice_document_id = ? AND claim_date = ? AND reference_rate_percent = ? LIMIT 1`
  ).get(input.invoiceDocumentId, input.asOfDate, roundDkk(Number(input.referenceRatePercent))) as { id: number } | null;
  if (existing) {
    return {
      ...calculation,
      ok: false,
      appliedRules: [RULE_ID, REGISTER_RULE_ID],
      errors: [`late interest for invoice ${input.invoiceDocumentId} is already registered for ${input.asOfDate} at reference rate ${roundDkk(Number(input.referenceRatePercent))}`],
    };
  }

  // Interest is always recomputed over the full window from the due date, so a
  // second claim at a later as-of date would re-bill the days already covered
  // by an earlier claim. Forbid more than one unposted (open) interest claim
  // per invoice to prevent that double-charge.
  const openClaim = db.query(
    `SELECT c.id FROM invoice_interest_claims c
     LEFT JOIN invoice_interest_postings p ON p.interest_claim_id = c.id
     WHERE c.invoice_document_id = ? AND p.id IS NULL
     LIMIT 1`
  ).get(input.invoiceDocumentId) as { id: number } | null;
  if (openClaim) {
    return {
      ...calculation,
      ok: false,
      appliedRules: [RULE_ID, REGISTER_RULE_ID],
      errors: [`invoice ${input.invoiceDocumentId} already has an open (unposted) late-interest claim; post or settle it before registering another`],
    };
  }

  const inserted = db.query(
    `INSERT INTO invoice_interest_claims (
      invoice_document_id, claim_date, reference_rate_percent, annual_interest_rate_percent,
      overdue_days, principal_open_balance, amount_dkk, note
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING id`
  ).get(
    input.invoiceDocumentId,
    input.asOfDate,
    roundDkk(Number(input.referenceRatePercent)),
    roundDkk(Number(calculation.annualInterestRatePercent)),
    Number(calculation.overdueDays),
    roundDkk(Number(calculation.principalOpenBalance)),
    roundDkk(Number(calculation.accruedInterestAmount)),
    input.note ?? null,
  ) as { id: number };

  insertAuditLog(db, {
    eventType: "invoice_interest_register",
    entityType: "invoice_interest_claim",
    entityId: inserted.id,
    message: `Registered late interest ${roundDkk(Number(calculation.accruedInterestAmount))} on invoice ${calculation.invoiceNumber}`,
  });

  const statusAfter = getInvoiceStatus(db, input.invoiceDocumentId, input.asOfDate);
  return {
    ...calculation,
    ok: true,
    claimId: inserted.id,
    claimDate: input.asOfDate,
    claimOpenBalance: statusAfter.ok ? statusAfter.claimOpenBalance : undefined,
    appliedRules: [RULE_ID, REGISTER_RULE_ID],
    errors: [],
  };
}

export function postInvoiceLateInterestToLedger(db: Database, input: PostInvoiceLateInterestToLedgerInput): PostInvoiceLateInterestToLedgerResult {
  if (!Number.isInteger(input.invoiceDocumentId) || input.invoiceDocumentId <= 0) {
    return { ok: false, appliedRules: [BOOKKEEPING_RULE_ID], errors: ["invoiceDocumentId must be a positive integer"] };
  }

  const claim = db.query(
    `SELECT c.id, c.invoice_document_id, c.claim_date, c.amount_dkk, d.invoice_no
     FROM invoice_interest_claims c
     JOIN documents d ON d.id = c.invoice_document_id
     WHERE c.invoice_document_id = ?
       AND (? IS NULL OR c.id = ?)
     ORDER BY c.claim_date ASC, c.id ASC
     LIMIT 1`
  ).get(input.invoiceDocumentId, input.claimId ?? null, input.claimId ?? null) as {
    id: number;
    invoice_document_id: number;
    claim_date: string;
    amount_dkk: number;
    invoice_no: string;
  } | null;

  if (!claim) {
    return { ok: false, appliedRules: [BOOKKEEPING_RULE_ID], errors: [input.claimId ? `interest claim ${input.claimId} does not exist for invoice ${input.invoiceDocumentId}` : `invoice ${input.invoiceDocumentId} has no registered late-interest claim`] };
  }

  const existing = db.query(
    `SELECT p.id, p.journal_entry_id, j.entry_no
     FROM invoice_interest_postings p
     JOIN journal_entries j ON j.id = p.journal_entry_id
     WHERE p.interest_claim_id = ?`
  ).get(claim.id) as { id: number; journal_entry_id: number; entry_no: string } | null;

  if (existing) {
    return {
      ok: false,
      claimId: claim.id,
      invoiceDocumentId: claim.invoice_document_id,
      invoiceNumber: claim.invoice_no,
      claimDate: claim.claim_date,
      accruedInterestAmount: roundDkk(Number(claim.amount_dkk)),
      appliedRules: [BOOKKEEPING_RULE_ID],
      errors: [`interest claim ${claim.id} is already posted in journal entry ${existing.entry_no}`],
    };
  }

  const amount = roundDkk(Number(claim.amount_dkk));
  try {
    return db.transaction(() => {
      const journal = postJournalEntry(db, {
        transactionDate: input.transactionDate ?? claim.claim_date,
        text: `Late interest ${claim.invoice_no}`,
        documentId: claim.invoice_document_id,
        createdBy: input.createdBy,
        createdByProgram: input.createdByProgram,
        lines: [
          { accountNo: input.receivableAccountNo ?? "1100", debitAmount: amount, text: `Late-interest receivable ${claim.invoice_no}` },
          { accountNo: input.interestIncomeAccountNo ?? "1010", creditAmount: amount, text: `Late-interest income ${claim.invoice_no}` },
        ],
      });
      if (!journal.ok) {
        return { ...journal, claimId: claim.id, invoiceDocumentId: claim.invoice_document_id, invoiceNumber: claim.invoice_no, claimDate: claim.claim_date, accruedInterestAmount: amount, appliedRules: [...new Set([...(journal.appliedRules ?? []), BOOKKEEPING_RULE_ID])] };
      }

      db.run(
        `INSERT INTO invoice_interest_postings (interest_claim_id, journal_entry_id) VALUES (?, ?)`,
        [claim.id, journal.entryId!],
      );

      insertAuditLog(db, {
        eventType: "invoice_interest_post",
        entityType: "invoice_interest_claim",
        entityId: claim.id,
        message: `Posted late interest ${amount} for invoice ${claim.invoice_no} in journal entry ${journal.entryNo}`,
        createdBy: input.createdBy,
        createdByProgram: input.createdByProgram,
      });

      const statusAfter = getInvoiceStatus(db, claim.invoice_document_id, input.transactionDate ?? claim.claim_date);
      return {
        ...journal,
        claimId: claim.id,
        invoiceDocumentId: claim.invoice_document_id,
        invoiceNumber: claim.invoice_no,
        claimDate: claim.claim_date,
        accruedInterestAmount: amount,
        claimOpenBalance: statusAfter.ok ? statusAfter.claimOpenBalance : undefined,
        appliedRules: [...new Set([...(journal.appliedRules ?? []), BOOKKEEPING_RULE_ID])],
      };
    })();
  } catch (error) {
    return {
      ok: false,
      claimId: claim.id,
      invoiceDocumentId: claim.invoice_document_id,
      invoiceNumber: claim.invoice_no,
      claimDate: claim.claim_date,
      accruedInterestAmount: amount,
      appliedRules: [BOOKKEEPING_RULE_ID],
      errors: [String(error)],
    };
  }
}

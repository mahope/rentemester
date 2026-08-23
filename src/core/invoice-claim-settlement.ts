import type { Database } from "bun:sqlite";
import { getInvoiceStatus } from "./invoice-payments";
import { postJournalEntry, type JournalPostResult } from "./ledger";
import { insertAuditLog } from "./actor";
import { roundDkk } from "./money";

const RULE_ID = "DK-INVOICE-CLAIM-SETTLEMENT-001";

export type SettleInvoiceClaimsFromBankInput = {
  invoiceDocumentId: number;
  bankTransactionId?: number;
  bankTransactionReference?: string;
  paymentDate?: string;
  amount?: number;
  bankAccountNo?: string;
  receivableAccountNo?: string;
  createdBy?: string;
  createdByProgram?: string;
};

export type SettleInvoiceClaimsFromBankResult = JournalPostResult & {
  claimPaymentId?: number;
  invoiceNumber?: string;
  remainingClaimOpenBalance?: number;
};


function getIncomingClaimBankTransaction(db: Database, input: SettleInvoiceClaimsFromBankInput) {
  if (input.bankTransactionId === undefined && !input.bankTransactionReference) {
    return { error: "bankTransactionId or bankTransactionReference is required" };
  }
  const bank = (input.bankTransactionId !== undefined
    ? db.query(`SELECT id, transaction_date, amount, text, reference FROM bank_transactions WHERE id = ?`).get(input.bankTransactionId)
    : db.query(`SELECT id, transaction_date, amount, text, reference FROM bank_transactions WHERE reference = ? ORDER BY id DESC LIMIT 1`).get(input.bankTransactionReference!)) as { id: number; transaction_date: string; amount: number; text: string; reference: string | null } | null;
  if (!bank) {
    return { error: input.bankTransactionId !== undefined ? `bank transaction ${input.bankTransactionId} does not exist` : `no bank transaction found with reference ${input.bankTransactionReference}` };
  }
  return { bank };
}

export function settleInvoiceClaimsFromBank(db: Database, input: SettleInvoiceClaimsFromBankInput): SettleInvoiceClaimsFromBankResult {
  if (!Number.isInteger(input.invoiceDocumentId) || input.invoiceDocumentId <= 0) {
    return { ok: false, appliedRules: [RULE_ID], errors: ["invoiceDocumentId must be a positive integer"] };
  }
  if (input.bankTransactionId !== undefined && (!Number.isInteger(input.bankTransactionId) || input.bankTransactionId <= 0)) {
    return { ok: false, appliedRules: [RULE_ID], errors: ["bankTransactionId must be a positive integer when present"] };
  }

  const selected = getIncomingClaimBankTransaction(db, input);
  if (selected.error) return { ok: false, appliedRules: [RULE_ID], errors: [selected.error] };
  const bank = selected.bank!;
  if (Number(bank.amount) <= 0) return { ok: false, appliedRules: [RULE_ID], errors: [`bank transaction ${bank.id} is not an incoming claim receipt`] };

  const invoice = db.query(
    `SELECT id, invoice_no FROM documents WHERE id = ? AND document_type = 'issued_invoice'`
  ).get(input.invoiceDocumentId) as { id: number; invoice_no: string } | null;
  if (!invoice) return { ok: false, appliedRules: [RULE_ID], errors: [`invoice document ${input.invoiceDocumentId} is not an issued invoice`] };

  const existingJournal = db.query(`SELECT id FROM journal_entries WHERE source_bank_transaction_id = ? LIMIT 1`).get(bank.id) as { id: number } | null;
  if (existingJournal) return { ok: false, appliedRules: [RULE_ID], errors: [`bank transaction ${bank.id} is already linked to journal entry ${existingJournal.id}`] };
  if (db.query(`SELECT id FROM invoice_claim_payments WHERE bank_transaction_id = ? LIMIT 1`).get(bank.id)) {
    return { ok: false, appliedRules: [RULE_ID], errors: [`bank transaction ${bank.id} is already applied to an invoice claim payment`] };
  }
  if (db.query(`SELECT id FROM invoice_payments WHERE bank_transaction_id = ? LIMIT 1`).get(bank.id)) {
    return { ok: false, appliedRules: [RULE_ID], errors: [`bank transaction ${bank.id} is already applied to an invoice principal payment`] };
  }

  const status = getInvoiceStatus(db, input.invoiceDocumentId);
  if (!status.ok) return { ok: false, appliedRules: [RULE_ID], errors: status.errors };
  const principalOpenBalance = roundDkk(Number(status.openBalance ?? 0));
  const claimOpenBalance = roundDkk(Number(status.claimOpenBalance ?? 0));
  if (principalOpenBalance !== 0) return { ok: false, appliedRules: [RULE_ID], errors: [`invoice ${invoice.invoice_no} still has principal open balance ${principalOpenBalance}; settle principal before claim receipts`] };
  if (!(claimOpenBalance > 0)) return { ok: false, appliedRules: [RULE_ID], errors: [`invoice ${invoice.invoice_no} has no outstanding claim balance`] };

  const amount = roundDkk(input.amount ?? Number(bank.amount));
  if (amount > claimOpenBalance) return { ok: false, appliedRules: [RULE_ID], errors: [`claim receipt amount ${amount} exceeds claim open balance ${claimOpenBalance}`] };
  const paymentDate = input.paymentDate ?? bank.transaction_date;

  try {
    const result = db.transaction(() => {
      const payment = db.query(
        `INSERT INTO invoice_claim_payments (invoice_document_id, bank_transaction_id, payment_date, amount, currency, note)
         VALUES (?, ?, ?, ?, 'DKK', ?)
         RETURNING id`
      ).get(input.invoiceDocumentId, bank.id, paymentDate, amount, `Claim settlement from transaction ${bank.id}`) as { id: number };

      insertAuditLog(db, {
        eventType: "invoice_claim_payment_apply",
        entityType: "invoice_claim_payment",
        entityId: payment.id,
        message: `Applied claim receipt ${amount} to invoice ${invoice.invoice_no}`,
        createdBy: input.createdBy,
        createdByProgram: input.createdByProgram,
      });

      const journal = postJournalEntry(db, {
        transactionDate: paymentDate,
        text: `Customer claim payment for invoice ${invoice.invoice_no}`,
        sourceBankTransactionId: bank.id,
        documentId: input.invoiceDocumentId,
        createdBy: input.createdBy,
        createdByProgram: input.createdByProgram,
        lines: [
          { accountNo: input.bankAccountNo ?? "2000", debitAmount: amount, text: `Bank claim receipt ${invoice.invoice_no}` },
          { accountNo: input.receivableAccountNo ?? "1100", creditAmount: amount, text: `Claim receivable settlement ${invoice.invoice_no}` },
        ],
      });
      if (!journal.ok) throw new Error(JSON.stringify({ appliedRules: journal.appliedRules, errors: journal.errors }));

      const after = getInvoiceStatus(db, input.invoiceDocumentId);
      if (!after.ok) throw new Error(JSON.stringify({ errors: after.errors }));

      return {
        ...journal,
        claimPaymentId: payment.id,
        invoiceNumber: invoice.invoice_no,
        remainingClaimOpenBalance: roundDkk(Number(after.claimOpenBalance ?? 0)),
        appliedRules: [...new Set([RULE_ID, ...(journal.appliedRules ?? [])])],
      };
    })();
    return result;
  } catch (error) {
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

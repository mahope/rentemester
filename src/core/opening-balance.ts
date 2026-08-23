// Opening balance (primobalance) — issue #179.
//
// A real business adopting Rentemester has accounting history. The opening
// balance is a single, audited, special journal entry that establishes
// per-account opening balances as of a cut-over date, so the books continue
// correctly. It is the generic landing zone the Dinero import (#173) and the
// additional importers (#185) write into.
//
// Design constraints (must merge cleanly with 6 other parallel branches):
//  - The opening entry is posted via the EXISTING `postJournalEntry` export —
//    nothing in `src/core/ledger.ts` is changed. The entry therefore inherits
//    the hash chain, append-only protection and audit log for free.
//  - "Primobalance already done" is tracked in a NEW table `opening_balances`
//    (one row per company), so no ALTER migration on an existing table is
//    needed — `migrate()` picks the CREATE TABLE IF NOT EXISTS up automatically.
//  - Money is integer øre throughout; balance is checked in øre.

import type { Database } from "bun:sqlite";
import { postJournalEntry } from "./ledger";
import { insertAuditLog } from "./actor";
import { isValidIsoDate } from "./dates";
import { toOre } from "./money";
import type { JournalEntryId } from "./ids";

// Recognisable text prefix that flags a journal entry as THE opening entry.
// `postOpeningBalance` prepends it; readers can detect the primo entry by it.
export const OPENING_BALANCE_TEXT = "Primobalance";

export type OpeningBalanceLineInput = {
  accountNo: string;
  debitAmount?: number;
  creditAmount?: number;
  text?: string;
};

export type OpeningBalanceInput = {
  // Cut-over date — the day the opening balances are established as of. The
  // opening journal entry is posted with this transaction date.
  cutOverDate: string;
  lines: OpeningBalanceLineInput[];
  note?: string;
  createdBy?: string;
  createdByProgram?: string;
};

export type OpeningBalanceResult = {
  ok: boolean;
  entryId?: JournalEntryId;
  entryNo?: string;
  entryHash?: string;
  cutOverDate?: string;
  appliedRules: string[];
  errors: string[];
};

export type OpeningBalanceRecord = {
  cutOverDate: string;
  journalEntryId: number;
  journalEntryNo: string;
  createdAt: string;
};

// The primobalance is, by construction, a balanced journal entry: the
// debits-equal-credits requirement is the existing BALANCED-001 rule. No new
// rule ID is introduced — the opening entry posts through postJournalEntry,
// which already applies BALANCED + APPEND-ONLY.
const OPENING_BALANCE_RULE = "DK-BOOKKEEPING-BALANCED-001";

/**
 * Returns the recorded primobalance for this company, or null if none has been
 * posted. Exactly one row can exist (enforced by the single-row table).
 */
export function getOpeningBalance(db: Database): OpeningBalanceRecord | null {
  const row = db
    .query(
      `SELECT cut_over_date, journal_entry_id, journal_entry_no, created_at
         FROM opening_balances
        ORDER BY id ASC
        LIMIT 1`,
    )
    .get() as
    | { cut_over_date: string; journal_entry_id: number; journal_entry_no: string; created_at: string }
    | null;
  if (!row) return null;
  return {
    cutOverDate: row.cut_over_date,
    journalEntryId: row.journal_entry_id,
    journalEntryNo: row.journal_entry_no,
    createdAt: row.created_at,
  };
}

/**
 * Posts the company's opening balance (primobalance).
 *
 * The opening balance is a single balanced journal entry (debits == credits,
 * checked in øre) flagged with the `OPENING_BALANCE_TEXT` prefix. It is
 * idempotent: exactly one primobalance per company — a second call is
 * rejected. Validation (balanced, accounts exist, sane date, two-sided lines)
 * is delegated to `postJournalEntry`; the unbalanced/invalid-account/bad-date
 * cases therefore never write a row.
 */
export function postOpeningBalance(db: Database, input: OpeningBalanceInput): OpeningBalanceResult {
  const appliedRules = [OPENING_BALANCE_RULE];
  const errors: string[] = [];

  const cutOverDate = typeof input.cutOverDate === "string" ? input.cutOverDate.trim() : "";
  if (!isValidIsoDate(cutOverDate)) {
    errors.push("cut-over date must be present in YYYY-MM-DD format");
  }

  const lines = Array.isArray(input.lines) ? input.lines : [];
  if (lines.length < 2) {
    errors.push("opening balance requires at least two lines (a balanced primobalance)");
  }

  // Pre-flight balance check in øre so an unbalanced primo fails with a clear
  // message even before the journal-entry validator runs.
  let debitOre = 0n;
  let creditOre = 0n;
  for (const line of lines) {
    const debit = typeof line.debitAmount === "number" && Number.isFinite(line.debitAmount) ? line.debitAmount : 0;
    const credit = typeof line.creditAmount === "number" && Number.isFinite(line.creditAmount) ? line.creditAmount : 0;
    debitOre += toOre(debit);
    creditOre += toOre(credit);
  }
  if (lines.length >= 2 && debitOre !== creditOre) {
    errors.push(`opening balance must balance: debits != credits (${debitOre} != ${creditOre} øre)`);
  }

  if (errors.length > 0) return { ok: false, appliedRules, errors };

  // Idempotency: exactly one primobalance per company.
  const existing = getOpeningBalance(db);
  if (existing) {
    return {
      ok: false,
      appliedRules,
      errors: [
        `opening balance already posted as journal entry ${existing.journalEntryNo} (cut-over ${existing.cutOverDate}); a company can only have one primobalance`,
      ],
    };
  }

  const note = typeof input.note === "string" && input.note.trim().length > 0 ? ` — ${input.note.trim()}` : "";
  const post = postJournalEntry(db, {
    transactionDate: cutOverDate,
    text: `${OPENING_BALANCE_TEXT} pr. ${cutOverDate}${note}`,
    createdBy: input.createdBy,
    createdByProgram: input.createdByProgram,
    lines: lines.map((line) => ({
      accountNo: line.accountNo,
      debitAmount: line.debitAmount,
      creditAmount: line.creditAmount,
      text: line.text ?? `${OPENING_BALANCE_TEXT} ${line.accountNo}`,
    })),
  });

  if (!post.ok || post.entryId == null || post.entryNo == null) {
    return { ok: false, appliedRules: [...appliedRules, ...post.appliedRules], errors: post.errors };
  }

  // Record the primobalance marker and an explicit audit-log entry. The marker
  // row is what makes a second call idempotent; the audit-log row makes the
  // primobalance event independently visible alongside the journal_post event.
  db.transaction(() => {
    db.run(
      `INSERT INTO opening_balances (cut_over_date, journal_entry_id, journal_entry_no)
       VALUES (?, ?, ?)`,
      [cutOverDate, post.entryId!, post.entryNo!],
    );
    insertAuditLog(db, {
      eventType: "opening_balance_post",
      entityType: "journal_entry",
      entityId: post.entryId,
      message: `Posted opening balance (primobalance) pr. ${cutOverDate} as ${post.entryNo}`,
      createdBy: input.createdBy,
      createdByProgram: input.createdByProgram,
    });
  })();

  return {
    ok: true,
    entryId: post.entryId,
    entryNo: post.entryNo,
    entryHash: post.entryHash,
    cutOverDate,
    appliedRules: [...new Set([...appliedRules, ...post.appliedRules])],
    errors: [],
  };
}

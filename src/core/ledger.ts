import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { getInvoiceStatus } from "./invoice-payments";
import { currentRuleBundleVersion } from "./rules-metadata";
import { insertAuditLog, resolveActor } from "./actor";
import { validateJournalTransactionDate } from "./periods";
import { companySequenceScope, fiscalYearLabelFromDate, nextSequenceValue } from "./sequences";
import { isValidIsoDate as looksLikeIsoDate } from "./dates";
import { retainUntilForDate } from "./retention";
import { resolveOpenExceptionsForBankTransaction } from "./exceptions";
import { compareDkk, fromOre, roundDkk, roundRate6, toOre } from "./money";
import { asJournalEntryId, type JournalEntryId } from "./ids";

export type JournalLineInput = {
  accountNo: string;
  debitAmount?: number;
  creditAmount?: number;
  vatCode?: string;
  text?: string;
};

export type JournalEntryInput = {
  transactionDate: string;
  text: string;
  documentId?: number;
  sourceBankTransactionId?: number;
  currency?: string;
  amountForeign?: number;
  amountDkk?: number;
  fxRateToDkk?: number;
  createdBy?: string;
  createdByProgram?: string;
  // When true the entry is a migration posting replayed from another
  // accounting system (the Dinero import, #195): the income/expense
  // document-evidence requirement is waived because the original receipt has
  // not been ingested into Rentemester yet (#196 attaches the bilag later).
  // The entry is still balanced, hash-chained and append-only — and stamped
  // with an import `createdByProgram` so it is visibly an imported voucher.
  importedHistorical?: boolean;
  lines: JournalLineInput[];
};

// `created_by_program` values flagging a journal entry as a replayed import
// posting (#195). Such entries are exempt from the income/expense
// document-evidence requirement until #196 attaches the original bilag.
const IMPORTED_HISTORICAL_PROGRAMS = new Set(["rentemester-import-postings"]);

export type JournalPostResult = {
  ok: boolean;
  entryId?: JournalEntryId;
  entryNo?: string;
  entryHash?: string;
  appliedRules: string[];
  errors: string[];
};

export type JournalReverseResult = JournalPostResult & {
  originalEntryId?: JournalEntryId;
};

const LEDGER_RULES = {
  BALANCED: "DK-BOOKKEEPING-BALANCED-001",
  APPEND_ONLY: "DK-BOOKKEEPING-APPEND-ONLY-001",
  REVERSAL: "DK-BOOKKEEPING-REVERSAL-001",
  DOCUMENT: "DK-BOOKKEEPING-DOCUMENT-001",
  FX: "DK-BOOKKEEPING-FX-001",
  PERIOD_LOCK: "DK-BOOKKEEPING-PERIOD-LOCK-001",
} as const;

const RULE_VERSION = currentRuleBundleVersion();

export function seedAccounts(db: Database) {
  // The seeded chart of accounts covers what an ordinary Danish small business
  // (incl. a one-person ApS) actually needs (#226). Numbering keeps the Danish
  // kontoplan ranges already in use:
  //   1xxx  income + debtors + salgsmoms
  //   2xxx  bank
  //   3xxx  external operating expenses (driftsomkostninger) + staff costs
  //   4xxx  VAT settlement accounts (4000 Købsmoms, 4500 Momsafregning)
  //   5xxx  equity (incl. owner's draw/contribution) + fixed assets
  //   7xxx  short-term liabilities (creditors + payroll-related gæld + tax)
  const rows = [
    // --- Income (1xxx) ---
    ["1000", "Omsætning, ydelser", "income", "credit", null],
    ["1010", "Gebyr- og kompensationsindtægter", "income", "credit", null],
    ["1100", "Debitorer", "asset", "debit", null],
    ["1200", "Salgsmoms", "vat", "credit", null],
    // --- Bank (2xxx) ---
    ["2000", "Bank", "asset", "debit", null],
    // --- External operating expenses (3xxx, 3000-3399) ---
    ["3000", "Software og SaaS", "expense", "debit", "DK_PURCHASE_25"],
    ["3010", "AI-værktøjer", "expense", "debit", "EU_SERVICE_REVERSE_CHARGE"],
    ["3020", "Hosting og cloud", "expense", "debit", "EU_SERVICE_REVERSE_CHARGE"],
    ["3050", "Rejse og transport", "expense", "debit", "DK_PURCHASE_25"],
    ["3055", "Kørselsgodtgørelse", "expense", "debit", null],
    ["3070", "Repræsentation", "expense", "debit", "REPRESENTATION_SPECIAL"],
    ["3080", "Tab på debitorer", "expense", "debit", "DK_BAD_DEBT_25"],
    ["3100", "Husleje", "expense", "debit", "DK_PURCHASE_25"],
    ["3110", "El, vand og varme", "expense", "debit", "DK_PURCHASE_25"],
    ["3120", "Hardware og udstyr", "expense", "debit", "DK_PURCHASE_25"],
    ["3130", "Kontorartikler og småanskaffelser", "expense", "debit", "DK_PURCHASE_25"],
    ["3140", "Telefon og internet", "expense", "debit", "DK_PURCHASE_25"],
    ["3150", "Forsikringer", "expense", "debit", null],
    ["3160", "Revisor og bogføring", "expense", "debit", "DK_PURCHASE_25"],
    ["3170", "Advokat og rådgivning", "expense", "debit", "DK_PURCHASE_25"],
    ["3180", "Markedsføring og annoncering", "expense", "debit", "DK_PURCHASE_25"],
    ["3190", "Kontingenter og abonnementer", "expense", "debit", "DK_PURCHASE_25"],
    ["3200", "Porto og fragt", "expense", "debit", "DK_PURCHASE_25"],
    ["3300", "Gebyrer, bank og betalingskort", "expense", "debit", null],
    ["3310", "Renteudgifter", "expense", "debit", null],
    // --- Staff costs (3xxx, 3500-3599) ---
    ["3500", "Lønninger", "expense", "debit", null],
    ["3510", "Pension", "expense", "debit", null],
    ["3520", "ATP og lovpligtige bidrag", "expense", "debit", null],
    ["3530", "Personaleomkostninger", "expense", "debit", "DK_PURCHASE_25"],
    // --- VAT settlement accounts (4xxx) ---
    ["4000", "Købsmoms", "vat", "debit", null],
    ["4500", "Momsafregning", "liability", "credit", null],
    // --- Equity + fixed assets (5xxx) ---
    ["5000", "Egenkapital", "equity", "credit", null],
    // Owner's draw / contribution (#249): for an enkeltmandsvirksomhed money
    // moved between the owner and the business is an equity movement, not an
    // expense or income. 5010 records hævninger (debit reduces equity), 5020
    // records indskud (credit increases equity).
    ["5010", "Privat hævning", "equity", "debit", null],
    ["5020", "Privat indskud", "equity", "credit", null],
    // Fixed-asset accounts (#124, #125), 5800-5899 range. 5800 capitalises
    // driftsmidler; 5810 is the contra-asset accumulated-depreciation account
    // (credit-normal); 5820 carries the period depreciation expense.
    ["5800", "Driftsmidler og inventar", "asset", "debit", null],
    ["5810", "Akkumulerede afskrivninger", "asset", "credit", null],
    ["5820", "Afskrivninger", "expense", "debit", null],
    // --- Short-term liabilities (7xxx): trade creditors + payroll gæld ---
    ["7000", "Leverandørgæld (kreditorer)", "liability", "credit", null],
    ["7100", "Skyldig A-skat", "liability", "credit", null],
    ["7110", "Skyldigt AM-bidrag", "liability", "credit", null],
    ["7120", "Skyldig ATP", "liability", "credit", null],
    ["7130", "Skyldig løn", "liability", "credit", null],
    // Tax payable / skattekonto (#249): the everyday account for tax owed to
    // SKAT — B-skat / restskat for an enkeltmandsvirksomhed, selskabsskat for
    // an ApS. Credit-normal short-term liability, alongside the payroll gæld.
    ["7200", "Skyldig skat (skattekonto)", "liability", "credit", null]
  ];
  const insert = db.prepare("INSERT OR IGNORE INTO accounts (account_no,name,type,normal_balance,default_vat_code) VALUES (?,?,?,?,?)");
  db.transaction(() => rows.forEach((r) => insert.run(...r)))();
}

export function nextEntryNo(db: Database, transactionDate: string) {
  const scope = fiscalYearLabelFromDate(db, transactionDate);
  const row = db.query(`SELECT COALESCE(MAX(CAST(substr(entry_no, -5) AS INTEGER)), 0) AS n FROM journal_entries WHERE entry_no GLOB ?`).get(`${scope}-[0-9][0-9][0-9][0-9][0-9]`) as { n: number };
  const nextValue = nextSequenceValue(db, "journal_entry", companySequenceScope(db, scope), Number(row.n ?? 0));
  return `${scope}-${String(nextValue).padStart(5, "0")}`;
}

export function previousHash(db: Database) {
  const row = db.query("SELECT entry_hash FROM journal_entries ORDER BY id DESC LIMIT 1").get() as { entry_hash: string } | null;
  return row?.entry_hash ?? "GENESIS";
}

// journal_entries is append-only (delete is blocked by trigger), so the id the
// next inserted row receives is deterministically MAX(id) + 1. The id is bound
// into the entry hash, so it must be predicted before the row is written.
function nextEntryId(db: Database) {
  const row = db.query("SELECT COALESCE(MAX(id), 0) AS n FROM journal_entries").get() as { n: number };
  return Number(row.n) + 1;
}

export function hashEntry(data: unknown, prev: string) {
  return createHash("sha256").update(JSON.stringify(data)).update(prev).digest("hex");
}


function normalizeAmount(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? roundDkk(value) : 0;
}

// The canonical hash binds the row id and an explicit per-line ordinal so each
// entry_hash attests its row identity and the insertion order of its lines.
// The chain therefore attests the id-ordered insertion sequence: two rows
// cannot be swapped in id order without invalidating their hashes.
function canonicalEntryData(entry: any, lines: any[]) {
  return {
    id: entry.id ?? null,
    entry_no: entry.entry_no,
    transaction_date: entry.transaction_date,
    text: entry.text,
    source_bank_transaction_id: entry.source_bank_transaction_id ?? null,
    document_id: entry.document_id ?? null,
    currency: entry.currency ?? 'DKK',
    amount_foreign: entry.amount_foreign ?? null,
    amount_dkk: entry.amount_dkk ?? null,
    fx_rate_to_dkk: entry.fx_rate_to_dkk ?? null,
    rule_version: entry.rule_version,
    created_by: entry.created_by,
    created_by_program: entry.created_by_program,
    status: entry.status,
    reversal_of_entry_id: entry.reversal_of_entry_id ?? null,
    lines: lines.map((line, ordinal) => ({
      ordinal,
      account_no: line.account_no,
      debit_amount: normalizeAmount(line.debit_amount),
      credit_amount: normalizeAmount(line.credit_amount),
      vat_code: line.vat_code ?? null,
      text: line.text ?? null,
    })),
  };
}

function accountMap(db: Database) {
  const rows = db.query("SELECT id, account_no, type, active FROM accounts").all() as Array<{ id: number; account_no: string; type: string; active: number }>;
  return new Map(rows.map((row) => [row.account_no, row]));
}

export function validateJournalEntry(db: Database, payload: JournalEntryInput) {
  const errors: string[] = [];
  const appliedRules: Array<(typeof LEDGER_RULES)[keyof typeof LEDGER_RULES]> = [
    LEDGER_RULES.BALANCED,
    LEDGER_RULES.APPEND_ONLY,
  ];
  const lines = payload.lines ?? [];
  const currency = (payload.currency ?? 'DKK').trim().toUpperCase();

  if (!looksLikeIsoDate(payload.transactionDate)) errors.push("transactionDate must be present in YYYY-MM-DD format");
  if (typeof payload.text !== "string" || payload.text.trim().length === 0) errors.push("text is required");
  if (looksLikeIsoDate(payload.transactionDate)) {
    appliedRules.push(LEDGER_RULES.PERIOD_LOCK);
    errors.push(...validateJournalTransactionDate(db, payload.transactionDate));
  }
  if (!Array.isArray(lines) || lines.length < 2) errors.push("at least two journal lines are required");
  if (currency.length !== 3) errors.push("currency must be a 3-letter ISO code when present");

  const accounts = accountMap(db);
  let debitSum = 0n;
  let creditSum = 0n;
  let requiresDocument = false;

  lines.forEach((line, idx) => {
    const debit = normalizeAmount(line.debitAmount);
    const credit = normalizeAmount(line.creditAmount);
    if (!line.accountNo || !accounts.has(line.accountNo)) {
      errors.push(`lines[${idx}].accountNo must reference an existing account`);
      return;
    }
    const account = accounts.get(line.accountNo)!;
    if (!account.active) errors.push(`lines[${idx}].accountNo refers to an inactive account`);
    if (debit < 0 || credit < 0) {
      errors.push(`lines[${idx}] debit and credit amounts must not be negative`);
    } else if ((debit > 0 && credit > 0) || (debit === 0 && credit === 0)) {
      errors.push(`lines[${idx}] must have either debitAmount or creditAmount`);
    }
    debitSum += toOre(debit);
    creditSum += toOre(credit);
    if (account.type === "expense" || account.type === "income") requiresDocument = true;
  });

  if (debitSum !== creditSum) {
    errors.push(`journal entry must balance: debit ${fromOre(debitSum)} != credit ${fromOre(creditSum)}`);
  }

  if (currency !== 'DKK') {
    appliedRules.push(LEDGER_RULES.FX);
    const amountForeign = normalizeAmount(payload.amountForeign);
    const amountDkk = normalizeAmount(payload.amountDkk);
    const fxRateToDkk = typeof payload.fxRateToDkk === 'number' && Number.isFinite(payload.fxRateToDkk) ? roundRate6(payload.fxRateToDkk) : NaN;
    if (!(amountForeign > 0)) errors.push("amountForeign must be positive for non-DKK journal entries");
    if (!(amountDkk > 0)) errors.push("amountDkk must be positive for non-DKK journal entries");
    if (!(fxRateToDkk > 0)) errors.push("fxRateToDkk must be positive for non-DKK journal entries");
    if (amountForeign > 0 && fxRateToDkk > 0) {
      const expectedAmountDkk = roundDkk(amountForeign * fxRateToDkk);
      if (compareDkk(amountDkk, expectedAmountDkk) !== 0) errors.push(`amountDkk must equal amountForeign * fxRateToDkk (${expectedAmountDkk})`);
    }
  }

  if (requiresDocument) {
    appliedRules.push(LEDGER_RULES.DOCUMENT);
    if (payload.importedHistorical && !payload.documentId) {
      // A replayed migration posting (#195): the original receipt is not yet
      // ingested into Rentemester. The entry is still recorded as needing
      // document evidence — #196 attaches the bilag — but is not rejected.
    } else if (!payload.documentId) {
      errors.push("documentId is required when posting expense or income lines");
    } else {
      const doc = db.query("SELECT id FROM documents WHERE id = ?").get(payload.documentId) as { id: number } | null;
      if (!doc) errors.push(`documentId ${payload.documentId} does not exist`);
    }
  }

  if (payload.sourceBankTransactionId) {
    const bank = db.query("SELECT id FROM bank_transactions WHERE id = ?").get(payload.sourceBankTransactionId) as { id: number } | null;
    if (!bank) errors.push(`sourceBankTransactionId ${payload.sourceBankTransactionId} does not exist`);
  }

  return { ok: errors.length === 0, appliedRules, errors };
}

export function postJournalEntry(db: Database, payload: JournalEntryInput): JournalPostResult {
  const validation = validateJournalEntry(db, payload);
  if (!validation.ok) return { ok: false, appliedRules: validation.appliedRules, errors: validation.errors };

  const accounts = accountMap(db);

  const result = db.transaction(() => {
    const entryId = nextEntryId(db);
    const entryNo = nextEntryNo(db, payload.transactionDate);
    const prevHash = previousHash(db);
    const actor = resolveActor({ createdBy: payload.createdBy, createdByProgram: payload.createdByProgram });
    const canonicalLines = payload.lines.map((line) => ({
      account_no: line.accountNo,
      debit_amount: normalizeAmount(line.debitAmount),
      credit_amount: normalizeAmount(line.creditAmount),
      vat_code: line.vatCode ?? null,
      text: line.text ?? null,
    }));
    const entryDraft = {
      id: entryId,
      entry_no: entryNo,
      transaction_date: payload.transactionDate,
      text: payload.text,
      source_bank_transaction_id: payload.sourceBankTransactionId ?? null,
      document_id: payload.documentId ?? null,
      currency: (payload.currency ?? 'DKK').trim().toUpperCase(),
      amount_foreign: payload.amountForeign == null ? null : roundDkk(payload.amountForeign),
      amount_dkk: payload.amountDkk == null ? null : roundDkk(payload.amountDkk),
      fx_rate_to_dkk: payload.fxRateToDkk == null ? null : roundRate6(payload.fxRateToDkk),
      rule_version: RULE_VERSION,
      created_by: actor.createdBy,
      created_by_program: actor.createdByProgram,
      status: 'posted',
      reversal_of_entry_id: null,
    };
    const entryHash = hashEntry(canonicalEntryData(entryDraft, canonicalLines), prevHash);

    const insertEntry = db.query(
      `INSERT INTO journal_entries (
        id, entry_no, transaction_date, text, source_bank_transaction_id, document_id,
        currency, amount_foreign, amount_dkk, fx_rate_to_dkk,
        rule_version, created_by, created_by_program, status, previous_hash, entry_hash, retain_until
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'posted', ?, ?, ?)
      RETURNING id, entry_no`
    );

    const entry = insertEntry.get(
      entryId,
      entryNo,
      payload.transactionDate,
      payload.text,
      payload.sourceBankTransactionId ?? null,
      payload.documentId ?? null,
      (payload.currency ?? 'DKK').trim().toUpperCase(),
      payload.amountForeign == null ? null : roundDkk(payload.amountForeign),
      payload.amountDkk == null ? null : roundDkk(payload.amountDkk),
      payload.fxRateToDkk == null ? null : roundRate6(payload.fxRateToDkk),
      RULE_VERSION,
      actor.createdBy,
      actor.createdByProgram,
      prevHash,
      entryHash,
      retainUntilForDate(db, payload.transactionDate),
    ) as any;

    const insertLine = db.prepare(
      `INSERT INTO journal_lines (journal_entry_id, account_id, debit_amount, credit_amount, vat_code, currency, text)
       VALUES (?, ?, ?, ?, ?, 'DKK', ?)`
    );

    canonicalLines.forEach((line) => {
      const account = accounts.get(line.account_no)!;
      insertLine.run(entry.id, account.id, line.debit_amount, line.credit_amount, line.vat_code, line.text);
    });

    insertAuditLog(db, {
      eventType: "journal_post",
      entityType: "journal_entry",
      entityId: entry.id,
      message: `Posted journal entry ${entry.entry_no}`,
      createdBy: actor.createdBy,
      createdByProgram: actor.createdByProgram,
    });

    if (payload.sourceBankTransactionId) {
      resolveOpenExceptionsForBankTransaction(
        db,
        payload.sourceBankTransactionId,
        `Resolved automatically by posted journal entry ${entry.entry_no}`,
        actor.createdBy,
      );
    }

    return { entryId: asJournalEntryId(entry.id), entryNo: entry.entry_no, entryHash };
  }, { immediate: true })();

  return { ok: true, appliedRules: validation.appliedRules, errors: [], ...result };
}

export function reverseJournalEntry(db: Database, input: { entryId: JournalEntryId; transactionDate: string; reason: string; createdBy?: string; createdByProgram?: string; }): JournalReverseResult {
  const appliedRules = [LEDGER_RULES.APPEND_ONLY, LEDGER_RULES.REVERSAL];
  const errors: string[] = [];

  if (!Number.isInteger(input.entryId) || input.entryId <= 0) errors.push("entryId must be a positive integer");
  if (!looksLikeIsoDate(input.transactionDate)) errors.push("transactionDate must be present in YYYY-MM-DD format");
  if (typeof input.reason !== "string" || input.reason.trim().length === 0) errors.push("reason is required");
  if (errors.length > 0) return { ok: false, appliedRules, errors };

  const original = db.query(
    `SELECT id, entry_no, transaction_date, text, source_bank_transaction_id, document_id, currency, amount_foreign, amount_dkk, fx_rate_to_dkk, rule_version, created_by, created_by_program, status, reversal_of_entry_id
     FROM journal_entries WHERE id = ?`
  ).get(input.entryId) as any | null;
  if (!original) return { ok: false, appliedRules, errors: [`journal entry ${input.entryId} does not exist`] };
  if (original.reversal_of_entry_id != null) return { ok: false, appliedRules, errors: [`journal entry ${input.entryId} is already a reversal entry`] };

  const existingReversal = db.query("SELECT id, entry_no FROM journal_entries WHERE reversal_of_entry_id = ? LIMIT 1").get(input.entryId) as { id: number; entry_no: string } | null;
  if (existingReversal) {
    return { ok: false, appliedRules, errors: [`journal entry ${input.entryId} already has reversal ${existingReversal.entry_no}`] };
  }

  const originalLines = db.query(
    `SELECT a.account_no, jl.debit_amount, jl.credit_amount, jl.vat_code, jl.text
     FROM journal_lines jl
     JOIN accounts a ON a.id = jl.account_id
     WHERE jl.journal_entry_id = ?
     ORDER BY jl.id ASC`
  ).all(input.entryId) as any[];
  if (originalLines.length === 0) {
    return { ok: false, appliedRules, errors: [`journal entry ${input.entryId} has no lines to reverse`] };
  }

  const reversalPayload: JournalEntryInput = {
    transactionDate: input.transactionDate,
    text: `Reversal of ${original.entry_no}: ${input.reason.trim()}`,
    documentId: original.document_id ?? undefined,
    sourceBankTransactionId: original.source_bank_transaction_id ?? undefined,
    currency: original.currency ?? 'DKK',
    amountForeign: original.amount_foreign ?? undefined,
    amountDkk: original.amount_dkk ?? undefined,
    fxRateToDkk: original.fx_rate_to_dkk ?? undefined,
    createdBy: input.createdBy,
    createdByProgram: input.createdByProgram,
    lines: originalLines.map((line) => ({
      accountNo: line.account_no,
      debitAmount: normalizeAmount(line.credit_amount) || undefined,
      creditAmount: normalizeAmount(line.debit_amount) || undefined,
      vatCode: line.vat_code ?? undefined,
      text: line.text ? `REVERSAL: ${line.text}` : `REVERSAL of ${original.entry_no}`,
    })),
  };

  const validation = validateJournalEntry(db, reversalPayload);
  if (!validation.ok) return { ok: false, appliedRules: [...new Set([...appliedRules, ...validation.appliedRules])], errors: validation.errors };

  const accounts = accountMap(db);

  const result = db.transaction(() => {
    const entryId = nextEntryId(db);
    const entryNo = nextEntryNo(db, reversalPayload.transactionDate);
    const prevHash = previousHash(db);
    const actor = resolveActor({ createdBy: reversalPayload.createdBy, createdByProgram: reversalPayload.createdByProgram });
    const canonicalLines = reversalPayload.lines.map((line) => ({
      account_no: line.accountNo,
      debit_amount: normalizeAmount(line.debitAmount),
      credit_amount: normalizeAmount(line.creditAmount),
      vat_code: line.vatCode ?? null,
      text: line.text ?? null,
    }));
    const entryDraft = {
      id: entryId,
      entry_no: entryNo,
      transaction_date: reversalPayload.transactionDate,
      text: reversalPayload.text,
      source_bank_transaction_id: reversalPayload.sourceBankTransactionId ?? null,
      document_id: reversalPayload.documentId ?? null,
      currency: (reversalPayload.currency ?? 'DKK').trim().toUpperCase(),
      amount_foreign: reversalPayload.amountForeign == null ? null : roundDkk(reversalPayload.amountForeign),
      amount_dkk: reversalPayload.amountDkk == null ? null : roundDkk(reversalPayload.amountDkk),
      fx_rate_to_dkk: reversalPayload.fxRateToDkk == null ? null : roundRate6(reversalPayload.fxRateToDkk),
      rule_version: RULE_VERSION,
      created_by: actor.createdBy,
      created_by_program: actor.createdByProgram,
      status: 'reversed',
      reversal_of_entry_id: original.id,
    };
    const entryHash = hashEntry(canonicalEntryData(entryDraft, canonicalLines), prevHash);

    const entry = db.query(
      `INSERT INTO journal_entries (
        id, entry_no, transaction_date, text, source_bank_transaction_id, document_id,
        currency, amount_foreign, amount_dkk, fx_rate_to_dkk,
        rule_version, created_by, created_by_program, status, reversal_of_entry_id, previous_hash, entry_hash, retain_until
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reversed', ?, ?, ?, ?)
      RETURNING id, entry_no`
    ).get(
      entryId,
      entryNo,
      reversalPayload.transactionDate,
      reversalPayload.text,
      reversalPayload.sourceBankTransactionId ?? null,
      reversalPayload.documentId ?? null,
      (reversalPayload.currency ?? 'DKK').trim().toUpperCase(),
      reversalPayload.amountForeign == null ? null : roundDkk(reversalPayload.amountForeign),
      reversalPayload.amountDkk == null ? null : roundDkk(reversalPayload.amountDkk),
      reversalPayload.fxRateToDkk == null ? null : roundRate6(reversalPayload.fxRateToDkk),
      RULE_VERSION,
      actor.createdBy,
      actor.createdByProgram,
      original.id,
      prevHash,
      entryHash,
      retainUntilForDate(db, reversalPayload.transactionDate),
    ) as any;

    const insertLine = db.prepare(
      `INSERT INTO journal_lines (journal_entry_id, account_id, debit_amount, credit_amount, vat_code, currency, text)
       VALUES (?, ?, ?, ?, ?, 'DKK', ?)`
    );
    canonicalLines.forEach((line) => {
      const account = accounts.get(line.account_no)!;
      insertLine.run(entry.id, account.id, line.debit_amount, line.credit_amount, line.vat_code, line.text);
    });

    insertAuditLog(db, {
      eventType: "journal_reverse",
      entityType: "journal_entry",
      entityId: entry.id,
      message: `Reversed journal entry ${original.entry_no} with ${entry.entry_no}`,
      createdBy: actor.createdBy,
      createdByProgram: actor.createdByProgram,
    });

    return { entryId: asJournalEntryId(entry.id), entryNo: entry.entry_no, entryHash };
  }, { immediate: true })();

  return { ok: true, originalEntryId: asJournalEntryId(original.id), appliedRules: [...new Set([...appliedRules, ...validation.appliedRules])], errors: [], ...result };
}

export function verifyAuditChain(db: Database) {
  const entries = db.query("SELECT id, entry_no, transaction_date, text, source_bank_transaction_id, document_id, currency, amount_foreign, amount_dkk, fx_rate_to_dkk, rule_version, created_by, created_by_program, status, reversal_of_entry_id, previous_hash, entry_hash FROM journal_entries ORDER BY id ASC").all() as any[];
  let prev = "GENESIS";
  const errors: string[] = [];

  const foreignKeyErrors = db.query("PRAGMA foreign_key_check").all() as Array<{ table: string; rowid: number; parent: string; fkid: number }>;
  for (const fk of foreignKeyErrors) {
    errors.push(`foreign key violation: ${fk.table} row ${fk.rowid} references missing ${fk.parent}`);
  }

  const orphanLines = db.query(
    `SELECT jl.id, jl.journal_entry_id
     FROM journal_lines jl
     LEFT JOIN journal_entries je ON je.id = jl.journal_entry_id
     WHERE je.id IS NULL
     ORDER BY jl.id ASC`
  ).all() as Array<{ id: number; journal_entry_id: number }>;
  for (const line of orphanLines) {
    errors.push(`journal_line ${line.id}: orphan journal_entry_id ${line.journal_entry_id}`);
  }

  const brokenAccountLines = db.query(
    `SELECT jl.id, jl.account_id
     FROM journal_lines jl
     LEFT JOIN accounts a ON a.id = jl.account_id
     WHERE a.id IS NULL
     ORDER BY jl.id ASC`
  ).all() as Array<{ id: number; account_id: number }>;
  for (const line of brokenAccountLines) {
    errors.push(`journal_line ${line.id}: missing account_id ${line.account_id}`);
  }

  for (const e of entries) {
    const lines = db.query(
      `SELECT a.account_no, a.type AS account_type, jl.debit_amount, jl.credit_amount, jl.vat_code, jl.text
       FROM journal_lines jl
       JOIN accounts a ON a.id = jl.account_id
       WHERE jl.journal_entry_id = ?
       ORDER BY jl.id ASC`
    ).all(e.id) as any[];
    if (lines.length === 0) errors.push(`${e.entry_no}: entry has no journal lines`);

    const canonicalLines = lines.map(({ account_type, ...line }) => line);
    const expected = hashEntry(canonicalEntryData(e, canonicalLines), prev);
    if (e.previous_hash !== prev) errors.push(`${e.entry_no}: previous_hash mismatch`);
    if (e.entry_hash !== expected) errors.push(`${e.entry_no}: entry_hash mismatch`);

    const debitSum = lines.reduce((sum, line) => sum + toOre(Number(line.debit_amount ?? 0)), 0n);
    const creditSum = lines.reduce((sum, line) => sum + toOre(Number(line.credit_amount ?? 0)), 0n);
    if (debitSum !== creditSum) errors.push(`${e.entry_no}: entry is unbalanced (${fromOre(debitSum)} != ${fromOre(creditSum)})`);

    const requiresDocument = lines.some((line) => line.account_type === "expense" || line.account_type === "income");
    // A replayed migration posting (#195) carries no Rentemester document yet —
    // #196 attaches the original bilag. It is identified by its import
    // `created_by_program` and exempted from the document-evidence check.
    const isImportedHistorical = IMPORTED_HISTORICAL_PROGRAMS.has(e.created_by_program);
    if (requiresDocument && !isImportedHistorical) {
      if (e.document_id == null) {
        errors.push(`${e.entry_no}: income/expense entry is missing document evidence`);
      } else {
        const document = db.query("SELECT id, sha256_hash, stored_path FROM documents WHERE id = ?").get(e.document_id) as { id: number; sha256_hash: string; stored_path: string | null } | null;
        if (!document) errors.push(`${e.entry_no}: document_id ${e.document_id} is missing`);
        if (document && (!document.sha256_hash || document.sha256_hash.trim().length === 0)) errors.push(`${e.entry_no}: document_id ${e.document_id} has no sha256_hash`);
      }
    }

    prev = e.entry_hash;
  }

  // Tail-truncation guard: the journal_entry sequence is monotonic and protected
  // against rollback, so it records the highest entry number ever allocated for
  // a fiscal scope. Deleting the most recent entries leaves a valid but shorter
  // chain; cross-checking the count and highest entry_no against the issued
  // sequence value detects those missing entries.
  const journalSequences = db.query(
    `SELECT scope, value FROM sequences WHERE kind = 'journal_entry'`
  ).all() as Array<{ scope: string; value: number }>;
  for (const sequence of journalSequences) {
    const fiscalScope = sequence.scope.slice(sequence.scope.lastIndexOf(":") + 1);
    if (!fiscalScope) continue;
    const glob = `${fiscalScope}-[0-9][0-9][0-9][0-9][0-9]`;
    const stats = db.query(
      `SELECT COUNT(*) AS n, COALESCE(MAX(CAST(substr(entry_no, -5) AS INTEGER)), 0) AS max_no
       FROM journal_entries WHERE entry_no GLOB ?`
    ).get(glob) as { n: number; max_no: number };
    const expected = Number(sequence.value);
    if (Number(stats.max_no) < expected) {
      errors.push(`fiscal scope ${fiscalScope}: highest journal entry ${fiscalScope}-${String(stats.max_no).padStart(5, "0")} is below issued sequence value ${expected} — entries are missing`);
    } else if (Number(stats.n) < expected) {
      errors.push(`fiscal scope ${fiscalScope}: ${stats.n} journal entries present but sequence issued ${expected} — entries are missing`);
    }
  }

  const bankLinkedEntries = db.query(
    `SELECT id, entry_no, source_bank_transaction_id, status, reversal_of_entry_id
     FROM journal_entries
     WHERE source_bank_transaction_id IS NOT NULL
     ORDER BY id ASC`
  ).all() as { id: number; entry_no: string; source_bank_transaction_id: number; status: string; reversal_of_entry_id: number | null }[];
  const byBankTransaction = new Map<number, typeof bankLinkedEntries>();
  for (const entry of bankLinkedEntries) {
    const existing = byBankTransaction.get(entry.source_bank_transaction_id) ?? [];
    existing.push(entry);
    byBankTransaction.set(entry.source_bank_transaction_id, existing);
  }
  for (const [bankTransactionId, group] of byBankTransaction.entries()) {
    if (group.length <= 1) continue;
    const cancelled = new Set<number>();
    const idsInGroup = new Set(group.map((entry) => entry.id));
    for (const entry of group) {
      if (entry.reversal_of_entry_id != null && idsInGroup.has(entry.reversal_of_entry_id)) {
        cancelled.add(entry.id);
        cancelled.add(entry.reversal_of_entry_id);
      }
    }
    const remaining = group.filter((entry) => !cancelled.has(entry.id));
    if (remaining.length > 1) {
      errors.push(`duplicate source_bank_transaction_id ${bankTransactionId}: used by ${remaining.length} active entries (${remaining.map((entry) => entry.entry_no).join(', ')})`);
    }
  }

  const unlinkedInvoicePayments = db.query(
    `SELECT p.id, p.invoice_document_id, p.journal_entry_id, d.invoice_no
     FROM invoice_payments p
     LEFT JOIN journal_entries j ON j.id = p.journal_entry_id
     LEFT JOIN documents d ON d.id = p.invoice_document_id
     WHERE p.journal_entry_id IS NULL OR j.id IS NULL
     ORDER BY p.id ASC`
  ).all() as Array<{ id: number; invoice_document_id: number; journal_entry_id: number | null; invoice_no: string | null }>;
  for (const payment of unlinkedInvoicePayments) {
    errors.push(`invoice payment ${payment.id} for invoice ${payment.invoice_no ?? payment.invoice_document_id} is missing journal evidence`);
  }

  const issuedInvoices = db.query("SELECT id, invoice_no, status FROM documents WHERE document_type = 'issued_invoice' ORDER BY id ASC").all() as Array<{ id: number; invoice_no: string | null; status: string | null }>;
  const allowedStoredStatus: Record<string, string[]> = {
    open: ["issued", "open"],
    paid: ["paid", "settled"],
    credited: ["credited"],
    refunded: ["refunded"],
    overpaid: ["overpaid"],
    written_off: ["written_off"],
  };
  for (const invoice of issuedInvoices) {
    const status = getInvoiceStatus(db, invoice.id);
    if (!status.ok) {
      errors.push(`invoice ${invoice.invoice_no ?? invoice.id}: status cross-check failed (${status.errors.join('; ')})`);
      continue;
    }
    const stored = invoice.status ?? "";
    if (stored === "issued") continue;
    const allowed = allowedStoredStatus[status.status ?? ""] ?? [status.status ?? ""];
    if (!allowed.includes(stored)) {
      errors.push(`invoice ${invoice.invoice_no ?? invoice.id}: stored status ${stored} does not match ledger status ${status.status} (open balance ${status.openBalance})`);
    }
  }

  return { ok: errors.length === 0, entries: entries.length, errors };
}

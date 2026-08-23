// Tests: src/core/ledger.ts — hash-chain tamper detection edge cases
// Single-field tampering, line reordering, middle truncation, sequence tampering
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureCompanyDirs } from "../../src/core/paths";
import { openDb, migrate } from "../../src/core/db";
import { hashEntry, seedAccounts, verifyAuditChain } from "../../src/core/ledger";

type ManualLine = {
  account_no: string;
  debit_amount: number;
  credit_amount: number;
  vat_code: string | null;
  text: string;
};

function insertManualEntry(db: ReturnType<typeof openDb>, input: {
  entryNo: string;
  previousHash: string;
  transactionDate: string;
  text: string;
  lines: ManualLine[];
  sourceBankTransactionId?: number | null;
  status?: "posted" | "reversed";
  reversalOfEntryId?: number | null;
}) {
  const entry = {
    entry_no: input.entryNo,
    transaction_date: input.transactionDate,
    text: input.text,
    source_bank_transaction_id: input.sourceBankTransactionId ?? null,
    document_id: null,
    currency: "DKK",
    amount_foreign: null,
    amount_dkk: null,
    fx_rate_to_dkk: null,
    rule_version: "dk-v0.0.1",
    created_by: "system",
    created_by_program: "rentemester",
    status: input.status ?? "posted",
    reversal_of_entry_id: input.reversalOfEntryId ?? null,
  };
  const predictedId = ((db.query("SELECT COALESCE(MAX(id), 0) AS n FROM journal_entries").get() as { n: number }).n) + 1;
  const canonical = {
    id: predictedId,
    ...entry,
    lines: input.lines.map((line, ordinal) => ({
      ordinal,
      account_no: line.account_no,
      debit_amount: line.debit_amount,
      credit_amount: line.credit_amount,
      vat_code: line.vat_code ?? null,
      text: line.text ?? null,
    })),
  };
  const entryHash = hashEntry(canonical, input.previousHash);

  db.run(
    `INSERT INTO journal_entries (
      id, entry_no, transaction_date, text, source_bank_transaction_id, document_id,
      currency, amount_foreign, amount_dkk, fx_rate_to_dkk,
      rule_version, created_by, created_by_program, status, reversal_of_entry_id, previous_hash, entry_hash
    ) VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?)`, [
    predictedId,
    entry.entry_no,
    entry.transaction_date,
    entry.text,
    entry.source_bank_transaction_id,
    entry.currency,
    entry.rule_version,
    entry.created_by,
    entry.created_by_program,
    entry.status,
    entry.reversal_of_entry_id,
    input.previousHash,
    entryHash,
  ]);

  for (const line of input.lines) {
    const account = db.query("SELECT id FROM accounts WHERE account_no = ?").get(line.account_no) as { id: number };
    db.run(
      `INSERT INTO journal_lines (journal_entry_id, account_id, debit_amount, credit_amount, vat_code, currency, text)
       VALUES (?, ?, ?, ?, ?, 'DKK', ?)`, [
      predictedId,
      account.id,
      line.debit_amount,
      line.credit_amount,
      line.vat_code,
      line.text,
    ]);
  }
  return { id: predictedId, entryHash };
}

describe("hash-chain tamper detection — edge cases", () => {
  function setup() {
    const root = mkdtempSync(join(tmpdir(), "rentemester-tamper-edge-"));
    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);
    seedAccounts(db);

    // Seed three valid entries forming a chain
    const e1 = insertManualEntry(db, {
      entryNo: "2026-00001", previousHash: "GENESIS", transactionDate: "2026-01-01",
      text: "Entry one", lines: [{ account_no: "2000", debit_amount: 100, credit_amount: 0, vat_code: null, text: "" }],
    });
    const e2 = insertManualEntry(db, {
      entryNo: "2026-00002", previousHash: e1.entryHash, transactionDate: "2026-01-02",
      text: "Entry two", lines: [{ account_no: "2000", debit_amount: 100, credit_amount: 0, vat_code: null, text: "" }],
    });
    const e3 = insertManualEntry(db, {
      entryNo: "2026-00003", previousHash: e2.entryHash, transactionDate: "2026-01-03",
      text: "Entry three", lines: [{ account_no: "2000", debit_amount: 100, credit_amount: 0, vat_code: null, text: "" }],
    });

    return { db, root, entries: [e1, e2, e3] };
  }

  test("detects single-field tampering on transaction_date", () => {
    const { db, root, entries } = setup();
    db.run("DROP TRIGGER journal_entries_no_update");
    db.run("UPDATE journal_entries SET transaction_date = '2025-01-01' WHERE id = ?", [entries[1].id]);
    const result = verifyAuditChain(db);
    expect(result.ok).toBe(false);
    expect(result.errors?.some((e: string) => e.includes("hash mismatch"))).toBe(true);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("detects single-field tampering on text", () => {
    const { db, root, entries } = setup();
    db.run("DROP TRIGGER journal_entries_no_update");
    db.run("UPDATE journal_entries SET text = 'Tampered text' WHERE id = ?", [entries[1].id]);
    const result = verifyAuditChain(db);
    expect(result.ok).toBe(false);
    expect(result.errors?.some((e: string) => e.includes("hash mismatch"))).toBe(true);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("detects tampering of a single journal line amount (balanced change)", () => {
    const { db, root, entries } = setup();
    db.run("DROP TRIGGER journal_lines_no_update");
    db.run("UPDATE journal_lines SET debit_amount = 999 WHERE journal_entry_id = ?", [entries[1].id]);
    const result = verifyAuditChain(db);
    expect(result.ok).toBe(false);
    expect(result.errors?.some((e: string) => e.includes("hash mismatch"))).toBe(true);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("detects middle truncation (entry removed from middle of chain)", () => {
    const { db, root, entries } = setup();
    db.run("DROP TRIGGER journal_entries_no_delete");
    db.run("DROP TRIGGER journal_lines_no_delete");
    db.run("DELETE FROM journal_lines WHERE journal_entry_id = ?", [entries[1].id]);
    db.run("DELETE FROM journal_entries WHERE id = ?", [entries[1].id]);
    const result = verifyAuditChain(db);
    expect(result.ok).toBe(false);
    expect(result.errors?.some((e: string) => e.includes("missing") || e.includes("not found") || e.includes("hash mismatch"))).toBe(true);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("hashEntry produces different hashes for different line orderings", () => {
    const base = {
      id: 1, entry_no: "2026-00001", previous_hash: "GENESIS", transaction_date: "2026-01-01", text: "Test",
      source_bank_transaction_id: null, document_id: null, currency: "DKK", amount_foreign: null, amount_dkk: null,
      fx_rate_to_dkk: null, rule_version: "dk-v0.0.1", created_by: "system", created_by_program: "rentemester",
      status: "posted" as const, reversal_of_entry_id: null,
    };
    const lineA = { ordinal: 0, account_no: "1000", debit_amount: 100, credit_amount: 0, vat_code: null, text: "Debit" };
    const lineB = { ordinal: 1, account_no: "2000", debit_amount: 0, credit_amount: 100, vat_code: null, text: "Credit" };
    const hashAB = hashEntry({ ...base, lines: [lineA, lineB] }, "GENESIS");
    const hashBA = hashEntry({ ...base, lines: [lineB, lineA] }, "GENESIS");
    expect(hashAB).not.toBe(hashBA);
  });
});
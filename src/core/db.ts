import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";
import { backfillRetentionDeadlines } from "./retention";

export function openDb(path: string) {
  const db = new Database(path);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA foreign_keys=ON");
  return db;
}

export function migrate(db: Database) {
  const schema = readFileSync(join(import.meta.dir, "../../src/core/schema.sql"), "utf8");
  db.exec(schema);
  db.exec("CREATE INDEX IF NOT EXISTS idx_accounting_periods_covering_date ON accounting_periods(period_start, period_end, status);");
  backfillRetentionDeadlines(db);
}
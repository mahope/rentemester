import { mkdirSync } from "node:fs";
import { join } from "node:path";

export function companyPaths(root: string) {
  return {
    root,
    data: join(root, "data"),
    db: join(root, "data", "ledger.sqlite"),
    bankIncoming: join(root, "bank", "incoming_csv"),
    bankProcessed: join(root, "bank", "processed"),
    documentsInbox: join(root, "documents", "inbox"),
    documentsOriginals: join(root, "documents", "originals"),
    invoicesDrafts: join(root, "invoices", "drafts"),
    invoicesIssued: join(root, "invoices", "issued"),
    exports: join(root, "exports"),
    backups: join(root, "backups"),
    logs: join(root, "logs"),
    config: join(root, "config"),
  };
}

export function ensureCompanyDirs(root: string) {
  const p = companyPaths(root);
  for (const dir of Object.values(p)) {
    if (dir.endsWith("ledger.sqlite")) continue;
    mkdirSync(dir, { recursive: true });
  }
  return p;
}

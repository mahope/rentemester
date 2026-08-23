import { readFileSync } from "node:fs";
import { companyPaths } from "../core/paths";
import { openDb, migrate } from "../core/db";
import { ingestDocument } from "../core/documents";
import { recordException } from "../core/exceptions";
import { resolveDocumentMasterData } from "../core/master-data";
import { openCommandDb } from "../cli-dispatch";
import { formatKroner } from "../cli-format";
import type { CommandDispatch } from "../cli-dispatch";

export function register(dispatch: CommandDispatch): void {
  dispatch.on("documents", "ingest", (ctx) => {
    const file = ctx.arg("--file");
    const metadataFile = ctx.arg("--metadata");
    if (!file || !metadataFile) {
      console.error("Missing required --file <path> or --metadata <file.json>");
      process.exit(2);
    }
    const root = ctx.companyRoot();
    const db = openDb(companyPaths(root).db);
    migrate(db);
    const metadata = JSON.parse(readFileSync(metadataFile, "utf8"));
    const vendorIdRaw = ctx.arg("--vendor-id");
    const vendorId = vendorIdRaw === undefined ? undefined : Number(vendorIdRaw);
    const resolved = resolveDocumentMasterData(db, metadata, {
      vendorId: vendorId !== undefined && Number.isInteger(vendorId) && vendorId > 0 ? vendorId : undefined,
    });
    if (!resolved.ok) {
      ctx.emitResult(resolved as Record<string, unknown>);
      db.close();
      process.exit(1);
    }
    const result = ingestDocument(db, root, file, resolved.metadata, {
      forceDuplicateLogicalIdentity: ctx.hasFlag("--force"),
    });
    if (!result.ok) {
      recordException(db, {
        type: "DOCUMENT_INGEST_BLOCKED",
        severity: "medium",
        message: `Document ingest blocked for ${file}`,
        requiredAction: "Fix document metadata or duplicate handling, then retry ingest.",
        sourceEvidence: {
          file,
          metadataFile,
          errors: result.errors ?? [],
        },
        postingPreview: {
          retryCommand:
            "documents ingest --company <path> --file <file> --metadata <file.json>",
        },
      });
    }
    ctx.emitResult(result as Record<string, unknown>);
    db.close();
  });

  dispatch.on("documents", "list", (ctx) => {
    const db = openCommandDb(ctx);
    migrate(db);
    const rows = db
      .query(
        "SELECT id, document_no, source, original_filename, invoice_date, amount_inc_vat, currency, status, stored_path FROM documents ORDER BY id DESC",
      )
      .all() as Array<Record<string, unknown>>;
    if (ctx.outputFormat === "json") {
      console.log(JSON.stringify(rows, null, 2));
      db.close();
      return;
    }
    console.log(`Bilag (${rows.length})`);
    if (rows.length === 0) {
      console.log("Ingen bilag gemt.");
    }
    for (const row of rows) {
      const currency = String(row.currency ?? "DKK").toUpperCase();
      console.log("");
      console.log(`#${row.document_no ?? row.id} — ${row.original_filename ?? "—"}`);
      console.log(`  Bilagsdato: ${row.invoice_date ?? "—"} | Kilde: ${row.source ?? "—"}`);
      let amountLine = `  Beløb (inkl. moms): ${formatKroner(row.amount_inc_vat)}`;
      if (currency !== "DKK") amountLine += ` ${currency}`;
      console.log(amountLine);
      console.log(`  Status: ${row.status ?? "—"}`);
    }
    db.close();
  });
}

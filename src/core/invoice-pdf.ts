import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import type { InvoicePayload } from "./invoice";
import { companyPaths } from "./paths";
import { insertAuditLog } from "./actor";
import { promoteTempFile, removeIfExists, writeTempFileFor } from "./atomic-file";
import { formatAmount } from "./money";

const RULE_ID = "DK-INVOICE-ISSUE-001";
const PDF_DOCUMENT_TYPE = "issued_invoice_pdf";

export type RenderIssuedInvoicePdfInput = {
  invoiceDocumentId: number;
};

export type RenderIssuedInvoicePdfResult = {
  ok: boolean;
  renderDocumentId?: number;
  invoiceNumber?: string;
  storedPath?: string;
  sha256?: string;
  appliedRules: string[];
  errors: string[];
};

/**
 * Payment instructions printed on the invoice so the customer knows where to
 * send the money. Sourced from the ledger's `bank_accounts` data; every field
 * is optional so partially-configured companies still produce a valid PDF.
 */
export type InvoicePaymentDetails = {
  bankName?: string | null;
  /** Danish 4-digit bank registration number (registreringsnummer). */
  registrationNo?: string | null;
  /** Danish bank account number (kontonummer). */
  accountNo?: string | null;
  iban?: string | null;
  /** Optional SWIFT/BIC for foreign transfers. */
  bic?: string | null;
};

/**
 * The full payload `buildIssuedInvoicePdf` accepts: a validated `InvoicePayload`
 * plus the issued-invoice metadata and the optional rendering extras (payment
 * details + a lightweight text logo). Keeping these extras here — rather than in
 * the core `InvoicePayload` — keeps the validator unaware of presentation data.
 */
export type IssuedInvoicePdfPayload = InvoicePayload & {
  invoiceNumber?: string;
  issuedAt?: string;
  status?: string;
  /** Payment instructions; injected from ledger bank-account data on render. */
  payment?: InvoicePaymentDetails;
  /**
   * Lightweight brand mark. A short text string is rendered as a styled word
   * mark in the header. This is a deliberate minimal seam: an image-based logo
   * can be added later without changing the call sites.
   */
  logoText?: string | null;
};

function sha256(buffer: Uint8Array) {
  return createHash("sha256").update(buffer).digest("hex");
}

// ---------------------------------------------------------------------------
// Text encoding
//
// The previous renderer escaped headings to ASCII ("Saelger"/"Koeber") because
// the PDF strings were written as raw bytes with no declared font encoding, so
// any non-ASCII byte rendered as garbage. The fix is two-fold: declare
// /WinAnsiEncoding on the Type1 fonts (the encoding the standard 14 fonts ship
// with for Latin text) and encode every string into WinAnsi bytes. WinAnsi
// (CP1252) is a superset of Latin-1, so the Danish letters æ ø å Æ Ø Å map to
// fixed single bytes and render correctly in every PDF viewer.
// ---------------------------------------------------------------------------

/** Code points that differ between Unicode and WinAnsi (CP1252) byte values. */
const WINANSI_OVERRIDES: Record<number, number> = {
  8364: 0x80, // €
  8218: 0x82,
  402: 0x83,
  8222: 0x84,
  8230: 0x85, // …
  8224: 0x86,
  8225: 0x87,
  710: 0x88,
  8240: 0x89,
  352: 0x8a,
  8249: 0x8b,
  338: 0x8c, // Œ
  381: 0x8e,
  8216: 0x91,
  8217: 0x92, // ’
  8220: 0x93,
  8221: 0x94,
  8226: 0x95, // •
  8211: 0x96, // –
  8212: 0x97, // —
  732: 0x98,
  8482: 0x99,
  353: 0x9a,
  8250: 0x9b,
  339: 0x9c, // œ
  382: 0x9e,
  376: 0x9f,
};

/**
 * Encode a JS string into a WinAnsi (CP1252) byte string. Code points 0-255
 * pass through unchanged (Latin-1 is a strict subset — this covers all Danish
 * letters); a handful of typographic characters are remapped; anything else is
 * replaced with "?" so an exotic input can never corrupt the PDF byte stream.
 */
function encodeWinAnsi(value: string) {
  let out = "";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0x3f;
    if (code <= 0xff) {
      out += String.fromCharCode(code);
    } else if (WINANSI_OVERRIDES[code] !== undefined) {
      out += String.fromCharCode(WINANSI_OVERRIDES[code]);
    } else {
      out += "?";
    }
  }
  return out;
}

/** Escape a WinAnsi byte string for a PDF literal `( ... )` string. */
function escapePdfText(value: string) {
  return encodeWinAnsi(value)
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)")
    .replace(/\r/g, " ")
    .replace(/\n/g, " ");
}

function compact(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

// ---------------------------------------------------------------------------
// Danish number formatting (#225)
//
// A Danish invoice must show amounts the Danish way — thousands grouped with a
// period and the decimal separator a comma: `1.000,00`, not `1000.00`. The
// shared `money.ts` `formatAmount`/`formatDkk` emit the locale-free
// "1234.56" form for JSON/ledger stability; here, on the customer-facing PDF,
// we re-group that canonical string into Danish presentation. The arithmetic
// still runs through `money.ts`, so this is a pure presentation transform.
// ---------------------------------------------------------------------------

/** Re-group a canonical `formatAmount` string ("-1234.56") into Danish
 *  presentation ("-1.234,56"). Returns null for null input. */
function toDanishNumber(canonical: string | null): string | null {
  if (canonical == null) return null;
  const negative = canonical.startsWith("-");
  const unsigned = negative ? canonical.slice(1) : canonical;
  const [whole = "0", fraction = "00"] = unsigned.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${negative ? "-" : ""}${grouped},${fraction}`;
}

/** Format a monetary amount in Danish number format ("1.000,00"), no currency
 *  suffix. Returns null for null/undefined/empty/NaN. */
function formatDanishAmount(value: number | string | null | undefined): string | null {
  return toDanishNumber(formatAmount(value));
}

/** Format a monetary amount in Danish number format with a currency suffix
 *  ("1.000,00 DKK"). Returns null for invalid input. */
function formatDanishDkk(value: number | string | null | undefined, currency = "DKK"): string | null {
  const amount = formatDanishAmount(value);
  if (amount == null) return null;
  return `${amount} ${currency.trim().toUpperCase()}`;
}

function amountLabel(value: unknown, currency = "DKK") {
  if (value == null || value === "") return null;
  const amount = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(amount)) return null;
  return formatDanishDkk(amount, currency);
}

// ---------------------------------------------------------------------------
// Page geometry (A4, points). The layout is fully deterministic: the same
// payload always produces the same element positions and therefore byte-
// identical PDF output.
// ---------------------------------------------------------------------------

const PAGE_WIDTH = 595;
const PAGE_HEIGHT = 842;
const MARGIN_X = 56;
const CONTENT_RIGHT = PAGE_WIDTH - MARGIN_X;
const PAGE_TOP = PAGE_HEIGHT - 56;
const PAGE_BOTTOM = 70;
const LINE_HEIGHT = 14;

type FontName = "F1" | "F2"; // F1 = Helvetica, F2 = Helvetica-Bold

type TextOp = {
  kind: "text";
  x: number;
  y: number;
  size: number;
  font: FontName;
  gray: number;
  text: string;
};
type RectOp = { kind: "rect"; x: number; y: number; w: number; h: number; gray: number };
type LineOp = { kind: "line"; x1: number; y1: number; x2: number; y2: number; gray: number; width: number };
type DrawOp = TextOp | RectOp | LineOp;

/** Approximate Helvetica advance widths (per 1pt of font size), good enough
 *  for right-alignment and column fitting without embedding font metrics. */
function textWidth(text: string, size: number) {
  // Helvetica's average glyph advance is ~0.5em; capitals/digits a touch wider.
  let units = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 0x20) units += 278;
    else if (code >= 0x30 && code <= 0x39) units += 556; // digits
    else if (/[A-ZÆØÅ]/.test(char)) units += 667;
    else if (/[.,:;'|!]/.test(char)) units += 280;
    else units += 540;
  }
  return (units / 1000) * size;
}

/** Right-align: x-coordinate at which a string of `text` should start so it
 *  ends at `rightX`. */
function rightAlignX(text: string, size: number, rightX: number) {
  return rightX - textWidth(text, size);
}

/** Truncate a string with an ellipsis so it fits inside `maxWidth`. */
function fitText(text: string, size: number, maxWidth: number) {
  if (textWidth(text, size) <= maxWidth) return text;
  let cut = text;
  while (cut.length > 1 && textWidth(`${cut}…`, size) > maxWidth) {
    cut = cut.slice(0, -1);
  }
  return `${cut.trimEnd()}…`;
}

/**
 * A page being laid out. `y` is the current baseline cursor; helpers append
 * draw operations and advance the cursor. When a page fills up the builder
 * flushes it and starts a fresh one so no content is ever dropped.
 */
class PageWriter {
  ops: DrawOp[] = [];
  y = PAGE_TOP;

  hasRoom(needed: number) {
    return this.y - needed >= PAGE_BOTTOM;
  }

  text(x: number, text: string, opts: { size?: number; font?: FontName; gray?: number } = {}) {
    this.ops.push({
      kind: "text",
      x,
      y: this.y,
      size: opts.size ?? 10,
      font: opts.font ?? "F1",
      gray: opts.gray ?? 0,
      text,
    });
  }

  /** Place text at an explicit baseline (does not move the cursor). */
  textAt(x: number, y: number, text: string, opts: { size?: number; font?: FontName; gray?: number } = {}) {
    this.ops.push({
      kind: "text",
      x,
      y,
      size: opts.size ?? 10,
      font: opts.font ?? "F1",
      gray: opts.gray ?? 0,
      text,
    });
  }

  rect(x: number, y: number, w: number, h: number, gray: number) {
    this.ops.push({ kind: "rect", x, y, w, h, gray });
  }

  hline(y: number, gray = 0, width = 0.75, x1 = MARGIN_X, x2 = CONTENT_RIGHT) {
    this.ops.push({ kind: "line", x1, y1: y, x2, y2: y, gray, width });
  }

  advance(amount = LINE_HEIGHT) {
    this.y -= amount;
  }
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

type LineItem = { description: string; quantity: string; unitPrice: string; lineTotal: string };

function buildLineItems(payload: IssuedInvoicePdfPayload, _currency: string): LineItem[] {
  return (payload.lines ?? []).map((line) => ({
    description: compact(line.description) ?? "",
    quantity: line.quantity == null ? "" : String(line.quantity),
    unitPrice: line.unitPriceExVat == null ? "" : (formatDanishAmount(line.unitPriceExVat) ?? ""),
    lineTotal: line.lineTotalExVat == null ? "" : (formatDanishAmount(line.lineTotalExVat) ?? ""),
  }));
}

function paymentLines(payment: InvoicePaymentDetails | undefined): string[] {
  if (!payment) return [];
  const lines: string[] = [];
  const bank = compact(payment.bankName);
  if (bank) lines.push(bank);
  const reg = compact(payment.registrationNo);
  const acct = compact(payment.accountNo);
  if (reg && acct) lines.push(`Reg.nr. ${reg}  Kontonr. ${acct}`);
  else if (acct) lines.push(`Kontonr. ${acct}`);
  else if (reg) lines.push(`Reg.nr. ${reg}`);
  const iban = compact(payment.iban);
  if (iban) lines.push(`IBAN: ${iban}`);
  const bic = compact(payment.bic);
  if (bic) lines.push(`SWIFT/BIC: ${bic}`);
  return lines;
}

/** Lay the whole invoice out across one or more A4 pages. */
function layoutInvoice(payload: IssuedInvoicePdfPayload): PageWriter[] {
  const currency = (payload.currency ?? "DKK").trim().toUpperCase();
  const pages: PageWriter[] = [];
  let page = new PageWriter();
  pages.push(page);

  const newPage = () => {
    page = new PageWriter();
    pages.push(page);
  };

  // ----- Header: brand mark (left) + invoice meta box (right) -----
  const sellerName = compact(payload.seller?.name);
  const brand = compact(payload.logoText) ?? sellerName ?? "Faktura";
  page.textAt(MARGIN_X, PAGE_TOP, brand, { size: 20, font: "F2", gray: 0 });

  page.textAt(rightAlignX("FAKTURA", 22, CONTENT_RIGHT), PAGE_TOP + 2, "FAKTURA", {
    size: 22,
    font: "F2",
    gray: 0.15,
  });

  // Invoice metadata, right-aligned under the FAKTURA title.
  const metaPairs: Array<[string, string]> = [];
  if (compact(payload.invoiceNumber)) metaPairs.push(["Fakturanr.", payload.invoiceNumber!.trim()]);
  if (compact(payload.issueDate)) metaPairs.push(["Fakturadato", payload.issueDate!.trim()]);
  if (compact(payload.dueDate)) metaPairs.push(["Forfaldsdato", payload.dueDate!.trim()]);
  if (compact(payload.deliveryDate)) metaPairs.push(["Leveringsdato", payload.deliveryDate!.trim()]);
  else if (compact(payload.deliveryPeriodStart) && compact(payload.deliveryPeriodEnd)) {
    metaPairs.push(["Leveringsperiode", `${payload.deliveryPeriodStart!.trim()} – ${payload.deliveryPeriodEnd!.trim()}`]);
  }
  metaPairs.push(["Valuta", currency]);

  let metaY = PAGE_TOP - 26;
  for (const [label, value] of metaPairs) {
    page.textAt(rightAlignX(label, 8, CONTENT_RIGHT - 130), metaY, label, { size: 8, font: "F1", gray: 0.45 });
    page.textAt(rightAlignX(value, 9.5, CONTENT_RIGHT), metaY, value, { size: 9.5, font: "F2", gray: 0 });
    metaY -= 13;
  }

  // Rule under the header.
  const headerBottom = Math.min(PAGE_TOP - 36, metaY) - 4;
  page.hline(headerBottom, 0.7, 1);
  page.y = headerBottom - 22;

  // ----- Seller / Buyer blocks, side by side -----
  const colWidth = (CONTENT_RIGHT - MARGIN_X - 24) / 2;
  const buyerX = MARGIN_X + colWidth + 24;
  const blockTop = page.y;

  const partyLines = (party?: { name?: string; address?: string; vatOrCvr?: string }) => {
    const out: string[] = [];
    if (compact(party?.name)) out.push(party!.name!.trim());
    for (const part of (compact(party?.address) ?? "").split(/\r?\n/)) {
      if (part.trim()) out.push(part.trim());
    }
    if (compact(party?.vatOrCvr)) out.push(`CVR/SE: ${party!.vatOrCvr!.trim()}`);
    return out;
  };

  const drawParty = (x: number, heading: string, lines: string[]) => {
    let yy = blockTop;
    page.textAt(x, yy, heading, { size: 8.5, font: "F2", gray: 0.45 });
    yy -= 16;
    if (lines.length === 0) {
      page.textAt(x, yy, "—", { size: 10, gray: 0.5 });
      yy -= LINE_HEIGHT;
    }
    for (const [i, line] of lines.entries()) {
      page.textAt(x, yy, fitText(line, i === 0 ? 11 : 9.5, colWidth), {
        size: i === 0 ? 11 : 9.5,
        font: i === 0 ? "F2" : "F1",
        gray: i === 0 ? 0 : 0.25,
      });
      yy -= i === 0 ? 16 : LINE_HEIGHT;
    }
    return yy;
  };

  const sellerBottom = drawParty(MARGIN_X, "SÆLGER", partyLines(payload.seller));
  const buyerBottom = drawParty(buyerX, "KØBER", partyLines(payload.buyer));
  page.y = Math.min(sellerBottom, buyerBottom) - 18;

  // ----- Line-item table -----
  // Columns: description (flex), quantity, unit price, line total.
  const colTotalRight = CONTENT_RIGHT;
  const colUnitRight = colTotalRight - 96;
  const colQtyRight = colUnitRight - 70;
  const descX = MARGIN_X + 6;
  const descMaxWidth = colQtyRight - 60 - descX;

  const tableHeaderHeight = 20;
  const rowHeight = 20;

  const drawTableHeader = () => {
    const top = page.y;
    page.rect(MARGIN_X, top - tableHeaderHeight, CONTENT_RIGHT - MARGIN_X, tableHeaderHeight, 0.92);
    const labelY = top - 14;
    page.textAt(descX, labelY, "Beskrivelse", { size: 8.5, font: "F2", gray: 0.35 });
    page.textAt(rightAlignX("Antal", 8.5, colQtyRight), labelY, "Antal", { size: 8.5, font: "F2", gray: 0.35 });
    page.textAt(rightAlignX("Stykpris", 8.5, colUnitRight), labelY, "Stykpris", { size: 8.5, font: "F2", gray: 0.35 });
    page.textAt(rightAlignX("Beløb", 8.5, colTotalRight), labelY, "Beløb", { size: 8.5, font: "F2", gray: 0.35 });
    page.hline(top - tableHeaderHeight, 0.55, 0.75);
    page.y = top - tableHeaderHeight;
  };

  const items = buildLineItems(payload, currency);
  drawTableHeader();

  for (const [index, item] of items.entries()) {
    if (!page.hasRoom(rowHeight + 4)) {
      newPage();
      page.y = PAGE_TOP;
      drawTableHeader();
    }
    const rowTop = page.y;
    if (index % 2 === 1) {
      page.rect(MARGIN_X, rowTop - rowHeight, CONTENT_RIGHT - MARGIN_X, rowHeight, 0.97);
    }
    const cellY = rowTop - 14;
    page.textAt(descX, cellY, fitText(item.description || "—", 9.5, descMaxWidth), { size: 9.5, gray: 0.1 });
    if (item.quantity) page.textAt(rightAlignX(item.quantity, 9.5, colQtyRight), cellY, item.quantity, { size: 9.5, gray: 0.1 });
    if (item.unitPrice) page.textAt(rightAlignX(item.unitPrice, 9.5, colUnitRight), cellY, item.unitPrice, { size: 9.5, gray: 0.1 });
    if (item.lineTotal) {
      page.textAt(rightAlignX(item.lineTotal, 9.5, colTotalRight), cellY, item.lineTotal, { size: 9.5, font: "F2", gray: 0 });
    }
    page.hline(rowTop - rowHeight, 0.9, 0.4);
    page.y = rowTop - rowHeight;
  }

  // ----- Totals block (right-aligned), kept together on one page -----
  const totalRows: Array<{ label: string; value: string; emphasis?: boolean }> = [];
  const net = amountLabel(payload.totals?.netAmount, currency);
  const vat = amountLabel(payload.totals?.vatAmount, currency);
  const gross = amountLabel(payload.totals?.grossAmount, currency);
  if (net) totalRows.push({ label: "Netto", value: net });
  if (payload.totals?.vatRate != null && Number.isFinite(Number(payload.totals.vatRate))) {
    const pct = (Number(payload.totals.vatRate) * 100).toFixed(Number.isInteger(Number(payload.totals.vatRate) * 100) ? 0 : 2);
    if (vat) totalRows.push({ label: `Moms (${pct}%)`, value: vat });
  } else if (vat) {
    totalRows.push({ label: "Moms", value: vat });
  }
  if (gross) totalRows.push({ label: "Total", value: gross, emphasis: true });
  const fx = payload.totals?.fxRateToDkk == null ? null : Number(payload.totals.fxRateToDkk).toFixed(6);
  const grossDkk = amountLabel(payload.totals?.grossAmountDkk, "DKK");
  if (currency !== "DKK" && fx) totalRows.push({ label: "Valutakurs til DKK", value: fx });
  if (currency !== "DKK" && grossDkk) totalRows.push({ label: "Total i DKK", value: grossDkk, emphasis: true });

  const totalsHeight = totalRows.length * 16 + 14;
  if (!page.hasRoom(totalsHeight + 10)) {
    newPage();
    page.y = PAGE_TOP;
  } else {
    page.advance(12);
  }

  const totalsLabelRight = CONTENT_RIGHT - 120;
  const totalsBlockLeft = MARGIN_X + colWidth + 24;
  for (const row of totalRows) {
    if (row.emphasis) {
      page.rect(totalsBlockLeft, page.y - 17, CONTENT_RIGHT - totalsBlockLeft, 19, 0.92);
      page.y -= 4;
    }
    const size = row.emphasis ? 11 : 9.5;
    const font: FontName = row.emphasis ? "F2" : "F1";
    page.textAt(rightAlignX(row.label, size, totalsLabelRight), page.y - 8, row.label, {
      size,
      font,
      gray: row.emphasis ? 0 : 0.4,
    });
    page.textAt(rightAlignX(row.value, size, CONTENT_RIGHT), page.y - 8, row.value, {
      size,
      font: "F2",
      gray: 0,
    });
    page.y -= 16;
  }

  // ----- Payment details -----
  const payLines = paymentLines(payload.payment);
  if (payLines.length > 0) {
    const blockHeight = payLines.length * LINE_HEIGHT + 26;
    if (!page.hasRoom(blockHeight + 8)) {
      newPage();
      page.y = PAGE_TOP;
    } else {
      page.advance(22);
    }
    page.hline(page.y, 0.85, 0.5);
    page.advance(16);
    page.text(MARGIN_X, "BETALING", { size: 8.5, font: "F2", gray: 0.45 });
    page.advance(16);
    for (const line of payLines) {
      page.text(MARGIN_X, line, { size: 9.5, gray: 0.15 });
      page.advance(LINE_HEIGHT);
    }
    if (compact(payload.invoiceNumber)) {
      page.text(MARGIN_X, `Anfør fakturanr. ${payload.invoiceNumber!.trim()} ved betaling.`, {
        size: 8.5,
        gray: 0.45,
      });
      page.advance(LINE_HEIGHT);
    }
  }

  // ----- Reverse-charge / legal note -----
  if (compact(payload.reverseChargeNote)) {
    if (!page.hasRoom(40)) {
      newPage();
      page.y = PAGE_TOP;
    } else {
      page.advance(14);
    }
    page.text(MARGIN_X, "NOTE", { size: 8.5, font: "F2", gray: 0.45 });
    page.advance(14);
    // Wrap the note to the content width.
    for (const wrapped of wrapText(payload.reverseChargeNote!.trim(), 9, CONTENT_RIGHT - MARGIN_X)) {
      if (!page.hasRoom(LINE_HEIGHT)) {
        newPage();
        page.y = PAGE_TOP;
      }
      page.text(MARGIN_X, wrapped, { size: 9, gray: 0.2 });
      page.advance(LINE_HEIGHT);
    }
  }

  return pages;
}

/** Greedy word-wrap to a pixel width using the Helvetica advance estimate. */
function wrapText(text: string, size: number, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (textWidth(candidate, size) > maxWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [""];
}

// ---------------------------------------------------------------------------
// PDF serialisation
// ---------------------------------------------------------------------------

function fmtNum(value: number) {
  // Deterministic, locale-free fixed-precision number for PDF *geometry*
  // operators (coordinates, widths, font sizes) — never currency amounts.
  // Currency always goes through money.ts (formatAmount/formatDkk).
  // money-allowed: page-coordinate rounding, not monetary math.
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function pageContentStream(page: PageWriter, footer: string) {
  const parts: string[] = [];
  // Footer baseline (drawn first so content can never overlap it).
  parts.push(
    `BT /F1 7.5 Tf 0.5 g 1 0 0 1 ${fmtNum(MARGIN_X)} ${fmtNum(PAGE_BOTTOM - 22)} Tm (${escapePdfText(footer)}) Tj ET`,
  );
  parts.push(`0.85 g ${fmtNum(MARGIN_X)} ${fmtNum(PAGE_BOTTOM - 10)} m ${fmtNum(CONTENT_RIGHT)} ${fmtNum(PAGE_BOTTOM - 10)} l 0.5 w S`);

  for (const op of page.ops) {
    if (op.kind === "rect") {
      parts.push(`${fmtNum(op.gray)} g ${fmtNum(op.x)} ${fmtNum(op.y)} ${fmtNum(op.w)} ${fmtNum(op.h)} re f`);
    } else if (op.kind === "line") {
      parts.push(
        `${fmtNum(op.gray)} G ${fmtNum(op.width)} w ${fmtNum(op.x1)} ${fmtNum(op.y1)} m ${fmtNum(op.x2)} ${fmtNum(op.y2)} l S`,
      );
    } else {
      parts.push(
        `BT /${op.font} ${fmtNum(op.size)} Tf ${fmtNum(op.gray)} g 1 0 0 1 ${fmtNum(op.x)} ${fmtNum(op.y)} Tm (${escapePdfText(op.text)}) Tj ET`,
      );
    }
  }
  return `${parts.join("\n")}\n`;
}

/**
 * Render an issued invoice into a professional, deterministic A4 PDF.
 *
 * Deterministic by construction: the same payload always produces the same
 * draw operations (the layout never reads the clock or the filesystem) and
 * therefore byte-identical output. The `CreationDate`/`ModDate` are derived
 * solely from the invoice's issue date.
 */
export function buildIssuedInvoicePdf(payload: IssuedInvoicePdfPayload) {
  const pages = layoutInvoice(payload);
  const issueDate = compact(payload.issueDate) ?? "1970-01-01";
  const pdfDate = `D:${issueDate.replace(/-/g, "")}000000Z`;
  const producer = "Rentemester deterministic invoice renderer";
  const title = `Faktura ${compact(payload.invoiceNumber) ?? ""}`.trim();

  // Object layout: 1 Catalog, 2 Pages, then per page a Page + Contents object,
  // then the two Font objects (F1, F2) and the Info object.
  const pageCount = pages.length;
  const pageObjectNos = pages.map((_, i) => 3 + i * 2);
  const fontRegularNo = 3 + pageCount * 2;
  const fontBoldNo = fontRegularNo + 1;
  const infoObjectNo = fontBoldNo + 1;

  const objects: string[] = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    `2 0 obj\n<< /Type /Pages /Count ${pageCount} /Kids [${pageObjectNos.map((n) => `${n} 0 R`).join(" ")}] >>\nendobj\n`,
  ];
  pages.forEach((page, i) => {
    const pageNo = pageObjectNos[i];
    const contentNo = pageNo + 1;
    // ASCII separator (#225): a non-ASCII bullet/middle-dot in the footer
    // rendered as a broken glyph in some PDF viewers ("Faktura 2026-0001 <?>
    // Side 1"). A plain hyphen is safe in every viewer and font.
    const footer = `${title} - Side ${i + 1} af ${pageCount}`;
    const content = pageContentStream(page, footer);
    objects.push(
      `${pageNo} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
        `/Resources << /Font << /F1 ${fontRegularNo} 0 R /F2 ${fontBoldNo} 0 R >> >> /Contents ${contentNo} 0 R >>\nendobj\n`,
    );
    objects.push(
      `${contentNo} 0 obj\n<< /Length ${Buffer.byteLength(content, "binary")} >>\nstream\n${content}endstream\nendobj\n`,
    );
  });
  objects.push(
    `${fontRegularNo} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n`,
  );
  objects.push(
    `${fontBoldNo} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>\nendobj\n`,
  );
  objects.push(
    `${infoObjectNo} 0 obj\n<< /Producer (${escapePdfText(producer)}) /Title (${escapePdfText(title)}) ` +
      `/CreationDate (${pdfDate}) /ModDate (${pdfDate}) >>\nendobj\n`,
  );

  let pdf = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
  const offsets: number[] = [0];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(pdf, "binary"));
    pdf += object;
  }
  const xrefOffset = Buffer.byteLength(pdf, "binary");
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (let i = 1; i < offsets.length; i += 1) {
    pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${infoObjectNo} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "binary");
}

/**
 * Resolve the company's payment instructions from the ledger's `bank_accounts`
 * table. Deterministic: prefers the lowest-id active account whose currency
 * matches the invoice, then any lowest-id active account. Returns `undefined`
 * when no account is configured so the PDF simply omits the payment block.
 */
function resolvePaymentDetails(db: Database, currency: string): InvoicePaymentDetails | undefined {
  let rows: Array<{
    bank_name: string | null;
    registration_no: string | null;
    account_no: string | null;
    iban: string | null;
    currency: string | null;
  }> = [];
  try {
    rows = db
      .query(
        `SELECT bank_name, registration_no, account_no, iban, currency
           FROM bank_accounts
          WHERE active = 1
          ORDER BY id ASC`,
      )
      .all() as typeof rows;
  } catch {
    // The table may not exist in very old ledgers; payment block is optional.
    return undefined;
  }
  if (rows.length === 0) return undefined;
  const wanted = currency.trim().toUpperCase();
  const match =
    rows.find((row) => (row.currency ?? "").trim().toUpperCase() === wanted) ?? rows[0];
  const details: InvoicePaymentDetails = {
    bankName: match.bank_name,
    registrationNo: match.registration_no,
    accountNo: match.account_no,
    iban: match.iban,
  };
  // Only return a block if at least one field carries real payment information.
  if (!compact(details.bankName) && !compact(details.registrationNo) && !compact(details.accountNo) && !compact(details.iban)) {
    return undefined;
  }
  return details;
}

export function renderIssuedInvoicePdf(db: Database, companyRoot: string, input: RenderIssuedInvoicePdfInput): RenderIssuedInvoicePdfResult {
  const invoice = db.query(
    `SELECT id, invoice_no, invoice_date, payload_json, status, retain_until
     FROM documents WHERE id = ? AND document_type = 'issued_invoice'`
  ).get(input.invoiceDocumentId) as {
    id: number;
    invoice_no: string | null;
    invoice_date: string | null;
    payload_json: string | null;
    status: string | null;
    retain_until: string | null;
  } | null;

  if (!invoice) return { ok: false, appliedRules: [RULE_ID], errors: [`invoice document ${input.invoiceDocumentId} does not exist or is not an issued invoice`] };
  if (!invoice.payload_json) return { ok: false, appliedRules: [RULE_ID], errors: [`invoice ${invoice.invoice_no ?? input.invoiceDocumentId} is missing payload_json`] };

  const payload = JSON.parse(invoice.payload_json) as IssuedInvoicePdfPayload;
  const invoiceNumber = compact(invoice.invoice_no ?? payload.invoiceNumber);
  if (!invoiceNumber) return { ok: false, appliedRules: [RULE_ID], errors: ["issued invoice is missing invoice number"] };

  const paths = companyPaths(companyRoot);
  mkdirSync(paths.invoicesIssued, { recursive: true });
  const storedPath = join(paths.invoicesIssued, `${invoiceNumber}.pdf`);
  // Payment details from the payload win; otherwise pull them from the ledger.
  const currency = (payload.currency ?? "DKK").trim().toUpperCase();
  const payment = payload.payment ?? resolvePaymentDetails(db, currency);
  const bytes = buildIssuedInvoicePdf({
    ...payload,
    invoiceNumber,
    status: payload.status ?? invoice.status ?? "issued",
    ...(payment ? { payment } : {}),
  });
  const hash = sha256(bytes);
  let tempPath: string | undefined;

  try {
    const result = db.transaction(() => {
      const existing = db.query(
        `SELECT id, sha256_hash, stored_path FROM documents
         WHERE document_type = ? AND invoice_no = ?
         ORDER BY id DESC LIMIT 1`
      ).get(PDF_DOCUMENT_TYPE, invoiceNumber) as { id: number; sha256_hash: string; stored_path: string | null } | null;

      tempPath = writeTempFileFor(storedPath, bytes);

      if (existing && existing.sha256_hash === hash) {
        return { renderDocumentId: existing.id };
      }

      // A prior PDF document row already exists (created at issue time or by an
      // earlier render) but its bytes differ — e.g. payment details were added
      // to the ledger after issuance. Update that row in place: the PDF
      // `document_no` (`<invoice>-pdf`) is unique, so a fresh INSERT would hit
      // the unique constraint.
      if (existing) {
        db.query(
          `UPDATE documents SET sha256_hash = ?, stored_path = ? WHERE id = ?`,
        ).run(hash, storedPath, existing.id);
        insertAuditLog(db, {
          eventType: "invoice_render_pdf",
          entityType: "document",
          entityId: existing.id,
          message: `Re-rendered invoice PDF ${invoiceNumber}`,
        });
        return { renderDocumentId: existing.id };
      }

      const inserted = db.query(
        `INSERT INTO documents (
          document_no, source, original_filename, stored_path, mime_type, sha256_hash,
          supplier_name, invoice_no, invoice_date, amount_inc_vat, currency, status,
          document_type, sender_name, sender_address, sender_vat_cvr,
          recipient_name, recipient_address, recipient_vat_cvr, vat_amount, payload_json, retain_until
        ) VALUES (?, 'rentemester', ?, ?, 'application/pdf', ?, ?, ?, ?, ?, ?, 'issued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING id`
      ).get(
        `${invoiceNumber}-pdf`,
        `${invoiceNumber}.pdf`,
        storedPath,
        hash,
        payload.seller?.name ?? null,
        invoiceNumber,
        invoice.invoice_date ?? payload.issueDate ?? null,
        payload.totals?.grossAmount ?? null,
        payload.currency ?? "DKK",
        PDF_DOCUMENT_TYPE,
        payload.seller?.name ?? null,
        payload.seller?.address ?? null,
        payload.seller?.vatOrCvr ?? null,
        payload.buyer?.name ?? null,
        payload.buyer?.address ?? null,
        payload.buyer?.vatOrCvr ?? null,
        payload.totals?.vatAmount ?? null,
        invoice.payload_json,
        invoice.retain_until ?? null,
      ) as { id: number };

      insertAuditLog(db, {
        eventType: "invoice_render_pdf",
        entityType: "document",
        entityId: inserted.id,
        message: `Rendered invoice PDF ${invoiceNumber}`,
      });

      return { renderDocumentId: inserted.id };
    }, { immediate: true })();

    promoteTempFile(tempPath!, storedPath);
    return { ok: true, renderDocumentId: result.renderDocumentId, invoiceNumber, storedPath, sha256: hash, appliedRules: [RULE_ID], errors: [] };
  } catch (error) {
    if (tempPath) removeIfExists(tempPath);
    return { ok: false, appliedRules: [RULE_ID], errors: [String(error)] };
  }
}

export function readIssuedInvoicePdfText(path: string) {
  return readFileSync(path, "latin1");
}

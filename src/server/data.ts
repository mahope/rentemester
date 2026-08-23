// Read-side data assembly for the cockpit backend (#170).
//
// Every figure here is computed by an existing core function — this module
// only opens the right ledger, calls core, and shapes the JSON. No business
// logic is duplicated and nothing here mutates a ledger.

import { existsSync } from "node:fs";
import type { Database } from "bun:sqlite";
import { companyPaths } from "../core/paths";
import { diffDaysSafe as daysBetween } from "../core/dates";
import { openDb, migrate } from "../core/db";
import {
  getCompanySettings,
  resolveCompanyPaymentDetails,
  syncCompanyFromCvr,
  type CompanyPaymentDetails,
  type CompanySettings,
  type SyncCompanyFromCvrResult,
} from "../core/company";
import { fiscalYearForDate } from "../core/fiscal-year";
import { buildInvoiceList, buildOverdueInvoiceList } from "../core/invoice-list";
import { listCustomers, listVendors } from "../core/master-data";
import { listBankTransactions } from "../core/reconciliation";
import { listExceptions } from "../core/exceptions";
import { buildVatReport } from "../core/vat";
import { addDkk, percentOfDkk, subtractDkk } from "../core/money";
import {
  buildBalanceSheet,
  buildProfitAndLoss,
  buildTrialBalance,
} from "../core/financial-statements";
import { listBankAccounts } from "../core/bank";
import {
  vatPeriodWindowFor,
  vatPeriodsForYear,
  vatPeriodLabel,
  effectivePeriodState,
  type VatPeriodType,
  type EffectivePeriodState,
} from "../core/periods";
import { getBackupComplianceStatus } from "../core/system-backups";
import { listRecentAuditLog } from "../core/audit-log";
import { verifyAuditChain } from "../core/ledger";
import {
  companyRootForSlug,
  findWorkspaceCompany,
  type WorkspaceCompanyEntry,
} from "../core/workspace";
import { discoverWorkspaceCompanies } from "./discovery";
import { ApiError } from "./errors";

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Today as YYYY-MM-DD (UTC). The clock lives here, not in core. */
export function todayIsoDate(): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Validates an optional `?as-of=` query value, defaulting to today. */
export function resolveAsOfDate(raw: string | null | undefined): string {
  if (raw === null || raw === undefined || raw.length === 0) return todayIsoDate();
  if (!ISO_DATE_RE.test(raw)) {
    throw ApiError.badRequest("asOf must be a YYYY-MM-DD date");
  }
  return raw;
}

// --------------------------------------------------------------------------
// Per-company summary (one row in the portfolio overview)
// --------------------------------------------------------------------------

/** The VAT block on a portfolio card — null when no VAT period is known. */
export type CompanyVatSummary = {
  /** Net VAT payable for the company's current quarter, kroner. */
  payable: number;
  /** The statutory filing/payment deadline (YYYY-MM-DD). */
  deadline: string;
  /** Whole days from today to the deadline; negative when overdue. */
  daysRemaining: number;
};

export type CompanySummary = {
  slug: string;
  name: string;
  cvr: string | null;
  archived: boolean;
  /** True when the slug is registered but has no ledger on disk. */
  ledgerMissing: boolean;
  /** The fiscal year these figures cover, e.g. "2026"; null when unknown. */
  fiscalYear: string | null;
  /** Year-to-date result (resultat) for the current fiscal year, kroner. */
  resultat: number;
  /** Year-to-date revenue (omsætning) for the current fiscal year, kroner. */
  omsaetning: number;
  /**
   * Actual bank balance from the imported statement, kroner — what the bank
   * app shows. Null when no statement balance is known for the company.
   */
  actualBankBalance: number | null;
  /** Current half-year VAT position + deadline; null when unknown. */
  vat: CompanyVatSummary | null;
  /** Open tasks — open exceptions, grouped into Danish summary lines. */
  openTaskCount: number;
  taskGroups: ExceptionGroup[];
  auditChainOk: boolean;
  // --- legacy fields retained for the MCP/older consumers -----------------
  openInvoiceCount: number;
  openInvoiceTotal: number;
  overdueInvoiceCount: number;
  unlinkedBankCount: number;
  /** Alias of `openTaskCount`. */
  openExceptionCount: number;
  /** Alias of `vat.payable` (0 when no VAT). */
  netVatPayable: number;
};

/**
 * The current (most recent live) fiscal year for a company — the same default
 * the per-company Overblik view uses. Falls back to today's calendar year when
 * the ledger has no posted entries yet. Returns the calendar year as a number.
 */
function currentFiscalYear(db: Database, settings: CompanySettings): {
  label: string;
  year: number;
} {
  const dateRows = db
    .query(
      "SELECT MAX(transaction_date) AS d FROM journal_entries WHERE status = 'posted'",
    )
    .get() as { d: string | null };
  const latest = dateRows?.d;
  if (latest && ISO_DATE_RE.test(latest)) {
    const fy = fiscalYearForDate(
      latest,
      settings.fiscalYearStartMonth,
      settings.fiscalYearLabelStrategy,
    );
    const y = parseInt(latest.slice(0, 4), 10);
    return { label: fy.identifierLabel, year: y };
  }
  const y = new Date().getUTCFullYear();
  return { label: String(y), year: y };
}

function summariseCompany(
  workspaceRoot: string,
  entry: WorkspaceCompanyEntry,
): CompanySummary {
  const companyRoot = companyRootForSlug(workspaceRoot, entry.slug);
  const dbPath = companyPaths(companyRoot).db;
  if (!existsSync(dbPath)) {
    return {
      slug: entry.slug,
      name: entry.name,
      cvr: null,
      archived: entry.archived,
      ledgerMissing: true,
      fiscalYear: null,
      resultat: 0,
      omsaetning: 0,
      actualBankBalance: null,
      vat: null,
      openTaskCount: 0,
      taskGroups: [],
      auditChainOk: false,
      openInvoiceCount: 0,
      openInvoiceTotal: 0,
      overdueInvoiceCount: 0,
      unlinkedBankCount: 0,
      openExceptionCount: 0,
      netVatPayable: 0,
    };
  }

  let db: Database;
  try {
    db = openDb(dbPath);
  } catch {
    // An unreadable ledger degrades gracefully — treated as "missing".
    return {
      slug: entry.slug,
      name: entry.name,
      cvr: null,
      archived: entry.archived,
      ledgerMissing: true,
      fiscalYear: null,
      resultat: 0,
      omsaetning: 0,
      actualBankBalance: null,
      vat: null,
      openTaskCount: 0,
      taskGroups: [],
      auditChainOk: false,
      openInvoiceCount: 0,
      openInvoiceTotal: 0,
      overdueInvoiceCount: 0,
      unlinkedBankCount: 0,
      openExceptionCount: 0,
      netVatPayable: 0,
    };
  }
  try {
    migrate(db);
    const company = getCompanySettings(db);
    const { label: fyLabel, year: yearNum } = currentFiscalYear(db, company);
    const yearStart = `${yearNum}-01-01`;
    const yearEnd = `${yearNum}-12-31`;

    // Resultat + omsætning — the same P&L the per-company Overblik renders.
    const pl = buildProfitAndLoss(db, yearStart, yearEnd);

    // Actual bank balance from the imported statement (what the bank shows).
    const actualBankBalance = actualBankBalanceAsOf(db, yearEnd);

    // VAT: the booked position for the company's actual VAT period — the
    // period (month / quarter / half-year, per `vatPeriodType`) that is due
    // now. Every cockpit surface reads the same cadence, so they agree (#299).
    const vatPeriod = selectVatPeriod(db, yearNum, company.vatPeriodType);
    const vat: CompanyVatSummary = {
      payable: vatPeriod.position.payable,
      deadline: vatPeriod.deadline,
      daysRemaining: daysBetween(todayIsoDate(), vatPeriod.deadline),
    };

    // Open tasks — open exceptions grouped into Danish summary lines.
    const exceptions = listExceptions(db, { status: "open" });
    const taskGroups = groupExceptions(
      exceptions.rows.map((row: any) => ({
        type: row.type,
        severity: row.severity,
      })),
    );

    // Legacy figures retained for older consumers.
    const invoices = buildInvoiceList(db, { status: "open", asOfDate: yearEnd });
    const overdue = buildOverdueInvoiceList(db, { asOfDate: yearEnd });
    const unlinked = listBankTransactions(db, { status: "unmatched" });
    const audit = verifyAuditChain(db);

    return {
      slug: entry.slug,
      name: company.name,
      cvr: company.cvr,
      archived: entry.archived,
      ledgerMissing: false,
      fiscalYear: fyLabel,
      resultat: pl.result,
      omsaetning: pl.totalIncome,
      actualBankBalance,
      vat,
      openTaskCount: exceptions.count,
      taskGroups,
      auditChainOk: audit.ok,
      openInvoiceCount: invoices.count,
      openInvoiceTotal: roundKroner(
        invoices.rows.reduce((acc, r) => acc + r.openBalance, 0),
      ),
      overdueInvoiceCount: overdue.count,
      unlinkedBankCount: unlinked.count,
      openExceptionCount: exceptions.count,
      netVatPayable: vat.payable,
    };
  } finally {
    db.close();
  }
}

export type PortfolioOverview = {
  workspace: string;
  asOf: string;
  companyCount: number;
  /**
   * Workspace-wide roll-up — "how is the whole portfolio doing". The figures
   * are summed across legal entities for a portfolio glance; each company is
   * still a separate entity and is judged on its own card.
   */
  rollup: {
    /** Combined year-to-date result across all companies, kroner. */
    resultat: number;
    /** Combined liquidity — actual bank balance across all companies, kroner. */
    liquidity: number;
    /** Combined VAT owed across all companies, kroner. */
    vatPayable: number;
    /** Total open tasks across all companies. */
    openTaskCount: number;
  };
  /** Legacy totals block, retained for older consumers. */
  totals: {
    openInvoiceCount: number;
    openInvoiceTotal: number;
    overdueInvoiceCount: number;
    unlinkedBankCount: number;
    openExceptionCount: number;
    netVatPayable: number;
  };
  companies: CompanySummary[];
};

/**
 * Aggregates one real-figure summary per workspace company plus a
 * workspace-wide roll-up. Each company's figures cover its current fiscal
 * year, computed by reusing the per-company core logic (`buildProfitAndLoss`,
 * `actualBankBalanceAsOf`, `vatPositionForPeriod`, the exception grouping).
 * `asOfDate` is retained on the response for backwards compatibility; the
 * figures themselves are year-to-date for each company's fiscal year.
 */
export function buildPortfolioOverview(
  workspaceRoot: string,
  asOfDate: string,
): PortfolioOverview {
  // Discover-and-adopt any present-but-unlisted company directory first
  // (#256): the portfolio is the cockpit's landing page, so an owner who set
  // a company up via the CLI must land on that real company — not onboarding.
  const entries = discoverWorkspaceCompanies(workspaceRoot);
  const companies = entries.map((entry) =>
    summariseCompany(workspaceRoot, entry),
  );
  const rollup = companies.reduce(
    (acc, c) => ({
      resultat: acc.resultat + c.resultat,
      liquidity: acc.liquidity + (c.actualBankBalance ?? 0),
      vatPayable: acc.vatPayable + (c.vat?.payable ?? 0),
      openTaskCount: acc.openTaskCount + c.openTaskCount,
    }),
    { resultat: 0, liquidity: 0, vatPayable: 0, openTaskCount: 0 },
  );
  const totals = companies.reduce(
    (acc, c) => ({
      openInvoiceCount: acc.openInvoiceCount + c.openInvoiceCount,
      openInvoiceTotal: acc.openInvoiceTotal + c.openInvoiceTotal,
      overdueInvoiceCount: acc.overdueInvoiceCount + c.overdueInvoiceCount,
      unlinkedBankCount: acc.unlinkedBankCount + c.unlinkedBankCount,
      openExceptionCount: acc.openExceptionCount + c.openExceptionCount,
      netVatPayable: acc.netVatPayable + c.netVatPayable,
    }),
    {
      openInvoiceCount: 0,
      openInvoiceTotal: 0,
      overdueInvoiceCount: 0,
      unlinkedBankCount: 0,
      openExceptionCount: 0,
      netVatPayable: 0,
    },
  );
  return {
    workspace: workspaceRoot,
    asOf: asOfDate,
    companyCount: companies.length,
    rollup: {
      resultat: roundKroner(rollup.resultat),
      liquidity: roundKroner(rollup.liquidity),
      vatPayable: roundKroner(rollup.vatPayable),
      openTaskCount: rollup.openTaskCount,
    },
    totals: {
      openInvoiceCount: totals.openInvoiceCount,
      openInvoiceTotal: roundKroner(totals.openInvoiceTotal),
      overdueInvoiceCount: totals.overdueInvoiceCount,
      unlinkedBankCount: totals.unlinkedBankCount,
      openExceptionCount: totals.openExceptionCount,
      netVatPayable: roundKroner(totals.netVatPayable),
    },
    companies,
  };
}

// --------------------------------------------------------------------------
// Per-company dashboard data
// --------------------------------------------------------------------------

export type CompanyDashboardData = ReturnType<typeof buildCompanyDashboardData>;

/**
 * Per-company dashboard data — the same figures the static HTML dashboard
 * (`src/core/dashboard.ts`) renders, returned as JSON for the cockpit SPA.
 *
 * Throws `ApiError.notFound` when the slug is not registered or the ledger is
 * missing on disk.
 */
export function buildCompanyDashboardData(
  workspaceRoot: string,
  slug: string,
  asOfDate: string,
) {
  const entry = findWorkspaceCompany(workspaceRoot, slug);
  if (!entry) {
    throw ApiError.notFound(`no company with slug '${slug}' in the workspace`);
  }
  const companyRoot = companyRootForSlug(workspaceRoot, slug);
  const dbPath = companyPaths(companyRoot).db;
  if (!existsSync(dbPath)) {
    throw ApiError.notFound(`company '${slug}' has no ledger`);
  }

  const db = openDb(dbPath);
  try {
    migrate(db);
    const company = getCompanySettings(db);
    const invoices = buildInvoiceList(db, { status: "open", asOfDate });
    const overdueInvoices = buildOverdueInvoiceList(db, { asOfDate });
    const unlinkedBank = listBankTransactions(db, { status: "unmatched" });
    const exceptions = listExceptions(db, { status: "open" });
    // VAT: surface the earliest unreported VAT period — the one the owner must
    // file now — exactly as the Overblik card and `vat momsangivelse` do
    // (#281). #299: the period follows the company's real VAT cadence
    // (`vatPeriodType`), so a monthly/half-yearly filer sees its own period.
    const { year: vatYear } = currentFiscalYear(db, company);
    const vatSelection = selectVatPeriod(db, vatYear, company.vatPeriodType);
    const period = { start: vatSelection.start, end: vatSelection.end };
    const vatPeriod = buildVatReport(db, period.start, period.end);
    const vatDeadline = vatSelection.deadline;
    const vatDaysRemaining = daysBetween(asOfDate, vatDeadline);
    const recentActivity = listRecentAuditLog(db, 10);
    const backup = getBackupComplianceStatus(db, companyRoot, asOfDate);
    const audit = verifyAuditChain(db);

    return {
      slug: entry.slug,
      asOf: asOfDate,
      company: {
        name: company.name,
        cvr: company.cvr,
        country: company.country,
        currency: company.currency,
        fiscalYearStartMonth: company.fiscalYearStartMonth,
        fiscalYearLabelStrategy: company.fiscalYearLabelStrategy,
      },
      invoices: {
        count: invoices.count,
        openTotal: invoices.rows.reduce((acc, r) => acc + r.openBalance, 0),
        rows: invoices.rows,
      },
      overdueInvoices: {
        count: overdueInvoices.count,
        rows: overdueInvoices.rows,
      },
      unlinkedBank: { count: unlinkedBank.count },
      exceptions: {
        count: exceptions.count,
        rows: exceptions.rows.map((row: any) => ({
          id: row.id,
          type: row.type,
          severity: row.severity,
          status: row.status,
          message: row.message,
        })),
      },
      vat: {
        periodStart: period.start,
        periodEnd: period.end,
        netVatPayable: vatPeriod.netVatPayable,
        daysRemaining: vatDaysRemaining,
        errors: vatPeriod.errors ?? [],
      },
      backup: {
        backupsFound: backup.backupsFound,
        latestBackupAt: backup.latestBackupAt,
        daysSinceLatestBackup: backup.daysSinceLatestBackup,
        hasActivitySinceBackup: backup.hasActivitySinceBackup,
      },
      audit: {
        ok: audit.ok,
        entryCount: audit.entries,
        firstError: audit.errors[0] ?? null,
      },
      recentActivity,
    };
  } finally {
    db.close();
  }
}

// --------------------------------------------------------------------------
// Per-company fiscal years
// --------------------------------------------------------------------------

/** One fiscal year available for a company. */
export type FiscalYearEntry = {
  /** Stable, sortable label for the year, e.g. "2026" or "2025-26". */
  label: string;
  /** Fiscal-year start date (YYYY-MM-DD); null for an archived year. */
  start: string | null;
  /** Fiscal-year end date (YYYY-MM-DD); null for an archived year. */
  end: string | null;
  /** Where the year's data lives: the live hash-chained ledger or the archive. */
  source: "live" | "archive";
};

export type CompanyFiscalYears = {
  slug: string;
  /** Fiscal years, descending by label — newest first. */
  years: FiscalYearEntry[];
};

/**
 * The fiscal years available for a company: the live ledger's year(s) — every
 * distinct fiscal year touched by a posted `journal_entries` row — plus any
 * read-only archived years from the `import_archive_years` table (#197).
 *
 * Years are deduplicated by label (a live year wins over an archived one of
 * the same label) and returned newest-first. Throws `ApiError.notFound` when
 * the slug is not registered or the ledger is missing on disk.
 */
export function buildCompanyFiscalYears(
  workspaceRoot: string,
  slug: string,
): CompanyFiscalYears {
  const entry = findWorkspaceCompany(workspaceRoot, slug);
  if (!entry) {
    throw ApiError.notFound(`no company with slug '${slug}' in the workspace`);
  }
  const companyRoot = companyRootForSlug(workspaceRoot, slug);
  const dbPath = companyPaths(companyRoot).db;
  if (!existsSync(dbPath)) {
    throw ApiError.notFound(`company '${slug}' has no ledger`);
  }

  const db = openDb(dbPath);
  try {
    migrate(db);
    const company = getCompanySettings(db);
    const byLabel = new Map<string, FiscalYearEntry>();

    // Live ledger: one fiscal year per distinct transaction_date, collapsed.
    const dateRows = db
      .query(
        "SELECT DISTINCT transaction_date AS d FROM journal_entries WHERE status = 'posted'",
      )
      .all() as Array<{ d: string }>;
    for (const row of dateRows) {
      if (!ISO_DATE_RE.test(row.d)) continue;
      const fy = fiscalYearForDate(
        row.d,
        company.fiscalYearStartMonth,
        company.fiscalYearLabelStrategy,
      );
      byLabel.set(fy.identifierLabel, {
        label: fy.identifierLabel,
        start: fy.start,
        end: fy.end,
        source: "live",
      });
    }

    // Archived years (#197) — read-only reference data, outside the ledger.
    const archiveRows = db
      .query(
        "SELECT DISTINCT fiscal_year AS y FROM import_archive_years ORDER BY fiscal_year",
      )
      .all() as Array<{ y: number }>;
    for (const row of archiveRows) {
      const label = String(row.y);
      // A live year of the same label is authoritative — never shadow it.
      if (byLabel.has(label)) continue;
      byLabel.set(label, { label, start: null, end: null, source: "archive" });
    }

    const years = [...byLabel.values()].sort((a, b) =>
      b.label.localeCompare(a.label),
    );
    return { slug: entry.slug, years };
  } finally {
    db.close();
  }
}

// --------------------------------------------------------------------------
// Per-company overview (the "Overblik" dashboard, year-aware)
// --------------------------------------------------------------------------

const YEAR_RE = /^\d{4}$/;

/**
 * Validates an optional `?year=` query value. Returns null when absent so the
 * caller can default to the company's most recent live fiscal year.
 */
export function resolveYearParam(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined || raw.length === 0) return null;
  if (!YEAR_RE.test(raw)) {
    throw ApiError.badRequest("year must be a four-digit calendar year");
  }
  return parseInt(raw, 10);
}

/**
 * Validates a required four-digit `:year` taken from the URL path (e.g. the
 * archive endpoint `/archive/:year`). Unlike `resolveYearParam` the year is
 * mandatory here, so an absent or malformed value is a 400.
 */
export function resolvePathYear(raw: string): number {
  if (!YEAR_RE.test(raw)) {
    throw ApiError.badRequest("year must be a four-digit calendar year");
  }
  return parseInt(raw, 10);
}

/**
 * VAT period windows + their statutory filing deadlines are computed by
 * `core/periods.ts#vatPeriodWindowFor` / `vatPeriodsForYear`, generalised over
 * the company's VAT cadence (`vatPeriodType`, #299). The cockpit, the static
 * dashboard and the CLI all read the same core helpers so they never disagree
 * on the period type or its deadline.
 */

/** Whether a VAT position carries any booked activity at all. */
function vatQuarterHasActivity(pos: VatPosition): boolean {
  return (
    pos.payable !== 0 ||
    pos.outputVat !== 0 ||
    pos.outputVatAdjustment !== 0 ||
    pos.inputVat !== 0
  );
}

/**
 * Picks the VAT quarter the cockpit surfaces by default for a calendar year.
 *
 * The owner must see the quarter that is *currently due* — the one whose
 * momsangivelse they have to file now — not whichever quarter happens to be
 * latest. So when the requested `year` is the current calendar year, the
 * quarter containing today's date is preferred whenever it carries activity;
 * this is the period the static dashboard and the CLI `vat momsangivelse`
 * (which keys off the `vat_quarter` accounting period) surface too, so the
 * three never disagree.
 *
 * A bad-debt write-off booked in a *later, otherwise empty* quarter must not
 * pull the selection forward into a future, near-empty period (#272). Only if
 * no quarter at or before the current one carries activity does the selection
 * fall back to the latest quarter that does — and to Q1 when the whole year is
 * empty, as a stable default. For a past year the latest active quarter is
 * still the right choice (nothing is "currently" due in a closed year).
 *
 * Returns the quarter number plus its VAT position so callers do not recompute.
 */
/**
 * The VAT period the cockpit surfaces — generalised over the company's VAT
 * cadence (#299).
 *
 * Selection mirrors the historical quarterly logic, period-type-agnostic: for
 * the current calendar year, prefer the period today falls in, falling back to
 * the latest active period when it (and every earlier one) is empty; for a past
 * year, the latest active period, or the year's first period when nothing has
 * activity. A monthly company picks among 12 periods, a quarterly company among
 * 4, a half-yearly company among 2 — but a `quarter` company gets the exact
 * same period the old `selectVatQuarter` did, so nothing observable changes.
 *
 * Returns the chosen period's window, its booked VAT position, a Danish label
 * and the statutory filing deadline so callers do not recompute any of it.
 */
function selectVatPeriod(
  db: Database,
  year: number,
  vatType: VatPeriodType,
): {
  start: string;
  end: string;
  label: string;
  deadline: string;
  position: VatPosition;
} {
  const windows = vatPeriodsForYear(year, vatType);
  const positions = windows.map((w) => vatPositionForPeriod(db, w.start, w.end));

  const today = todayIsoDate();
  const currentYear = parseInt(today.slice(0, 4), 10);

  // The latest period index at or before `cap` that carries activity, or null.
  const latestActiveUpTo = (cap: number): number | null => {
    for (let i = windows.length - 1; i >= 0; i -= 1) {
      if (i <= cap && vatQuarterHasActivity(positions[i]!)) return i;
    }
    return null;
  };

  // The index of the period that contains today (clamped into the year).
  const indexOfDate = (iso: string): number => {
    const target = vatPeriodWindowFor(iso, vatType).start;
    const idx = windows.findIndex((w) => w.start === target);
    return idx >= 0 ? idx : windows.length - 1;
  };

  let selected: number;
  if (year === currentYear) {
    const currentIndex = indexOfDate(today);
    selected =
      latestActiveUpTo(currentIndex) ??
      latestActiveUpTo(windows.length - 1) ??
      currentIndex;
  } else {
    selected = latestActiveUpTo(windows.length - 1) ?? 0;
  }

  const window = windows[selected]!;
  return {
    start: window.start,
    end: window.end,
    label: vatPeriodLabel(window),
    deadline: window.filingDeadline,
    position: positions[selected]!,
  };
}

/**
 * The effective lifecycle state of the VAT period `start`..`end` — `open`,
 * `closed` or `reported` (#303). A momsangivelse may only be filed for a
 * closed or reported period; for an open period the cockpit must mark the
 * figures as provisional. Replays the append-only `period reopen`/`close`
 * audit lifecycle, so a period that was closed-then-reopened reads `open`.
 */
function vatPeriodEffectiveStatus(
  db: Database,
  start: string,
  end: string,
): EffectivePeriodState {
  const row = db
    .query(
      `SELECT id, status
         FROM accounting_periods
        WHERE kind = 'vat_quarter'
          AND period_start = ? AND period_end = ?
        ORDER BY id DESC
        LIMIT 1`,
    )
    .get(start, end) as
    | { id: number; status: "open" | "closed" | "reported" }
    | undefined;
  if (!row) return "open";
  return effectivePeriodState(db, row.id, row.status);
}

/** Rounds a kroner amount to whole øre, killing float drift. */
function roundKroner(value: number): number {
  return Math.round(Number(value ?? 0) * 100) / 100;
}

// --------------------------------------------------------------------------
// Archived fiscal years (#197) — deriving the rich statement views from the
// read-only `import_archive_*` tables for a pre-cut-over year.
//
// A Dinero export ships a full `SaldoBalance.csv` (every account's closing
// balance) and `Posteringer.csv` (every posting line) per archived year. That
// is enough to render the same Resultatopgørelse / Balance / Saldobalance /
// Posteringer / Overblik the live ledger does — the only difference is the
// figures come from the archive, never from a posted journal entry.
//
// Sign convention: the archived `amount` is debit-signed, exactly like a live
// trial-balance `balance` (debit − credit). So income reads positive as
// `−amount`, expenses as `amount`, assets as `amount`, liabilities/equity as
// `−amount` — the same conversions `core/financial-statements` applies.
// --------------------------------------------------------------------------

/** The `import_archive_years` header row for a fiscal year, or null. */
function archiveYearRow(
  db: Database,
  year: number,
): { id: number; sourceSystem: string } | null {
  const row = db
    .query(
      `SELECT id, source_system AS sourceSystem
         FROM import_archive_years
        WHERE fiscal_year = ?
        ORDER BY id DESC`,
    )
    .get(year) as { id: number; sourceSystem: string } | undefined;
  return row ?? null;
}

/** One archived `SaldoBalance` line joined to the live chart's account type. */
type ArchiveTypedBalance = {
  accountNo: string;
  name: string;
  /** Debit-signed closing balance, kroner (debit − credit). */
  amount: number;
  /** The live `accounts.type`, or null when the account is unknown. */
  type: string | null;
  /** The live `accounts.normal_balance`, or null when unknown. */
  normalBalance: "debit" | "credit" | null;
};

/**
 * Every archived `SaldoBalance` line for `archiveYearId`, each joined to the
 * live chart of accounts so it carries the account `type` and `normalBalance`
 * needed to classify it into a statement section. Ordered by account number.
 */
function archiveTypedBalances(
  db: Database,
  archiveYearId: number,
): ArchiveTypedBalance[] {
  const rows = db
    .query(
      `SELECT b.account_no     AS accountNo,
              b.account_name   AS name,
              b.amount         AS amount,
              a.type           AS type,
              a.normal_balance AS normalBalance
         FROM import_archive_balances b
         LEFT JOIN accounts a ON a.account_no = b.account_no
        WHERE b.archive_year_id = ?
        ORDER BY b.account_no ASC`,
    )
    .all(archiveYearId) as Array<{
    accountNo: string;
    name: string | null;
    amount: number;
    type: string | null;
    normalBalance: "debit" | "credit" | null;
  }>;
  return rows.map((r) => ({
    accountNo: r.accountNo,
    name: r.name ?? "",
    amount: roundKroner(r.amount),
    type: r.type,
    normalBalance: r.normalBalance,
  }));
}

/**
 * Resultatopgørelse figures for an archived year, classified from the archived
 * `SaldoBalance` by the live chart's account `type`. Returns empty totals when
 * the year is not archived. Money is kroner.
 */
function archiveIncomeStatement(
  db: Database,
  year: number,
): {
  income: IncomeStatementLine[];
  expense: IncomeStatementLine[];
  totalIncome: number;
  totalExpense: number;
  result: number;
} {
  const header = archiveYearRow(db, year);
  if (!header) {
    return { income: [], expense: [], totalIncome: 0, totalExpense: 0, result: 0 };
  }
  const income: IncomeStatementLine[] = [];
  const expense: IncomeStatementLine[] = [];
  let totalIncome = 0;
  let totalExpense = 0;
  for (const b of archiveTypedBalances(db, header.id)) {
    if (b.type === "income") {
      // Income is credit-normal — negate the debit-signed archive balance.
      const amount = roundKroner(-b.amount);
      income.push({ accountNo: b.accountNo, name: b.name, amount, priorAmount: 0 });
      totalIncome += amount;
    } else if (b.type === "expense") {
      const amount = roundKroner(b.amount);
      expense.push({ accountNo: b.accountNo, name: b.name, amount, priorAmount: 0 });
      totalExpense += amount;
    }
  }
  totalIncome = roundKroner(totalIncome);
  totalExpense = roundKroner(totalExpense);
  return {
    income,
    expense,
    totalIncome,
    totalExpense,
    result: roundKroner(totalIncome - totalExpense),
  };
}

export type VatPosition = {
  periodStart: string;
  periodEnd: string;
  /**
   * Output VAT (salgsmoms) for the period — the genuine VAT on sales, kroner.
   *
   * This is the *gross* figure: it does NOT have the bad-debt (debitortab)
   * output-VAT relief netted into it. A bad-debt write-off books a debit on
   * the output-VAT account, so a chart-of-accounts-level sum would let a large
   * write-off turn salgsmoms negative — a nonsensical headline for an owner
   * (#271). The relief is surfaced separately as `outputVatAdjustment`.
   */
  outputVat: number;
  /**
   * The bad-debt (debitortab) output-VAT adjustment for the period, kroner —
   * a value ≤ 0, the negative of the VAT relief claimed on written-off
   * receivables. Zero when no write-off falls in the period. Kept on its own
   * clearly-labelled line so it never silently drags salgsmoms negative.
   */
  outputVatAdjustment: number;
  /** Input VAT (købsmoms) booked for the period, kroner. */
  inputVat: number;
  /** outputVat + outputVatAdjustment − inputVat; positive is payable, kroner. */
  payable: number;
};

/**
 * The VAT position for a period, computed from the VAT *amounts booked on the
 * VAT accounts themselves* — the truthful obligation regardless of how the
 * chart of accounts numbers them.
 *
 * A VAT account is any account that is `type = 'vat'` (the native-Rentemester
 * chart: `1200` Salgsmoms, `4000` Købsmoms) OR sits in the standard Danish VAT
 * block `64000`–`64099` (a Dinero-imported chart, where the VAT accounts are
 * typed `liability`). The `64100` settlement account is excluded — it only
 * moves money between the VAT accounts and the bank and is not itself an
 * obligation.
 *
 * Output VAT is the credit-signed movement of output-side VAT accounts; input
 * VAT the credit-signed movement of input-side ones. An account is input-side
 * when it is debit-normal (the native-Rentemester `4000` Købsmoms) or carries
 * a standard Danish input-VAT account number (`64060` Købsmoms; `64080`/
 * `64085`/`64090` afgift-reclaim). The net payable is output − input —
 * arithmetically the credit-signed net of every VAT account, so it is correct
 * regardless of how cleanly the input/output split lands. Money is kroner.
 */
const INPUT_VAT_ACCOUNT_NOS = new Set(["64060", "64080", "64085", "64090"]);

function vatPositionForPeriod(
  db: Database,
  periodStart: string,
  periodEnd: string,
): VatPosition {
  const rows = db
    .query(
      `SELECT a.account_no     AS accountNo,
              a.normal_balance AS normalBalance,
              jl.debit_amount  AS debit,
              jl.credit_amount AS credit
         FROM journal_entries je
         JOIN journal_lines jl ON jl.journal_entry_id = je.id
         JOIN accounts a       ON a.id = jl.account_id
        WHERE je.status = 'posted'
          AND je.transaction_date >= ? AND je.transaction_date <= ?
          AND (a.type = 'vat'
               OR (a.account_no >= '64000' AND a.account_no < '64100'))`,
    )
    .all(periodStart, periodEnd) as Array<{
    accountNo: string;
    normalBalance: "debit" | "credit";
    debit: number;
    credit: number;
  }>;

  let bookedOutputVat = 0;
  let inputVat = 0;
  for (const row of rows) {
    const debit = Number(row.debit ?? 0);
    const credit = Number(row.credit ?? 0);
    const isInput =
      row.normalBalance === "debit" || INPUT_VAT_ACCOUNT_NOS.has(row.accountNo);
    if (isInput) {
      inputVat += debit - credit;
    } else {
      bookedOutputVat += credit - debit;
    }
  }

  bookedOutputVat = roundKroner(bookedOutputVat);
  inputVat = roundKroner(inputVat);

  // A bad-debt write-off (debitortab) books a debit on the output-VAT account
  // to claim back the VAT on a receivable that will never be paid. The booked
  // output-VAT total above therefore already has that relief netted in — a
  // large write-off can drive it negative. Split the relief back out so the
  // headline salgsmoms shows the genuine VAT on sales and the adjustment sits
  // on its own clearly-labelled line (#271). `buildVatReport` keys the relief
  // off the `DK_BAD_DEBT_25` vat-code base, the same source the CLI uses.
  const report = buildVatReport(db, periodStart, periodEnd);
  const outputVatAdjustment = roundKroner(
    -percentOfDkk(report.badDebtReliefBase25, 25),
  );
  // Genuine salgsmoms = booked output VAT with the relief added back in.
  const outputVat = roundKroner(bookedOutputVat - outputVatAdjustment);

  return {
    periodStart,
    periodEnd,
    outputVat,
    outputVatAdjustment,
    inputVat,
    payable: roundKroner(outputVat + outputVatAdjustment - inputVat),
  };
}

/**
 * The standard SKAT TastSelv momsangivelse rubrics for a VAT period.
 *
 * This is the SAME mapping `core/vat-filing.ts#buildVatFiling` applies, run
 * directly off `core/vat.ts#buildVatReport` so the cockpit can show the
 * rubrics for an *open* (not yet closed) period too — `buildVatFiling` itself
 * only produces a return for a closed `vat_quarter` accounting period. The
 * numbers are identical to what the CLI's `vat momsangivelse` reports once the
 * period is closed; the cockpit surface and the terminal therefore agree.
 */
function vatRubrikkerForPeriod(
  db: Database,
  periodStart: string,
  periodEnd: string,
): VatRubrikker {
  const report = buildVatReport(db, periodStart, periodEnd);
  // Salgsmoms — output VAT on domestic sales + reverse-charge output. The
  // report's outputVat already nets bad-debt relief out.
  const salgsmoms = report.outputVat;
  // Moms af ydelseskøb i udlandet — 25% of the reverse-charge purchase base.
  const momsAfYdelseskobUdland = percentOfDkk(report.reverseChargePurchaseBase, 25);
  // Moms af varekøb i udlandet — there is no goods-import VAT code today.
  const momsAfVarekobUdland = 0;
  // Købsmoms — total deductible input VAT.
  const kobsmoms = report.inputVat;
  // Momstilsvar — salgsmoms + udenlandsk moms − købsmoms.
  const momstilsvar = subtractDkk(
    addDkk(salgsmoms, momsAfVarekobUdland, momsAfYdelseskobUdland),
    kobsmoms,
  );
  return {
    salgsmoms,
    momsAfVarekobUdland,
    momsAfYdelseskobUdland,
    kobsmoms,
    momstilsvar,
    rubrikA: report.reverseChargePurchaseBase,
    rubrikB: report.reverseChargeSalesBase,
    rubrikC: 0,
  };
}

/** A VatRubrikker with every rubric zeroed — used for an archived year. */
function emptyVatRubrikker(): VatRubrikker {
  return {
    salgsmoms: 0,
    momsAfVarekobUdland: 0,
    momsAfYdelseskobUdland: 0,
    kobsmoms: 0,
    momstilsvar: 0,
    rubrikA: 0,
    rubrikB: 0,
    rubrikC: 0,
  };
}

/**
 * Booked balance of the bank / cash asset accounts at `asOfDate`, kroner.
 *
 * Bank accounts are identified by the `bank_accounts.ledger_account_no` link
 * when any bank account is registered; otherwise it falls back to every
 * `asset`-type account whose name reads as a bank or cash account. This keeps
 * the figure independent of any one chart's account numbering.
 */
function bankBalanceAsOf(db: Database, asOfDate: string): number {
  const linked = listBankAccounts(db)
    .accounts.map((a) => a.ledgerAccountNo)
    .filter((no): no is string => typeof no === "string" && no.length > 0);

  let accountNos: string[];
  if (linked.length > 0) {
    accountNos = [...new Set(linked)];
  } else {
    accountNos = (
      db
        .query(
          `SELECT account_no FROM accounts
            WHERE type = 'asset'
              AND (lower(name) LIKE '%bank%' OR lower(name) LIKE '%kasse%'
                   OR lower(name) LIKE '%giro%')`,
        )
        .all() as Array<{ account_no: string }>
    ).map((r) => r.account_no);
  }
  if (accountNos.length === 0) return 0;

  const placeholders = accountNos.map(() => "?").join(", ");
  const row = db
    .query(
      `SELECT COALESCE(SUM(jl.debit_amount - jl.credit_amount), 0) AS bal
         FROM journal_entries je
         JOIN journal_lines jl ON jl.journal_entry_id = je.id
         JOIN accounts a       ON a.id = jl.account_id
        WHERE je.status = 'posted'
          AND je.transaction_date <= ?
          AND a.account_no IN (${placeholders})`,
    )
    .get(asOfDate, ...accountNos) as { bal: number };
  return roundKroner(row.bal);
}

/**
 * Actual bank balance from the imported statement, kroner — the `balance_after`
 * of the most recent `bank_transactions` row (latest `transaction_date`, then
 * latest id) per bank account, summed across accounts.
 *
 * This is what the owner's bank app shows; it can differ from the booked
 * ledger balance when transactions are imported but not yet reconciled. Rows
 * with no `balance_after` (a generic CSV import that omitted the running
 * balance) are skipped. Returns `null` when no statement balance is known.
 */
function actualBankBalanceAsOf(db: Database, asOfDate: string): number | null {
  // The latest dated row per bank account (id breaks same-date ties). Rows
  // imported before #187 have a null bank_account_id — group them together as
  // one logical account so a single statement still surfaces.
  const rows = db
    .query(
      `SELECT bt.balance_after AS balanceAfter
         FROM bank_transactions bt
         JOIN (
           SELECT bank_account_id AS acc,
                  MAX(transaction_date) AS maxDate
             FROM bank_transactions
            WHERE transaction_date <= ?
              AND balance_after IS NOT NULL
            GROUP BY bank_account_id
         ) latest
           ON (bt.bank_account_id IS latest.acc
               OR (bt.bank_account_id IS NULL AND latest.acc IS NULL))
          AND bt.transaction_date = latest.maxDate
        WHERE bt.transaction_date <= ?
          AND bt.balance_after IS NOT NULL
          AND bt.id = (
            SELECT MAX(b2.id) FROM bank_transactions b2
             WHERE (b2.bank_account_id IS bt.bank_account_id)
               AND b2.transaction_date = bt.transaction_date
               AND b2.balance_after IS NOT NULL
               AND b2.transaction_date <= ?
          )`,
    )
    .all(asOfDate, asOfDate, asOfDate) as Array<{ balanceAfter: number }>;
  if (rows.length === 0) return null;
  const total = rows.reduce((sum, r) => sum + Number(r.balanceAfter ?? 0), 0);
  return roundKroner(total);
}

const MONTH_NAMES_DK = [
  "jan", "feb", "mar", "apr", "maj", "jun",
  "jul", "aug", "sep", "okt", "nov", "dec",
];

export type OverviewMonth = {
  /** 1–12. */
  month: number;
  label: string;
  income: number;
  expense: number;
};

/**
 * The standard SKAT TastSelv momsangivelse rubrics for a VAT period — the
 * shape `core/vat-filing.ts#VatFilingRubrikker` produces, surfaced so the
 * cockpit shows the same numbers an owner files. All amounts are kroner.
 */
export type VatRubrikker = {
  /** Salgsmoms — output VAT on domestic sales (net of bad-debt relief). */
  salgsmoms: number;
  /** Moms af varekøb i udlandet — VAT on goods purchased abroad. */
  momsAfVarekobUdland: number;
  /** Moms af ydelseskøb i udlandet — reverse-charge VAT on foreign services. */
  momsAfYdelseskobUdland: number;
  /** Købsmoms — total deductible input VAT. */
  kobsmoms: number;
  /** Momstilsvar — salgsmoms + udenlandsk moms − købsmoms; positive = owed. */
  momstilsvar: number;
  /** Rubrik A — value of goods/services bought abroad without Danish VAT. */
  rubrikA: number;
  /** Rubrik B — value of goods/services sold abroad without Danish VAT. */
  rubrikB: number;
  /** Rubrik C — value of other VAT-exempt sales. */
  rubrikC: number;
};

/** The Overblik VAT block — null for an archived year (no VAT data exists). */
export type OverviewVat = {
  periodStart: string;
  periodEnd: string;
  periodLabel: string;
  /** Genuine output VAT on sales — gross, before any bad-debt relief. */
  outputVat: number;
  /** Bad-debt (debitortab) output-VAT adjustment, ≤ 0; 0 when none. */
  outputVatAdjustment: number;
  inputVat: number;
  payable: number;
  deadline: string;
  daysRemaining: number;
};

export type CompanyOverview = ReturnType<typeof buildCompanyOverview>;

/**
 * Per-company "Overblik" — the year-aware company dashboard the cockpit SPA's
 * P0 view renders. Every figure is computed from posted ledger postings: the
 * P&L from `core/financial-statements`, the VAT position from the booked VAT
 * accounts, the bank balance from the cash asset accounts. Money is kroner.
 *
 * `year` selects the calendar fiscal year; when omitted the company's most
 * recent live year is used. An archived-only year returns `archived: true`
 * with empty figures — the live ledger has nothing for it (#197 archive data
 * is surfaced in a later iteration).
 *
 * Throws `ApiError.notFound` when the slug is not registered or has no ledger.
 */
export function buildCompanyOverview(
  workspaceRoot: string,
  slug: string,
  year: number | null,
) {
  const entry = findWorkspaceCompany(workspaceRoot, slug);
  if (!entry) {
    throw ApiError.notFound(`no company with slug '${slug}' in the workspace`);
  }
  const companyRoot = companyRootForSlug(workspaceRoot, slug);
  const dbPath = companyPaths(companyRoot).db;
  if (!existsSync(dbPath)) {
    throw ApiError.notFound(`company '${slug}' has no ledger`);
  }

  const fiscalYears = buildCompanyFiscalYears(workspaceRoot, slug);
  const years = fiscalYears.years;
  // Default to the most recent live year, falling back to the newest year.
  const liveYears = years.filter((y) => y.source === "live");
  const defaultYear =
    liveYears[0]?.label ?? years[0]?.label ?? String(new Date().getUTCFullYear());
  const selectedLabel = year !== null ? String(year) : defaultYear;
  const selected = years.find((y) => y.label === selectedLabel);
  const isArchivedOnly = selected ? selected.source === "archive" : false;

  const db = openDb(dbPath);
  try {
    migrate(db);
    const company = getCompanySettings(db);

    const companyBlock = {
      name: company.name,
      cvr: company.cvr,
      country: company.country,
      currency: company.currency,
      fiscalYearStartMonth: company.fiscalYearStartMonth,
      fiscalYearLabelStrategy: company.fiscalYearLabelStrategy,
    };

    // An archived-only year has no live ledger — but the #197 archive holds
    // the full SaldoBalance + Posteringer, enough for a P&L-oriented overview.
    // The figures are derived from the archive; the live-only sections (bank
    // reconciliation, exception queue, VAT deadline) are surfaced as N/A
    // rather than faked — there is no archived data for them.
    if (isArchivedOnly) {
      const archYear = parseInt(selectedLabel, 10);
      const header = archiveYearRow(db, archYear);
      const pl = archiveIncomeStatement(db, archYear);

      // Monthly income/expense buckets — every archived posting line joined to
      // its account type and bucketed by its `transaction_date` month. Income
      // accounts are credit-normal (a negative archive amount is income);
      // expense accounts are debit-normal (a positive amount is an expense).
      const months: OverviewMonth[] = [];
      const monthIncome = new Array(12).fill(0) as number[];
      const monthExpense = new Array(12).fill(0) as number[];
      const recentEntries: RecentEntry[] = [];
      let lastPostedDate: string | null = null;
      if (header) {
        const postingRows = db
          .query(
            `SELECT p.line_no          AS lineNo,
                    p.account_no       AS accountNo,
                    p.account_name     AS accountName,
                    p.transaction_date AS date,
                    p.voucher          AS voucher,
                    p.text             AS text,
                    p.amount           AS amount,
                    a.type             AS type
               FROM import_archive_postings p
               LEFT JOIN accounts a ON a.account_no = p.account_no
              WHERE p.archive_year_id = ?`,
          )
          .all(header.id) as Array<{
          lineNo: number;
          accountNo: string;
          accountName: string | null;
          date: string | null;
          voucher: string | null;
          text: string | null;
          amount: number;
          type: string | null;
        }>;
        for (const r of postingRows) {
          if (!r.date) continue;
          const m = parseInt(r.date.slice(5, 7), 10);
          if (!(m >= 1 && m <= 12)) continue;
          const amount = Number(r.amount ?? 0);
          if (r.type === "income") monthIncome[m - 1]! += -amount;
          else if (r.type === "expense") monthExpense[m - 1]! += amount;
        }
        // The most recent archived postings — newest date first, capped at 8.
        const dated = postingRows
          .filter((r) => r.date)
          .sort((a, b) =>
            a.date! !== b.date!
              ? b.date!.localeCompare(a.date!)
              : b.lineNo - a.lineNo,
          );
        lastPostedDate = dated[0]?.date ?? null;
        for (const r of dated.slice(0, 8)) {
          recentEntries.push({
            id: r.lineNo,
            entryNo: r.voucher ?? "",
            date: r.date!,
            text: r.text && r.text.length > 0 ? r.text : (r.accountName ?? ""),
            amount: roundKroner(Number(r.amount ?? 0)),
          });
        }
      }
      for (let m = 1; m <= 12; m += 1) {
        months.push({
          month: m,
          label: MONTH_NAMES_DK[m - 1]!,
          income: roundKroner(monthIncome[m - 1]!),
          expense: roundKroner(monthExpense[m - 1]!),
        });
      }

      const bruttomargin =
        pl.totalIncome !== 0 ? pl.result / pl.totalIncome : null;

      return {
        slug: entry.slug,
        selectedYear: selectedLabel,
        archived: true,
        archivedSource: header?.sourceSystem ?? null,
        company: companyBlock,
        fiscalYears: years,
        profitAndLoss: {
          omsaetning: pl.totalIncome,
          udgifter: pl.totalExpense,
          resultat: pl.result,
          months,
        },
        // Live-only sections — no archived data exists, so N/A rather than 0.
        bank: { balance: 0, actualBalance: null, difference: null },
        receivables: { openCount: 0, openTotal: 0 },
        vat: null,
        exceptions: {
          count: 0,
          rows: [] as ExceptionPreview[],
          groups: [] as ExceptionGroup[],
        },
        recentEntries,
        lastPostedDate,
        keyFigures: { bruttomargin, egenkapitalandel: null },
      };
    }

    const yearNum = parseInt(selectedLabel, 10);
    const yearStart = `${yearNum}-01-01`;
    const yearEnd = `${yearNum}-12-31`;

    // P&L for the full year, reusing the core financial statement.
    const pl = buildProfitAndLoss(db, yearStart, yearEnd);

    // Monthly breakdown — one income/expense pair per calendar month.
    const months: OverviewMonth[] = [];
    for (let m = 1; m <= 12; m += 1) {
      const mm = String(m).padStart(2, "0");
      const last = new Date(Date.UTC(yearNum, m, 0)).getUTCDate();
      const mPl = buildProfitAndLoss(
        db,
        `${yearNum}-${mm}-01`,
        `${yearNum}-${mm}-${String(last).padStart(2, "0")}`,
      );
      months.push({
        month: m,
        label: MONTH_NAMES_DK[m - 1]!,
        income: mPl.totalIncome,
        expense: mPl.totalExpense,
      });
    }

    // VAT position: each VAT period settles separately. Surface the period
    // (month / quarter / half-year, per the company's `vatPeriodType`) that is
    // due now, so the cockpit agrees with the static dashboard and CLI (#299).
    const vatSelection = selectVatPeriod(db, yearNum, company.vatPeriodType);
    const vat = vatSelection.position;

    // The exception queue — grouped by type into one Danish summary line each,
    // so the "Opgaver" card reads "362 banktransaktioner mangler afstemning"
    // rather than 362 individual English exception messages.
    const exceptions = listExceptions(db, { status: "open" });
    const exceptionRows: ExceptionPreview[] = exceptions.rows
      .slice(0, 6)
      .map((row: any) => ({
        id: row.id,
        type: row.type,
        severity: row.severity,
        message: row.message,
        // The concrete "what the owner must do" guidance — the most useful
        // part of an exception. The CLI's `exceptions list` shows it; the
        // cockpit must too (#254). Null when the exception has none.
        requiredAction: row.requiredAction ?? null,
      }));
    const exceptionGroups = groupExceptions(
      exceptions.rows.map((row: any) => ({
        type: row.type,
        severity: row.severity,
      })),
    );

    // The most recent posted journal entries within the selected year.
    const entryRows = db
      .query(
        `SELECT je.id          AS id,
                je.entry_no    AS entryNo,
                je.transaction_date AS date,
                je.text        AS text,
                (SELECT COALESCE(SUM(debit_amount), 0)
                   FROM journal_lines WHERE journal_entry_id = je.id) AS amount
           FROM journal_entries je
          WHERE je.status = 'posted'
            AND je.transaction_date >= ? AND je.transaction_date <= ?
          ORDER BY je.transaction_date DESC, je.id DESC
          LIMIT 8`,
      )
      .all(yearStart, yearEnd) as Array<{
      id: number;
      entryNo: string;
      date: string;
      text: string;
      amount: number;
    }>;
    const recentEntries: RecentEntry[] = entryRows.map((r) => ({
      id: r.id,
      entryNo: r.entryNo,
      date: r.date,
      text: r.text,
      amount: Math.round(Number(r.amount ?? 0) * 100) / 100,
    }));

    // Bank: the booked ledger balance plus the actual statement balance (the
    // latest imported `balance_after`) and the gap between them. The owner
    // needs the actual figure — the booked one alone is misleading when the
    // import is not yet reconciled.
    const bookedBalance = bankBalanceAsOf(db, yearEnd);
    const actualBalance = actualBankBalanceAsOf(db, yearEnd);
    const bankDifference =
      actualBalance === null ? null : roundKroner(bookedBalance - actualBalance);

    // Receivables (debitorer): money owed TO the company — the still-open
    // balance of issued sales invoices as of the year end. `buildInvoiceList`
    // derives each invoice's open balance via `core/invoice-payments`; for
    // Helheim (0 issued invoices) this is a clean 0.
    const openInvoices = buildInvoiceList(db, {
      status: "open",
      asOfDate: yearEnd,
    });
    const receivables = {
      openCount: openInvoices.count,
      openTotal: roundKroner(
        openInvoices.rows.reduce((acc, r) => acc + r.openBalance, 0),
      ),
    };

    // The transaction date of the most recent posted journal entry in the
    // year — surfaced as "Senest bogført pr. <dato>" so the owner sees at a
    // glance how current the figures are. Null when nothing is posted yet.
    const lastPostedDate = recentEntries.length > 0 ? recentEntries[0]!.date : null;

    // Nøgletal: the two ratios an owner reads off a glance — bruttomargin
    // (resultat ÷ omsætning) and egenkapitalandel (egenkapital ÷ balancesum).
    // Both are fractions (0–1); the SPA renders them as percentages. Each is
    // null when its denominator is zero — no figure is invented.
    const bs = buildBalanceSheet(db, yearEnd);
    const equityTotal = roundKroner(bs.equity.total + bs.periodResult);
    const bruttomargin =
      pl.totalIncome !== 0 ? pl.result / pl.totalIncome : null;
    const egenkapitalandel =
      bs.totalAssets !== 0 ? equityTotal / bs.totalAssets : null;

    const vatDeadline = vatSelection.deadline;
    const vatBlock: OverviewVat = {
      periodStart: vat.periodStart,
      periodEnd: vat.periodEnd,
      periodLabel: vatSelection.label,
      outputVat: vat.outputVat,
      outputVatAdjustment: vat.outputVatAdjustment,
      inputVat: vat.inputVat,
      payable: vat.payable,
      deadline: vatDeadline,
      daysRemaining: daysBetween(todayIsoDate(), vatDeadline),
    };

    return {
      slug: entry.slug,
      selectedYear: selectedLabel,
      archived: false,
      archivedSource: null as string | null,
      company: companyBlock,
      fiscalYears: years,
      profitAndLoss: {
        omsaetning: pl.totalIncome,
        udgifter: pl.totalExpense,
        resultat: pl.result,
        months,
      },
      bank: {
        balance: bookedBalance,
        actualBalance,
        difference: bankDifference,
      },
      receivables,
      vat: vatBlock as OverviewVat | null,
      exceptions: {
        count: exceptions.count,
        rows: exceptionRows,
        groups: exceptionGroups,
      },
      recentEntries,
      lastPostedDate,
      keyFigures: { bruttomargin, egenkapitalandel },
    };
  } finally {
    db.close();
  }
}

type ExceptionPreview = {
  id: number;
  type: string;
  severity: string;
  message: string;
  /** The concrete action the owner must take; null when none is recorded. */
  requiredAction: string | null;
};

/**
 * One grouped exception line for the Overblik "Opgaver" card — every open
 * exception of one `type` collapsed into a single Danish, actionable summary
 * with a count and a deep-link target.
 */
export type ExceptionGroup = {
  /** The shared `exceptions.type`. */
  type: string;
  /** Open exceptions of this type. */
  count: number;
  /** The highest severity among the grouped exceptions. */
  severity: "low" | "medium" | "high";
  /** A Danish one-liner, e.g. "362 banktransaktioner mangler afstemning". */
  label: string;
  /** The cockpit sub-view this group links to, e.g. "bank"; null when none. */
  link: string | null;
};

const SEVERITY_RANK: Record<string, number> = { low: 0, medium: 1, high: 2 };

/**
 * Builds the Danish summary line for a group of `count` same-type exceptions.
 * Known types get a tailored, pluralised sentence and a deep-link target;
 * unknown types fall back to a generic count so nothing is ever dropped.
 */
function describeExceptionGroup(
  type: string,
  count: number,
): { label: string; link: string | null } {
  const n = count;
  switch (type) {
    case "UNMATCHED_BANK_TRANSACTION":
      return {
        label: `${n} ${
          n === 1 ? "banktransaktion mangler" : "banktransaktioner mangler"
        } afstemning`,
        link: "bank",
      };
    case "BANK_BALANCE_GAP":
      return {
        label: `${n} ${n === 1 ? "afvigelse" : "afvigelser"} mellem bogført og faktisk banksaldo`,
        link: "bank",
      };
    case "MAIL_INTAKE_NO_ATTACHMENT":
      return {
        label: `${n} ${n === 1 ? "indkommen mail" : "indkomne mails"} uden vedhæftet bilag`,
        link: null,
      };
    case "MAIL_INTAKE_AMBIGUOUS_METADATA":
      return {
        label: `${n} ${n === 1 ? "bilag" : "bilag"} med uklare oplysninger fra mail`,
        link: null,
      };
    case "MAIL_INTAKE_INGEST_BLOCKED":
      return {
        label: `${n} ${n === 1 ? "mail kunne" : "mails kunne"} ikke indlæses`,
        link: null,
      };
    case "ASSET_WRITEOFF_MISSING_DOCUMENTATION":
      return {
        label: `${n} ${n === 1 ? "aktiv-afskrivning mangler" : "aktiv-afskrivninger mangler"} dokumentation`,
        link: null,
      };
    case "ASSET_WRITEOFF_ELIGIBILITY_UNCERTAIN":
      return {
        label: `${n} ${n === 1 ? "aktiv-afskrivning" : "aktiv-afskrivninger"} med usikker fradragsret`,
        link: null,
      };
    default:
      return {
        label: `${n} ${n === 1 ? "undtagelse" : "undtagelser"} kræver gennemgang`,
        link: null,
      };
  }
}

/**
 * Collapses a list of open exceptions into one summary line per `type`. Each
 * group carries a Danish, actionable label and the highest severity seen, so
 * the cockpit renders "362 banktransaktioner mangler afstemning" instead of
 * 362 individual English lines. Deterministic: groups are ordered by severity
 * (high first), then by descending count, then by type.
 */
function groupExceptions(
  rows: Array<{ type: string; severity: string }>,
): ExceptionGroup[] {
  const byType = new Map<string, { count: number; severity: string }>();
  for (const row of rows) {
    const existing = byType.get(row.type);
    if (existing) {
      existing.count += 1;
      if ((SEVERITY_RANK[row.severity] ?? 0) > (SEVERITY_RANK[existing.severity] ?? 0)) {
        existing.severity = row.severity;
      }
    } else {
      byType.set(row.type, { count: 1, severity: row.severity });
    }
  }
  const groups: ExceptionGroup[] = [];
  for (const [type, agg] of byType) {
    const { label, link } = describeExceptionGroup(type, agg.count);
    const severity =
      agg.severity === "high" || agg.severity === "medium" ? agg.severity : "low";
    groups.push({ type, count: agg.count, severity, label, link });
  }
  groups.sort(
    (a, b) =>
      (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0) ||
      b.count - a.count ||
      a.type.localeCompare(b.type),
  );
  return groups;
}

type RecentEntry = {
  id: number;
  entryNo: string;
  date: string;
  text: string;
  amount: number;
};

// --------------------------------------------------------------------------
// Per-company financial statements (year-aware) — cockpit-redesign it. 2
// --------------------------------------------------------------------------

/**
 * Resolves the company, opens its ledger and picks the selected fiscal year —
 * the shared preamble for the statement builders below. The selected year
 * follows `buildCompanyOverview`: an explicit `?year=` wins, else the most
 * recent live year, else the newest available year.
 *
 * Throws `ApiError.notFound` when the slug is not registered or has no ledger.
 */
function resolveStatementContext(
  workspaceRoot: string,
  slug: string,
  year: number | null,
): {
  entry: WorkspaceCompanyEntry;
  db: Database;
  company: ReturnType<typeof getCompanySettings>;
  years: FiscalYearEntry[];
  selectedLabel: string;
  isArchivedOnly: boolean;
} {
  const entry = findWorkspaceCompany(workspaceRoot, slug);
  if (!entry) {
    throw ApiError.notFound(`no company with slug '${slug}' in the workspace`);
  }
  const companyRoot = companyRootForSlug(workspaceRoot, slug);
  const dbPath = companyPaths(companyRoot).db;
  if (!existsSync(dbPath)) {
    throw ApiError.notFound(`company '${slug}' has no ledger`);
  }

  const years = buildCompanyFiscalYears(workspaceRoot, slug).years;
  const liveYears = years.filter((y) => y.source === "live");
  const defaultYear =
    liveYears[0]?.label ?? years[0]?.label ?? String(new Date().getUTCFullYear());
  const selectedLabel = year !== null ? String(year) : defaultYear;
  const selected = years.find((y) => y.label === selectedLabel);
  const isArchivedOnly = selected ? selected.source === "archive" : false;

  const db = openDb(dbPath);
  migrate(db);
  return {
    entry,
    db,
    company: getCompanySettings(db),
    years,
    selectedLabel,
    isArchivedOnly,
  };
}

export type StatementCompanyBlock = {
  name: string;
  cvr: string | null;
  country: string;
  currency: string;
  fiscalYearStartMonth: number | string;
  fiscalYearLabelStrategy: string;
};

function statementCompanyBlock(
  company: ReturnType<typeof getCompanySettings>,
): StatementCompanyBlock {
  return {
    name: company.name,
    cvr: company.cvr,
    country: company.country,
    currency: company.currency,
    fiscalYearStartMonth: company.fiscalYearStartMonth,
    fiscalYearLabelStrategy: company.fiscalYearLabelStrategy,
  };
}

/** Resolve a slug to its ledger db path, asserting the company + ledger exist. */
function requireCompanyDbPath(workspaceRoot: string, slug: string): string {
  if (!findWorkspaceCompany(workspaceRoot, slug)) {
    throw ApiError.notFound(`no company with slug '${slug}' in the workspace`);
  }
  const dbPath = companyPaths(companyRootForSlug(workspaceRoot, slug)).db;
  if (!existsSync(dbPath)) {
    throw ApiError.notFound(`company '${slug}' has no ledger`);
  }
  return dbPath;
}

/**
 * The full company settings row plus the company's own payment/bank details.
 *
 * `payment` is the primary `bank_accounts` row resolved via
 * `core/company.ts#resolveCompanyPaymentDetails` — the same source every issued
 * invoice's payment block reads from. It is null when no bank account is
 * configured yet, which is exactly when the Cockpit must let the owner add one
 * (#284): without it, an invoice goes out with no payment instructions.
 */
export type CompanySettingsView = CompanySettings & {
  payment: CompanyPaymentDetails | null;
};

/**
 * The full company settings row, including the CVR-register stamdata and the
 * payment/bank details. Read-only — backs `GET /api/companies/:slug/company` so
 * the cockpit can show the synced address/branche/status and the bank account.
 */
export function buildCompanySettings(
  workspaceRoot: string,
  slug: string,
): CompanySettingsView {
  const db = openDb(requireCompanyDbPath(workspaceRoot, slug));
  try {
    migrate(db);
    const settings = getCompanySettings(db);
    const payment = resolveCompanyPaymentDetails(db, settings.currency) ?? null;
    return { ...settings, payment };
  } finally {
    db.close();
  }
}

/**
 * Refresh a company's CVR-register stamdata. Backs
 * `POST /api/companies/:slug/sync-cvr`. The CVR lookup runs server-side so the
 * CVR credentials never reach the browser.
 */
export async function syncCompanyCvr(
  workspaceRoot: string,
  slug: string,
): Promise<SyncCompanyFromCvrResult> {
  const db = openDb(requireCompanyDbPath(workspaceRoot, slug));
  try {
    migrate(db);
    return await syncCompanyFromCvr(db);
  } finally {
    db.close();
  }
}

export type IncomeStatementLine = {
  accountNo: string;
  name: string;
  amount: number;
  /** The same account's amount in the prior calendar year, kroner. */
  priorAmount: number;
};

export type CompanyIncomeStatement = ReturnType<typeof buildCompanyIncomeStatement>;

/**
 * Resultatopgørelse — the income statement for the selected calendar fiscal
 * year: income accounts and expense accounts, each with its own amount and the
 * prior year's amount for comparison, plus the totals and the result. Every
 * figure is computed by `core/financial-statements`. Money is kroner.
 */
export function buildCompanyIncomeStatement(
  workspaceRoot: string,
  slug: string,
  year: number | null,
) {
  const ctx = resolveStatementContext(workspaceRoot, slug, year);
  try {
    const companyBlock = statementCompanyBlock(ctx.company);
    if (ctx.isArchivedOnly) {
      // Archived year — derive the resultatopgørelse from the archived
      // SaldoBalance (#197). The prior column comes from the prior year's
      // archive when one exists, so a year-over-year comparison still works.
      const archYear = parseInt(ctx.selectedLabel, 10);
      const current = archiveIncomeStatement(ctx.db, archYear);
      const prior = archiveIncomeStatement(ctx.db, archYear - 1);
      const priorIncome = new Map(prior.income.map((l) => [l.accountNo, l.amount]));
      const priorExpense = new Map(
        prior.expense.map((l) => [l.accountNo, l.amount]),
      );
      return {
        slug: ctx.entry.slug,
        selectedYear: ctx.selectedLabel,
        archived: true,
        archivedSource: archiveYearRow(ctx.db, archYear)?.sourceSystem ?? null,
        company: companyBlock,
        fiscalYears: ctx.years,
        income: current.income.map((l) => ({
          ...l,
          priorAmount: priorIncome.get(l.accountNo) ?? 0,
        })),
        expense: current.expense.map((l) => ({
          ...l,
          priorAmount: priorExpense.get(l.accountNo) ?? 0,
        })),
        totalIncome: current.totalIncome,
        totalExpense: current.totalExpense,
        priorTotalIncome: prior.totalIncome,
        priorTotalExpense: prior.totalExpense,
        result: current.result,
        priorResult: prior.result,
      };
    }

    const yearNum = parseInt(ctx.selectedLabel, 10);
    const current = buildProfitAndLoss(ctx.db, `${yearNum}-01-01`, `${yearNum}-12-31`);
    const prior = buildProfitAndLoss(
      ctx.db,
      `${yearNum - 1}-01-01`,
      `${yearNum - 1}-12-31`,
    );
    const priorIncome = new Map(prior.income.map((l) => [l.accountNo, l.amount]));
    const priorExpense = new Map(prior.expense.map((l) => [l.accountNo, l.amount]));

    const income: IncomeStatementLine[] = current.income.map((l) => ({
      accountNo: l.accountNo,
      name: l.name,
      amount: l.amount,
      priorAmount: priorIncome.get(l.accountNo) ?? 0,
    }));
    const expense: IncomeStatementLine[] = current.expense.map((l) => ({
      accountNo: l.accountNo,
      name: l.name,
      amount: l.amount,
      priorAmount: priorExpense.get(l.accountNo) ?? 0,
    }));

    return {
      slug: ctx.entry.slug,
      selectedYear: ctx.selectedLabel,
      archived: false,
      archivedSource: null as string | null,
      company: companyBlock,
      fiscalYears: ctx.years,
      income,
      expense,
      totalIncome: current.totalIncome,
      totalExpense: current.totalExpense,
      priorTotalIncome: prior.totalIncome,
      priorTotalExpense: prior.totalExpense,
      result: current.result,
      priorResult: prior.result,
    };
  } finally {
    ctx.db.close();
  }
}

export type BalanceLine = {
  accountNo: string;
  name: string;
  amount: number;
};

export type BalanceSection = {
  lines: BalanceLine[];
  total: number;
};

export type CompanyBalance = ReturnType<typeof buildCompanyBalance>;

/**
 * Balance — the balance sheet as of the selected fiscal year's end date:
 * assets, liabilities and equity sections with section totals. The fiscal
 * year's result is folded into the equity section as an "Årets resultat" line,
 * so `equity.total` is the equity figure an owner reads (equity accounts plus
 * the result) and the sheet balances as assets = liabilities + equity. That
 * holds for live years (computed by `core/financial-statements`) and archived
 * years (#197) alike, and keeps `equity.total` equal to the Flerårsoversigt's
 * `egenkapital` for the same year. Money is kroner.
 */
export function buildCompanyBalance(
  workspaceRoot: string,
  slug: string,
  year: number | null,
) {
  const ctx = resolveStatementContext(workspaceRoot, slug, year);
  try {
    const companyBlock = statementCompanyBlock(ctx.company);
    if (ctx.isArchivedOnly) {
      // Archived year — classify the archived SaldoBalance (#197) into the
      // asset / liability / equity sections. The income/expense net is the
      // fiscal year's result: like a balance sheet's retained earnings it
      // belongs to equity, so it is folded into the equity section as an
      // "Årets resultat" line. That makes `equity.total` the equity figure an
      // owner reads — equity accounts plus the year's result — and the sheet
      // balances as assets = liabilities + equity, internally consistent with
      // the Flerårsoversigt's `egenkapital` for the same year.
      const archYear = parseInt(ctx.selectedLabel, 10);
      const header = archiveYearRow(ctx.db, archYear);
      const assets: BalanceLine[] = [];
      const liabilities: BalanceLine[] = [];
      const equity: BalanceLine[] = [];
      let totalAssets = 0;
      let totalLiabilities = 0;
      let equitySection = 0;
      let periodResult = 0;
      if (header) {
        for (const b of archiveTypedBalances(ctx.db, header.id)) {
          if (
            b.type === "asset" ||
            (b.type === "vat" && b.normalBalance === "debit")
          ) {
            // Assets are debit-normal — the archive amount reads as-is.
            assets.push({ accountNo: b.accountNo, name: b.name, amount: b.amount });
            totalAssets += b.amount;
          } else if (
            b.type === "liability" ||
            (b.type === "vat" && b.normalBalance === "credit")
          ) {
            const amount = roundKroner(-b.amount);
            liabilities.push({ accountNo: b.accountNo, name: b.name, amount });
            totalLiabilities += amount;
          } else if (b.type === "equity") {
            const amount = roundKroner(-b.amount);
            equity.push({ accountNo: b.accountNo, name: b.name, amount });
            equitySection += amount;
          } else if (b.type === "income") {
            periodResult += -b.amount;
          } else if (b.type === "expense") {
            periodResult -= b.amount;
          }
        }
      }
      totalAssets = roundKroner(totalAssets);
      totalLiabilities = roundKroner(totalLiabilities);
      equitySection = roundKroner(equitySection);
      periodResult = roundKroner(periodResult);
      // Fold the year's result into equity as a retained-earnings line so the
      // equity section total carries it — the same way the live Balance view
      // surfaces the result on the equity side.
      equity.push({ accountNo: "—", name: "Årets resultat", amount: periodResult });
      const totalEquity = roundKroner(equitySection + periodResult);
      const totalLiabilitiesAndEquity = roundKroner(
        totalLiabilities + totalEquity,
      );
      return {
        slug: ctx.entry.slug,
        selectedYear: ctx.selectedLabel,
        archived: true,
        archivedSource: header?.sourceSystem ?? null,
        company: companyBlock,
        fiscalYears: ctx.years,
        asOfDate: `${ctx.selectedLabel}-12-31`,
        assets: { lines: assets, total: totalAssets },
        liabilities: { lines: liabilities, total: totalLiabilities },
        equity: { lines: equity, total: totalEquity },
        periodResult,
        totalAssets,
        totalLiabilitiesAndEquity,
        balanced: Math.abs(totalAssets - totalLiabilitiesAndEquity) < 0.005,
      };
    }

    const yearNum = parseInt(ctx.selectedLabel, 10);
    const asOfDate = `${yearNum}-12-31`;
    const bs = buildBalanceSheet(ctx.db, asOfDate);
    const toLines = (lines: { accountNo: string; name: string; amount: number }[]) =>
      lines.map((l) => ({ accountNo: l.accountNo, name: l.name, amount: l.amount }));

    // Fold the un-closed period result into the equity section as a
    // retained-earnings line — `equity.total` is then the equity figure an
    // owner reads (equity accounts plus the year's result) and matches the
    // Flerårsoversigt's `egenkapital`. The sheet balances as
    // assets = liabilities + equity.
    const equityLines = toLines(bs.equity.lines);
    equityLines.push({
      accountNo: "—",
      name: "Årets resultat",
      amount: bs.periodResult,
    });
    const equityTotal = roundKroner(bs.equity.total + bs.periodResult);

    return {
      slug: ctx.entry.slug,
      selectedYear: ctx.selectedLabel,
      archived: false,
      archivedSource: null as string | null,
      company: companyBlock,
      fiscalYears: ctx.years,
      asOfDate: bs.asOfDate,
      assets: { lines: toLines(bs.assets.lines), total: bs.assets.total },
      liabilities: {
        lines: toLines(bs.liabilities.lines),
        total: bs.liabilities.total,
      },
      equity: { lines: equityLines, total: equityTotal },
      periodResult: bs.periodResult,
      totalAssets: bs.totalAssets,
      totalLiabilitiesAndEquity: bs.totalLiabilitiesAndEquity,
      balanced: bs.balanced,
    };
  } finally {
    ctx.db.close();
  }
}

export type TrialBalanceRow = {
  accountNo: string;
  name: string;
  type: string;
  debit: number;
  credit: number;
  balance: number;
};

export type CompanyTrialBalance = ReturnType<typeof buildCompanyTrialBalance>;

/**
 * Saldobalance — the trial balance for the selected calendar fiscal year:
 * every account that moved, with its summed debit total, credit total and the
 * signed net balance. The report is balanced when total debit equals total
 * credit. Computed by `core/financial-statements`. Money is kroner.
 */
export function buildCompanyTrialBalance(
  workspaceRoot: string,
  slug: string,
  year: number | null,
) {
  const ctx = resolveStatementContext(workspaceRoot, slug, year);
  try {
    const companyBlock = statementCompanyBlock(ctx.company);
    if (ctx.isArchivedOnly) {
      // Archived year — the archived SaldoBalance (#197) is itself the trial
      // balance. The export stores only a signed (debit − credit) closing
      // balance per account, so a positive balance reads as a debit column
      // figure and a negative one as a credit; the report is balanced when
      // every account's balance nets to zero.
      const archYear = parseInt(ctx.selectedLabel, 10);
      const header = archiveYearRow(ctx.db, archYear);
      const rows: TrialBalanceRow[] = [];
      let totalDebit = 0;
      let totalCredit = 0;
      if (header) {
        for (const b of archiveTypedBalances(ctx.db, header.id)) {
          const debit = b.amount > 0 ? b.amount : 0;
          const credit = b.amount < 0 ? roundKroner(-b.amount) : 0;
          totalDebit += debit;
          totalCredit += credit;
          rows.push({
            accountNo: b.accountNo,
            name: b.name,
            type: b.type ?? "",
            debit,
            credit,
            balance: b.amount,
          });
        }
      }
      totalDebit = roundKroner(totalDebit);
      totalCredit = roundKroner(totalCredit);
      return {
        slug: ctx.entry.slug,
        selectedYear: ctx.selectedLabel,
        archived: true,
        archivedSource: header?.sourceSystem ?? null,
        company: companyBlock,
        fiscalYears: ctx.years,
        periodStart: `${ctx.selectedLabel}-01-01`,
        periodEnd: `${ctx.selectedLabel}-12-31`,
        rows,
        totalDebit,
        totalCredit,
        balanced: Math.abs(totalDebit - totalCredit) < 0.005,
      };
    }

    const yearNum = parseInt(ctx.selectedLabel, 10);
    const tb = buildTrialBalance(ctx.db, `${yearNum}-01-01`, `${yearNum}-12-31`);
    const rows: TrialBalanceRow[] = tb.accounts.map((a) => ({
      accountNo: a.accountNo,
      name: a.name,
      type: a.type,
      debit: a.debit,
      credit: a.credit,
      balance: a.balance,
    }));

    return {
      slug: ctx.entry.slug,
      selectedYear: ctx.selectedLabel,
      archived: false,
      archivedSource: null as string | null,
      company: companyBlock,
      fiscalYears: ctx.years,
      periodStart: tb.periodStart,
      periodEnd: tb.periodEnd,
      rows,
      totalDebit: tb.totalDebit,
      totalCredit: tb.totalCredit,
      balanced: tb.balanced,
    };
  } finally {
    ctx.db.close();
  }
}

// --------------------------------------------------------------------------
// Per-company journal (Posteringer, year-aware) — cockpit-redesign it. 3
// --------------------------------------------------------------------------

export type JournalLine = {
  accountNo: string;
  accountName: string;
  debit: number;
  credit: number;
  text: string | null;
};

export type JournalEntry = {
  id: number;
  entryNo: string;
  date: string;
  text: string;
  /** Sum of the debit side — the entry total, kroner. */
  total: number;
  lines: JournalLine[];
};

export type CompanyJournal = ReturnType<typeof buildCompanyJournal>;

/**
 * Posteringer — every posted journal entry for the selected calendar fiscal
 * year, newest first, each carrying its debit/credit lines so the UI can drill
 * into an entry. The entry `total` is the summed debit side. Money is kroner.
 *
 * When `account` is given, only entries with at least one line on that account
 * are returned, and `accountFilter` names the account — this powers the
 * "klik konto → kontoens posteringer" drill-down from the statement views.
 */
export function buildCompanyJournal(
  workspaceRoot: string,
  slug: string,
  year: number | null,
  account: string | null = null,
) {
  const ctx = resolveStatementContext(workspaceRoot, slug, year);
  try {
    const companyBlock = statementCompanyBlock(ctx.company);
    if (ctx.isArchivedOnly) {
      // Archived year — group the archived Posteringer (#197) by their voucher
      // (Bilag) number into journal-entry-shaped rows. The export stores one
      // signed `amount` per line (the raw Beløb): a positive amount reads as a
      // debit, a negative one as a credit. Lines with no voucher are grouped
      // under a synthetic key so nothing is dropped.
      const archYear = parseInt(ctx.selectedLabel, 10);
      const header = archiveYearRow(ctx.db, archYear);
      const accountArg =
        account !== null && account.trim().length > 0 ? account.trim() : null;
      let entries: JournalEntry[] = [];
      let accountFilter: { accountNo: string; name: string } | null = null;
      if (header) {
        const postingRows = ctx.db
          .query(
            `SELECT line_no       AS lineNo,
                    account_no    AS accountNo,
                    account_name  AS accountName,
                    transaction_date AS date,
                    voucher       AS voucher,
                    text          AS text,
                    amount        AS amount
               FROM import_archive_postings
              WHERE archive_year_id = ?
              ORDER BY line_no ASC`,
          )
          .all(header.id) as Array<{
          lineNo: number;
          accountNo: string;
          accountName: string | null;
          date: string | null;
          voucher: string | null;
          text: string | null;
          amount: number;
        }>;

        if (accountArg !== null) {
          const sample = postingRows.find((r) => r.accountNo === accountArg);
          accountFilter = {
            accountNo: accountArg,
            name: sample?.accountName ?? accountArg,
          };
        }

        // Group by voucher; an absent voucher gets a stable synthetic key so
        // those lines still surface (one entry per orphan line).
        const groups = new Map<
          string,
          { voucher: string; date: string; lines: typeof postingRows }
        >();
        for (const r of postingRows) {
          const key = r.voucher && r.voucher.length > 0
            ? r.voucher
            : `linje-${r.lineNo}`;
          const existing = groups.get(key);
          if (existing) {
            existing.lines.push(r);
            if (r.date && (!existing.date || r.date < existing.date)) {
              existing.date = r.date;
            }
          } else {
            groups.set(key, {
              voucher: r.voucher && r.voucher.length > 0 ? r.voucher : key,
              date: r.date ?? `${archYear}-01-01`,
              lines: [r],
            });
          }
        }

        const all: JournalEntry[] = [...groups.values()].map((g, i) => {
          const lines: JournalLine[] = g.lines.map((r) => ({
            accountNo: r.accountNo,
            accountName: r.accountName ?? "",
            debit: r.amount > 0 ? roundKroner(r.amount) : 0,
            credit: r.amount < 0 ? roundKroner(-r.amount) : 0,
            text: r.text,
          }));
          const total = roundKroner(
            lines.reduce((acc, l) => acc + l.debit, 0),
          );
          // The entry text is the first non-empty line text — the Dinero
          // export repeats the voucher description across its lines.
          const text =
            g.lines.find((r) => r.text && r.text.length > 0)?.text ?? "";
          return {
            id: i + 1,
            entryNo: g.voucher,
            date: g.date,
            text,
            total,
            lines,
          };
        });

        // Newest first — the same ordering the live journal uses.
        all.sort((a, b) =>
          a.date !== b.date
            ? b.date.localeCompare(a.date)
            : b.entryNo.localeCompare(a.entryNo),
        );

        entries =
          accountArg === null
            ? all
            : all.filter((e) =>
                e.lines.some((l) => l.accountNo === accountArg),
              );
      }
      return {
        slug: ctx.entry.slug,
        selectedYear: ctx.selectedLabel,
        archived: true,
        archivedSource: header?.sourceSystem ?? null,
        company: companyBlock,
        fiscalYears: ctx.years,
        periodStart: `${ctx.selectedLabel}-01-01`,
        periodEnd: `${ctx.selectedLabel}-12-31`,
        entries,
        accountFilter,
      };
    }

    const yearNum = parseInt(ctx.selectedLabel, 10);
    const yearStart = `${yearNum}-01-01`;
    const yearEnd = `${yearNum}-12-31`;

    // Optional account drill-down: resolve the account's name (so the view can
    // title the filter) and the set of entry ids that touch it.
    let accountFilter: { accountNo: string; name: string } | null = null;
    let accountEntryIds: Set<number> | null = null;
    if (account !== null && account.trim().length > 0) {
      const accountNo = account.trim();
      const acc = ctx.db
        .query("SELECT account_no AS accountNo, name AS name FROM accounts WHERE account_no = ?")
        .get(accountNo) as { accountNo: string; name: string } | undefined;
      accountFilter = acc
        ? { accountNo: acc.accountNo, name: acc.name }
        : { accountNo, name: accountNo };
      const idRows = ctx.db
        .query(
          `SELECT DISTINCT jl.journal_entry_id AS id
             FROM journal_lines jl
             JOIN journal_entries je ON je.id = jl.journal_entry_id
             JOIN accounts a         ON a.id = jl.account_id
            WHERE je.status = 'posted'
              AND je.transaction_date >= ? AND je.transaction_date <= ?
              AND a.account_no = ?`,
        )
        .all(yearStart, yearEnd, accountNo) as Array<{ id: number }>;
      accountEntryIds = new Set(idRows.map((r) => r.id));
    }

    const entryRows = ctx.db
      .query(
        `SELECT je.id          AS id,
                je.entry_no    AS entryNo,
                je.transaction_date AS date,
                je.text        AS text
           FROM journal_entries je
          WHERE je.status = 'posted'
            AND je.transaction_date >= ? AND je.transaction_date <= ?
          ORDER BY je.transaction_date DESC, je.id DESC`,
      )
      .all(yearStart, yearEnd) as Array<{
      id: number;
      entryNo: string;
      date: string;
      text: string;
    }>;

    const lineRows = ctx.db
      .query(
        `SELECT jl.journal_entry_id AS entryId,
                a.account_no        AS accountNo,
                a.name              AS accountName,
                jl.debit_amount     AS debit,
                jl.credit_amount    AS credit,
                jl.text             AS text
           FROM journal_lines jl
           JOIN journal_entries je ON je.id = jl.journal_entry_id
           JOIN accounts a         ON a.id = jl.account_id
          WHERE je.status = 'posted'
            AND je.transaction_date >= ? AND je.transaction_date <= ?
          ORDER BY jl.id ASC`,
      )
      .all(yearStart, yearEnd) as Array<{
      entryId: number;
      accountNo: string;
      accountName: string;
      debit: number;
      credit: number;
      text: string | null;
    }>;

    const linesByEntry = new Map<number, JournalLine[]>();
    for (const row of lineRows) {
      const list = linesByEntry.get(row.entryId) ?? [];
      list.push({
        accountNo: row.accountNo,
        accountName: row.accountName,
        debit: roundKroner(row.debit),
        credit: roundKroner(row.credit),
        text: row.text,
      });
      linesByEntry.set(row.entryId, list);
    }

    const filteredRows =
      accountEntryIds === null
        ? entryRows
        : entryRows.filter((e) => accountEntryIds!.has(e.id));

    const entries: JournalEntry[] = filteredRows.map((e) => {
      const lines = linesByEntry.get(e.id) ?? [];
      const total = roundKroner(
        lines.reduce((acc, l) => acc + l.debit, 0),
      );
      return {
        id: e.id,
        entryNo: e.entryNo,
        date: e.date,
        text: e.text,
        total,
        lines,
      };
    });

    return {
      slug: ctx.entry.slug,
      selectedYear: ctx.selectedLabel,
      archived: false,
      archivedSource: null as string | null,
      company: companyBlock,
      fiscalYears: ctx.years,
      periodStart: yearStart,
      periodEnd: yearEnd,
      entries,
      accountFilter,
    };
  } finally {
    ctx.db.close();
  }
}

// --------------------------------------------------------------------------
// Per-company bank transactions (Bank, year-aware) — cockpit-redesign it. 3
// --------------------------------------------------------------------------

export type BankTransactionRow = {
  id: number;
  date: string;
  text: string;
  amount: number;
  /** Running balance from the import, kroner; null when the export omits it. */
  runningBalance: number | null;
  /** "matched" when a posted journal entry references this row, else "unmatched". */
  reconciliationStatus: "matched" | "unmatched";
  /** The matched journal entry's number, when reconciled. */
  journalEntryNo: string | null;
};

export type CompanyBank = ReturnType<typeof buildCompanyBank>;

/**
 * Bank — the imported `bank_transactions` rows for the selected calendar
 * fiscal year, each with its reconciliation status (matched vs unmatched to a
 * posted journal entry), plus the registered bank account and its booked
 * ledger balance at the year end. Money is kroner.
 */
export function buildCompanyBank(
  workspaceRoot: string,
  slug: string,
  year: number | null,
) {
  const ctx = resolveStatementContext(workspaceRoot, slug, year);
  try {
    const companyBlock = statementCompanyBlock(ctx.company);
    const accounts = listBankAccounts(ctx.db).accounts.map((a) => ({
      id: a.id,
      name: a.name,
      bankName: a.bankName,
      accountNo: a.accountNo,
      ledgerAccountNo: a.ledgerAccountNo,
    }));
    if (ctx.isArchivedOnly) {
      return {
        slug: ctx.entry.slug,
        selectedYear: ctx.selectedLabel,
        archived: true,
        company: companyBlock,
        fiscalYears: ctx.years,
        periodStart: `${ctx.selectedLabel}-01-01`,
        periodEnd: `${ctx.selectedLabel}-12-31`,
        accounts,
        bookedBalance: 0,
        actualBalance: null,
        difference: null,
        bankStatementStatus: "none" as "known" | "no-balance-column" | "none",
        transactions: [] as BankTransactionRow[],
        matchedCount: 0,
        unmatchedCount: 0,
      };
    }

    const yearNum = parseInt(ctx.selectedLabel, 10);
    const yearStart = `${yearNum}-01-01`;
    const yearEnd = `${yearNum}-12-31`;

    // Bank rows for the year, oldest-first so the running balance reads
    // naturally down the table. The LEFT JOIN to a posted journal entry on
    // `source_bank_transaction_id` is the reconciliation status — the same
    // join `core/reconciliation.listBankTransactions` uses.
    const rows = ctx.db
      .query(
        `SELECT bt.id            AS id,
                bt.transaction_date AS date,
                bt.text          AS text,
                bt.amount        AS amount,
                bt.balance_after AS runningBalance,
                je.entry_no      AS journalEntryNo
           FROM bank_transactions bt
           LEFT JOIN journal_entries je
             ON je.source_bank_transaction_id = bt.id
            AND je.status = 'posted'
          WHERE bt.transaction_date >= ? AND bt.transaction_date <= ?
          ORDER BY bt.transaction_date ASC, bt.id ASC`,
      )
      .all(yearStart, yearEnd) as Array<{
      id: number;
      date: string;
      text: string;
      amount: number;
      runningBalance: number | null;
      journalEntryNo: string | null;
    }>;
    const transactions: BankTransactionRow[] = rows.map((r) => ({
      id: r.id,
      date: r.date,
      text: r.text,
      amount: roundKroner(r.amount),
      runningBalance:
        r.runningBalance === null || r.runningBalance === undefined
          ? null
          : roundKroner(r.runningBalance),
      reconciliationStatus: r.journalEntryNo ? "matched" : "unmatched",
      journalEntryNo: r.journalEntryNo,
    }));
    const matchedCount = transactions.filter(
      (t) => t.reconciliationStatus === "matched",
    ).length;

    // The booked ledger balance vs the actual statement balance (the latest
    // imported `balance_after`). Their gap is the headline of a bank page —
    // money the owner has on paper but not in the account, or vice versa.
    const bookedBalance = bankBalanceAsOf(ctx.db, yearEnd);
    const actualBalance = actualBankBalanceAsOf(ctx.db, yearEnd);
    const difference =
      actualBalance === null ? null : roundKroner(bookedBalance - actualBalance);

    // #305: `actualBalance === null` has two very different causes — no
    // statement imported at all, or a statement WAS imported but its CSV had
    // no balance column. The cockpit must not say "intet kontoudtog
    // importeret" for the second case: an owner who just imported a CSV would
    // think the import silently failed. `bankStatementStatus` distinguishes
    // them so the UI can say "banksaldo ukendt — kontoudtoget havde ingen
    // saldo-kolonne" instead.
    const hasAnyTransactions =
      transactions.length > 0 ||
      (ctx.db
        .query("SELECT 1 FROM bank_transactions LIMIT 1")
        .get() as unknown) !== null;
    const bankStatementStatus: "known" | "no-balance-column" | "none" =
      actualBalance !== null
        ? "known"
        : hasAnyTransactions
          ? "no-balance-column"
          : "none";

    return {
      slug: ctx.entry.slug,
      selectedYear: ctx.selectedLabel,
      archived: false,
      company: companyBlock,
      fiscalYears: ctx.years,
      periodStart: yearStart,
      periodEnd: yearEnd,
      accounts,
      bookedBalance,
      actualBalance,
      difference,
      bankStatementStatus,
      transactions,
      matchedCount,
      unmatchedCount: transactions.length - matchedCount,
    };
  } finally {
    ctx.db.close();
  }
}

// --------------------------------------------------------------------------
// Per-company VAT return (Moms, year-aware) — cockpit-redesign it. 3
// --------------------------------------------------------------------------

export type CompanyVat = ReturnType<typeof buildCompanyVat>;

/**
 * Moms — the VAT return for the selected calendar fiscal year. The VAT period
 * follows the company's own settlement cadence (`vatPeriodType` — month /
 * quarter / half-year, #299); the period that is due now is surfaced, the same
 * selection `buildCompanyOverview` uses. The figures come from the booked VAT
 * accounts via `vatPositionForPeriod`. Money is kroner.
 *
 * #303: `periodStatus` reports the period's effective lifecycle state. A
 * momsangivelse may only be FILED for a `closed`/`reported` period — for an
 * `open` period the figures are provisional, and the cockpit must say so
 * rather than claim they match the terminal `vat momsangivelse` (which refuses
 * an open period). `momsangivelseReady` is the single flag the SPA keys off.
 */
export function buildCompanyVat(
  workspaceRoot: string,
  slug: string,
  year: number | null,
) {
  const ctx = resolveStatementContext(workspaceRoot, slug, year);
  try {
    const companyBlock = statementCompanyBlock(ctx.company);
    if (ctx.isArchivedOnly) {
      const archYear = parseInt(ctx.selectedLabel, 10);
      const archWindow = vatPeriodWindowFor(
        `${archYear}-01-01`,
        ctx.company.vatPeriodType,
      );
      return {
        slug: ctx.entry.slug,
        selectedYear: ctx.selectedLabel,
        archived: true,
        company: companyBlock,
        fiscalYears: ctx.years,
        periodStart: archWindow.start,
        periodEnd: archWindow.end,
        periodLabel: vatPeriodLabel(archWindow),
        outputVat: 0,
        outputVatAdjustment: 0,
        inputVat: 0,
        payable: 0,
        deadline: archWindow.filingDeadline,
        daysRemaining: daysBetween(todayIsoDate(), archWindow.filingDeadline),
        // An archived year carries no live period to close — treat as open so
        // no provisional figures are ever claimed filing-ready.
        periodStatus: "open" as EffectivePeriodState,
        momsangivelseReady: false,
        rubrikker: emptyVatRubrikker(),
      };
    }

    const yearNum = parseInt(ctx.selectedLabel, 10);
    // Surface the VAT period (month / quarter / half-year, per the company's
    // `vatPeriodType`) that is due now — the same selection the static
    // dashboard and the Overblik view use, so the period type never depends on
    // which screen the owner looks at (#299).
    const vatSelection = selectVatPeriod(
      ctx.db,
      yearNum,
      ctx.company.vatPeriodType,
    );
    const vat = vatSelection.position;

    // The statutory filing/payment deadline for the surfaced period, plus a
    // signed countdown from today — negative once the deadline has passed.
    const deadline = vatSelection.deadline;

    // #303: a momsangivelse is only filing-ready for a closed/reported period.
    // For an open period the cockpit shows the figures as PROVISIONAL.
    const periodStatus = vatPeriodEffectiveStatus(
      ctx.db,
      vat.periodStart,
      vat.periodEnd,
    );
    const momsangivelseReady =
      periodStatus === "closed" || periodStatus === "reported";

    // The full SKAT TastSelv rubrics — the same numbers the CLI's
    // `vat momsangivelse` reports — so an owner can file straight from here.
    const rubrikker = vatRubrikkerForPeriod(
      ctx.db,
      vat.periodStart,
      vat.periodEnd,
    );

    return {
      slug: ctx.entry.slug,
      selectedYear: ctx.selectedLabel,
      archived: false,
      company: companyBlock,
      fiscalYears: ctx.years,
      periodStart: vat.periodStart,
      periodEnd: vat.periodEnd,
      periodLabel: vatSelection.label,
      outputVat: vat.outputVat,
      outputVatAdjustment: vat.outputVatAdjustment,
      inputVat: vat.inputVat,
      payable: vat.payable,
      deadline,
      daysRemaining: daysBetween(todayIsoDate(), deadline),
      periodStatus,
      momsangivelseReady,
      rubrikker,
    };
  } finally {
    ctx.db.close();
  }
}

// --------------------------------------------------------------------------
// Per-company documents (Bilag) — cockpit-redesign it. 3
// --------------------------------------------------------------------------

export type DocumentRow = {
  id: number;
  documentNo: string | null;
  source: string;
  filename: string | null;
  documentType: string;
  supplierName: string | null;
  invoiceNo: string | null;
  invoiceDate: string | null;
  amountIncVat: number | null;
  currency: string;
  status: string;
  /** The voucher reference the document was matched on, when linked. */
  voucherRef: string | null;
  /** The linked journal entry's number, when one exists. */
  journalEntryNo: string | null;
  /** The linked journal entry's id, for drill-through. */
  journalEntryId: number | null;
  /** The linked journal entry's posting text — what the voucher is for. */
  journalEntryText: string | null;
  /** The linked journal entry's total (summed debit side), kroner. */
  journalEntryTotal: number | null;
};

export type CompanyDocuments = ReturnType<typeof buildCompanyDocuments>;

/**
 * Bilag — the ingested documents/receipts in the company's `documents` table,
 * each carrying the voucher and posted journal entry it is linked to through
 * `import_document_links` (#196) where one exists. Newest upload first.
 */
export function buildCompanyDocuments(workspaceRoot: string, slug: string) {
  const entry = findWorkspaceCompany(workspaceRoot, slug);
  if (!entry) {
    throw ApiError.notFound(`no company with slug '${slug}' in the workspace`);
  }
  const companyRoot = companyRootForSlug(workspaceRoot, slug);
  const dbPath = companyPaths(companyRoot).db;
  if (!existsSync(dbPath)) {
    throw ApiError.notFound(`company '${slug}' has no ledger`);
  }

  const db = openDb(dbPath);
  try {
    migrate(db);
    const company = getCompanySettings(db);
    const rows = db
      .query(
        `SELECT d.id              AS id,
                d.document_no     AS documentNo,
                d.source          AS source,
                d.original_filename AS filename,
                d.document_type   AS documentType,
                d.supplier_name   AS supplierName,
                d.invoice_no      AS invoiceNo,
                d.invoice_date    AS invoiceDate,
                d.amount_inc_vat  AS amountIncVat,
                d.currency        AS currency,
                d.status          AS status,
                idl.voucher_ref   AS voucherRef,
                je.id             AS journalEntryId,
                je.entry_no       AS journalEntryNo,
                je.text           AS journalEntryText,
                (SELECT COALESCE(SUM(debit_amount), 0)
                   FROM journal_lines
                  WHERE journal_entry_id = je.id) AS journalEntryTotal
           FROM documents d
           LEFT JOIN import_document_links idl ON idl.document_id = d.id
           LEFT JOIN journal_entries je        ON je.id = idl.journal_entry_id
          ORDER BY d.upload_datetime DESC, d.id DESC`,
      )
      .all() as Array<{
      id: number;
      documentNo: string | null;
      source: string;
      filename: string | null;
      documentType: string;
      supplierName: string | null;
      invoiceNo: string | null;
      invoiceDate: string | null;
      amountIncVat: number | null;
      currency: string;
      status: string;
      voucherRef: string | null;
      journalEntryId: number | null;
      journalEntryNo: string | null;
      journalEntryText: string | null;
      journalEntryTotal: number | null;
    }>;

    const documents: DocumentRow[] = rows.map((r) => ({
      id: r.id,
      documentNo: r.documentNo,
      source: r.source,
      filename: r.filename,
      documentType: r.documentType,
      supplierName: r.supplierName,
      invoiceNo: r.invoiceNo,
      invoiceDate: r.invoiceDate,
      amountIncVat:
        r.amountIncVat === null || r.amountIncVat === undefined
          ? null
          : roundKroner(r.amountIncVat),
      currency: r.currency,
      status: r.status,
      voucherRef: r.voucherRef,
      journalEntryNo: r.journalEntryNo,
      journalEntryId: r.journalEntryId,
      journalEntryText: r.journalEntryText,
      journalEntryTotal:
        r.journalEntryId === null || r.journalEntryTotal === null
          ? null
          : roundKroner(r.journalEntryTotal),
    }));
    const linkedCount = documents.filter(
      (d) => d.journalEntryNo !== null,
    ).length;

    return {
      slug: entry.slug,
      company: statementCompanyBlock(company),
      documents,
      linkedCount,
      unlinkedCount: documents.length - linkedCount,
    };
  } finally {
    db.close();
  }
}

// --------------------------------------------------------------------------
// Per-company archive (Arkiv — a single archived year) — cockpit-redesign it. 4
// --------------------------------------------------------------------------

/** One archived `SaldoBalance.csv` line — an account's closing balance. */
export type ArchiveBalanceRow = {
  accountNo: string;
  name: string;
  /** Closing balance, kroner, exactly as the Dinero export stored it. */
  amount: number;
};

export type CompanyArchiveYear = ReturnType<typeof buildCompanyArchiveYear>;

/**
 * Arkiv — one archived fiscal year's read-only reference data (#197). Returns
 * that year's full `SaldoBalance` (every account: number, name, closing
 * amount) from `import_archive_balances`, plus a summary of its archived
 * `Posteringer` (the line count and total). Nothing here touches the live
 * ledger — the archive is append-only Dinero export rows, never posted.
 *
 * Throws `ApiError.notFound` when the slug is not registered, the ledger is
 * missing, or the company has no archived data for `year`.
 */
export function buildCompanyArchiveYear(
  workspaceRoot: string,
  slug: string,
  year: number,
) {
  const entry = findWorkspaceCompany(workspaceRoot, slug);
  if (!entry) {
    throw ApiError.notFound(`no company with slug '${slug}' in the workspace`);
  }
  const companyRoot = companyRootForSlug(workspaceRoot, slug);
  const dbPath = companyPaths(companyRoot).db;
  if (!existsSync(dbPath)) {
    throw ApiError.notFound(`company '${slug}' has no ledger`);
  }

  const db = openDb(dbPath);
  try {
    migrate(db);
    const company = getCompanySettings(db);

    const yearRow = db
      .query(
        `SELECT id, source_system AS sourceSystem,
                posting_count AS postingCount,
                balance_count AS balanceCount,
                imported_at   AS importedAt
           FROM import_archive_years
          WHERE fiscal_year = ?
          ORDER BY id DESC`,
      )
      .get(year) as
      | {
          id: number;
          sourceSystem: string;
          postingCount: number;
          balanceCount: number;
          importedAt: string;
        }
      | undefined;
    if (!yearRow) {
      throw ApiError.notFound(
        `company '${slug}' has no archived data for ${year}`,
      );
    }

    const balanceRows = db
      .query(
        `SELECT account_no AS accountNo, account_name AS name, amount AS amount
           FROM import_archive_balances
          WHERE archive_year_id = ?
          ORDER BY account_no ASC`,
      )
      .all(yearRow.id) as Array<{
      accountNo: string;
      name: string | null;
      amount: number;
    }>;
    const saldoBalance: ArchiveBalanceRow[] = balanceRows.map((r) => ({
      accountNo: r.accountNo,
      name: r.name ?? "",
      amount: roundKroner(r.amount),
    }));

    // A summary of the archived postings — count + total amount. The signed
    // archive `amount` sums to ~0 over a balanced year, so the total here is
    // the gross posting volume (sum of absolute amounts) for an at-a-glance
    // sense of activity.
    const postingSummary = db
      .query(
        `SELECT COUNT(*) AS count,
                COALESCE(SUM(ABS(amount)), 0) AS grossTotal
           FROM import_archive_postings
          WHERE archive_year_id = ?`,
      )
      .get(yearRow.id) as { count: number; grossTotal: number };

    return {
      slug: entry.slug,
      company: statementCompanyBlock(company),
      year: String(year),
      sourceSystem: yearRow.sourceSystem,
      importedAt: yearRow.importedAt,
      saldoBalance,
      postings: {
        count: postingSummary.count,
        grossTotal: roundKroner(postingSummary.grossTotal),
      },
    };
  } finally {
    db.close();
  }
}

// --------------------------------------------------------------------------
// Per-company multi-year key figures (Flerårsoversigt) — cockpit-redesign it. 4
// --------------------------------------------------------------------------

/** Key figures for one fiscal year in the multi-year comparison. */
export type MultiYearRow = {
  /** The fiscal-year label, e.g. "2025". */
  year: string;
  /** Where the figures come from: the live ledger or the #197 archive. */
  source: "live" | "archive";
  /** Income / omsætning for the year, kroner. */
  omsaetning: number;
  /** Expenses / udgifter for the year, kroner. */
  udgifter: number;
  /** Result (omsætning − udgifter), kroner. */
  resultat: number;
  /** Total assets (balancesum) at the year end, kroner. */
  balancesum: number;
  /** Equity (egenkapital incl. period result) at the year end, kroner. */
  egenkapital: number;
  /**
   * Bruttomargin — resultat ÷ omsætning, a 0–1 fraction. Null when there is no
   * omsætning to divide by; no figure is invented.
   */
  bruttomargin: number | null;
  /**
   * Egenkapitalandel — egenkapital ÷ balancesum, a 0–1 fraction. Null when the
   * balance sum is zero.
   */
  egenkapitalandel: number | null;
};

export type CompanyMultiYear = ReturnType<typeof buildCompanyMultiYear>;

/**
 * Flerårsoversigt — key figures for every fiscal year available for a company,
 * oldest→newest so a trend can be charted: the P&L (omsætning / udgifter /
 * resultat), the balance-sheet development (balancesum / egenkapital) and the
 * two ratios an owner reads off a glance (bruttomargin, egenkapitalandel).
 *
 * The live year(s) are computed from the posted ledger via
 * `core/financial-statements` — exactly as `/income-statement` and `/balance`
 * do. The archived years (#197) are derived from `import_archive_balances`:
 * each archived account's closing balance is classified by joining its account
 * number to the live `accounts` table's `type`. Income accounts are
 * credit-normal, so the archive's signed balance is negated to read as a
 * positive omsætning; expense accounts read positive as-is. Assets are
 * debit-normal (read as-is); equity is credit-normal (negated) and carries the
 * un-closed period result so it matches the archive-aware Balance view.
 *
 * Throws `ApiError.notFound` when the slug is not registered or has no ledger.
 */
export function buildCompanyMultiYear(workspaceRoot: string, slug: string) {
  const entry = findWorkspaceCompany(workspaceRoot, slug);
  if (!entry) {
    throw ApiError.notFound(`no company with slug '${slug}' in the workspace`);
  }
  const companyRoot = companyRootForSlug(workspaceRoot, slug);
  const dbPath = companyPaths(companyRoot).db;
  if (!existsSync(dbPath)) {
    throw ApiError.notFound(`company '${slug}' has no ledger`);
  }

  const years = buildCompanyFiscalYears(workspaceRoot, slug).years;

  const db = openDb(dbPath);
  try {
    migrate(db);
    const company = getCompanySettings(db);

    // Account number → type, for classifying archived balances. The archive
    // stores raw account numbers; the live chart of accounts is the only
    // source of an account's income/expense classification.
    const accountTypeRows = db
      .query("SELECT account_no AS accountNo, type AS type FROM accounts")
      .all() as Array<{ accountNo: string; type: string }>;
    const accountType = new Map(
      accountTypeRows.map((r) => [r.accountNo, r.type]),
    );

    // Bruttomargin (resultat ÷ omsætning) and egenkapitalandel (egenkapital ÷
    // balancesum) — each a 0–1 fraction, or null when its denominator is zero.
    // The same two ratios the Overblik view surfaces; no figure is invented.
    const ratios = (
      resultat: number,
      omsaetning: number,
      egenkapital: number,
      balancesum: number,
    ) => ({
      bruttomargin: omsaetning !== 0 ? resultat / omsaetning : null,
      egenkapitalandel: balancesum !== 0 ? egenkapital / balancesum : null,
    });

    const rows: MultiYearRow[] = [];
    for (const fy of years) {
      if (fy.source === "live") {
        const yearNum = parseInt(fy.label, 10);
        const yearEnd = `${yearNum}-12-31`;
        const pl = buildProfitAndLoss(db, `${yearNum}-01-01`, yearEnd);
        // Balance-sheet development — total assets and equity (the equity
        // section plus the un-closed period result), exactly as the Balance
        // and Overblik views compute them.
        const bs = buildBalanceSheet(db, yearEnd);
        const balancesum = roundKroner(bs.totalAssets);
        const egenkapital = roundKroner(bs.equity.total + bs.periodResult);
        const omsaetning = roundKroner(pl.totalIncome);
        const udgifter = roundKroner(pl.totalExpense);
        const resultat = roundKroner(pl.result);
        rows.push({
          year: fy.label,
          source: "live",
          omsaetning,
          udgifter,
          resultat,
          balancesum,
          egenkapital,
          ...ratios(resultat, omsaetning, egenkapital, balancesum),
        });
        continue;
      }

      // Archived year — classify each SaldoBalance line by account type. The
      // archive `amount` is debit-signed (debit − credit): income/equity are
      // credit-normal and read negated, expenses/assets read as-is.
      const archiveId = db
        .query(
          "SELECT id FROM import_archive_years WHERE fiscal_year = ? ORDER BY id DESC",
        )
        .get(parseInt(fy.label, 10)) as { id: number } | undefined;
      let omsaetning = 0;
      let udgifter = 0;
      let balancesum = 0;
      let equitySection = 0;
      if (archiveId) {
        const balRows = db
          .query(
            `SELECT account_no AS accountNo, amount AS amount
               FROM import_archive_balances
              WHERE archive_year_id = ?`,
          )
          .all(archiveId.id) as Array<{ accountNo: string; amount: number }>;
        for (const b of balRows) {
          const type = accountType.get(b.accountNo);
          const amount = Number(b.amount ?? 0);
          if (type === "income") omsaetning += -amount;
          else if (type === "expense") udgifter += amount;
          else if (type === "asset") balancesum += amount;
          else if (type === "equity") equitySection += -amount;
        }
      }
      omsaetning = roundKroner(omsaetning);
      udgifter = roundKroner(udgifter);
      const resultat = roundKroner(omsaetning - udgifter);
      balancesum = roundKroner(balancesum);
      // Equity carries the un-closed period result so it matches the
      // archive-aware Balance view (assets = liabilities + equity + result).
      const egenkapital = roundKroner(equitySection + resultat);
      rows.push({
        year: fy.label,
        source: "archive",
        omsaetning,
        udgifter,
        resultat,
        balancesum,
        egenkapital,
        ...ratios(resultat, omsaetning, egenkapital, balancesum),
      });
    }

    // Oldest→newest so the SPA can chart a trend left-to-right.
    rows.sort((a, b) => a.year.localeCompare(b.year));

    return {
      slug: entry.slug,
      company: statementCompanyBlock(company),
      years: rows,
    };
  } finally {
    db.close();
  }
}

// --------------------------------------------------------------------------
// Per-company issued invoices (Fakturaer, year-aware) — cockpit-redesign it. 5
// --------------------------------------------------------------------------

/** One issued invoice — the fields the Fakturaer view renders. */
export type CompanyInvoiceRow = {
  documentId: number;
  invoiceNo: string;
  invoiceDate: string | null;
  customerName: string | null;
  /** Gross amount inc. VAT, kroner. */
  grossAmount: number;
  /** Still-outstanding balance on the invoice, kroner. */
  openBalance: number;
  currency: string;
  /** Settlement state, plus "overdue" for an open invoice past its due date. */
  status: "open" | "paid" | "credited" | "refunded" | "overpaid" | "written_off" | "overdue";
  effectiveDueDate: string | null;
  overdueDays: number;
};

export type CompanyInvoices = ReturnType<typeof buildCompanyInvoices>;

/**
 * Fakturaer — the company's issued (sales) invoices for the selected calendar
 * fiscal year. Each row carries its settlement status; an open invoice past
 * its due date is surfaced as "overdue". Every figure comes from
 * `core/invoice-list` (which derives status via `core/invoice-payments`) — no
 * business logic is duplicated. A company with no issued invoices returns an
 * empty list, which is a correct, expected state.
 */
export function buildCompanyInvoices(
  workspaceRoot: string,
  slug: string,
  year: number | null,
) {
  const ctx = resolveStatementContext(workspaceRoot, slug, year);
  try {
    const companyBlock = statementCompanyBlock(ctx.company);
    if (ctx.isArchivedOnly) {
      return {
        slug: ctx.entry.slug,
        selectedYear: ctx.selectedLabel,
        archived: true,
        company: companyBlock,
        fiscalYears: ctx.years,
        periodStart: `${ctx.selectedLabel}-01-01`,
        periodEnd: `${ctx.selectedLabel}-12-31`,
        invoices: [] as CompanyInvoiceRow[],
        totalGross: 0,
        totalOpen: 0,
        overdueCount: 0,
      };
    }

    const yearNum = parseInt(ctx.selectedLabel, 10);
    const yearStart = `${yearNum}-01-01`;
    const yearEnd = `${yearNum}-12-31`;

    const list = buildInvoiceList(ctx.db, { from: yearStart, to: yearEnd });
    const invoices: CompanyInvoiceRow[] = list.rows.map((r) => ({
      documentId: r.documentId,
      invoiceNo: r.invoiceNumber,
      invoiceDate: r.invoiceDate,
      customerName: r.customerName,
      grossAmount: roundKroner(r.grossAmount),
      openBalance: roundKroner(r.openBalance),
      currency: r.currency,
      status: r.isOverdue ? "overdue" : r.status,
      effectiveDueDate: r.effectiveDueDate,
      overdueDays: r.overdueDays,
    }));
    // Newest invoice first — the most recent activity is what the user wants.
    invoices.sort((a, b) => {
      const dateA = a.invoiceDate ?? "";
      const dateB = b.invoiceDate ?? "";
      if (dateA !== dateB) return dateB.localeCompare(dateA);
      return b.invoiceNo.localeCompare(a.invoiceNo);
    });

    const totalGross = roundKroner(
      invoices.reduce((acc, r) => acc + r.grossAmount, 0),
    );
    const totalOpen = roundKroner(
      invoices.reduce((acc, r) => acc + r.openBalance, 0),
    );
    const overdueCount = invoices.filter((r) => r.status === "overdue").length;

    return {
      slug: ctx.entry.slug,
      selectedYear: ctx.selectedLabel,
      archived: false,
      company: companyBlock,
      fiscalYears: ctx.years,
      periodStart: yearStart,
      periodEnd: yearEnd,
      invoices,
      totalGross,
      totalOpen,
      overdueCount,
    };
  } finally {
    ctx.db.close();
  }
}

// --------------------------------------------------------------------------
// Per-company contacts (Kontakter — customers + vendors) — cockpit-redesign it. 5
// --------------------------------------------------------------------------

/** One customer in the master data. */
export type ContactCustomerRow = {
  id: number;
  name: string;
  vatOrCvr: string | null;
  email: string | null;
  paymentTermsDays: number;
  defaultCurrency: string;
};

/** One vendor (supplier) in the master data. */
export type ContactVendorRow = {
  id: number;
  name: string;
  vatOrCvr: string | null;
  defaultExpenseAccount: string | null;
  defaultVatTreatment: string | null;
};

export type CompanyContacts = ReturnType<typeof buildCompanyContacts>;

/**
 * Kontakter — the company's customers and vendors (master data). This is
 * reference data, not year-scoped; the company sub-nav still carries the
 * selected `?year=` so it follows the user across views, so the fiscal years
 * for the selector are fetched alongside. Both lists come straight from
 * `core/master-data`. A company with no contacts returns empty lists — a
 * correct, expected state.
 */
export function buildCompanyContacts(workspaceRoot: string, slug: string) {
  const entry = findWorkspaceCompany(workspaceRoot, slug);
  if (!entry) {
    throw ApiError.notFound(`no company with slug '${slug}' in the workspace`);
  }
  const companyRoot = companyRootForSlug(workspaceRoot, slug);
  const dbPath = companyPaths(companyRoot).db;
  if (!existsSync(dbPath)) {
    throw ApiError.notFound(`company '${slug}' has no ledger`);
  }

  const years = buildCompanyFiscalYears(workspaceRoot, slug).years;

  const db = openDb(dbPath);
  try {
    migrate(db);
    const company = getCompanySettings(db);

    const customers: ContactCustomerRow[] = listCustomers(db).rows.map((c) => ({
      id: c.id,
      name: c.name,
      vatOrCvr: c.vatOrCvr,
      email: c.email,
      paymentTermsDays: c.paymentTermsDays,
      defaultCurrency: c.defaultCurrency,
    }));
    const vendors: ContactVendorRow[] = listVendors(db).rows.map((v) => ({
      id: v.id,
      name: v.name,
      vatOrCvr: v.vatOrCvr,
      defaultExpenseAccount: v.defaultExpenseAccount,
      defaultVatTreatment: v.defaultVatTreatment,
    }));

    return {
      slug: entry.slug,
      company: statementCompanyBlock(company),
      fiscalYears: years,
      customers,
      vendors,
    };
  } finally {
    db.close();
  }
}

// --------------------------------------------------------------------------
// Per-company obligations (Forpligtelser — what the company owes, year-aware)
// — cockpit-redesign Runde 2, iteration 7
// --------------------------------------------------------------------------

/** One thing the company owes — a payable surfaced from the ledger. */
export type ObligationRow = {
  /** A short, stable key for the obligation kind. */
  kind:
    | "vat"
    | "corporation-tax"
    | "annual-report"
    | "creditors"
    | "auditor"
    | "other";
  /** A human Danish label, e.g. "Moms — Q2 2026". */
  label: string;
  /** The amount owed, kroner; positive is payable. */
  amount: number;
  /** The filing/payment deadline as YYYY-MM-DD, or null when none is known. */
  dueDate: string | null;
  /** Signed countdown from today to `dueDate`; null when `dueDate` is null. */
  daysRemaining: number | null;
  /** The ledger account the figure was read from, when one applies. */
  accountNo: string | null;
};

export type CompanyObligations = ReturnType<typeof buildCompanyObligations>;

/**
 * Standard Danish liability account numbers (the Dinero chart) whose meaning
 * is well-known enough to label precisely and — for VAT and corporation tax —
 * carry a derived deadline. Trade creditors and accrued auditor have no
 * statutory date the ledger can derive, so their `dueDate` is left null.
 */
const KNOWN_LIABILITY_ACCOUNTS: Record<
  string,
  { kind: ObligationRow["kind"]; label: string }
> = {
  "63000": { kind: "creditors", label: "Kreditorer (leverandørgæld)" },
  "63040": { kind: "auditor", label: "Afsat revisor" },
  "63060": { kind: "corporation-tax", label: "Skyldig selskabsskat" },
};

/**
 * The credit-signed balance (credit − debit, kroner) of every `liability`-type
 * account at `asOfDate`, excluding the entire standard Danish VAT block.
 *
 * No VAT account may appear as a liability row here — VAT is surfaced as its
 * own single obligation from the booked VAT position (`vatPositionForPeriod`),
 * and that net figure already represents the *whole* VAT obligation. The gross
 * VAT accounts (output VAT `64000`, foreign-services reverse-charge `64040`,
 * input VAT `64060`, …) are merely *components* of that computation, so
 * counting them here as well would double-count VAT. The exclusion uses the
 * same VAT-account identification as `vatPositionForPeriod`: `type = 'vat'`
 * (native-Rentemester chart) or the standard Danish block `64000`–`64099`.
 * The `64100`-block settlement accounts (`Momsafregning`) only shuttle money
 * between the VAT accounts and the bank, so they are excluded too.
 */
function liabilityBalancesAsOf(
  db: Database,
  asOfDate: string,
): Array<{ accountNo: string; name: string; balance: number }> {
  const rows = db
    .query(
      `SELECT a.account_no AS accountNo,
              a.name       AS name,
              COALESCE(SUM(jl.credit_amount - jl.debit_amount), 0) AS balance
         FROM accounts a
         JOIN journal_lines jl     ON jl.account_id = a.id
         JOIN journal_entries je   ON je.id = jl.journal_entry_id
        WHERE a.type = 'liability'
          AND je.status = 'posted'
          AND je.transaction_date <= ?
          AND a.type != 'vat'
          AND NOT (a.account_no >= '64000' AND a.account_no < '64100')
          AND lower(a.name) NOT LIKE '%momsafregning%'
          AND a.account_no NOT GLOB '641[0-9][0-9]'
        GROUP BY a.id
        ORDER BY a.account_no ASC`,
    )
    .all(asOfDate) as Array<{
    accountNo: string;
    name: string;
    balance: number;
  }>;
  return rows.map((r) => ({
    accountNo: r.accountNo,
    name: r.name,
    balance: roundKroner(r.balance),
  }));
}

/**
 * Forpligtelser — "what does the company owe, and when". A year-aware list of
 * the company's outstanding payables, each with the amount owed and a due date
 * where one is derivable. Every figure is read straight from the posted
 * ledger:
 *
 *  - VAT — the booked quarterly VAT position (`vatPositionForPeriod`); its
 *    deadline is the statutory filing date (`vatQuarterDeadline`).
 *  - Corporation tax, trade creditors, accrued auditor and any other payable
 *    — the credit balance of the `liability`-type accounts at the year end.
 *    Known account numbers get a precise Danish label; corporation tax also
 *    gets a derived SKAT deadline. The rest carry no date — that is fine and
 *    shown as "—" in the UI.
 *
 * Rows are returned sorted by due date (soonest first); rows with no date sink
 * to the bottom. Money is kroner. Throws `ApiError.notFound` when the slug is
 * not registered or has no ledger.
 */
export function buildCompanyObligations(
  workspaceRoot: string,
  slug: string,
  year: number | null,
) {
  const ctx = resolveStatementContext(workspaceRoot, slug, year);
  try {
    const companyBlock = statementCompanyBlock(ctx.company);
    if (ctx.isArchivedOnly) {
      return {
        slug: ctx.entry.slug,
        selectedYear: ctx.selectedLabel,
        archived: true,
        company: companyBlock,
        fiscalYears: ctx.years,
        obligations: [] as ObligationRow[],
        totalOwed: 0,
      };
    }

    const today = todayIsoDate();
    const yearNum = parseInt(ctx.selectedLabel, 10);
    const yearEnd = `${yearNum}-12-31`;
    const obligations: ObligationRow[] = [];

    // VAT: each VAT period settles separately. Surface every period that
    // carries a payable so the owner sees each filing deadline; if no period
    // has a payable, no VAT obligation is shown. #299: the periods follow the
    // company's real VAT cadence (`vatPeriodType`) — a monthly filer sees up to
    // twelve VAT lines, a half-yearly filer two — never a hardcoded quarter.
    for (const window of vatPeriodsForYear(yearNum, ctx.company.vatPeriodType)) {
      const position = vatPositionForPeriod(ctx.db, window.start, window.end);
      if (position.payable > 0) {
        obligations.push({
          kind: "vat",
          label: `Moms — ${vatPeriodLabel(window)}`,
          amount: position.payable,
          dueDate: window.filingDeadline,
          daysRemaining: daysBetween(today, window.filingDeadline),
          accountNo: null,
        });
      }
    }

    // Annual report (årsrapport) — the statutory filing to Erhvervsstyrelsen.
    // It is not a ledger payable (it has no amount owed), but it is the other
    // recurring legal deadline an owner must not miss, so the Forpligtelser
    // screen surfaces it alongside VAT (#290). The deadline is computed the
    // SAME way `agent run` does (`src/agent/loop.ts#checkDeadlines`): a
    // class-B company files its årsrapport by the 1st of the 5th month after
    // the fiscal year ends. The fiscal year is derived from the company's own
    // `fiscalYearStartMonth` / label strategy, so a non-calendar year is
    // handled correctly. `amount` is 0 — it is a deadline, not a debt.
    const fy = fiscalYearForDate(
      yearEnd,
      ctx.company.fiscalYearStartMonth,
      ctx.company.fiscalYearLabelStrategy,
    );
    const fyEndYear = parseInt(fy.end.slice(0, 4), 10);
    const fyEndMonth = parseInt(fy.end.slice(5, 7), 10);
    const annualReportDue = new Date(Date.UTC(fyEndYear, fyEndMonth + 4, 1));
    const annualReportDueDate = `${annualReportDue.getUTCFullYear()}-${String(
      annualReportDue.getUTCMonth() + 1,
    ).padStart(2, "0")}-01`;
    obligations.push({
      kind: "annual-report",
      label: `Årsrapport — regnskabsår ${fy.displayLabel}`,
      amount: 0,
      dueDate: annualReportDueDate,
      daysRemaining: daysBetween(today, annualReportDueDate),
      accountNo: null,
    });

    // Liability accounts with a credit balance — corporation tax, trade
    // creditors, accrued auditor and anything else. A debit (negative) balance
    // is not a payable, so it is skipped. Corporation tax for an income year
    // is due to SKAT on 1 November of the following year (the standard ApS
    // restskat deadline) — the only liability date the ledger can derive.
    for (const acc of liabilityBalancesAsOf(ctx.db, yearEnd)) {
      if (acc.balance <= 0) continue;
      const known = KNOWN_LIABILITY_ACCOUNTS[acc.accountNo];
      const kind: ObligationRow["kind"] = known?.kind ?? "other";
      const label = known?.label ?? acc.name;
      const dueDate =
        kind === "corporation-tax" ? `${yearNum + 1}-11-01` : null;
      obligations.push({
        kind,
        label,
        amount: acc.balance,
        dueDate,
        daysRemaining: dueDate === null ? null : daysBetween(today, dueDate),
        accountNo: acc.accountNo,
      });
    }

    // Sorted by due date, soonest first; dateless rows sink to the bottom.
    // Ties break by descending amount, then by label — fully deterministic.
    obligations.sort((a, b) => {
      if (a.dueDate !== b.dueDate) {
        if (a.dueDate === null) return 1;
        if (b.dueDate === null) return -1;
        return a.dueDate.localeCompare(b.dueDate);
      }
      if (a.amount !== b.amount) return b.amount - a.amount;
      return a.label.localeCompare(b.label, "da");
    });

    const totalOwed = roundKroner(
      obligations.reduce((acc, o) => acc + o.amount, 0),
    );

    return {
      slug: ctx.entry.slug,
      selectedYear: ctx.selectedLabel,
      archived: false,
      company: companyBlock,
      fiscalYears: ctx.years,
      obligations,
      totalOwed,
    };
  } finally {
    ctx.db.close();
  }
}

// --------------------------------------------------------------------------
// Per-company cash flow (Likviditet — actual money in/out, year-aware)
// — cockpit-redesign Runde 2, iteration 8
// --------------------------------------------------------------------------

/** One calendar month of actual money movement on the bank statement. */
export type CashflowMonth = {
  /** 1–12. */
  month: number;
  label: string;
  /** Sum of positive `bank_transactions.amount` in the month, kroner. */
  indbetalinger: number;
  /** Sum of negative amounts as a positive figure (money out), kroner. */
  udbetalinger: number;
  /** indbetalinger − udbetalinger; the net movement, kroner. */
  netto: number;
};

/** One dated point on the real bank-balance trajectory. */
export type CashflowBalancePoint = {
  date: string;
  /** The imported `balance_after` at this point, kroner. */
  balance: number;
};

export type CompanyCashflow = ReturnType<typeof buildCompanyCashflow>;

/**
 * Likviditet / pengestrøm — actual money in and out of the bank for the
 * selected calendar fiscal year, computed straight from the imported
 * `bank_transactions` (NOT the accrual ledger). This is what the owner's bank
 * app shows: real cash, not booked revenue.
 *
 *  - `months` — per-month indbetalinger (positive amounts) and udbetalinger
 *    (negative amounts, shown as a positive figure), all twelve months.
 *  - `balanceSeries` — the `balance_after` trajectory: every transaction in the
 *    year that carries a running balance, oldest-first; the real bank-balance
 *    line.
 *  - summary — opening balance (the actual balance the day before the year
 *    starts), total in, total out and closing balance for the year.
 *
 * `hasTransactions` is false when the company has no bank rows at all in the
 * year — the UI renders a clean empty state. Money is kroner. Throws
 * `ApiError.notFound` when the slug is not registered or has no ledger.
 */
export function buildCompanyCashflow(
  workspaceRoot: string,
  slug: string,
  year: number | null,
) {
  const ctx = resolveStatementContext(workspaceRoot, slug, year);
  try {
    const companyBlock = statementCompanyBlock(ctx.company);
    const yearNum = parseInt(ctx.selectedLabel, 10);
    const yearStart = `${yearNum}-01-01`;
    const yearEnd = `${yearNum}-12-31`;
    const priorYearEnd = `${yearNum - 1}-12-31`;

    const emptyMonths = (): CashflowMonth[] =>
      MONTH_NAMES_DK.map((label, i) => ({
        month: i + 1,
        label,
        indbetalinger: 0,
        udbetalinger: 0,
        netto: 0,
      }));

    if (ctx.isArchivedOnly) {
      return {
        slug: ctx.entry.slug,
        selectedYear: ctx.selectedLabel,
        archived: true,
        company: companyBlock,
        fiscalYears: ctx.years,
        periodStart: yearStart,
        periodEnd: yearEnd,
        hasTransactions: false,
        months: emptyMonths(),
        balanceSeries: [] as CashflowBalancePoint[],
        openingBalance: null as number | null,
        closingBalance: null as number | null,
        totalIn: 0,
        totalOut: 0,
      };
    }

    // Every bank transaction in the year, oldest-first — drives both the
    // monthly in/out totals and the balance trajectory.
    const rows = ctx.db
      .query(
        `SELECT bt.transaction_date AS date,
                bt.amount           AS amount,
                bt.balance_after    AS balanceAfter
           FROM bank_transactions bt
          WHERE bt.transaction_date >= ? AND bt.transaction_date <= ?
          ORDER BY bt.transaction_date ASC, bt.id ASC`,
      )
      .all(yearStart, yearEnd) as Array<{
      date: string;
      amount: number;
      balanceAfter: number | null;
    }>;

    const months = emptyMonths();
    let totalIn = 0;
    let totalOut = 0;
    const balanceSeries: CashflowBalancePoint[] = [];
    for (const r of rows) {
      const month = parseInt(r.date.slice(5, 7), 10);
      const slot = months[month - 1];
      const amount = Number(r.amount ?? 0);
      if (slot) {
        if (amount >= 0) slot.indbetalinger += amount;
        else slot.udbetalinger += -amount;
      }
      if (amount >= 0) totalIn += amount;
      else totalOut += -amount;
      if (r.balanceAfter !== null && r.balanceAfter !== undefined) {
        balanceSeries.push({
          date: r.date,
          balance: roundKroner(Number(r.balanceAfter)),
        });
      }
    }
    for (const m of months) {
      m.indbetalinger = roundKroner(m.indbetalinger);
      m.udbetalinger = roundKroner(m.udbetalinger);
      m.netto = roundKroner(m.indbetalinger - m.udbetalinger);
    }

    // Opening balance — the actual statement balance the day before the year
    // begins; closing balance — the actual balance at the year end. Both come
    // from the same `balance_after`-based helper the bank view uses, so they
    // are null when no statement carries a running balance.
    const openingBalance = actualBankBalanceAsOf(ctx.db, priorYearEnd);
    const closingBalance = actualBankBalanceAsOf(ctx.db, yearEnd);

    return {
      slug: ctx.entry.slug,
      selectedYear: ctx.selectedLabel,
      archived: false,
      company: companyBlock,
      fiscalYears: ctx.years,
      periodStart: yearStart,
      periodEnd: yearEnd,
      hasTransactions: rows.length > 0,
      months,
      balanceSeries,
      openingBalance,
      closingBalance,
      totalIn: roundKroner(totalIn),
      totalOut: roundKroner(totalOut),
    };
  } finally {
    ctx.db.close();
  }
}

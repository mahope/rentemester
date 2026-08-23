# IMPLEMENTATION_PLAN — Rentemester

Autonom loop-state. Læs FØRST, hold opdateret. Mission: korrekthed i et dagligt brugt,
append-only dansk bogføringssystem (MCP + kerne, TypeScript/bun). Intet live-site, ingen
deploys — men revisionskritisk kode.

## Gate-definition (fra docs/build-loop.md + .github/workflows)

1. Fokuserede tests → 2. `bun test` → 3. `bun run smoke` (frisk /tmp/rentemester-smoke) →
4. `bun run typecheck` (tilføjet 2026-08-23) → 5. `bun run lint` (tilføjet 2026-08-23,
biome) → 6. `git diff --check`. CI kører `test.yml` (`bun test`) og `smoke.yml`
(`bun run smoke`; budget-varianten `smoke:budget` fejler over 30s). Typecheck og lint
kører IKKE i CI endnu (noteret under opgave 6).
- bun ligger i `~/.bun/bin` (ikke på PATH i alle shells): `export PATH="$HOME/.bun/bin:$PATH"`.

## Repo-kort (research 2026-08-22)

- **Arkitektur**: `src/core/` (66 moduler: ledger m. sha256-hash-kæde, vat, invoice*,
  bank, backup/governance, gdpr, import/export, dates/money-hjælpere), `src/cli/`
  (32 kommandomoduler + dispatch), `src/mcp/server.ts`, `src/server/` (cockpit-API),
  `app/` (React-cockpit SPA — egen tsconfig/package.json), `www/` (site — egen tsconfig),
  `examples/` (fixtures til smoke/CLI), `docs/`, `rules/`.
- **Tests**: 169 filer / ~1163 tests (`bun test`). Dækker kerneflows bredt: journal-post +
  balance, hash-kæde (ledger-hardening, audit-verify, gdpr-ledger-integrity), moms (vat-*),
  renter (invoice-interest, Renteloven: reference + 8 pct.), fakturaflow, skudår i dates.test.ts.
- **Sikkerhed**: `npm audit` = **0 vulnerabilities** (package-lock.json genereret lokalt;
  projektet bruger bun.lock). Ingen advisories at rette pt.
- **Lint**: ingen konfiguration overhovedet (ingen eslint/biome/oxlint).
- **Typecheck**: rod-tsconfig har ingen excludes → `bunx tsc --noEmit` = 3709 fejl (3500 i
  app/, der skal bygges med sin egen config; 84 i src/, 107 i tests/, 8+10 i examples/www).
- **Miljø**: bun 1.3.14 lokalt; CI bruger oven-sh/setup-bun.

### Kritisk fund: tidsafhængig test-råd (baseline er RØD)

Seneste commit er 2026-05-22; i dag 2026-08-22. Fixtures med hardkodede datoer er rådnnet:

- VIES-cache TTL = 90 dage (`src/core/vies.ts`). Tests seeder `validatedAt: 2026-05-15`,
  smoke-seeder `2026-05-16 → expires 2026-08-16` (scripts/seed-vies-validation.ts) → udløbet.
- **12 fejlende tests** i `bun test`: reverse-charge/VIES-klyngen (invoice-issue ×2,
  credit-notes, eu-reverse-charge ×2, expense-booking, invoice-ledger-posting), cockpit
  VAT-periodvalg ×2 (#272), authority-export audit-counts, system-backups weekly-duty,
  examples/agent-demo audit-chain.
- **`bun run smoke` fejler**: "VIES validation ... expired at 2026-08-16".
- Årsag-mønster: kode understøtter eksplicit `asOf`-parametre flere steder, men tests/seeds
  bruger "now" implícit + faste kalenderdatoer i fixtures.

### Husstandholdning

- `package-lock.json` er utracket npm-artefakt (brugt til npm audit). Beslutning: føj til
  `.gitignore` (projektets lockfile er bun.lock) — med i typecheck-opgaven.

---

## Opgaver (prioriteret)

### 1. [P0] FÆRDIG — Reparér tidsafhængige tests + smoke (genopret grøn baseline)
- **Løst 2026-08-23** (commit 6b5e43f, merge c313735): alle 12 fejlende tests + smoke +
  agent-demo var samme rod — hardkodede maj-2026-datoer vs. rigtige ur. Rettelser (kun
  test-infra, `src/` urørt):
  - VIES-seeds (7 steder i 6 testfiler + `scripts/seed-vies-validation.ts`): hardcodede
    `validatedAt`/`expiresAt` fjernet → modulets default (nu + 90 dages TTL) bruges.
  - `system-backups.test.ts` weekly-duty: transaktionsdatoer afledes nu af backup-
    tidspunktet (±1 dag) i stedet for faste datoer.
  - `authority-export.test.ts` #1: periode anket omkring "nu" (periodEnd = sidste dag i
    næste måned som margin), fixture-datoer sættes dynamisk i testen, frist-forventning
    = requestedAt + 28 dage. Begrundelse: audit_log er append-only (triggers), så rækker
    kan ikke flyttes i tid — perioden må indeholde "nu".
  - `server-api.test.ts` #272 ×2: aktivitet dateres "i dag", afskrivning midt i NÆSTE
    kvartal; kvartalgrænser/frist beregnes uafhængigt i testen (1. i tredje måned efter
    kvartalslut). Forventningerne er ikke tautologiske (bruger ikke core/periods.ts).
- **Accept verificeret**: `bun test` = 1163/1163 grønne; `bun run smoke` exit 0;
  `git diff --check` ren. Bemærk: to tests fik dynamiske (ikke hardcodede) assertions —
  semantisk intent bevaret, reviewet som del af diffen.

### 2. [P1] FÆRDIG — Typecheck som gate: rod-tsconfig-excludes + ryd op i src/
- **Løst 2026-08-23** (commit ce74003):
  - Rod-tsconfig excluderer nu `app/`, `www/`, `examples/` (egne configs/builds).
  - `"typecheck": "tsc --noEmit"` script + `typescript@5.9.3` i devDependencies.
  - `package-lock.json` i `.gitignore`.
  - Nyt `src/bun-sqlite.d.ts`: udvider bun-types 1.4.0 med `transaction(fn,
    { immediate })`-options som koden allerede brugte runtime.
  - src/-fixes (alle type-niveau, runtime-uændret): array-bindings til `db.run`
    (ny signatur i bun-types kræver ÉN array), `ok: true as const`-diskriminering,
    generiske `getCurrent<any>`, non-null assertions bag eksisterende guards,
    `withCockpitActor`-returtype præciseret.
  - tests/-fixes (~106 fejl): db.run-array-bindings, `InvoicePayload`-typede
    payload-hjælpere (3 filer), branded `invoiceNumber` sammenlignet via
    template-literal, `Bun.Subprocess<"pipe","pipe","pipe">`-felttyper i de to
    MCP-testklienter, `parse!()` for valgfrit SourceParser.parse, fetch-mocks
    `as unknown as typeof fetch` (som cvr-lookup.test.ts allerede), fuldt
    CompanySettings-fixture, `!` på optional felter.
- **Accept verificeret**: root `bun run typecheck` = 0 fejl; app/ bygger med egen
  config (`vite build`, efter lokal `bun install` — deps var ikke installeret);
  www/ bygger med astro; `bun test` = 1163/1163 grønne; `bun run smoke` exit 0;
  `git diff --check` ren.

### 3. [P1] FÆRDIG — Lint-setup
- **Løst 2026-08-23** (arbejdet fra afbrudt iteration færdiggjort + merge):
  - `@biomejs/biome` 2.x som devDependency; `biome.json` med recommended-preset,
    correctness-regler på error, formatter FRA (ingen stilistik-omskrivninger —
    repoet har ingen ensartet formatering, og den diskussion tilhører Mads),
    scope: `src/`, `tests/`, `scripts/` (app/www/examples har egen toolchain).
  - `"lint": "biome lint --config-path=biome.json src/ tests/ scripts/"`.
  - ~30 filers fixes: ubrugte imports fjernet, ubrugte parametre/konstanter
    prefixed `_`, eksplicitte type-annotationer hvor inference brød regler,
    escapede anførselstegn i template-literals ryddet, biome-ignore med begrundelse
    på 2 bevidste idiomer (while-re.exec, transaktion-for).
  - Semantik-verificeret punktvis: de 3 fjernede `case "quarter":`-labels faldt
    alle igennem til identiske `default`-grene (død kode); WINANSI-tabel i
    invoice-pdf.ts er kun hex→decimal-literaler (identiske værdier).
  - Rettede fejl fra den afbrudte iteration: `KeyObject` var annoteret men ikke
    importeret i system-restore.ts → typecheck rød; import tilføjet.
  - docs/build-loop.md opdateret: gate-trin, main-krav og definition-of-done
    nævner nu `bun run typecheck` + `bun run lint`.
- **Accept verificeret**: `bun run lint` exit 0 (334 filer); `bun test` =
  1163/1163 grønne; `bun run smoke` exit 0; `bun run typecheck` = 0 fejl;
  `git diff --check` ren.

### 4. [P2] FÆRDIG — Testdækningsgab i kerneflows (randtilfælde)
- **Løst 2026-08-23** (commit 9a103df): 6 nye testfiler, 70 nye tests (1233 totalt,
  op fra 1163). Alle skrevet som "fejlende proof" — de testede koden var allerede
  korrekt, så de fungerede som regression guards, ikke bugfixes. Ingen src/-ændringer.
  - **money-edge-cases.test.ts** (31 tests): roundDiv med fortegn/nul/overflow,
    toOre/fromOre-konvertering (NaN-throw, bigint round-trip), formatAmount/null-input,
    formatDkk/currency, formatKronerDa/DK-format/non-finite, compareDkk/equalsDkk/absDkk,
    addDkk/subtractDkk/float-drift, multiplyDkk/fortegn/nul, percentOfDkk/grænser,
    accrueInterestDkk/365-dage/nul-input/små-beløb, normalizeCurrency.
  - **fiscal-year-edge-cases.test.ts** (12 tests): kalenderår (startMonth=1),
    offset-start (2/7/12), label-strategier (start-year/end-year/span), boundary-datoer
    (første/sidste dag i regnskabsåret), invalid-date-throw.
  - **vat-period-type-edge-cases.test.ts** (12 tests): Q4-kvartal med næste-års
    deadline, december-måned med marts-deadline, skudårs-februar (29. vs 28.),
    hver kadence for 31. december, alle 12 måneders danske labels, vatPeriodsForYear
    i skudår.
  - **audit-verify-edge-cases.test.ts** (5 tests): single-field tampering på
    transaction_date, single-field tampering på text, line-amount tampering (balanced),
    middle truncation (entry fjernet), hashEntry-producerer forskellig hash ved
    line-reordering.
  - **invoice-interest-edge-cases.test.ts** (6 tests): renter over skudårs-februar
    (29 dage), over årsskifte (dec→jan), over månedsskifte (31. mar→1. apr),
    negativ referencesats (DK-historisk), referencesats=0, fuld cycle (register+post+
    verify) med skudår.
  - **vat-report-edge-cases.test.ts** (4 tests): tom periode (zero totals),
    transaktion på præcis periodestart (inkluderet), på præcis periodslut
    (inkluderet), dagen før periodestart (ekskluderet).
- **Fund undervejs**: 
  - `journal_lines` har ingen `ordinal`-kolonne i SQL — ordinals er kun i hash-
    computation, ikke persisted → line-reordering testes via hashEntry() direkte.
  - `postJournalEntry` kræver `documentId` for linjer med vatCode — nødvendiggjorde
    document-ingest i VAT boundary-tests.
  - `issueInvoice` auto-tildeler invoiceNumbers sekventielt — manuelle numre afvises
    hvis de ikke er de næste i rækken.
- **Accept verificeret**: `bun test` = 1233/1233 grønne; `bun run smoke` exit 0;
  `bun run typecheck` = 0 fejl; `bun run lint` exit 0; `git diff --check` ren.

### 5. [P3] FÆRDIG — Fejlbeskeder + døde stier
- **Løst 2026-08-23** (commit eecbed2):
  - Forbedrede 8 vage fejlbeskeder på tværs af core/ og mcp/:
    - SMTP-fejl nævner nu host + fakturanummer (email.ts)
    - Restore-fejl nævner backupId, createdAt, target (system-restore.ts)
    - "resolveDocumentMasterData failed" → beskrivende dansk (documents.ts,
      write-handlers.ts ×2)
    - "unsafe path" → forklarer hvorfor og giver handlingsanvisning
      (tool-runtime.ts)
    - "not exist or not initialized" → "does not exist: <redacted> — run
      'company init' first" med path-redaction (tool-runtime.ts)
    - "only DKK" → nævner faktisk currency (invoice-reminders.ts)
    - "could not be evaluated" → "is unavailable (check destination and
      server logs)" (backup-governance.ts)
    - vat.ts error: wrapCoreResult + appliedRules:[] → errorEnvelope (renere
      envelope)
  - Fjernet død kode (10 unused exports: dbExists, isValidEanNumber,
    asBankTransactionId, CustomerRecord, VendorRecord, FALLBACK_DASH,
    CompanyPaths, envelopeOutputSchema; dead barrel src/server/index.ts)
  - Udvidede cli-errors.test.ts med 3 nye tests: exit 2 for parse/usage,
    exit 1 for business rejection, JSON envelope med specifikke errors
  - Ingen ændringer i ledger/hash-kæde/beregningslogik — ren
    test-infra + kosmetiske fejlbeskeder
- **Accept verificeret**: `bun test` = 1236/1236 grønne (3 nye); `bun run smoke` exit 0;
  `bun run typecheck` = 0 fejl; `bun run lint` exit 0; `git diff --check` ren.
- Gennemgå envelope `ok/errors[]`-konsistens i CLI/MCP-svar; tydeligere beskeder hvor
  diffuse. Kør lint/typecheck-fund igennem for død kode.
- **Accept**: cli-errors.test.ts udvidet; ingen funktionsændringer uden bevis.

### 6. [P3] Docs-sync
- Opdatér docs/build-loop.md (gate: typecheck/lint når tilføjet), AGENTS.md/cli-contract.md
  hvis actor-flow ændres, README ved større afvigelser.
- **Accept**: docs stemmer med faktiske scripts i package.json.

## Beslutninger & fund (log)

- 2026-08-22: Research-iteration. npm audit ren; baseline rød pga. tidsråd (detaljer
  ovenfor); ingen linter; root-tsc ubrugelig uden excludes. P0 = genopret grøn baseline
  før alt andet (missionens "korrekthed er alt").
- Risici noteret: ingen rigtige datapaths set i repo-config (companies/ er gitignored);
  .env.example indeholder kun pladsholdere — intet at reagere på.
- 2026-08-23: Opgave 1 løst (6b5e43f). Fund undervejs: (a) audit_log er append-only via
  triggers → tidsstempler kan ikke korrigeres i tests, perioden må ankes omkring nu;
  (b) agent-demo og smoke deler samme VIES-seed-script — én fix slog begge igennem;
  (c) `selectVatPeriod` capper ved "nutids"-perioden, så #272-scenariet (afskrivning i
  senere kvartal) stadig er meningsfuldt med dynamiske datoer. Næste: opgave 2
  (typecheck-gate; inkl. `package-lock.json` → `.gitignore`).
- 2026-08-23: Opgave 2 løst (ce74003). Fund undervejs:
  - bun-types 1.4.0-signaturen `run(sql, ...bindings: ParamsType[])` med
    `ParamsType extends SQLQueryBindings[]` kræver ÉN array pr. kald — flad variadic
    (`run(sql, a, b)`) fejler både types OG runtime ("expected 2 values, received 1").
    Alle db.run-kald bruger nu `run(sql, [a, b])`.
  - bun-types 1.4.0 `fetch` har en påkrævet `preconnect`-metode → simple async-mocks
    typechecker ikke længere; repoets eksisterende idiom er `as unknown as typeof fetch`.
  - app/ og www/ havde slet ikke installeret node_modules lokalt — begge bygger rent
    efter `bun install` (app: tsc + vite; www: astro build, 73 sider).
  - CI kører IKKE typecheck endnu (kun test.yml/smoke.yml). Overvej at tilføje et
    typecheck-job som del af opgave 6 (docs-sync) eller separat.

- 2026-08-23: Opgave 3 løst. Fund undervejs:
  - Biome recommended-preset var nok til at rense 334 filer med ~30 filers
    smårettelser — ingen dybe problemer. De eneste semantisk interessante fund:
    duplikerede switch-labels (død kode) i periods.ts og en ubrugt WINANSI-
    parameter i invoice-pdf.ts.
  - Den afbrudte iteration efterlod typecheck rød (manglende `KeyObject`-import)
    — lektie: kør FULD gate før iterationen afbrydes, også halvvejs.
  - `noForEach`/`useOptionalChain` m.fl. er slået fra i config for at undgå
    kosmetiske omskrivninger; correctness-reglerne står på error.

- 2026-08-23: Opgave 4 løst (9a103df). 70 nye randtilfælde-tests på tværs af 6 filer.
  Alle gates grønne. Næste: opgave 5 (fejlbeskeder + døde stier).

- 2026-08-23: Opgave 5 løst (eecbed2). 8 forbedrede fejlbeskeder, 10 døde exports +
  dead barrel fjernet, 3 nye CLI-error-tests. Fund: `safeErrorEnvelope` bruger
  `redactPaths` — vigtigt at huske ved ændring af `withCompanyDb`-fejlbeskeder.
  Næste: opgave 6 (docs-sync).

## STATUS: AKTIV — næste iteration starter opgave 6 (docs-sync).

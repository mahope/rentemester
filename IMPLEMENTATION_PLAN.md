# IMPLEMENTATION_PLAN — Rentemester

Autonom loop-state. Læs FØRST, hold opdateret. Mission: korrekthed i et dagligt brugt,
append-only dansk bogføringssystem (MCP + kerne, TypeScript/bun). Intet live-site, ingen
deploys — men revisionskritisk kode.

## Gate-definition (fra docs/build-loop.md + .github/workflows)

1. Fokuserede tests → 2. `bun test` → 3. `bun run smoke` (frisk /tmp/rentemester-smoke) →
4. `bun run typecheck` (tilføjet 2026-08-23) → 5. `git diff --check`. CI kører `test.yml`
(`bun test`) og `smoke.yml` (`bun run smoke`; budget-varianten `smoke:budget` fejler over
30s). Lint findes IKKE som script endnu — planlagt opgave 3.
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

### 3. [P1] Lint-setup
- Vælg én linter (biome anbefalet: TS-native, hurtig, minimal opsætning; alternativ oxlint).
- Start konservativ (correctness-regler, ingen stilistik-omskrivninger); fix eller suppress
  med bevidsthed. `"lint"` script + i gaten når grøn.
- **Accept**: `bun run lint` exit 0 på hele repoet; dokumenteret i docs/build-loop.md.

### 4. [P2] Testdækningsgab i kerneflows (randtilfælde)
- Verificér/fald udbyg: øre-afrunding (money.ts), periodegrænser (periods/fiscal-year over
  årsksifte), hash-kæde tamper-detection (skal allerede findes i ledger-hardening —
  verificér og uddyb ved behov), interest day-count over månedsskift/skudår, momsperiode-
  grænser. Skriv fejlende proof først iflg. docs/build-loop.md.
- **Accept**: hver ny sag har negativ test ("hvad SKAL blokeres"); `bun test` grøn.

### 5. [P3] Fejlbeskeder + døde stier
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

## STATUS: AKTIV — næste iteration starter opgave 3 (lint-setup).

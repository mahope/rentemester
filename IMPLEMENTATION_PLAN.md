# IMPLEMENTATION_PLAN — Rentemester

Autonom loop-state. Læs FØRST, hold opdateret. Mission: korrekthed i et dagligt brugt,
append-only dansk bogføringssystem (MCP + kerne, TypeScript/bun). Intet live-site, ingen
deploys — men revisionskritisk kode.

## Gate-definition (fra docs/build-loop.md + .github/workflows)

1. Fokuserede tests → 2. `bun test` → 3. `bun run smoke` (frisk /tmp/rentemester-smoke) →
4. `git diff --check`. CI kører `test.yml` (`bun test`) og `smoke.yml` (`bun run smoke`;
   budget-varianten `smoke:budget` fejler over 30s). Typecheck/lint findes IKKE som scripts
   endnu — det er en planlagt opgave.
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

### 1. [P0] I GANG — Reparér tidsafhængige tests + smoke (genopret grøn baseline)
- **Omfang**: de 12 fejlende tests + `scripts/seed-vies-validation.ts` (+ evt. andre
  hardkodede seeds). Metode: seed datoer relativt til `new Date()` eller brug eksisterende
  eksplicitte `asOf`-parametre — ALDRIG ændre semantik i vies/vat/backup-logik.
- **Accept**: `bun test` = 1163/1163 grønne; `bun run smoke` exit 0; ingen ændrede
  assertions udover dato-forsyning (diff skal kunne reviewes som ren test-infrastruktur).

### 2. [P1] Typecheck som gate: rod-tsconfig-excludes + ryd op i src/
- Excludér `app/`, `www/`, `examples/` fra rod-tsconfigen (de har egne configs/bygges med
  vite). Fiks derefter de ~84 reelle strict-fejl i `src/` (og 107 i `tests/`) trinvis.
- Tilføj `"typecheck": "tsc --noEmit"` script; optag den i gate-definitionen her når grøn.
- Føj `package-lock.json` til `.gitignore`.
- **Accept**: root `tsc --noEmit` = 0 fejl for src/tests; app/www bygger stadig med egne
  configs; `bun test` stadig grøn.

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

## STATUS: AKTIV — næste iteration fortsætter opgave 1.

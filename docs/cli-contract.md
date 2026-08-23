# CLI-kontrakt: actor-politik og exit-koder

Dette dokument beskriver to forudsætninger, som ikke fremgår af den enkelte
kommandos `--help`, men som en agent skal kende for at kalde `rentemester`-CLI'en
korrekt. Implementeringen ligger i `src/cli-actor.ts` og `src/cli.ts`.

## 1. Actor-politik for muterende kommandoer

Enhver **muterende** kommando (alt der skriver til ledger'en — fakturaer,
finansposteringer, backups, kunde-/leverandøroprettelse osv.) kræver en kendt
actor. Det fulde sæt ligger i `MUTATING_COMMANDS` i `src/cli-actor.ts`.
Read-only-kommandoer (lister, rapporter, `--help`, `--example`) kræver ingen
actor.

En muterende kommando uden actor afvises med:

```
actor required for mutations: pass --actor <user:...|agent:...|system:...> or run with USER/LOGNAME/OPENCLAW_AGENT set
```

Actoren bestemmes i denne rækkefølge:

1. `--actor <id>` — eksplicit flag. Skal være på kanonisk form
   `user:<id>`, `agent:<id>` eller `system:<id>`, og skal stå i
   `config/policy.yaml` under `actor_allowlist`. En actor uden for allowlisten
   afvises med en klar fejl.
2. `RENTEMESTER_ACTOR` miljøvariabel — behandles som et eksplicit, kanonisk
   actor-id (samme allowlist-krav som `--actor`).
3. En **udledt** actor fra miljøet, hvis intet eksplicit er sat (ingen
   allowlist-kontrol):
   - `OPENCLAW_AGENT` → `agent:<værdi>`
   - `RENTEMESTER_AGENT` → `agent:<værdi>`
   - `RENTEMESTER_USER` → `user:<værdi>`
   - `USER` → `user:<værdi>`
   - `LOGNAME` → `user:<værdi>`

Findes ingen af delene, fejler kommandoen før den rører virksomhedsdata.

`--actor-via <kilde>` er valgfri og sætter `RENTEMESTER_ACTOR_VIA` (sporing af,
hvilken kanal mutationen kom igennem; standard `rentemester-cli`).

For `system restore-backup` håndhæves politikken mod `--target-company`-stien,
ikke `--company`, fordi det er dér data skrives. Én undtagelse (#283): et
restore-mål der endnu ikke findes (frisk restore) har ingen
`config/policy.yaml` at kontrole mod, så allowlist-tjekket springes over —
det kanoniske format kræves dog stadig, og restore ind i en eksisterende
virksomhed håndhæves fuldt.

## 2. Exit-koder

CLI'en bruger to fejl-exit-koder, så en agent kan skelne "jeg kaldte den
forkert" fra "kaldet var korrekt, men ledger'en afviste det":

| Exit-kode | Betydning | Eksempler |
|-----------|-----------|-----------|
| `0` | Succes. Resultatet har `ok: true`. | Postering bogført, backup oprettet. |
| `2` | Parse-/brugsfejl. Kaldet kom aldrig så langt som til forretningslogikken. | Ukendt flag, manglende påkrævet flag, ugyldigt `--format`, ukendt kommando, actor afvist af politikken, manglende `--input`-fil-argument. |
| `1` | Forretnings-/ledger-afvisning. Kaldet var velformet, men resultatet er `ok: false`. | Ubalanceret postering, faktura findes ikke, periode er lukket, `system restore-backup` uden `--confirm yes`. |

Praktisk for en agent:

- **Exit `2`** → ret selve kald'et (flag, argumenter, input-sti).
- **Exit `1`** → kald'et var korrekt; læs `errors[]` i JSON-resultatet for at se,
  hvorfor ledger'en afviste det, og ret payloaden eller forudsætningerne.
- **Exit `0`** → mutationen lykkedes.

Resultatet skrives altid til stdout (JSON med `--format json`/`--json`).
Parse-/brugsfejl (`exit 2`) skrives til stderr.

## 3. Output-felter ved succes

Den enkelte kommandos `--help` dækker exit-koder og — ved fejl — `errors[]`,
men *ikke* hvilke felter `--json`-succes-outputtet indeholder. Den kontrakt
står ikke i `--help`.

Reglen er: **et `--json`-succes-output fra CLI'en spejler `data`-shapen for
den tilsvarende MCP-tool.** Hver CLI-kommando svarer (typisk 1:1) til en
MCP-tool — `journal post` ⇄ `journal_post`, `invoice issue` ⇄ `invoice_issue`,
`audit verify` ⇄ `audit_verify` osv. — og de to overflader returnerer den
samme strukturerede `{ ok, errors, ... }`-form med de samme felter under
resultatet.

Den autoritative, per-tool feltliste står derfor i
[`docs/mcp-tool-surface.md`](mcp-tool-surface.md) under afsnittet
"`data`-felter pr. tool" (samt i kildens `*Result`-typer i `src/core/*.ts`).
Slå CLI-kommandoens MCP-pendant op dér for at se de præcise felter — fx giver
`audit verify` / `audit_verify` `{ entries }` med integritets-verdikten i
`ok`/`errors[]`, og `journal post` / `journal_post` giver
`{ entryId, entryNo, entryHash }`.

Bemærk de få CLI-only-kommandoer uden MCP-pendant (fx `invoice create`,
`invoice export-public`); de er listet under "CLI/MCP-mapping" i samme
dokument.

## CLI-kontrakt for agenter

Før du kalder `rentemester`-CLI'en muterende, læs `docs/cli-contract.md`. Kort:

- **Actor-politik**: enhver muterende kommando kræver en actor — `--actor
  <user:...|agent:...|system:...>` eller `RENTEMESTER_ACTOR` (skal stå i
  `config/policy.yaml`), eller en udledt `USER`/`LOGNAME`/`RENTEMESTER_USER`/
  `RENTEMESTER_AGENT`/`OPENCLAW_AGENT` miljøvariabel. Uden actor afvises
  kommandoen med `actor required for mutations`.
- **Exit-koder**: `0` = succes (`ok:true`); `2` = parse-/brugsfejl (forkert
  kald — ret flag/argumenter); `1` = forretnings-/ledger-afvisning (kaldet var
  korrekt, men resultatet er `ok:false` — læs `errors[]`).

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

When the user types `/graphify`, use the Graphify CLI before doing anything else.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- Dirty graphify-out/ files are expected after hooks or incremental updates; dirty graph files are not a reason to skip graphify. Only skip graphify if the task is about stale or incorrect graph output, or the user explicitly says not to use it.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).

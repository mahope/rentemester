#!/usr/bin/env bun
import { openDb, migrate } from "../src/core/db";
import { companyPaths } from "../src/core/paths";
import { storeViesValidation } from "../src/core/vies";

const [, , companyRoot, vatOrCvr] = Bun.argv;
if (!companyRoot || !vatOrCvr) {
  console.error("Usage: bun run scripts/seed-vies-validation.ts <company-root> <EU-VAT>");
  process.exit(2);
}

const db = openDb(companyPaths(companyRoot).db);
migrate(db);
// validatedAt/expiresAt bevidst udeladt: storeViesValidation default'er til
// "nu" + 90 dages TTL, så seedet altid er friskt når demoen/smoke kører.
const validation = storeViesValidation(db, {
  vatOrCvr,
  valid: true,
  rawResponse: JSON.stringify({ valid: true, source: "smoke-seed" }),
});
db.close();
console.log(JSON.stringify({ ok: true, validation }, null, 2));

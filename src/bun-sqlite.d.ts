// Bun kører `db.transaction(fn, { immediate: true })` (BEGIN IMMEDIATE), men
// bun-types 1.4.0 har ikke options-parameteren med. Udvid typen til runtime-
// adfærden så kodebasens eksisterende kald typechecker.
declare module "bun:sqlite" {
  interface Database {
    transaction<A extends any[], T>(
      insideTransaction: (...args: A) => T,
      options: { immediate?: boolean; deferred?: boolean; exclusive?: boolean },
    ): ((...args: A) => T) & {
      deferred: (...args: A) => T;
      immediate: (...args: A) => T;
      exclusive: (...args: A) => T;
    };
  }
}

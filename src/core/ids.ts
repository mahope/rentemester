/**
 * Brandede typer for de bærende identifikatorer i regnskabskernen.
 *
 * Fakturanumre og entitets-id'er blev tidligere ført rundt som rå `string`
 * / `number`. To `string`-argumenter eller to `number`-id'er kan byttes om
 * uden at compileren fanger det — en reel korrekthedsrisiko i et finansielt
 * system (se issue #129 om manuel fakturanummer-håndtering).
 *
 * En branded type er nominelt unik: `DocumentId` er stadig et `number` ved
 * kørselstid (brandet er kun typeniveau og forsvinder ved compilering), men
 * et `BankTransactionId` kan ikke gives hvor en `DocumentId` forventes.
 *
 * Adopteres trinvist startende ved ledger/faktura/dokument-sømmene. Ved
 * SQLite-grænsen castes rå rækker eksplicit, f.eks. `row.id as DocumentId`.
 */

/** Et udstedt fakturanummer på formen `<scope>-<løbenummer>`. */
export type InvoiceNumber = string & { readonly __brand: "InvoiceNumber" };

/** Primærnøgle for en post i `documents`-tabellen. */
export type DocumentId = number & { readonly __brand: "DocumentId" };

/** Primærnøgle for en post i `journal_entries`-tabellen. */
export type JournalEntryId = number & { readonly __brand: "JournalEntryId" };

/** Primærnøgle for en post i `bank_transactions`-tabellen. */
export type BankTransactionId = number & {
  readonly __brand: "BankTransactionId";
};

/** Caster et rå fakturanummer til den brandede type (typisk ved DB-grænsen). */
export function asInvoiceNumber(value: string): InvoiceNumber {
  return value as InvoiceNumber;
}

/** Caster en rå rækkenøgle til `DocumentId` (typisk ved DB-grænsen). */
export function asDocumentId(value: number): DocumentId {
  return value as DocumentId;
}

/** Caster en rå rækkenøgle til `JournalEntryId` (typisk ved DB-grænsen). */
export function asJournalEntryId(value: number): JournalEntryId {
  return value as JournalEntryId;
}

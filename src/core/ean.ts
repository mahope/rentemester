export function trimToNull(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function normalizeEanNumber(value: unknown) {
  const trimmed = trimToNull(value);
  if (!trimmed) return null;
  const digitsOnly = trimmed.replace(/\s+/g, "");
  return /^\d{13}$/.test(digitsOnly) ? digitsOnly : null;
}

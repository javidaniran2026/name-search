/**
 * Normalize for Meilisearch: preserve word boundaries (ZWNJ → space).
 * Use when indexing/searching so multi-word queries work.
 */
export function normalizeForSearch(text: string): string {
  return text
    .replace(/\u200C/g, " ") // ZWNJ → space (keeps words separate)
    .replace(/\s+/g, " ")
    .trim()
    .replace(/ي/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/ة/g, "ه");
}

/**
 * Normalize Persian digits to ASCII for consistent date/number handling.
 */
export function normalizeDigits(text: string): string {
  return text.replace(/[۰-۹]/g, (d) =>
    String("۰۱۲۳۴۵۶۷۸۹".indexOf(d))
  );
}

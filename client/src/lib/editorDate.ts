/** API encoder for MySQL DATE. Drizzle/date and db.ts timezone Z represent it at UTC midnight. */
export function editorDate(value: Date | string | null | undefined): string {
  if (value == null || value === "") return "";
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "" : value.toISOString().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}(?:$|T)/.test(value) ? value.slice(0, 10) : "";
}

import { customType } from "drizzle-orm/mysql-core";

// Binary comparison after explicit lowercasing: do not silently fold accents or spaces.
export const barcodeIdentityColumn = customType<{ data: string }>({
  dataType: () => "varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin",
});

/** Deterministic generated-column expression mirroring shared/barcodeNormalize.ts. */
export function barcodeIdentitySql(column: string): string {
  // Hex text literals avoid SQL-mode-dependent backslash parsing and collation drift.
  const literal = (value: string) => `CONVERT(0x${Buffer.from(value, "utf8").toString("hex")} USING utf8mb4) COLLATE utf8mb4_bin`;
  let value = `(${column} COLLATE utf8mb4_bin)`;
  for (const mark of ["\u00ad", "\u061c", "\u200b", "\u200c", "\u200d", "\u200e", "\u200f", "\u202a", "\u202b", "\u202c", "\u202d", "\u202e", "\u2060", "\u2061", "\u2062", "\u2063", "\u2064", "\u2066", "\u2067", "\u2068", "\u2069", "\ufeff"]) {
    value = `REPLACE(${value}, ${literal(mark)}, '')`;
  }
  const edge = "[\\x{0000}-\\x{0020}\\x{007f}-\\x{00a0}\\x{1680}\\x{2000}-\\x{200a}\\x{2028}\\x{2029}\\x{202f}\\x{205f}\\x{3000}]";
  value = `LOWER(REGEXP_REPLACE(${value}, ${literal(`^${edge}+|${edge}+$`)}, ''))`;
  for (const digits of ["٠١٢٣٤٥٦٧٨٩", "۰۱۲۳۴۵۶۷۸۹"]) {
    Array.from(digits).forEach((digit, index) => { value = `REPLACE(${value}, ${literal(digit)}, '${index}')`; });
  }
  return value;
}

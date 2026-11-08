import { normalizeSearchText } from "./searchNormalize";

/**
 * CATALOG-SURGICAL-20261107 — توحيد معاينة وتوليد وتطبيع تركيبات المتغيّرات (أحادي وثنائي البعد).
 *
 * يدعم:
 * - لون فقط (`colors.length > 0 && sizes.length === 0`)
 * - قياس فقط (`colors.length === 0 && sizes.length > 0`)
 * - مصفوفة لون × قياس (`colors.length > 0 && sizes.length > 0`)
 * مع منع تكرار التركيبات العادية بعد التطبيع، واسترجاع اختيارات المحفوظ دون الكتابة فوق القيم.
 */

/** يطبّع قيمة اللون أو القياس للمقارنة ومنع التكرار (طيّ عربي + أحرف صغيرة + دمج المسافات). */
export function normalizeVariantDimension(
  raw: string | null | undefined,
): string {
  const trimmed = (raw ?? "").trim().replace(/\s+/g, " ");
  if (!trimmed) return "";
  return normalizeSearchText(trimmed);
}

/** مفتاح مقارن قانوني لتركيبة (لون، قياس) بعد التطبيع. */
export function normalizedVariantComboKey(
  color: string | null | undefined,
  size: string | null | undefined,
): string {
  return `${normalizeVariantDimension(color)}|${normalizeVariantDimension(size)}`;
}

/** مفتاح الخلية الخام لعرض المصفوفة مع التوافق الخلفي والبحث المطبّع. */
export function matrixCellKey(
  color: string | null | undefined,
  size: string | null | undefined,
): string {
  return normalizedVariantComboKey(color, size);
}

export interface VariantMatrixCell {
  color: string;
  size: string;
  key: string;
  included: boolean;
}

/** يزيل تكرار الرقائق بعد التطبيع مع الإبقاء على نصّ الإدخال الأوّل للعرض. */
export function dedupeDimensionValues(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const trimmed = raw.trim().replace(/\s+/g, " ");
    if (!trimmed) continue;
    const norm = normalizeVariantDimension(trimmed);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    out.push(trimmed);
  }
  return out;
}

/** يبني كل خلايا المصفوفة الممكنة (أحادي أو ثنائي البعد) مع حالة التضمين لكل خلية. */
export function buildVariantMatrixCells(args: {
  colors: readonly string[];
  sizes: readonly string[];
  excluded?: Iterable<string>;
}): VariantMatrixCell[] {
  const colors = dedupeDimensionValues(args.colors);
  const sizes = dedupeDimensionValues(args.sizes);
  if (colors.length === 0 && sizes.length === 0) return [];

  const excludedNorm = new Set<string>();
  for (const item of Array.from(args.excluded ?? [])) {
    const parts = item.split("|");
    excludedNorm.add(
      normalizedVariantComboKey(parts[0] ?? "", parts.slice(1).join("|")),
    );
  }

  const cells: VariantMatrixCell[] = [];
  if (colors.length > 0 && sizes.length > 0) {
    for (const color of colors) {
      for (const size of sizes) {
        const key = normalizedVariantComboKey(color, size);
        cells.push({ color, size, key, included: !excludedNorm.has(key) });
      }
    }
    return cells;
  }

  if (colors.length > 0) {
    for (const color of colors) {
      const key = normalizedVariantComboKey(color, "");
      cells.push({ color, size: "", key, included: !excludedNorm.has(key) });
    }
    return cells;
  }

  for (const size of sizes) {
    const key = normalizedVariantComboKey("", size);
    cells.push({ color: "", size, key, included: !excludedNorm.has(key) });
  }
  return cells;
}

/** يسترجع رقائق الألوان والقياسات والخلايا المستثناة من المتغيّرات المحفوظة عند فتح التعديل. */
export function restoreMatrixStateFromVariants(
  variants: ReadonlyArray<{
    variantKind?: string | null;
    color?: string | null;
    size?: string | null;
    isActive?: boolean | null;
  }>,
): { colors: string[]; sizes: string[]; excluded: string[] } {
  const regular = variants.filter(
    (v) => (v.variantKind ?? "VARIANT") !== "ALTERNATIVE",
  );
  const colors = dedupeDimensionValues(
    regular.map((v) => v.color ?? "").filter(Boolean),
  );
  const sizes = dedupeDimensionValues(
    regular.map((v) => v.size ?? "").filter(Boolean),
  );
  if (colors.length === 0 && sizes.length === 0) {
    return { colors: [], sizes: [], excluded: [] };
  }

  const activeSavedKeys = new Set<string>();
  for (const v of regular) {
    if (v.isActive === false) continue;
    const key = normalizedVariantComboKey(v.color, v.size);
    if (key !== "|") activeSavedKeys.add(key);
  }

  const allCells = buildVariantMatrixCells({ colors, sizes });
  const excluded = allCells
    .filter((cell) => !activeSavedKeys.has(cell.key))
    .map((cell) => cell.key);

  return { colors, sizes, excluded };
}

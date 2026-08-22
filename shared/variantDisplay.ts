// اسم عرض المتغيّر — مصدرٌ واحد (وثيقة «الجرد بالباركود» ٢٢/٨، م٣).
//
// قبل هذا كان كل موضعٍ يركّب الاسم محلّياً بصيَغ وفواصل مختلفة (مسافة/‏/‏/—/•). هذا المعجم
// يوحّد الصيغة ويميّز نوعَي المتغيّر:
//   - VARIANT (تنويعة لون/قياس): الواصف = «لون / قياس» (وإلا variantName إن وُجد).
//   - ALTERNATIVE (منتجٌ حقيقيٌّ مستقلّ تحت الاسم الجامع): الواصف = اسمه (variantName).
// الاسم الكامل = «اسم المنتج — الواصف» (بلا واصف ⇒ اسم المنتج وحده). للتنويعة بلا لون/قياس
// يبقى المخرج اسمَ المنتج — مطابقٌ للسلوك القائم، فتبنّيه لا يُحدث تغييراً مرئياً على البيانات القائمة.

export type VariantKind = "VARIANT" | "ALTERNATIVE";

export interface VariantDisplayParts {
  productName: string;
  variantName?: string | null;
  color?: string | null;
  size?: string | null;
  variantKind?: VariantKind | string | null;
  sku?: string | null;
}

const DASH = " — ";

export function isAlternativeVariant(kind: string | null | undefined): boolean {
  return kind === "ALTERNATIVE";
}

const clean = (v: string | null | undefined): string => (v ?? "").trim();

/**
 * الواصف بلا اسم المنتج (للاستعمال داخل بطاقةٍ عنوانُها المنتج أصلاً):
 * - بديل: اسمه (variantName) — وإلا لون/قياس، وإلا SKU.
 * - تنويعة: «لون / قياس» — وإلا variantName.
 * يعيد "" حين لا يوجد ما يميّز (تنويعةٌ وحيدة بلا سماتٍ) — فيُعرض اسمُ المنتج وحده.
 */
export function variantDescriptor(p: VariantDisplayParts): string {
  const color = clean(p.color);
  const size = clean(p.size);
  const name = clean(p.variantName);
  const colorSize = [color, size].filter(Boolean).join(" / ");

  if (isAlternativeVariant(p.variantKind)) {
    return name || colorSize || clean(p.sku);
  }
  return colorSize || name;
}

/** الاسم الكامل للعرض: «اسم المنتج — الواصف»، أو اسم المنتج وحده حين لا واصف. */
export function variantDisplayName(p: VariantDisplayParts): string {
  const base = clean(p.productName);
  const desc = variantDescriptor(p);
  return desc ? `${base}${DASH}${desc}` : base;
}

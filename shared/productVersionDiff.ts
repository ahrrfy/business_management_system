/**
 * ═══ «ما الذي تغيّر» — فرقُ لقطتَي منتج حقلاً بحقل (م٦ ق٨) ═══
 *
 * دالّةٌ نقيّة بلا قاعدة: تقارن مستندَي لقطة (`ProductSnapshotDocument`) وتُخرج صفوفاً
 * `{ path, label, before, after }` بتسمياتٍ عربية هي **تسمياتُ شاشة المنتج نفسها** — كي يقرأ
 * الموظّف في السجلّ الاسمَ الذي يراه في النموذج، لا اسمَ العمود.
 *
 * يُستعمل في موضعَين بالنصّ نفسه (مصدرٌ واحد):
 *   • الخادم: `catalog.productVersions` (الحقول المتغيّرة لكلّ نسخة) و`catalog.productVersionDiff`.
 *   • الواجهة: عرض الصفوف كما جاءت — لا حسابٌ ثانٍ في الشاشة.
 *
 * دلالةُ «النسخة N»: حالةُ المنتج **قبل** التعديل N. فـ«ما تغيّر في التعديل N» =
 * `diff(النسخة N، النسخة N+1)`، وللأخيرة `diff(النسخة N، الحالة الحاليّة)`.
 *
 * ⚠️ الأرقامُ تُعرض كما خُزّنت (لاتينية) — لا `toLocaleString("ar-…")` (حارس `check:locale-numbers`).
 */
import type {
  ProductSnapshotDocument,
  ProductSnapshotImage,
  ProductSnapshotUnit,
  ProductSnapshotVariant,
} from "./productSnapshot";

export type ProductChangeRow = {
  /** مسارٌ ثابت للحقل (للمفاتيح والاختبار) — مثل `name` أو `unit:قطعة.retail` أو `variant:12.costPrice`. */
  path: string;
  /** تسميةُ الشاشة العربية. */
  label: string;
  before: string | null;
  after: string | null;
};

type ValueKind = "text" | "bool" | "number";

const EMPTY = "—";

function fmt(kind: ValueKind, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (kind === "bool") return value ? "نعم" : "لا";
  const s = String(value);
  return s.trim() === "" ? null : s;
}

function push(rows: ProductChangeRow[], path: string, label: string, kind: ValueKind, a: unknown, b: unknown) {
  const before = fmt(kind, a);
  const after = fmt(kind, b);
  if (before === after) return;
  rows.push({ path, label, before, after });
}

/** ترويسةُ المنتج — الترتيبُ هو ترتيبُ العرض في السجلّ. */
const HEADER_FIELDS: Array<[keyof ProductSnapshotDocument, string, ValueKind]> = [
  ["name", "اسم المنتج", "text"],
  ["productType", "النوع", "text"],
  ["brand", "الماركة", "text"],
  ["modelName", "الموديل", "text"],
  ["categoryId", "الفئة", "number"],
  ["description", "الوصف", "text"],
  ["internalName", "الاسم الداخلي", "text"],
  ["storeTitle", "عنوان المتجر", "text"],
  ["seoTitle", "عنوان SEO", "text"],
  ["shortTitle", "العنوان المختصر", "text"],
  ["posLabel", "تسمية الكاشير", "text"],
  ["invoiceLabel", "تسمية الفاتورة", "text"],
  ["marketingCopy", "النص التسويقي", "text"],
  ["isCustomizable", "قابل للتخصيص", "bool"],
  ["allowAutoCartRecommendations", "التوصيات الآلية", "bool"],
  ["isService", "خدمة (بلا مخزون)", "bool"],
  ["allowBackorder", "يباع بالطلب", "bool"],
  ["isBundle", "بكج", "bool"],
  ["isActive", "حالة المنتج", "bool"],
  ["showInReception", "نقطة خدمة العملاء (الاستقبال)", "bool"],
  ["showInPrintPos", "نقطة الطباعة", "bool"],
  ["isConsignment", "بضاعة أمانة", "bool"],
];

const UNIT_FIELDS: Array<[keyof ProductSnapshotUnit, string, ValueKind]> = [
  ["conversionFactor", "معامل التحويل", "text"],
  ["isBaseUnit", "وحدة أساس", "bool"],
  ["isStoreSaleUnit", "بيع بالمتجر", "bool"],
  ["retail", "سعر المفرد", "text"],
  ["wholesale", "سعر الجملة", "text"],
  ["government", "سعر الحكومي", "text"],
];

const VARIANT_FIELDS: Array<[keyof ProductSnapshotVariant, string, ValueKind]> = [
  ["sku", "SKU", "text"],
  ["variantKind", "نوع المتغير", "text"],
  ["variantName", "اسم البديل", "text"],
  ["color", "اللون", "text"],
  ["colorHex", "لون العرض", "text"],
  ["size", "القياس", "text"],
  ["costPrice", "سعر التكلفة", "text"],
  ["baseRetail", "سعر المفرد الخاص", "text"],
  ["minStock", "الحد الأدنى", "number"],
  ["reorderPoint", "نقطة إعادة الطلب", "number"],
  ["isActive", "الحالة", "bool"],
  ["imageRef", "صورة اللون", "text"],
];

const IMAGE_FIELDS: Array<[keyof ProductSnapshotImage, string, ValueKind]> = [
  ["isPrimary", "رئيسية", "bool"],
  ["sortOrder", "الترتيب", "number"],
  ["ref", "المحتوى", "text"],
];

const variantLabel = (v: ProductSnapshotVariant) =>
  `المتغير «${v.variantName?.trim() || [v.color, v.size].filter(Boolean).join(" ") || v.sku}»`;

/**
 * سعرُ مفرد الأساس **الخاصّ** بالمتغيّر: `baseRetail` في المستند يعكس سعرَ القالب ما لم يكن للمتغيّر
 * سعرٌ خاصّ (دلالة `priceOverride` في الشاشة). فبلا هذا التمييز يظهر تغييرُ سعر القالب مرّةً في صفّ
 * الوحدة ومرّةً لكلّ متغيّر — N+1 صفّاً لتغييرٍ واحد. هنا يُقاس **الفرقُ عن القالب** وحده.
 */
function specialBaseRetail(v: ProductSnapshotVariant, doc: ProductSnapshotDocument): string | null {
  const templateRetail = doc.unitTemplate.find((u) => u.isBaseUnit)?.retail ?? "";
  const own = (v.baseRetail ?? "").trim();
  return own && own !== templateRetail ? own : null;
}

/** يقارن لقطتَين ويُرجع الصفوف المتغيّرة فقط. لقطتان متطابقتان ⇒ مصفوفة فارغة. */
export function diffProductSnapshots(
  before: ProductSnapshotDocument,
  after: ProductSnapshotDocument,
): ProductChangeRow[] {
  const rows: ProductChangeRow[] = [];

  for (const [key, label, kind] of HEADER_FIELDS) push(rows, key, label, kind, before[key], after[key]);
  // المودِع: نُظهر الاسم إن عُرف، والمعرّف احتياطاً — قيمةٌ واحدة قابلة للقراءة.
  push(
    rows,
    "consignorId",
    "المودع",
    "text",
    before.consignorId == null ? null : (before.consignorName ?? String(before.consignorId)),
    after.consignorId == null ? null : (after.consignorName ?? String(after.consignorId)),
  );

  // قالب الوحدات — مفتاحُه اسمُ الوحدة (هو مفتاح المطابقة في مسار الحفظ أيضاً).
  const unitsA = new Map(before.unitTemplate.map((u) => [u.unitName, u]));
  const unitsB = new Map(after.unitTemplate.map((u) => [u.unitName, u]));
  unitsA.forEach((a, name) => {
    const b = unitsB.get(name);
    if (!b) {
      rows.push({ path: `unit:${name}`, label: `الوحدة «${name}»`, before: "موجودة", after: "محذوفة" });
      return;
    }
    for (const [key, label, kind] of UNIT_FIELDS)
      push(rows, `unit:${name}.${key}`, `الوحدة «${name}» — ${label}`, kind, a[key], b[key]);
  });
  unitsB.forEach((_b, name) => {
    if (!unitsA.has(name))
      rows.push({ path: `unit:${name}`, label: `الوحدة «${name}»`, before: null, after: "مضافة" });
  });

  // المتغيّرات — مفتاحُها المعرّف (ثابتٌ عبر النسخ؛ الـSKU قابلٌ للتعديل).
  const varsA = new Map(before.variants.map((v) => [v.id, v]));
  const varsB = new Map(after.variants.map((v) => [v.id, v]));
  varsA.forEach((a, id) => {
    const b = varsB.get(id);
    if (!b) {
      rows.push({ path: `variant:${id}`, label: variantLabel(a), before: "موجود", after: "محذوف" });
      return;
    }
    const prefix = variantLabel(b);
    for (const [key, label, kind] of VARIANT_FIELDS) {
      if (key === "baseRetail") {
        push(rows, `variant:${id}.baseRetail`, `${prefix} — ${label}`, kind, specialBaseRetail(a, before), specialBaseRetail(b, after));
        continue;
      }
      push(rows, `variant:${id}.${key}`, `${prefix} — ${label}`, kind, a[key], b[key]);
    }
    const unitNames = Array.from(new Set([...Object.keys(a.unitBarcodes), ...Object.keys(b.unitBarcodes)]));
    for (const name of unitNames)
      push(rows, `variant:${id}.barcode:${name}`, `${prefix} — باركود «${name}»`, "text", a.unitBarcodes[name], b.unitBarcodes[name]);
  });
  varsB.forEach((b, id) => {
    if (!varsA.has(id)) rows.push({ path: `variant:${id}`, label: variantLabel(b), before: null, after: "مضاف" });
  });

  // الصور — هويّةٌ وترتيبٌ وبصمة (لا بايتات؛ انظر رأس `productSnapshot.ts`).
  const imgA = new Map(before.images.map((i) => [i.id, i]));
  const imgB = new Map(after.images.map((i) => [i.id, i]));
  imgA.forEach((a, id) => {
    const b = imgB.get(id);
    if (!b) {
      rows.push({ path: `image:${id}`, label: `الصورة #${id}`, before: "موجودة", after: "محذوفة" });
      return;
    }
    for (const [key, label, kind] of IMAGE_FIELDS)
      push(rows, `image:${id}.${key}`, `الصورة #${id} — ${label}`, kind, a[key], b[key]);
  });
  imgB.forEach((_b, id) => {
    if (!imgA.has(id)) rows.push({ path: `image:${id}`, label: `الصورة #${id}`, before: null, after: "مضافة" });
  });

  return rows;
}

/** تسمياتُ الحقول المتغيّرة بلا تكرار، بترتيب الظهور — لسطر «الحقول المتغيّرة» في قائمة النسخ. */
export function changedFieldLabels(rows: ProductChangeRow[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of rows) {
    if (seen.has(r.label)) continue;
    seen.add(r.label);
    out.push(r.label);
  }
  return out;
}

/** قيمةٌ للعرض: `null` ⇒ «—». */
export function displayChangeValue(value: string | null): string {
  return value === null || value === "" ? EMPTY : value;
}
